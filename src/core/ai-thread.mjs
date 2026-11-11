/* ============================================================================
 * 统一 AI 对话线程（Unified AI Thread）· 项目级一条总线程
 *
 * 目标：把项目里所有 AI 对话入口（制片助手 / 六步分步 / 封面 / 导演风格 / 画布）
 * 收进**同一条线程**——同一个对话框里按时间看全部历史，按档位换提示与按钮。
 *
 * 三条硬约束：
 *  ① **不破坏既有会话**：分步会话仍在 management.stepChats[stepId]、制片会话仍在
 *     management.conversation，本模块只在**读取时**把它们与新档位合并成一条时间线，
 *     写入路径各自不变（老接口、老测试、老导出全部照旧）。
 *  ② **新增档位也要有历史**：封面 / 导演风格 / 画布此前是纯浏览器态（关窗即丢），
 *     这里为它们建 management.aiScopes[scope] 桶，并同步落盘分享副本。
 *  ③ **游标稳定**：合并时间线的排序键是 (at, 桶序, seq) 复合键，游标编码同一把键，
 *     新消息只会追加到末尾，不会让旧游标指向的边界漂移。
 *
 * 本文件不碰 HTTP：REST 封装见 src/api/routes/ai-thread.mjs。
 * ==========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, saveProject } from './store.mjs';
import { emit } from './events.mjs';
import { ensureManagement, stepTokenReport, STEPS } from './project-steps.mjs';
import { STEP_CHAT_ACTIONS, stepChatLabel, stepChatContext, runStepChat } from './step-chat.mjs';
import { CHAT_STEPS, runProductionChat, curlOf } from './production-chat.mjs';
import { coverChat } from '../agents/cover-agent.mjs';
import { styleForgeChat } from './style-forge-chat.mjs';
import { chatWithCanvas } from '../agents/canvas-agent.mjs';

const CONV_DIR = path.join(DATA_DIR, 'conversations');

/** 单个档位会话的消息上限：与分步会话同量级，防异常刷屏把项目 JSON 撑爆 */
export const MAX_MESSAGES_PER_SCOPE = 1000;
const MAX_TEXT = 8000;

const zeroTokens = () => ({ prompt: 0, completion: 0, total: 0, calls: 0 });

/* -------------------------------------------------------------------------- *
 * 档位注册表：一个地方说清「有哪些对话档位，各自长什么样」
 * ------------------------------------------------------------------------- */

/** 六步的档位 id（与 STEPS 一一对应） */
export const STEP_SCOPE_IDS = STEPS.map((s) => s.id);

/** 本轮新增的对话档位（此前没有服务端历史） */
export const NEW_SCOPE_IDS = ['cover', 'style', 'canvas'];

/** 全部档位：制片助手 + 六步 + 封面 + 导演风格 + 画布 */
export const AI_SCOPE_IDS = ['project', ...STEP_SCOPE_IDS, ...NEW_SCOPE_IDS];

/**
 * 档位元数据。label / icon / group 供前端渲染切换条与消息来源标签；
 * 具体的「提示文案 / 快捷指令 / 功能按钮」由 scopeCatalog() 按项目动态生成
 * （有些要读项目现状、有些要读 ComfyUI 是否就绪）。
 */
const SCOPE_META = {
  project: { label: '项目总览 · 制片助手', short: '总览', icon: '◈', group: '总览' },
  cover: { label: '项目封面', short: '封面', icon: '🖼', group: '资产' },
  style: { label: '导演风格设计', short: '风格', icon: '✦', group: '资产' },
  canvas: { label: '画布 Agent', short: '画布', icon: '⬡', group: '画布' },
};
for (const s of STEPS) {
  SCOPE_META[s.id] = { label: `第 ${s.no} 步 · ${s.title}`, short: `第${s.no}步`, icon: s.icon, group: '六步' };
}

export function aiScopeMeta(scopeId) {
  return SCOPE_META[scopeId] || { label: scopeId, short: scopeId, icon: '•', group: '其它' };
}

/* -------------------------------------------------------------------------- *
 * 会话桶：分步会话与制片会话沿用旧容器，新增档位走 management.aiScopes
 * ------------------------------------------------------------------------- */

/** 老项目惰性补「新增档位会话」容器（升级兼容，不覆盖已有内容） */
export function ensureAiScopes(m) {
  if (!m.aiScopes || typeof m.aiScopes !== 'object' || Array.isArray(m.aiScopes)) m.aiScopes = {};
  return m.aiScopes;
}

/** 取某档位的新会话桶（惰性创建） */
export function aiScopeOf(project, scopeId) {
  const m = ensureManagement(project);
  const all = ensureAiScopes(m);
  if (!all[scopeId] || typeof all[scopeId] !== 'object') {
    all[scopeId] = {
      schema: 1, scope: scopeId, label: aiScopeMeta(scopeId).label,
      createdAt: Date.now(), updatedAt: Date.now(),
      messages: [], tokens: zeroTokens(), counter: 0, state: {},
    };
  }
  const bucket = all[scopeId];
  if (!Array.isArray(bucket.messages)) bucket.messages = [];
  if (!bucket.tokens) bucket.tokens = zeroTokens();
  if (!bucket.state || typeof bucket.state !== 'object') bucket.state = {};
  // counter = 累计写入条数：seq 用它而不是 messages.length，
  // 否则裁剪旧消息后新消息的 seq 会从 1 重新开始，导出与引用都会错位。
  if (!Number.isFinite(bucket.counter) || bucket.counter < bucket.messages.length) {
    bucket.counter = bucket.messages.length;
  }
  bucket.label = aiScopeMeta(scopeId).label;
  return bucket;
}

/** 落盘分享副本：换进程后仍能读到，也方便发给其他用户复刻 */
function persistAiScope(project, scopeId) {
  try {
    fs.mkdirSync(CONV_DIR, { recursive: true });
    const bucket = aiScopeOf(project, scopeId);
    fs.writeFileSync(path.join(CONV_DIR, `${project.id}.scope-${scopeId}.json`),
      JSON.stringify({ projectId: project.id, projectName: project.name, ...bucket }, null, 2), 'utf8');
  } catch { /* 分享副本写失败不影响主流程 */ }
}

/**
 * 追加一条消息到新增档位的会话桶。
 * @param {object} msg role / text / suggestions / images / promptBlock / artifacts / tokens / extra ...
 */
export function appendAiMessage(project, scopeId, msg = {}) {
  const bucket = aiScopeOf(project, scopeId);
  const tokens = msg.tokens ? {
    prompt: Number(msg.tokens.prompt) || 0,
    completion: Number(msg.tokens.completion) || 0,
    total: Number(msg.tokens.total) || 0,
    calls: Number(msg.tokens.calls) || 0,
  } : zeroTokens();
  const rec = {
    seq: bucket.counter + 1,
    at: Date.now(),
    role: msg.role === 'user' ? 'user' : 'assistant',
    text: String(msg.text || '').slice(0, MAX_TEXT),
    action: msg.action || null,
    params: msg.params || null,
    calls: Array.isArray(msg.calls) ? msg.calls : [],
    artifacts: Array.isArray(msg.artifacts) ? msg.artifacts : [],
    suggestions: Array.isArray(msg.suggestions) ? msg.suggestions : [],
    actions: Array.isArray(msg.actions) ? msg.actions : [],
    images: Array.isArray(msg.images) ? msg.images : [],
    promptBlock: msg.promptBlock || null,
    links: Array.isArray(msg.links) ? msg.links : [],
    extra: msg.extra && typeof msg.extra === 'object' ? msg.extra : {},
    tokens,
    durationMs: Number(msg.durationMs) || 0,
    ok: msg.ok !== false,
    changed: !!msg.changed,
  };
  bucket.messages.push(rec);
  bucket.counter = rec.seq;
  if (bucket.messages.length > MAX_MESSAGES_PER_SCOPE) {
    bucket.messages.splice(0, bucket.messages.length - MAX_MESSAGES_PER_SCOPE);
  }
  for (const k of ['prompt', 'completion', 'total', 'calls']) bucket.tokens[k] += tokens[k];
  bucket.updatedAt = Date.now();
  return rec;
}

/** 提交新增档位会话：保存项目 + 落盘分享副本 */
export function commitAiScope(project, scopeId) {
  saveProject(project);
  persistAiScope(project, scopeId);
}

/* -------------------------------------------------------------------------- *
 * 合并时间线：把各档位的会话桶按时间拼成一条
 * ------------------------------------------------------------------------- */

/**
 * 枚举本项目的全部会话桶。
 * 分步会话（6 步）+ 旧制片助理（stepChats.project）+ 新制片助手（conversation）
 * 都归入「项目总览」档；新增档位各占一桶。
 */
export function threadBuckets(project) {
  const m = ensureManagement(project);
  const chats = m.stepChats || {};
  const out = [];
  for (const id of STEP_SCOPE_IDS) {
    out.push({ rank: out.length, scope: id, bucket: chats[id] || null });
  }
  out.push({ rank: out.length, scope: 'project', bucket: chats.project || null });
  out.push({ rank: out.length, scope: 'project', bucket: m.conversation || null });
  const scopes = m.aiScopes || {};
  for (const id of NEW_SCOPE_IDS) {
    out.push({ rank: out.length, scope: id, bucket: scopes[id] || null });
  }
  return out;
}

/** 复合排序键：时间戳 → 桶序 → 桶内 seq。同一毫秒内也不会错序。 */
function sortKey(rec, rank) {
  return [Number(rec.at) || 0, rank, Number(rec.seq) || 0];
}

function cmpKey(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** 游标编码：at|桶序|seq —— 与排序键同一把尺子 */
export function encodeCursor(key) {
  return `${key[0]}|${key[1]}|${key[2]}`;
}

export function decodeCursor(text) {
  const parts = String(text || '').split('|').map((n) => Number(n));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts;
}

/**
 * 把一条桶内记录归一化成统一消息结构（前端只认这一种形状）。
 */
export function normalizeRecord(rec, scope, rank) {
  const meta = aiScopeMeta(scope);
  const seq = Number(rec.seq) || 0;
  return {
    uid: `${scope}#${rank}#${seq}`,
    scope,
    scopeLabel: meta.label,
    scopeShort: meta.short,
    scopeIcon: meta.icon,
    scopeGroup: meta.group,
    seq,
    at: Number(rec.at) || 0,
    role: rec.role === 'user' ? 'user' : 'assistant',
    text: String(rec.text || ''),
    suggestions: Array.isArray(rec.suggestions) ? rec.suggestions : [],
    actions: Array.isArray(rec.actions) ? rec.actions : [],
    artifacts: Array.isArray(rec.artifacts) ? rec.artifacts : [],
    calls: Array.isArray(rec.calls) ? rec.calls : [],
    images: Array.isArray(rec.images) ? rec.images : [],
    promptBlock: rec.promptBlock || null,
    links: Array.isArray(rec.links) ? rec.links : [],
    extra: rec.extra && typeof rec.extra === 'object' ? rec.extra : {},
    tokens: rec.tokens || zeroTokens(),
    durationMs: Number(rec.durationMs) || 0,
    ok: rec.ok !== false,
    changed: !!rec.changed,
    action: rec.action || null,
    intent: rec.intent || null,
    params: rec.params || null,
    reran: rec.reran || null,
  };
}

/** 收集全部归一化消息（升序） */
function collectThread(project, scopeFilter = '') {
  const buckets = threadBuckets(project);
  const out = [];
  for (const b of buckets) {
    if (scopeFilter && scopeFilter !== 'all' && b.scope !== scopeFilter) continue;
    const msgs = b.bucket?.messages;
    if (!Array.isArray(msgs)) continue;
    for (const rec of msgs) {
      out.push({ key: sortKey(rec, b.rank), msg: normalizeRecord(rec, b.scope, b.rank) });
    }
  }
  out.sort((a, b) => cmpKey(a.key, b.key));
  return out;
}

/**
 * 读统一时间线。
 * @param {object} project
 * @param {object} o
 * @param {string} [o.scope]   档位过滤：'all'（全部，默认）或某个档位 id
 * @param {string} [o.before]  游标：只返回比它更早的消息（向上翻历史）
 * @param {number} [o.limit]   单页条数上限
 * @returns {{messages:Array, nextCursor:string|null, hasMore:boolean}}
 */
export function readThread(project, o = {}) {
  const scope = String(o.scope || 'all');
  const limit = Math.max(1, Math.min(500, Number(o.limit) || 120));
  const all = collectThread(project, scope);
  const cur = o.before ? decodeCursor(o.before) : null;
  const older = cur ? all.filter((x) => cmpKey(x.key, cur) < 0) : all;
  const page = older.length > limit ? older.slice(older.length - limit) : older;
  const next = older.length > page.length && page.length
    ? encodeCursor(page[0].key) : null;
  return {
    messages: page.map((x) => x.msg),
    nextCursor: next,
    hasMore: Boolean(next),
  };
}

/** 各档位消息条数（前端切换条上的计数徽标） */
export function threadCounts(project) {
  const counts = {};
  for (const id of AI_SCOPE_IDS) counts[id] = 0;
  for (const b of threadBuckets(project)) {
    const n = Array.isArray(b.bucket?.messages) ? b.bucket.messages.length : 0;
    counts[b.scope] = (counts[b.scope] || 0) + n;
  }
  counts.all = Object.entries(counts).reduce((a, [, n]) => a + n, 0);
  return counts;
}

/* -------------------------------------------------------------------------- *
 * 档位目录：每档的提示文案 / 快捷指令 / 功能按钮（前端据此渲染，不各自硬编码）
 * ------------------------------------------------------------------------- */

/** 制片助手（总览档）的可用指令 */
const PROJECT_SAYS = CHAT_STEPS.filter((s) => s.id !== 'export').map((s) => ({ text: s.say, label: s.label }));

/** 封面的功能按钮（真正的客户端动作，act 由前端注册处理函数） */
const COVER_ACTIONS = [
  { id: 'cover.one-click', label: '✦ 一键生成封面', act: 'cover.one-click', primary: true },
  { id: 'cover.upload-refs', label: '⇧ 上传参考图', act: 'cover.upload-refs' },
  { id: 'cover.pick-refs', label: '▣ 资源库选参考图', act: 'cover.pick-refs' },
  { id: 'cover.upload-cover', label: '⇧ 上传图片作封面', act: 'cover.upload-cover' },
  { id: 'cover.from-library-cover', label: '▣ 资源库选图作封面', act: 'cover.from-library-cover' },
  { id: 'cover.reset-cover', label: '↺ 恢复名称封面', act: 'cover.reset-cover' },
];

const STYLE_SUGGESTIONS = [
  '赛博朋克霓虹都市，冷蓝与洋红，手持快节奏',
  '唐代宫廷仕女画风，暖金与胭脂红，仪式感长镜',
  '黑白默片质感，高对比硬光，固定机位',
];

const CANVAS_SUGGESTIONS = [
  { text: '项目进度', label: '项目进度' },
  { text: '整理画布', label: '整理画布' },
  { text: '检查一致性', label: '检查一致性' },
  { text: '下一步做什么', label: '下一步' },
];

/**
 * 生成档位目录：每个档位的提示文案、快捷指令、功能按钮、token 账目与可用性。
 * 这是前端唯一的「档位差异」来源——切换档位时提示与按钮随之改变。
 */
export function scopeCatalog(project) {
  const m = ensureManagement(project);
  const novel = m.kind === 'novel';
  const report = stepTokenReport(m);
  const total = report.total;
  const rowOf = (id) => report.steps.find((s) => s.id === id) || null;
  const scopes = [];

  for (const id of AI_SCOPE_IDS) {
    const meta = aiScopeMeta(id);
    const entry = {
      id,
      label: meta.label,
      short: meta.short,
      icon: meta.icon,
      group: meta.group,
      available: true,
      unavailableReason: '',
      placeholder: '',
      hint: '',
      context: [],
      suggestions: [],
      actions: [],
      tokens: { exec: zeroTokens(), chat: zeroTokens(), sum: zeroTokens() },
    };

    if (id === 'project') {
      entry.available = novel;
      entry.unavailableReason = novel ? '' : '制片助手只作用于小说创作项目';
      entry.placeholder = '一句话推进整条流水线：跑完六步 / 一键全流程 / 验收 / 出片…';
      entry.hint = '我是 AI 制片助手，小说合成短剧的每一步都能在这里用一句话完成。';
      entry.context = projectContextLines(project);
      entry.suggestions = PROJECT_SAYS.slice(0, 8);
      entry.actions = [
        { id: 'project.steps', label: '⏩ 跑完六步', say: '依次跑完全部六个步骤', primary: true },
        { id: 'project.director', label: '✦ 一键全流程', say: '一键完成最终产物全流程' },
        { id: 'project.verify', label: '✓ 验收报告', say: '给出最终产物验收报告' },
        { id: 'project.export', label: '⤓ 导出记录', act: 'thread.export' },
      ];
      entry.tokens = { exec: total, chat: zeroTokens(), sum: total };
    } else if (STEP_SCOPE_IDS.includes(id)) {
      entry.available = novel;
      entry.unavailableReason = novel ? '' : '六步工作台只存在于小说创作项目';
      const ctx = stepChatContext(project, id);
      const acts = STEP_CHAT_ACTIONS[id] || [];
      entry.placeholder = `说一句要改什么，例如「${acts[0]?.say || '把这一步改一下'}」…`;
      entry.hint = `我是「${stepChatLabel(id)}」的协作助手，这一步说一句话就能改。`;
      entry.context = ctx.lines;
      entry.suggestions = acts.slice(0, 4).map((a) => ({ text: a.say, label: a.label }));
      entry.actions = acts.map((a) => ({
        id: `${id}.${a.id}`, label: a.label, say: a.say, primary: a.id === 'rerun',
      }));
      const row = rowOf(id);
      entry.tokens = row
        ? { exec: row.exec, chat: row.chat, sum: row.sum }
        : { exec: zeroTokens(), chat: zeroTokens(), sum: zeroTokens() };
    } else if (id === 'cover') {
      entry.placeholder = '描述你想要的封面（如「水墨风、留白多、带点孤寂感」）…';
      entry.hint = '我是封面创作助手：说一句方向，或直接用下面的按钮。';
      entry.context = [
        `当前封面：${m.cover?.url ? '已有（点击消息里的图可放大）' : '还没有，用名称封面'}`,
        `片名：${m.bible?.title ? `《${m.bible.title}》` : project.name}`,
      ];
      entry.suggestions = [
        { text: '水墨风、留白多、带点孤寂感', label: '水墨留白' },
        { text: '赛博朋克霓虹都市，冷蓝与洋红', label: '赛博霓虹' },
        { text: '把现在的封面换成暖色调的黄昏', label: '暖调黄昏' },
      ];
      entry.actions = COVER_ACTIONS.map((a) => ({ ...a }));
      entry.tokens = { exec: zeroTokens(), chat: (m.aiScopes?.cover?.tokens || zeroTokens()), sum: (m.aiScopes?.cover?.tokens || zeroTokens()) };
    } else if (id === 'style') {
      entry.placeholder = '描述你想要的导演风格（如「赛博朋克霓虹都市，冷蓝与洋红」）…';
      entry.hint = '我是导演风格设计师：说说题材、基调、颜色、光线、运镜与节奏，我来补全成完整档案。';
      const draft = m.aiScopes?.style?.state?.draft || null;
      entry.context = draft
        ? [`草稿进行中：${draft.label || '（未命名）'}${draft.tone ? ` · ${draft.tone}` : ''}`]
        : ['还没有草稿：说说你想要的画面长什么样。'];
      // 草稿本体随会话存在（关窗不丢）；前端保存时据此提交完整档案
      entry.draft = draft;
      entry.ready = !!m.aiScopes?.style?.state?.ready;
      entry.suggestions = STYLE_SUGGESTIONS.map((t) => ({ text: t, label: t.slice(0, 10) }));
      entry.actions = [
        { id: 'style.save', label: '💾 保存为导演风格', act: 'style.save', primary: true },
        { id: 'style.keep', label: '↺ 再改一轮', say: '再改一轮' },
      ];
      entry.tokens = { exec: zeroTokens(), chat: (m.aiScopes?.style?.tokens || zeroTokens()), sum: (m.aiScopes?.style?.tokens || zeroTokens()) };
    } else if (id === 'canvas') {
      entry.placeholder = '例如：给场景补 4 个镜头 / 解释 @n_1 的依赖 / 整理画布';
      entry.hint = '我是画布协作者：能读到整张图，解释依赖、检查一致性、整理布局，也能直接给场景补镜头链。';
      entry.context = [
        `画布节点 ${project.nodes?.length || 0} 个 · 连线 ${project.edges?.length || 0} 条`,
      ];
      entry.suggestions = CANVAS_SUGGESTIONS;
      entry.actions = [
        { id: 'canvas.arrange', label: '⇕ 整理画布', say: '整理画布' },
        { id: 'canvas.consistency', label: '⚠ 检查一致性', say: '检查一致性' },
        { id: 'canvas.status', label: '📊 项目进度', say: '项目进度' },
      ];
      entry.tokens = { exec: zeroTokens(), chat: (m.aiScopes?.canvas?.tokens || zeroTokens()), sum: (m.aiScopes?.canvas?.tokens || zeroTokens()) };
    }
    scopes.push(entry);
  }
  return scopes;
}

function projectContextLines(project) {
  const m = ensureManagement(project);
  const eps = m.episodes || [];
  const chars = m.characters || [];
  const nodes = project.nodes || [];
  return [
    `项目「${project.name}」· ${nodes.length} 个画布节点`,
    `角色 ${chars.length} 位 · 分集 ${eps.length} 集`,
  ];
}

/* -------------------------------------------------------------------------- *
 * 统一派发：按档位把一句话交给对应的既有业务函数
 * ------------------------------------------------------------------------- */

/** 记录某个桶在调用前的条数，用来识别「这次调用追加了哪些消息」 */
function bucketSizes(project) {
  const sizes = {};
  for (const b of threadBuckets(project)) {
    const key = `${b.scope}#${b.rank}`;
    sizes[key] = Array.isArray(b.bucket?.messages) ? b.bucket.messages.length : 0;
  }
  return sizes;
}

/** 调用后取出新追加的消息（统一返回给前端，避免前端再拉一次全量） */
function collectAppended(project, scope, before) {
  const out = [];
  for (const b of threadBuckets(project)) {
    if (b.scope !== scope) continue;
    const msgs = b.bucket?.messages;
    if (!Array.isArray(msgs)) continue;
    const from = before[`${b.scope}#${b.rank}`] || 0;
    for (let i = from; i < msgs.length; i += 1) {
      out.push(normalizeRecord(msgs[i], b.scope, b.rank));
    }
  }
  out.sort((a, b) => (a.at - b.at) || (a.seq - b.seq));
  return out;
}

/**
 * 统一派发入口。
 * @param {object} o
 * @param {object} o.project
 * @param {string} o.scope     档位 id
 * @param {string} o.message   用户这一句话
 * @param {string} [o.modelId]
 * @param {Array}  [o.refs]    封面参考图（只在封面档有意义；不落盘）
 */
export async function dispatchAiChat({ project, scope, message, modelId = '', refs = [], log = () => {} } = {}) {
  const text = String(message || '').trim();
  if (!text) return { ok: false, error: '消息不能为空' };
  const m = ensureManagement(project);
  if (scope !== 'project' && scope !== 'cover' && scope !== 'style' && scope !== 'canvas'
      && !STEP_SCOPE_IDS.includes(scope)) {
    return { ok: false, error: `未知对话档位「${scope}」` };
  }
  if ((scope === 'project' || STEP_SCOPE_IDS.includes(scope)) && m.kind !== 'novel') {
    return { ok: false, error: '只有创作项目（六步工作台）才有这类对话' };
  }

  const before = bucketSizes(project);

  if (scope === 'project') {
    const r = await runProductionChat({ project, message: text, modelId, log });
    return { ok: r.ok !== false, scope, pending: !!r.pending, taskId: r.taskId || '', intent: r.intent || '', appended: collectAppended(project, 'project', before) };
  }

  if (STEP_SCOPE_IDS.includes(scope)) {
    const r = await runStepChat({ project, stepId: scope, message: text, modelId, log });
    return {
      ok: r.ok !== false, scope, action: r.action || '', changed: !!r.changed,
      reran: r.reran || null, appended: collectAppended(project, scope, before),
    };
  }

  if (scope === 'cover') {
    const bucket = aiScopeOf(project, 'cover');
    const history = bucket.messages
      .filter((x) => x.role === 'user' || x.role === 'assistant')
      .map((x) => ({ role: x.role, content: x.text }))
      .slice(-12);
    const usage = zeroTokens();
    appendAiMessage(project, 'cover', { role: 'user', text });
    try {
      const out = await coverChat({
        project, m, messages: history, refs, modelId,
        log,
        onUsage: (u) => {
          usage.prompt += u.promptTokens || 0;
          usage.completion += u.completionTokens || 0;
          usage.total += u.totalTokens || 0;
          usage.calls += u.calls || 0;
        },
      });
      appendAiMessage(project, 'cover', {
        role: 'assistant',
        text: out.reply || '已写好封面提示词，确认后即可生成。',
        suggestions: out.suggestions || [],
        promptBlock: { prompt: out.prompt, negative: out.negative },
        extra: { source: out.source, fellBack: !!out.fellBack },
        tokens: usage,
      });
    } catch (err) {
      appendAiMessage(project, 'cover', { role: 'assistant', text: `✗ ${err.message}`, ok: false });
    }
    commitAiScope(project, 'cover');
    return { ok: true, scope, appended: collectAppended(project, 'cover', before) };
  }

  if (scope === 'style') {
    const bucket = aiScopeOf(project, 'style');
    const history = bucket.messages
      .filter((x) => x.role === 'user' || x.role === 'assistant')
      .map((x) => ({ role: x.role, content: x.text }))
      .slice(-14);
    const usage = zeroTokens();
    appendAiMessage(project, 'style', { role: 'user', text });
    try {
      const out = await styleForgeChat({
        messages: history, draft: bucket.state.draft || null, modelId, log,
        onUsage: (u) => {
          usage.prompt += u.promptTokens || 0;
          usage.completion += u.completionTokens || 0;
          usage.total += u.totalTokens || 0;
          usage.calls += u.calls || 0;
        },
      });
      // 草稿随会话一起存：关掉对话框再打开，风格进度不丢
      bucket.state.draft = out.draft || null;
      bucket.state.ready = !!out.ready;
      bucket.state.missing = out.missing || [];
      appendAiMessage(project, 'style', {
        role: 'assistant',
        text: out.reply,
        suggestions: out.suggestions || [],
        extra: { ready: !!out.ready, missing: out.missing || [], source: out.source, fellBack: !!out.fellBack },
        tokens: usage,
      });
    } catch (err) {
      appendAiMessage(project, 'style', { role: 'assistant', text: `✗ ${err.message}`, ok: false });
    }
    commitAiScope(project, 'style');
    return { ok: true, scope, appended: collectAppended(project, 'style', before) };
  }

  // 画布档：能真正改画布（整理布局 / 补镜头链），改动要落盘并广播
  const usage = zeroTokens();
  appendAiMessage(project, 'canvas', { role: 'user', text });
  try {
    const out = await chatWithCanvas(project, text, modelId, (u) => {
      usage.prompt += u.promptTokens || 0;
      usage.completion += u.completionTokens || 0;
      usage.total += u.totalTokens || 0;
      usage.calls += u.calls || 0;
    });
    const segments = Array.isArray(out.segments) ? out.segments : [];
    appendAiMessage(project, 'canvas', {
      role: 'assistant',
      text: segments.join('\n'),
      extra: { action: out.action || '', changed: !!out.changed },
      tokens: usage,
      changed: !!out.changed,
    });
    if (out.changed) {
      saveProject(project);
      emit('state', { projectId: project.id, project, reason: `canvas-chat:${out.action || 'reply'}` });
    }
  } catch (err) {
    appendAiMessage(project, 'canvas', { role: 'assistant', text: `✗ ${err.message}`, ok: false });
  }
  commitAiScope(project, 'canvas');
  return { ok: true, scope, appended: collectAppended(project, 'canvas', before) };
}

/**
 * 客户端动作回写：把「本地产生的事件」记进统一线程
 * （封面出图、风格保存、画布整理等由前端发起，产物也要能在同一个对话框里回看）。
 */
export function appendClientMessage(project, scope, msg = {}) {
  if (!AI_SCOPE_IDS.includes(scope)) return { ok: false, error: `未知对话档位「${scope}」` };
  const rec = appendAiMessage(project, scope, msg);
  commitAiScope(project, scope);
  return { ok: true, scope, message: normalizeRecord(rec, scope, -1) };
}

/* -------------------------------------------------------------------------- *
 * 统一导出：整个项目的对话合成一份 Markdown / JSON（含等价 curl，可复刻）
 * ------------------------------------------------------------------------- */

export function threadExport(project, format = 'md') {
  const m = ensureManagement(project);
  const all = collectThread(project, 'all');
  const counts = threadCounts(project);
  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      filename: `${project.id}-thread.json`,
      body: JSON.stringify({
        projectId: project.id,
        projectName: project.name,
        exportedAt: new Date().toISOString(),
        scopes: AI_SCOPE_IDS.map((id) => ({ id, label: aiScopeMeta(id).label, messages: counts[id] || 0 })),
        messages: all.map((x) => ({
          scope: x.msg.scope, scopeLabel: x.msg.scopeLabel, seq: x.msg.seq,
          at: new Date(x.msg.at).toISOString(), role: x.msg.role, text: x.msg.text,
          action: x.msg.action, intent: x.msg.intent, params: x.msg.params,
          calls: x.msg.calls, artifacts: x.msg.artifacts, suggestions: x.msg.suggestions,
          images: x.msg.images, promptBlock: x.msg.promptBlock, links: x.msg.links,
          tokens: x.msg.tokens, durationMs: x.msg.durationMs, ok: x.msg.ok,
          curl: (x.msg.calls || []).find((c) => c.curl)?.curl || curlOfCall(x.msg.calls),
        })),
      }, null, 2),
    };
  }

  const lines = [
    `# ${project.name} · 统一 AI 对话记录`,
    '',
    `- 项目：\`${project.id}\``,
    `- 导出时间：${new Date().toISOString()}`,
    `- 消息总数：${counts.all} 条（${AI_SCOPE_IDS.map((id) => `${aiScopeMeta(id).short} ${counts[id] || 0}`).join(' · ')}）`,
    '',
    '> 复刻方式：把下面每步的 `{projectId}` 换成你自己的项目 ID，端口换成你启动服务的端口。',
    '',
    '## 一、完整对话流程（按时间）',
    '',
  ];
  for (const x of all) {
    const msg = x.msg;
    const who = msg.role === 'user' ? '🧑 用户' : '🤖 助手';
    lines.push(`### ${msg.scopeLabel} · ${who}（${new Date(msg.at).toLocaleString('zh-CN', { hour12: false })}）`);
    lines.push('');
    lines.push('```text');
    lines.push(msg.text);
    lines.push('```');
    lines.push('');
    if (msg.promptBlock?.prompt) {
      lines.push(`提示词：\`${msg.promptBlock.prompt}\``);
      if (msg.promptBlock.negative) lines.push(`负向：\`${msg.promptBlock.negative}\``);
      lines.push('');
    }
    if (msg.images?.length) {
      lines.push(`图片：${msg.images.map((u) => `[${u}](${u})`).join(' · ')}`);
      lines.push('');
    }
    if (msg.durationMs) lines.push(`耗时：${(msg.durationMs / 1000).toFixed(1)}s  `);
    if (msg.tokens?.total) lines.push(`本次 token：${msg.tokens.total}（输入 ${msg.tokens.prompt} / 输出 ${msg.tokens.completion}）  `);
    const curl = (msg.calls || []).find((c) => c.curl)?.curl || curlOfCall(msg.calls);
    if (curl) {
      lines.push('', '等价复刻命令：', '', '```bash', curl, '```', '');
    }
    if (msg.artifacts?.length) {
      lines.push(`产物：${msg.artifacts.map((a) => `[${a.label}](${String(a.url).replace(project.id, '{projectId}')})`).join(' · ')}`);
      lines.push('');
    }
  }
  lines.push('## 二、一键复刻命令串（按顺序执行）', '', '```bash', '# 0) 启动服务（端口按实际替换）', 'PORT=4599 node server.mjs', 'PROJECT={projectId}', '');
  for (const x of all) {
    const msg = x.msg;
    if (msg.role !== 'user') continue;
    const curl = (msg.calls || []).find((c) => c.curl)?.curl || curlOfCall(msg.calls);
    if (!curl) continue;
    lines.push(`# ${msg.scopeLabel} · ${msg.text.replace(/\n/g, ' ').slice(0, 60)}`);
    lines.push(curl.replace(project.id, '{projectId}'));
    lines.push('');
  }
  lines.push('```', '');
  lines.push('## 三、环境要求与诚实化说明', '');
  lines.push('1. **真实模式（默认）**：每个片段都必须由 ComfyUI 视频工作流生成；少一段、或成片是 ffmpeg 关键帧预览，验收一律判「缺失」，不会冒充真实短剧。');
  lines.push('2. **关键帧预览模式**：明确说「使用关键帧预览模式」才启用，产物是静态帧等长拼接，验收记为「降级」，不是 AI 视频。');
  lines.push('3. **零 Key LLM**：小说 / 剧本 / 导演阐述会标 `mock` / `heuristic`，不冒充模型生成；配置模型后重跑即可覆盖。');
  lines.push('4. **GPU 时间**：MiniMax H3 等视频工作流单片段可能需数分钟，10 片段 × 3s 的 30s 短剧请预留约 10 倍单段耗时。');
  lines.push('5. 导出的 JSON 含每一步的 `scope / action / intent / calls / curl / artifacts`，可直接被脚本重放。');
  lines.push('');
  return {
    contentType: 'text/markdown; charset=utf-8',
    filename: `${project.id}-thread.md`,
    body: lines.join('\n'),
  };
}

/** 从调用记录里还原一条可复制的 curl（step-chat 的 calls 没有预置 curl 字段） */
function curlOfCall(calls) {
  const call = (Array.isArray(calls) ? calls : []).find((c) => c && c.method && c.path);
  if (!call) return '';
  try {
    return curlOf(call);
  } catch {
    return '';
  }
}
