// 项目域：新建 / 导入 / 运行控制 / 模板重建 / 自动排布 / 画布对话 / 项目 CRUD
import { json, readBody } from '../http.mjs';
import { MATCH } from './match.mjs';
import { loadProject, saveProject, deleteProject, uid } from '../../core/store.mjs';
import { emit } from '../../core/events.mjs';
import { buildNovelProject, attachSource } from '../../pipelines/novel-project.mjs';
import { broadcastMeta } from '../../core/step-runner.mjs';
import { stepProgress } from '../../core/project-steps.mjs';
import { buildTemplate } from '../../pipelines/templates.mjs';
import { validate, autoLayout } from '../../core/graph.mjs';
import { runProject, stopProject, isRunning } from '../../core/orchestrator.mjs';
import { chatWithCanvas } from '../../agents/canvas-agent.mjs';

export async function handleProjects(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  if (pathname === '/api/projects' && method === 'POST') {
    const body = await readBody(req);
    // 新逻辑：创作项目只要求「项目名称」必填，小说 / 分集 / 风格全部进项目后逐步补充或 AI 生成
    if ((body.kind === 'novel' || body.novel) && !String(body.name || '').trim()) {
      return json(res, { error: '项目名称不能为空：先给项目起个名字，其他信息可以之后逐步补充' }, 400), true;
    }
    let project;
    try {
      // kind='novel' → 新建「创作项目」：带 text 时创建即完成 ①②；
      // 不带 text 时返回六步全待执行的极简骨架，小说延后到第 ① 步上传（POST /:id/source）
      project = (body.kind === 'novel' || body.novel)
        ? buildNovelProject({
          text: body.text || body.novel, filename: body.filename, name: body.name,
          files: Array.isArray(body.files) ? body.files : undefined,
          idea: body.idea,
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

  // 极简创建后延迟上传小说：解析 + 分集 + 注入画布 + 完成 ①② 步
  const sourceMatch = pathname.match(MATCH.source);
  if (sourceMatch && method === 'POST') {
    const id = sourceMatch[1];
    const project = loadProject(id);
    if (!project) return json(res, { error: '项目不存在' }, 404), true;
    if (isRunning(id)) return json(res, { error: '项目正在运行，稍后再上传' }, 409), true;
    const body = await readBody(req);
    try {
      const r = attachSource(project, {
        text: body?.text, filename: body?.filename, split: body?.split,
        files: Array.isArray(body?.files) ? body.files : undefined,
      });
      saveProject(project);
      broadcastMeta(project);
      emit('state', { projectId: id, project, reason: 'source' });
      emit('log', { projectId: id, level: 'info', message: `⇧ ${r.message}` });
      return json(res, {
        ok: true, message: r.message,
        novel: { title: r.novel.title, chapterCount: r.novel.chapterCount, totalChars: r.novel.totalChars },
        episodeCount: r.episodes.length,
        chapters: r.chapters || [], sources: r.sources || [],
        episodes: (project.management?.episodes || []).map((e) => ({
          no: e.no, title: e.title, chars: e.chars, summary: e.summary,
          chapters: e.chapters || [], segmentCount: (e.segments || []).length,
        })),
        management: project.management,
        progress: stepProgress(project.management),
      }), true;
    } catch (err) {
      return json(res, { error: err.message }, 400), true;
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
      runProject(id, { project, nodeId: body.nodeId, modelId: body.modelId }).catch((err) =>
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
      const result = await chatWithCanvas(project, body.message || '', body.modelId);
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

  return false;
}
