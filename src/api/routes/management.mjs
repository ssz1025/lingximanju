// 创作项目管理域：属性 / 复制 / 快照恢复 / 六步执行 / 项目封面
import { json, readBody } from '../http.mjs';
import { MATCH } from './match.mjs';
import { loadProject, saveProject, uid, listSnapshots, writeSnapshot, readSnapshot, writeAssetBinary, readAsset } from '../../core/store.mjs';
import { registerAsset } from '../../core/assets.mjs';
import { emit } from '../../core/events.mjs';
import { ensureManagement, applyManageAction, projectStats, stepProgress, STEPS } from '../../core/project-steps.mjs';
import { attachSource } from '../../pipelines/novel-project.mjs';
import { isRunning, runProject } from '../../core/orchestrator.mjs';
import { reconcileProjectComfy, watchComfyJobs } from '../../core/comfy-reconcile.mjs';
import { isRealKeyframe, keyframeImage } from '../../core/keyframe-status.mjs';
import { resolveComfyConfig } from '../../core/comfy-config.mjs';
import { parseWorkflow, runWorkflow } from '../../core/comfyui.mjs';
import { executeSteps, broadcastMeta } from '../../core/step-runner.mjs';
import { createProviders } from '../../core/providers.mjs';
import { mergeExtracted } from '../../core/characters.mjs';
// 音色分配智能体：提取角色后自动为每个角色绑定互不重复的音色
import { assignVoices } from '../../agents/voice-agent.mjs';
// 角色定妆业务层：路由只是薄壳，路由 / 智能体 / 导演能力共用同一口径
import {
  generateCharacterView, generateCharacterSheet, ensureCharacterPortraits,
  characterReadyForVideo, emitPortraitProgress,
} from '../../core/character-portrait.mjs';
// 角色定妆后台任务：长批量不再挂在一个 HTTP 请求上，逐张落盘 + SSE 进度 + 可查询/可暂停
import {
  startPortraitJob, getPortraitJob, getProjectPortraitJob, cancelPortraitJob, stalePortraitJob,
} from '../../core/portrait-jobs.mjs';
// 角色提取 / 封面智能体（agents 统一目录）：业务 Agent 与路由解耦，画布节点复用同一函数
import { extractProjectCharacters } from '../../agents/character-agent.mjs';
import { designCoverPrompt, MAX_COVER_REFS, parseImagePayload, resolveChatRefs, coverChat } from '../../agents/cover-agent.mjs';
import { resolveModelSettings } from '../../core/app-settings.mjs';
// 分镜板业务 Agent：分镜画面设置 + 按版式重排每段分镜板（业务口径不散落在路由里）
import { planStoryboardSheets, composeStoryboardSheets } from '../../agents/storyboard-agent.mjs';

/**
 * 单视图生成的内联实现已抽到 core/character-portrait.mjs。
 * 保留此薄封装只为兼容旧调用点，逻辑与业务层完全一致（不维护第二套口径）。
 */
async function generateView(project, m, character, viewKey, modelId = '', opts = {}) {
  const out = await generateCharacterView({
    project, m, character, viewKey, modelId,
    requireReal: opts.requireReal === true,
    interfaceId: String(opts.interfaceId || '').slice(0, 60),
    log: (level, msg) => emit('log', { projectId: project.id, level, message: `角色多视图 · ${msg}` }),
  });
  return out;
}

export async function handleManagement(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  // ---------- 创作项目管理：属性 / 复制 / 快照 / 六步执行 ----------
  const manageMatch = pathname.match(MATCH.manageAction);
  if (manageMatch) {
    const [, id, action] = manageMatch;
    const project = loadProject(id);
    if (!project) return json(res, { error: '项目不存在' }, 404), true;
    const m = ensureManagement(project);

    if (action === 'manage') {
      if (method === 'GET') {
        return json(res, { management: m, stats: projectStats(project), progress: stepProgress(m), steps: STEPS }), true;
      }
      if (method === 'POST' || method === 'PUT') {
        const body = await readBody(req);
        const out = applyManageAction(project, body.action, body.value);
        if (!out.ok) return json(res, out, 400), true;
        saveProject(project);
        broadcastMeta(project);
        emit('state', { projectId: id, project, reason: 'manage' });
        return json(res, { ok: true, message: out.message, management: m,
          stats: projectStats(project), progress: stepProgress(m) }), true;
      }
    }

    if (action === 'duplicate' && method === 'POST') {
      const copy = JSON.parse(JSON.stringify(project));
      copy.id = uid('prj');
      copy.name = `${project.name} · 副本`;
      copy.createdAt = Date.now(); copy.updatedAt = Date.now(); copy.runs = [];
      copy.management = {
        ...copy.management, title: copy.name, favorite: false, archived: false,
        createdAt: Date.now(), updatedAt: Date.now(),
        history: [{ id: uid('h'), at: Date.now(), action: 'duplicate', detail: `复制自「${project.name}」` }],
      };
      for (const n of copy.nodes) {
        if (['running', 'queued', 'error'].includes(n.status)) { n.status = 'idle'; n.progress = 0; n.error = ''; }
      }
      saveProject(copy);
      emit('state', { projectId: copy.id, project: copy, reason: 'created' });
      return json(res, copy, 201), true;
    }

    if (action === 'snapshots') {
      if (method === 'GET') return json(res, { snapshots: listSnapshots(id) }), true;
      if (method === 'POST') {
        const snapshot = writeSnapshot(project);
        emit('log', { projectId: id, level: 'info', message: `已创建项目快照 · ${snapshot.nodeCount} 节点` });
        return json(res, { ok: true, snapshot, snapshots: listSnapshots(id) }), true;
      }
    }

    if (action === 'restore' && method === 'POST') {
      const body = await readBody(req);
      const snap = readSnapshot(id, body.at);
      if (!snap) return json(res, { error: '快照不存在或已被清理' }, 404), true;
      writeSnapshot(project); // 恢复前自动留一个安全点，避免覆盖当前进度无法找回
      const restored = { ...snap, id, updatedAt: Date.now() };
      saveProject(restored);
      emit('state', { projectId: id, project: restored, reason: 'restore' });
      broadcastMeta(restored);
      return json(res, { ok: true, project: restored, snapshots: listSnapshots(id) }), true;
    }

    if (action === 'step' && method === 'POST') {
      const body = await readBody(req);
      const result = await executeSteps(loadProject(id), body);
      return json(res, result, result.ok ? 200 : 400), true;
    }
  }

  // ---------- 项目封面：上传 / ComfyUI 生成 / AI 对话式创作 / AI 一键生成 / 恢复名称封面 ----------
  const coverMatch = pathname.match(MATCH.cover);
  const coverGenMatch = pathname.match(MATCH.coverGenerate);
  const coverChatMatch = pathname.match(MATCH.coverChat);
  const coverAiMatch = pathname.match(MATCH.coverAi);
  if (coverMatch || coverGenMatch || coverChatMatch || coverAiMatch) {
    const id = (coverMatch || coverGenMatch || coverChatMatch || coverAiMatch)[1];
    const project = loadProject(id);
    if (!project) return json(res, { error: '项目不存在' }, 404), true;
    const m = ensureManagement(project);
    const commitCover = (value) => {
      const out = applyManageAction(project, 'cover', value);
      if (!out.ok) return out;
      saveProject(project);
      broadcastMeta(project);
      emit('state', { projectId: id, project, reason: 'cover' });
      return out;
    };

    // 封面对话式创作：对话历史 + 参考图（VLM 看图）→ AI 回复 + 提示词草稿 + 下一步建议
    if (coverChatMatch && method === 'POST') {
      const body = await readBody(req);
      try {
        const refs = resolveChatRefs(body.refs);
        const out = await coverChat({
          project, m, messages: body.messages, refs, modelId: body.modelId,
          log: (level, msg) => emit('log', { projectId: id, level, message: `封面对话 · ${msg}` }),
        });
        // 提示词草稿随对话即时保存（不改动封面图本身），生成成功后再经 cover 动作落定
        m.cover = { ...m.cover, prompt: out.prompt };
        saveProject(project);
        return json(res, {
          ok: true, ...out,
          message: out.source === 'llm' ? 'AI 已根据项目资料与参考图生成封面提示词'
            : out.fellBack ? 'LLM 未返回有效结果，已回退内置模板生成提示词'
            : '未配置大模型（设置 → 模型），已用内置模板生成提示词',
        }), true;
      } catch (err) {
        return json(res, { error: `封面对话失败：${err.message}` }, 502), true;
      }
    }

    // AI 一键生成封面：提示词 agent 设计画面 → 有 ComfyUI 工作流 / 图像接口时真实出图，
    // 都没有时用内置海报绘制兜底，保证「点一下总有封面」，并直接落定为项目封面
    if (coverAiMatch && method === 'POST') {
      const body = await readBody(req);
      const log = (level, msg) => emit('log', { projectId: id, level, message: `AI 封面 · ${msg}` });
      try {
        const providers = createProviders(resolveModelSettings(project, body.modelId), log);
        const designed = await designCoverPrompt({
          project, m, providers, modelId: body.modelId,
          requirement: String(body.requirement || m.bible?.logline || '').trim(),
          log,
        });
        const img = await providers.image({
          kind: 'poster', interfaceId: String(body.interfaceId || '').slice(0, 60),
          prompt: designed.prompt,
          negative: designed.negative,
          label: String(m.bible?.title || project.name),
          style: project.settings?.style,
          shotCount: (m.episodes || []).length,
        });
        const url = String(img?.url || '');
        if (!url) throw new Error('图像生成未返回可用图片');
        const file = url.startsWith('/assets/') ? url.slice(8) : '';
        if (file) {
          registerAsset({ file, kind: 'cover', name: `${project.name} 封面`, sourceProjectId: id, sourceProjectName: project.name });
        }
        const out = applyManageAction(project, 'cover', {
          url, source: img.provider === 'comfyui' ? 'comfyui' : 'ai', prompt: designed.prompt,
        });
        if (!out.ok) return json(res, out, 400), true;
        saveProject(project);
        broadcastMeta(project);
        emit('state', { projectId: id, project, reason: 'cover' });
        return json(res, {
          ok: true, cover: m.cover, prompt: designed.prompt, generated: { file, url },
          provider: img.provider || 'mock', promptSource: designed.source,
          message: img.provider === 'comfyui' ? 'AI 已按项目设定生成封面（ComfyUI）'
            : img.provider === 'remote' ? 'AI 已按项目设定生成封面（图像接口）'
            : 'AI 已生成封面草图（未配置出图工作流，使用内置海报绘制）',
        }), true;
      } catch (err) {
        return json(res, { error: `AI 生成封面失败：${err.message}` }, 502), true;
      }
    }

    // ComfyUI 出图生成封面（约 1–2 分钟，需已配置 imageWorkflow）；支持多参考图（资源库图片 / 本地上传）
    if (coverGenMatch && method === 'POST') {
      const body = await readBody(req);
      // 封面板块：默认走全局选中的出图接口，可绑定其它接口，也可由本次请求临时指定
      const config = resolveComfyConfig(project, undefined, {
        scope: 'cover', interfaceId: String(body.interfaceId || '').slice(0, 60),
      });
      if (!config.enabled || !config.imageWorkflow) {
        return json(res, { error: '尚未配置 ComfyUI 出图工作流，请先在设置中导入「导出(API)」工作流' }, 400), true;
      }
      const wf = parseWorkflow(config.imageWorkflow, '出图工作流');
      // 文本框内容即完整提示词（AI 生成或用户精调）原样使用；为空时交由独立提示词 agent 按项目资料设计（模板兜底）
      const rawPrompt = String(body.prompt || '').trim().slice(0, 2000);
      let prompt = rawPrompt;
      if (!prompt) {
        const designed = await designCoverPrompt({ project, m, requirement: String(body.requirement || ''), modelId: body.modelId });
        prompt = designed.prompt;
        emit('log', { projectId: id, level: 'info', message: `封面提示词 · 由提示词 agent 生成（${designed.source}）` });
      }
      const negative = String(body.negative || '').trim().slice(0, 600) || config.negativePrompt;

      // 参考图收集：refs=[{asset|dataUrl}]（也接受纯文件名字符串），按给定顺序对应 LoadImage 插槽
      const imageRefs = [];
      try {
        for (const item of (Array.isArray(body.refs) ? body.refs.slice(0, MAX_COVER_REFS) : [])) {
          const it = item && typeof item === 'object' ? item : { asset: String(item) };
          if (it.asset) {
            const name = String(it.asset);
            if (!/^[a-zA-Z0-9_.-]+$/.test(name) || !/\.(png|jpe?g|webp)$/i.test(name)) {
              throw new Error(`参考图「${name}」不是可用的图片资源（仅支持 PNG / JPEG / WebP）`);
            }
            const buf = readAsset(name);
            if (!buf) throw new Error(`参考图「${name}」不存在或已被删除`);
            imageRefs.push({ buffer: buf, name });
          } else if (it.dataUrl) {
            const { buf, ext } = parseImagePayload(it.dataUrl, `参考图 ${imageRefs.length + 1}：`, false);
            const url = writeAssetBinary(`ref_${id}_${Date.now().toString(36)}_${imageRefs.length}.${ext}`, buf);
            registerAsset({ file: url.slice(8), kind: 'image', name: `${project.name} 封面参考图`,
              tags: ['参考图'], sourceProjectId: id, sourceProjectName: project.name });
            imageRefs.push({ buffer: buf, name: url.slice(8) });
          } else {
            throw new Error(`参考图 ${imageRefs.length + 1} 缺少 asset 或 dataUrl`);
          }
        }
      } catch (err) {
        return json(res, { error: err.message }, 400), true;
      }
      // 调用记录：把本次 ComfyUI 调用的完整过程日志（提示词、参考图、注入结果、runWorkflow 日志）留档
      const callLogs = [];
      const logLine = (level, msg) => {
        callLogs.push(`[${level}] ${msg}`);
        emit('log', { projectId: id, level, message: `封面生成 · ${msg}` });
      };
      const recordCall = (extra = {}) => {
        const rec = {
          id: uid('call'), at: Date.now(), ok: false,
          prompt, negative,
          refs: imageRefs.map((r) => r.name), refCount: imageRefs.length,
          logs: callLogs.slice(-60),
          ...extra,
        };
        m.coverCalls = [rec, ...(m.coverCalls || [])].slice(0, 20);
        m.updatedAt = Date.now();
        saveProject(project);
        return rec;
      };
      try {
        const result = await runWorkflow(config, wf, {
          prompt, negative,
          filenamePrefix: `cover_${id}`, cfg: config,
          imageRefs,
        }, {
          bindings: config.bindings?.image || [],
          log: logLine,
        });
        const url = result.primary?.url;
        const file = String(url || '').startsWith('/assets/') ? String(url).slice(8) : '';
        recordCall({
          ok: Boolean(file),
          interfaceId: config.resolvedInterface?.id || null,
          interfaceName: config.resolvedInterface?.name || '',
          promptId: result.promptId, durationMs: result.durationMs,
          promptInjection: result.promptInjection || null,
          applied: (result.applied || []).map((a) => ({ node: a.node, input: a.input, by: a.by })),
          error: file ? '' : 'ComfyUI 未返回封面图片',
        });
        if (!file) return json(res, { error: 'ComfyUI 未返回封面图片' }, 502), true;
        // 不直接设为封面：先入资源库，由前端放大预览，用户确认后才经 POST /cover {asset} 落定
        registerAsset({ file, kind: 'cover', name: `${project.name} 封面`, sourceProjectId: id, sourceProjectName: project.name });
        return json(res, { ok: true, generated: { file, url }, prompt,
          promptId: result.promptId, durationMs: result.durationMs, message: '封面已生成，预览确认后保存' }), true;
      } catch (err) {
        recordCall({ error: err.message, durationMs: 0 });
        return json(res, { error: `封面生成失败：${err.message}` }, 502), true;
      }
    }

    // 本地上传（dataURL base64），存入 /assets/ 供静态服务直接访问
    if (coverMatch && method === 'POST') {
      const body = await readBody(req);
      // 从资源库复用已有图片：只接受指向 /assets/ 的合法图片资源，完整走 commitCover 链路；
      // 确认保存 ComfyUI 生成结果时随带生成提示词（prompt），完整落盘不截断
      if (body.asset) {
        const name = String(body.asset);
        if (!/^[a-zA-Z0-9_.-]+$/.test(name) || !/\.(png|jpe?g|webp|gif)$/i.test(name)) {
          return json(res, { error: '仅支持从资源库选择 PNG / JPEG / WebP / GIF 图片' }, 400), true;
        }
        if (!readAsset(name)) return json(res, { error: '资源不存在或已被删除' }, 404), true;
        const out = commitCover({ url: `/assets/${name}`, source: 'upload', prompt: String(body.prompt || '') });
        if (!out.ok) return json(res, out, 400), true;
        return json(res, { ok: true, cover: m.cover, url: m.cover?.url, message: out.message }), true;
      }
      const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || '').trim());
      if (!match) return json(res, { error: '仅支持 PNG / JPEG / WebP / GIF 图片' }, 400), true;
      const buf = Buffer.from(match[2], 'base64');
      if (!buf.length || buf.length > 6 * 1024 * 1024) return json(res, { error: '图片大小需在 1B–6MB 之间' }, 400), true;
      const head = buf.subarray(0, 8).toString('hex');
      const valid = match[1] === 'png' ? head.startsWith('89504e47')
        : match[1] === 'jpeg' ? head.startsWith('ffd8ff')
        : match[1] === 'webp' ? head.startsWith('52494646')
        : /^47494638/.test(head);
      if (!valid) return json(res, { error: '图片内容与声明格式不符' }, 400), true;
      const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
      const url = writeAssetBinary(`cover_${id}_${Date.now().toString(36)}.${ext}`, buf);
      registerAsset({ file: url.slice(8), kind: 'cover', name: `${project.name} 封面`, sourceProjectId: id, sourceProjectName: project.name });
      const out = commitCover({ url, source: 'upload' });
      if (!out.ok) return json(res, out, 400), true;
      return json(res, { ok: true, cover: m.cover, url, message: out.message }), true;
    }

    // 清除封面 → 回退「项目名称封面」
    if (coverMatch && method === 'DELETE') {
      const out = commitCover({ source: 'name' });
      if (!out.ok) return json(res, out, 400), true;
      return json(res, { ok: true, cover: m.cover, message: out.message }), true;
    }
  }

  // ---------- 角色管理：从小说提取角色属性 / 生成角色多视图 ----------
  const charExtractMatch = pathname.match(MATCH.charExtract);
  if (charExtractMatch) {
    if (method !== 'POST') return json(res, { error: '需要 POST' }, 405), true;
    const id = decodeURIComponent(charExtractMatch[1]);
    const project = loadProject(id);
    if (!project) return json(res, { error: '项目不存在' }, 404), true;
    const m = ensureManagement(project);
    if (!m.source?.text) return json(res, { error: '尚未上传小说，无法提取角色' }, 400), true;
    const body = await readBody(req);
    // 提取逻辑统一走角色提取智能体：路由只负责读请求 → 落盘 → 广播
    const result = await extractProjectCharacters({
      project, m,
      mode: body.mode,
      limit: body.limit,
      modelId: body.modelId,
      log: (level, msg) => emit('log', { projectId: id, level, message: msg }),
    });
    if (!result.ok) return json(res, { error: result.error }, 400), true;
    const merged = mergeExtracted(m.characters, result.extracted, { source: result.source });
    const out = applyManageAction(project, 'characters', merged.characters);
    if (!out.ok) return json(res, out, 400), true;
    saveProject(project);
    broadcastMeta(project);
    // 提取即配声：给还没有音色的角色自动分配「互不重复」的音色（音色分配 Agent，
    // LLM 优先 / 启发式兜底；手动指定过的绑定原样保留）。失败不阻断提取主流程。
    let voiceResult = null;
    try {
      voiceResult = await assignVoices({
        project, m, onlyMissing: true, modelId: body.modelId,
        log: (level, msg) => emit('log', { projectId: id, level, message: `音色分配 · ${msg}` }),
      });
      if (voiceResult.applied) {
        saveProject(project);
        broadcastMeta(project);
      }
    } catch (err) {
      emit('log', { projectId: id, level: 'warn', message: `提取后自动分配音色失败（不影响角色）：${err.message}` });
    }
    emit('state', { projectId: id, project, reason: 'characters' });
    return json(res, {
      ok: true, characters: m.characters,
      added: merged.added, merged: merged.merged, removed: merged.removed || [],
      fellBack: result.fellBack, message: result.message,
      source: result.source, stats: result.stats,
      voice: voiceResult ? { applied: voiceResult.applied, skipped: voiceResult.skipped, message: voiceResult.message } : null,
    }), true;
  }

  /**
   * 单镜头重出分镜图：第⑤步面板上「↻ 重出本镜」的后端。
   * 只把这一镜的关键帧 / 择优复位（清掉上一轮候选，含占位图），
   * 其它镜头已出的真实图不受影响——40 镜全量重出要几十分钟 GPU，不能为一张图全烧。
   */
  const shotRegenMatch = pathname.match(MATCH.shotRegen);
  if (shotRegenMatch) {
    if (method !== 'POST') return json(res, { error: '需要 POST' }, 405), true;
    const id = decodeURIComponent(shotRegenMatch[1]);
    const shotKey = decodeURIComponent(shotRegenMatch[2]);
    const project = loadProject(id);
    if (!project) return json(res, { error: '项目不存在' }, 404), true;
    if (isRunning(id)) return json(res, { error: '项目正在运行，等当前任务结束再重出这一镜' }, 409), true;
    const shotNode = (project.nodes || []).find((n) => n.type === 'shot'
      && (n.id === shotKey
        || String(n.data?.shot?.shotNo) === shotKey
        || String(n.data?.shot?.sequence) === shotKey));
    if (!shotNode) return json(res, { error: '镜头不存在' }, 404), true;
    const edges = project.edges || [];
    const keyframeNode = (project.nodes || []).find((n) => n.type === 'keyframe'
      && edges.some((e) => e.from === shotNode.id && e.to === n.id));
    if (!keyframeNode) return json(res, { error: '这个镜头还没有关键帧节点：请先执行第④步展开镜头链' }, 400), true;
    keyframeNode.status = 'idle'; keyframeNode.progress = 0; keyframeNode.error = '';
    keyframeNode.data = { ...(keyframeNode.data || {}), candidates: [] };
    const reviewNode = (project.nodes || []).find((n) => n.type === 'review'
      && edges.some((e) => e.from === keyframeNode.id && e.to === n.id));
    if (reviewNode) {
      reviewNode.status = 'idle'; reviewNode.progress = 0; reviewNode.error = '';
      reviewNode.data = { ...(reviewNode.data || {}), keyframeUrl: '', candidates: [], selected: 0, scores: [] };
    }
    saveProject(project);
    broadcastMeta(project);
    emit('log', { projectId: id, level: 'info', message: `↻ 重出镜头 ${shotNode.data?.shot?.shotNo ?? '?'}：只复位这一镜的关键帧与择优` });
    try {
      const summary = await runProject(id, { project, scope: ['keyframe', 'review'], videoStage: false });
      saveProject(project);
      broadcastMeta(project);
      emit('state', { projectId: id, project, reason: 'storyboard-shot' });
      const image = keyframeImage(keyframeNode);
      const real = isRealKeyframe(keyframeNode);
      const err = keyframeNode.error || '';
      return json(res, {
        ok: real,
        shotNo: shotNode.data?.shot?.shotNo ?? null,
        nodeId: keyframeNode.id,
        image: image ? { url: image.url, provider: image.provider, prompt: image.prompt } : null,
        status: keyframeNode.status,
        error: err,
        message: real ? `镜头 ${shotNode.data?.shot?.shotNo ?? ''} 已重出真实分镜图`
          : `镜头 ${shotNode.data?.shot?.shotNo ?? ''} 仍未拿到真实图：${err || 'ComfyUI 未返回图片'}`,
        run: { nodes: summary.nodeCount, failed: summary.failed },
      }), true;
    } catch (runErr) {
      return json(res, { error: `重出本镜失败：${runErr.message}` }, 502), true;
    }
  }

  /**
   * ComfyUI 任务对账（第⑥步任务看板「⟲ 检查已完成」）。
   * 为什么需要它：ComfyUI 是独立进程，服务重启 / 请求中断后它的队列和历史还在，
   * 但画布节点会停在「已发送 · 排队中」。这条路由把已完成的任务直接取回，
   * 正在跑 / 排队的保留状态，只有 ComfyUI 侧也查不到的才复位；
   * body.resubmit=true 时把复位掉的重新发一遍（找不到才重发，绝不无脑重烧）。
   */
  const recMatch = pathname.match(MATCH.comfyReconcile);
  if (recMatch) {
    if (method !== 'POST') return json(res, { error: '需要 POST' }, 405), true;
    const id = decodeURIComponent(recMatch[1]);
    const project = loadProject(id);
    if (!project) return json(res, { error: '项目不存在' }, 404), true;
    const body = await readBody(req).catch(() => ({}));
    const cfg = resolveComfyConfig(project);
    // 项目正在跑时不复位任何节点（否则会和当前调度打架）：只做「取回已完成」
    const runningNow = isRunning(id);
    // auto=true 是页面打开第⑥步时的静默自检：正在跑的项目直接跳过，绝不去动实时调度
    if (body?.auto === true && runningNow) {
      return json(res, { ok: true, skipped: 'running', message: '项目正在运行，跳过自检' }), true;
    }
    const report = await reconcileProjectComfy(project, {
      config: cfg, resetMissing: !runningNow,
      log: (level, message) => emit('log', { projectId: id, level, message }),
    });
    if (!report.ok) return json(res, { ok: false, ...report }, 200), true;

    // 复位（查无结果 → 待发送）同样要落盘：否则刷新页面这些节点又变回「排队中」，
    // 用户看到的假象就永远修不掉。
    if (report.adopted.length || report.reset.length || report.running.length || report.queued.length) {
      saveProject(project);
      broadcastMeta(project);
      emit('state', { projectId: id, project, reason: 'comfy-reconcile' });
    }

    let resubmit = null;
    if (body?.resubmit === true && report.lost.length) {
      if (runningNow) {
        resubmit = { started: false, message: '项目正在运行，等当前任务结束后再重发' };
      } else {
        const types = [...new Set(report.lost.map((n) => n.type))].filter((t) => t !== 'review');
        emit('log', { projectId: id, level: 'info',
          message: `↻ 重新发送 ${report.lost.length} 条在 ComfyUI 查无结果的任务（${types.join(' / ')}）` });
        try {
          const summary = await runProject(id, {
            project, scope: types,
            videoStage: types.includes('video') || types.includes('transition'),
          });
          saveProject(project);
          broadcastMeta(project);
          emit('state', { projectId: id, project, reason: 'comfy-resubmit' });
          resubmit = {
            started: true, count: report.lost.length,
            run: { status: summary.status, nodes: summary.nodeCount, failed: summary.failed },
          };
        } catch (err) {
          resubmit = { started: false, message: `重发失败：${err.message}` };
        }
      }
    }

    if (report.running.length || report.queued.length) watchComfyJobs(id, cfg);
    return json(res, {
      ok: true, ...report, resubmit,
      message: resubmit?.started
        ? `${report.message}；已重新发送 ${report.lost.length} 条`
        : report.message,
    }), true;
  }

  /**
   * 分镜画面设置 + 分镜板重排（第⑤步操作台）。
   * GET  ：读设置 / 版式清单 / 统计（几张板、几格、几张真实分镜图、几张板与当前版式不一致）
   * POST ：保存设置（可选）→ 按版式重排所有段的分镜板（纯 SVG 合成，不动关键帧、不烧 GPU）
   * 面板上的「保存并重排分镜图」就是走这条路由；「只保存」走 manage 的 storyboard 动作。
   */
  const sheetsMatch = pathname.match(MATCH.storyboardSheets);
  if (sheetsMatch) {
    const id = decodeURIComponent(sheetsMatch[1]);
    const project = loadProject(id);
    if (!project) return json(res, { error: '项目不存在' }, 404), true;
    const m = ensureManagement(project);
    if (method === 'GET') {
      return json(res, { ok: true, ...planStoryboardSheets(project, m) }), true;
    }
    if (method !== 'POST') return json(res, { error: '需要 GET / POST' }, 405), true;
    const body = await readBody(req);
    const patch = body?.settings && typeof body.settings === 'object' ? body.settings : body;
    try {
      const out = await composeStoryboardSheets({
        project, m,
        patch: patch && typeof patch === 'object' ? patch : {},
        log: (level, message) => emit('log', { projectId: id, level, message }),
      });
      if (!out.ok) return json(res, out, 400), true;
      saveProject(project);
      broadcastMeta(project);
      emit('state', { projectId: id, project, reason: 'storyboard-sheets' });
      emit('log', {
        projectId: id, level: 'info',
        message: `分镜板已重排：${out.description || ''} · ${out.grids} 张`,
      });
      return json(res, {
        ok: true, ...out,
        management: m, stats: projectStats(project), progress: stepProgress(m),
      }), true;
    } catch (err) {
      return json(res, { error: `分镜板重排失败：${err.message}` }, 502), true;
    }
  }

  const charViewsMatch = pathname.match(MATCH.charViews);
  if (charViewsMatch) {
    if (method !== 'POST') return json(res, { error: '需要 POST' }, 405), true;
    const id = decodeURIComponent(charViewsMatch[1]);
    const project = loadProject(id);
    if (!project) return json(res, { error: '项目不存在' }, 404), true;
    const m = ensureManagement(project);
    const body = await readBody(req);
    const character = (m.characters || []).find((c) => c.id === String(body.characterId || ''));
    if (!character) return json(res, { error: '角色不存在' }, 404), true;
    try {
      // view 可传单视图 key，也可传 'sheet'（多视图并排定妆板）
      if (String(body.view || '') === 'sheet') {
        const out = await generateCharacterSheet({
          project, m, character, modelId: body.modelId,
          views: Array.isArray(body.views) && body.views.length ? body.views : null,
          requireReal: body.requireReal === true,
          interfaceId: String(body.interfaceId || '').slice(0, 60),
          log: (level, msg) => emit('log', { projectId: id, level, message: `角色定妆板 · ${msg}` }),
        });
        saveProject(project);
        broadcastMeta(project);
        emit('state', { projectId: id, project, reason: 'characters' });
        return json(res, {
          ok: true, ...out, ready: characterReadyForVideo(character),
          characters: m.characters,
        }), true;
      }
      const out = await generateView(project, m, character, String(body.view || ''), body.modelId,
        { requireReal: body.requireReal === true, interfaceId: body.interfaceId });
      saveProject(project);
      broadcastMeta(project);
      emit('state', { projectId: id, project, reason: 'characters' });
      return json(res, {
        ok: true, ...out, ready: characterReadyForVideo(character),
        characters: m.characters,
      }), true;
    } catch (err) {
      return json(res, { error: `角色多视图生成失败：${err.message}` }, 502), true;
    }
  }

  /**
   * 批量补全定妆：scope=core（正面/3-4 侧/侧面/背面）或 all（含面部特写）；
   * includeSheet=true 时同时生成定妆板。逐张落盘 + SSE 进度，可断点续跑。
   *
   * 默认异步：立即返回 jobId，生成在后台继续跑（12 位角色 × 6 张 ≈ 40 分钟，
   * 挂在一个同步请求上会导致前端「一直待生成」、刷新即失联）。
   * 传 sync:true 可退回同步语义（脚本/测试用）。
   */
  const charViewsAllMatch = pathname.match(MATCH.charViewsAll);
  if (charViewsAllMatch) {
    if (method !== 'POST') return json(res, { error: '需要 POST' }, 405), true;
    const id = decodeURIComponent(charViewsAllMatch[1]);
    const project = loadProject(id);
    if (!project) return json(res, { error: '项目不存在' }, 404), true;
    const m = ensureManagement(project);
    const body = await readBody(req);
    const all = m.characters || [];
    if (!all.length) return json(res, { error: '还没有角色：请先在「角色」页从原著提取或手动新增' }, 400), true;

    // 兼容旧参数 allViews：true 等价 scope=core（含面部特写用 scope=all）
    const scope = String(body.scope || (body.allViews === true ? 'core' : 'core'));
    const onlyMissing = body.onlyMissing !== false;
    const includeSheet = body.includeSheet === true || body.sheet === true;
    const jobOpts = {
      scope, onlyMissing, sheet: includeSheet,
      characterIds: Array.isArray(body.characterIds) ? body.characterIds : null,
      regenerateMock: body.regenerateMock === true,
      requireReal: body.requireReal === true,
      concurrency: Number(body.concurrency) || 2,
      modelId: body.modelId,
      interfaceId: String(body.interfaceId || '').slice(0, 60),
    };

    if (body.sync !== true) {
      const job = startPortraitJob({
        project, m, opts: jobOpts,
        hooks: {
          save: () => saveProject(project),
          // 任务快照写进项目：服务重启 / 进程退出后第⑤步仍能看到进度与「最近一次」状态
          persist: (snapshot) => {
            m.portraitJob = snapshot;
            try { saveProject(project); } catch { /* 落盘失败不影响任务继续跑 */ }
          },
          onFinish: () => {
            broadcastMeta(project);
            emit('state', { projectId: id, project, reason: 'characters' });
          },
        },
      });
      const pending = job.total - job.done;
      return json(res, {
        ok: true, async: true, jobId: job.id, total: job.total,
        message: job.status === 'running'
          ? `已开始生成：${job.characters} 位角色 · 待出 ${pending} 张（后台任务，关闭页面也会继续）`
          : job.message,
        job,
      }, 202), true;
    }

    try {
      const out = await ensureCharacterPortraits({
        project, m,
        scope, onlyMissing, sheet: includeSheet,
        characterIds: Array.isArray(body.characterIds) ? body.characterIds : null,
        regenerateMock: body.regenerateMock === true,
        requireReal: body.requireReal === true,
        interfaceId: String(body.interfaceId || '').slice(0, 60),
        modelId: body.modelId,
        save: () => saveProject(project),
        log: (level, msg) => emit('log', { projectId: id, level, message: `角色定妆 · ${msg}` }),
        onProgress: (evt) => emitPortraitProgress(id, evt),
      });
      broadcastMeta(project);
      emit('state', { projectId: id, project, reason: 'characters' });
      if (!out.ok && out.error) return json(res, { error: out.error, ...out }, 400), true;
      // 与定妆智能体同一口径：面板需要「哪些角色已能进视频」与项目级完整度，
      // 而不是自己去遍历 views —— 前端与后端只认一份判定。
      const ready = Object.fromEntries((m.characters || []).map((c) => [c.id, characterReadyForVideo(c)]));
      const readyList = Object.values(ready);
      const blocked = (m.characters || []).filter((c) => !ready[c.id]?.ok).map((c) => c.name);
      return json(res, {
        ok: true, ...out,
        characters: m.characters,
        ready,
        portraitStatus: out.status,
        videoReady: {
          total: readyList.length,
          ready: readyList.filter((r) => r.ok).length,
          blocked,
          label: blocked.length
            ? `${blocked.length} 位角色还不可进视频（${blocked.slice(0, 3).join('、')}${blocked.length > 3 ? ' 等' : ''}）`
            : `${readyList.length} 位角色均可进入视频生成`,
        },
      }), true;
    } catch (err) {
      return json(res, { error: `批量定妆失败：${err.message}` }, 502), true;
    }
  }

  // ---------- 角色定妆任务：查询进度 / 恢复页面状态 / 暂停 ----------
  const charJobMatch = pathname.match(MATCH.charJob);
  if (charJobMatch) {
    const id = decodeURIComponent(charJobMatch[1]);
    const jobId = charJobMatch[2];
    const project = loadProject(id);
    if (!project) return json(res, { error: '项目不存在' }, 404), true;
    if (method === 'POST') {
      const body = await readBody(req);
      if (body.action === 'cancel') {
        const job = cancelPortraitJob(jobId);
        return json(res, { ok: true, job }, job ? 200 : 404), true;
      }
    }
    // 内存任务表里没有（重启 / 已过保留期）时回落到项目里落盘的快照
    const saved = ensureManagement(project).portraitJob;
    const job = getPortraitJob(jobId)
      || (saved && String(saved.id) === String(jobId) ? stalePortraitJob(saved) : null);
    if (!job || job.projectId !== id) return json(res, { error: '任务不存在或已过期' }, 404), true;
    return json(res, { ok: true, job }), true;
  }
  const charJobsMatch = pathname.match(MATCH.charJobs);
  if (charJobsMatch) {
    const id = decodeURIComponent(charJobsMatch[1]);
    const live = getProjectPortraitJob(id);
    if (live) return json(res, { ok: true, job: live, persisted: false }), true;
    const project = loadProject(id);
    const saved = project ? ensureManagement(project).portraitJob : null;
    return json(res, { ok: true, job: stalePortraitJob(saved), persisted: true }), true;
  }


  // ---------- AI 生成小说：大纲预览 / 整本生成并注入（等价于上传小说，完成 ①② 步） ----------
  const novelAiMatch = pathname.match(MATCH.novelAi);
  if (novelAiMatch) {
    if (method !== 'POST') return json(res, { error: '需要 POST' }, 405), true;
    const id = decodeURIComponent(novelAiMatch[1]);
    const project = loadProject(id);
    if (!project) return json(res, { error: '项目不存在' }, 404), true;
    const m = ensureManagement(project);
    if (m.kind !== 'novel') return json(res, { error: '只有创作项目支持 AI 生成小说' }, 400), true;
    if (isRunning(id)) return json(res, { error: '项目正在运行，稍后再生成' }, 409), true;
    const body = await readBody(req);
    const providers = createProviders(resolveModelSettings(project, body.modelId),
      (level, msg) => emit('log', { projectId: id, level, message: `AI 小说 · ${msg}` }));
    const idea = String(body.idea || m.bible?.logline || m.bible?.firstEpisodeTheme || project.name || '').trim().slice(0, 600);
    const chapterCount = Math.max(1, Math.min(8, Number(body.chapterCount) || 3));
    const chapterChars = Math.max(300, Math.min(2000, Number(body.chapterChars) || 800));
    // 大纲归一：LLM / Mock / 用户编辑过的输入都收敛到同一结构，防止脏数据进正文生成
    const normalizeOutline = (raw, titleFallback) => {
      const chapters = (Array.isArray(raw?.chapters) ? raw.chapters : [])
        .map((c, i) => ({
          title: String(c?.title || `第${i + 1}章`).trim().slice(0, 46),
          summary: String(c?.summary || '').trim().slice(0, 200),
          hook: String(c?.hook || '').trim().slice(0, 120),
        })).filter((c) => c.title).slice(0, 8);
      if (!chapters.length) throw new Error('大纲没有任何有效章节');
      return {
        title: String(raw?.title || titleFallback || '未命名小说').trim().slice(0, 40),
        genre: String(raw?.genre || '').trim().slice(0, 24),
        logline: String(raw?.logline || '').trim().slice(0, 120),
        chapters,
      };
    };
    try {
      if (body.mode === 'outline') {
        const out = await providers.generate('novelOutline', {
          idea, title: project.name, chapterCount, style: project.settings?.style,
        });
        const outline = normalizeOutline(out, project.name);
        const fromMock = providers.mode !== 'openai' || Boolean(out.__fallback) || (out.__mockKeys || []).includes('chapters');
        return json(res, {
          ok: true, outline, provider: providers.mode,
          source: fromMock ? (providers.mode === 'openai' ? 'fallback' : 'mock') : 'llm',
          message: providers.mode === 'openai'
            ? (fromMock ? 'LLM 未返回有效大纲，已用内置模板生成，可编辑后继续' : 'AI 大纲已生成，可编辑后生成全文')
            : '未配置大模型（设置 → 模型），以下为内置模板演示大纲，配置后可由 AI 按构想生成',
        }), true;
      }
      // 整本生成：大纲（可用用户编辑版）→ 逐章正文 → 拼接 → attachSource 注入并分集
      let outline = null;
      let outlineMock = false;
      if (body.outline && Array.isArray(body.outline.chapters) && body.outline.chapters.length) {
        outline = normalizeOutline(body.outline, project.name);
      } else {
        const out = await providers.generate('novelOutline', {
          idea, title: project.name, chapterCount, style: project.settings?.style,
        });
        outline = normalizeOutline(out, project.name);
        outlineMock = Boolean(out.__fallback) || (out.__mockKeys || []).includes('chapters');
      }
      emit('log', { projectId: id, level: 'info', message: `AI 小说 ·《${outline.title}》${outline.chapters.length} 章 · 开始逐章生成正文` });
      const parts = [];
      let chapterMock = false;
      for (const [i, ch] of outline.chapters.entries()) {
        const out = await providers.generate('novelChapter', {
          idea, title: outline.title, chapterTitle: ch.title, summary: ch.summary, hook: ch.hook,
          chapterChars, index: i, total: outline.chapters.length, style: project.settings?.style,
        });
        const text = String(out?.text || '').trim();
        if (text.length < 40) throw new Error(`「${ch.title}」生成内容过短，请重试`);
        if (out?.__fallback || (out?.__mockKeys || []).includes('text')) chapterMock = true;
        parts.push(`${ch.title}\n${text}`);
      }
      const full = `${outline.title}\n\n${parts.join('\n\n')}`;
      const r = attachSource(project, { text: full, filename: `${outline.title}.txt`, split: body.split });
      saveProject(project);
      broadcastMeta(project);
      emit('state', { projectId: id, project, reason: 'source' });
      emit('log', { projectId: id, level: 'info', message: `✦ AI 小说已注入：${r.message}` });
      const mocked = providers.mode !== 'openai' || outlineMock || chapterMock;
      return json(res, {
        ok: true, message: r.message, outline,
        novel: { title: r.novel.title, chapterCount: r.novel.chapterCount, totalChars: r.novel.totalChars },
        episodeCount: r.episodes.length,
        provider: providers.mode,
        source: mocked ? (providers.mode === 'openai' ? 'fallback' : 'mock') : 'llm',
        management: project.management,
        progress: stepProgress(project.management),
      }), true;
    } catch (err) {
      return json(res, { error: `AI 生成小说失败：${err.message}` }, 502), true;
    }
  }

  // ---------- AI 补全项目信息：一句话构想 → 创作设定（bible）只补空字段，不覆盖手改 ----------
  const bibleAiMatch = pathname.match(MATCH.bibleAi);
  if (bibleAiMatch) {
    if (method !== 'POST') return json(res, { error: '需要 POST' }, 405), true;
    const id = decodeURIComponent(bibleAiMatch[1]);
    const project = loadProject(id);
    if (!project) return json(res, { error: '项目不存在' }, 404), true;
    const m = ensureManagement(project);
    const body = await readBody(req);
    // 一键生成不强制用户先写构想：没有构想时用项目名 / 原著标题作为题材依据
    const idea = String(body.idea || m.bible?.logline || m.source?.title || project.name || '').trim().slice(0, 600);
    if (!idea) return json(res, { error: '请先输入一句话故事构想或给项目命名，AI 才能据此补全项目信息' }, 400), true;
    const providers = createProviders(resolveModelSettings(project, body.modelId),
      (level, msg) => emit('log', { projectId: id, level, message: `AI 项目信息 · ${msg}` }));
    try {
      // 显式点「AI 一键生成」时允许整组重写（否则只补空字段，已有名称/设定永远改不动）
      const overwrite = body.regenerate === true && providers.mode === 'openai';
      const out = await providers.generate('storyIdea', {
        idea, title: overwrite ? undefined : project.name, style: project.settings?.style,
      });
      const fromMock = providers.mode !== 'openai' || Boolean(out.__fallback) || (out.__mockKeys || []).includes('logline');
      // 真实模型调用失败时不再拿内置模板冒充 AI 结果写进项目（旧行为会让用户以为生成成功）
      if (providers.mode === 'openai' && out.__fallback) {
        return json(res, {
          ok: true, bible: m.bible, filled: 0, name: project.name, source: 'fallback',
          message: 'AI 调用失败（模型未返回有效内容，详见运行日志），已保留现有项目信息',
        }), true;
      }
      // 只有真实模型产出才允许整组重写；内置模板只在字段为空时补位，绝不覆盖用户内容
      const canRewrite = overwrite && !fromMock;
      const templateKeys = new Set(out.__mockKeys || []);
      const b = m.bible || {};
      const patch = {};
      const fields = ['title', 'genre', 'audience', 'logline', 'tone', 'artStyle', 'firstEpisodeTheme', 'worldview'];
      for (const f of fields) {
        const v = String(out?.[f] || '').trim();
        if (!v) continue;
        if (canRewrite) {
          // 整组重写时也只采纳模型自己产出的字段，模板补位值不写回
          if (!templateKeys.has(f)) patch[f] = v;
        } else if (!String(b[f] || '').trim()) {
          patch[f] = v;
        }
      }
      if (!Object.keys(patch).length) {
        const failed = providers.mode === 'openai' && fromMock;
        return json(res, {
          ok: true, bible: m.bible, filled: 0, name: project.name,
          source: fromMock ? (providers.mode === 'openai' ? 'fallback' : 'mock') : 'llm',
          message: failed ? 'AI 调用未返回有效内容，已保留现有项目信息，请稍后重试'
            : '项目信息已完整，无需补全（清空字段后可重新生成）',
        }), true;
      }
      const applied = applyManageAction(project, 'bible', patch);
      if (!applied.ok) return json(res, applied, 400), true;
      // 项目名：占位名必改；一键生成（overwrite）时以 AI 剧名为准，让「项目名称」确实被生成
      const placeholder = /^(未命名项目|新建项目|未命名)?$/.test(String(project.name || '').trim());
      const aiTitle = String(patch.title || m.bible.title || '').trim();
      let renamedTo = '';
      if (aiTitle && aiTitle !== project.name && (placeholder || canRewrite)) {
        applyManageAction(project, 'rename', aiTitle);
        renamedTo = project.name;
      }
      saveProject(project);
      broadcastMeta(project);
      emit('state', { projectId: id, project, reason: 'bible' });
      return json(res, {
        ok: true, bible: m.bible, filled: Object.keys(patch).length, renamedTo, name: project.name,
        source: fromMock ? (providers.mode === 'openai' ? 'fallback' : 'mock') : 'llm',
        message: providers.mode === 'openai'
          ? (fromMock ? `LLM 未返回有效内容，已用内置模板补全 ${Object.keys(patch).length} 项` : `AI 已补全 ${Object.keys(patch).length} 项项目信息${renamedTo ? `，并命名为「${renamedTo}」` : ''}`)
          : `未配置大模型，已用内置模板补全 ${Object.keys(patch).length} 项；配置后可由 AI 按构想生成`,
      }), true;
    } catch (err) {
      return json(res, { error: `AI 补全项目信息失败：${err.message}` }, 502), true;
    }
  }

  return false;
}
