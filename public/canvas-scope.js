/* ============================================================================
 * 画布范围（Canvas Scope）UI 规则 —— 纯函数层
 *
 * 从 app.js 抽出，让「总览 / 主画布 / 单集画布」三种范围的判定与文案只存在一处：
 *  - 无 DOM、无 fetch、无副作用，可被 node --test 直接导入。
 *  - app.js 只负责把结果写进 <select> / hint 元素，以及调用 canvas.setProject()。
 *  - 范围键本身的编解码在 project-model.js，下拉数据在 canvas-compose.js；
 *    本模块只管「怎么分组、什么时候算变化、显示什么提示、是否只读」。
 * ==========================================================================*/
import { parseScopeKey } from './project-model.js';

/** 关闭项目后给画布一个空壳，避免残留上一个项目的节点 / 连线 / 视口 */
export const EMPTY_CANVAS_PROJECT = {
  id: '', name: '', nodes: [], edges: [], settings: {}, management: {},
};

/**
 * 把 canvasScopeOptions() 的扁平列表按 divider 切成 optgroup 结构。
 * divider 之前属于「总览」，之后每个 divider 开启一个新季。
 * 空组不会被输出，避免出现没有 option 的 optgroup。
 */
export function groupScopeOptions(options, rootLabel = '总览') {
  const grouped = [];
  let cur = { label: rootLabel, items: [] };
  for (const o of (Array.isArray(options) ? options : [])) {
    if (!o) continue;
    if (o.divider) {
      if (cur.items.length) grouped.push(cur);
      cur = { label: o.label || '分集', items: [] };
    } else if (o.key) {
      cur.items.push(o);
    }
  }
  if (cur.items.length) grouped.push(cur);
  return grouped;
}

/** 选项签名：SSE 会频繁全量回灌状态，选项没变就不要重建 <select>，否则会打断用户操作 */
export function scopeOptionsSignature(projectId, grouped) {
  const parts = (Array.isArray(grouped) ? grouped : [])
    .map((g) => `${g.label}:${(g.items || []).map((o) => o.key).join(',')}`);
  return `${projectId || ''}|${parts.join('|')}`;
}

/** 范围条右侧提示文案 */
export function scopeHint(kind, episodeCount = 0) {
  if (kind === 'overall') return `组合 ${episodeCount} 集 · 双击节点进入该集`;
  if (kind === 'main') return '项目主画布 · 可编辑 / 可运行';
  return '本集独立画布 · 可编辑';
}

/** 组合总览是派生只读视图：禁止在它上面跑流水线或改动主画布 */
export function isScopeReadOnly(project, view, scopeKey) {
  return !!project && view === 'canvas' && parseScopeKey(scopeKey).kind === 'overall';
}
