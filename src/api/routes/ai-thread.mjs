// 统一 AI 对话域：项目级一条总线程 + 按档位派发
//
// - GET  /api/projects/:id/ai/scopes                        档位目录（提示 / 快捷指令 / 功能按钮）
// - GET  /api/projects/:id/ai/thread?scope=&before=&limit=  合并时间线（向上翻历史用游标分页）
// - POST /api/projects/:id/ai/chat   {scope,message,modelId} 按档位派发到既有业务函数
// - POST /api/projects/:id/ai/append {scope,message,...}      客户端动作回写（封面出图 / 风格保存…）
// - GET  /api/projects/:id/ai/export?format=md|json          整个项目的对话导出（含等价 curl）
//
// 关键约定：**不新建会话容器**。分步会话仍在 management.stepChats[stepId]、
// 制片会话仍在 management.conversation，本域只在读取时把它们与新增档位合并成一条时间线；
// 新增档位（封面 / 导演风格 / 画布）才落到 management.aiScopes[scope]。
import { json, readBody } from '../http.mjs';
import { MATCH } from './match.mjs';
import { loadProject } from '../../core/store.mjs';
import { ensureManagement } from '../../core/project-steps.mjs';
import { emit } from '../../core/events.mjs';
import {
  AI_SCOPE_IDS, scopeCatalog, readThread, threadCounts, dispatchAiChat,
  appendClientMessage, threadExport,
} from '../../core/ai-thread.mjs';

function fail(res, message, status = 400) {
  return json(res, { ok: false, error: message }, status), true;
}

export async function handleAiThread(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  const exportMatch = pathname.match(MATCH.aiExport);
  const appendMatch = pathname.match(MATCH.aiAppend);
  const chatMatch = pathname.match(MATCH.aiChat);
  const threadMatch = pathname.match(MATCH.aiThread);
  const scopesMatch = pathname.match(MATCH.aiScopes);
  if (!exportMatch && !appendMatch && !chatMatch && !threadMatch && !scopesMatch) return false;

  const hit = exportMatch || appendMatch || chatMatch || threadMatch || scopesMatch;
  const id = decodeURIComponent(hit[1]);
  const project = loadProject(id);
  if (!project) return fail(res, '项目不存在', 404);
  ensureManagement(project);

  /* ---------- 档位目录：每档的提示 / 快捷指令 / 功能按钮 ---------- */
  if (scopesMatch) {
    if (method !== 'GET') return fail(res, '需要 GET', 405);
    return json(res, {
      ok: true,
      scopes: scopeCatalog(project),
      counts: threadCounts(project),
    }), true;
  }

  /* ---------- 导出整个项目的对话 ---------- */
  if (exportMatch) {
    if (method !== 'GET') return fail(res, '需要 GET', 405);
    const format = url.searchParams.get('format') === 'json' ? 'json' : 'md';
    const out = threadExport(project, format);
    res.writeHead(200, {
      'Content-Type': out.contentType,
      'Content-Disposition': `attachment; filename="${out.filename}"`,
    });
    res.end(out.body);
    return true;
  }

  /* ---------- 读合并时间线（向上翻历史） ---------- */
  if (threadMatch) {
    if (method !== 'GET') return fail(res, '需要 GET', 405);
    const scope = url.searchParams.get('scope') || 'all';
    const before = url.searchParams.get('before') || '';
    const limit = Number(url.searchParams.get('limit')) || 120;
    const out = readThread(project, { scope, before, limit });
    return json(res, {
      ok: true,
      scope,
      messages: out.messages,
      nextCursor: out.nextCursor,
      hasMore: out.hasMore,
      counts: threadCounts(project),
    }), true;
  }

  /* ---------- 客户端动作回写：把本地产生的事件记进同一条线程 ---------- */
  if (appendMatch) {
    if (method !== 'POST') return fail(res, '需要 POST', 405);
    const body = await readBody(req);
    const scope = String(body.scope || '');
    if (!AI_SCOPE_IDS.includes(scope)) return fail(res, `未知对话档位「${scope}」`);
    const out = appendClientMessage(project, scope, {
      role: body.role === 'user' ? 'user' : 'assistant',
      text: String(body.text || ''),
      images: Array.isArray(body.images) ? body.images : [],
      promptBlock: body.promptBlock || null,
      links: Array.isArray(body.links) ? body.links : [],
      actions: Array.isArray(body.actions) ? body.actions : [],
      artifacts: Array.isArray(body.artifacts) ? body.artifacts : [],
      suggestions: Array.isArray(body.suggestions) ? body.suggestions : [],
      extra: body.extra || {},
    });
    return json(res, out, out.ok === false ? 400 : 200), true;
  }

  /* ---------- 按档位派发一句话 ---------- */
  if (chatMatch) {
    if (method !== 'POST') return fail(res, '需要 POST', 405);
    const body = await readBody(req);
    const scope = String(body.scope || '');
    if (!AI_SCOPE_IDS.includes(scope)) return fail(res, `未知对话档位「${scope}」`);
    const message = String(body.message || '').trim();
    if (!message) return fail(res, '消息不能为空');
    const log = (level, text) => {
      // 派发过程写进事件流：统一面板据此显示「正在处理」
      emit('log', { projectId: id, level, message: `AI 对话 · ${scope} · ${text}` });
    };
    const out = await dispatchAiChat({
      project, scope, message,
      modelId: String(body.modelId || ''),
      refs: Array.isArray(body.refs) ? body.refs : [],
      log,
    });
    return json(res, out, out.ok === false ? 400 : 200), true;
  }

  return fail(res, '不支持的方法', 405);
}
