/* ============================================================================
 * 全局资源库：data/assets/ 下已生成资源的统一管理与复用选择。
 * manage 模式 = 顶栏入口（类型/标签/来源项目筛选 · 搜索 · 改名打标 · 预览 · 删除）；
 * pick 模式 = 封面弹窗、节点检查器的「从资源库选择」取图入口。
 * 元数据（kind/name/tags/来源项目）来自 GET /api/assets 的 index.json 索引，
 * 改名与打标走 PATCH /api/assets/:file，供跨项目共享与角色优先匹配检索。
 * 纯自主实现，无框架依赖；弹窗结构照搬 openCoverDialog 的 backdrop 模式。
 * ==========================================================================*/
import { toast } from './panels.js';
import { collectProjectAssets } from './project-sidebar.js';
import { openPage } from './page.js';
import { $, esc, cut } from './utils.js';

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

const TYPE_LABEL = { image: '图片', video: '视频', audio: '音频', other: '其他' };
const KIND_LABEL = { cover: '封面', character: '角色', image: '图片', video: '视频', audio: '音色', pack: '导演包', other: '其他' };
const KIND_ORDER = ['all', 'character', 'cover', 'image', 'video', 'audio', 'pack', 'other'];
const SORTS = {
  new:   { label: '最新优先', fn: (a, b) => (b.createdAt || 0) - (a.createdAt || 0) },
  old:   { label: '最早优先', fn: (a, b) => (a.createdAt || 0) - (b.createdAt || 0) },
  big:   { label: '大 → 小', fn: (a, b) => (b.bytes || 0) - (a.bytes || 0) },
  small: { label: '小 → 大', fn: (a, b) => (a.bytes || 0) - (b.bytes || 0) },
  name:  { label: '名称 A→Z', fn: (a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN') },
};

/** 单元格视觉：图片直接缩略、视频用静帧预览、音频给播放器、其余按扩展名块呈现 */
function cellMedia(a) {
  if (a.type === 'image') return `<img loading="lazy" src="${esc(a.url)}" alt="${esc(a.name)}">`;
  if (a.type === 'video') return `<video src="${esc(a.url)}" muted controls preload="metadata" playsinline></video>`;
  // 音频没有画面，缩略图格里只放一个紧凑播放器；不给播放器就只能看到 .MP3 扩展名块，抽卡候选听着像不存在
  if (a.type === 'audio') return `<div class="asset-audio"><audio src="${esc(a.url)}" controls preload="metadata"></audio></div>`;
  return `<span class="asset-ext">${esc((a.ext || '?').toUpperCase())}</span>`;
}

/**
 * 打开资源库弹窗。
 * @param {object} o
 * @param {'manage'|'pick'} o.mode    manage=管理（筛选/搜索/打标/预览/删除）；pick=选择并回调
 * @param {'all'|'image'|'video'} o.accept  pick 模式下限制可选类型
 * @param {boolean} [o.multi]        pick 模式多选：点击勾选，确认后按勾选顺序回调全部所选
 * @param {string[]} [o.files]      manage 模式限定只显示这些文件（项目侧栏的「本项目资源」）
 * @param {object} [o.project]      项目会话：按项目 JSON 引用动态算出白名单，默认「仅本项目」
 * @param {(asset)=>void} o.onPick    pick 模式选中回调；multi 模式下回调资产数组
 */
export function openAssetLibrary(o = {}) {
  const mode = o.mode === 'pick' ? 'pick' : 'manage';
  const multi = mode === 'pick' && o.multi === true;
  const accept = ['image', 'video'].includes(o.accept) ? o.accept : 'all';
  let fileScope = Array.isArray(o.files) ? new Set(o.files) : null; // 项目侧栏传入的资源白名单
  let scopeProject = o.project || null;   // 项目会话打开：每次重载都按最新项目数据重算范围
  let assets = [];
  let stats = null;
  let filter = 'all';            // 类型/角色筛选（kind 优先，回退 type）
  let tagFilter = '';            // 标签筛选
  let projectFilter = '';        // 来源项目筛选
  let query = '';                // 名称 / 标签搜索
  let sortBy = 'new';            // 排序方式（SORTS 键）
  let selMode = false;           // 多选模式（manage）
  const selSet = new Set();      // 多选选中的 file 集合
  const page = openPage({ title: '▣ 资源库', sub: '', variant: 'wide' });
  const backdrop = page.content;
  const close = () => page.close();

  const load = async () => {
    const d = await api('/api/assets');
    const all = d.assets || [];
    assets = all;
    stats = d.stats || null;
    if (accept !== 'all') assets = assets.filter((a) => a.type === accept);
    // 项目会话：以项目 JSON 的 /assets/ 引用 + 索引里的 sourceProjectId 为准；
    // 产物落盘后重新载入也不会漏掉新资源。点「查看全部资源」可退出范围。
    if (scopeProject) fileScope = new Set(collectProjectAssets(scopeProject, all).map((a) => a.file));
    if (fileScope) assets = assets.filter((a) => fileScope.has(a.file));
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
    }).sort(SORTS[sortBy]?.fn || SORTS.new.fn);
  }

  /** 多选挑选模式：勾选变化后就地刷新计数 / 按钮（不重绘，保持滚动与焦点） */
  function updatePickBar() {
    backdrop.querySelectorAll('.asset-selbar b').forEach((b) => { b.textContent = String(selSet.size); });
    backdrop.querySelectorAll('[data-pick-confirm]').forEach((b) => {
      b.toggleAttribute('disabled', !selSet.size);
      b.textContent = `✓ 使用所选（${selSet.size}）`;
    });
    backdrop.querySelector('[data-sel-clear]')?.toggleAttribute('disabled', !selSet.size);
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
    const scopeChip = fileScope
      ? `<button class="asset-chip proj on" data-unscope title="退出本项目范围，查看全部资源">⌂ 仅${scopeProject?.name ? `「${esc(cut(scopeProject.name, 10))}」` : '本项目'} · 查看全部资源 ✕</button>` : '';

    const grid = gridHTML(shown);

    const st = fileScope
      ? `${scopeProject?.name ? `「${esc(cut(scopeProject.name, 12))}」` : '本项目'} ${assets.length} 项`
      : (stats ? `共 ${stats.total} 项 · ${fmtBytes(stats.bytes)}${stats.tagCount ? ` · ${stats.tagCount} 个标签` : ''}` : `${assets.length} 项`);
    page.setSub(mode === 'pick' ? (multi ? '点击勾选，可多选后按勾选顺序使用' : '点击资源即可选用') : `${st} · 生成的封面 / 角色 / 片段统一管理，可打标签跨项目复用`);
    backdrop.innerHTML = `<div class="asset-toolbar">
        <div class="asset-filters">${kindChips}</div>
        <div class="asset-toolbar-right">
          <select id="asset-sort" class="asset-sort" title="排序方式">
            ${Object.entries(SORTS).map(([k, s]) => `<option value="${k}" ${sortBy === k ? 'selected' : ''}>${s.label}</option>`).join('')}
          </select>
          <input class="asset-search" id="asset-search" type="search" placeholder="搜索名称 / 标签 / 来源项目…" value="${esc(query)}">
        </div>
      </div>
      ${(tagChips || projChips || scopeChip) ? `<div class="asset-filters sub">${scopeChip}${tagChips}${projChips}${activeTags}</div>` : ''}
      ${multi ? `<div class="asset-selbar"><b>${selSet.size}</b> 项已选（按勾选顺序返回）
        <button class="btn sm" data-sel-all>全选本页</button>
        <button class="btn sm" data-sel-clear ${selSet.size ? '' : 'disabled'}>清空</button>
        <button class="btn sm primary" data-pick-confirm ${selSet.size ? '' : 'disabled'}>✓ 使用所选（${selSet.size}）</button></div>` : ''}
      ${selMode && mode === 'manage' ? `<div class="asset-selbar"><b>${selSet.size}</b> 项已选
        <button class="btn sm" data-sel-all>全选本页</button>
        <button class="btn sm primary" data-batch-tag ${selSet.size ? '' : 'disabled'}>批量打标</button>
        <button class="btn sm danger" data-batch-del ${selSet.size ? '' : 'disabled'}>删除所选</button>
        <button class="btn sm" data-sel-exit>退出多选</button></div>` : ''}
      <div class="asset-scroll">${grid}</div>
      <div class="modal-actions">${mode === 'manage' ? `<button class="btn" data-act="orphan" title="删除未被任何项目引用的资源">⌫ 清理孤儿</button>
        <button class="btn" data-act="reindex">↻ 重扫目录</button>
        <button class="btn${selMode ? ' primary' : ''}" data-act="sel-toggle">${selMode ? '☑ 完成多选' : '☑ 多选'}</button>` : ''}
        ${multi ? `<button class="btn primary" data-pick-confirm ${selSet.size ? '' : 'disabled'}>✓ 使用所选（${selSet.size}）</button>` : ''}
        <button class="btn" data-act="close">关闭</button></div>`;

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
    backdrop.querySelector('#asset-sort')?.addEventListener('change', (e) => { sortBy = e.target.value; render(); });
    backdrop.querySelector('[data-act="sel-toggle"]')?.addEventListener('click', () => { selMode = !selMode; if (!selMode) selSet.clear(); render(); });
    backdrop.querySelector('[data-sel-exit]')?.addEventListener('click', () => { selMode = false; selSet.clear(); render(); });
    backdrop.querySelector('[data-sel-all]')?.addEventListener('click', () => { visible().forEach((a) => selSet.add(a.file)); render(); });
    backdrop.querySelector('[data-batch-del]')?.addEventListener('click', async () => {
      const files = [...selSet];
      if (!files.length) return;
      if (!confirm(`确定删除选中的 ${files.length} 项资源？被项目引用的资源会自动跳过。`)) return;
      try {
        const d = await api('/api/assets/batch-delete', { files }, 'POST');
        selSet.clear();
        toast(`已删除 ${d.deleted.length} 项${d.blocked.length ? `，${d.blocked.length} 项被项目引用已跳过` : ''}`, d.blocked.length ? 'warn' : 'ok');
        await load(); render();
      } catch (err) { toast(err.message, 'err'); }
    });
    backdrop.querySelector('[data-batch-tag]')?.addEventListener('click', () => batchTagDialog());
    backdrop.querySelector('[data-sel-clear]')?.addEventListener('click', () => { selSet.clear(); render(); });
    backdrop.querySelectorAll('[data-pick-confirm]').forEach((btn) => btn.addEventListener('click', () => {
      if (!selSet.size) return;
      // 按勾选顺序返回（Set 保持插入序），供多参考图这类「顺序有意义」的场景使用
      const list = [...selSet].map((file) => assets.find((a) => a.file === file)).filter(Boolean);
      close();
      o.onPick?.(list);
    }));
    backdrop.querySelector('[data-act="orphan"]')?.addEventListener('click', async () => {
      try {
        const d = await api('/api/assets/orphans');
        if (!d.count) { toast('没有孤儿资源，所有资源都被项目引用着', 'ok'); return; }
        if (!confirm(`发现 ${d.count} 项未被任何项目引用的孤儿资源（共 ${fmtBytes(d.bytes)}），确认全部删除？`)) return;
        const r = await api('/api/assets/batch-delete', { files: d.orphans.map((x) => x.file) }, 'POST');
        selSet.clear();
        toast(`已清理 ${r.deleted.length} 项孤儿资源（${fmtBytes(r.bytes)}）`, 'ok');
        await load(); render();
      } catch (err) { toast(err.message, 'err'); }
    });
    backdrop.querySelectorAll('[data-tag]').forEach((c) => c.addEventListener('click', () => { tagFilter = tagFilter === c.dataset.tag ? '' : c.dataset.tag; render(); }));
    backdrop.querySelectorAll('[data-proj]').forEach((c) => c.addEventListener('click', () => { projectFilter = projectFilter === c.dataset.proj ? '' : c.dataset.proj; render(); }));
    backdrop.querySelector('[data-unscope]')?.addEventListener('click', async () => {
      fileScope = null; scopeProject = null; filter = 'all'; projectFilter = ''; tagFilter = ''; query = '';
      await load(); render();
    });
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
      if (!list.length) {
        const empty = fileScope && !assets.length
          ? '当前项目还没有资源<br><small>生成封面、角色定妆图、运行流水线或导出导演包后会自动出现在这里</small>'
          : assets.length ? '没有匹配的资源<br><small>试试清除筛选或换个关键词</small>'
            : '资源库为空——生成封面、运行流水线后，产出会自动收录到这里';
        return `<div class="asset-empty">${empty}</div>`;
      }
      return `<div class="asset-grid">${list.map((a) => `<div class="asset-cell${selSet.has(a.file) ? ' selected' : ''}" data-file="${esc(a.file)}" title="${esc(a.name)}">
          <div class="asset-media">${cellMedia(a)}</div>
          <div class="asset-meta">
            <span class="asset-name" title="${esc(a.name)}">${esc(a.name)}</span>
            <span class="asset-sub"><b class="asset-kind k-${esc(a.kind || 'other')}">${KIND_LABEL[a.kind] || TYPE_LABEL[a.type] || '其他'}</b> ${fmtBytes(a.size || a.bytes)} · ${fmtTime(a.createdAt || a.mtime)}</span>
            ${(a.tags || []).length ? `<span class="asset-tags">${a.tags.map((t) => `<i>#${esc(t)}</i>`).join('')}</span>` : ''}
            ${a.sourceProjectName ? `<span class="asset-src" title="来源项目">⌂ ${esc(a.sourceProjectName)}</span>` : ''}
          </div>
          ${multi ? `<span class="asset-check${selSet.has(a.file) ? ' on' : ''}">${selSet.has(a.file) ? '✓' : ''}</span>`
            : mode === 'pick' ? '<span class="asset-pick-badge">选择</span>'
            : selMode ? `<span class="asset-check${selSet.has(a.file) ? ' on' : ''}">${selSet.has(a.file) ? '✓' : ''}</span>`
            : `<button class="asset-del" data-del="${esc(a.file)}" title="删除资源">✕</button>`}
        </div>`).join('')}</div>`;
    }

    bindCells();
    function bindCells() {
      backdrop.querySelectorAll('.asset-cell').forEach((cell) => cell.addEventListener('click', (e) => {
        if (e.target.closest('[data-del]') || e.target.closest('[data-edit]')) return;
        const a = assets.find((x) => x.file === cell.dataset.file);
        if (!a) return;
        if (mode === 'pick') {
          if (!multi) { close(); o.onPick?.(a); return; }
          // 多选：点击 = 勾选/取消，确认后按勾选顺序一次性回调
          if (selSet.has(a.file)) selSet.delete(a.file); else selSet.add(a.file);
          cell.classList.toggle('selected', selSet.has(a.file));
          cell.querySelector('.asset-check')?.classList.toggle('on', selSet.has(a.file));
          cell.querySelector('.asset-check')?.replaceChildren(selSet.has(a.file) ? '✓' : '');
          updatePickBar();
          return;
        }
        // 多选模式下点击 = 勾选/取消；单选模式点击 = 预览
        if (selMode) {
          if (selSet.has(a.file)) selSet.delete(a.file); else selSet.add(a.file);
          cell.classList.toggle('selected', selSet.has(a.file));
          cell.querySelector('.asset-check')?.classList.toggle('on', selSet.has(a.file));
          const bar = backdrop.querySelector('.asset-selbar b');
          if (bar) bar.textContent = String(selSet.size);
          backdrop.querySelector('[data-batch-del]')?.toggleAttribute('disabled', !selSet.size);
          backdrop.querySelector('[data-batch-tag]')?.toggleAttribute('disabled', !selSet.size);
          return;
        }
        if (a.type === 'image' || a.type === 'video') openPreview(a);
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

  /** 改名 / 打标签 / 改类型子页：PATCH /api/assets/:file 后刷新列表 */
  function openMetaDialog(a) {
    const sub = openPage({ title: '✎ 资源信息', sub: `${a.file} · ${fmtBytes(a.size || a.bytes)}` });
    const wrap = sub.content;
    wrap.innerHTML = `<div class="field"><label>展示名（角色资源建议用角色名，便于跨项目匹配）</label>
        <input id="am-name" value="${esc(a.name)}" maxlength="80"></div>
      <div class="field"><label>类型</label>
        <select id="am-kind">${Object.entries(KIND_LABEL).map(([k, v]) => `<option value="${k}" ${(a.kind || 'other') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field"><label>标签（逗号分隔 · 共享给其他项目检索）</label>
        <input id="am-tags" value="${esc((a.tags || []).join(', '))}" placeholder="例如：角色, 古装, 女主"></div>
      ${a.sourceProjectName ? `<div class="cover-note">来源项目：${esc(a.sourceProjectName)}</div>` : ''}
      <div class="modal-actions"><button class="btn" data-x>取消</button>
        <button class="btn primary" data-save>保存</button></div>`;
    const done = () => sub.close();
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

  /** 增强预览子页：大图/视频/音频 + 完整信息 + 下载 / 复制链接 / 编辑信息 */
  function openPreview(a) {
    const isVideo = a.type === 'video';
    const isAudio = a.type === 'audio';
    const sub = openPage({ title: `👁 ${a.name}`, sub: a.file, variant: 'wide' });
    const wrap = sub.content;
    const media = isVideo
      ? `<video src="${esc(a.url)}" controls autoplay loop playsinline></video>`
      : isAudio
        ? `<audio src="${esc(a.url)}" controls autoplay preload="metadata"></audio>`
        : `<img src="${esc(a.url)}" alt="${esc(a.name)}">`;
    wrap.innerHTML = `<div class="asset-preview-media${isAudio ? ' is-audio' : ''}">${media}</div>
      <div class="asset-info">
        <div><span>类型</span><b class="asset-kind k-${esc(a.kind || 'other')}">${KIND_LABEL[a.kind] || TYPE_LABEL[a.type] || '其他'}</b></div>
        <div><span>大小</span><b>${fmtBytes(a.size || a.bytes)}</b></div>
        <div><span>收录时间</span><b>${fmtTime(a.createdAt || a.mtime)}</b></div>
        <div><span>标签</span><b>${(a.tags || []).length ? a.tags.map((t) => `<i class="pv-tag">#${esc(t)}</i>`).join(' ') : '—'}</b></div>
        <div><span>来源项目</span><b>${a.sourceProjectName ? esc(a.sourceProjectName) : '—'}</b></div>
      </div>
      <div class="modal-actions">
        <a class="btn" href="${esc(a.url)}" download="${esc(a.file)}" data-dl>⇩ 下载原文件</a>
        <button class="btn" data-copy>⧉ 复制链接</button>
        <button class="btn" data-edit>✎ 编辑信息</button>
        <button class="btn primary" data-x>关闭</button>
      </div>`;
    const done = () => sub.close();
    wrap.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', done));
    wrap.querySelector('[data-copy]').addEventListener('click', async () => {
      const abs = location.origin + a.url;
      try { await navigator.clipboard.writeText(abs); toast('链接已复制', 'ok'); }
      catch {
        const input = document.createElement('input');
        input.value = abs; wrap.appendChild(input); input.select();
        document.execCommand('copy'); input.remove(); toast('链接已复制', 'ok');
      }
    });
    wrap.querySelector('[data-edit]').addEventListener('click', () => { done(); openMetaDialog(a); });
  }

  /** 批量打标子页：把同一组标签追加到多选的资源上 */
  function batchTagDialog() {
    const files = [...selSet];
    if (!files.length) return;
    const sub = openPage({ title: '# 批量打标', sub: `将为选中的 ${files.length} 项资源追加标签` });
    const wrap = sub.content;
    wrap.innerHTML = `<div class="field"><label>标签（逗号分隔 · 追加到现有标签之后）</label>
        <input id="am-btags" placeholder="例如：第2幕, 夜景"></div>
      <div class="modal-actions"><button class="btn" data-x>取消</button>
        <button class="btn primary" data-save>应用</button></div>`;
    const done = () => sub.close();
    wrap.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', done));
    wrap.querySelector('[data-save]').addEventListener('click', async () => {
      const raw = wrap.querySelector('#am-btags').value;
      const tags = raw.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
      if (!tags.length) { toast('请至少输入一个标签', 'err'); return; }
      const btn = wrap.querySelector('[data-save]');
      btn.disabled = true;
      try {
        let ok = 0;
        for (const file of files) {
          const a = assets.find((x) => x.file === file);
          if (!a) continue;
          const merged = [...new Set([...(a.tags || []), ...tags])];
          await api(`/api/assets/${encodeURIComponent(file)}`, { tags: merged.join(', ') }, 'PATCH');
          ok += 1;
        }
        toast(`已为 ${ok} 项资源追加标签 ${tags.map((t) => '#' + t).join(' ')}`, 'ok');
        selSet.clear();
        done();
        await load(); render();
      } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
    });
    wrap.querySelector('#am-btags').focus();
  }

  load().then(render).catch((err) => { close(); toast(err.message, 'err'); });
  return backdrop;
}
