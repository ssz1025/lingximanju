// 创作项目管理域：属性 / 复制 / 快照恢复 / 六步执行 / 项目封面
import { json, readBody } from '../http.mjs';
import { MATCH } from './match.mjs';
import { loadProject, saveProject, uid, listSnapshots, writeSnapshot, readSnapshot, writeAssetBinary, readAsset } from '../../core/store.mjs';
import { registerAsset } from '../../core/assets.mjs';
import { emit } from '../../core/events.mjs';
import { ensureManagement, applyManageAction, projectStats, stepProgress, STEPS } from '../../core/project-steps.mjs';
import { attachSource } from '../../pipelines/novel-project.mjs';
import { isRunning } from '../../core/orchestrator.mjs';
import { loadComfyConfig } from '../../core/comfy-config.mjs';
import { parseWorkflow, runWorkflow } from '../../core/comfyui.mjs';
import { executeSteps, broadcastMeta } from '../../core/step-runner.mjs';
import { createProviders } from '../../core/providers.mjs';
import { extractCharacters } from '../../core/novel.mjs';
import { CHARACTER_VIEWS, buildExtractVars, buildViewPrompt, mergeExtracted } from '../../core/characters.mjs';

/** 封面生成提示词：片名 + 原著/剧本梗概 + 电影海报视觉要求（中文提示词可直接喂 SDXL） */
function buildCoverPrompt(project, m, custom = '') {
  const name = String(project.name || m.title || '未命名影片').slice(0, 40);
  const idea = (project.nodes || []).find((n) => n.type === 'idea');
  const script = (project.nodes || []).find((n) => n.type === 'script');
  const gist = [
    script?.data?.script?.logline || script?.data?.logline || '',
    (m.episodes || [])[0]?.summary || '',
    String(idea?.data?.text || '').replace(/\s+/g, ' ').slice(0, 90),
    String(m.source?.text || '').replace(/\s+/g, ' ').slice(0, 90),
  ].filter(Boolean).join('，').slice(0, 180);
  const base = `电影海报风格的项目封面插画，片名《${name}》，${gist || '一部富有戏剧张力的故事'}，` +
    `cinematic movie poster, dramatic cinematic lighting, rich atmosphere, centered composition, ` +
    `highly detailed, film grain, no text, no watermark, no lettering`;
  const extra = String(custom || '').trim().slice(0, 400);
  return extra ? `电影海报风格的项目封面插画，片名《${name}》，${extra}，cinematic movie poster, dramatic lighting, no text, no watermark` : base;
}

/** 封面提示词 AI 生成的 LLM 输入：项目名 + 简介 / 剧本梗概 + 分集摘要 + 小说节选 + 用户补充要求 */
function buildCoverVars(project, m, custom = '') {
  const name = String(project.name || m.title || '未命名影片').slice(0, 40);
  const idea = (project.nodes || []).find((n) => n.type === 'idea');
  const script = (project.nodes || []).find((n) => n.type === 'script');
  const logline = script?.data?.script?.logline || script?.data?.logline || '';
  return {
    title: name,
    genre: String(script?.data?.script?.genre || script?.data?.genre || ''),
    logline: String(logline).slice(0, 200),
    episodes: (m.episodes || []).slice(0, 6)
      .map((e) => `第${e.no}集《${e.title}》：${String(e.summary || '').replace(/\s+/g, ' ').slice(0, 120)}`),
    idea: String(idea?.data?.text || '').replace(/\s+/g, ' ').slice(0, 300),
    novelExcerpt: String(m.source?.text || '').replace(/\s+/g, ' ').slice(0, 1500),
    custom: String(custom || '').trim().slice(0, 400),
    style: project.settings?.style || '',
  };
}

/** dataURL → 合法图片二进制；失败抛错（与封面上传同校验：魔数 + 6MB 上限） */
function parseImagePayload(dataUrl, label = '图片', allowGif = true) {
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '').trim());
  if (!match) throw new Error(`${label}仅支持 PNG / JPEG / WebP / GIF 图片`);
  const buf = Buffer.from(match[2], 'base64');
  if (!buf.length || buf.length > 6 * 1024 * 1024) throw new Error(`${label}大小需在 1B–6MB 之间`);
  const head = buf.subarray(0, 8).toString('hex');
  const valid = match[1] === 'png' ? head.startsWith('89504e47')
    : match[1] === 'jpeg' ? head.startsWith('ffd8ff')
    : match[1] === 'webp' ? head.startsWith('52494646')
    : /^47494638/.test(head);
  if (!valid) throw new Error(`${label}内容与声明格式不符`);
  if (match[1] === 'gif' && !allowGif) throw new Error(`${label}不支持 GIF（ComfyUI 参考图仅支持 PNG / JPEG / WebP）`);
  return { buf, ext: match[1] === 'jpeg' ? 'jpg' : match[1] };
}

/** 参考图上限：与 ComfyUI LoadImage 插槽数量同量级，防止把整个资源库都上传一遍 */
const MAX_COVER_REFS = 6;

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

  // ---------- 项目封面：上传 / ComfyUI 生成 / AI 提示词 / 恢复名称封面 ----------
  const coverMatch = pathname.match(MATCH.cover);
  const coverGenMatch = pathname.match(MATCH.coverGenerate);
  const coverPromptMatch = pathname.match(MATCH.coverPrompt);
  if (coverMatch || coverGenMatch || coverPromptMatch) {
    const id = (coverMatch || coverGenMatch || coverPromptMatch)[1];
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

    // AI 生成封面提示词：调用已配置的 LLM，按项目名 / 简介 / 小说摘要产出可编辑的文生图提示词（不落盘）
    if (coverPromptMatch && method === 'POST') {
      const body = await readBody(req);
      const providers = createProviders(project.settings,
        (level, msg) => emit('log', { projectId: id, level, message: `封面提示词 · ${msg}` }));
      try {
        const out = await providers.generate('coverPrompt', buildCoverVars(project, m, body.custom));
        const prompt = String(out?.prompt || '').trim();
        if (!prompt) throw new Error('模型未返回有效提示词');
        // 来源判定以「prompt 是否真由模型产出」为准：LLM 缺字段被 Mock 补位也算回退，不冒充 AI
        const promptFromMock = Boolean(out.__fallback) || (out.__mockKeys || []).includes('prompt');
        const source = promptFromMock ? 'fallback' : providers.mode === 'openai' ? 'llm' : 'template';
        return json(res, {
          ok: true, prompt, negative: String(out.negative || '').trim(), style: String(out.style || ''),
          source, fellBack: promptFromMock && providers.mode === 'openai',
          message: source === 'llm' ? 'AI 已根据项目资料生成封面提示词，可编辑后再生成'
            : providers.mode === 'openai' ? 'LLM 未返回有效提示词，已回退内置模板生成，可编辑后再生成'
            : '未配置大模型（设置 → 模型），已用内置模板生成；配置后可由 AI 按项目资料生成',
        }), true;
      } catch (err) {
        return json(res, { error: `封面提示词生成失败：${err.message}` }, 502), true;
      }
    }

    // ComfyUI 出图生成封面（约 1–2 分钟，需已配置 imageWorkflow）；支持多参考图（资源库图片 / 本地上传）
    if (coverGenMatch && method === 'POST') {
      const config = loadComfyConfig();
      if (!config.enabled || !config.imageWorkflow) {
        return json(res, { error: '尚未配置 ComfyUI 出图工作流，请先在设置中导入「导出(API)」工作流' }, 400), true;
      }
      const body = await readBody(req);
      const wf = parseWorkflow(config.imageWorkflow, '出图工作流');
      // 文本框内容即完整提示词（AI 生成或用户精调）原样使用；为空才按项目资料自动套片名模板
      const rawPrompt = String(body.prompt || '').trim().slice(0, 2000);
      const prompt = rawPrompt || buildCoverPrompt(project, m, '');
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
      try {
        const result = await runWorkflow(config, wf, {
          prompt, negative,
          filenamePrefix: `cover_${id}`, cfg: config,
          imageRefs,
        }, {
          bindings: config.bindings?.image || [],
          log: (level, msg) => emit('log', { projectId: id, level, message: `封面生成 · ${msg}` }),
        });
        const url = result.primary?.url;
        if (!url) return json(res, { error: 'ComfyUI 未返回封面图片' }, 502), true;
        const out = commitCover({ url, source: 'comfyui', prompt });
        if (!out.ok) return json(res, out, 400), true;
        // 收录进资源库：类型=封面，带项目来源，其他项目可直接从资源库复用
        const cf = String(url).startsWith('/assets/') ? String(url).slice(8) : '';
        if (cf) registerAsset({ file: cf, kind: 'cover', name: `${project.name} 封面`, sourceProjectId: id, sourceProjectName: project.name });
        return json(res, { ok: true, cover: m.cover, url, prompt,
          promptId: result.promptId, durationMs: result.durationMs, message: out.message }), true;
      } catch (err) {
        return json(res, { error: `封面生成失败：${err.message}` }, 502), true;
      }
    }

    // 本地上传（dataURL base64），存入 /assets/ 供静态服务直接访问
    if (coverMatch && method === 'POST') {
      const body = await readBody(req);
      // 从资源库复用已有图片：只接受指向 /assets/ 的合法图片文件，完整走 commitCover 链路
      if (body.asset) {
        const name = String(body.asset);
        if (!/^[a-zA-Z0-9_.-]+$/.test(name) || !/\.(png|jpe?g|webp|gif)$/i.test(name)) {
          return json(res, { error: '仅支持从资源库选择 PNG / JPEG / WebP / GIF 图片' }, 400), true;
        }
        if (!readAsset(name)) return json(res, { error: '资源不存在或已被删除' }, 404), true;
        const out = commitCover({ url: `/assets/${name}`, source: 'upload' });
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
        const providers = createProviders(project.settings, (level, msg) => emit('log', { projectId: id, level, message: `角色提取 · ${msg}` }));
        const out = await providers.generate('charExtract', buildExtractVars(project, m, limit));
        if (out?.__fallback || !Array.isArray(out?.characters) || !out.characters.length) throw new Error('模型未返回有效角色');
        extracted = out.characters;
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
    const view = CHARACTER_VIEWS.find((v) => v.key === String(body.view || ''));
    if (!view) return json(res, { error: '视图必须是 front / side / back' }, 400), true;
    const prompt = buildViewPrompt(character, view.key, {
      style: m.bible?.stylePrompt || project.settings?.style || '',
      negative: m.bible?.negativePrompt || '',
    });
    const providers = createProviders(project.settings, (level, msg) => emit('log', { projectId: id, level, message: `角色多视图 · ${msg}` }));
    try {
      const img = await providers.image({
        kind: 'character-view', view: view.key,
        label: `${character.name}·${view.label}`,
        prompt, palette: character.palette,
        style: project.settings?.style || 'cinematic',
        seed: `${id}-${character.id}-${view.key}`,
      });
      const file = String(img.url || '').split('/').pop();
      // 登记资源库（类型=角色），其他项目与关键帧 ref 可按角色名复用
      registerAsset({
        file, kind: 'character', name: `${character.name}·${view.label}`,
        tags: ['角色', character.name, view.label, ...character.aliases].filter(Boolean),
        sourceProjectId: id, sourceProjectName: project.name,
      });
      character.views = { front: null, side: null, back: null, ...character.views, [view.key]: { file, url: img.url, prompt, provider: img.provider, at: Date.now() } };
      character.updatedAt = Date.now();
      m.updatedAt = Date.now();
      saveProject(project);
      broadcastMeta(project);
      emit('state', { projectId: id, project, reason: 'characters' });
      return json(res, { ok: true, view: view.key, url: img.url, provider: img.provider, character }), true;
    } catch (err) {
      return json(res, { error: `角色多视图生成失败：${err.message}` }, 502), true;
    }
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
    const providers = createProviders(project.settings,
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
    const providers = createProviders(project.settings,
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
