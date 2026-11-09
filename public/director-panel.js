/* 导演 Agent 技能面板 / 最终产物验收报告 —— 纯视图片段
 * 状态与事件由 project-view.js 统一管理（ui.director + bindEvents），
 * 这里只负责把后端 /api/bootstrap 的 directorSkills 与运行报告渲染成 DOM。
 *
 * 技能分两组渲染：
 *   flow  —— 制片流程策略（决定交付什么、跑哪些步骤）
 *   style —— 导演风格（决定画面长什么样，带调色板 / 节奏 / 媒介）
 * 两组不能混在一格里，否则用户分不清「换策略」和「换画面」。 */
import { esc } from './utils.js';

/** bootstrap 未带技能清单时的兜底（与 core/director-skills.mjs 保持同构，避免首屏空白）
 *  这里只保留分组骨架与少量代表项：真实清单由 /api/bootstrap 下发，兜底只为不空白。 */
export const FALLBACK_SKILLS = [
  { id: 'full', icon: '🎬', label: '全流程导演', tagline: '一键成片 · 从原著到双产物',
    summary: '串起全部六个制作步骤，先补齐导演阐述、角色库与音色，再逐阶段调度智能体，最后核对导演包与成片。',
    highlights: ['导演阐述', '角色 / 音色', '六步全跑', '双产物验收'], capabilities: [
      { label: '导演阐述' }, { label: '角色提取' }, { label: '音色分配' }],
    deliverables: null, stepMode: { label: '完整六步' }, steps: 'all', group: 'flow' },
  { id: 'script', icon: '▤', label: '剧本精修导演', tagline: '先把故事立住，再进画面',
    summary: '在全流程之前补齐创作设定，并做导演阐述、角色与音色，让剧本与上下文阶段拿到的信息更完整。',
    highlights: ['创作设定', '导演阐述', '角色 / 音色', '六步全跑'], capabilities: [
      { label: '创作设定补全' }, { label: '导演阐述' }, { label: '角色提取' }, { label: '音色分配' }],
    deliverables: null, stepMode: { label: '完整六步' }, steps: 'all', group: 'flow' },
  { id: 'visual', icon: '⌗', label: '视觉一致性导演', tagline: '锁定画风，专注画面链',
    summary: '锁定双产物，只编排智能体四步，并强制按当前画布重新打包，方便反复调整画面后重出交接包。',
    highlights: ['双产物锁定', '智能体四步', '画布重打包', '一致性约束'], capabilities: [
      { label: '导演阐述' }, { label: '角色提取' }, { label: '音色分配' }],
    deliverables: { video: true, pack: true }, stepMode: { label: '智能体四步' }, steps: 'core', group: 'flow' },
  { id: 'pack', icon: '▦', label: '交接包导演', tagline: '最快拿可导入的导演包',
    summary: '只产出交接包：跳过本地视频渲染与附加 Agent，用最短链路把剧本、分镜与首帧送到 ComfyUI 导演工作台。',
    highlights: ['仅导演包', '跳过视频渲染', '最短链路', '可导入导演台'], capabilities: [{ label: '导演阐述' }],
    deliverables: { video: false, pack: true }, stepMode: { label: '完整六步' }, steps: 'all', group: 'flow' },
];

/** 分组元数据兜底（与 core/director-skills.mjs 的 DIRECTOR_SKILL_GROUPS 同构） */
export const FALLBACK_GROUPS = [
  { id: 'flow', label: '制片流程策略', desc: '决定交付物组合与执行步骤范围，不改变画面美学' },
  { id: 'style', label: '导演风格', desc: '把一位导演的视听语法注入导演阐述与画面生成，真正改变成片的样子' },
];

const fmtAt = (ts) => ts ? new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const fmtDur = (ms) => `${((Number(ms) || 0) / 1000).toFixed(1)}s`;
const cut = (v, n) => { const s = String(v ?? ''); return s.length > n ? `${s.slice(0, n)}…` : s; };

function deliverableLabel(skill) {
  if (!skill?.deliverables) return '沿用项目交付设置';
  const d = skill.deliverables;
  return [d.video ? '成片视频' : '', d.pack ? '导演包' : ''].filter(Boolean).join(' + ') || '未指定';
}

/** 调色板色块：让用户在点选前就看见「换成这位导演画面会变成什么样」 */
function swatchesHTML(style) {
  const palettes = (style?.palettes || []).slice(0, 4);
  if (!palettes.length) return '';
  const def = style.defaultPalette;
  return `<span class="dir-swatch" aria-hidden="true">${palettes.map((p) =>
    `<i style="background:${esc(p.hex)}" class="${p.key === def ? 'on' : ''}" title="${esc(p.name)} ${esc(p.hex)}"></i>`).join('')}</span>`;
}

/** 一张技能卡：流程策略卡显示交付/步骤，风格卡额外显示调色板与节奏 */
function skillCardHTML(s, current, busy) {
  const on = s.id === current.id;
  const style = s.style;
  const accent = style?.palettes?.find((p) => p.key === style.defaultPalette)?.hex || '#8A8A8A';
  return `<button type="button" class="dir-skill ${on ? 'on' : ''} ${s.group === 'style' ? 'is-style' : 'is-flow'}"
      data-dir="skill" data-id="${esc(s.id)}" role="radio" aria-checked="${on}" ${busy ? 'disabled' : ''}
      ${style ? `style="--dir-accent:${esc(accent)}"` : ''}
      title="${esc(s.summary || s.tagline || '')}">
      <span class="dir-skill-ico">${esc(s.icon || '◇')}</span>
      <span class="dir-skill-main">
        <strong>${esc(s.label)}</strong>
        <small>${esc(s.tagline || '')}</small>
        ${style
    ? `<span class="dir-skill-meta">${swatchesHTML(style)}<em>${esc(style.paceLabel || '')}</em></span>`
    : `<span class="dir-skill-meta"><em>${esc(s.stepMode?.label || '完整六步')} · ${esc(deliverableLabel(s))}</em></span>`}
      </span>
      <span class="dir-skill-check">${on ? '✓' : ''}</span>
    </button>`;
}

/** 主色调选择器：只有风格技能且档案里有多色时才显示。
 *  张艺谋有英雄红 / 影墨黑 / 竹林绿 / 大漠黄，换色不换导演——
 *  点击后 paletteKey 落盘，出图与分镜提示词里的主色随之改变。 */
function palettePickerHTML(current, busy) {
  const style = current.style;
  const palettes = style?.palettes || [];
  if (palettes.length < 2) return '';
  const active = current.paletteKey || style.defaultPalette;
  return `<div class="dir-palette" role="radiogroup" aria-label="主色调">
    <span class="dir-palette-lb">主色调</span>
    ${palettes.map((p) => `<button type="button" class="dir-pal ${p.key === active ? 'on' : ''}"
        data-dir="palette" data-key="${esc(p.key)}" role="radio" aria-checked="${p.key === active}"
        ${busy ? 'disabled' : ''} title="${esc(p.name)} ${esc(p.hex)}${p.mood ? ` · ${esc(p.mood)}` : ''}">
      <i style="background:${esc(p.hex)}"></i><em>${esc(p.name)}</em>
    </button>`).join('')}
  </div>`;
}

/**
 * 导演风格「单卡」：下拉选完某位导演后，以其主色调描边的卡片呈现——
 * 含图标 / 标语 / 摘要 / 高亮标签 / 主色调选择器 / 附加能力 / 提醒。
 * 风格会越加越多，用下拉收敛选择面，单卡则把「换成这位导演画面长什么样」讲清楚。 */
function styleCardDetailHTML(s, view, busy, warn) {
  const style = s.style;
  const accent = style?.palettes?.find((p) => p.key === style.defaultPalette)?.hex || '#8A8A8A';
  const caps = (s.capabilities || []).map((c) => c.label).join(' · ') || '无附加智能体';
  const styleName = style ? `${style.workTitle} · ${style.director}` : '';
  const palettes = style?.palettes || [];
  const palBlock = palettes.length >= 2
    ? palettePickerHTML(view, busy)
    : (palettes.length === 1
        ? `<div class="dir-palette"><span class="dir-palette-lb">主色调</span><span class="dir-pal on"><i style="background:${esc(palettes[0].hex)}"></i><em>${esc(palettes[0].name)}</em></span></div>`
        : '');
  return `<div class="dir-style-card" style="--dir-accent:${esc(accent)}">
    <div class="dir-style-card-head">
      <span class="dir-style-ico">${esc(s.icon || '◇')}</span>
      <div class="dir-style-card-txt"><strong>${esc(s.label)}</strong><small>${esc(s.tagline || '')}</small></div>
      <span class="dir-style-pace">${esc(style?.paceLabel || '')}</span>
    </div>
    <p class="dir-style-sum">${esc(s.summary || '')}</p>
    <div class="dir-chips">
      ${(s.highlights || []).map((h) => `<span class="dir-chip">${esc(h)}</span>`).join('')}
      ${styleName ? `<span class="dir-chip star">${esc(styleName)}</span>` : ''}
    </div>
    ${palBlock}
    <div class="dir-cap-line"><b>附加能力</b> ${esc(caps)}</div>
    ${warn?.length ? `<div class="dir-warn">${warn.map((w) => `<span>⚠ ${esc(w)}</span>`).join('')}</div>` : ''}
  </div>`;
}

/** ① 设置基础信息步骤：选择技能 + 一键启动全流程 */
export function directorPanelHTML({ skills, groups, skillId, paletteKey, busy, progress, idea, plan, hasSource, runtime }) {
  const list = Array.isArray(skills) && skills.length ? skills : FALLBACK_SKILLS;
  const current = list.find((s) => s.id === skillId) || list[0];
  // 主色以项目实际落盘的 paletteKey 为准（面板随时切换），没记录时用档案默认色
  const currentStyle = current.style
    ? { ...current.style, defaultPalette: paletteKey || current.style.defaultPalette }
    : null;
  const view = { ...current, style: currentStyle, paletteKey: paletteKey || currentStyle?.defaultPalette || null };
  const caps = (current.capabilities || []).map((c) => c.label).join(' · ') || '无附加智能体';
  const pct = Math.max(0, Math.min(100, Math.round((progress?.percent ?? 0) * 100)));
  const warn = (plan?.warnings || []).slice(0, 2);
  // 短剧成片规格：默认 30s / 3s → 10 片段，与 core/runtime-spec.mjs 同源
  const spec = runtime || { totalSeconds: 30, clipSeconds: 3, clipCount: 10, fps: 24 };
  const total = Number(spec.totalSeconds) || 30;
  const clip = Number(spec.clipSeconds) || 3;
  const count = Number(spec.clipCount) || Math.round(total / clip);
  const fps = Number(spec.fps) || 24;
  const frames = Number(spec.totalFrames) || count * Math.round(clip * fps);
  // 分组渲染：优先用后端下发的分组元数据；缺省时按 group 字段就地切分
  const groupMeta = Array.isArray(groups) && groups.length ? groups : FALLBACK_GROUPS;
  const allGroups = groupMeta.map((g) => ({
    ...g,
    skills: list.filter((s) => (s.group || 'flow') === g.id),
  })).filter((g) => g.skills.length);
  const currentIsStyle = current.group === 'style';
  const styleList = list.filter((s) => (s.group || 'flow') === 'style');
  // 风格组改用下拉选择：风格会越加越多，卡片网格会失控；下拉选完后再以单卡呈现所选风格。
  // 流程组保留卡片网格（数量少，且要一眼对比交付 / 步骤差异）。
  const groupsHTML = allGroups.map((g) => {
    if (g.id === 'style') {
      return `<div class="dir-group" data-group="style">
        <div class="dir-group-head"><strong>${esc(g.label)}</strong>
          <small>${esc(g.desc)}</small><em>${g.skills.length}</em></div>
        <select class="dir-style-select" data-dir="style-select" ${busy ? 'disabled' : ''} aria-label="选择导演风格">
          <option value="" ${currentIsStyle ? '' : 'selected'} disabled>选择导演风格…</option>
          ${styleList.map((s) => `<option value="${esc(s.id)}" ${s.id === current.id ? 'selected' : ''}>${esc(s.icon || '◇')} ${esc(s.label)}</option>`).join('')}
        </select>
        ${currentIsStyle
          ? styleCardDetailHTML(current, view, busy, warn)
          : `<div class="dir-style-hint">从上方下拉框选择一位导演风格，下方将以卡片展示其视听语法、节奏与主色调</div>`}
      </div>`;
    }
    return `<div class="dir-group" data-group="${esc(g.id)}">
      <div class="dir-group-head"><strong>${esc(g.label)}</strong>
        <small>${esc(g.desc)}</small><em>${g.skills.length}</em></div>
      <div class="dir-skills" role="radiogroup" aria-label="${esc(g.label)}">
        ${g.skills.map((s) => skillCardHTML(s, current, busy)).join('')}
      </div>
    </div>`;
  }).join('');
  return `<div class="dir-panel" id="dir-panel">
    <div class="dir-head">
      <span class="dir-icon">🎬</span>
      <div class="dir-head-txt"><strong>导演 Agent · 项目技能</strong>
        <small>先选流程策略决定「交付什么」，再选导演风格决定「画面长什么样」；两者可自由组合</small></div>
      <span class="dir-badge">${esc(current.id)}</span>
    </div>
    ${groupsHTML}
    ${currentIsStyle ? '' : `<div class="dir-detail">
      <p>${esc(current.summary || '')}</p>
      <div class="dir-chips">
        ${(current.highlights || []).map((h) => `<span class="dir-chip">${esc(h)}</span>`).join('')}
        <span class="dir-chip alt">步骤 · ${esc(current.stepMode?.label || '完整六步')}</span>
        <span class="dir-chip alt">交付 · ${esc(deliverableLabel(current))}</span>
      </div>
      <div class="dir-cap-line"><b>附加能力</b> ${esc(caps)}</div>
      ${warn.length ? `<div class="dir-warn">${warn.map((w) => `<span>⚠ ${esc(w)}</span>`).join('')}</div>` : ''}
    </div>`}
    <div class="rt-box" id="rt-box">
      <div class="rt-head"><span class="rt-icon">⏱</span>
        <div class="rt-head-txt"><strong>短剧成片规格</strong>
          <small>总时长 ÷ 每片段时长 = 片段数；驱动分镜预算、导演包时间线与成片时长验收</small></div></div>
      <div class="rt-fields">
        <label>总时长 <input id="pv-rt-total" type="number" min="1" max="600" step="0.5" value="${total}" ${busy ? 'disabled' : ''}> 秒</label>
        <label>每片段 <input id="pv-rt-clip" type="number" min="0.5" max="30" step="0.5" value="${clip}" ${busy ? 'disabled' : ''}> 秒</label>
        <button type="button" class="btn sm" data-rt="save" ${busy ? 'disabled' : ''}>保存规格</button>
      </div>
      <div class="rt-eq"><span>${total}s ÷ ${clip}s = <b>${count} 个片段</b> · ${fps}fps · ${frames} 帧${spec.aligned ? '（总时长已按片段时长对齐）' : ''}</span>
        <small>保存后重新运行「一键完成最终产物全流程」按新片段数生成</small></div>
    </div>
    <div class="dir-actions">
      <input id="pv-dir-idea" class="dir-idea" placeholder="${hasSource ? '（可选）一句话构想，供导演阐述参考' : '（建议）一句话构想：没有原著时导演 Agent 会据此生成演示小说'}"
        value="${esc(idea || '')}" ${busy ? 'disabled' : ''}>
      <button type="button" class="btn primary dir-run" data-dir="run" ${busy ? 'disabled' : ''}>
        ${busy ? '⏳ 导演智能体执行中…' : '▶ 一键完成最终产物全流程'}</button>
    </div>
    <div class="dir-progress ${busy || progress?.phase === 'done' ? 'show' : ''}" data-dir-progress>
      <div class="dir-progress-bar"><i style="width:${pct}%"></i></div>
      <span data-dir-msg>${esc(progress?.label || (busy ? '正在准备导演智能体…' : '就绪'))}</span>
      <span data-dir-pct>${pct}%</span>
    </div>
  </div>`;
}

const LEVEL_META = {
  ok: { icon: '✓', label: '达成' },
  degraded: { icon: '◐', label: '降级' },
  missing: { icon: '✕', label: '缺失' },
};

/** ⑦ 成片交付步骤：最近一次导演全流程的验收清单 + 复跑入口 */
export function directorReportHTML({ report, busy }) {
  const items = report?.checklist || [];
  const caps = report?.capabilities || [];
  return `<div class="dir-report" id="dir-report">
    <div class="dir-head">
      <span class="dir-icon">✦</span>
      <div class="dir-head-txt"><strong>导演智能体 · 最终产物验收</strong>
        <small>逐项核对原著、剧本、分镜、步骤状态、导演包与成片；Mock 降级如实标注</small></div>
      <button type="button" class="btn sm" data-dir="rerun" ${busy ? 'disabled' : ''}>↻ 换技能重跑</button>
    </div>
    ${report ? `
      <div class="dir-summary ${report.complete ? 'ok' : 'bad'}">
        <strong>${report.complete ? '✓ 全流程已达成' : '⚠ 尚有未达成项'}</strong>
        <span>${esc(report.summary || '')}</span>
        <small>${esc(report.skillLabel || report.skillId || '')}${report.styleLabel ? ` · 风格 ${esc(report.styleLabel)}` : ''} · ${fmtAt(report.at)} · ${fmtDur(report.durationMs)}
          · 通过 ${report.passed ?? 0} / 降级 ${report.degraded ?? 0} / 缺失 ${report.missing ?? 0}</small>
      </div>
      <div class="dir-checklist">
        ${items.map((i) => `<div class="dir-item lv-${esc(i.level || 'missing')}">
          <span class="dir-item-ico">${LEVEL_META[i.level]?.icon || '·'}</span>
          <div><strong>${esc(i.label)}</strong><small>${esc(cut(i.detail, 90))}</small></div>
          <span class="dir-item-tag">${LEVEL_META[i.level]?.label || i.level}</span>
        </div>`).join('')}
      </div>
      ${caps.length ? `<div class="dir-cap-report"><b>技能能力</b>${caps.map((c) => `<span class="dir-cap-pill ${esc(c.status)}">${esc(c.label)} · ${esc(c.status)}${c.source ? `（${esc(c.source)}）` : ''}</span>`).join('')}</div>` : ''}
      ${(report.steps || []).length ? `<div class="dir-step-report"><b>制作步骤</b>${report.steps.map((s) => `<span class="dir-step-pill ${esc(s.status)}">${esc(s.id)} · ${esc(s.status)}</span>`).join('')}</div>` : ''}
      <div class="dir-report-acts">
        <button type="button" class="btn sm" data-dir="pack">▤ 生成并下载导演包</button>
        <button type="button" class="btn sm" data-dir="scroll-top">↑ 回到技能选择</button>
      </div>` : `
      <div class="dir-empty">还没有运行过导演智能体。到「设置基础信息」选择技能，点「一键完成最终产物全流程」即可从原著一路跑到导演包与成片验收。</div>`}
  </div>`;
}
