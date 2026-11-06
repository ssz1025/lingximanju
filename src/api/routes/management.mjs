// 创作项目管理域：属性 / 复制 / 快照恢复 / 六步执行 / 项目封面
import { json, readBody } from '../http.mjs';
import { MATCH } from './match.mjs';
import { loadProject, saveProject, uid, listSnapshots, writeSnapshot, readSnapshot, writeAssetBinary, readAsset } from '../../core/store.mjs';
import { registerAsset } from '../../core/assets.mjs';
import { emit } from '../../core/events.mjs';
import { ensureManagement, applyManageAction, projectStats, stepProgress, STEPS } from '../../core/project-steps.mjs';
import { loadComfyConfig } from '../../core/comfy-config.mjs';
import { parseWorkflow, runWorkflow } from '../../core/comfyui.mjs';
import { executeSteps, broadcastMeta } from '../../core/step-runner.mjs';

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

  // ---------- 项目封面：上传 / ComfyUI 生成 / 恢复名称封面 ----------
  const coverMatch = pathname.match(MATCH.cover);
  const coverGenMatch = pathname.match(MATCH.coverGenerate);
  if (coverMatch || coverGenMatch) {
    const id = (coverMatch || coverGenMatch)[1];
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

    // ComfyUI 出图生成封面（约 1–2 分钟，需已配置 imageWorkflow）
    if (coverGenMatch && method === 'POST') {
      const config = loadComfyConfig();
      if (!config.enabled || !config.imageWorkflow) {
        return json(res, { error: '尚未配置 ComfyUI 出图工作流，请先在设置中导入「导出(API)」工作流' }, 400), true;
      }
      const body = await readBody(req);
      const wf = parseWorkflow(config.imageWorkflow, '出图工作流');
      const prompt = buildCoverPrompt(project, m, body.prompt);
      try {
        const result = await runWorkflow(config, wf, {
          prompt, negative: config.negativePrompt,
          filenamePrefix: `cover_${id}`, cfg: config,
        }, { log: (level, msg) => emit('log', { projectId: id, level, message: `封面生成 · ${msg}` }) });
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

  return false;
}
