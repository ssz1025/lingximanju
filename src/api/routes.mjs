// REST + SSE 路由层
import fs from 'node:fs';
import path from 'node:path';
import { listProjects, loadProject, saveProject, deleteProject, uid, readAsset,
  writeSnapshot, listSnapshots, readSnapshot, EXAMPLES_DIR } from '../core/store.mjs';
import { emit, subscribe } from '../core/events.mjs';
import { autoLayout, validate } from '../core/graph.mjs';
import { runProject, stopProject, isRunning } from '../core/orchestrator.mjs';
import { buildTemplate, TEMPLATE_META } from '../pipelines/templates.mjs';
import { buildNovelProject, refreshEpisodes } from '../pipelines/novel-project.mjs';
import { validateNovelInput, novelPreview } from '../core/novel.mjs';
import { STEPS, STEP_BY_ID, ensureManagement, stepProgress, startStep, finishStep,
  resetStep, resetAllSteps, applyManageAction, projectStats, projectIndex } from '../core/project-steps.mjs';
import { listAgents } from '../agents/index.mjs';
import { chatWithCanvas } from '../agents/canvas-agent.mjs';
import { loadComfyConfig, saveComfyConfig, comfySummary } from '../core/comfy-config.mjs';
import { parseWorkflow, analyzeWorkflow, testConnection, runWorkflow } from '../core/comfyui.mjs';
import { exportDirectorPack } from '../core/director-pack.mjs';
import '../agents/index.mjs';

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function binary(res, buf, filename, type = 'application/octet-stream') {
  if (!buf) return json(res, { error: '文件不存在或已被清理' }, 404), true;
  const safe = String(filename).replace(/[^A-Za-z0-9_.-]/g, '_');
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="${safe}"`,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); }
      else parts.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(parts).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

const MATCH = {
  project: /^\/api\/projects\/([^/]+)$/,
  projectAction: /^\/api\/projects\/([^/]+)\/(template|run|stop|chat|arrange|export)$/,
  manageAction: /^\/api\/projects\/([^/]+)\/(manage|duplicate|snapshots|restore|step)$/,
  deliverable: /^\/api\/projects\/([^/]+)\/(director-pack|film)$/,
};

/** 项目管理状态广播：步骤面板、侧栏进度、顶栏状态胶囊都靠这个事件对齐 */
function broadcastMeta(project) {
  emit('project:meta', {
    projectId: project.id,
    management: ensureManagement(project),
    stats: projectStats(project),
    progress: stepProgress(project.management),
  });
}

/**
 * 六步任务执行器：把「步骤」翻译成 orchestrator 的节点类型白名单（scope），
 * 逐阶段调度真实的智能体流水线；每步开始 / 结束都广播状态供前端做视觉提示。
 */
async function executeSteps(project, body = {}) {
  const m = ensureManagement(project);
  const id = project.id;
  if (body.action === 'reset') {
    if (body.stepId) resetStep(m, body.stepId); else resetAllSteps(m);
    saveProject(project);
    broadcastMeta(project);
    return { ok: true, message: '任务状态已重置', management: m, progress: stepProgress(m) };
  }
  if (m.kind !== 'novel') return { ok: false, error: '这是标准流水线项目，请使用顶栏「运行完整流水线」' };
  if (isRunning(id)) return { ok: false, error: '该项目已有运行中的任务' };

  const ids = body.all
    ? STEPS.filter((s) => !s.auto).map((s) => s.id)
    : [body.stepId || stepProgress(m).currentId];
  const executed = [];

  for (const stepId of ids) {
    const def = STEP_BY_ID[stepId];
    if (!def) return { ok: false, error: `未知步骤：${stepId}` };
    const state = () => m.steps.find((s) => s.id === stepId);
    if (!body.force && state()?.status === 'done') continue;

    startStep(m, stepId);
    saveProject(project);
    broadcastMeta(project);
    emit('log', { projectId: id, level: 'info', message: `▶ 第 ${def.no} 步「${def.title}」开始 · 理论依据 ${def.theory.ref}` });
    const t0 = Date.now();
    try {
      if (def.auto) {
        if (stepId === 'episodes') {
          const r = refreshEpisodes(project);
          emit('state', { projectId: id, project, reason: 'episodes' });
          finishStep(m, stepId, { ok: true, note: r.message, durationMs: Date.now() - t0 });
        } else {
          finishStep(m, stepId, { ok: true, note: '原著与交付设置已确认', durationMs: Date.now() - t0 });
        }
      } else {
        const summary = await runProject(id, { project, scope: def.scope });
        const ok = summary.status === 'done' && summary.failed === 0;
        // 交付步：按项目交付设置保证导演包存在（composer 在「只生成视频」模式下不打包）
        if (stepId === 'deliver' && ok && m.deliverables?.pack) {
          const finalNode = project.nodes.find((n) => n.type === 'final');
          if (finalNode && !finalNode.data?.directorPack?.file) {
            const cfg = { ...loadComfyConfig(), ...(project.settings?.comfy || {}) };
            const info = exportDirectorPack(project, cfg);
            const pack = {
              url: info.url, file: info.file, filename: info.filename, bytes: info.bytes,
              shotCount: info.shotCount, fileCount: info.fileCount, target: info.format,
              groups: info.groups, note: info.note,
            };
            finalNode.data = { ...(finalNode.data || {}), directorPack: pack };
            emit('node:data', { projectId: id, nodeId: finalNode.id, patch: { directorPack: pack } });
          }
        }
        const finalData = project.nodes.find((n) => n.type === 'final')?.data || {};
        const extra = stepId === 'deliver'
          ? (finalData.film?.file ? ' · 成片 MP4 已生成' : ' · Mock 为帧序列预览，接入 ComfyUI 视频工作流后产出真实 MP4')
          : '';
        finishStep(m, stepId, {
          ok,
          note: ok
            ? `${summary.nodeCount} 节点 · ${summary.waves} 波 · ${(summary.durationMs / 1000).toFixed(1)}s${extra}`
            : `编排${summary.status === 'cancelled' ? '已取消' : '失败'}，失败节点 ${summary.failed} 个`,
          durationMs: Date.now() - t0,
        });
      }
    } catch (err) {
      finishStep(m, stepId, { ok: false, note: err.message, durationMs: Date.now() - t0 });
      emit('log', { projectId: id, level: 'error', message: `第 ${def.no} 步失败：${err.message}` });
    }
    saveProject(project);
    broadcastMeta(project);
    executed.push({ id: stepId, status: state().status, note: state().note });
    if (state().status === 'error') break;
  }
  emit('state', { projectId: id, project, reason: 'step' });
  return {
    ok: true, management: m, progress: stepProgress(m),
    stats: projectStats(project), executed,
  };
}

export async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

  if (pathname === '/api/events' && method === 'GET') { subscribe(req, res); return true; }
  if (pathname === '/api/health') return json(res, { ok: true, ts: Date.now() }), true;

  // ---------- 本地 ComfyUI 配置 / 探测 / 工作流测试 ----------
  if (pathname === '/api/comfyui/config' && method === 'GET') {
    const config = loadComfyConfig();
    return json(res, { config, summary: comfySummary(config) }), true;
  }
  if (pathname === '/api/comfyui/config' && method === 'PUT') {
    const body = await readBody(req);
    for (const key of ['imageWorkflow', 'videoWorkflow']) {
      if (body[key] === '' || body[key] === null) body[key] = null;
      else if (body[key] !== undefined) body[key] = parseWorkflow(body[key], key);
    }
    const config = saveComfyConfig(body);
    return json(res, { ok: true, config, summary: comfySummary(config) }), true;
  }
  if (pathname === '/api/comfyui/test' && method === 'POST') {
    const body = await readBody(req);
    const config = loadComfyConfig();
    try {
      const result = await testConnection(body.baseUrl || config.baseUrl);
      return json(res, { ok: true, ...result }), true;
    } catch (err) {
      return json(res, { ok: false, error: err.message }), true;
    }
  }
  if (pathname === '/api/comfyui/analyze' && method === 'POST') {
    const body = await readBody(req);
    const wf = parseWorkflow(body.workflow);
    return json(res, { nodes: Object.keys(wf).length, detected: analyzeWorkflow(wf) }), true;
  }
  if (pathname === '/api/comfyui/run-test' && method === 'POST') {
    const body = await readBody(req);
    const config = loadComfyConfig();
    const kind = body.kind === 'video' ? 'video' : 'image';
    const wf = parseWorkflow(body.workflow || config[`${kind}Workflow`], `${kind} 工作流`);
    const result = await runWorkflow(config, wf, {
      prompt: body.prompt || 'cinematic test shot, consistent character, soft light',
      filenamePrefix: 'lingximanju_test', cfg: config,
    }, { bindings: config.bindings?.[kind] || [] });
    return json(res, {
      ok: true, promptId: result.promptId, durationMs: result.durationMs,
      applied: result.applied, assets: result.assets,
    }), true;
  }

  if (pathname === '/api/bootstrap' && method === 'GET') {
    let projects = listProjects();
    if (!projects.length) {
      const demo = buildTemplate('idea2video');
      saveProject(demo);
      projects = listProjects();
    }
    const active = projects.filter((p) => !p.archived);
    return json(res, {
      projects, templates: TEMPLATE_META, agents: listAgents(),
      recent: projects[0]?.id || null, serverTime: Date.now(),
      comfy: comfySummary(loadComfyConfig()),
      steps: STEPS,
      stats: {
        total: projects.length, active: active.length,
        novels: projects.filter((p) => p.kind === 'novel').length,
        done: projects.filter((p) => p.status === 'done').length,
        running: projects.filter((p) => p.status === 'running').length,
        archived: projects.length - active.length,
        favorite: projects.filter((p) => p.favorite).length,
      },
    }), true;
  }

  /** 向导「载入示例小说」：示例文本随仓库自包含，不依赖外部网络 */
  if (pathname === '/api/novel/sample' && method === 'GET') {
    try {
      const text = fs.readFileSync(path.join(EXAMPLES_DIR, 'sample-novel.txt'), 'utf8');
      return json(res, { ok: true, filename: 'sample-novel.txt', text }), true;
    } catch {
      return json(res, { error: '示例小说不存在（examples/sample-novel.txt）' }, 404), true;
    }
  }

  /** 新建项目向导的实时分集预览（不落盘） */
  if (pathname === '/api/novel/preview' && method === 'POST') {
    const body = await readBody(req);
    const checked = validateNovelInput(body.text, { filename: body.filename, split: body.split });
    if (!checked.ok) return json(res, { ok: false, message: checked.message }), true;
    return json(res, { ok: true, message: checked.message, preview: novelPreview(checked.novel, checked.episodes) }), true;
  }

  if (pathname === '/api/projects' && method === 'POST') {
    const body = await readBody(req);
    let project;
    try {
      // kind='novel' → 新建「创作项目」：上传小说 → 分集 → 视频 / 导演包
      project = (body.kind === 'novel' || body.novel)
        ? buildNovelProject({
          text: body.text || body.novel, filename: body.filename, name: body.name,
          split: body.split, deliverables: body.deliverables,
          style: body.style, aspect: body.aspect,
        }).project
        : buildTemplate(body.template || 'idea2video', {
          name: body.name, idea: body.idea, style: body.style,
        });
    } catch (err) {
      return json(res, { error: err.message }, 400), true;
    }
    saveProject(project);
    emit('state', { projectId: project.id, project, reason: 'created' });
    return json(res, project, 201), true;
  }

  if (pathname === '/api/import' && method === 'POST') {
    const body = await readBody(req);
    if (!body || !Array.isArray(body.nodes)) return json(res, { error: '不是有效的项目 JSON' }, 400), true;
    const project = { ...body, id: uid('prj'), name: `${body.name || '导入项目'} · 副本`, createdAt: Date.now(), updatedAt: Date.now() };
    saveProject(project);
    return json(res, project, 201), true;
  }

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

  // ---------- 两种最终产物：导演包 / 成片 ----------
  const deliverableMatch = pathname.match(MATCH.deliverable);
  if (deliverableMatch) {
    const [, id, kind] = deliverableMatch;
    const project = loadProject(id);
    if (!project) return json(res, { error: '项目不存在' }, 404), true;
    const cfg = { ...loadComfyConfig(), ...(project.settings?.comfy || {}) };
    if (kind === 'director-pack') {
      if (method === 'POST') {
        const info = exportDirectorPack(project, cfg);
        const finalNode = project.nodes.find((n) => n.type === 'final');
        if (finalNode) {
          const pack = {
            url: info.url, file: info.file, filename: info.filename, bytes: info.bytes,
            shotCount: info.shotCount, fileCount: info.fileCount, target: info.format,
            groups: info.groups, note: info.note,
          };
          finalNode.data = { ...(finalNode.data || {}), directorPack: pack };
          saveProject(project);
          emit('node:data', { projectId: id, nodeId: finalNode.id, patch: { directorPack: pack } });
        }
        return json(res, info), true;
      }
      if (method === 'GET') {
        const existing = project.nodes.find((n) => n.type === 'final')?.data?.directorPack;
        const info = existing?.file && readAsset(existing.file) ? existing : exportDirectorPack(project, cfg);
        return binary(res, readAsset(info.file), info.filename, 'application/zip'), true;
      }
    }
    if (kind === 'film' && method === 'GET') {
      const film = project.nodes.find((n) => n.type === 'final')?.data?.film;
      if (!film?.file) return json(res, { error: '尚未生成成片，请先运行流水线并接入 ComfyUI 视频工作流' }, 404), true;
      return binary(res, readAsset(film.file), `lingximanju-${project.id}.mp4`, 'video/mp4'), true;
    }
  }

  const actionMatch = pathname.match(MATCH.projectAction);
  if (actionMatch) {
    const [, id, action] = actionMatch;
    const project = loadProject(id);
    if (!project) return json(res, { error: '项目不存在' }, 404), true;

    if (action === 'export') return json(res, project), true;

    if (action === 'template' && method === 'POST') {
      const body = await readBody(req);
      const fresh = buildTemplate(body.template || project.mode, {
        name: project.name, idea: body.idea, style: project.settings?.style,
      });
      fresh.id = project.id;
      fresh.settings = { ...fresh.settings, ...(project.settings || {}) };
      saveProject(fresh);
      emit('state', { projectId: id, project: fresh, reason: 'template' });
      return json(res, fresh), true;
    }

    if (action === 'run' && method === 'POST') {
      if (isRunning(id)) return json(res, { error: '该项目已有运行中的任务' }, 409), true;
      const body = await readBody(req);
      if (body.nodeId) {
        const target = project.nodes.find((n) => n.id === body.nodeId);
        if (!target) return json(res, { error: '节点不存在' }, 404), true;
      }
      runProject(id, { project, nodeId: body.nodeId }).catch((err) =>
        emit('log', { projectId: id, level: 'error', message: `启动失败：${err.message}` }));
      return json(res, { started: true, projectId: id, nodeId: body.nodeId || null }), true;
    }

    if (action === 'stop' && method === 'POST') {
      return json(res, { stopped: stopProject(id) }), true;
    }

    if (action === 'arrange' && method === 'POST') {
      const pos = autoLayout(project.nodes, project.edges);
      for (const n of project.nodes) if (pos[n.id]) { n.x = pos[n.id].x; n.y = pos[n.id].y; }
      saveProject(project);
      emit('state', { projectId: id, project, reason: 'arrange' });
      return json(res, { moved: project.nodes.length }), true;
    }

    if (action === 'chat' && method === 'POST') {
      const body = await readBody(req);
      const result = await chatWithCanvas(project, body.message || '');
      for (const seg of result.segments) {
        emit('chat', { projectId: id, role: 'assistant', content: seg });
        await new Promise((r) => setTimeout(r, 90));
      }
      if (result.changed) {
        saveProject(project);
        emit('state', { projectId: id, project, reason: result.action });
      }
      return json(res, { ok: true, segments: result.segments, action: result.action }), true;
    }
  }

  const projMatch = pathname.match(MATCH.project);
  if (projMatch) {
    const id = projMatch[1];
    if (method === 'GET') {
      const project = loadProject(id);
      return project ? (json(res, project), true) : (json(res, { error: '项目不存在' }, 404), true);
    }
    if (method === 'PUT') {
      const body = await readBody(req);
      if (!body || !Array.isArray(body.nodes) || !Array.isArray(body.edges)) {
        return json(res, { error: '项目数据不完整' }, 400), true;
      }
      body.id = id;
      const check = validate(body.nodes, body.edges);
      if (!check.ok) emit('log', { projectId: id, level: 'warn', message: `画布存在 ${check.dangling} 条悬空边或 ${check.cycles.length} 个环，已自动忽略` });
      saveProject(body);
      return json(res, { ok: true, updatedAt: body.updatedAt }), true;
    }
    if (method === 'DELETE') {
      deleteProject(id);
      return json(res, { ok: true }), true;
    }
  }

  return json(res, { error: `未知接口 ${method} ${pathname}` }, 404), true;
}
