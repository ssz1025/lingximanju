// 工作台分步对话域：每一步都能和 Agent 对话改这一步的事
//
// - GET  /api/projects/:id/steps/chats              全部步骤的会话概览（条数 / 最近一句 / token）
// - GET  /api/projects/:id/steps/tokens             每步 token 明细（执行 / 对话 / 合计 / 运行明细）
// - GET  /api/projects/:id/steps/:stepId/chat       本步会话历史 + 现状 + 可用动作 + token
// - POST /api/projects/:id/steps/:stepId/chat       发一条指令（同步执行，返回 Agent 回复与调用记录）
// - GET  /api/projects/:id/steps/:stepId/chat/export?format=md|json  导出本步对话
// - POST /api/projects/:id/steps/:stepId/chat/clear 归档式清空（把消息移进 archive，不真删）
import { json, readBody } from '../http.mjs';
import { MATCH } from './match.mjs';
import { loadProject, saveProject } from '../../core/store.mjs';
import { ensureManagement, stepTokenReport } from '../../core/project-steps.mjs';
import { emit } from '../../core/events.mjs';
import {
  STEP_CHAT_SCOPE, STEP_CHAT_ACTIONS, stepChatOf, stepChatContext, stepChatHistory,
  stepChatIndex, runStepChat, exportStepChat, stepChatLabel,
} from '../../core/step-chat.mjs';

function fail(res, message, status = 400) {
  return json(res, { ok: false, error: message }, status), true;
}

export async function handleStepChat(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  const exportMatch = pathname.match(MATCH.stepChatExport);
  const clearMatch = pathname.match(MATCH.stepChatClear);
  const chatMatch = pathname.match(MATCH.stepChat);
  const indexMatch = pathname.match(MATCH.stepChatIndex);
  const tokensMatch = pathname.match(MATCH.stepTokens);
  if (!exportMatch && !clearMatch && !chatMatch && !indexMatch && !tokensMatch) return false;

  const hit = exportMatch || clearMatch || chatMatch || indexMatch || tokensMatch;
  const id = decodeURIComponent(hit[1]);
  const project = loadProject(id);
  if (!project) return fail(res, '项目不存在', 404);
  const m = ensureManagement(project);

  /* ---------- 全部步骤的会话概览 ---------- */
  if (indexMatch && method === 'GET') {
    return json(res, {
      ok: true,
      scope: STEP_CHAT_SCOPE,
      actions: STEP_CHAT_ACTIONS,
      chats: stepChatIndex(project),
      tokens: stepTokenReport(m),
    }), true;
  }

  /* ---------- 每步 token 明细 ---------- */
  if (tokensMatch && method === 'GET') {
    return json(res, { ok: true, ...stepTokenReport(m) }), true;
  }

  const stepId = String((exportMatch || clearMatch || chatMatch)[2] || '');
  if (!STEP_CHAT_SCOPE.includes(stepId)) {
    return fail(res, `未知步骤「${stepId}」，可选：${STEP_CHAT_SCOPE.join(' / ')}`, 404);
  }
  if (stepId !== 'project' && m.kind !== 'novel') {
    return fail(res, '只有创作项目（六步工作台）才有分步对话');
  }
  const log = (level, message) => emit('log', { projectId: id, level, message: `分步对话 · ${stepChatLabel(stepId)} · ${message}` });

  /* ---------- 导出本步对话 ---------- */
  if (exportMatch) {
    if (method !== 'GET') return fail(res, '需要 GET', 405);
    const format = url.searchParams.get('format') === 'json' ? 'json' : 'md';
    const out = exportStepChat(project, stepId, format);
    res.writeHead(200, {
      'Content-Type': out.contentType,
      'Content-Disposition': `attachment; filename="${out.filename}"`,
    });
    res.end(out.body);
    return true;
  }

  /* ---------- 归档式清空：消息搬进 archive，可追溯，不真删 ---------- */
  if (clearMatch) {
    if (method !== 'POST') return fail(res, '需要 POST', 405);
    const chat = stepChatOf(project, stepId);
    chat.archive = chat.archive || [];
    chat.archive.push({ at: Date.now(), messages: chat.messages });
    const moved = chat.messages.length;
    chat.messages = [];
    chat.updatedAt = Date.now();
    saveProject(project);
    emit('step:chat', { projectId: id, stepId, cleared: moved });
    return json(res, { ok: true, cleared: moved, message: `已归档 ${moved} 条消息（仍可通过导出追溯）` }), true;
  }

  /* ---------- 会话历史 + 现状 ---------- */
  if (method === 'GET') {
    const ctx = stepChatContext(project, stepId);
    return json(res, {
      ok: true,
      stepId,
      label: stepChatLabel(stepId),
      steps: STEP_CHAT_SCOPE,
      actions: STEP_CHAT_ACTIONS[stepId] || STEP_CHAT_ACTIONS.project,
      messages: stepChatHistory(project, stepId),
      chat: stepChatOf(project, stepId),
      context: ctx,
      tokens: stepTokenReport(m),
    }), true;
  }

  /* ---------- 发一条指令 ---------- */
  if (method === 'POST') {
    const body = await readBody(req);
    const message = String(body.message || '').trim();
    if (!message) return fail(res, '消息不能为空');
    const out = await runStepChat({
      project, stepId, message, modelId: body.modelId || '', log,
    });
    return json(res, out, out.ok === false ? 400 : 200), true;
  }

  return fail(res, '不支持的方法', 405);
}
