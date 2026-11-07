/* ============================================================================
 * 创作项目管理层前端：项目列表（搜索/筛选/排序/收藏/归档/更多操作）、
 * 六步任务面板（四态视觉提示 + 论文依据）、画布步骤导航条、项目管理面板。
 * 只负责 DOM 与交互；所有状态以 project.management / /api 返回为准。
 * ==========================================================================*/
import { openAssetLibrary } from './asset-manager.js';
import { openAIChat } from './ai-chat.js';
import { ensureModelPicker, withModelId } from './model-picker.js';

const $ = (id) => document.getElementById(id);
const esc = (s = '') => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cut = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };
const fmtTime = (ts) => {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const fmtBytes = (b) => !b ? '—' : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;

/** 角色多视图定义（与后端 characters.mjs CHARACTER_VIEWS 对齐） */
const CHARACTER_VIEWS = [
  { key: 'front', label: '正面' },
  { key: 'side', label: '侧面' },
  { key: 'back', label: '背面' },
];
/** 多视图生成中的进度状态（跨 render 保持） */
let viewGen = { charId: null, current: 0, total: 0 };

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
    // 项目级 token 累积（runs 汇总，projectIndex 下发）；无消耗时不显示避免噪音
    const tok = p.tokens?.total
      ? `<span class="pm-tok" title="项目累积 LLM Token 消耗（输入 ${(p.tokens.prompt || 0).toLocaleString()} / 输出 ${(p.tokens.completion || 0).toLocaleString()} · ${p.tokens.calls || 0} 次调用）">Σ ${fmtTok(p.tokens.total)} tok</span>`
      : '';
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
        ${tok}
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

/* ------------------------------------------------------------------ 项目封面：对话式创作
 * 与封面助手 AI 对话：直接给选项 → 一键生成封面（自动产出提示词并保存 → ComfyUI 文生图）；
 * 或上传 / 从资源库选参考图（单图或多图）→ AI 结合参考图重写提示词 → 用户确认后
 * 调用 ComfyUI 多参考图生图。对话交互由可复用的 ai-chat.js 组件承载。
 * ---------------------------------------------------------------- */
export function openCoverDialog(ctx = {}) {
  const p = ctx.project;
  if (!p) return;
  const toast = ctx.toast || (() => {});
  const comfyReady = Boolean(ctx.comfy?.imageWorkflow);
  let cover = { ...readCover(p) };
  let refs = [];                    // 参考图（有序）：{file?, name, url, dataUrl?, bytes?}
  let lastPrompt = '';              // 最近一次 AI 提示词（后端已存草稿）
  let lastNegative = '';
  let lastGenerated = null;         // 待确认的生成结果 {file,url}：确认后才保存为封面
  /** 同步到列表索引与完整项目两处，避免关闭后卡片短暂回退 */
  const applyCover = (next) => {
    cover = { ...next };
    p.cover = cover;
    if (p.management) p.management.cover = cover;
  };
  const refsPayload = () => refs.map((r) => (r.file ? { asset: r.file } : { dataUrl: r.dataUrl }));

  /** 与封面助手对话一轮：AI 回复 + 提示词；autoGenerate=true 时链式直接调 ComfyUI 出图 */
  async function roundChat(ui, opts = {}) {
    try {
      const d = await api(`/api/projects/${p.id}/cover/chat`, withModelId('cover', { messages: ui.history(), refs: refsPayload() }));
      lastPrompt = String(d.prompt || '');
      lastNegative = String(d.negative || '');
      if (d.fellBack) toast('LLM 未返回有效结果，已用内置模板生成提示词', 'warn');
      ui.addMessage({
        role: 'assistant',
        text: d.reply || d.message || '已写好封面提示词，确认后即可生成。',
        promptBlock: { prompt: lastPrompt, negative: lastNegative },
        suggestions: d.suggestions,
        actions: [
          { label: '✦ 生成封面', act: 'generate', primary: true, disabled: !comfyReady },
          { label: '↺ 换一版', act: 'regen' },
          ...(refs.length ? [{ label: '＋ 补充参考图', act: 'pick-refs' }, { label: '✕ 清空参考图', act: 'clear-refs' }] : []),
        ],
      });
      if (opts.autoGenerate && comfyReady) await doGenerate(ui);
    } catch (err) {
      ui.addMessage({ role: 'assistant', text: `✗ ${err.message}` });
    }
  }

  /** 生成结果放大预览：确认才保存为项目封面；放弃则图片保留在资源库可复用（模块级实现，见文末） */
  const openGenerated = (g, ui) => openGeneratedConfirm({
    project: p, ui, generated: g,
    applyCover, onChanged: () => ctx.onChanged?.(), toast,
  });

  /** 用户确认提示词后调 ComfyUI 生图（约 1–2 分钟）；生成后先放大预览，确认才保存封面 */
  async function doGenerate(ui) {
    ui.setBusy(true, 'ComfyUI 正在生成封面（约 1–2 分钟）…');
    try {
      const d = await api(`/api/projects/${p.id}/cover/generate`, withModelId('cover', {
        prompt: lastPrompt, negative: lastNegative, refs: refsPayload(),
      }));
      const secs = d.durationMs ? ` · ${(d.durationMs / 1000).toFixed(1)}s` : '';
      // 生成结果带上实际使用的提示词：确认保存时原样回传落盘（只用这提示词、完整保存）
      const g = { ...(d.generated || {}), prompt: d.prompt || lastPrompt, promptId: d.promptId || '' };
      ui.addMessage({
        role: 'assistant',
        text: `✓ 封面已生成${secs}${refs.length ? ` · 参考图 ${refs.length} 张` : ''}${d.promptId ? ` · 调用 ${d.promptId}` : ''}，请在大图预览中确认后保存`,
        images: [g.url].filter(Boolean),
        actions: [
          { label: '✓ 保存为封面', act: 'confirm-cover', primary: true },
          { label: '↺ 重新生成', act: 'regen' },
          { label: '＋ 换参考图', act: 'pick-refs' },
        ],
      });
      const handle = openGenerated(g, ui);
      if (handle?.generated) lastGenerated = handle.generated;
    } catch (err) {
      ui.addMessage({ role: 'assistant', text: `✗ ${err.message}` });
    }
    ui.setBusy(false);
  }

  /** 追加参考图后自动让 AI 结合图片重写提示词（用户确认后再生图） */
  function refsAdded(ui, added) {
    refs = [...refs, ...added].slice(0, 6);
    ui.addMessage({
      role: 'user',
      text: `已添加 ${added.length} 张参考图（共 ${refs.length} 张），请结合参考图重新生成提示词`,
      images: added.map((r) => r.url),
    });
    return roundChat(ui);
  }

  // 参考图 / 封面上传的隐藏文件输入（无需挂到 DOM 即可 click）
  const refInput = document.createElement('input');
  refInput.type = 'file';
  refInput.accept = 'image/png,image/jpeg,image/webp';
  refInput.multiple = true;
  refInput.addEventListener('change', async () => {
    const files = [...(refInput.files || [])];
    refInput.value = '';
    if (!files.length) return;
    const added = [];
    let total = refs.reduce((s, r) => s + (r.bytes || 0), 0);
    for (const file of files) {
      if (refs.length + added.length >= 6) break;
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { chat.addMessage({ role: 'assistant', text: '✗ 参考图仅支持 PNG / JPEG / WebP' }); continue; }
      if (file.size > 2 * 1024 * 1024) { chat.addMessage({ role: 'assistant', text: '✗ 单张参考图不超过 2 MB，请压缩后再上传' }); continue; }
      if (total + file.size > 3.5 * 1024 * 1024) { chat.addMessage({ role: 'assistant', text: '✗ 本地参考图总计不超过 3.5 MB，超出请改用「资源库选参考图」' }); break; }
      total += file.size;
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error('读取图片失败'));
          reader.readAsDataURL(file);
        });
        added.push({ dataUrl, name: file.name, url: dataUrl, bytes: file.size });
      } catch (err) { chat.addMessage({ role: 'assistant', text: `✗ ${err.message}` }); }
    }
    if (added.length) await refsAdded(chat, added);
  });
  const coverInput = document.createElement('input');
  coverInput.type = 'file';
  coverInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
  coverInput.addEventListener('change', async () => {
    const file = coverInput.files?.[0];
    coverInput.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return chat.addMessage({ role: 'assistant', text: '✗ 仅支持 PNG / JPEG / WebP / GIF 图片' });
    if (file.size > 4 * 1024 * 1024) return chat.addMessage({ role: 'assistant', text: '✗ 图片超过 4 MB，请压缩后再上传' });
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(file);
      });
      const d = await api(`/api/projects/${p.id}/cover`, { dataUrl });
      applyCover(d.cover);
      chat.addMessage({ role: 'assistant', text: '✓ 封面图片已上传', images: [cover.url] });
      toast('项目封面已上传', 'ok');
      await ctx.onChanged?.();
    } catch (err) { chat.addMessage({ role: 'assistant', text: `✗ ${err.message}` }); }
  });

  const chat = openAIChat({
    title: '🖼 项目封面',
    subtitle: `${p.name} · 对话式封面创作`,
    placeholder: '描述你想要的封面（如「水墨风、留白多、带点孤寂感」）…',
    modelEntry: 'cover',
    welcome: {
      role: 'assistant',
      text: `我是封面创作助手，已了解《${p.name}》的资料${cover.url ? '，当前封面如下（点击可放大），可随时替换' : ''}。`
        + `${comfyReady ? '可以一句话告诉我方向，或直接选择：' : '⚠ 尚未配置 ComfyUI 出图工作流，生成前请先在设置中导入「导出(API)」工作流；也可以直接上传图片作封面。'}`,
      images: cover.url ? [`${cover.url}${cover.url.includes('?') ? '&' : '?'}t=${cover.updatedAt || ''}`] : [],
      actions: [
        { label: '✦ 一键生成封面', act: 'one-click', primary: true, disabled: !comfyReady },
        { label: '⇧ 上传参考图', act: 'upload-refs' },
        { label: '▣ 资源库选参考图', act: 'pick-refs' },
        { label: '⇧ 上传图片作封面', act: 'upload-cover' },
        { label: '▣ 资源库选图作封面', act: 'from-library-cover' },
        { label: '↺ 恢复名称封面', act: 'reset-cover', disabled: !cover.url },
      ],
    },
    actions: {
      // 一键生成封面：自动生成提示词并保存 → 直接链式调用 ComfyUI 文生图
      'one-click': async (ui) => {
        ui.addMessage({ role: 'user', text: '一键生成封面' });
        await roundChat(ui, { autoGenerate: true });
      },
      'regen': async (ui) => {
        ui.addMessage({ role: 'user', text: '换一版不一样的' });
        await roundChat(ui);
      },
      'generate': (ui) => doGenerate(ui),
      'confirm-cover': async (ui) => {
        if (!lastGenerated) return ui.addMessage({ role: 'assistant', text: '✗ 没有待确认的生成结果，请先生成封面' });
        try {
          const d = await api(`/api/projects/${p.id}/cover`, { asset: lastGenerated.file, prompt: lastGenerated.prompt || '' });
          applyCover(d.cover);
          ui.addMessage({ role: 'assistant', text: '✓ 已保存为项目封面（提示词已随封面完整保存）', images: [cover.url] });
          toast('项目封面已保存', 'ok');
          await ctx.onChanged?.();
        } catch (err) { ui.addMessage({ role: 'assistant', text: `✗ ${err.message}` }); }
      },
      'pick-refs': (ui) => openAssetLibrary({
        mode: 'pick', multi: true, accept: 'image',
        onPick: async (list) => {
          const chosen = (Array.isArray(list) ? list : [list])
            .filter((a) => /\.(png|jpe?g|webp)$/i.test(a.file))
            .map((a) => ({ file: a.file, name: a.name, url: a.url }));
          if (!chosen.length) return;
          await refsAdded(ui, chosen);
        },
      }),
      'upload-refs': () => refInput.click(),
      'clear-refs': async (ui) => {
        refs = [];
        ui.addMessage({ role: 'user', text: '已清空参考图，回到纯文生图' });
        await roundChat(ui);
      },
      'upload-cover': () => coverInput.click(),
      'from-library-cover': (ui) => openAssetLibrary({
        mode: 'pick', accept: 'image',
        onPick: async (a) => {
          try {
            const d = await api(`/api/projects/${p.id}/cover`, { asset: a.file });
            applyCover(d.cover);
            ui.addMessage({ role: 'assistant', text: '✓ 已从资源库选用封面', images: [cover.url] });
            toast('项目封面已更新', 'ok');
            await ctx.onChanged?.();
          } catch (err) { ui.addMessage({ role: 'assistant', text: `✗ ${err.message}` }); }
        },
      }),
      'reset-cover': async (ui) => {
        try {
          const d = await api(`/api/projects/${p.id}/cover`, undefined, 'DELETE');
          applyCover(d.cover);
          ui.addMessage({ role: 'assistant', text: '✓ 已恢复为项目名称封面' });
          toast('已恢复为项目名称封面', 'ok');
          await ctx.onChanged?.();
        } catch (err) { ui.addMessage({ role: 'assistant', text: `✗ ${err.message}` }); }
      },
    },
    onSend: ({ ui }) => roundChat(ui),
  });
  return chat;
}

/* ------------------------------------------------------------------ 封面生成确认弹窗（模块级，便于单元测试） */
/** 生成结果放大预览：确认才保存为项目封面；放弃则图片保留在资源库可复用。
 * 依赖显式注入：project（含 id）/ ui（对话面板，addMessage）/ generated {file,url} /
 * applyCover（写回封面）/ onChanged / toast。返回 { wrap, generated } 便于调用方登记待确认项。 */
export function openGeneratedConfirm({ project, ui = { addMessage: () => {} }, generated, applyCover = () => {}, onChanged, toast: toastFn = () => {} }) {
  if (!generated?.file || !generated?.url) return null;
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal cover-confirm-modal" role="dialog" aria-label="封面确认">
      <div class="pmm-head"><div><h2>👁 封面预览确认</h2><div class="sub">保存后生效为项目封面；放弃则图片仍存于资源库</div></div>
        <button class="icon-btn" data-x aria-label="关闭">✕</button></div>
      <img class="cover-confirm-img" src="${esc(generated.url)}" alt="生成的封面" title="点击图片可关闭，稍后从对话里重新确认">
      <div class="modal-actions">
        <button class="btn" data-skip>✕ 放弃</button>
        <button class="btn primary" data-save>✓ 保存为封面</button>
      </div></div>`;
  (document.getElementById('modal-root') || document.body).appendChild(wrap);
  const done = () => wrap.remove();
  wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) done(); });
  wrap.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', done));
  wrap.querySelector('.cover-confirm-img').addEventListener('click', done);
  wrap.querySelector('[data-skip]').addEventListener('click', () => {
    done();
    ui.addMessage({ role: 'assistant', text: '已放弃本次封面，图片已存入资源库，可从资源库再次选用' });
  });
  wrap.querySelector('[data-save]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      // 随封面保存生成时实际使用的完整提示词（不截断），保证可复现
      const d = await api(`/api/projects/${project.id}/cover`, { asset: generated.file, prompt: generated.prompt || '' });
      applyCover(d.cover);
      ui.addMessage({ role: 'assistant', text: '✓ 已保存为项目封面（提示词已随封面完整保存）', images: [d.cover?.url].filter(Boolean) });
      toastFn('项目封面已保存', 'ok');
      await onChanged?.();
      done();
    } catch (err) { toastFn(err.message, 'err'); btn.disabled = false; }
  });
  return { wrap, generated };
}

/* ------------------------------------------------------------------ 六步任务面板 */
let expandedStep = null;
/** token 数字格式化：≥1000 显示 x.xk（与后端 project-steps 同规则） */
function fmtTok(n) {
  n = Number(n) || 0;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
/** 执行新步骤前由 app.js 调用，让详情卡自动跟随正在执行的那一步 */
export function setExpandedStep(id) { expandedStep = id; }

/** 骨架项目第 ① 步内嵌的「上传小说」入口：文件 / 粘贴 / 示例三来源，走 POST /:id/source */
function renderSourceUpload() {
  return `<div class="sp-upload" id="sp-upload">
    <div class="sp-upload-head"><strong>⇧ 上传小说</strong><span>解析原文 → 分集 → 自动完成 ①② 步 · 至少 40 字</span></div>
    <div class="sp-upload-actions">
      <button class="btn" data-src="file">选择 .txt / .md 文件</button>
      <button class="btn" data-src="sample">载入示例小说</button>
    </div>
    <textarea id="sp-src-text" rows="4" placeholder="或在这里粘贴小说正文&#10;&#10;第一章 ……"></textarea>
    <div class="sp-upload-foot">
      <span class="sp-upload-msg" id="sp-src-msg">数据仅保存在本地 data/</span>
      <button class="btn primary" data-src="submit">⇧ 上传并完成 ①②</button>
    </div>
  </div>`;
}

function bindSourceUpload(host, ctx) {
  const box = host.querySelector('#sp-upload');
  if (!box) return;
  const ta = box.querySelector('#sp-src-text');
  const msg = box.querySelector('#sp-src-msg');
  const state = { text: '', filename: '' };
  const setMsg = (t, err = false) => { msg.textContent = t; msg.classList.toggle('err', err); };
  const readFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      state.text = String(reader.result || ''); state.filename = file.name;
      ta.value = state.text;
      setMsg(`已载入「${file.name}」· ${state.text.trim().length} 字`);
    };
    reader.readAsText(file, 'utf-8');
  };
  box.querySelectorAll('[data-src]').forEach((b) => b.addEventListener('click', async () => {
    const act = b.dataset.src;
    if (act === 'file') {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.txt,.md,.markdown,text/plain,text/markdown';
      input.onchange = () => readFile(input.files?.[0]);
      input.click();
    } else if (act === 'sample') {
      try {
        const d = await api('/api/novel/sample');
        state.text = d.text; state.filename = d.filename;
        ta.value = state.text;
        setMsg(`示例已载入 · ${state.text.trim().length} 字`);
      } catch (e) { setMsg(e.message, true); }
    } else if (act === 'submit') {
      const text = (ta.value || state.text || '').trim();
      if (text.length < 40) return setMsg(`正文至少需要 40 字（当前 ${text.length} 字）`, true);
      b.disabled = true; setMsg('正在解析与分集…');
      try {
        const out = await api(`/api/projects/${ctx.project.id}/source`, { text, filename: state.filename });
        setMsg(`✓ ${out.message}`);
        await ctx.onSourceUploaded?.(out);
      } catch (e) {
        setMsg(e.message, true); b.disabled = false;
      }
    }
  }));
}

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
  // 骨架项目（尚未上传小说）：第 ① 步内嵌上传入口，替代「执行本步」
  const needSource = !m.source?.text;
  if (!expandedStep || !states[expandedStep]) expandedStep = current?.id || null;
  // Token 统计：项目级口径 = 全部 runs 汇总（与侧栏卡片一致，覆盖画布运行与步骤运行两种入口）
  // 步骤自身消耗在每步的 tokens/lastTokens 中单独归因
  const sumTok = (ctx.project?.runs || []).reduce((a, r) => {
    for (const k of ['prompt', 'completion', 'total', 'calls']) a[k] += r.tokens?.[k] || 0;
    return a;
  }, { prompt: 0, completion: 0, total: 0, calls: 0 });
  const live = running ? ctx.liveTokens : null;

  host.innerHTML = `
    <div class="sp-head">
      <div class="sp-head-row"><strong>任务执行步骤</strong><span class="sp-counter">${done}/${total}</span></div>
      <div class="sp-progress"><i class="st-${overall}" style="width:${Math.round(done / total * 100)}%"></i></div>
      <div class="sp-status st-${overall}"><span class="sp-status-dot"></span>${esc(STATUS_TEXT[overall] || overall)}${running ? ' · 画布节点正在生长' : ''}</div>
      <div class="sp-token"><b>Token 统计</b>
        <span class="sp-token-total">${sumTok.calls} 次调用 · ${fmtTok(sumTok.total)} tokens（输入 ${fmtTok(sumTok.prompt)} / 输出 ${fmtTok(sumTok.completion)}）</span>
        ${live ? `<span class="sp-token-live">${live.estimated ? '≈' : ''}${fmtTok(live.total)} tok · 实时</span>` : ''}
      </div>
      <div class="sp-legend"><span class="lg pending">灰 · 待执行</span><span class="lg running">橙 + 呼吸 · 进行中</span><span class="lg done">绿 ✓ · 完成</span><span class="lg error">红 · 失败可重试</span></div>
    </div>
    <div class="sp-list">${steps.map((def) => {
      const st = states[def.id] || { status: def.auto ? 'done' : 'pending' };
      const isCur = current?.id === def.id && st.status !== 'done';
      const open = expandedStep === def.id;
      const tokBadge = st.tokens?.total ? ` · ${fmtTok(st.tokens.total)} tok` : '';
      const badge = st.status === 'done' ? `✓ ${st.durationMs ? (st.durationMs / 1000).toFixed(1) + 's' : '已完成'}${tokBadge}`
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
          ${def.id === 'upload' && needSource ? renderSourceUpload() : ''}
          ${st.tokens && (st.tokens.calls > 0 || st.status === 'done') ? `<div class="sp-token-detail"><b>Token 用量</b>
            <span>累计 ${fmtTok(st.tokens.total)} tok（输入 ${fmtTok(st.tokens.prompt)} / 输出 ${fmtTok(st.tokens.completion)}）· ${st.tokens.calls} 次调用</span>
            ${st.lastTokens ? `<span>上次运行 ${fmtTok(st.lastTokens.total)} tok（输入 ${fmtTok(st.lastTokens.prompt)} / 输出 ${fmtTok(st.lastTokens.completion)}）</span>` : ''}
          </div>` : ''}
          <div class="sp-checks"><b>完成检查</b>${def.checklist.map((c) => `<span>○ ${esc(c)}</span>`).join('')}</div>
          <div class="sp-theory"><b>论文依据 · ${esc(def.theory.ref)}</b><p>${esc(def.theory.text)}</p>
            <div class="sp-map">${def.theory.map.map(([k, v]) => `<span><em>${esc(k)}</em>${esc(v)}</span>`).join('')}</div></div>
          <div class="sp-actions">
            ${st.status !== 'done' && !(def.id === 'upload' && needSource) ? `<button class="btn primary" data-run="${esc(def.id)}" ${ctx.busy ? 'disabled' : ''}>${st.status === 'error' ? '↻ 重试本步' : '▶ 执行本步'}</button>` : ''}
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
  bindSourceUpload(host, ctx);
  host.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', () => ctx.onRunStep?.(b.dataset.run, false)));
  host.querySelectorAll('[data-focus]').forEach((b) => b.addEventListener('click', () => ctx.onFocus?.(b.dataset.focus)));
  host.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', () => ctx.onReset?.(b.dataset.reset)));
  $('sp-next')?.addEventListener('click', () => {
    // 骨架项目停在第 ① 步：先把上传框露出来，避免「执行」直接抛「尚未上传小说」
    if (needSource && current?.id === 'upload') {
      expandedStep = 'upload';
      renderStepPanel(host, ctx);
      host.querySelector('#sp-src-text')?.focus();
      return;
    }
    ctx.onRunStep?.(current?.id, false);
  });
  $('sp-all')?.addEventListener('click', () => {
    // 骨架项目先补原著，否则「全部执行」会在第 ① 步立刻失败
    if (needSource) {
      expandedStep = 'upload';
      renderStepPanel(host, ctx);
      host.querySelector('#sp-src-text')?.focus();
      ctx.onNeedSource?.();
      return;
    }
    ctx.onRunStep?.(null, true);
  });
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

/** 概览页的创作设定摘要：已填写时展示一行基础标识，点击跳转「创作设定」tab 编辑 */
function bibleHintHTML(m) {
  const b = m.bible || {};
  const bits = [
    b.title && `剧名《${b.title}》`, b.genre, b.audience && `受众 ${b.audience}`,
    b.totalEpisodes ? `总集数 ${b.totalEpisodes}` : '', b.artStyle, b.tone && `${b.tone}调性`,
    b.ending && `结局 ${b.ending}`,
  ].filter(Boolean);
  if (!bits.length) return '';
  return `<div class="cf-note pmm-bible-hint">创作设定：${esc(bits.join(' · '))}（<a href="javascript:void 0" data-goto-bible>编辑创作设定</a>）</div>`;
}

/** 角色卡片：三视图缩略 + 属性摘要 + 操作按钮；生成中显示逐视图进度 */
function charCardHTML(c, gen = { charId: null }) {
  const generating = gen.charId === c.id;
  const views = CHARACTER_VIEWS.map((v) => {
    const img = c.views?.[v.key];
    return img
      ? `<div class="pmm-char-view"><img src="${esc(img.url)}" alt="${esc(v.label)}"><span>${v.label}</span></div>`
      : `<div class="pmm-char-view empty"><i></i><span>${v.label}</span></div>`;
  }).join('');
  const srcLabel = { llm: 'LLM 提取', heuristic: '启发式', manual: '手动' }[c.source] || c.source || '手动';
  return `<div class="pmm-char-card" data-char-id="${esc(c.id)}">
    <div class="pmm-char-views">${views}</div>
    <div class="pmm-char-info">
      <div class="pmm-char-title"><b>${esc(c.name)}</b>
        ${(c.aliases || []).map((a) => `<span class="pmm-chip">${esc(a)}</span>`).join('')}
        <span class="pmm-chip">${esc(srcLabel)}</span></div>
      ${c.role ? `<div class="pmm-char-role">${esc(c.role)}</div>` : ''}
      ${c.style ? `<div class="pmm-char-desc">设定风格：${esc(cut(c.style, 60))}</div>` : ''}
      ${c.personality ? `<div class="pmm-char-desc">${esc(cut(c.personality, 60))}</div>` : ''}
      <div class="pmm-char-pal">${(c.palette || []).map((col) => `<i style="background:${esc(col)}"></i>`).join('')}</div>
    </div>
    <div class="pmm-char-acts">
      ${generating
      ? `<span class="pmm-char-gen">正在生成 ${CHARACTER_VIEWS[gen.current - 1]?.label || ''} ${gen.current}/${gen.total}…</span>`
      : `<button class="btn sm" data-char-edit="${esc(c.id)}">✎ 编辑</button>
      <button class="btn sm primary" data-char-views="${esc(c.id)}">✦ 生成多视图</button>
      <button class="btn sm" data-char-del="${esc(c.id)}">✕</button>`}
    </div>
  </div>`;
}

/** 角色属性编辑弹窗：新增/编辑角色（含别名、人物关系、配色、多视图提示词），保存走 char-upsert */
export function openCharacterEditor(char = {}, onSave) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const close = () => backdrop.remove();
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(); });
  let relations = (char.relations || []).map((r) => ({ ...r }));

  const renderBody = () => {
    backdrop.innerHTML = `<div class="modal char-editor" role="dialog" aria-label="角色属性">
      <div class="pmm-head"><div><h2>${char.id ? '✎ 编辑角色' : '＋ 新增角色'}</h2><div class="sub">角色属性驱动多视图生成与关键帧一致性</div></div>
        <button class="icon-btn" data-act="close">✕</button></div>
      <div class="pmm-body">
        <div class="modal-grid">
          <div class="field"><label>姓名 *</label><input id="ce-name" maxlength="20" value="${esc(char.name || '')}"></div>
          <div class="field"><label>别名（逗号分隔）</label><input id="ce-aliases" value="${esc((char.aliases || []).join('，'))}"></div>
          <div class="field"><label>身份 / 定位</label><input id="ce-role" maxlength="60" value="${esc(char.role || '')}"></div>
          <div class="field"><label>性别</label><input id="ce-gender" maxlength="8" value="${esc(char.gender || '')}"></div>
          <div class="field"><label>年龄</label><input id="ce-age" maxlength="24" value="${esc(char.age || '')}"></div>
        </div>
        <div class="modal-grid">
          <div class="field"><label>性格</label><textarea id="ce-personality" rows="2">${esc(char.personality || '')}</textarea></div>
          <div class="field"><label>外貌描述</label><textarea id="ce-appearance" rows="2">${esc(char.appearance || '')}</textarea></div>
          <div class="field"><label>发型</label><input id="ce-hair" value="${esc(char.hair || '')}"></div>
          <div class="field"><label>随身物件</label><input id="ce-props" value="${esc(char.props || '')}"></div>
          <div class="field" style="grid-column:1/-1"><label>服装 / 配饰</label><textarea id="ce-costume" rows="2">${esc(char.costume || '')}</textarea></div>
        </div>
        <div class="field"><label>设定风格（一句话总结，驱动多视图与关键帧）</label>
          <input id="ce-style" maxlength="120" value="${esc(char.style || '')}" placeholder="如：古风玄幻 · 清冷剑修，白衣墨发，水墨淡彩"></div>
        <div class="cf-section"><h4>人物关系</h4>
          <div class="char-rel-list">${relations.map((r, i) => `
            <div class="char-rel-row">
              <input data-rel="target" data-i="${i}" placeholder="对象（如：林夏）" value="${esc(r.target || '')}">
              <input data-rel="label" data-i="${i}" placeholder="关系（如：同门师兄）" value="${esc(r.label || '')}">
              <button class="btn sm" data-rel-del="${i}">✕</button>
            </div>`).join('') || '<div class="cf-note" style="margin:0">暂无人物关系</div>'}</div>
          <button class="btn sm" data-act="add-rel">＋ 添加关系</button>
        </div>
        <div class="cf-section"><h4>配色（3–5 个，用于多视图与关键帧）</h4>
          <div class="char-pal-row">${[0, 1, 2, 3, 4].map((i) => `<input type="color" data-pal="${i}" value="${esc((char.palette || [])[i] || ['#1a2233', '#3a506b', '#ff9a5c', '#6b4f8a', '#3f6b5c'][i])}">`).join('')}</div>
        </div>
        <div class="field"><label>多视图提示词（可选，留空则按上方属性自动拼装）</label>
          <textarea id="ce-view-prompt" placeholder="直接描述角色造型要求，生成多视图时优先使用…">${esc(char.viewPrompt || '')}</textarea></div>
      </div>
      <div class="modal-actions">
        <button class="btn" data-act="close">取消</button>
        <button class="btn primary" data-act="save">保存角色</button>
      </div>
    </div>`;
    backdrop.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener('click', close));
    backdrop.querySelector('[data-act="add-rel"]').addEventListener('click', () => {
      relations.push({ target: '', label: '' });
      renderBody();
    });
    backdrop.querySelectorAll('[data-rel]').forEach((el) => el.addEventListener('input', () => {
      relations[Number(el.dataset.i)][el.dataset.rel] = el.value;
    }));
    backdrop.querySelectorAll('[data-rel-del]').forEach((b) => b.addEventListener('click', () => {
      relations.splice(Number(b.dataset.relDel), 1);
      renderBody();
    }));
    backdrop.querySelector('[data-act="save"]').addEventListener('click', () => {
      const val = (sel) => String(backdrop.querySelector(sel)?.value || '').trim();
      const name = val('#ce-name');
      if (!name) { backdrop.querySelector('#ce-name')?.focus(); return; }
      onSave({
        ...(char.id ? { id: char.id } : {}),
        name,
        aliases: val('#ce-aliases').split(/[,，、]/).map((s) => s.trim()).filter(Boolean),
        role: val('#ce-role'), gender: val('#ce-gender'), age: val('#ce-age'),
        personality: val('#ce-personality'), appearance: val('#ce-appearance'),
        hair: val('#ce-hair'), costume: val('#ce-costume'), props: val('#ce-props'),
        style: val('#ce-style'),
        relations: relations.filter((r) => r.target || r.label),
        palette: [...backdrop.querySelectorAll('[data-pal]')].map((el) => el.value),
        viewPrompt: val('#ce-view-prompt'),
      });
      close();
    });
  };
  renderBody();
  $('modal-root').appendChild(backdrop);
}

export function openProjectManager(ctx = {}) {
  const toast = ctx.toast || (() => {});
  const root = $('modal-root');
  let tab = ['overview', 'bible', 'characters', 'episodes', 'deliverables', 'versions'].includes(ctx.tab) ? ctx.tab : 'overview';
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
      <div class="pmm-tabs">${[['overview', '概览'], ['bible', '创作设定'], ['characters', '角色'], ['episodes', '分集'], ['deliverables', '产物'], ['versions', '版本 / 记录']].map(([k, label]) => `<button class="pmm-tab ${tab === k ? 'active' : ''}" data-tab="${k}">${label}</button>`).join('')}</div>
      <div class="pmm-body" id="pmm-body"></div>
      <div class="modal-actions"><button class="btn" data-act="close">关闭</button></div>
    </div>`;
    backdrop.querySelector('[data-act="close"]').addEventListener('click', close);
    backdrop.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener('click', close));
    backdrop.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; render(); }));
    const body = $('pmm-body');
    if (tab === 'overview') renderOverview(body, m, s, prog);
    if (tab === 'bible') renderBible(body, m);
    if (tab === 'characters') renderCharacters(body, m);
    if (tab === 'episodes') renderEpisodes(body, m);
    if (tab === 'deliverables') renderDeliverables(body, m, s);
    if (tab === 'versions') renderVersions(body, p, s);
  }

  /** 「角色」Tab：从小说提取角色属性（LLM 优先）、手动维护、逐视图生成多视图 */
  function renderCharacters(body, m) {
    const chars = Array.isArray(m.characters) ? m.characters : [];
    const hasNovel = !!m.source?.text;
    body.innerHTML = `
      <div class="cf-section"><h4>角色库 · 从小说提取 · 多视图生成</h4>
        <div class="cf-row">
          <button class="btn primary" id="pmm-char-extract" ${hasNovel ? '' : 'disabled'}>✦ 从原著提取（LLM）</button>
          <button class="btn" id="pmm-char-heur" ${hasNovel ? '' : 'disabled'}>⚙ 启发式提取</button>
          <button class="btn" id="pmm-char-add">＋ 新增角色</button>
          <span class="cf-note" style="margin:0" id="pmm-char-status">${hasNovel ? '' : '请先上传小说后再提取角色'}</span>
        </div>
        <div class="cf-row pmm-char-batch">
          <button class="btn primary" id="pmm-char-gen-all" ${chars.length ? '' : 'disabled'}>✦ 一键生成全部角色定妆图</button>
          <label class="cf-check"><input type="checkbox" id="pmm-char-all-views"> 每人生成三视图（正面 / 侧面 / 背面）</label>
          <label class="cf-check"><input type="checkbox" id="pmm-char-only-missing" checked> 只补缺失的图</label>
          <span class="cf-note" style="margin:0">${chars.length ? `共 ${chars.length} 位角色 · 逐张落盘，可随时中断` : ''}</span>
        </div>
        ${chars.length
        ? `<div class="pmm-chars">${chars.map((c) => charCardHTML(c, viewGen)).join('')}</div>`
        : '<div class="cf-note">还没有角色。可从小说自动提取（LLM 优先、启发式兜底），或手动新增角色。</div>'}
      </div>`;
    // 模型选择器：提取与多视图生成都用它选中的模型（库为空时不出现）
    ensureModelPicker('chars', body.querySelector('.cf-row'), body.querySelector('#pmm-char-status'));
    body.querySelector('#pmm-char-add').addEventListener('click', () => {
      openCharacterEditor({}, (obj) => manage('char-upsert', obj));
    });
    const extract = async (mode) => {
      const status = $('pmm-char-status');
      const btns = [body.querySelector('#pmm-char-extract'), body.querySelector('#pmm-char-heur')].filter(Boolean);
      btns.forEach((b) => { b.disabled = true; });
      if (status) status.textContent = mode === 'heuristic' ? '启发式提取中…' : 'LLM 提取中，可能需要 30 秒以上，请耐心等待…';
      try {
        const d = await api(`/api/projects/${ctx.project.id}/characters/extract`, withModelId('chars', { mode }));
        toast(d.message || `新增 ${d.added || 0} · 合并 ${d.merged || 0}`, d.fellBack ? 'err' : 'ok');
        await refresh();
        await ctx.onChanged?.();
      } catch (e) {
        toast(`提取失败：${e.message}`, 'err');
        if (status) status.textContent = '';
        btns.forEach((b) => { b.disabled = false; });
      }
    };
    if (hasNovel) {
      body.querySelector('#pmm-char-extract').addEventListener('click', () => extract('llm'));
      body.querySelector('#pmm-char-heur').addEventListener('click', () => extract('heuristic'));
    }
    /** 一键生成全部角色：一次请求批量出图，SSE 进度由 app.js 写回 #pmm-char-status */
    body.querySelector('#pmm-char-gen-all')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const status = $('pmm-char-status');
      btn.disabled = true;
      btn.textContent = '✦ 批量生成中…';
      if (status) status.textContent = '正在准备批量生成…';
      try {
        const d = await api(`/api/projects/${ctx.project.id}/characters/views/all`, withModelId('chars', {
          allViews: body.querySelector('#pmm-char-all-views')?.checked === true,
          onlyMissing: body.querySelector('#pmm-char-only-missing')?.checked !== false,
        }));
        toast(d.message || '批量生成完成', d.failed?.length ? 'warn' : 'ok');
        if (status) status.textContent = d.message || '';
        await refresh();
        await ctx.onChanged?.();
      } catch (err) {
        toast(`批量生成失败：${err.message}`, 'err');
        if (status) status.textContent = err.message;
      } finally {
        btn.disabled = false;
        btn.textContent = '✦ 一键生成全部角色定妆图';
      }
    });
    body.querySelectorAll('[data-char-edit]').forEach((b) => b.addEventListener('click', () => {
      const c = chars.find((x) => x.id === b.dataset.charEdit);
      if (c) openCharacterEditor(c, (obj) => manage('char-upsert', obj));
    }));
    body.querySelectorAll('[data-char-del]').forEach((b) => b.addEventListener('click', () => manage('char-del', b.dataset.charDel)));
    body.querySelectorAll('[data-char-views]').forEach((b) => b.addEventListener('click', () => {
      const c = chars.find((x) => x.id === b.dataset.charViews);
      if (c) generateViews(c);
    }));
  }

  /** 逐视图生成角色多视图：每张一次请求、逐张反馈进度，单张失败继续后续视图 */
  async function generateViews(c) {
    viewGen = { charId: c.id, current: 0, total: CHARACTER_VIEWS.length };
    render();
    let okCount = 0;
    const fails = [];
    for (let i = 0; i < CHARACTER_VIEWS.length; i++) {
      const v = CHARACTER_VIEWS[i];
      viewGen = { charId: c.id, current: i + 1, total: CHARACTER_VIEWS.length };
      render();
      try {
        await api(`/api/projects/${ctx.project.id}/characters/views`, withModelId('chars', { characterId: c.id, view: v.key }));
        okCount += 1;
      } catch (e) { fails.push(`${v.label}：${e.message}`); }
    }
    viewGen = { charId: null, current: 0, total: 0 };
    if (fails.length) toast(`「${c.name}」多视图完成 ${okCount}/${CHARACTER_VIEWS.length}，失败 ${fails.join('；')}`, 'err');
    else toast(`「${c.name}」多视图已生成：${okCount} 张，已登记资源库`, 'ok');
    await refresh();
    await ctx.onChanged?.();
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
        ${bibleHintHTML(m)}</div>
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
    body.querySelector('[data-goto-bible]')?.addEventListener('click', () => { tab = 'bible'; render(); });
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

  /* ------------------------------------------------ 创作设定（漫剧基础信息归档）
   * 一部剧的「创作圣经」：基础标识 / 首集锚定主题 / 改编原则 / 创作底线 /
   * 世界观 / 人设 / AI 生成需求。总集数保存后自动同步分集参数「最多集数」。 */
  function renderBible(body, m) {
    const b = m.bible || {};
    body.innerHTML = `
      <div class="cf-section"><h4>基础标识</h4>
        <div class="modal-grid">
          <div class="field"><label>剧名</label><input id="pb-title" value="${esc(b.title || '')}" placeholder="《xxxx》"></div>
          <div class="field"><label>题材</label><input id="pb-genre" value="${esc(b.genre || '')}" placeholder="科幻悬疑"></div>
          <div class="field"><label>目标受众</label><input id="pb-audience" value="${esc(b.audience || '')}" placeholder="青年观众"></div>
          <div class="field"><label>总集数</label><input id="pb-total" type="number" min="0" max="64" value="${esc(b.totalEpisodes || '')}" placeholder="8（0 = 未设定）"></div>
          <div class="field"><label>结局类型</label><input id="pb-ending" value="${esc(b.ending || '')}" placeholder="开放结局（OE）"></div>
          <div class="field"><label>美术风格</label><input id="pb-art" value="${esc(b.artStyle || '')}" placeholder="写实电影画风"></div>
          <div class="field"><label>整体调性</label><input id="pb-tone" value="${esc(b.tone || '')}" placeholder="暗黑"></div>
        </div></div>
      <div class="cf-section"><h4>首集锚定主题</h4>
        <textarea id="pb-theme" rows="2" placeholder="如：日常秩序里的一道裂缝——所见非真。首集结尾用一次微小异象推翻官方定论…">${esc(b.firstEpisodeTheme || '')}</textarea></div>
      <div class="cf-section"><h4>改编原则</h4>
        <textarea id="pb-adapt" rows="3" placeholder="核心策略（如：抽核式改编）、保留骨架、不可删减的关键事件（每行一条）…">${esc(b.adaptation || '')}</textarea></div>
      <div class="cf-section"><h4>创作底线（每行一条，不可突破）</h4>
        <textarea id="pb-bottom" rows="3" placeholder="如：不解释意识体本体，保留未知神秘感">${esc(b.bottomLines || '')}</textarea></div>
      <div class="cf-section"><h4>世界观设定</h4>
        <textarea id="pb-world" rows="6" placeholder="时代与舞台、核心现象（只描述现象，永不解释本体）、证据链误读结构、世界观铁律…">${esc(b.worldview || '')}</textarea></div>
      <div class="cf-section"><h4>人设（每段一个角色）</h4>
        <textarea id="pb-chars" rows="6" placeholder="每段一个角色：名字｜身份｜外形锚点｜性格与行为逻辑｜人物弧光与结局代价&#10;如：老陈｜55岁·爆破组长｜花白寸头，左眉骨旧疤，手背光晕 L4｜话少，规矩重｜殉道者弧光，用被石埋结清自己的账">${esc(b.characters || '')}</textarea></div>
      <div class="cf-section"><h4>AI 生成需求</h4>
        <div class="modal-grid">
          <div class="field" style="grid-column:1/-1"><label>全局风格串（注入关键帧提示词前缀）</label><textarea id="pb-style" rows="2" placeholder="写实电影画风，暗黑调性，低饱和冷灰主色 + 应急灯暖橙点缀，体积雾，35mm 胶片颗粒…">${esc(b.stylePrompt || '')}</textarea></div>
          <div class="field" style="grid-column:1/-1"><label>负面串</label><textarea id="pb-neg" rows="2" placeholder="动漫感、过曝、明亮高调、卡通渲染、明确幽灵特效、文字水印…">${esc(b.negativePrompt || '')}</textarea></div>
        </div></div>
      <div class="cf-row"><button class="btn primary" data-act="save-bible">保存创作设定</button>
        <span class="cf-note" style="margin:0">总集数保存后自动同步为分集参数「最多集数」，重新执行第 ② 步生效</span></div>`;
    body.querySelector('[data-act="save-bible"]').addEventListener('click', async () => {
      await manage('bible', {
        title: $('pb-title').value.trim(), genre: $('pb-genre').value.trim(),
        audience: $('pb-audience').value.trim(), totalEpisodes: Number($('pb-total').value) || 0,
        ending: $('pb-ending').value.trim(), artStyle: $('pb-art').value.trim(), tone: $('pb-tone').value.trim(),
        firstEpisodeTheme: $('pb-theme').value, adaptation: $('pb-adapt').value,
        bottomLines: $('pb-bottom').value, worldview: $('pb-world').value,
        characters: $('pb-chars').value, stylePrompt: $('pb-style').value, negativePrompt: $('pb-neg').value,
      });
    });
  }

  function renderEpisodes(body, m) {
    if (m.kind !== 'novel') { body.innerHTML = '<div class="pmm-empty">标准项目没有分集数据</div>'; return; }
    // 基础信息条：分集表按创作设定展示题材 / 受众 / 美术风格 / 调性 / 结局类型
    const b = m.bible || {};
    const total = b.totalEpisodes || (m.episodes || []).length;
    const chips = [b.genre, b.audience && `受众 ${b.audience}`, b.artStyle, b.tone && `${b.tone}调性`]
      .filter(Boolean).map((x) => `<span class="pmm-chip">${esc(x)}</span>`).join('');
    const strip = (chips || b.ending) ? `<div class="pmm-bible-strip">${chips}${b.ending ? `<span class="pmm-chip chip-ending">结局：${esc(b.ending)}</span>` : ''}<span class="pmm-bible-total">共 ${total} 集</span></div>` : '';
    const epTag = (e, i, arr) => {
      if (e.no === 1 && b.firstEpisodeTheme) return `<span class="pmm-ep-tag">锚定主题：${esc(cut(b.firstEpisodeTheme, 40))}</span>`;
      if (i === arr.length - 1 && b.ending) return `<span class="pmm-ep-tag">结局：${esc(b.ending)}</span>`;
      return '';
    };
    const eps = (m.episodes || []);
    body.innerHTML = `${strip}<div class="pmm-section-head"><strong>分集表 · ${eps.length} 集</strong><span>来自 ${esc(m.source?.filename || '粘贴文本')} · 共 ${m.source?.totalChars || 0} 字</span></div>
      <div class="pmm-eps">${eps.map((e, i) => `<button class="pmm-ep" data-ep-open="${e.no}" title="打开第 ${e.no} 集详情">
        <span class="pmm-ep-no">${e.no}</span>
        <span class="pmm-ep-main"><strong>${esc(e.title)}${epTag(e, i, eps)}</strong><small>${esc(e.summary)}</small><em>结尾钩子：${esc(e.hook)}</em><span class="pmm-ep-src">来源：${esc((e.sourceTitles || []).join(' / '))} · ${(e.chapters || []).length} 章 / ${(e.segments || []).length} 段</span></span>
        <span class="pmm-ep-chars">${e.chars} 字<i>查看详情 →</i></span></button>`).join('')}</div>
      <div class="cf-note">点击任意一集可查看拆分原文、本集剧本、出场角色、每段宫格图、资源链接画布，并可单独导出导演包或调用本地 ComfyUI 生成视频。</div>`;
    body.querySelectorAll('[data-ep-open]').forEach((b) => b.addEventListener('click', () => {
      close();
      ctx.onOpenEpisode?.(Number(b.dataset.epOpen));
    }));
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
    const calls = (p.management?.coverCalls || []);
    body.innerHTML = `<div class="cf-section"><h4>项目快照</h4>
      <div class="cf-row"><button class="btn primary" data-act="snapshot">＋ 创建快照</button><span class="cf-note" style="margin:0">恢复前会自动为当前状态再存一个安全点</span></div>
      <div class="pmm-snaps">${snapshots.length ? snapshots.map((x) => `<div><span>${fmtTime(x.at)}</span><b>${x.nodeCount} 节点</b><span>${fmtBytes(x.size)}</span><button class="btn" data-restore="${x.at}">恢复</button></div>`).join('') : '<div class="pmm-empty">暂无快照</div>'}</div></div>
      <div class="cf-section"><h4>运行记录（最近 ${s.runCount || 0} 次）</h4>
        <div class="pmm-snaps">${(p.runs || []).slice(0, 8).map((r) => `<div><span>${fmtTime(r.finishedAt)}</span><b>${r.nodeCount} 节点 / ${r.waves} 波</b><span>${((r.durationMs || 0) / 1000).toFixed(1)}s · ${esc(r.status)}</span></div>`).join('') || '<div class="pmm-empty">暂无运行记录</div>'}</div></div>
      <div class="cf-section"><h4>封面生成调用记录（最近 ${calls.length} 次）</h4>
        <div class="pmm-snaps pmm-calls">${calls.map((c) => `<div class="pmm-call">
          <span>${fmtTime(c.at)}</span>
          <b class="${c.ok ? 'ok' : 'err'}">${c.ok ? '✓ 成功' : '✗ 失败'}</b>
          <span>${((c.durationMs || 0) / 1000).toFixed(1)}s${c.refCount ? ` · 参考图 ${c.refCount} 张` : ''}${c.promptId ? ` · ${esc(c.promptId)}` : ''}</span>
          <details><summary>过程日志</summary>
            <div class="pmm-call-detail">
              <div><b>提示词</b>${esc(cut(c.prompt, 200))}${String(c.prompt || '').length > 200 ? '…' : ''}</div>
              ${c.negative ? `<div><b>负向</b>${esc(cut(c.negative, 120))}</div>` : ''}
              ${(c.refs || []).length ? `<div><b>参考图</b>${esc(c.refs.join('、'))}</div>` : ''}
              ${c.promptInjection ? `<div><b>提示词注入</b>${esc(c.promptInjection.positive ? `${c.promptInjection.positive.node}.${c.promptInjection.positive.input} · ${c.promptInjection.positive.strategy || ''}` : '未找到注入点')}${(c.promptInjection.warnings || []).length ? ` · ⚠ ${esc(c.promptInjection.warnings.join('；'))}` : ''}</div>` : ''}
              ${c.applied?.length ? `<div><b>注入参数</b>${c.applied.map((a) => esc(`${a.node}.${a.input}(${a.by})`)).join('、')}</div>` : ''}
              ${c.error ? `<div><b>错误</b>${esc(c.error)}</div>` : ''}
              <div class="pmm-call-logs">${(c.logs || []).map((l) => `<div>${esc(l)}</div>`).join('')}</div>
            </div>
          </details>
        </div>`).join('') || '<div class="pmm-empty">暂无调用记录</div>'}</div>
        <div class="cf-note">每次 ComfyUI 封面生成（含失败）都会留档：所用完整提示词、参考图、提示词注入结果与运行日志。</div></div>
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
