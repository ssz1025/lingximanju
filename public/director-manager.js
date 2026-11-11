/* ============================================================================
 * 导演风格统一管理页 —— 详情 / 删除自定义 / AI 对话生成新导演风格
 *
 * 入口：工作台「导演风格」分组的 ⚙ 管理按钮（project-view.js 绑定 data-dir="manage"）。
 * 数据：GET  /api/director-styles            全量清单（内置 + 自定义）
 *       POST /api/director-styles            保存自定义风格
 *       DELETE /api/director-styles/:id      删除自定义风格
 *       POST /api/director-styles/chat       AI 设计师对话（无状态：历史 + 草稿 进）
 *
 * AI 对话采用「草稿回传」协议：前端持 draft，每轮 POST {messages, draft}，
 * 后端合并出完整草稿并给出 ready 判定；ready 后出现「保存为导演风格」动作。
 * ==========================================================================*/
import { openPage, showPage } from './page.js';
import { openForgeChat } from './style-forge.js';
import { esc } from './utils.js';

async function request(path, body, method) {
  const res = await fetch(path, body !== undefined || method
    ? { method: method || (body !== undefined ? 'POST' : 'GET'),
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined }
    : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

/** 节奏档案 → 一句人话（与后端 paceLabel 同语义的前端兜底） */
function paceText(pace = {}) {
  const min = Number(pace.minShotSec) || 0;
  const max = Number(pace.maxShotSec) || 0;
  if (!min || !max) return '';
  const range = min === max ? `单镜 ${min}s` : `单镜 ${min}–${max}s`;
  const fixed = Math.round((Number(pace.fixedShotRatio) || 0) * 100);
  return fixed >= 30 ? `${range} · 固定长镜 ${fixed}%` : range;
}

/* -------------------------------------------------------------------------- *
 * 详情页：把一份美学档案按「色彩 → 光线 → 构图 → 运镜 → 节奏 → 声音 → 连戏 →
 * 提示词」分区铺开，让用户在选择前就能完整看见导演的视听语法。
 * -------------------------------------------------------------------------- */
function detailBody(s) {
  const pal = s.palettes || [];
  const rows = [
    ['主色规则', s.colorRule], ['光线', s.light], ['构图', s.composition],
    ['运镜', s.camera], ['质感', s.texture], ['基调', s.tone],
    ['视觉风格', s.visualStyle], ['节奏', s.pacing], ['景别策略', s.shotStrategy],
    ['声音策略', s.audioStrategy],
  ].filter(([, v]) => v);
  const palHTML = pal.length ? `<div class="dsm-pals">${pal.map((p) => `
    <span class="dsm-pal ${p.key === s.defaultPalette ? 'on' : ''}" title="${esc(p.mood || '')}">
      <i style="background:${esc(p.hex)}"></i>${esc(p.name)}<small>${esc(p.hex)}</small></span>`).join('')}</div>` : '';
  const listHTML = (items, cls = '') => (items?.length
    ? `<ul class="dsm-list ${cls}">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  const pace = paceText(s.pace);
  return `<div class="dsm-detail">
    <div class="dsm-detail-head">
      <span class="dsm-ico" style="--dir-accent:${esc(pal.find((p) => p.key === s.defaultPalette)?.hex || '#8A8A8A')}">${esc(s.icon || '◇')}</span>
      <div><strong>${esc(s.label)}</strong><small>${esc(s.tagline || '')}</small></div>
      <span class="dsm-badge ${s.custom ? 'custom' : ''}">${s.custom ? '自定义' : '内置'}</span>
    </div>
    ${s.summary ? `<p class="dsm-summary">${esc(s.summary)}</p>` : ''}
    ${palHTML}
    <dl class="dsm-rows">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
      ${pace ? `<div><dt>节奏</dt><dd>${esc(pace)}${s.pace?.mode ? ` · ${esc(s.pace.mode)}` : ''}</dd></div>` : ''}</dl>
    ${s.medium?.length ? `<h4>自然媒介</h4>${listHTML(s.medium)}` : ''}
    ${s.taboos?.length ? `<h4>画面禁忌</h4>${listHTML(s.taboos)}` : ''}
    ${s.highlights?.length ? `<h4>高亮标签</h4><div class="dsm-chips">${s.highlights.map((h) => `<span>${esc(h)}</span>`).join('')}</div>` : ''}
    ${s.continuityRules?.length ? `<h4>连戏规则</h4>${listHTML(s.continuityRules)}` : ''}
    ${s.risks?.length ? `<h4>制作风险</h4>${listHTML(s.risks)}` : ''}
    <h4>出图提示词</h4>
    <div class="dsm-prompt"><b>正向</b><p>${esc(s.stylePrompt || '')}</p></div>
    ${s.negativePrompt ? `<div class="dsm-prompt"><b>负向</b><p>${esc(s.negativePrompt)}</p></div>` : ''}
  </div>`;
}

/* -------------------------------------------------------------------------- *
 * 管理页主体
 * -------------------------------------------------------------------------- */
export function openDirectorManager({ onChanged = null, onOpenChat = null, projectId = '' } = {}) {
  const page = openPage({
    title: '导演风格 · 统一管理',
    sub: '内置 + 自定义导演美学档案：点卡片看完整详情；自定义可删除；AI 设计师可对话生成新风格',
    variant: 'wide',
  });

  let styles = [];

  function cardHTML(s) {
    const pal = s.palettes || [];
    const accent = pal.find((p) => p.key === s.defaultPalette)?.hex || '#8A8A8A';
    return `<button type="button" class="dsm-card" data-id="${esc(s.id)}" style="--dir-accent:${esc(accent)}"
      title="${esc(s.label)} · ${esc(s.tagline || '')}">
      <span class="dsm-card-ico">${esc(s.icon || '◇')}</span>
      <strong class="dsm-card-name">${esc(s.workTitle || s.label)}</strong>
      <small class="dsm-card-sub">${esc(s.director || '')}</small>
      ${pal.length ? `<span class="dsm-card-dots">${pal.slice(0, 4).map((p) => `<i style="background:${esc(p.hex)}" title="${esc(p.name)}"></i>`).join('')}</span>` : ''}
      <em class="dsm-card-badge ${s.custom ? 'custom' : ''}">${s.custom ? '自定义' : '内置'}</em>
    </button>`;
  }

  function render() {
    const customs = styles.filter((x) => x.custom).length;
    page.content.innerHTML = `<div class="dsm-page">
      <div class="dsm-toolbar">
        <span>${styles.length} 位导演 · 其中自定义 ${customs} 位</span>
        <div class="dsm-toolbar-acts">
          <button class="btn primary" data-dsm="forge">✦ AI 新增导演风格</button>
        </div>
      </div>
      <div class="dsm-grid">${styles.map(cardHTML).join('')}</div>
      ${customs ? '<p class="dsm-note">自定义风格保存在 data/director-styles.json，项目技能面板与内置风格同等生效。</p>' : ''}
    </div>`;

    page.content.querySelectorAll('[data-dsm="forge"]').forEach((b) => b.addEventListener('click', () => {
      // AI 设计新风格：项目内走统一对话面板（风格档位，草稿随会话留存）
      if (onOpenChat && projectId) {
        onOpenChat('style');
        return;
      }
      // 无项目上下文（全局风格管理）时退回独立对话框
      openForgeChat({ onSaved: async () => { await refresh(); await onChanged?.(); } });
    }));
    page.content.querySelectorAll('.dsm-card').forEach((card) => card.addEventListener('click', () => {
      const s = styles.find((x) => x.id === card.dataset.id);
      if (!s) return;
      showPage({
        title: s.label,
        sub: `${s.tagline || ''} · ${s.custom ? '自定义档案' : '内置档案'}`,
        body: detailBody(s),
        actions: [
          ...(s.custom ? [{
            label: '🗑 删除该风格',
            onClick: async () => {
              // 二次确认：自定义风格删除后不可恢复（画布上已选它的项目会回退默认色）
              if (!window.confirm(`确定删除自定义风格「${s.label}」？此操作不可恢复。`)) return true;
              try {
                await request(`/api/director-styles/${encodeURIComponent(s.id)}`, undefined, 'DELETE');
                await refresh();
                await onChanged?.();
                return false; // 关闭详情页
              } catch (err) { window.alert(err.message); return true; }
            },
          }] : []),
          { label: '关闭', onClick: async () => false },
        ],
      });
    }));
  }

  async function refresh() {
    try {
      const d = await request('/api/director-styles');
      styles = d.styles || [];
      render();
    } catch (err) {
      page.content.innerHTML = `<div class="pv-empty">✗ ${esc(err.message)}</div>`;
    }
  }

  refresh();
}
