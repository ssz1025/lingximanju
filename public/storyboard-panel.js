/* ============================================================================
 * 第⑤步「分镜画面设置」与「分镜板画廊」的纯 HTML 构造层
 *
 * 为什么单独一个模块：
 *   · project-view.js 已经很长，画面设置是一组独立的表单 + 卡片 + 画廊；
 *   · 这里只 import utils / project-options（两者都无 DOM 副作用），
 *     可以被 node --test 直接导入做字符串断言——版式卡、默认选中态、
 *     选项 id 是否与服务端 storyboard-settings.mjs 对齐，都能在测试里卡住。
 *
 * 渲染约定：
 *   · 版式选中态写在容器 data-layout 上，事件层读它再提交（不依赖 input:checked）；
 *   · 所有可提交字段统一挂 data-sb / data-sbp 前缀，事件层用一个 readSb 就能收全；
 *   · 真实版面几何（宽高 / 单格大小）在服务端推导，这里只保证选项与文案一致。
 * ==========================================================================*/
import { esc } from './utils.js';
import {
  STORYBOARD_LAYOUTS, STORYBOARD_ASPECTS, STORYBOARD_SOURCES, STORYBOARD_CAPTIONS,
  STORYBOARD_GUIDES, STORYBOARD_PROMPT_PARTS, storyboardLayout, storyboardDescription,
} from './project-options.js';

/**
 * 分镜画面设置面板：版式（九宫格等）/ 画幅 / 格内信息 / 画面来源 / 构图参考 / 提示词公式。
 * @param {object} p 项目（读 settings.aspect 作为「跟随项目画幅」的展示值）
 * @param {object} m 管理态（读 storyboard 设置）
 */
export function storyboardFrameSettingsHTML(p = {}, m = {}) {
  const s = m.storyboard || {};
  const layout = storyboardLayout(s.layout);
  const aspect = s.aspect || 'inherit';
  const projectAspect = p.settings?.aspect === '9:16' ? '9:16' : '16:9';
  const desc = storyboardDescription({ ...s, layout: layout.id, aspect }, projectAspect);
  const opts = (list, cur) => list
    .map((o) => `<option value="${esc(o.id)}"${o.id === cur ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  const pOn = (k) => (s.prompt?.[k] === undefined ? true : !!s.prompt[k]);
  return `<div class="pvs-set" data-sbs data-layout="${esc(layout.id)}">
    <div class="pvs-set-head">
      <b>分镜画面设置</b>
      <span>版式 · 画幅 · 格内信息 · 提示词公式</span>
      <em data-sb-desc>${esc(desc)}</em>
    </div>
    <div class="pvs-set-layouts">
      ${STORYBOARD_LAYOUTS.map((l) => `<button type="button" class="pvs-layout${l.id === layout.id ? ' on' : ''}"
        data-sb-layout="${l.id}" title="${esc(l.hint)}" aria-pressed="${l.id === layout.id}">
        <span class="pvs-layout-mini" style="--cols:${l.cols};--rows:${l.rows}" aria-hidden="true">${'<i></i>'.repeat(l.cells)}</span>
        <b>${esc(l.label)}</b><em>${esc(l.size)} · ${l.cells} 格</em>
      </button>`).join('')}
    </div>
    <div class="pvs-set-row">
      <label>画幅<select data-sb="aspect">${opts(STORYBOARD_ASPECTS, aspect)}</select></label>
      <label>格内信息<select data-sb="captionMode">${opts(STORYBOARD_CAPTIONS, s.captionMode || 'spec')}</select></label>
      <label>画面来源<select data-sb="source">${opts(STORYBOARD_SOURCES, s.source || 'mixed')}</select></label>
      <label>构图参考<select data-sb="guides">${opts(STORYBOARD_GUIDES, s.guides || 'thirds')}</select></label>
    </div>
    <div class="pvs-set-toggles">
      <label><input type="checkbox" data-sb="showNo" ${s.showNo === false ? '' : 'checked'}> 序号角标</label>
      <label><input type="checkbox" data-sb="watermark" ${s.watermark === false ? '' : 'checked'}> 页脚署名</label>
      <span class="pvs-set-sep">提示词公式</span>
      ${STORYBOARD_PROMPT_PARTS.map((x) => `<label title="${esc(x.hint)}"><input type="checkbox" data-sbp="${x.id}" ${pOn(x.id) ? 'checked' : ''}> ${esc(x.label)}</label>`).join('')}
    </div>
    <div class="pvs-set-acts">
      <button class="btn sm" data-act="sb-save">保存设置</button>
      <button class="btn sm primary" data-act="sb-apply">⌗ 保存并重排分镜板</button>
      <span class="pvs-set-hint" data-sb-hint>重排只合成 SVG，不会重新出图，也不烧 GPU</span>
    </div>
  </div>`;
}

/**
 * 分镜板画廊：每段一张，点击看大图。
 * 现有产物里没有 gridUrl 的段落不展示（避免一排空卡片），
 * 缺板数量由上方统计卡的「分镜板 n/总数」体现。
 */
export function storyboardSheetsHTML(m = {}) {
  const sheets = [];
  for (const ep of (m.episodes || [])) {
    for (const seg of (ep.segments || [])) {
      if (seg.gridUrl) sheets.push({ ep, seg });
    }
  }
  if (!sheets.length) return '';
  const layout = storyboardLayout(m.storyboard?.layout);
  return `<div class="pvs-sheets">
    <div class="pvs-head"><b>分镜板 · ${esc(layout.label)} ${layout.cols}×${layout.rows}</b><span>${sheets.length} 张 · 点击查看大图</span></div>
    <div class="pvs-sheet-grid">
      ${sheets.map(({ ep, seg }) => {
    const title = `第 ${ep.no} 集 · 第 ${seg.no} 段分镜板`;
    // 每格视觉物料徽标：站位图 / 图生视频提示词 / 角色参考槽位（重排后每格都有）
    const cells = seg.cells || [];
    const blockings = cells.filter((c) => c.blockingUrl).length;
    const prompts = cells.filter((c) => c.videoPrompt).length;
    const refs = cells.reduce((a, c) => a + (c.visual?.slots?.length || 0), 0);
    const badges = [
      seg.gridCells ? `<em>${seg.gridCells} 格</em>` : '',
      blockings ? `<em>站位 ${blockings}</em>` : '',
      prompts ? `<em>提示词 ${prompts}</em>` : '',
      refs ? `<em>参考图 ${refs}</em>` : '',
    ].filter(Boolean).join('');
    return `<button class="pvs-sheet" data-act="sheet-open" data-url="${esc(seg.gridUrl)}" data-title="${esc(title)}" title="${esc(title)}">
          <img src="${esc(seg.gridUrl)}" alt="${esc(title)}" loading="lazy">
          <span>第 ${ep.no} 集 · 第 ${seg.no} 段</span>
          ${badges}
        </button>`;
  }).join('')}
    </div>
  </div>`;
}
