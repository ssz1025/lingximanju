// AI 制片对话域：对话框里用一句话完成「小说 → 真实短剧」的每一步
//
// - GET  /api/projects/:id/production/chat           历史 + 快捷指令 + 状态快照
// - POST /api/projects/:id/production/chat           发消息（长意图转后台任务，SSE production:chat 推进度）
// - GET  /api/projects/:id/production/chat/export    导出 Markdown / JSON（含等价 curl，供他人复刻）
import { json, readBody } from '../http.mjs';
import { MATCH } from './match.mjs';
import { loadProject } from '../../core/store.mjs';
import { ensureManagement } from '../../core/project-steps.mjs';
import { resolveRuntimeSpec } from '../../core/runtime-spec.mjs';
import { verifyDirectorDeliverables, ensureDirectorState } from '../../core/director-skills.mjs';
import { CHAT_STEPS, QUICK_SAYS, runProductionChat, chatHistory,
  hasRunningTask, chatTaskSnapshot, exportChat } from '../../core/production-chat.mjs';

function snapshot(project) {
  const m = ensureManagement(project);
  const d = ensureDirectorState(m);
  return {
    ok: true,
    steps: CHAT_STEPS,
    quickSays: QUICK_SAYS,
    running: hasRunningTask(project.id),
    tasks: chatTaskSnapshot(project.id),
    history: chatHistory(project),
    state: {
      skillId: d.skillId,
      runtime: resolveRuntimeSpec(project),
      verification: verifyDirectorDeliverables(project, d.skillId),
    },
  };
}

export async function handleProductionChat(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';
  const chatMatch = pathname.match(MATCH.productionChat);
  const exportMatch = pathname.match(MATCH.productionChatExport);
  if (!chatMatch && !exportMatch) return false;

  const id = decodeURIComponent((chatMatch || exportMatch)[1]);
  const project = loadProject(id);
  if (!project) return json(res, { error: '项目不存在' }, 404), true;
  const m = ensureManagement(project);
  if (m.kind !== 'novel') return json(res, { error: '制片对话只作用于小说创作项目' }, 400), true;

  // ---------- 导出复刻记录（先判，避免被 /export 吞进 chat 匹配） ----------
  if (exportMatch && method === 'GET') {
    const format = url.searchParams.get('format') === 'json' ? 'json' : 'md';
    const out = exportChat(project, format);
    res.writeHead(200, {
      'Content-Type': out.contentType,
      'Content-Disposition': `attachment; filename="${out.filename}"`,
    });
    res.end(out.body);
    return true;
  }

  // ---------- 历史 + 快捷指令 + 状态 ----------
  if (method === 'GET') {
    return json(res, snapshot(project)), true;
  }

  // ---------- 发送一条指令 ----------
  if (method === 'POST') {
    const body = await readBody(req);
    const message = String(body.message || '').trim();
    if (!message) return json(res, { error: '消息不能为空' }, 400), true;
    const result = await runProductionChat({ project, message, modelId: body.modelId || '' });
    return json(res, result, result.ok === false ? 400 : 200), true;
  }

  return json(res, { error: '不支持的方法' }, 405), true;
}
