/* ============================================================================
 * 创作项目管理层前端：项目列表（搜索/筛选/排序/收藏/归档/更多操作）、
 * 六步任务面板（四态视觉提示 + 论文依据）、画布步骤导航条、项目管理面板。
 * 只负责 DOM 与交互；所有状态以 project.management / /api 返回为准。
 * ==========================================================================*/
const $ = (id) => document.getElementById(id);
const esc = (s = '') => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cut = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };
const fmtTime = (ts) => {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const fmtBytes = (b) => !b ? '—' : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;

async function api(path, body, method) {
  const res = await fetch(path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
  return data;
}

const STATUS_TEXT = {
  draft: '待执行', running: '进行中', done: '已完成', error: '失败',
  standard: '标准', pending: '待执行',
};
const filter = { mode: 'recent', query: '', view: 'all', sort: 'updated' };
export const getFilter = () => ({ ...filter });
export function setFilter(patch = {}) { Object.assign(filter, patch); }

const RECENT_MAX = 5;
/* 项目配置按钮：齿轮图标，16px 线条在 30px 按钮里清晰可辨 */
const GEAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

/* ------------------------------------------------------------------ 项目封面渲染（模块级共用：卡片 / 设置弹窗 / 管理面板概览）
 * 无封面时的「项目名称封面」：按名称散列取色，稳定且可辨识。 */
function nameCoverHTML(p) {
  const name = String(p.name || '未命名项目');
  const first = Array.from(name)[0] || '项';
  const hue = Array.from(name).reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return `<span class="pm-thumb-name" style="--pm-hue:${hue}"><b>${esc(first)}</b><small>${esc(cut(name, 5))}</small></span>`;
}
/** 取项目封面：兼容列表索引（顶层 cover）与完整项目（management.cover）两种数据源 */
function readCover(p) {
  return p?.cover || p?.management?.cover || { url: '', source: 'name', prompt: '', updatedAt: 0 };
}
/** 卡片/概览用的封面缩略图；asButton=false 时渲染为不可点击的纯展示块 */
function coverThumbHTML(p, asButton = true) {
  const cover = readCover(p);
  const url = cover.url;
  const badge = url ? `<span class="pm-thumb-badge">${cover.source === 'comfyui' ? '✦ AI' : '⇧ 上传'}</span>` : '';
  const inner = url ? `<img src="${esc(url)}" alt="" loading="lazy">` : nameCoverHTML(p);
  if (!asButton) return `<div class="pm-thumb is-static ${url ? 'has-img' : 'is-name'}">${inner}${badge}</div>`;
  return `<button class="pm-thumb ${url ? 'has-img' : 'is-name'}" data-open="${esc(p.id)}" title="打开「${esc(p.name)}」" aria-label="打开项目">${inner}${badge}</button>`;
}

/* ------------------------------------------------------------------ 侧栏项目列表：最近项目 + 更多 */
export function renderProjectList(host, ctx = {}) {
  if (!host) return;
  const all = ctx.projects || [];
  const total = all.length;
  const moreMode = filter.mode === 'all';
  host.innerHTML = `
    <div class="pm-head">
      <strong class="pm-head-title">${moreMode ? '全部项目' : '最近项目'}</strong>
      ${moreMode
        ? `<button class="pm-browse" id="pm-back" title="返回最近项目">← 最近项目</button>`
        : `<button class="pm-browse" id="pm-browse" title="搜索、筛选与排序全部项目">更多 <span class="pm-count">${total}</span> ›</button>`}
    </div>
    ${moreMode ? `
    <div class="pm-tools">
      <input id="pm-search" class="pm-search" type="search" placeholder="搜索项目 / 标签…" value="${esc(filter.query)}" aria-label="搜索项目">
      <select id="pm-sort" class="pm-sort" aria-label="排序">
        <option value="updated" ${filter.sort === 'updated' ? 'selected' : ''}>最近更新</option>
        <option value="name" ${filter.sort === 'name' ? 'selected' : ''}>名称</option>
        <option value="progress" ${filter.sort === 'progress' ? 'selected' : ''}>进度</option>
        <option value="created" ${filter.sort === 'created' ? 'selected' : ''}>创建时间</option>
      </select>
    </div>
    <div class="pm-filters" id="pm-filters"></div>` : ''}
    <div id="pm-list" class="pm-list"></div>`;

  $('pm-browse')?.addEventListener('click', () => {
    filter.mode = 'all';
    renderProjectList(host, ctx);
  });
  $('pm-back')?.addEventListener('click', () => {
    filter.mode = 'recent'; filter.query = ''; filter.view = 'all';
    renderProjectList(host, ctx);
  });
  if (moreMode) {
    $('pm-search').addEventListener('input', (e) => { filter.query = e.target.value; renderItems(); });
    $('pm-sort').addEventListener('change', (e) => { filter.sort = e.target.value; renderItems(); });
    renderFilters();
  }
  renderItems();

  function renderFilters() {
    const views = [['all', '全部'], ['novel', '创作项目'], ['running', '进行中'], ['done', '已完成'], ['favorite', '★ 收藏'], ['archived', '已归档']];
    $('pm-filters').innerHTML = views.map(([v, label]) => `<button class="pm-chip ${filter.view === v ? 'active' : ''}" data-view="${v}">${label}</button>`).join('');
    $('pm-filters').querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
      filter.view = b.dataset.view; renderFilters(); renderItems();
    }));
  }

  function visible() {
    const q = filter.query.trim().toLowerCase();
    let list = all.filter((p) => {
      if (filter.view === 'all' && p.archived) return false;
      if (filter.view === 'archived' && !p.archived) return false;
      if (filter.view === 'novel' && p.kind !== 'novel') return false;
      if (filter.view === 'running' && p.status !== 'running') return false;
      if (filter.view === 'done' && p.status !== 'done') return false;
      if (filter.view === 'favorite' && !p.favorite) return false;
      if (!q) return true;
      return `${p.name} ${(p.tags || []).join(' ')} ${p.mode || ''}`.toLowerCase().includes(q);
    });
    const cmp = {
      updated: (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
      created: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
      name: (a, b) => String(a.name).localeCompare(String(b.name), 'zh'),
      progress: (a, b) => (b.progress || 0) - (a.progress || 0),
    }[filter.sort] || ((a, b) => b.updatedAt - a.updatedAt);
    return list.sort(cmp);
  }

  /** 最近项目：按更新时间取前 N 个，保证当前打开的项目可见 */
  function recent() {
    const live = all.filter((p) => !p.archived);
    const top = [...live].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, RECENT_MAX);
    const cur = live.find((p) => p.id === ctx.currentId);
    if (cur && !top.some((p) => p.id === cur.id)) top.unshift(cur);
    return top;
  }

  function cardHTML(p) {
    const isNovel = p.kind === 'novel';
    const pct = isNovel ? (p.progress || 0) : (p.nodeCount ? Math.round(p.doneCount / p.nodeCount * 100) : 0);
    const meta = isNovel
      ? `${p.episodeCount || 0} 集 · 任务 ${p.stepDone ?? 0}/${p.stepTotal ?? 6}`
      : `${p.nodeCount || 0} 节点 · ${p.doneCount || 0} 已完成`;
    return `<div class="pm-item ${p.id === ctx.currentId ? 'active' : ''} ${p.archived ? 'is-archived' : ''}" data-id="${esc(p.id)}">
      ${coverThumbHTML(p)}
      <div class="pm-card-main">
      <div class="pm-item-top">
        <button class="pm-open" data-open="${esc(p.id)}">
          <span class="pm-name">${p.favorite ? '<span class="pm-star">★</span>' : ''}${esc(p.name)}</span>
        </button>
        <button class="pm-more" data-more="${esc(p.id)}" title="项目配置与管理操作" aria-label="项目配置">${GEAR_SVG}</button>
      </div>
      <div class="pm-item-meta">
        <span class="pm-status st-${esc(p.status)}"><i></i>${esc(STATUS_TEXT[p.status] || p.status)}</span>
        ${isNovel ? '<span class="pm-kind">小说分集</span>' : ''}
        <span class="pm-sub">${esc(meta)}</span>
      </div>
      <div class="pm-bar"><span class="pm-bar-track"><i class="st-${esc(p.status)}" style="width:${pct}%"></i></span><em class="st-${esc(p.status)}">${pct}%</em></div>
      ${(p.tags || []).length ? `<div class="pm-tags">${p.tags.slice(0, 3).map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="pm-menu" data-menu="${esc(p.id)}" hidden>
        <button data-op="cover">🖼 设置项目封面</button>
        <button data-op="favorite">${p.favorite ? '☆ 取消收藏' : '★ 加入收藏'}</button>
        <button data-op="rename">✎ 重命名</button>
        <button data-op="tags">🏷 编辑标签</button>
        <button data-op="duplicate">⧉ 复制项目</button>
        <button data-op="export">⇩ 导出 JSON</button>
        <button data-op="archive">${p.archived ? '↩ 取消归档' : '▣ 归档'}</button>
        <div class="pm-menu-sep"></div>
        <button data-op="delete" class="danger">✕ 删除项目</button>
      </div>
    </div>`;
  }

  function renderItems() {
    const box = $('pm-list');
    if (!box) return;
    const list = moreMode ? visible() : recent();
    if (!list.length) {
      box.innerHTML = moreMode
        ? `<div class="pm-empty">没有匹配的项目<br><small>试试切换筛选，或点上方「＋ 新建创作项目」</small></div>`
        : `<div class="pm-empty">还没有项目<br><small>点上方「＋ 新建创作项目」开始创作</small></div>`;
      return;
    }
    box.innerHTML = list.map(cardHTML).join('');

    box.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', (e) => {
      if (e.target.closest('[data-more]') || e.target.closest('[data-menu]')) return;
      ctx.onOpen?.(el.dataset.open);
    }));
    box.querySelectorAll('[data-more]').forEach((btn) => btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = box.querySelector(`[data-menu="${btn.dataset.more}"]`);
      const wasOpen = !menu.hidden;
      box.querySelectorAll('.pm-menu').forEach((m) => { m.hidden = true; });
      menu.hidden = wasOpen;
    }));
    box.querySelectorAll('.pm-menu button').forEach((btn) => btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.closest('[data-menu]').dataset.menu;
      const op = btn.dataset.op;
      btn.closest('[data-menu]').hidden = true;
      await doListAction(op, id);
    }));
    document.addEventListener('pointerdown', closeMenus, { once: true });
  }

  function closeMenus(e) {
    if (!e.target.closest?.('.pm-menu') && !e.target.closest?.('[data-more]')) {
      $('pm-list')?.querySelectorAll('.pm-menu').forEach((m) => { m.hidden = true; });
    } else document.addEventListener('pointerdown', closeMenus, { once: true });
  }

  async function doListAction(op, id) {
    const p = (ctx.projects || []).find((x) => x.id === id);
    const toast = ctx.toast || (() => {});
    try {
      if (op === 'delete') {
        if (!window.confirm(`确定删除「${p?.name || id}」？此操作不可撤销。`)) return;
        await api(`/api/projects/${id}`, undefined, 'DELETE');
        toast('项目已删除', 'ok');
      } else if (op === 'cover') {
        openCoverDialog({ project: p, toast, onChanged: ctx.onChanged, comfy: ctx.comfy });
        return;
      } else if (op === 'rename') {
        const name = window.prompt('项目名称', p?.name || '');
        if (!name || !name.trim()) return;
        await api(`/api/projects/${id}/manage`, { action: 'rename', value: name.trim() });
        toast('已重命名', 'ok');
      } else if (op === 'tags') {
        const value = window.prompt('标签（逗号分隔，最多 8 个）', (p?.tags || []).join(', '));
        if (value === null) return;
        await api(`/api/projects/${id}/manage`, { action: 'tags', value });
        toast('标签已更新', 'ok');
      } else if (op === 'duplicate') {
        await api(`/api/projects/${id}/duplicate`, {});
        toast('已复制项目副本', 'ok');
      } else if (op === 'export') {
        const data = await api(`/api/projects/${id}/export`);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        a.download = `${p?.name || 'project'}.json`; a.click(); URL.revokeObjectURL(a.href);
        toast('项目 JSON 已导出', 'ok');
      } else {
        await api(`/api/projects/${id}/manage`, { action: op, value: undefined });
        toast(op === 'favorite' ? '收藏状态已更新' : op === 'archive' ? '归档状态已更新' : '已更新', 'ok');
      }
      await ctx.onChanged?.();
    } catch (err) { toast(err.message, 'err'); }
  }
}

/* ------------------------------------------------------------------ 项目封面设置弹窗
 * 三种来源：ComfyUI 出图生成 / 本地上传 / 清除后回退「项目名称封面」。
 * 卡片缩略图与这里共用同一套 nameCoverHTML 渲染，视觉一致。
 * ---------------------------------------------------------------- */
export function openCoverDialog(ctx = {}) {
  const p = ctx.project;
  if (!p) return;
  const root = $('modal-root') || document.body;
  const toast = ctx.toast || (() => {});
  let cover = { ...readCover(p) };
  let busy = false;
  let message = '';
  /** 同步到列表索引与完整项目两处，避免弹窗关闭后卡片短暂回退 */
  const applyCover = (next) => {
    cover = { ...next };
    p.cover = cover;
    if (p.management) p.management.cover = cover;
  };
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const close = () => { if (!busy) backdrop.remove(); };
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(); });

  const sourceLabel = () => cover.source === 'comfyui' ? '✦ ComfyUI 生成'
    : cover.source === 'upload' ? '⇧ 本地上传' : '项目名称封面（默认）';

  function render() {
    const preview = cover.url
      ? `<img src="${esc(cover.url)}?t=${encodeURIComponent(String(cover.updatedAt || ''))}" alt="项目封面">`
      : nameCoverHTML({ name: p.name });
    backdrop.innerHTML = `<div class="modal cover-modal" role="dialog" aria-label="项目封面设置">
      <div class="pmm-head"><div><h2>🖼 项目封面</h2><div class="sub">${esc(p.name)} · ${esc(sourceLabel())}</div></div>
        <button class="icon-btn" data-act="close" ${busy ? 'disabled' : ''} aria-label="关闭">✕</button></div>
      <div class="cover-body">
        <div class="cover-preview">${preview}
          ${busy ? '<div class="cover-busy"><span class="cover-spinner"></span><b>ComfyUI 正在生成封面</b><small>约 1–2 分钟，请勿关闭窗口</small></div>' : ''}
        </div>
        <div class="cover-side">
          <p class="cover-tip">未设置封面时，项目卡片会自动使用<b>项目名称封面</b>（按名称生成的渐变色块）。<br>
            生成封面会调用已配置的 ComfyUI 出图工作流；上传支持 PNG / JPEG / WebP / GIF，单张不超过 4 MB。</p>
          <label class="field"><span>补充画面要求（可选）</span>
            <input id="cover-prompt" placeholder="如：雨夜霓虹、水墨风、暖色调电影海报…" value="${esc(cover.prompt || '')}"></label>
          <div class="cover-actions">
            <button class="btn primary" data-act="generate" ${busy ? 'disabled' : ''}>✦ 用 ComfyUI 生成封面</button>
            <button class="btn" data-act="upload" ${busy ? 'disabled' : ''}>⇧ 上传本地图片</button>
            <button class="btn" data-act="reset" ${busy || !cover.url ? 'disabled' : ''}>↺ 使用项目名称封面</button>
          </div>
          ${message ? `<div class="cover-status ${message.startsWith('✗') ? 'err' : ''}">${esc(message)}</div>` : ''}
          <div class="cover-note">${ctx.comfy?.imageWorkflow ? '✓ 已检测到 ComfyUI 出图工作流' : '⚠ 未检测到 ComfyUI 出图工作流，生成前请先在设置中导入'}</div>
          <input type="file" id="cover-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
        </div>
      </div>
      <div class="modal-actions"><button class="btn" data-act="close" ${busy ? 'disabled' : ''}>关闭</button></div>
    </div>`;

    backdrop.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener('click', close));
    const promptInput = $('cover-prompt');

    backdrop.querySelector('[data-act="generate"]')?.addEventListener('click', async () => {
      if (busy) return;
      const prompt = promptInput?.value || '';
      busy = true; message = ''; render();
      try {
        const d = await api(`/api/projects/${p.id}/cover/generate`, { prompt });
        applyCover(d.cover);
        const secs = d.durationMs ? ` · ${(d.durationMs / 1000).toFixed(1)}s` : '';
        message = `✓ 封面已由 ComfyUI 生成${secs}`;
        toast('项目封面已生成', 'ok');
        await ctx.onChanged?.();
      } catch (err) { message = `✗ ${err.message}`; toast(err.message, 'err'); }
      busy = false; render();
    });

    const fileInput = $('cover-file');
    backdrop.querySelector('[data-act="upload"]')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', async () => {
      if (busy) return;
      const file = fileInput.files?.[0];
      if (!file) return;
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { message = '✗ 仅支持 PNG / JPEG / WebP / GIF 图片'; render(); return; }
      if (file.size > 4 * 1024 * 1024) { message = '✗ 图片超过 4 MB，请压缩后再上传'; render(); return; }
      busy = true; message = '正在上传封面…'; render();
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error('读取图片失败'));
          reader.readAsDataURL(file);
        });
        const d = await api(`/api/projects/${p.id}/cover`, { dataUrl });
        applyCover(d.cover);
        message = '✓ 封面图片已上传';
        toast('项目封面已上传', 'ok');
        await ctx.onChanged?.();
      } catch (err) { message = `✗ ${err.message}`; toast(err.message, 'err'); }
      busy = false; render();
      fileInput.value = '';
    });

    backdrop.querySelector('[data-act="reset"]')?.addEventListener('click', async () => {
      if (busy || !cover.url) return;
      busy = true; message = ''; render();
      try {
        const d = await api(`/api/projects/${p.id}/cover`, undefined, 'DELETE');
        applyCover(d.cover);
        message = '✓ 已恢复为项目名称封面';
        toast(message, 'ok');
        await ctx.onChanged?.();
      } catch (err) { message = `✗ ${err.message}`; toast(err.message, 'err'); }
      busy = false; render();
    });
  }

  root.appendChild(backdrop);
  render();
  return { close };
}

/* ------------------------------------------------------------------ 六步任务面板 */
let expandedStep = null;
/** 执行新步骤前由 app.js 调用，让详情卡自动跟随正在执行的那一步 */
export function setExpandedStep(id) { expandedStep = id; }
export function renderStepPanel(host, ctx = {}) {
  if (!host) return;
  const project = ctx.project;
  const steps = ctx.steps || [];
  const m = project?.management;
  if (!project || !m) { host.innerHTML = '<div class="insp-placeholder"><span class="big">◈</span>请先打开一个项目</div>'; return; }
  if (m.kind !== 'novel') {
    host.innerHTML = `<div class="insp-placeholder"><span class="big">▤</span>这是标准流水线项目<br><small>点顶栏「▶ 运行完整流水线」，画布会随智能体自动生长；<br>六步任务清单仅用于上传小说新建的创作项目。</small>
      <button class="btn primary" id="sp-create" style="margin-top:14px">＋ 新建创作项目</button></div>`;
    $('sp-create')?.addEventListener('click', () => ctx.onCreate?.());
    return;
  }
  const states = Object.fromEntries((m.steps || []).map((s) => [s.id, s]));
  const done = (m.steps || []).filter((s) => s.status === 'done').length;
  const total = steps.length || 6;
  const running = (m.steps || []).some((s) => s.status === 'running');
  const failed = (m.steps || []).some((s) => s.status === 'error');
  const overall = failed ? 'error' : running ? 'running' : done === total ? 'done' : 'draft';
  const current = (m.steps || []).find((s) => s.status === 'running') || (m.steps || []).find((s) => s.status === 'pending');
  if (!expandedStep || !states[expandedStep]) expandedStep = current?.id || null;

  host.innerHTML = `
    <div class="sp-head">
      <div class="sp-head-row"><strong>任务执行步骤</strong><span class="sp-counter">${done}/${total}</span></div>
      <div class="sp-progress"><i class="st-${overall}" style="width:${Math.round(done / total * 100)}%"></i></div>
      <div class="sp-status st-${overall}"><span class="sp-status-dot"></span>${esc(STATUS_TEXT[overall] || overall)}${running ? ' · 画布节点正在生长' : ''}</div>
      <div class="sp-legend"><span class="lg pending">灰 · 待执行</span><span class="lg running">橙 + 呼吸 · 进行中</span><span class="lg done">绿 ✓ · 完成</span><span class="lg error">红 · 失败可重试</span></div>
    </div>
    <div class="sp-list">${steps.map((def) => {
      const st = states[def.id] || { status: def.auto ? 'done' : 'pending' };
      const isCur = current?.id === def.id && st.status !== 'done';
      const open = expandedStep === def.id;
      const badge = st.status === 'done' ? `✓ ${st.durationMs ? (st.durationMs / 1000).toFixed(1) + 's' : '已完成'}`
        : st.status === 'running' ? '进行中…' : st.status === 'error' ? '失败 · 重试' : isCur ? '下一步' : '待执行';
      return `<div class="sp-step st-${esc(st.status)} ${isCur ? 'current' : ''} ${open ? 'open' : ''}" data-step="${esc(def.id)}">
        <div class="sp-row" data-toggle="${esc(def.id)}">
          <span class="sp-no">${st.status === 'done' ? '✓' : def.no}</span>
          <span class="sp-icon">${def.icon}</span>
          <span class="sp-txt"><strong>${esc(def.title)}</strong><small>${esc(def.short)}</small></span>
          <span class="sp-badge">${esc(badge)}</span>
        </div>
        ${open ? `<div class="sp-detail">
          <p class="sp-desc">${esc(def.desc)}</p>
          ${st.note ? `<div class="sp-note ${st.status === 'error' ? 'err' : ''}">${esc(st.note)}</div>` : ''}
          <div class="sp-checks"><b>完成检查</b>${def.checklist.map((c) => `<span>○ ${esc(c)}</span>`).join('')}</div>
          <div class="sp-theory"><b>论文依据 · ${esc(def.theory.ref)}</b><p>${esc(def.theory.text)}</p>
            <div class="sp-map">${def.theory.map.map(([k, v]) => `<span><em>${esc(k)}</em>${esc(v)}</span>`).join('')}</div></div>
          <div class="sp-actions">
            ${st.status !== 'done' ? `<button class="btn primary" data-run="${esc(def.id)}" ${ctx.busy ? 'disabled' : ''}>${st.status === 'error' ? '↻ 重试本步' : '▶ 执行本步'}</button>` : ''}
            <button class="btn" data-focus="${esc(def.id)}">⌖ 查看画布节点</button>
            ${st.status === 'done' && !def.auto ? `<button class="btn" data-reset="${esc(def.id)}">重置状态</button>` : ''}
          </div>
        </div>` : ''}
      </div>`;
    }).join('')}</div>
    <div class="sp-foot">
      <button class="btn primary" id="sp-next" ${(ctx.busy || done === total) ? 'disabled' : ''}>${ctx.busy ? '执行中…' : '▶ 执行下一步'}</button>
      <button class="btn" id="sp-all" ${(ctx.busy || done === total) ? 'disabled' : ''}>⏩ 全部执行</button>
      <button class="btn" id="sp-manage">▦ 项目管理</button>
      <button class="btn" id="sp-reset-all">↺ 重置六步</button>
    </div>`;

  host.querySelectorAll('[data-toggle]').forEach((el) => el.addEventListener('click', () => {
    expandedStep = expandedStep === el.dataset.toggle ? null : el.dataset.toggle;
    renderStepPanel(host, ctx);
  }));
  host.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', () => ctx.onRunStep?.(b.dataset.run, false)));
  host.querySelectorAll('[data-focus]').forEach((b) => b.addEventListener('click', () => ctx.onFocus?.(b.dataset.focus)));
  host.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', () => ctx.onReset?.(b.dataset.reset)));
  $('sp-next')?.addEventListener('click', () => ctx.onRunStep?.(current?.id, false));
  $('sp-all')?.addEventListener('click', () => ctx.onRunStep?.(null, true));
  $('sp-manage')?.addEventListener('click', () => ctx.onManage?.());
  $('sp-reset-all')?.addEventListener('click', () => ctx.onReset?.(null));
}

/* ------------------------------------------------------------------ 画布上方步骤导航条 */
export function renderCanvasStepBar(host, ctx = {}) {
  if (!host) return;
  const m = ctx.project?.management;
  const steps = ctx.steps || [];
  if (!m || m.kind !== 'novel') { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;
  const states = Object.fromEntries((m.steps || []).map((s) => [s.id, s]));
  const done = (m.steps || []).filter((s) => s.status === 'done').length;
  host.innerHTML = `<span class="csb-label">六步任务</span>
    ${steps.map((s) => {
      const st = states[s.id]?.status || 'pending';
      return `<button class="csb-step st-${esc(st)}" data-jump="${esc(s.id)}" title="${esc(s.title)} · ${esc(s.theory.ref)}">
        <span class="csb-no">${st === 'done' ? '✓' : s.no}</span><span class="csb-name">${esc(cut(s.short, 10))}</span></button>`;
    }).join('')}
    <span class="csb-count">${done}/${steps.length}</span>`;
  host.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => ctx.onJump?.(b.dataset.jump)));
}

/* ------------------------------------------------------------------ 项目管理面板 */
export function openProjectManager(ctx = {}) {
  const toast = ctx.toast || (() => {});
  const root = $('modal-root');
  let tab = 'overview';
  let snapshots = [];
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const close = () => { backdrop.remove(); ctx.onClose?.(); };
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(); });

  async function refresh(keepTab = true) {
    try {
      const d = await api(`/api/projects/${ctx.project.id}/manage`);
      ctx.project.management = d.management; ctx.stats = d.stats; ctx.progress = d.progress;
      const s = await api(`/api/projects/${ctx.project.id}/snapshots`);
      snapshots = s.snapshots || [];
      if (!keepTab) tab = 'overview';
      render();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function manage(action, value, msg) {
    try {
      const d = await api(`/api/projects/${ctx.project.id}/manage`, { action, value });
      if (action === 'rename') ctx.project.name = String(value || '').trim() || ctx.project.name;
      if (msg !== false) toast(d.message || '已更新', 'ok');
      await refresh();
      await ctx.onChanged?.();
      return d;
    } catch (e) { toast(e.message, 'err'); return null; }
  }

  function render() {
    const p = ctx.project;
    const m = p.management || {};
    const s = ctx.stats || {};
    const prog = ctx.progress || { label: `${(m.steps || []).filter((x) => x.status === 'done').length}/6`, percent: 0 };
    backdrop.innerHTML = `<div class="modal pm-modal" role="dialog" aria-label="项目管理">
      <div class="pmm-head"><div><h2>▦ 项目管理</h2><div class="sub">${esc(p.name)} · ${m.kind === 'novel' ? '小说分集创作项目' : '标准流水线项目'} · 六步 ${esc(prog.label)}</div></div>
        <button class="icon-btn" data-act="close">✕</button></div>
      <div class="pmm-tabs">${[['overview', '概览'], ['episodes', '分集'], ['deliverables', '产物'], ['versions', '版本 / 记录']].map(([k, label]) => `<button class="pmm-tab ${tab === k ? 'active' : ''}" data-tab="${k}">${label}</button>`).join('')}</div>
      <div class="pmm-body" id="pmm-body"></div>
      <div class="modal-actions"><button class="btn" data-act="close">关闭</button></div>
    </div>`;
    backdrop.querySelector('[data-act="close"]').addEventListener('click', close);
    backdrop.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener('click', close));
    backdrop.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; render(); }));
    const body = $('pmm-body');
    if (tab === 'overview') renderOverview(body, m, s, prog);
    if (tab === 'episodes') renderEpisodes(body, m);
    if (tab === 'deliverables') renderDeliverables(body, m, s);
    if (tab === 'versions') renderVersions(body, p, s);
  }

  function renderOverview(body, m, s, prog) {
    const cover = readCover(ctx.project);
    const coverLabel = cover.source === 'comfyui' ? '✦ ComfyUI 生成封面'
      : cover.source === 'upload' ? '⇧ 本地上传封面' : '项目名称封面（默认）';
    body.innerHTML = `
      <div class="pmm-grid">
        <div class="pmm-stat"><b>${s.nodeCount || 0}</b><span>画布节点</span></div>
        <div class="pmm-stat"><b>${s.edgeCount || 0}</b><span>连线</span></div>
        <div class="pmm-stat"><b>${s.shotCount || 0}</b><span>镜头</span></div>
        <div class="pmm-stat"><b>${s.anchorCount || 0}</b><span>视觉锚点</span></div>
        <div class="pmm-stat"><b>${m.episodes?.length || 0}</b><span>分集</span></div>
        <div class="pmm-stat"><b>${prog.percent || 0}%</b><span>六步进度</span></div>
      </div>
      <div class="cf-section"><h4>项目封面</h4>
        <div class="cover-mgr">
          ${coverThumbHTML(ctx.project, false)}
          <div class="cover-mgr-info">
            <div class="cf-note" style="margin:0 0 8px">当前：<b>${esc(coverLabel)}</b><br>未设置封面时，项目卡片会自动使用项目名称封面；可用 ComfyUI 生成或上传本地图片。</div>
            <button class="btn primary" data-act="set-cover">🖼 设置项目封面</button>
          </div>
        </div>
      </div>
      <div class="cf-section"><h4>基本信息</h4>
        <div class="modal-grid">
          <div class="field"><label>项目名称</label><input id="pmm-name" value="${esc(ctx.project.name)}"></div>
          <div class="field"><label>标签（逗号分隔）</label><input id="pmm-tags" value="${esc((m.tags || []).join(', '))}"></div>
          <div class="field" style="grid-column:1/-1"><label>项目备注</label><textarea id="pmm-note" rows="2" placeholder="改编方向、角色设定、交付备注…">${esc(m.note || '')}</textarea></div>
        </div>
        <div class="cf-row"><button class="btn primary" data-act="save-basic">保存基本信息</button>
          <button class="btn" data-act="favorite">${m.favorite ? '☆ 取消收藏' : '★ 加入收藏'}</button>
          <button class="btn" data-act="archive">${m.archived ? '↩ 取消归档' : '▣ 归档项目'}</button>
          <span class="cf-note" style="margin:0">创建 ${fmtTime(m.createdAt)} · 更新 ${fmtTime(m.updatedAt)} · 版本 ${m.version || 1}</span></div>
      </div>
      ${m.kind === 'novel' ? `<div class="cf-section"><h4>分集参数与理论默认值</h4>
        <div class="modal-grid">
          <div class="field"><label>策略</label><select id="pmm-strategy">${[['chapter', '按章节'], ['fixed', '按字数'], ['scene', '按场景段落']].map(([v, l]) => `<option value="${v}" ${m.split?.strategy === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label>每集目标字数</label><input id="pmm-target" type="number" min="300" max="8000" value="${m.split?.targetChars || 1200}"></div>
          <div class="field"><label>最多集数</label><input id="pmm-max" type="number" min="1" max="12" value="${m.split?.maxEpisodes || 4}"></div>
          <div class="field"><label>原著</label><input value="${esc(m.source?.filename || '粘贴文本')} · ${m.source?.totalChars || 0} 字 · ${m.source?.chapterCount || 0} 章" readonly></div>
        </div>
        <div class="cf-row"><button class="btn" data-act="save-split">保存参数</button><button class="btn primary" data-act="resplit">↻ 按新参数重新分集（第 ② 步）</button></div>
        <div class="cf-note">论文默认值已固化：best-of-k <code>2</code>（RQ6）· 视觉锚点必选（移除 GC −8.7%）· VLM 择优（−3.8%）· RAG 与事件链不可关（NF 3.52→3.14 / 2.34）。详见 <code>docs/THEORY.md</code>。</div>
      </div>` : ''}
      <div class="cf-section"><h4>近期操作</h4><div class="pmm-history">${(m.history || []).slice(0, 8).map((h) => `<div><span>${fmtTime(h.at)}</span><b>${esc(h.action)}</b><span>${esc(cut(h.detail, 46))}</span></div>`).join('') || '<div>暂无记录</div>'}</div></div>`;
    body.querySelector('[data-act="save-basic"]').addEventListener('click', async () => {
      await manage('rename', $('pmm-name').value, false);
      await manage('tags', $('pmm-tags').value, false);
      await manage('note', $('pmm-note').value, false);
      toast('基本信息已保存', 'ok');
    });
    body.querySelector('[data-act="set-cover"]').addEventListener('click', () => {
      openCoverDialog({ project: ctx.project, toast, comfy: ctx.comfy, onChanged: ctx.onChanged });
    });
    body.querySelector('[data-act="favorite"]').addEventListener('click', () => manage('favorite'));
    body.querySelector('[data-act="archive"]').addEventListener('click', () => manage('archive'));
    const saveSplit = body.querySelector('[data-act="save-split"]');
    if (saveSplit) {
      saveSplit.addEventListener('click', () => manage('split', {
        strategy: $('pmm-strategy').value, targetChars: Number($('pmm-target').value), maxEpisodes: Number($('pmm-max').value),
      }));
      body.querySelector('[data-act="resplit"]').addEventListener('click', async () => {
        await manage('split', {
          strategy: $('pmm-strategy').value, targetChars: Number($('pmm-target').value), maxEpisodes: Number($('pmm-max').value),
        }, false);
        toast('正在重新分集…', 'ok');
        await ctx.onRunStep?.('episodes', false);
        await refresh();
      });
    }
  }

  function renderEpisodes(body, m) {
    if (m.kind !== 'novel') { body.innerHTML = '<div class="pmm-empty">标准项目没有分集数据</div>'; return; }
    body.innerHTML = `<div class="pmm-section-head"><strong>分集表 · ${m.episodes?.length || 0} 集</strong><span>来自 ${esc(m.source?.filename || '粘贴文本')} · 共 ${m.source?.totalChars || 0} 字</span></div>
      <div class="pmm-eps">${(m.episodes || []).map((e) => `<div class="pmm-ep">
        <span class="pmm-ep-no">${e.no}</span>
        <span class="pmm-ep-main"><strong>${esc(e.title)}</strong><small>${esc(e.summary)}</small><em>结尾钩子：${esc(e.hook)}</em><span class="pmm-ep-src">来源：${esc((e.sourceTitles || []).join(' / '))}</span></span>
        <span class="pmm-ep-chars">${e.chars} 字</span></div>`).join('')}</div>
      <div class="cf-note">每集在无限画布上对应一个 <code>episode</code> 节点，并以 <code>ref</code> 边把本集梗概传给剧本节点；原著全文由 RAG 节点索引（式(6)）。</div>`;
  }

  function renderDeliverables(body, m, s) {
    const d = m.deliverables || { video: true, pack: true };
    body.innerHTML = `<div class="cf-section"><h4>交付物开关</h4>
      <div class="cf-row">
        <label class="cf-check"><input type="checkbox" id="pmm-d-video" ${d.video ? 'checked' : ''}> 成片视频（MP4 / 逐镜头预览）</label>
        <label class="cf-check"><input type="checkbox" id="pmm-d-pack" ${d.pack ? 'checked' : ''}> 导演包（*.mmxpack.zip）</label>
        <button class="btn" data-act="save-deliver">保存</button></div>
      <div class="cf-note">修改后重新执行第 ⑥ 步生效；「只导出导演包」会跳过本地视频渲染。</div></div>
      <div class="cf-section"><h4>产物</h4>
        <div class="deliver-item"><strong>① 导演包 ${s.pack ? `<span class="tag-ok">已生成</span>` : '<span class="tag-wait">未生成</span>'}</strong>
          <div class="cf-note">${s.pack ? `${esc(s.pack.filename)} · ${fmtBytes(s.pack.bytes)} · ${s.pack.fileCount || '—'} 文件` : '执行第 ⑥ 步后生成，可导入 ComfyUI MiniMax H3 Director'}</div>
          <div class="insp-actions"><button class="btn" data-act="regen-pack">↻ 重新打包</button><button class="btn primary" data-act="dl-pack" ${s.pack ? '' : 'disabled'}>⇩ 下载导演包</button></div></div>
        <div class="deliver-item"><strong>② 成片视频 ${s.film ? '<span class="tag-ok">已生成</span>' : '<span class="tag-wait">预览态</span>'}</strong>
          <div class="cf-note">${s.film ? `${esc(s.film.file)} · ${fmtBytes(s.film.bytes)}` : 'Mock 模式为分镜帧序列预览；接入 ComfyUI 视频工作流后由 ffmpeg 拼成 MP4，不会伪造视频文件'}</div>
          <div class="insp-actions"><button class="btn primary" data-act="dl-film" ${s.film ? '' : 'disabled'}>⇩ 下载成片 MP4</button></div></div>
      </div>
      <div class="cf-section"><h4>产物统计</h4><div class="pmm-grid">
        <div class="pmm-stat"><b>${s.videoCount || 0}</b><span>视频片段</span></div>
        <div class="pmm-stat"><b>${s.refCount || 0}</b><span>资产引用</span></div>
        <div class="pmm-stat"><b>${s.doneNodes || 0}/${s.nodeCount || 0}</b><span>节点完成</span></div>
        <div class="pmm-stat"><b>${s.errorNodes || 0}</b><span>失败节点</span></div></div></div>`;
    body.querySelector('[data-act="save-deliver"]').addEventListener('click', () => manage('deliverables', {
      video: $('pmm-d-video').checked, pack: $('pmm-d-pack').checked,
    }));
    body.querySelector('[data-act="regen-pack"]').addEventListener('click', async () => {
      try { await api(`/api/projects/${ctx.project.id}/director-pack`, {}); toast('导演包已按当前画布重新生成', 'ok'); await refresh(); await ctx.onChanged?.(); }
      catch (e) { toast(e.message, 'err'); }
    });
    body.querySelector('[data-act="dl-pack"]').addEventListener('click', () => ctx.onDownload?.('pack'));
    body.querySelector('[data-act="dl-film"]').addEventListener('click', () => ctx.onDownload?.('film'));
  }

  function renderVersions(body, p, s) {
    body.innerHTML = `<div class="cf-section"><h4>项目快照</h4>
      <div class="cf-row"><button class="btn primary" data-act="snapshot">＋ 创建快照</button><span class="cf-note" style="margin:0">恢复前会自动为当前状态再存一个安全点</span></div>
      <div class="pmm-snaps">${snapshots.length ? snapshots.map((x) => `<div><span>${fmtTime(x.at)}</span><b>${x.nodeCount} 节点</b><span>${fmtBytes(x.size)}</span><button class="btn" data-restore="${x.at}">恢复</button></div>`).join('') : '<div class="pmm-empty">暂无快照</div>'}</div></div>
      <div class="cf-section"><h4>运行记录（最近 ${s.runCount || 0} 次）</h4>
        <div class="pmm-snaps">${(p.runs || []).slice(0, 8).map((r) => `<div><span>${fmtTime(r.finishedAt)}</span><b>${r.nodeCount} 节点 / ${r.waves} 波</b><span>${((r.durationMs || 0) / 1000).toFixed(1)}s · ${esc(r.status)}</span></div>`).join('') || '<div class="pmm-empty">暂无运行记录</div>'}</div></div>
      <div class="cf-section"><h4>项目操作</h4><div class="cf-row">
        <button class="btn" data-act="duplicate">⧉ 复制项目</button>
        <button class="btn" data-act="export">⇩ 导出 JSON</button>
        <button class="btn" data-act="reset-steps">↺ 重置六步状态</button>
        <button class="btn danger" data-act="delete">✕ 删除项目</button></div>
        <div class="cf-note">删除不可撤销；建议先创建快照。</div></div>`;
    body.querySelector('[data-act="snapshot"]').addEventListener('click', async () => {
      try { await api(`/api/projects/${p.id}/snapshots`, {}); toast('快照已创建', 'ok'); await refresh(); }
      catch (e) { toast(e.message, 'err'); }
    });
    body.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
      if (!window.confirm('恢复到该快照？当前状态会先自动存为安全点。')) return;
      try { await api(`/api/projects/${p.id}/restore`, { at: Number(b.dataset.restore) }); toast('已恢复快照', 'ok'); await refresh(); await ctx.onChanged?.(); }
      catch (e) { toast(e.message, 'err'); }
    }));
    body.querySelector('[data-act="duplicate"]').addEventListener('click', async () => {
      try { await api(`/api/projects/${p.id}/duplicate`, {}); toast('已复制项目副本', 'ok'); await ctx.onChanged?.(); close(); }
      catch (e) { toast(e.message, 'err'); }
    });
    body.querySelector('[data-act="export"]').addEventListener('click', async () => {
      try {
        const d = await api(`/api/projects/${p.id}/export`);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }));
        a.download = `${p.name}.json`; a.click(); URL.revokeObjectURL(a.href);
        toast('项目 JSON 已导出', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });
    body.querySelector('[data-act="reset-steps"]').addEventListener('click', async () => {
      try { await api(`/api/projects/${p.id}/step`, { action: 'reset' }); toast('六步任务状态已重置', 'ok'); await refresh(); await ctx.onChanged?.(); }
      catch (e) { toast(e.message, 'err'); }
    });
    body.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      if (!window.confirm(`确定删除「${p.name}」？此操作不可撤销。`)) return;
      try { await api(`/api/projects/${p.id}`, undefined, 'DELETE'); toast('项目已删除', 'ok'); close(); await ctx.onChanged?.(true); }
      catch (e) { toast(e.message, 'err'); }
    });
  }

  root.appendChild(backdrop);
  render();
  return { close, refresh };
}
