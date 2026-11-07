// 创作项目管理域：属性 / 复制 / 快照恢复 / 六步执行 / 项目封面
import { json, readBody } from '../http.mjs';
import { MATCH } from './match.mjs';
import { loadProject, saveProject, uid, listSnapshots, writeSnapshot, readSnapshot, writeAssetBinary, readAsset } from '../../core/store.mjs';
import { registerAsset } from '../../core/assets.mjs';
import { emit } from '../../core/events.mjs';
import { ensureManagement, applyManageAction, projectStats, stepProgress, STEPS } from '../../core/project-steps.mjs';
import { attachSource } from '../../pipelines/novel-project.mjs';
import { isRunning } from '../../core/orchestrator.mjs';
import { resolveComfyConfig } from '../../core/comfy-config.mjs';
import { parseWorkflow, runWorkflow } from '../../core/comfyui.mjs';
import { executeSteps, broadcastMeta } from '../../core/step-runner.mjs';
import { createProviders } from '../../core/providers.mjs';
import { extractCharacters } from '../../core/novel.mjs';
import { CHARACTER_VIEWS, buildExtractVars, buildViewPrompt, mergeExtracted, verifyEvidence } from '../../core/characters.mjs';
// 封面智能体（agents 统一目录）：提示词构建 / 参考图解析 / 对话编排都在那里
import { designCoverPrompt, MAX_COVER_REFS, parseImagePayload, resolveChatRefs, coverChat } from '../../agents/cover-agent.mjs';
import { resolveModelSettings } from '../../core/app-settings.mjs';

/**
 * 生成单个角色的某个视图，并写回 management.characters + 资源库。
 * 单视图端点与「一键生成全部角色」共用，保证两条路径字段口径完全一致。
 */
async function generateCharacterView(project, m, character, viewKey, modelId = '') {
  const view = CHARACTER_VIEWS.find((v) => v.key === viewKey);
  if (!view) throw new Error('视图必须是 front / side / back');
  const prompt = buildViewPrompt(character, view.key, {
    style: m.bible?.stylePrompt || project.settings?.style || '',
    negative: m.bible?.negativePrompt || '',
  });
  const providers = createProviders(resolveModelSettings(project, modelId),
    (level, msg) => emit('log', { projectId: project.id, level, message: `角色多视图 · ${msg}` }));
  // 论文对齐（ViMax CharacterPortraitsGenerator）：侧面/背面以正面定妆图为参考图，
  // 保证同一人物的脸型/发型/服装/配饰完全一致；正面图缺失时退化为纯文本描述
  const frontUrl = character.views?.front?.url || '';
  const refs = view.key === 'front' || !frontUrl ? [] : [frontUrl];
  if (view.key !== 'front' && !frontUrl) {
    emit('log', { projectId: project.id, level: 'warn', message: `角色多视图 · ${character.name} 缺正面定妆图，${view.label}将仅依据文字特征生成` });
  }
  const img = await providers.image({
    kind: 'character-view', view: view.key,
    label: `${character.name}·${view.label}`,
    prompt, palette: character.palette,
    style: project.settings?.style || 'cinematic',
    seed: `${project.id}-${character.id}-${view.key}`,
    refs,
  });
  const file = String(img.url || '').split('/').pop();
  registerAsset({
    file, kind: 'character', name: `${character.name}·${view.label}`,
    tags: ['角色', character.name, view.label, ...character.aliases].filter(Boolean),
    sourceProjectId: project.id, sourceProjectName: project.name,
  });
  character.views = {
    front: null, side: null, back: null, ...character.views,
    [view.key]: { file, url: img.url, prompt, provider: img.provider, at: Date.now() },
  };
  character.updatedAt = Date.now();
  m.updatedAt = Date.now();
  return { view: view.key, url: img.url, provider: img.provider, character };
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

  // ---------- 项目封面：上传 / ComfyUI 生成 / AI 对话式创作 / 恢复名称封面 ----------
  const coverMatch = pathname.match(MATCH.cover);
  const coverGenMatch = pathname.match(MATCH.coverGenerate);
  const coverChatMatch = pathname.match(MATCH.coverChat);
  if (coverMatch || coverGenMatch || coverChatMatch) {
    const id = (coverMatch || coverGenMatch || coverChatMatch)[1];
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

    // ComfyUI 出图生成封面（约 1–2 分钟，需已配置 imageWorkflow）；支持多参考图（资源库图片 / 本地上传）
    if (coverGenMatch && method === 'POST') {
      const config = resolveComfyConfig(project);
      if (!config.enabled || !config.imageWorkflow) {
        return json(res, { error: '尚未配置 ComfyUI 出图工作流，请先在设置中导入「导出(API)」工作流' }, 400), true;
      }
      const body = await readBody(req);
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
    const limit = Math.max(1, Math.min(8, Number(body.limit) || 8));
    const heuristic = () => extractCharacters(m.source.text, limit);
    let extracted = [];
    let fellBack = false;
    let message = '';
    if (body.mode === 'heuristic') {
      extracted = heuristic();
      message = `启发式提取到 ${extracted.length} 位候选角色`;
    } else {
      try {
        const providers = createProviders(resolveModelSettings(project, body.modelId), (level, msg) => emit('log', { projectId: id, level, message: `角色提取 · ${msg}` }));
        // 论文式(6)：全书分块 → BM25 召回 + 候选名原文定位 → 原文证据喂给模型
        const vars = buildExtractVars(project, m, limit);
        emit('log', { projectId: id, level: 'info', message: `角色提取 · 召回 ${vars.fragments.length} 段原著片段（候选 ${vars.candidates.length} 位）` });
        const out = await providers.generate('charExtract', vars);
        if (out?.__fallback || !Array.isArray(out?.characters) || !out.characters.length) throw new Error('模型未返回有效角色');
        extracted = out.characters;
        // 证据校验：引用必须能在原著原文里逐字定位，定位不到即视为幻觉引用并丢弃
        const checked = verifyEvidence(extracted, m.source.text);
        extracted = checked.characters;
        if (checked.dropped) {
          emit('log', { projectId: id, level: 'info', message: `角色提取 · 证据校验：${checked.verified} 条引用有效，${checked.dropped} 条无法在原著中定位已丢弃` });
        }
        message = `LLM 提取到 ${extracted.length} 位角色`;
      } catch (err) {
        // LLM 不可用/失败自动落回启发式，响应里明示，避免假成功
        extracted = heuristic();
        fellBack = true;
        message = `LLM 提取失败（${err.message}），已回退启发式提取 ${extracted.length} 位候选`;
      }
    }
    const source = (fellBack || body.mode === 'heuristic') ? 'heuristic' : 'llm';
    const merged = mergeExtracted(m.characters, extracted, { source });
    const out = applyManageAction(project, 'characters', merged.characters);
    if (!out.ok) return json(res, out, 400), true;
    saveProject(project);
    broadcastMeta(project);
    emit('state', { projectId: id, project, reason: 'characters' });
    return json(res, { ok: true, characters: m.characters, added: merged.added, merged: merged.merged, fellBack, message }), true;
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
      const out = await generateCharacterView(project, m, character, String(body.view || ''), body.modelId);
      saveProject(project);
      broadcastMeta(project);
      emit('state', { projectId: id, project, reason: 'characters' });
      return json(res, { ok: true, ...out }), true;
    } catch (err) {
      return json(res, { error: `角色多视图生成失败：${err.message}` }, 502), true;
    }
  }

  /** 一键生成全部角色：默认每位角色生成「正面」定妆图，可选三视图；逐项落盘 + SSE 进度 */
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
    const views = body.allViews === true
      ? CHARACTER_VIEWS.map((v) => v.key)
      : ['front'];
    const onlyMissing = body.onlyMissing !== false;
    const targets = onlyMissing
      ? all.filter((c) => views.some((v) => !c.views?.[v]?.url))
      : all;
    if (!targets.length) return json(res, { ok: true, total: 0, generated: 0, failed: [], message: '所有角色定妆图都已生成' }), true;

    const total = targets.length * views.length;
    let done = 0;
    let generated = 0;
    const failed = [];
    for (const c of targets) {
      for (const key of views) {
        if (onlyMissing && c.views?.[key]?.url) { done += 1; continue; }
        emit('character:batch', {
          projectId: id, done, total, characterId: c.id, name: c.name, view: key, status: 'running',
        });
        let lastOk = false;
        try {
          await generateCharacterView(project, m, c, key, body.modelId);
          generated += 1;
          lastOk = true;
        } catch (err) {
          failed.push(`${c.name}·${CHARACTER_VIEWS.find((v) => v.key === key)?.label || key}：${err.message}`);
        }
        done += 1;
        // 每张都落盘：中途失败 / 关闭页面也不会丢已完成的定妆图
        saveProject(project);
        emit('character:batch', {
          projectId: id, done, total, characterId: c.id, name: c.name, view: key,
          status: lastOk ? 'done' : 'error',
        });
      }
    }
    broadcastMeta(project);
    emit('state', { projectId: id, project, reason: 'characters' });
    return json(res, {
      ok: true, total: targets.length, generated, failed,
      characters: m.characters,
      message: `一键生成完成：${targets.length} 位角色 · 成功 ${generated} 张${failed.length ? ` · 失败 ${failed.length} 张` : ''}`,
    }), true;
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
    const idea = String(body.idea || '').trim().slice(0, 600);
    if (!idea) return json(res, { error: '请先输入一句话故事构想，AI 才能据此补全项目信息' }, 400), true;
    const providers = createProviders(resolveModelSettings(project, body.modelId),
      (level, msg) => emit('log', { projectId: id, level, message: `AI 项目信息 · ${msg}` }));
    try {
      const out = await providers.generate('storyIdea', { idea, title: project.name, style: project.settings?.style });
      const fromMock = providers.mode !== 'openai' || Boolean(out.__fallback) || (out.__mockKeys || []).includes('logline');
      // 只补空字段：用户已填的信息不被 AI 覆盖
      const b = m.bible || {};
      const patch = {};
      const fields = ['title', 'genre', 'audience', 'logline', 'tone', 'artStyle', 'firstEpisodeTheme', 'worldview'];
      for (const f of fields) {
        const v = String(out?.[f] || '').trim();
        if (v && !String(b[f] || '').trim()) patch[f] = v;
      }
      if (!Object.keys(patch).length) {
        return json(res, { ok: true, bible: m.bible, filled: 0, source: fromMock ? 'mock' : 'llm', message: '项目信息已完整，无需补全（清空字段后可重新生成）' }), true;
      }
      const applied = applyManageAction(project, 'bible', patch);
      if (!applied.ok) return json(res, applied, 400), true;
      saveProject(project);
      broadcastMeta(project);
      emit('state', { projectId: id, project, reason: 'bible' });
      return json(res, {
        ok: true, bible: m.bible, filled: Object.keys(patch).length,
        source: fromMock ? (providers.mode === 'openai' ? 'fallback' : 'mock') : 'llm',
        message: providers.mode === 'openai'
          ? (fromMock ? `LLM 未返回有效内容，已用内置模板补全 ${Object.keys(patch).length} 项` : `AI 已补全 ${Object.keys(patch).length} 项项目信息`)
          : `未配置大模型，已用内置模板补全 ${Object.keys(patch).length} 项；配置后可由 AI 按构想生成`,
      }), true;
    } catch (err) {
      return json(res, { error: `AI 补全项目信息失败：${err.message}` }, 502), true;
    }
  }

  return false;
}
