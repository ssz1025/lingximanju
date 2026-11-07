/* ============================================================================
 * 项目侧栏（Project Sidebar）—— 打开项目后左侧只讲「当前项目」
 *
 * 与旧版的区别：进入项目后不再显示「项目管理 / 全部项目卡片」，
 * 改为：项目卡与六步进度 → 项目导航（工作台 / 画布 / 剧集）
 *      → 本项目资源列表（封面 / 角色 / 分镜图 / 视频 / 导演包）
 *      → 项目设置（创作设定 / 角色 / 交付物 / 封面 / 模型 / 导出）
 * 点项目卡上的 ✕ / 顶栏 × / ⌂ 项目列表 / H 会真正关闭项目会话（清空项目态），
 * 回到项目列表页后才能切换、新建、导入项目。
 * 画布工具（模板 / 节点库 / 智能体）仍由 index.html 的 #side-canvas-tools
 * 承载，仅在画布视图显示，不占用工作台 / 剧集详情的侧栏空间。
 *
 * 资源归属：以「项目 JSON 里引用到的 /assets/ URL」为准（最可靠，覆盖
 * 角色视图、封面、宫格图、节点产物、剧集导演包等所有落点），再补上资产索引
 * 里 sourceProjectId === 当前项目的条目，避免索引未回写时漏项。
 * 零第三方依赖，原生 ESM；collectProjectAssets 是纯函数，可在 Node 下单测。
 * ==========================================================================*/
const esc = (s = '') => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cut = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };
const fmtBytes = (b) => !b ? '—' : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
const fmtTime = (ts) => ts ? new Date(Number(ts)).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '';
const KIND_LABEL = { cover: '封面', character: '角色', image: '图片', video: '视频', pack: '导演包', other: '文件' };
const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'image', label: '图片' },
  { key: 'video', label: '视频' },
  { key: 'pack', label: '导演包' },
  { key: 'other', label: '其他' },
];
const PAGE_SIZE = 5;   // 首屏给「项目设置」留位置；其余项点「展开」或进资源库查看

function typeFromExt(file) {
  const ext = String(file).split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'bmp'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video';
  if (['zip', 'mmxpack', 'pack'].includes(ext)) return 'pack';
  return 'other';
}
function normalizeType(t, file) {
  const s = String(t || '').toLowerCase();
  if (['image', 'video', 'pack', 'other'].includes(s)) return s;
  if (s === 'cover' || s === 'character') return 'image';
  return typeFromExt(file);
}
function kindOf(kind, file) {
  const s = String(kind || '').toLowerCase();
  if (Object.hasOwn(KIND_LABEL, s)) return s;
  return typeFromExt(file);
}

/**
 * 收集「当前项目」的资源。纯函数，不碰 DOM / 网络。
 * @param {object} project 项目 JSON（递归扫描所有字符串里的 /assets/ 引用）
 * @param {Array}  index   GET /api/assets 返回的资产索引条目
 * @returns {Array} 统一结构的资源列表，按创建时间倒序
 */
export function collectProjectAssets(project, index = []) {
  if (!project || typeof project !== 'object') return [];
  const list = Array.isArray(index) ? index : [];
  const refs = new Set();
  const URL_RE = /\/assets\/([A-Za-z0-9._%\-/]+)/g;
  const walk = (v, depth = 0) => {
    if (v == null || depth > 14) return;
    if (typeof v === 'string') {
      URL_RE.lastIndex = 0;
      let m;
      while ((m = URL_RE.exec(v))) {
        const raw = m[1].replace(/[?#].*$/, '').replace(/["'\s<>)]+$/, '');
        let file;
        try { file = decodeURIComponent(raw); } catch { file = raw; }
        if (file && file !== '.gitkeep' && /\.[a-z0-9]{1,8}$/i.test(file)) refs.add(file);
      }
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === 'object') { for (const k of Object.keys(v)) walk(v[k], depth + 1); }
  };
  walk(project);

  const byFile = new Map(list.map((a) => [String(a?.file || ''), a || {}]));
  const files = new Set(refs);
  for (const a of list) {
    const file = String(a?.file || '');
    if (project.id && a?.sourceProjectId === project.id && file !== '.gitkeep' && /\.[a-z0-9]{1,8}$/i.test(file)) files.add(file);
  }
  return [...files].map((file) => {
    const it = byFile.get(file) || {};
    return {
      file,
      url: it.url || `/assets/${file}`,
      name: it.name || String(file).split('/').pop(),
      type: normalizeType(it.type || it.kind, file),
      kind: kindOf(it.kind, file),
      bytes: Number(it.bytes) || 0,
      createdAt: Number(it.createdAt) || 0,
      tags: Array.isArray(it.tags) ? it.tags : [],
      referenced: refs.has(file),
    };
  }).sort((a, b) => (b.createdAt - a.createdAt) || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
}

/**
 * 项目会话的「外壳文案」：进入项目后顶栏品牌、侧栏页脚、状态栏、资源库入口
 * 全部改成只讲当前项目；关闭项目（回到列表）后恢复中性的应用级文案。
 * 纯函数，不碰 DOM，便于单测。
 * @param {object|null} project 当前项目；null = 项目列表页
 * @param {object} [opts] {view, episodeNo, projectCount}
 */
export function projectChrome(project, opts = {}) {
  const { view = 'home', episodeNo = 0, projectCount = 0 } = opts;
  const home = {
    brandTitle: 'lingximanju',
    brandSub: '无限画布 · 智能体制片',
    foot: '本地运行 · 数据仅保存在 data/',
    homeStatus: `共 ${projectCount} 个项目`,
    assetLibTitle: '资源库：全部项目已生成资源统一管理',
    inProject: false,
  };
  if (!project || typeof project !== 'object' || view === 'home') return home;
  const m = project.management || {};
  const eps = Array.isArray(m.episodes) ? m.episodes.length : 0;
  const nodes = Array.isArray(project.nodes) ? project.nodes.length : 0;
  const edges = Array.isArray(project.edges) ? project.edges.length : 0;
  const name = String(project.name || '未命名项目');
  const titles = { workshop: '项目工作台', canvas: '画布编辑', episode: '剧集详情' };
  const isNovel = m.kind === 'novel';
  const foot = isNovel
    ? `本项目 · ${eps} 集 · ${nodes} 节点 · 数据保存在 data/`
    : `本项目 · ${nodes} 节点 · ${edges} 连线 · 数据保存在 data/`;
  return {
    brandTitle: titles[view] || '项目工作台',
    brandSub: view === 'episode' ? `${name} · 第 ${Number(episodeNo) || 1} 集` : name,
    foot,
    homeStatus: '',
    assetLibTitle: `本项目资源库 · ${name}`,
    inProject: true,
  };
}

/* ---------------------------------------------------------------- 模块状态 */
const ui = { projectId: null, filter: 'all', showAll: false };
let latestCtx = {};
let currentAssets = [];
let indexCache = { at: 0, list: [] };
let renderSeq = 0;

/** 产物落盘（SSE）后调用：让下一次渲染强制重取资产索引 */
export function invalidateAssets() { indexCache.at = 0; }

async function fetchIndex(force = false) {
  if (!force && indexCache.list.length && Date.now() - indexCache.at < 10000) return indexCache.list;
  try {
    const res = await fetch('/api/assets');
    const d = await res.json();
    indexCache = { at: Date.now(), list: Array.isArray(d.assets) ? d.assets : [] };
  } catch { indexCache = { at: Date.now(), list: [] }; }
  return indexCache.list;
}

/* ---------------------------------------------------------------- 结构渲染 */
function coverHTML(p) {
  const url = p.management?.cover?.url;
  return `<span class="ps-cover">${url
    ? `<img src="${esc(url)}" alt="">`
    : `<i>${esc(String(p.name || '未')[0])}</i>`}</span>`;
}

function shellHTML(p, ctx) {
  const m = p.management || {};
  const steps = (m.steps?.length ? m.steps : (ctx.steps || []).map((s) => ({ id: s.id, status: 'pending' })));
  const total = steps.length || 6;
  const done = steps.filter((s) => s.status === 'done').length;
  const percent = total ? Math.round(done / total * 100) : 0;
  const eps = Array.isArray(m.episodes) ? m.episodes : [];
  const kindLabel = m.kind === 'novel' ? '小说分集创作' : '标准流水线';
  const v = ctx.view || 'workshop';
  return `
    <div class="ps-head">
      ${coverHTML(p)}
      <div class="ps-head-main">
        <strong title="${esc(p.name)}">${esc(cut(p.name || '未命名项目', 12))}</strong>
        <small>${kindLabel} · ${eps.length} 集</small>
      </div>
      <button class="ps-home-btn" data-act="home" title="关闭当前项目，返回项目列表（切换 / 新建 / 导入项目）" aria-label="关闭项目">✕</button>
    </div>
    <div class="ps-progress"><i style="width:${percent}%"></i></div>
    <div class="ps-progress-label"><span>六步进度</span><b>${done}/${total}</b></div>

    <section class="side-section ps-section">
      <div class="section-head"><span>项目导航</span><span class="section-hint">${v === 'episode' ? `第 ${ctx.episodeNo || 1} 集` : ''}</span></div>
      <nav class="ps-nav">
        <button data-nav="workshop" class="${v === 'workshop' || v === 'episode' ? 'on' : ''}">▦ 工作台</button>
        <button data-nav="canvas" class="${v === 'canvas' ? 'on' : ''}">⬡ 画布</button>
        <button data-nav="manage">▤ 管理</button>
      </nav>
      ${eps.length ? `<div class="ps-eps">
        <div class="ps-eps-head"><span>剧集</span><button data-act="episodes">全部 ${eps.length} 集 ›</button></div>
        <div class="ps-eps-list">${eps.slice(0, 3).map((e) => `<button data-ep="${Number(e.no) || 0}" class="${v === 'episode' && Number(ctx.episodeNo) === Number(e.no) ? 'on' : ''}" title="${esc(e.title || `第 ${e.no} 集`)}"><i>${Number(e.no) || '·'}</i><span>${esc(cut(e.title || `第 ${e.no} 集`, 11))}</span></button>`).join('')}</div>
      </div>` : ''}
    </section>

    <section class="side-section ps-section">
      <div class="section-head"><span>项目资源</span><span class="section-hint" id="ps-count">…</span></div>
      <div class="ps-filters" id="ps-filters"></div>
      <div class="ps-assets" id="ps-assets"></div>
      <div class="ps-asset-acts">
        <button class="mini-btn" data-act="assets">▣ 在资源库中管理</button>
        <button class="mini-btn" data-act="refresh-assets" title="重新扫描本项目资源">↻ 刷新</button>
      </div>
    </section>

    <section class="side-section ps-section">
      <div class="section-head"><span>项目设置</span></div>
      <div class="ps-settings">
        <button data-act="overview" title="项目概览：名称 / 备注 / 收藏 / 封面"><b>▦</b>项目信息</button>
        <button data-act="bible" title="类型 / 受众 / 基调 / 画风等创作设定"><b>✎</b>创作设定</button>
        <button data-act="characters" title="角色库与定妆图"><b>👤</b>角色</button>
        <button data-act="deliverables" title="交付物与产物下载"><b>✦</b>交付物</button>
        <button data-act="cover" title="设置项目封面"><b>🖼</b>项目封面</button>
        <button data-act="settings" title="文本大模型 / ComfyUI 工作流（全局）"><b>⚙</b>模型设置</button>
        <button data-act="export" title="导出当前项目 JSON"><b>⇩</b>导出项目</button>
      </div>
    </section>`;
}

function paintAssets(host, assets) {
  if (!host || !host.isConnected) return;
  currentAssets = assets;
  const count = host.querySelector('#ps-count');
  const filters = host.querySelector('#ps-filters');
  const box = host.querySelector('#ps-assets');
  if (!count || !filters || !box) return;
  count.textContent = `${assets.length} 项`;
  const of = (key) => key === 'all' ? assets.length : assets.filter((a) => a.type === key).length;
  filters.innerHTML = FILTERS.filter((f) => f.key === 'all' || of(f.key))
    .map((f) => `<button data-kind="${f.key}" class="${ui.filter === f.key ? 'on' : ''}">${f.label} ${of(f.key)}</button>`).join('');
  const shown = ui.filter === 'all' ? assets : assets.filter((a) => a.type === ui.filter);
  const visible = ui.showAll ? shown : shown.slice(0, PAGE_SIZE);
  if (!shown.length) {
    box.innerHTML = `<div class="ps-empty">${assets.length ? '该类型暂无资源' : '还没有项目资源<br><small>生成封面、角色定妆图或运行流水线后会自动出现在这里</small>'}</div>`;
  } else {
    box.innerHTML = visible.map((a) => {
      const thumb = a.type === 'image'
        ? `<img src="${esc(a.url)}" alt="" loading="lazy">`
        : `<i class="t-${a.type}">${a.type === 'video' ? '▶' : a.type === 'pack' ? '▤' : '◇'}</i>`;
      return `<button class="ps-asset" data-file="${esc(a.file)}" title="${esc(a.name)} · ${fmtBytes(a.bytes)}">
        <span class="ps-asset-thumb">${thumb}</span>
        <span class="ps-asset-main"><strong>${esc(cut(a.name, 15))}</strong>
          <small>${KIND_LABEL[a.kind] || '文件'}${a.bytes ? ` · ${fmtBytes(a.bytes)}` : ''}${a.createdAt ? ` · ${fmtTime(a.createdAt)}` : ''}</small></span>
      </button>`;
    }).join('') + (shown.length > visible.length
      ? `<button class="ps-more" data-act="more">展开其余 ${shown.length - visible.length} 项 ▾</button>` : '');
  }
}

/* ---------------------------------------------------------------- 预览弹窗 */
function openAssetPreview(a) {
  if (!a) return;
  const root = document.getElementById('modal-root');
  if (!root) return;
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  const media = a.type === 'image'
    ? `<img class="ps-preview-media" src="${esc(a.url)}" alt="${esc(a.name)}">`
    : a.type === 'video'
      ? `<video class="ps-preview-media" src="${esc(a.url)}" controls playsinline preload="metadata"></video>`
      : `<div class="ps-preview-file"><b>${esc(String(a.file).split('.').pop().toUpperCase())}</b><span>${esc(a.name)}</span><small>此类型请在资源库中下载后查看</small></div>`;
  back.innerHTML = `<div class="modal ps-preview" role="dialog" aria-label="资源预览">
    <div class="pmm-head"><div><h2>${esc(cut(a.name, 30))}</h2>
      <div class="sub">${KIND_LABEL[a.kind] || '文件'} · ${fmtBytes(a.bytes)}${a.createdAt ? ` · ${fmtTime(a.createdAt)}` : ''}${a.tags?.length ? ` · ${esc(a.tags.slice(0, 3).join(' / '))}` : ''}</div></div>
      <button class="icon-btn" data-close aria-label="关闭">✕</button></div>
    <div class="ps-preview-body">${media}</div>
    <div class="modal-actions">
      <button class="btn" data-lib>▣ 在资源库中查看</button>
      <a class="btn" href="${esc(a.url)}" download="${esc(a.file)}">⇩ 下载</a>
      <button class="btn primary" data-close>关闭</button>
    </div>
  </div>`;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  back.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  back.querySelector('[data-lib]')?.addEventListener('click', () => {
    close();
    latestCtx.onOpenAssets?.([a.file]);
  });
  root.appendChild(back);
  document.addEventListener('keydown', onKey);
}

/* ---------------------------------------------------------------- 事件委托 */
function onClick(e) {
  const el = e.target.closest('[data-act], [data-nav], [data-kind], [data-file], [data-ep]');
  if (!el) return;
  const c = latestCtx;
  const host = document.getElementById('project-sidebar');
  if (!host || !host.contains(el)) return;

  if (el.dataset.nav) {
    if (el.dataset.nav === 'manage') c.onManage?.();
    else c.onView?.(el.dataset.nav);
    return;
  }
  if (el.dataset.ep) { c.onEpisode?.(Number(el.dataset.ep)); return; }
  if (el.dataset.kind) { ui.filter = el.dataset.kind; ui.showAll = false; paintAssets(host, currentAssets); return; }
  if (el.dataset.file) { openAssetPreview(currentAssets.find((a) => a.file === el.dataset.file)); return; }

  switch (el.dataset.act) {
    case 'home': c.onHome?.(); break;
    case 'episodes': c.onManage?.('episodes'); break;
    case 'assets': c.onOpenAssets?.(currentAssets.map((a) => a.file)); break;
    case 'more': ui.showAll = true; paintAssets(host, currentAssets); break;
    case 'refresh-assets':
      invalidateAssets();
      fetchIndex(true).then((index) => paintAssets(host, collectProjectAssets(c.project, index)))
        .then(() => c.toast?.('项目资源已刷新', 'ok'));
      break;
    case 'overview': c.onManage?.('overview'); break;
    case 'bible': c.onManage?.('bible'); break;
    case 'characters': c.onManage?.('characters'); break;
    case 'deliverables': c.onManage?.('deliverables'); break;
    case 'cover': c.onCover?.(); break;
    case 'settings': c.onSettings?.(); break;
    case 'export': c.onExport?.(); break;
    default: break;
  }
}

/**
 * 渲染项目侧栏。ctx 由 app.js 组装，模块只拿回调，不直接改应用状态。
 * 资源索引异步加载：先用缓存同步出结构，拿到索引后只重绘资源区（不打断其它交互）。
 */
export function renderProjectSidebar(host, ctx = {}) {
  if (!host) return;
  latestCtx = ctx;
  const p = ctx.project;
  const seq = ++renderSeq;
  if (!p) { host.innerHTML = ''; return; }
  if (ui.projectId !== p.id) {
    ui.projectId = p.id; ui.filter = 'all'; ui.showAll = false;
  }
  host.innerHTML = shellHTML(p, ctx);
  host.onclick = onClick;
  paintAssets(host, collectProjectAssets(p, indexCache.list));
  const needFetch = ctx.forceAssets === true || !indexCache.list.length || Date.now() - indexCache.at >= 10000;
  if (!needFetch) return;
  fetchIndex(ctx.forceAssets === true).then((index) => {
    // 期间可能切换了项目 / 视图：丢弃过期结果，避免把别的项目的资源画上来
    if (seq !== renderSeq || !host.isConnected || latestCtx.project?.id !== p.id) return;
    paintAssets(host, collectProjectAssets(latestCtx.project, index));
  });
}
