/* ============================================================================
 * 原著 · 导入统计 + 原文阅读器（纯前端视图模块）
 *
 * 契约：export function renderSourceView(host, ctx = {})
 *   - ctx.source 优先；缺省时自行 GET /api/projects/:id/source 后重渲染，期间显示加载态
 *   - 只输出语义化 DOM + `sv-` 前缀类名，样式由宿主 CSS 负责
 *   - 事件全部用 host.onclick / host.oninput 委托，重复渲染不叠加监听
 *   - 顶层不触碰 document / window / localStorage，可在 Node 下 import
 * ==========================================================================*/

/* -------------------------------------------------------------- 共享工具 */
import { str, num as n, fmtNum, cut, esc, escapeHTML, escapeRegExp } from './utils.js';

/** 时间兜底：无效 / 空值显示 '—'，数值字符串按毫秒时间戳处理 */
function fmtDate(v) {
  if (v === '' || v == null) return '—';
  const raw = typeof v === 'number' ? v : (/^\d+$/.test(str(v)) ? Number(v) : v);
  if (!raw) return '—';
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('zh-CN');
}

/* ---------------------------------------------------------------- 模块状态 */
/* 默认全文阅读：导入后第一眼就能看到完整原著；点目录切到「按章」 */
const ui = { projectId: undefined, mode: 'full', chapterNo: 1, query: '' };
let current = { ctx: {}, source: null, host: null };
let renderSeq = 0;

const EMPTY_SOURCE = { ok: false, stats: {}, chapters: [], sources: [], episodes: [], text: '' };

function normalize(src) {
  const s = src && typeof src === 'object' ? src : {};
  return {
    ok: Boolean(s.ok),
    stats: s.stats && typeof s.stats === 'object' ? s.stats : {},
    chapters: Array.isArray(s.chapters) ? s.chapters : [],
    sources: Array.isArray(s.sources) ? s.sources : [],
    episodes: Array.isArray(s.episodes) ? s.episodes : [],
    text: str(s.text),
  };
}

/* ------------------------------------------------------------ 统计卡（纯函数） */
/**
 * 由 stats 生成 6 张指标卡数据。
 * @param {object} stats source.stats
 * @returns {Array<{label:string, value:number, sub:string}>} value 为原始数值，渲染时再 toLocaleString()
 */
export function sourceStatCards(stats = {}) {
  const s = stats && typeof stats === 'object' ? stats : {};
  const total = n(s.totalChars);
  const avg = n(s.avgCharsPerEpisode);
  const min = n(s.minEpisodeChars);
  const max = n(s.maxEpisodeChars);
  const file = cut(str(s.filename), 14);
  const wan = total >= 10000 ? ` · 约 ${(total / 10000).toFixed(1)} 万字` : '';
  return [
    { label: '总字数', value: total, sub: `字${wan}` },
    { label: '章节数', value: n(s.chapterCount), sub: `章 · 已关联 ${fmtNum(n(s.linkedChapterCount))} 章` },
    { label: '段落数', value: n(s.paragraphCount), sub: file ? `段 · 来源 ${file}` : '段' },
    { label: '分集数', value: n(s.episodeCount), sub: avg ? `集 · 平均每集 ${fmtNum(avg)} 字` : '集' },
    { label: '季数', value: n(s.seasonCount), sub: max ? `季 · 单集 ${fmtNum(min)}–${fmtNum(max)} 字` : '季' },
    { label: '角色数', value: n(s.characterCount), sub: `个 · 上传于 ${fmtDate(s.uploadedAt)}` },
  ];
}

/* -------------------------------------------------------------- 搜索高亮 */
/**
 * 先对全文做 HTML 转义，再用「同样转义过」的查询词做替换，命中包 <mark class="sv-hit">。
 * 正则把 &xxx; 实体作为整体优先跳过，避免把标签插进 &amp; / &lt; 内部导致实体破损。
 * XSS 不可能：插入的只有固定标签，标签内的内容已是转义后的文本。
 */
function highlight(text, query) {
  const safe = escapeHTML(text);
  const q = str(query).trim();
  if (!q) return { html: safe, count: 0 };
  const safeQ = escapeHTML(q);
  const re = new RegExp(`(${escapeRegExp(safeQ)})|&[a-zA-Z#0-9]+;`, 'gi');
  let count = 0;
  const html = safe.replace(re, (match, hit) => {
    if (!hit) return match; // 命中了 HTML 实体，原样保留
    count += 1;
    return `<mark class="sv-hit">${match}</mark>`;
  });
  return { html, count };
}

/* ------------------------------------------------------------ 阅读内容计算 */
/** 章节 text 为空但全文存在时，按标题在全文里定位切片，避免白屏 */
function chapterBody(source, ch) {
  const own = str(ch?.text);
  if (own.trim()) return { text: own, fallback: false };
  const full = str(source.text);
  if (!full) return { text: '', fallback: false };
  const norm = (s) => str(s).replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
  const lines = full.split('\n');
  const titles = new Set(source.chapters.map((c) => norm(c?.title)).filter(Boolean));
  const target = norm(ch?.title);
  titles.delete(target);
  const idx = target ? lines.findIndex((l) => norm(l) === target) : -1;
  const start = idx >= 0 ? idx + 1 : 0;
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (titles.has(norm(lines[i]))) { end = i; break; }
  }
  const slice = lines.slice(start, end).join('\n').trim();
  return { text: slice || full.slice(0, 1500), fallback: true };
}

/** 当前阅读区的数据（标题 / 字数 / 来源 / 集号 / 正文） */
function readerData(source) {
  const stats = source.stats || {};
  const chapters = source.chapters || [];
  const bookTitle = str(stats.title) || str(current.ctx?.project?.name) || str(stats.filename) || '原著全文';
  if (ui.mode === 'full' || !chapters.length) {
    return {
      title: bookTitle,
      chars: n(stats.totalChars),
      sourceName: str(stats.filename),
      episodeNo: 0,
      text: str(source.text),
      fallback: ui.mode !== 'full' && Boolean(str(source.text)),
    };
  }
  const ch = chapters.find((c) => n(c?.no) === ui.chapterNo) || chapters[0];
  const body = chapterBody(source, ch);
  return {
    title: str(ch?.title) || `第 ${n(ch?.no)} 章`,
    chars: n(ch?.chars) || body.text.length,
    sourceName: str(ch?.sourceName) || str(stats.filename),
    episodeNo: n(ch?.episodeNo),
    text: body.text,
    fallback: body.fallback,
  };
}

/** .sv-text 与命中数的当前片段（搜索输入时只重绘这一块，保持滚动与焦点） */
function textBlock(d) {
  const q = str(ui.query).trim();
  const hl = highlight(d.text, q);
  let note = '';
  if (!d.text) note = '<div class="sv-empty">本章暂无正文</div>';
  else if (q && hl.count === 0) note = `<div class="sv-empty">没有找到「${esc(cut(q, 24))}」</div>`;
  const fallback = d.fallback
    ? '<div class="sv-fallback">本章正文未单独存储，以下为原著全文中的对应片段。</div>'
    : '';
  return {
    html: `${note}${d.text ? `<pre>${hl.html}</pre>` : ''}${fallback}`,
    count: hl.count,
    query: q,
    label: q ? `命中 ${fmtNum(hl.count)} 处` : '输入关键词检索',
  };
}

/* ------------------------------------------------------------------ HTML */
function statsHTML(cards) {
  return `<div class="sv-stats">${cards.map((c) => `
    <div class="sv-stat">
      <span class="sv-stat-label">${esc(c.label)}</span>
      <b>${fmtNum(c.value)}</b>
      <small>${esc(c.sub)}</small>
    </div>`).join('')}</div>`;
}

function headHTML(source, ctx) {
  const stats = source.stats || {};
  const label = str(stats.filename) || str(ctx.project?.name) || '原著导入';
  return `<div class="sv-head">
    <div class="sv-head-title">
      <h2>原著 · 导入统计</h2>
      <span class="sv-head-sub">${esc(cut(label, 24))} · 上传于 ${esc(fmtDate(stats.uploadedAt))}</span>
    </div>
    <div class="sv-head-acts">
      <button class="sv-btn" data-act="copy" title="复制全文">⧉ 复制全文</button>
      <button class="sv-btn" data-act="download" title="下载 .txt">⇩ 下载 .txt</button>
      <button class="sv-btn" data-act="reupload" title="重新导入 / 上传小说">⇧ 重新导入</button>
    </div>
  </div>`;
}

function tocHTML(source, totalChapters) {
  const chapters = source.chapters || [];
  const sources = source.sources || [];
  const chapterBtns = chapters.length
    ? chapters.map((c) => {
      const no = n(c?.no);
      const ep = n(c?.episodeNo);
      const title = str(c?.title) || `第 ${no} 章`;
      const on = ui.mode === 'chapter' && no === ui.chapterNo ? ' on' : '';
      return `<button class="sv-ch${on}" data-ch="${no}" title="${esc(title)}">
        <span class="sv-ch-no">${String(no).padStart(2, '0')}</span>
        <span class="sv-ch-title">${esc(cut(title, 18))}</span>
        <span class="sv-ch-chars">${fmtNum(n(c?.chars))} 字</span>
        ${ep ? `<span class="sv-ch-ep" data-ep="${ep}">→ 第 ${fmtNum(ep)} 集</span>` : ''}
      </button>`;
    }).join('')
    : '<div class="sv-empty">暂无章节</div>';
  const sourceItems = sources.length
    ? sources.map((s) => {
      const name = str(s?.name) || '未命名来源';
      const cnt = Array.isArray(s?.chapterTitles) ? s.chapterTitles.length : 0;
      return `<div class="sv-source">
        <span class="sv-source-name" title="${esc(name)}">${esc(cut(name, 18))}</span>
        <small>${fmtNum(n(s?.chars))} 字 · ${fmtNum(cnt)} 章</small>
      </div>`;
    }).join('')
    : '<div class="sv-empty">暂无来源文件</div>';
  return `<div class="sv-toc">
    <div class="sv-toc-head">
      <span>目录 · ${fmtNum(totalChapters)} 章</span>
      <div class="sv-modes">
        <button class="sv-mode${ui.mode === 'full' ? ' on' : ''}" data-mode="full">全文</button>
        <button class="sv-mode${ui.mode === 'chapter' ? ' on' : ''}" data-mode="chapter">按章</button>
      </div>
    </div>
    <div class="sv-toc-list">${chapterBtns}</div>
    <div class="sv-sources">
      <div class="sv-sources-head">
        <span>来源文件 · ${fmtNum(sources.length)} 个</span>
        <button class="sv-btn" data-act="assets">查看资源 →</button>
      </div>
      <div class="sv-sources-list">${sourceItems}</div>
    </div>
  </div>`;
}

function readerHTML(source, ctx) {
  const d = readerData(source);
  const tb = textBlock(d);
  return `<div class="sv-reader">
    <div class="sv-reader-head">
      <div class="sv-reader-title">
        <h3 title="${esc(d.title)}">${esc(d.title)}</h3>
        <span class="sv-reader-sub">${ui.mode === 'full' ? '全文阅读' : '按章阅读'}</span>
      </div>
      <div class="sv-reader-meta">
        <span>共 ${fmtNum(d.chars)} 字</span>
        ${d.sourceName ? `<span>来源：${esc(d.sourceName)}</span>` : ''}
        ${d.episodeNo ? `<span>关联第 ${fmtNum(d.episodeNo)} 集 <button class="sv-ep" data-ep="${n(d.episodeNo)}">查看第 ${fmtNum(d.episodeNo)} 集 →</button></span>` : ''}
        ${d.fallback ? '<span class="sv-warn">正文回退片段</span>' : ''}
      </div>
    </div>
    <div class="sv-search">
      <input id="sv-search" type="search" placeholder="在原文中搜索…" value="${esc(ui.query)}" autocomplete="off">
      <span class="sv-search-count">${esc(tb.label)}</span>
    </div>
    <div class="sv-text">${tb.html}</div>
  </div>`;
}

function shellHTML(source, ctx, cards) {
  const stats = source.stats || {};
  const totalChapters = n(stats.chapterCount) || source.chapters.length;
  return `<div class="sv">
    ${headHTML(source, ctx)}
    ${statsHTML(cards)}
    <div class="sv-body">
      ${tocHTML(source, totalChapters)}
      ${readerHTML(source, ctx)}
    </div>
  </div>`;
}

function emptyHTML() {
  return `<div class="sv">
    <div class="sv-head">
      <div class="sv-head-title">
        <h2>原著 · 导入统计</h2>
        <span class="sv-head-sub">尚未导入</span>
      </div>
      <div class="sv-head-acts"><button class="sv-btn" data-act="reupload">⇧ 重新导入</button></div>
    </div>
    <div class="sv-empty">
      <div class="sv-empty-ico">◈</div>
      <h3>还没有导入原著</h3>
      <p>上传小说文件后，这里会自动统计字数 / 章节 / 分集 / 角色，并提供全文检索阅读。</p>
      <button class="sv-btn" data-act="reupload">⇧ 上传小说</button>
    </div>
  </div>`;
}

function loadingHTML() {
  return '<div class="sv"><div class="sv-loading">⟳ 正在读取原著…</div></div>';
}

/* --------------------------------------------------------------- 副作用 */
function downloadName(stats, project) {
  let name = str(stats?.filename).trim() || str(project?.name).trim() || '原著';
  name = name.replace(/[\\/\r\n]+/g, '_');
  if (!/\.txt$/i.test(name)) name += '.txt';
  return name;
}

async function copyText(text, ctx) {
  let ok = false;
  try {
    const clip = globalThis.navigator?.clipboard;
    if (clip?.writeText) { await clip.writeText(text); ok = true; }
  } catch { ok = false; }
  if (!ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = Boolean(document.execCommand('copy'));
      ta.remove();
    } catch { ok = false; }
  }
  ctx.toast?.(ok ? '已复制全文' : '复制失败，请手动选择文本', ok ? 'ok' : 'err');
}

function downloadText(text, filename, ctx) {
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    ctx.toast?.(`已下载 ${filename}`, 'ok');
  } catch {
    ctx.toast?.('下载失败', 'err');
  }
}

/* ---------------------------------------------------------------- 事件委托 */
function handleClick(e) {
  const host = current.host;
  const ctx = current.ctx || {};
  const src = current.source;
  if (!host || !e || !e.target) return;
  const el = typeof e.target.closest === 'function'
    ? e.target.closest('[data-act], [data-mode], [data-ch], [data-ep]')
    : null;
  if (!el || !host.contains(el)) return;
  const d = el.dataset || {};
  if (d.act) {
    if (d.act === 'copy') copyText(str(src?.text), ctx);
    else if (d.act === 'download') downloadText(str(src?.text), downloadName(src?.stats, ctx.project), ctx);
    else if (d.act === 'reupload') ctx.onReupload?.();
    else if (d.act === 'assets') ctx.onOpenAssets?.();
    return;
  }
  if (d.ep) { ctx.onOpenEpisode?.(n(d.ep)); return; }
  if (d.mode) { ui.mode = d.mode === 'full' ? 'full' : 'chapter'; renderSourceView(host, ctx); return; }
  if (d.ch) { ui.chapterNo = n(d.ch) || 1; ui.mode = 'chapter'; renderSourceView(host, ctx); }
}

function handleInput(e) {
  if (!e || !e.target || e.target.id !== 'sv-search') return;
  ui.query = str(e.target.value);
  paintText();
}

/** 仅重绘 .sv-text / .sv-search-count，保留阅读区滚动位置与输入框焦点 */
function paintText() {
  const host = current.host;
  if (!host || typeof host.querySelector !== 'function') return;
  const box = host.querySelector('.sv-text');
  if (!box) return;
  const top = box.scrollTop;
  const tb = textBlock(readerData(current.source));
  box.innerHTML = tb.html;
  box.scrollTop = top;
  const countEl = host.querySelector('.sv-search-count');
  if (countEl) countEl.textContent = tb.label;
}

/* ------------------------------------------------------------------ 渲染 */
function renderWithSource(host, ctx, source) {
  const src = normalize(source);
  current = { ctx, source: src, host };
  const cards = sourceStatCards(src.stats);
  if (!src.ok || !src.text) { host.innerHTML = emptyHTML(); return; }
  if (ui.mode === 'chapter' && src.chapters.length
    && !src.chapters.some((c) => n(c?.no) === ui.chapterNo)) {
    ui.chapterNo = n(src.chapters[0]?.no) || 1;
  }
  host.innerHTML = shellHTML(src, ctx, cards);
}

/**
 * 渲染「原著 · 导入统计 + 原文阅读器」。
 * @param {HTMLElement} host 已存在的容器元素
 * @param {object} ctx { project, source, toast, onOpenEpisode, onReupload, onOpenAssets }
 */
export function renderSourceView(host, ctx = {}) {
  if (!host) return;
  host.onclick = handleClick;
  host.oninput = handleInput;
  const pid = ctx.project?.id;
  if (ui.projectId !== pid) {
    ui.projectId = pid;
    ui.mode = 'full';
    ui.chapterNo = 1;
    ui.query = '';
  }
  const seq = ++renderSeq;
  if (ctx.source == null) {
    current = { ctx, source: null, host };
    host.innerHTML = loadingHTML();
    const id = ctx.project?.id;
    if (!id) { renderWithSource(host, ctx, EMPTY_SOURCE); return; }
    fetch(`/api/projects/${encodeURIComponent(id)}/source`)
      .then((r) => r.json())
      .then((data) => {
        if (seq !== renderSeq) return;
        renderSourceView(host, { ...ctx, source: data });
      })
      .catch(() => {
        if (seq !== renderSeq) return;
        ctx.toast?.('读取原著失败', 'err');
        renderSourceView(host, { ...ctx, source: EMPTY_SOURCE });
      });
    return;
  }
  renderWithSource(host, ctx, ctx.source);
}
