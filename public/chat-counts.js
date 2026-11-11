/* ============================================================================
 * 统一 AI 对话的消息计数（前端侧）
 *
 * 与服务端 src/core/ai-thread.mjs 的 threadCounts() 同口径：
 *   分步会话（management.stepChats[stepId]）+ 制片会话（management.conversation）
 *   + 新增档位（management.aiScopes[scope]）按档位合计。
 *
 * 为什么要前端也算一遍：步骤面板与工作台的「💬 对话 · N」徽标是**同步**渲染的，
 * 拿不到统一线程接口；这里按同一套规则就地算，保证徽标与统一面板里的计数一致。
 *
 * 无 DOM、无 fetch，可在 node --test 中直接导入。
 * ==========================================================================*/

/** 六步档位 id（与后端 STEPS 顺序一致） */
export const CHAT_STEP_SCOPES = ['upload', 'episodes', 'script', 'context', 'storyboard', 'deliver'];

/** 新增档位（此前没有服务端历史，現在统一线程里有） */
export const CHAT_NEW_SCOPES = ['cover', 'style', 'canvas'];

const n = (v) => (Array.isArray(v) ? v.length : 0);

/**
 * 各档位的对话条数。
 * @param {object} m project.management
 * @returns {object} { upload, episodes, ..., project, cover, style, canvas, all }
 */
export function chatCounts(m = {}) {
  const counts = {};
  const chats = m.stepChats || {};
  for (const id of CHAT_STEP_SCOPES) counts[id] = n(chats[id]?.messages);
  // 总览档 = 旧制片助理桶 + 制片助手会话（两者同归一档，按时间交织）
  counts.project = n(chats.project?.messages) + n(m.conversation?.messages);
  const scopes = m.aiScopes || {};
  for (const id of CHAT_NEW_SCOPES) counts[id] = n(scopes[id]?.messages);
  counts.all = Object.values(counts).reduce((a, b) => a + b, 0);
  return counts;
}

/** 单个档位的对话条数（徽标用） */
export function chatCount(m = {}, scopeId = 'project') {
  return chatCounts(m)[scopeId] || 0;
}
