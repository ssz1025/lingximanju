// REST + SSE 路由层
import { listProjects, loadProject, saveProject, deleteProject, uid, readAsset } from '../core/store.mjs';
import { emit, subscribe } from '../core/events.mjs';
import { autoLayout, validate } from '../core/graph.mjs';
import { runProject, stopProject, isRunning } from '../core/orchestrator.mjs';
import { buildTemplate, TEMPLATE_META } from '../pipelines/templates.mjs';
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
  deliverable: /^\/api\/projects\/([^/]+)\/(director-pack|film)$/,
};

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
    return json(res, {
      projects, templates: TEMPLATE_META, agents: listAgents(),
      recent: projects[0]?.id || null, serverTime: Date.now(),
      comfy: comfySummary(loadComfyConfig()),
    }), true;
  }

  if (pathname === '/api/projects' && method === 'POST') {
    const body = await readBody(req);
    const project = buildTemplate(body.template || 'idea2video', {
      name: body.name, idea: body.idea, style: body.style,
    });
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
      return project ? json(res, project) : (json(res, { error: '项目不存在' }, 404), true);
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
