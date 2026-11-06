/* ============================================================================
 * 全局资源库：data/assets/ 下已生成资源的统一管理与复用选择。
 * manage 模式 = 顶栏入口（类型/标签/来源项目筛选 · 搜索 · 改名打标 · 预览 · 删除）；
 * pick 模式 = 封面弹窗、节点检查器的「从资源库选择」取图入口。
 * 元数据（kind/name/tags/来源项目）来自 GET /api/assets 的 index.json 索引，
 * 改名与打标走 PATCH /api/assets/:file，供跨项目共享与角色优先匹配检索。
 * 纯自主实现，无框架依赖；弹窗结构照搬 openCoverDialog 的 backdrop 模式。
 * ==========================================================================*/
import { toast, openAssetPreview } from './panels.js';

const $ = (id) => document.getElementById(id);
const esc = (s = '') => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtBytes = (b) => !b ? '—' : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
const fmtTime = (ts) => {
  const d = new Date(Number(ts));
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

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

const TYPE_LABEL = { image: '图片', video: '视频', other: '其他' };
const KIND_LABEL = { cover: '封面', character: '角色', image: '图片', video: '视频', pack: '导演包', other: '其他' };
const KIND_ORDER = ['all', 'character', 'cover', 'image', 'video', 'pack', 'other'];

/** 单元格视觉：图片直接缩略、视频用静帧预览、其余按扩展名块呈现 */
function cellMedia(a) {
  if (a.type === 'image') return `<img loading="lazy" src="${esc(a.url)}" alt="${esc(a.name)}">`;
  if (a.type === 'video') return `<video src="${esc(a.url)}" muted controls preload="metadata" playsinline></video>`;
  return `<span class="asset-ext">${esc((a.ext || '?').toUpperCase())}</span>`;
}

/**
 * 打开资源库弹窗。
 * @param {object} o
 * @param {'manage'|'pick'} o.mode    manage=管理（筛选/搜索/打标/预览/删除）；pick=选择并回调
 * @param {'all'|'image'|'video'} o.accept  pick 模式下限制可选类型
 * @param {(asset)=>void} o.onPick    pick 模式选中回调
 */
export function openAssetLibrary(o = {}) {
  const mode = o.mode === 'pick' ? 'pick' : 'manage';
  const accept = ['image', 'video'].includes(o.accept) ? o.accept : 'all';
  let assets = [];
  let stats = null;
  let filter = 'all';            // 类型/角色筛选（kind 优先，回退 type）
  let tagFilter = '';            // 标签筛选
  let projectFilter = '';        // 来源项目筛选
  let query = '';                // 名称 / 标签搜索
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const close = () => backdrop.remove();
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(); });

  const load = async () => {
    const d = await api('/api/assets');
    assets = d.assets || [];
    stats = d.stats || null;
    if (accept !== 'all') assets = assets.filter((a) => a.type === accept);
  };

  /** 当前筛选条件下可见的资源（类型 → 标签 → 来源项目 → 搜索，逐层收窄） */
  function visible() {
    return assets.filter((a) => {
      if (filter !== 'all' && (a.kind || a.type) !== filter && a.type !== filter) return false;
      if (tagFilter && !(a.tags || []).includes(tagFilter)) return false;
      if (projectFilter && (a.sourceProjectId || '') !== projectFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        const hay = `${a.name} ${a.file} ${(a.tags || []).join(' ')} ${a.sourceProjectName || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function render() {
    const shown = visible();
    const kindChips = KIND_ORDER.map((k) => {
      const n = k === 'all' ? assets.length : assets.filter((a) => (a.kind || a.type) === k || a.type === k).length;
      if (k !== 'all' && !n) return '';
      return `<button class="asset-chip${filter === k ? ' on' : ''}" data-kind="${k}">${k === 'all' ? '全部' : KIND_LABEL[k]} · ${n}</button>`;
    }).join('');
    // 标签与来源项目聚合（只列实际存在的，避免死筛选项）
    const tagCounts = new Map();
    for (const a of assets) for (const t of a.tags || []) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    const tagChips = [...tagCounts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10)
      .map(([t, n]) => `<button class="asset-chip tag${tagFilter === t ? ' on' : ''}" data-tag="${esc(t)}">#${esc(t)} · ${n}</button>`).join('');
    const projCounts = new Map();
    for (const a of assets) if (a.sourceProjectId) projCounts.set(a.sourceProjectId, a.sourceProjectName || a.sourceProjectId);
    const projChips = [...projCounts.entries()].slice(0, 6)
      .map(([id, name]) => `<button class="asset-chip proj${projectFilter === id ? ' on' : ''}" data-proj="${esc(id)}" title="${esc(name)}">⌂ ${esc(name.length > 12 ? name.slice(0, 12) + '…' : name)}</button>`).join('');
    const activeTags = tagFilter || projectFilter || query
      ? `<button class="asset-chip clear" data-clear>✕ 清除筛选</button>` : '';

    const grid = gridHTML(shown);

    const st = stats ? `共 ${stats.total} 项 · ${fmtBytes(stats.bytes)}${stats.tagCount ? ` · ${stats.tagCount} 个标签` : ''}` : `${assets.length} 项`;
    backdrop.innerHTML = `<div class="modal asset-modal" role="dialog" aria-label="资源库">
      <div class="pmm-head"><div><h2>▣ 资源库</h2><div class="sub">${mode === 'pick' ? '点击资源即可选用' : `${st} · 生成的封面 / 角色 / 片段统一管理，可打标签跨项目复用`}</div></div>
        <button class="icon-btn" data-act="close" aria-label="关闭">✕</button></div>
      <div class="asset-toolbar">
        <div class="asset-filters">${kindChips}</div>
        <input class="asset-search" id="asset-search" type="search" placeholder="搜索名称 / 标签 / 来源项目…" value="${esc(query)}">
      </div>
      ${(tagChips || projChips) ? `<div class="asset-filters sub">${tagChips}${projChips}${activeTags}</div>` : ''}
      <div class="asset-scroll">${grid}</div>
      <div class="modal-actions">${mode === 'manage' ? '<button class="btn" data-act="reindex">↻ 重扫目录</button>' : ''}
        <button class="btn" data-act="close">关闭</button></div>
    </div>`;

    backdrop.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener('click', close));
    backdrop.querySelector('[data-act="reindex"]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = '重扫中…';
      try {
        const d = await api('/api/assets/reindex', {}, 'POST');
        toast(`已重扫：新增 ${d.added} · 清除 ${d.removed} · 共 ${d.total} 项`, 'ok');
        await load(); render();
      } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
    });
    backdrop.querySelectorAll('[data-kind]').forEach((c) => c.addEventListener('click', () => { filter = c.dataset.kind; render(); }));
    backdrop.querySelectorAll('[data-tag]').forEach((c) => c.addEventListener('click', () => { tagFilter = tagFilter === c.dataset.tag ? '' : c.dataset.tag; render(); }));
    backdrop.querySelectorAll('[data-proj]').forEach((c) => c.addEventListener('click', () => { projectFilter = projectFilter === c.dataset.proj ? '' : c.dataset.proj; render(); }));
    backdrop.querySelector('[data-clear]')?.addEventListener('click', () => { tagFilter = ''; projectFilter = ''; query = ''; render(); });
    const search = backdrop.querySelector('#asset-search');
    search?.addEventListener('input', (e) => {
      query = e.target.value;
      // 只刷新网格与筛选计数，保持输入焦点
      const scroll = backdrop.querySelector('.asset-scroll');
      if (scroll) scroll.innerHTML = gridHTML(shown2());
      bindCells();
    });
    search?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); render(); } });

    function shown2() { return visible(); }
    function gridHTML(list) {
      if (!list.length) return `<div class="asset-empty">${assets.length ? '没有匹配的资源<br><small>试试清除筛选或换个关键词</small>' : '资源库为空——生成封面、运行流水线后，产出会自动收录到这里'}</div>`;
      return `<div class="asset-grid">${list.map((a) => `<div class="asset-cell" data-file="${esc(a.file)}" title="${esc(a.name)}">
          <div class="asset-media">${cellMedia(a)}</div>
          <div class="asset-meta">
            <span class="asset-name" title="${esc(a.name)}">${esc(a.name)}</span>
            <span class="asset-sub"><b class="asset-kind k-${esc(a.kind || 'other')}">${KIND_LABEL[a.kind] || TYPE_LABEL[a.type] || '其他'}</b> ${fmtBytes(a.size || a.bytes)} · ${fmtTime(a.createdAt || a.mtime)}</span>
            ${(a.tags || []).length ? `<span class="asset-tags">${a.tags.map((t) => `<i>#${esc(t)}</i>`).join('')}</span>` : ''}
            ${a.sourceProjectName ? `<span class="asset-src" title="来源项目">⌂ ${esc(a.sourceProjectName)}</span>` : ''}
          </div>
          ${mode === 'manage' ? `<button class="asset-del" data-del="${esc(a.file)}" title="删除资源">✕</button>` : '<span class="asset-pick-badge">选择</span>'}
        </div>`).join('')}</div>`;
    }

    bindCells();
    function bindCells() {
      backdrop.querySelectorAll('.asset-cell').forEach((cell) => cell.addEventListener('click', (e) => {
        if (e.target.closest('[data-del]') || e.target.closest('[data-edit]')) return;
        const a = assets.find((x) => x.file === cell.dataset.file);
        if (!a) return;
        if (mode === 'pick') { close(); o.onPick?.(a); return; }
        if (a.type === 'image') openAssetPreview(a.url, a.name);
        else if (a.type === 'video') openAssetPreview(a.url, a.name);
        else openMetaDialog(a);
      }));
      // manage 模式：双击单元格 = 改名 / 打标签 / 改类型
      if (mode === 'manage') {
        backdrop.querySelectorAll('.asset-cell').forEach((cell) => cell.addEventListener('dblclick', (e) => {
          if (e.target.closest('[data-del]')) return;
          const a = assets.find((x) => x.file === cell.dataset.file);
          if (a) openMetaDialog(a);
        }));
        backdrop.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const name = btn.dataset.del;
          if (!confirm(`确定删除资源「${name}」？被项目引用的资源会被拒绝删除。`)) return;
          try {
            await api(`/api/assets/${encodeURIComponent(name)}`, undefined, 'DELETE');
            toast('资源已删除', 'ok');
            await load(); render();
          } catch (err) { toast(err.message, 'err'); }
        }));
      }
    }
  }

  /** 改名 / 打标签 / 改类型弹窗：PATCH /api/assets/:file 后刷新列表 */
  function openMetaDialog(a) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal asset-meta-modal" role="dialog" aria-label="资源信息">
      <div class="pmm-head"><div><h2>✎ 资源信息</h2><div class="sub">${esc(a.file)} · ${fmtBytes(a.size || a.bytes)}</div></div>
        <button class="icon-btn" data-x>✕</button></div>
      <div class="field"><label>展示名（角色资源建议用角色名，便于跨项目匹配）</label>
        <input id="am-name" value="${esc(a.name)}" maxlength="80"></div>
      <div class="field"><label>类型</label>
        <select id="am-kind">${Object.entries(KIND_LABEL).map(([k, v]) => `<option value="${k}" ${(a.kind || 'other') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field"><label>标签（逗号分隔 · 共享给其他项目检索）</label>
        <input id="am-tags" value="${esc((a.tags || []).join(', '))}" placeholder="例如：角色, 古装, 女主"></div>
      ${a.sourceProjectName ? `<div class="cover-note">来源项目：${esc(a.sourceProjectName)}</div>` : ''}
      <div class="modal-actions"><button class="btn" data-x>取消</button>
        <button class="btn primary" data-save>保存</button></div>
    </div>`;
    (document.getElementById('modal-root') || document.body).appendChild(wrap);
    const done = () => wrap.remove();
    wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) done(); });
    wrap.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', done));
    wrap.querySelector('[data-save]').addEventListener('click', async () => {
      const btn = wrap.querySelector('[data-save]');
      btn.disabled = true;
      try {
        await api(`/api/assets/${encodeURIComponent(a.file)}`, {
          name: wrap.querySelector('#am-name').value,
          kind: wrap.querySelector('#am-kind').value,
          tags: wrap.querySelector('#am-tags').value,
        }, 'PATCH');
        toast('资源信息已保存', 'ok');
        done();
        await load(); render();
      } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
    });
    wrap.querySelector('#am-name').focus();
  }

  const root = $('modal-root') || document.body;
  root.appendChild(backdrop);
  load().then(render).catch((err) => { close(); toast(err.message, 'err'); });
  return backdrop;
}
