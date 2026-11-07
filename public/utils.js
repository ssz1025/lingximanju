/* ============================================================================
 * 前端共享纯工具层
 *
 * 约定
 *  - 零依赖：不 import 任何业务模块，任何视图 / 引擎模块都可以安全地引用它，
 *    不会与 nodes.js / project-model.js 等形成循环依赖。
 *  - 无副作用：顶层不触碰 document / window / localStorage，可被 node --test 直接导入。
 *  - 「同一个概念只保留一份实现」：HTML 转义、截断、数值兜底等过去散落在十几个
 *    视图模块里，且口径并不一致（cut 的省略号是否占位数、esc 是否转义单引号）。
 *  - cut(s, n) 统一为「输出长度 ≤ n（省略号计入 n）」；esc(s) 统一转义 ' 以防属性注入。
 * ==========================================================================*/

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** 任意值转字符串，null / undefined 归空串 */
export function str(s) { return String(s ?? ''); }

/** HTML 文本 / 属性转义：& < > " ' 全覆盖，用户与后端文本入 DOM 前必须经过它 */
export function esc(s = '') {
  return str(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

/** 语义化别名（app.js / source-view.js 历史上叫 escapeHTML） */
export const escapeHTML = esc;

/** 截断：返回长度不超过 n 的字符串，超出时用 … 补位（… 计入 n） */
export function cut(s, n = 120) {
  const t = str(s);
  const lim = Math.max(1, Math.floor(num(n, 120)));
  return t.length > lim ? `${t.slice(0, lim - 1)}…` : t;
}

/** 数值兜底：无效值回退，绝不把 NaN / undefined 带进视图 */
export function num(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

/** 千分位显示 */
export function fmtNum(v) { return num(v).toLocaleString(); }

/** 空值统一显示破折号 */
export function fmt(v) { return v === undefined || v === null || v === '' ? '—' : str(v); }

/** 钳制到闭区间 */
export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

/**
 * 短随机 id（仅前端临时节点 / 浮层使用；持久 id 由后端 uid 负责）。
 * 原实现只有「时间戳 + 4 位随机」，同一毫秒内批量创建节点时有约 7% 的碰撞概率；
 * 收敛到共享层后补一段单调递增序列，保证同毫秒连续调用也唯一。
 */
let uidSeq = 0;
export function uid(prefix = 'n') {
  uidSeq = (uidSeq + 1) % 0xffffff;
  return `${prefix}_${Date.now().toString(36)}${uidSeq.toString(36).padStart(4, '0')}${Math.random().toString(36).slice(2, 5)}`;
}

/** 正则字面量转义（搜索高亮用） */
export function escapeRegExp(s) {
  return str(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** DOM 查询；Node 环境导入本模块不会抛错 */
export function $(id) {
  return typeof document === 'undefined' ? null : document.getElementById(id);
}
