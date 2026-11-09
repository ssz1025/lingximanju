/* ============================================================================
 * 项目侧栏（Project Sidebar）—— 打开项目后左侧只讲「当前项目」
 *
 * 与旧版的区别：进入项目后不再显示「项目管理 / 全部项目卡片」，
 * 改为：项目卡与六步进度 → 项目导航（工作台 / 画布 / 管理）
 *      → 资源入口 → 项目设置（创作设定 / 角色 / 交付物 / 封面 / 模型 / 导出 / 退出项目）
 * 侧栏只保留功能按钮，不再罗列分季清单与资源清单：
 * 「▥ 分季」「▣ 资源」点击后跳转到工作台的「分集 / 资源」页查看完整列表。
 * 项目会话只有两处退出出口：顶栏右上角「退出项目」与「项目设置 → 退出项目」，
 * 二者都走 app.js 的 requestExitProject()；项目卡上不再放 ✕，避免误触退出。
 * 回到项目列表页后才能切换、新建、导入项目。
 * 画布工具（模板 / 节点库 / 智能体）仍由 index.html 的 #side-canvas-tools
 * 承载，仅在画布视图显示，不占用工作台 / 剧集详情的侧栏空间。
 *
 * 资源归属：以「项目 JSON 里引用到的 /assets/ URL」为准（最可靠，覆盖
 * 角色视图、封面、宫格图、节点产物、剧集导演包等所有落点），再补上资产索引
 * 里 sourceProjectId === 当前项目的条目，避免索引未回写时漏项。
 * 零第三方依赖，原生 ESM；collectProjectAssets 是纯函数，可在 Node 下单测。
 * ==========================================================================*/
import { seasonGroups } from './project-model.js';
import { esc, cut } from './utils.js';

const KIND_LABEL = { cover: '封面', character: '角色', image: '图片', video: '视频', pack: '导演包', other: '文件' };

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
    title: 'lingximanju · 项目列表',
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
  const seasonCount = seasonGroups(project).length;
  const foot = isNovel
    ? `本项目 · ${seasonCount} 季 ${eps} 集 · ${nodes} 节点 · 数据保存在 data/`
    : `本项目 · ${nodes} 节点 · ${edges} 连线 · 数据保存在 data/`;
  return {
    brandTitle: titles[view] || '项目工作台',
    brandSub: view === 'episode' ? `${name} · 第 ${Number(episodeNo) || 1} 集` : name,
    foot,
    homeStatus: '',
    assetLibTitle: `本项目资源库 · ${name}`,
    title: `${name} · ${titles[view] || '项目工作台'}${view === 'episode' ? ` · 第 ${Number(episodeNo) || 1} 集` : ''}`,
    inProject: true,
  };
}

/**
 * 画布工具区的「本项目」统计。纯函数，不碰 DOM / 网络。
 * 模板 / 节点库 / 智能体不再罗列全应用定义，而是以当前项目的节点图为依据标注使用情况。
 * @param {object} project 当前项目
 * @param {object} [nodeTypes] NODE_TYPES（type → {agent} 等定义）
 * @returns {{typeCount: object, agentCount: object, nodeCount: number, templateId: string}}
 */
export function collectToolStats(project, nodeTypes = {}) {
  const nodes = Array.isArray(project?.nodes) ? project.nodes : [];
  const typeCount = {};
  const agentCount = {};
  for (const n of nodes || []) {
    const t = String(n?.type || '');
    if (t) typeCount[t] = (typeCount[t] || 0) + 1;
    const a = String(n?.agent || n?.agentId || nodeTypes[t]?.agent || '');
    if (a) agentCount[a] = (agentCount[a] || 0) + 1;
  }
  return {
    typeCount,
    agentCount,
    nodeCount: nodes.length,
    templateId: String(project?.mode || ''),
  };
}

/* ---------------------------------------------------------------- 模块状态 */
let latestCtx = {};

/** 产物落盘（SSE）后调用：让下一次渲染强制重取资产索引 */
export function invalidateAssets() { /* 侧栏不再缓存资产索引，保留导出以兼容既有调用方 */ }

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
      <div class="ps-links">
        <button data-act="tab-source" title="查看导入原著与数据统计">📖 原著</button>
        <button data-act="tab-episodes" title="按季管理分集与独立画布">▥ 分季</button>
        <button data-act="tab-assets" title="归纳本项目全部资源">▣ 资源</button>
        <button data-act="overall-canvas" title="打开全部组合画布">🌐 组合</button>
      </div>
    </section>

    <section class="side-section ps-section">
      <div class="section-head"><span>资源</span></div>
      <div class="ps-asset-acts">
        <button class="mini-btn" data-act="assets">▣ 打开资源库</button>
        <button class="mini-btn" data-act="refresh-assets" title="重新扫描本项目资源">↻ 刷新</button>
      </div>
    </section>

    <section class="side-section ps-section">
      <div class="section-head"><span>项目设置</span><span class="ps-set-mini">
        <button data-act="theme" title="切换主题 (T)">◐</button>
        <button data-act="help" title="本项目快捷键与操作指引 (?)">?</button>
      </span></div>
      <div class="ps-settings">
        <button data-act="overview" title="项目概览：名称 / 备注 / 收藏 / 封面"><b>▦</b>项目信息</button>
        <button data-act="bible" title="类型 / 受众 / 基调 / 画风等创作设定"><b>✎</b>创作设定</button>
        <button data-act="characters" title="角色库与定妆图"><b>👤</b>角色</button>
        <button data-act="deliverables" title="交付物与产物下载"><b>✦</b>交付物</button>
        <button data-act="cover" title="设置项目封面"><b>🖼</b>项目封面</button>
        <button data-act="settings" title="本项目运行参数（模型库与连接配置为应用级共享）"><b>⚙</b>模型与运行</button>
        <button data-act="export" title="导出当前项目 JSON"><b>⇩</b>导出项目</button>
        <button class="ps-exit" data-act="exit-project" title="退出当前项目，返回项目列表"><b>⇦</b>退出项目</button>
      </div>
    </section>`;
}

/* ---------------------------------------------------------------- 事件委托 */
function onClick(e) {
  const el = e.target.closest('[data-act], [data-nav]');
  if (!el) return;
  const c = latestCtx;
  const host = document.getElementById('project-sidebar');
  if (!host || !host.contains(el)) return;

  if (el.dataset.nav) {
    if (el.dataset.nav === 'manage') c.onManage?.();
    else c.onView?.(el.dataset.nav);
    return;
  }

  switch (el.dataset.act) {
    case 'exit-project': c.onExitProject?.(); break;
    case 'tab-source': c.onWorkshopTab?.('source'); break;
    case 'tab-episodes': c.onWorkshopTab?.('episodes'); break;
    case 'tab-assets': c.onWorkshopTab?.('assets'); break;
    case 'overall-canvas': c.onOverallCanvas?.(); break;
    case 'assets': c.onOpenAssets?.(); break;
    case 'refresh-assets':
      invalidateAssets();
      c.onRefreshAssets?.();
      c.toast?.('项目资源已刷新', 'ok');
      break;
    case 'overview': c.onManage?.('overview'); break;
    case 'bible': c.onManage?.('bible'); break;
    case 'characters': c.onManage?.('characters'); break;
    case 'deliverables': c.onManage?.('deliverables'); break;
    case 'cover': c.onCover?.(); break;
    case 'settings': c.onSettings?.(); break;
    case 'theme': c.onTheme?.(); break;
    case 'help': c.onHelp?.(); break;
    case 'export': c.onExport?.(); break;
    default: break;
  }
}

/**
 * 渲染项目侧栏。ctx 由 app.js 组装，模块只拿回调，不直接改应用状态。
 * 侧栏只保留功能按钮：分季 / 资源等清单统一到工作台对应页查看。
 */
export function renderProjectSidebar(host, ctx = {}) {
  if (!host) return;
  latestCtx = ctx;
  const p = ctx.project;
  if (!p) { host.innerHTML = ''; return; }
  host.innerHTML = shellHTML(p, ctx);
  host.onclick = onClick;
}
