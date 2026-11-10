/* ============================================================================
 * 项目工作台（Project Workshop）—— 进入创作项目后的默认全屏视图
 *
 * 布局：左侧 = 漫剧路线图（六步友好外壳，映射现有 STEPS 状态机）
 *            + 故事来源入口（上传小说 / AI 生成小说）
 *            + 项目资源（角色 / 分集 / 产物统计与入口）
 *      右侧 = 项目信息卡（封面 / 名称 / 简介与创作设定，✦ AI 一键补全）
 *            + 当前步骤操作台（上传、AI 生成、分集参数、提取角色、执行、下载）
 *            + 分集列表
 * 画布视图仍保留，顶栏一键切换（高级编辑）。
 * 零第三方依赖，原生 ESM。
 * ==========================================================================*/
import { ensureModelPicker, withModelId } from './model-picker.js';
import { ensureInterfacePicker, withInterfaceId } from './interface-picker.js';
import * as SV from './source-view.js';
import * as PMODEL from './project-model.js';
import { collectProjectAssets } from './project-sidebar.js';
import { directorPanelHTML, directorReportHTML, FILM_POLICY_OPTIONS } from './director-panel.js';
import { openDirectorManager } from './director-manager.js';
import { openCharacterDetail } from './project-manager.js';
import { GENRES, AUDIENCES, TONES, ART_STYLES, selectOptions, RUNTIME_PRESETS,
  matchRuntimePreset, previewRuntimeSpec,
  STORYBOARD_PROMPT_PARTS, storyboardLayout, storyboardDescription } from './project-options.js';
import { storyboardFrameSettingsHTML, storyboardSheetsHTML } from './storyboard-panel.js';
import { taskPanelHTML, startTaskTicker, stopTaskTicker, copyPromptId } from './task-panel.js';
import { filmTimelineHTML, stepStatsTableHTML } from './deliver-panel.js';
import { esc, cut, num, fmtNum } from './utils.js';

/** 角色出图请求：并上「本次使用的接口」，定妆板单独按 character-sheet 记忆 */
const withCharImage = (body = {}) => withInterfaceId(
  body?.view === 'sheet' ? 'character-sheet' : 'character-view',
  withModelId('chars', body),
);
const withCoverImage = (body = {}) => withInterfaceId('cover', withModelId('cover', body));


async function api(path, body, method) {
  const verb = method || (body === undefined ? 'GET' : 'POST');
  const res = await fetch(path, {
    method: verb,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
  return data;
}

/** 六步 → 友好路线图文案（底层仍是 project-steps.mjs 的 STEPS 状态机） */
const ROADMAP = {
  upload: { name: '准备故事', hint: '上传小说，或让 AI 按构想生成', icon: '⇧' },
  episodes: { name: '分集拆解', hint: '把长篇切成可拍摄的集', icon: '▥' },
  script: { name: '剧本创作', hint: '分集梗概写成统一格式剧本', icon: '▤' },
  context: { name: '角色与上下文', hint: '提取角色 · 原著索引 · 层次分解', icon: '⑂' },
  storyboard: { name: '分镜与画面', hint: '分镜提示词 · 关键帧 · 分镜板（九宫格等）', icon: '⌗' },
  deliver: { name: '视频与交付', hint: '视频片段 · 成片 / 导演包', icon: '▶' },
};

/** 工作台步骤清单（单页顺序展示）：① 设置基础信息 + 现有 6 步，第一项固定为基础信息。
 *  底层仍走 project-steps.mjs 的 STEPS 状态机（除 basic 步骤外）。 */
export const WORKSHOP_STEPS = [
  { id: 'basic', name: '设置基础信息', icon: '⚙', desc: '项目名 · 简介 · 类型 · 画面风格 · 画幅 · 交付形式', auto: true, scope: 'project' },
  { id: 'upload', name: '准备故事', icon: '⇧', desc: '上传小说，或让 AI 按构想生成 · 作用于全书', scope: 'project' },
  { id: 'episodes', name: '分集拆解', icon: '▥', desc: '把长篇切成可拍摄的集 · 一次拆全书', scope: 'project' },
  { id: 'script', name: '剧本创作', icon: '▤', desc: '逐集把分集梗概写成统一格式剧本', scope: 'episode' },
  { id: 'context', name: '角色与上下文', icon: '⑂', desc: '逐集确认出场角色与本集剧本，再出角色定妆', scope: 'episode' },
  { id: 'storyboard', name: '分镜与画面', icon: '⌗', desc: '逐集生成分镜提示词 · 关键帧 · 分镜板（九宫格等）', scope: 'episode' },
  { id: 'deliver', name: '视频与交付', icon: '▶', desc: '逐集出片段与成片，最后统一交付导演包', scope: 'episode' },
];

const STATUS_TEXT = { pending: '待执行', running: '进行中', done: '已完成', error: '失败 · 可重试', skipped: '已跳过' };
const STYLES = ['cinematic', 'noir', 'anime', 'watercolor'];
const STYLE_NAMES = { cinematic: '电影感', noir: '黑色电影', anime: '日系动画', watercolor: '水彩' };
const SPLIT_STRATEGIES = [
  { id: 'chapter', name: '按章节', hint: '识别「第X章 / Chapter N」' },
  { id: 'fixed', name: '按字数', hint: '固定字数均分' },
  { id: 'scene', name: '按场景段落', hint: '空行分段聚合' },
];

/** 工作台四个 Tab：把原来一屏塞满的卡片按用途归拢，首屏只讲「现在该做什么」 */
const TABS = [
  { id: 'overview', label: '▦ 概览', hint: '路线图 · 项目信息 · 当前步骤' },
  { id: 'source', label: '📖 原著', hint: '导入统计与全文阅读' },
  { id: 'episodes', label: '▥ 分季分集', hint: '按季管理 · 每集独立画布' },
  { id: 'assets', label: '▣ 资源', hint: '本项目产物统一归纳' },
];
const ASSET_KIND_LABEL = { cover: '封面', character: '角色', image: '图片', video: '视频', pack: '导演包', other: '其他' };

/** 「制作步骤」导航的展开 / 收起偏好：跨项目、跨刷新保留 */
const NAV_STATE_KEY = 'lxmj.workshop.navCollapsed';
function readNavPref() {
  try { return localStorage.getItem(NAV_STATE_KEY) === '1'; } catch { return false; }
}
function writeNavPref(collapsed) {
  try { localStorage.setItem(NAV_STATE_KEY, collapsed ? '1' : '0'); } catch { /* 隐私模式下忽略 */ }
}

/* 工作台 UI 状态（跨渲染保留：AI 大纲草稿、上传草稿、项目信息编辑稿） */
const ui = {
  projectId: null,
  tab: 'overview',
  stepId: null,
  sourceOpen: false,              // 步骤②「查看原著与统计」折叠状态
  navCollapsed: readNavPref(),    // 制作步骤窄栏：收起为 40px 状态轨 / 展开为 190px 步骤栏
  scrollTo: null,                 // 导航点击后滚动锚点（渲染后消费并清空）
  info: {},                       // 项目信息编辑稿（bible 字段）
  projectName: null,              // 项目名称编辑稿（null = 未改动，跟随项目名）
  skipCapture: false,             // AI 补全等服务端改写场景：跳过一次 DOM 捕获，避免旧输入框值盖回新数据
  upload: { open: false, filename: '', text: '', msg: '', err: false, files: [], strategy: '', targetChars: 0, maxEpisodes: 0 },
  ai: { open: false, idea: '', chapterCount: 3, chapterChars: 800, outline: null, source: '', message: '', busy: false, busyText: '' },
  // 导演 Agent：技能选择、一句话构想、SSE 阶段进度（busy 由 app.js 的 state.directorBusy 统一持有）
  director: { skillId: null, paletteKey: null, idea: '', progress: null },
  // 剧本工作台：展开哪一集、正在编辑哪一集、编辑草稿、正在生成的集
  script: { openNo: null, editNo: null, draft: null, busyNo: null, batchBusy: '' },
  // 分集制作（第⑤⑥⑦步按集执行，④ 剧本走 script 接口）：正在执行的单集 / 批量任务
  epStep: { busyNo: null, busyStep: '', batchBusy: '' },
  // 当前剧集（跨步骤共享）：第④步之后所有任务都挂在这一集上，换集 = 换一套任务
  activeNo: 0,
  // 每集独立的界面状态（剧本展开 / 编辑草稿 / 倍速）：切集时存档、切回时还原，
  // 保证「后续步骤完全独立」——上一集的草稿不会串到下一集，切回来也还在
  epUI: {},
  // 分季分集 Tab：搜索 / 状态筛选 / 折叠的季（只影响展示，不改数据）
  epFilter: { query: '', status: 'all' },
  collapsedSeasons: [],
  // 本地 ComfyUI 配置摘要（app.js 由 bootstrap 下发）：判断出图工作流是否就绪
  comfy: null,
  // 服务端 API 能力（app.js 由 bootstrap 下发）：常驻进程跑旧代码时据此禁用生成并提示重启
  api: null,
  // 单张视图重生成中的状态 { characterId, view }：让缩略图立刻进入扫光态
  viewRegen: null,
  // 第⑦步成片倍速（跨渲染保留；暂不进 localStorage，刷新回到 1×）
  filmRate: 1,
};

function resetUi(p) {
  const m = p.management || {};
  ui.projectId = p.id;
  ui.tab = 'overview';
  ui.stepId = null;
  ui.sourceOpen = false;
  ui.scrollTo = null;
  ui.info = {};
  ui.projectName = null;
  ui.upload = { open: false, filename: '', text: '', msg: '', err: false, files: [], strategy: '', targetChars: 0, maxEpisodes: 0 };
  ui.ai = { open: false, idea: String(m.bible?.logline || ''), chapterCount: 3, chapterChars: 800, outline: null, source: '', message: '', busy: false, busyText: '' };
  ui.director = { skillId: null, idea: '', progress: null };
  ui.script = { openNo: null, editNo: null, draft: null, busyNo: null, batchBusy: '' };
  ui.epStep = { busyNo: null, busyStep: '', batchBusy: '' };
  // 当前剧集按项目记忆：从分集卡 / 流水线选过哪一集，回到工作台还停在那集
  ui.activeNo = readActiveNo(p.id);
  // 按集界面状态属于项目：切项目时清空，避免把上一个项目的草稿画到新项目上
  ui.epUI = {};
  ui.epFilter = { query: '', status: 'all' };
  ui.collapsedSeasons = [];
  // 任务态属于项目：切项目时清空，避免把上一个项目的进度画到新项目上；
  // 回到有任务的项目会由 restorePortraitJob() 从服务端恢复。
  ui.portraitJob = null;
  ui.viewRegen = null;
}

/** 重绘前把用户正在编辑的 DOM 值收进 ui，避免 SSE 刷新吃掉输入 */
function captureState(host) {
  if (!host || !host.isConnected) return;
  const q = (sel) => host.querySelector(sel);
  if (q('#pv-up-text')) ui.upload.text = q('#pv-up-text').value;
  if (q('#pv-ai-idea')) ui.ai.idea = q('#pv-ai-idea').value;
  if (q('#pv-ai-count')) ui.ai.chapterCount = Number(q('#pv-ai-count').value) || 3;
  if (q('#pv-ai-charsel')) ui.ai.chapterChars = Number(q('#pv-ai-charsel').value) || 800;
  if (ui.ai.outline) {
    host.querySelectorAll('[data-olf]').forEach((el) => {
      const i = Number(el.dataset.i);
      const f = el.dataset.olf;
      if (ui.ai.outline.chapters?.[i]) ui.ai.outline.chapters[i][f] = el.value;
    });
    const t = q('#pv-ol-title');
    if (t) ui.ai.outline.title = t.value;
  }
  host.querySelectorAll('[data-bi]').forEach((el) => { ui.info[el.dataset.bi] = el.value; });
  if (q('#pv-name')) ui.projectName = q('#pv-name').value;
  // 导演面板：一句话构想也要在 SSE 触发的重绘里保住
  const dirIdea = q('#pv-dir-idea');
  if (dirIdea) ui.director.idea = dirIdea.value;
  // 剧本编辑器：SSE / 切 Tab 触发的重绘不能吃掉用户刚改的内容
  if (ui.script.editNo && host.querySelector('#sw-editor')) {
    const draft = readScriptDraft(host);
    if (draft) ui.script.draft = draft;
  }
}

/** 从剧本编辑器读回草稿（只在 DOM 存在时调用） */
function readScriptDraft(host) {
  const root = host?.querySelector('#sw-editor');
  if (!root) return null;
  const val = (sel) => root.querySelector(sel)?.value ?? '';
  const scenes = [...root.querySelectorAll('[data-scr-scene]')].map((el) => ({
    id: el.dataset.scrScene || '',
    location: el.querySelector('[data-scr-loc]')?.value || '',
    time: el.querySelector('[data-scr-time]')?.value || '',
    summary: el.querySelector('[data-scr-sum]')?.value || '',
    script: String(el.querySelector('[data-scr-lines]')?.value || '')
      .split('\n').map((s) => s.trim()).filter(Boolean),
  }));
  return { title: val('[data-scr="title"]'), logline: val('[data-scr="logline"]'), scenes };
}

const fmtTok = (n) => (Number(n) || 0) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Number(n) || 0);
const fmtTime = (ts) => ts ? new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '';

function stepStateOf(m, id) {
  return (m.steps || []).find((s) => s.id === id) || { status: 'pending' };
}

/* ------------------------------------------------------------------ 左侧：路线图 */
function roadmapHTML(m, steps, busy) {
  const list = steps.length ? steps : Object.keys(ROADMAP).map((id, i) => ({ id, no: i + 1 }));
  const done = (m.steps || []).filter((s) => s.status === 'done').length;
  const total = list.length;
  const current = (m.steps || []).find((s) => s.status === 'running') || (m.steps || []).find((s) => s.status === 'pending');
  const allDone = total > 0 && done === total;
  return `<div class="pv-card pv-roadmap">
    <div class="pv-card-head"><span>🗺 漫剧路线图</span><span class="pv-progress-pill">${done}/${total}</span></div>
    <div class="pv-progress"><i style="width:${total ? Math.round(done / total * 100) : 0}%"></i></div>
    <div class="pv-steps">${list.map((def) => {
      const st = stepStateOf(m, def.id);
      const rm = ROADMAP[def.id] || { name: def.title || def.id, hint: def.short || '', icon: '·' };
      const isCur = current?.id === def.id && st.status !== 'done';
      return `<button class="pv-step st-${st.status} ${ui.stepId === def.id ? 'selected' : ''}" data-step="${def.id}">
        <span class="pv-step-no">${st.status === 'done' ? '✓' : def.no}</span>
        <span class="pv-step-main"><strong>${esc(rm.name)}</strong><small>${esc(rm.hint)}</small></span>
        <span class="pv-step-state">${st.status === 'running' ? '<i class="pv-pulse"></i>' : ''}${isCur && st.status === 'pending' ? '下一步' : STATUS_TEXT[st.status] || ''}</span>
      </button>`;
    }).join('')}</div>
    <div class="pv-roadmap-foot">
      <button class="btn primary sm" data-act="run-next" ${busy || allDone ? 'disabled' : ''}>${busy ? '执行中…' : allDone ? '✓ 全部完成' : '▶ 执行下一步'}</button>
      <button class="btn sm" data-act="run-all" ${busy || allDone ? 'disabled' : ''}>⏩ 全部执行</button>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ 左侧：故事来源 */
function sourceCardHTML(m) {
  const s = m.source || {};
  return `<div class="pv-card pv-source">
    <div class="pv-card-head"><span>📖 故事来源</span></div>
    ${s.text
      ? `<div class="pv-source-info">
          <strong>《${esc(cut(s.title || '未命名', 18))}》</strong>
          <span>${s.chapterCount || 0} 章 · ${(s.totalChars || 0).toLocaleString()} 字 · ${(m.episodes || []).length} 集</span>
        </div>`
      : `<div class="pv-source-empty">还没有故事。上传你的小说，或让 AI 按一句话构想生成一部。</div>`}
    <div class="pv-source-acts">
      ${s.text ? `<button class="btn sm primary" data-act="view-source">📖 查看原著与统计</button>` : ''}
      <button class="btn sm" data-act="goto-upload">⇧ 上传小说</button>
      <button class="btn sm accent-mini" data-act="goto-ai">✦ AI 生成小说</button>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ 左侧：项目资源 */
/** 真实出图判定：provider=mock 的自绘 SVG / .svg 占位不算「已生成」 */
const isRealShot = (img) => Boolean(img?.url)
  && String(img?.provider || '') !== 'mock'
  && !/\.svg(\?|$)/i.test(String(img.url));

function resourceCardHTML(p, m, stats) {
  const chars = Array.isArray(m.characters) ? m.characters : [];
  return `<div class="pv-card pv-res">
    <div class="pv-card-head"><span>▣ 项目资源</span></div>
    <div class="pv-res-grid">
      <div><b>${chars.length}</b><span>角色</span></div>
      <div><b>${(m.episodes || []).length}</b><span>分集</span></div>
      <div><b>${stats.shotCount ?? p.nodes.filter((n) => n.type === 'shot').length}</b><span>镜头</span></div>
      <div><b>${stats.videoCount ?? p.nodes.filter((n) => n.type === 'video').length}</b><span>片段</span></div>
    </div>
    ${chars.length ? `<div class="pv-res-chars">${chars.slice(0, 5).map((c) => {
    // 缩略图优先用正面（身份基准），缺正面时退到面部特写/3-4 侧，仍能看出是谁
    const pick = c.views?.front?.url || c.views?.closeup?.url || c.views?.threeQuarter?.url || c.views?.side?.url || '';
    const ready = isRealShot(c.views?.front);
    const mock = pick && !isRealShot(pick) ? ' · 缩略为占位图' : '';
    return `<span class="pv-char-chip ${ready ? '' : 'warn'}" data-char-detail="${esc(c.id)}" title="${esc(c.name)} · ${esc(c.role || '未设定')}${ready ? ' · 已有正面定妆，可用于视频' : ' · 缺正面真实出图，暂不可进视频'}${mock}">${pick ? `<img src="${esc(pick)}" alt="">` : '<i></i>'}${esc(c.name)}</span>`;
  }).join('')}${chars.length > 5 ? `<span class="pv-char-chip">+${chars.length - 5}</span>` : ''}</div>` : ''}
    ${chars.length ? (() => {
    // 只认真实出图：占位图（Mock 自绘）单独计数，不给「已生成」冒名
    const readyCount = chars.filter((c) => isRealShot(c.views?.front?.url) || isRealShot(c.views?.closeup?.url)).length;
    const sheetCount = chars.filter((c) => isRealShot(c.sheet)).length;
    const viewTotal = chars.length * 5;
    const viewDone = chars.reduce((n, c) => n
      + ['front', 'threeQuarter', 'side', 'back', 'closeup'].filter((k) => isRealShot(c.views?.[k])).length, 0);
    const mockViews = chars.reduce((n, c) => n
      + ['front', 'threeQuarter', 'side', 'back', 'closeup'].filter((k) => c.views?.[k]?.url && !isRealShot(c.views[k])).length, 0);
    return `<div class="pv-res-note">${readyCount}/${chars.length} 位角色可进视频 · 真实出图 ${viewDone}/${viewTotal} 张视图${mockViews ? ` · ${mockViews} 张占位` : ''} · ${sheetCount} 张定妆板${readyCount < chars.length ? ' · 第④步可一键补全' : ''}</div>`;
  })() : ''}
    <div class="pv-res-acts">
      <button class="btn sm" data-act="assets">▣ 资源库</button>
      <button class="btn sm" data-act="chars">👤 角色管理</button>
      <button class="btn sm" data-act="manage">▦ 项目管理</button>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ 右侧：项目信息卡 */
function infoCardHTML(p, m) {
  const b = m.bible || {};
  const raw = (k) => String(ui.info[k] !== undefined ? ui.info[k] : (b[k] || ''));
  const v = (k) => esc(raw(k));
  const nameVal = ui.projectName === null ? (p.name || '') : ui.projectName;
  const cover = m.cover || {};
  const settings = p.settings || {};
  const d = m.deliverables || { video: true, pack: true };
  const coverHtml = cover.url
    ? `<img src="${esc(cover.url)}" alt="封面">`
    : `<span class="pv-cover-name">${esc((p.name || '未')[0])}</span>`;
  return `<div class="pv-card pv-hero">
    <button class="pv-cover" data-act="cover" title="设置项目封面">${coverHtml}<span class="pv-cover-edit">🖼 封面</span></button>
    <div class="pv-hero-main">
      <div class="pv-hero-title">
        <h1>${esc(p.name)}</h1>
        <span class="pv-tag">${m.kind === 'novel' ? '小说分集创作' : '标准流水线'}</span>
        <span class="pv-tag">${esc(STYLE_NAMES[settings.style] || settings.style || '电影感')}</span>
        <span class="pv-tag">${esc(settings.aspect || '16:9')}</span>
        <span class="pv-tag">${d.video && d.pack ? '视频 + 导演包' : d.video ? '成片视频' : '导演包'}</span>
      </div>
      <div class="pv-hero-sub">创建于 ${fmtTime(m.createdAt)} · 「AI 一键生成」会按构想重写项目名称、简介、类型等设定并生成封面</div>
      <div class="pv-ai-fill">
        <input id="pv-bi-idea" placeholder="一句话故事构想（AI 据此生成项目名称、简介与封面；留空则按当前项目名生成）" value="${esc(ui.ai.idea || b.logline || '')}">
        <button class="btn sm primary" data-act="ai-fill">✦ AI 一键生成</button>
      </div>
      <div class="pv-info-grid">
        <div class="field"><label>项目名称</label><input id="pv-name" value="${esc(nameVal)}" maxlength="80" placeholder="如：雨夜来信" title="修改后按回车即可保存名称"></div>
        <div class="field"><label>一句话简介</label><textarea data-bi="logline" rows="2" placeholder="这个故事讲了什么…">${v('logline')}</textarea></div>
        <div class="pv-info-row">
          <div class="field"><label>类型</label><select data-bi="genre">${selectOptions(raw('genre'), GENRES)}</select></div>
          <div class="field"><label>受众</label><select data-bi="audience">${selectOptions(raw('audience'), AUDIENCES)}</select></div>
          <div class="field"><label>基调</label><select data-bi="tone">${selectOptions(raw('tone'), TONES)}</select></div>
        </div>
        <div class="pv-info-row">
          <div class="field"><label>画面风格</label><select data-set="style">${STYLES.map((s) => `<option value="${s}" ${(settings.style || 'cinematic') === s ? 'selected' : ''}>${STYLE_NAMES[s]}（${s}）</option>`).join('')}</select></div>
          <div class="field"><label>画幅</label><select data-set="aspect"><option value="16:9" ${(settings.aspect || '16:9') === '16:9' ? 'selected' : ''}>16:9 横屏</option><option value="9:16" ${settings.aspect === '9:16' ? 'selected' : ''}>9:16 竖屏</option></select></div>
          <div class="field"><label>美术风格</label><select data-bi="artStyle">${selectOptions(raw('artStyle'), ART_STYLES)}</select></div>
        </div>
      </div>
      <div class="pv-hero-acts">
        <button class="btn sm primary" data-act="save-info">保存项目信息</button>
        <button class="btn sm" data-act="ai-cover">🖼 AI 生成封面</button>
        <button class="btn sm" data-act="cover">🖼 上传 / 换封面</button>
        <span class="pv-hero-msg" id="pv-info-msg">${m.basicInfo?.confirmedAt ? `✓ 基础信息已确认 · ${fmtTime(m.basicInfo.confirmedAt)}` : ''}</span>
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ 右侧：步骤操作台 */
function consoleHeadHTML(def, st, busy) {
  const rm = ROADMAP[def.id] || { name: def.title, hint: def.short };
  return `<div class="pv-console-head">
    <span class="pv-console-icon">${rm.icon}</span>
    <div class="pv-console-title"><strong>第 ${def.no} 步 · ${esc(rm.name)}</strong><small>${esc(def.desc || rm.hint)}</small></div>
    <span class="pv-pill st-${st.status}">${STATUS_TEXT[st.status] || st.status}</span>
  </div>
  ${st.note ? `<div class="pv-console-note">${esc(st.note)}${st.durationMs ? ` · ${(st.durationMs / 1000).toFixed(1)}s` : ''}</div>` : ''}
  ${def.auto ? '' : `<div class="pv-console-acts">
    <button class="btn primary sm" data-act="run-step" data-id="${def.id}" ${busy ? 'disabled' : ''}>${st.status === 'error' ? '↻ 重试本步' : st.status === 'done' ? '↻ 重新执行' : '▶ 执行本步'}</button>
  </div>`}`;
}

/** 上传文件 chip：多文件时可 ↑/↓ 手动调整合并顺序（顺序即章节合并顺序） */
function fileChipHTML(f, i, n) {
  const nav = n > 1
    ? `<button data-up-move="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="上移（靠前的文件先合并）">↑</button>` +
      `<button data-up-move="${i}" data-dir="1" ${i === n - 1 ? 'disabled' : ''} title="下移（靠后的文件后合并）">↓</button>`
    : '';
  return `<span class="pv-file-chip" title="${esc(f.name)}">📄 ${esc(cut(f.name, 22))}<small>${(f.text || '').length} 字</small>${nav}<button data-up-remove="${i}" title="移除">✕</button></span>`;
}

/** ① 准备故事：上传 / AI 生成双入口 */
function uploadConsoleHTML(m) {
  const s = m.source || {};
  const has = !!s.text;
  const sp = m.split || { strategy: 'chapter', targetChars: 1200, maxEpisodes: 4 };
  const strategy = ui.upload.strategy || sp.strategy || 'chapter';
  const target = ui.upload.targetChars || sp.targetChars || 1200;
  const max = ui.upload.maxEpisodes || sp.maxEpisodes || 4;
  const seasonSize = ui.upload.seasonSize || sp.seasonSize || 12;
  return `
  ${has ? `<div class="pv-src-card">
      <div class="pv-src-badge ok">✓ 故事已就绪</div>
      <strong>《${esc(s.title || '未命名')}》</strong>
      <span>${s.chapterCount || 0} 章 · ${(s.totalChars || 0).toLocaleString()} 字 · 已拆为 ${(m.episodes || []).length} 集${s.filename ? ` · ${esc(cut(s.filename, 24))}` : ''}</span>
      <div class="pv-src-acts">
        <button class="btn sm" data-act="toggle-upload">⇧ 重新上传</button>
        <button class="btn sm" data-act="toggle-ai">✦ AI 重新生成</button>
      </div>
    </div>` : ''}
  ${!has || ui.upload.open ? `<div class="pv-sub-card" id="pv-upload-card">
      <div class="pv-sub-head"><strong>⇧ 上传小说（支持超长 · 多文件）</strong><span>.txt / .md · 可一次选上百个分卷文件 · 单项目最高 1000 万字 · 至少 40 字 · 多文件自动按文件名排序，可手动微调</span></div>
      <div class="pv-up-actions">
        <button class="btn sm" data-up="file">＋ 选择文件（可多选）</button>
        <button class="btn sm" data-up="sample">载入示例小说</button>
        <button class="btn sm" data-up="clear" ${ui.upload.files.length ? '' : 'disabled'}>清空文件</button>
      </div>
      <div class="pv-up-files" id="pv-up-files">${ui.upload.files.length
    ? ui.upload.files.map((f, i) => fileChipHTML(f, i, ui.upload.files.length)).join('')
    : '<span class="pv-up-files-hint">未选择文件 · 也可直接在下方粘贴正文</span>'}</div>
      <textarea id="pv-up-text" rows="4" placeholder="雨夜来信&#10;&#10;第一章 没有署名的信&#10;雨下了整夜……">${esc(ui.upload.text)}</textarea>
      <div class="pv-up-rules">
        <span class="pv-up-rules-title">拆分规则（上传时即按此自动分集）</span>
        <div class="pv-up-split">${SPLIT_STRATEGIES.map((s) => `<button class="pv-split-card ${strategy === s.id ? 'selected' : ''}" data-up-split="${s.id}"><strong>${s.name}</strong><small>${s.hint}</small></button>`).join('')}</div>
        <div class="pv-up-rule-nums">
          <label>每集目标字数 <input type="number" id="pv-up-target" min="300" max="8000" step="100" value="${target}"></label>
          <label>最多集数 <input type="number" id="pv-up-max" min="1" max="600" value="${max}"></label>
          <label>每季集数 <input type="number" id="pv-up-season" min="1" max="600" value="${seasonSize}"></label>
        </div>
        <div class="pv-hint">超过「每季集数」自动分季 · 分季之后仍可在「分季分集」里把任意一集移到别的季</div>
      </div>
      <div class="pv-up-foot">
        <span class="pv-up-msg ${ui.upload.err ? 'err' : ''}">${esc(ui.upload.msg || '上传后自动合并文件、解析章节并按规则关联到对应剧集')}</span>
        <button class="btn primary sm" data-up="submit">⇧ 上传并自动分集</button>
      </div>
    </div>` : ''}
  ${!has || ui.ai.open ? `<div class="pv-sub-card" id="pv-ai-card">
      <div class="pv-sub-head"><strong>✦ AI 生成小说</strong><span>一句话构想 → 分章大纲 → 整本正文 → 自动分集 · 未配置模型时用内置模板演示</span></div>
      <div class="pv-ai-form">
        <textarea id="pv-ai-idea" rows="2" placeholder="例如：退役刑警收到一封来自十年前的信，揭开一桩被遗忘的旧案">${esc(ui.ai.idea)}</textarea>
        <div class="pv-ai-opts">
          <label>章节数 <select id="pv-ai-count">${[2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${ui.ai.chapterCount === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <label>每章约 <select id="pv-ai-charsel">${[600, 800, 1200, 1500].map((n) => `<option value="${n}" ${ui.ai.chapterChars === n ? 'selected' : ''}>${n}</option>`).join('')}</select> 字</label>
          <button class="btn sm" data-ai="outline" ${ui.ai.busy ? 'disabled' : ''}>${ui.ai.outline ? '↻ 重新生成大纲' : '① 生成大纲'}</button>
        </div>
      </div>
      ${ui.ai.outline ? `<div class="pv-ai-outline">
        <div class="field"><label>书名</label><input id="pv-ol-title" value="${esc(ui.ai.outline.title)}"></div>
        ${ui.ai.outline.chapters.map((c, i) => `<div class="pv-ol-ch">
          <input data-olf="title" data-i="${i}" value="${esc(c.title)}" title="章节标题">
          <textarea data-olf="summary" data-i="${i}" rows="2" placeholder="本章梗概">${esc(c.summary)}</textarea>
          <input data-olf="hook" data-i="${i}" value="${esc(c.hook)}" placeholder="结尾钩子（可选）">
        </div>`).join('')}
        <div class="pv-ai-foot">
          <span class="pv-up-msg">${esc(ui.ai.message || '')}</span>
          <button class="btn primary sm" data-ai="full" ${ui.ai.busy ? 'disabled' : ''}>${ui.ai.busy ? esc(ui.ai.busyText || '生成中…') : '② 生成全文并注入项目'}</button>
        </div>
      </div>` : `<div class="pv-ai-foot"><span class="pv-up-msg">${esc(ui.ai.message || '先生成大纲，确认或编辑后再生成全文')}</span></div>`}
    </div>` : ''}`;
}

/** ② 分集拆解 */
function episodesConsoleHTML(m, st, busy) {
  const has = !!m.source?.text;
  const sp = m.split || { strategy: 'chapter', targetChars: 1200, maxEpisodes: 4 };
  if (!has) return `<div class="pv-hint">先在第 ② 步上传或生成小说，再回来调整分集。</div>`;
  return `<div class="pv-split">
    <div class="pv-split-cards">${SPLIT_STRATEGIES.map((s) => `
      <button class="pv-split-card ${sp.strategy === s.id ? 'selected' : ''}" data-split="${s.id}">
        <strong>${s.name}</strong><small>${s.hint}</small>
      </button>`).join('')}</div>
    <div class="pv-split-opts">
      <label>每集目标字数 <input type="number" id="pv-sp-target" min="300" max="8000" step="100" value="${sp.targetChars}"></label>
      <label>最多集数 <input type="number" id="pv-sp-max" min="1" max="600" value="${sp.maxEpisodes}"></label>
      <label>每季集数 <input type="number" id="pv-sp-season" min="1" max="600" value="${sp.seasonSize || 12}"></label>
      <button class="btn sm primary" data-act="re-split" ${busy ? 'disabled' : ''}>▥ 按新参数重新分集</button>
    </div>
    <div class="pv-hint">当前 ${(m.episodes || []).length} 集 · 重新分集会替换画板上的分集节点，章节关联同步更新，原著全文保留。</div>
  </div>`;
}

/* ------------------------------------------------------ ④ 剧本创作 · 分集剧本台 */
const SCRIPT_SOURCE = { llm: '大模型', mock: '内置模板', manual: '人工编辑', heuristic: '启发式' };
const fmtDay = (ts) => ts ? new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '';

function scriptIssuesHTML(sc) {
  const list = Array.isArray(sc?.issues) ? sc.issues : [];
  if (!list.length) return '';
  const level = list.some((x) => x.level === 'error') ? 'err' : list.some((x) => x.level === 'warn') ? 'warn' : 'info';
  return `<div class="sw-issues ${level}">${list.slice(0, 4).map((x) => `<span>${x.level === 'error' ? '✕' : x.level === 'warn' ? '⚠' : 'ⓘ'} ${esc(x.message)}</span>`).join('')}</div>`;
}

function scriptReaderHTML(ep, sc) {
  const no = num(ep.no);
  const chars = Array.isArray(sc.characters) ? sc.characters : [];
  return `<div class="sw-read">
    <div class="sw-read-title">《${esc(sc.title || `第 ${no} 集`)}》</div>
    ${sc.logline ? `<p class="sw-logline">${esc(sc.logline)}</p>` : ''}
    ${chars.length ? `<div class="sw-cast">${chars.slice(0, 8).map((c) => `<span class="sw-cast-chip">${esc(c.name)}${c.role ? `<small>${esc(c.role)}</small>` : ''}</span>`).join('')}</div>` : ''}
    ${scriptIssuesHTML(sc)}
    <div class="sw-scenes">${(sc.scenes || []).map((s, i) => `<div class="sw-scene">
      <div class="sw-scene-head"><span class="sw-scene-no">${String(i + 1).padStart(2, '0')}</span>
        <strong>${esc(s.location || '未指定场景')}</strong>${s.time ? `<small>${esc(s.time)}</small>` : ''}</div>
      ${s.summary ? `<p>${esc(s.summary)}</p>` : ''}
      <div class="sw-lines">${(s.script || []).map((line) => {
        const dlg = /^[^：:\s【】]{1,10}\s*[：:]/.test(line) && !/^(动作|画面|字幕|备注|场景|时间|地点)[:：]/.test(line);
        return `<div class="sw-line ${dlg ? 'dlg' : /^动作[:：]/.test(line) ? 'act' : ''}">${esc(line)}</div>`;
      }).join('')}</div>
    </div>`).join('')}</div>
    <div class="sw-foot">
      <button class="btn sm" data-act="edit-script" data-no="${no}">✎ 编辑剧本</button>
      <a class="btn sm" href="/api/projects/${esc(ui.projectId)}/episodes/${no}/script/export" download>⇩ 导出本集 .md</a>
      <span class="sw-foot-note">${sc.continuity?.prevRecap ? `承接第 ${sc.continuity.prevNo || no - 1} 集结尾` : '本集开场'}${sc.continuity?.nextHook ? ' · 结尾留钩子' : ''}${sc.filled?.length ? ' · 部分字段由模板补位' : ''}</span>
    </div>
  </div>`;
}

function scriptEditorHTML(ep, sc) {
  const no = num(ep.no);
  return `<div class="sw-editor" id="sw-editor" data-no="${no}">
    <div class="sw-editor-head"><strong>编辑第 ${no} 集剧本</strong><span>每行一句：对白写「角色：「台词」」，动作写「动作：…」</span></div>
    <div class="sw-edit-meta">
      <label>片名<input data-scr="title" value="${esc(sc.title || '')}"></label>
      <label>梗概<textarea data-scr="logline" rows="2">${esc(sc.logline || '')}</textarea></label>
    </div>
    ${(sc.scenes || []).map((s, i) => `<section class="sw-edit-scene" data-scr-scene="${esc(s.id || `S${i + 1}`)}">
      <div class="sw-edit-row">
        <label>第 ${i + 1} 场 · 地点<input data-scr-loc value="${esc(s.location || '')}"></label>
        <label>时间<input data-scr-time value="${esc(s.time || '')}"></label>
      </div>
      <label>场次概述<textarea data-scr-sum rows="2">${esc(s.summary || '')}</textarea></label>
      <label>正文 / 对白<textarea data-scr-lines rows="6" placeholder="角色名：「台词」">${esc((s.script || []).join('\n'))}</textarea></label>
    </section>`).join('')}
    <div class="sw-edit-foot">
      <button class="btn primary sm" data-act="save-script" data-no="${no}">✓ 保存剧本</button>
      <button class="btn sm" data-act="cancel-script">取消</button>
      <span class="pv-up-msg" id="sw-edit-msg">保存后会重新统计场次 / 对白 / 字数，并把来源标为「人工编辑」</span>
    </div>
  </div>`;
}

/** ④ 剧本创作：只显示「当前剧集」的剧本与编辑区，其余集收进折叠列表 */
export function scriptConsoleHTML(p, m, st) {
  const eps = Array.isArray(m.episodes) ? m.episodes : [];
  if (!eps.length) return '<div class="pv-hint">先完成 ③ 分集拆解，这里才会出现每一集的剧本位。</div>';
  const activeNo = activeEpisodeNo(m);
  const activeEp = eps.find((e) => num(e.no) === activeNo) || eps[0];
  const locked = PMODEL.isFinalized(activeEp);
  const openNos = eps.filter((e) => !PMODEL.isFinalized(e));
  const openMissing = openNos.filter((e) => !e.script).length;
  const cov = PMODEL.scriptCoverage(eps);
  const outline = p.nodes.find((n) => n.type === 'script')?.data?.script;
  const batchBusy = Boolean(ui.script.batchBusy);
  const rows = [activeEp].map((ep) => {
    const no = num(ep.no);
    const prod = PMODEL.episodeProduction(ep);
    const sc = ep.script;
    const open = num(ui.script.openNo) === no;
    const editing = num(ui.script.editNo) === no;
    const draft = editing && ui.script.draft ? ui.script.draft : sc;
    const busyThis = num(ui.script.busyNo) === no;
    return `<article class="sw-item ${open ? 'open' : ''} ${prod.script ? 'has-script' : 'no-script'}">
      <header class="sw-head">
        <span class="sw-no">${PMODEL.episodeLabelFull(PMODEL.seasonOf(ep), no)}</span>
        <div class="sw-title"><strong>${esc(cut(ep.title || `第 ${no} 集`, 34))}</strong>
          <small>${prod.script
            ? `${prod.scenes} 场 · ${prod.lines} 行 · ${fmtNum(prod.chars)} 字 · ${SCRIPT_SOURCE[prod.source] || prod.source}${sc?.generatedAt ? ` · ${fmtDay(sc.generatedAt)}` : ''}${sc?.editedAt && prod.source !== 'manual' ? ' · 已人工编辑' : ''}`
            : '尚未生成剧本 · 生成时会带上上一集结尾与本集钩子'}</small></div>
        <div class="sw-badges"><span class="${epStepDoneLocal(ep, 'context') ? 'on' : ''}">上下文${epStepDoneLocal(ep, 'context') ? ' ✓' : ''}</span>${prod.stages.map((x) => `<span class="${x.done ? 'on' : ''}">${x.label}${x.key === 'grid' && prod.segments ? ` ${prod.grids}/${prod.segments}` : x.done ? ' ✓' : ''}</span>`).join('')}</div>
        <div class="sw-acts">
          <button class="btn sm" data-act="toggle-script" data-no="${no}" ${!prod.script ? 'disabled' : ''}>${open ? '收起源码' : '阅读剧本'}</button>
          <button class="btn sm ${prod.script ? '' : 'primary'}" data-act="gen-ep-script" data-no="${no}" data-force="${prod.script ? 1 : 0}" ${busyThis || batchBusy || locked ? 'disabled' : ''}>${locked ? '🔒 已定稿' : busyThis ? '生成中…' : prod.script ? '↻ 重写' : '✦ 生成本集'}</button>
        </div>
      </header>
      ${open ? (editing && draft ? scriptEditorHTML(ep, draft) : sc ? scriptReaderHTML(ep, sc) : '') : ''}
    </article>`;
  }).join('');
  const others = eps.filter((e) => num(e.no) !== num(activeEp.no)).map((e) => {
    const n = num(e.no);
    const done = Boolean(e.script);
    return `<div class="sw-other">
      <button class="btn sm" data-act="pick-ep" data-no="${n}" title="切换到${PMODEL.episodeLabelFull(PMODEL.seasonOf(e), n)}">${PMODEL.episodeLabelFull(PMODEL.seasonOf(e), n)} →</button>
      <span class="sw-other-t">${esc(cut(e.title || `第 ${n} 集`, 28))}</span>
      <span class="sw-other-s ${done ? 'ok' : ''}">${PMODEL.isFinalized(e) ? '🔒 已定稿' : done ? '✓ 已有剧本' : '尚未写剧本'}</span>
    </div>`;
  }).join('');
  return `<div class="sw">
    ${flowChainLineHTML('script')}
    <div class="epb-scope-line">▤ 当前只显示 <b>${PMODEL.episodeLabelFull(PMODEL.seasonOf(activeEp), activeEp.no)}</b> 的剧本与编辑区${locked ? ' · 🔒 本集已定稿' : ''} · 换集在第③步「分季 · 分集」卡片内的「当前剧集」控制区；各集剧本独立落盘、互不覆盖</div>
    <div class="sw-overview">
      <div class="sw-cov"><b>${cov.written}<em>/${cov.total}</em></b><span>集已有剧本（全项目汇总）</span>
        <div class="sw-bar"><i style="width:${cov.percent}%"></i></div></div>
      <div class="sw-stat"><b>${cov.scenes}</b><span>场次</span></div>
      <div class="sw-stat"><b>${fmtNum(cov.chars)}</b><span>剧本字数</span></div>
      <div class="sw-stat"><b>${cov.bySource.llm}</b><span>大模型</span></div>
      <div class="sw-stat"><b>${cov.bySource.mock}</b><span>模板</span></div>
      <div class="sw-stat"><b>${cov.bySource.manual}</b><span>人工</span></div>
    </div>
    <div class="sw-toolbar">
      <div class="sw-tip">${openMissing
        ? `还有 ${openMissing} 集（未定稿）没有剧本：第 ${openNos.filter((e) => !e.script).map((e) => num(e.no)).slice(0, 8).join('、')} 集${openMissing > 8 ? '…' : ''}`
        : '✓ 所有未定稿集都已有剧本，可逐集精修；四段完成后在流水线定稿'}</div>
      <div class="sw-tool-acts">
        <button class="btn sm primary" data-act="gen-scripts" data-missing="1" ${!openMissing || batchBusy ? 'disabled' : ''}>${batchBusy === 'missing' ? '生成中…' : `✦ 补齐缺失剧本（${openMissing}）`}</button>
        <button class="btn sm" data-act="gen-scripts" data-missing="0" ${!openNos.length || batchBusy ? 'disabled' : ''}>${batchBusy === 'all' ? '重写中…' : '↻ 全部重写（跳过已定稿）'}</button>
        <button class="btn sm" data-act="export-scripts" ${!cov.written ? 'disabled' : ''}>⇩ 导出全部 .md</button>
      </div>
    </div>
    <div class="sw-list">${rows}</div>
    <details class="sw-others"><summary>全部剧集（${eps.length}）· 点集号切换当前剧集 · 以下按钮为跨集批量动作</summary>
      <div class="sw-others-list">${others || '<div class="pv-hint">本项目只有一集。</div>'}</div>
    </details>
    ${outline ? `<details class="sw-outline"><summary>全剧纲要 · 《${esc(cut(outline.title || p.name, 24))}》 · ${(outline.scenes || []).length} 场（项目级）</summary>
      <p>${esc(outline.logline || '')}</p></details>` : ''}
    <div class="pv-hint">剧本按集独立落盘，生成时自动带上「上一集结尾 / 本集钩子 / 本集原文 / 出场角色」；编辑保存后来源标记为「人工编辑」，分镜与导演包会读取最新版本。角色库为全项目共享，已存在则沿用、同名角色直接复用设定与定妆图；本集 ④⑤⑥⑦ 四段全完成后定稿，产物锁定，顺序进入下一集。</div>
  </div>`;
}

/** ④ 角色与上下文 · 任务角色卡
 *
 * 为什么改成「任务卡」：这一块的阅读对象不是「角色设定集」，而是「还有哪些角色的
 * 定妆没出、现在跑到哪一张」。列表式条目只能看到名字和来源，看不出 5 张视图哪张
 * 是真实的、哪张是占位、哪个角色正在生成；一键生成又因为 40 分钟的长任务看起来
 * 像没开始。这里把「角色」和「出图任务」合成一张卡：状态、5 视图真实度、进度、
 * 单角色生成入口都在同一张卡上，SSE 事件直接驱动卡片变化。
 */
const PVIEWS = [
  { key: 'front', label: '正面' },
  { key: 'threeQuarter', label: '3/4 侧' },
  { key: 'side', label: '侧面' },
  { key: 'back', label: '背面' },
  { key: 'closeup', label: '特写' },
];
const isRealShotFE = (v) => Boolean(v?.url) && String(v?.provider || '') !== 'mock';

/** 角色任务状态：优先用后台任务的实时状态，其次按真实出图数量判定 */
function charTaskState(c, jobChar) {
  const real = PVIEWS.filter((v) => isRealShotFE(c.views?.[v.key])).length;
  const mock = PVIEWS.filter((v) => c.views?.[v.key]?.url && !isRealShotFE(c.views[v.key])).length;
  const jv = jobChar?.views || {};
  const running = Object.entries(jv).find(([k, v]) => k !== 'sheet' && v.status === 'running');
  const failed = Object.entries(jv).filter(([k, v]) => k !== 'sheet' && v.status === 'error');
  const jobDone = Object.entries(jv).filter(([k, v]) => k !== 'sheet' && (v.status === 'done' || v.status === 'skip')).length;
  if (running) {
    const def = PVIEWS.find((v) => v.key === running[0]);
    return { id: 'running', label: `生成中 ${jobDone}/5`, sub: def?.label || '', real, mock };
  }
  if (failed.length && !real) return { id: 'error', label: `失败 ${failed.length} 张`, sub: '可重试', real, mock };
  if (real === PVIEWS.length) return { id: 'done', label: '视图齐全', sub: '可进视频', real, mock };
  if (real) return { id: 'partial', label: `真实 ${real}/5`, sub: mock ? `${mock} 张占位` : '待补齐', real, mock };
  if (mock) return { id: 'mock', label: `占位 ${mock} 张`, sub: '待真实重出', real, mock };
  return { id: 'pending', label: '待生成', sub: '0/5', real, mock };
}

function portraitViewMini(c, v, jobChar) {
  const shot = c.views?.[v.key];
  const js = jobChar?.views?.[v.key];
  const real = isRealShotFE(shot);
  const regen = ui.viewRegen?.charId === c.id && ui.viewRegen?.view === v.key;
  const canGen = Boolean(ui.comfy?.imageWorkflow) && !apiStale() && ui.portraitJob?.status !== 'running';
  let cls = 'pvt-v';
  let title = `${v.label} · 待生成（点击生成这一张）`;
  let inner = '<i class="pvt-v-ph"></i>';
  let act = 'char-regen-view';
  if (regen) {
    cls += ' run';
    title = `${v.label} · 正在重新生成`;
    inner = '<i class="pvt-v-run"></i>';
    act = '';
  } else if (js?.status === 'running') {
    cls += ' run';
    title = `${v.label} · 正在生成`;
    inner = '<i class="pvt-v-run"></i>';
    act = '';
  } else if (js?.status === 'done' || real) {
    cls += ' ok';
    title = `${v.label} · ${real ? 'ComfyUI 真实出图' : '本次已生成'}（点击 ↻ 重新生成）`;
    inner = `<img src="${esc(js?.url || shot?.url)}" alt="${esc(v.label)}" loading="lazy">`;
    act = '';
  } else if (shot?.url) {
    cls += ' mock';
    title = `${v.label} · 占位图（未真实生成，点击重新生成）`;
    inner = `<img src="${esc(shot.url)}" alt="${esc(v.label)}" loading="lazy">`;
  } else if (js?.status === 'error') {
    cls += ' err';
    title = `${v.label} · 生成失败（点击重试）`;
  }
  const attrs = act ? ` data-act="${act}" data-char="${esc(c.id)}" data-view="${v.key}"` : '';
  // 已生成的图默认点开详情；右下角单独给一个「↻」重生成按钮，避免误触覆盖
  const regenBtn = canGen && !regen && !js
    ? `<button class="pvt-v-regen" data-act="char-regen-view" data-char="${esc(c.id)}" data-view="${v.key}"
        title="重新生成 ${esc(v.label)}（覆盖当前这张）">↻</button>`
    : '';
  return `<span class="${cls}"${attrs} title="${esc(title)}">${inner}${regenBtn}<em>${esc(v.label)}</em></span>`;
}

/** 任务时间：最近一次运行的收尾时刻（中断也显示，便于判断是不是上次没跑完） */
function jobWhen(job) {
  const t = job?.finishedAt || job?.interruptedAt || job?.startedAt;
  if (!t) return '';
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function portraitJobBarHTML(job) {
  if (!job) return '';
  const pct = job.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
  if (job.status === 'running') {
    const now = job.current ? `${job.current.name || ''} · ${job.current.label || ''}` : '准备下一张…';
    return `<div class="pvt-job run">
      <span class="pvt-job-pulse"></span>
      <div class="pvt-job-text"><b>本地 ComfyUI 生成中</b> ${job.done}/${job.total} · ${esc(now)}</div>
      <div class="pvt-job-bar"><i style="width:${pct}%"></i></div>
      <button class="btn sm" data-act="char-job-cancel">暂停</button>
    </div>`;
  }
  // 中断：进程重启 / 关闭导致任务没跑完。已完成的那部分图不会重烧，补齐缺图即可继续。
  if (job.status === 'interrupted') {
    return `<div class="pvt-job warn">
      <span class="pvt-job-text"><b>上次任务被中断</b> ${job.done || 0}/${job.total || 0}${jobWhen(job) ? ` · ${esc(jobWhen(job))}` : ''}
        · 已生成的图不会重烧，点「补齐缺失图」继续</span>
      <div class="pvt-job-bar"><i style="width:${pct}%"></i></div>
    </div>`;
  }
  const tone = job.status === 'done' ? 'ok' : job.status === 'partial' ? 'warn' : job.status === 'cancelled' ? '' : 'err';
  const label = job.status === 'done' ? '最近一次：完成' : job.status === 'partial' ? '最近一次：部分完成' : job.status === 'cancelled' ? '最近一次：已暂停' : '最近一次：失败';
  return `<div class="pvt-job ${tone}">${label} ${job.done || 0}/${job.total || 0}${jobWhen(job) ? ` · ${esc(jobWhen(job))}` : ''}：${esc(job.message || job.error || '')}${job.failedCount ? ` · 失败 ${job.failedCount} 张` : ''}</div>`;
}

function portraitAreaHTML(p, m) {
  const chars = Array.isArray(m.characters) ? m.characters : [];
  const stale = apiStale();
  const comfyReady = Boolean(ui.comfy?.imageWorkflow) && !stale;
  const job = ui.portraitJob;
  const running = job?.status === 'running' || Boolean(ui.viewRegen);
  const totalReal = chars.reduce((n, c) => n + PVIEWS.filter((v) => isRealShotFE(c.views?.[v.key])).length, 0);
  const totalMock = chars.reduce((n, c) => n + PVIEWS.filter((v) => c.views?.[v.key]?.url && !isRealShotFE(c.views[v.key])).length, 0);
  const totalViews = chars.length * PVIEWS.length;
  const sheetCount = chars.filter((c) => isRealShotFE(c.sheet)).length;
  const pending = totalViews - totalReal;
  return `<div class="pvt-head">
      <div class="pvt-stat"><b>${chars.length}</b><span>位角色</span></div>
      <div class="pvt-stat ok"><b>${totalReal}<em>/${totalViews}</em></b><span>真实定妆</span></div>
      <div class="pvt-stat warn"><b>${pending}</b><span>待生成${totalMock ? `（占位 ${totalMock}）` : ''}</span></div>
      <div class="pvt-stat"><b>${sheetCount}</b><span>定妆板</span></div>
      <div class="pvt-head-acts">
        <button class="btn sm primary" data-act="char-gen-all" ${!chars.length || !comfyReady || running || !pending ? 'disabled' : ''}
          title="${comfyReady ? `补齐缺失的角色图：调用本地 ComfyUI 生成 ${pending} 张（后台任务，可关闭页面）` : '请先到「设置 → 本地 ComfyUI」导入「导出(API)」图像工作流'}">✦ 补齐缺失图${pending ? `（${pending}）` : ''}</button>
        <button class="btn sm" data-act="char-regen-all" ${!chars.length || !comfyReady || running ? 'disabled' : ''}
          title="${comfyReady ? `覆盖重生成全部 ${totalViews} 张角色图 + 定妆板，会覆盖现有图片` : '未配置 ComfyUI 出图工作流'}">↻ 全部重新生成</button>
        ${comfyReady ? '' : '<span class="cf-note">未配置 ComfyUI 出图工作流</span>'}
      </div>
    </div>
    ${stale ? `<div class="pvt-job err">⚠ 服务端仍在运行旧版本（缺少角色出图任务接口），生成会退回占位图。请重启服务：终端 Ctrl+C 后重新执行 <b>npm start</b>，再刷新本页。</div>` : ''}
    ${job
      ? portraitJobBarHTML(job)
      : (chars.length
        ? `<div class="pvt-job pvt-job-none">尚无批量生成记录 · 按真实出图统计：${totalReal}/${totalViews} 张已生成${pending ? `（还差 ${pending} 张）` : ''}；点上方「补齐缺失图」开始生成后，这里会显示逐张任务进度</div>`
        : '')}
    ${chars.length ? `<div class="pvt-grid">${chars.map((c) => {
    const jobChar = job?.byChar?.[c.id];
    const st = charTaskState(c, jobChar);
    const real = st.real;
    const pct = Math.round((real / PVIEWS.length) * 100);
    const front = c.views?.front;
    const avatar = jobChar?.views?.front?.url || (front?.url ? front.url : '');
    const srcLabel = { llm: 'LLM 提取', heuristic: '启发式', manual: '手动' }[c.source] || c.source || '手动';
    return `<article class="pvt-card state-${st.id}" data-char-detail="${esc(c.id)}" title="点击查看角色详情">
        <header class="pvt-card-head">
          <span class="pvt-avatar">${avatar ? `<img src="${esc(avatar)}" alt="">` : '<i></i>'}</span>
          <div class="pvt-id"><b>${esc(c.name)}</b><small>${esc(cut(c.role || '未填写身份', 26))}</small></div>
          <span class="pvt-state ${st.id}">${esc(st.label)}</span>
        </header>
        <div class="pvt-views">${PVIEWS.map((v) => portraitViewMini(c, v, jobChar)).join('')}</div>
        <div class="pvt-meta">
          <span class="pvt-src">${esc(srcLabel)}</span>
          ${c.sheet?.url ? `<span class="pvt-sheet ${isRealShotFE(c.sheet) ? 'ok' : 'mock'}" title="${isRealShotFE(c.sheet) ? '定妆板已生成' : '定妆板为占位图'}">▦ 定妆板</span>` : '<span class="pvt-sheet">定妆板 —</span>'}
          <span class="pvt-sub">${esc(st.sub)}</span>
        </div>
        <div class="pvt-bar"><i style="width:${pct}%"></i></div>
        <footer class="pvt-foot">
          <button class="btn sm" data-act="char-gen-one" data-char="${esc(c.id)}" data-force="${real === PVIEWS.length ? '1' : '0'}" ${!comfyReady || running ? 'disabled' : ''}
            title="${real === PVIEWS.length ? '覆盖重生成这位角色的全部视图与定妆板' : '补齐这位角色缺失 / 占位的视图'}">${real === PVIEWS.length ? '↻ 重出本角色' : '✦ 生成此人'}</button>
          <button class="btn sm ghost" data-act="char-detail" data-char="${esc(c.id)}">详情</button>
        </footer>
      </article>`;
  }).join('')}</div>`
    : '<div class="pv-hint">还没有角色：先「从原著提取角色」，再一键生成定妆图。</div>'}
    <div class="pv-hint">点击卡片查看完整属性 / 原文证据 / 多视图大图；「一键生成全部角色图」在后台逐张调用本地 ComfyUI（可关闭页面，回来继续看进度）。</div>`;
}

/* ------------------------------------------------------------------ 分集制作
 * 第③步剧本创作之后，④角色和上下文 / ⑤分镜与画面 / ⑥视频与交付 都以「集」为
 * 单位独立执行与追踪：每集状态记在 ep.steps[stepId]（后端 episode-runner 落盘），
 * 这里渲染每集一行的执行列表 + 批量补齐入口。单集深度操作（剧本编辑 / 分镜板
 * 逐段 / 成片播放）仍在剧集详情页，这个列表只做「推进与看进度」。
 */
const EP_STEP_TITLES = { context: '角色和上下文', storyboard: '分镜与画面', deliver: '视频与交付' };

/** 本集某步是否已完成：口径统一交给 project-model，前端 / 后端 / 定稿判定同源 */
function epStepDoneLocal(ep, stepId) {
  return PMODEL.episodeStageDone(ep, stepId);
}

/** 本集某步的事实摘要（一行内说清产物） */
function epStepInfo(ep, stepId) {
  if (stepId === 'context') {
    const cast = (ep.characterIds || []).length;
    return `${cast} 位出场角色 · ${ep.script ? '本集剧本已生成' : '本集剧本未生成'}`;
  }
  if (stepId === 'storyboard') {
    const segs = ep.segments || [];
    return `${segs.filter((s) => s.gridUrl).length}/${segs.length} 张分镜板 · ${segs.length} 段`;
  }
  let frames = 0;
  let videos = 0;
  for (const seg of (ep.segments || [])) {
    for (const c of (seg.cells || [])) {
      if (c.url && !/\.svg(\?|$)/i.test(String(c.url))) frames += 1;
      if (c.video?.provider === 'comfyui' && c.video?.file) videos += 1;
    }
  }
  if (!frames) return '还没有可出片的分镜格 · 先出分镜';
  return `${videos}/${frames} 格片段${ep.film?.file ? ` · 成片 ${Number(ep.film.duration).toFixed(0)}s` : ' · 成片未拼'}`;
}

/** 某步尚未完成的集号（批量补齐用；running 中 / 已定稿的集不重复下发） */
function epStepMissingNos(m, stepId) {
  return (m.episodes || [])
    .filter((ep) => !PMODEL.isFinalized(ep))
    .filter((ep) => {
      const st = ep?.steps?.[stepId]?.status;
      if (st === 'running') return false;
      return !epStepDoneLocal(ep, stepId) || st === 'error';
    })
    .map((ep) => Number(ep.no));
}

/* ------------------------------------------------------- 剧集流水线（按集任务）
 * 分集之后，剧本 / 角色·上下文 / 分镜 / 视频四段都是「按集」执行的。以前 ④⑤⑥
 * 各列一遍全集，用户看不出「我选的是哪一集、这一集走到哪、下一步点哪个」。
 * 这里统一成一张按集流水线：每集一行横向摊开四段任务，点行 = 选中该集，
 * 行下方只展开这一集的四段任务与「下一步」；四段之外的项目级动作仍留在本步。
 */
const FLOW_STAGES = [
  { key: 'script', label: '剧本', stepNo: 4, scope: '本集剧本' },
  { key: 'context', label: '角色·上下文', stepNo: 5, scope: '出场角色 + 本集剧本' },
  { key: 'storyboard', label: '分镜', stepNo: 6, scope: '本集分镜板' },
  { key: 'deliver', label: '视频·成片', stepNo: 7, scope: '片段 + 成片 + 导演包' },
];

const ACTIVE_EP_KEY = (pid) => `lxmj.workshop.activeEp.${pid || ''}`;
function readActiveNo(pid) {
  try { return Number(localStorage.getItem(ACTIVE_EP_KEY(pid))) || 0; } catch { return 0; }
}
function writeActiveNo(pid, no) {
  try { localStorage.setItem(ACTIVE_EP_KEY(pid), String(no || '')); } catch { /* 隐私模式忽略 */ }
}

/**
 * 当前剧集：整张工作台只有一个「当前集」身份，④⑤⑥⑦ 都读它。
 * 顺序口径（分季分集之后）：默认第一季第一集 = 队列里第一个未定稿的集；
 * 用户手动选过的集只要还没定稿就保持；一旦该集定稿，自动落到顺序里的下一集。
 */
export function activeEpisodeNo(m) {
  const q = PMODEL.episodeQueue({ management: m });
  if (!q.length) return 0;
  const cur = q.find((x) => num(x.no) === num(ui.activeNo));
  if (cur && !cur.finalized) return num(cur.no);
  return num((q.find((x) => !x.finalized) || q[q.length - 1]).no);
}

/**
 * 切换当前剧集：把上一集的界面状态存档、还原目标集的，做到「后续步骤完全独立」。
 * 剧本展开 / 编辑草稿 / 倍速 / 分镜灯箱都按集隔离，切回来原样还在，绝不串集。
 * 正在执行的任务态（busy）不属于界面存档，保持原样以免任务跑飞。
 */
export function setActiveEpisode(p, no) {
  const target = num(no);
  const eps = Array.isArray(p?.management?.episodes) ? p.management.episodes : [];
  if (!target || !eps.some((e) => num(e.no) === target)) return false;
  const old = num(ui.activeNo);
  // 同一集：不存档也不还原，避免把用户刚展开 / 正在编辑的内容冲掉
  if (old === target) return false;
  if (old) {
    ui.epUI[old] = {
      scriptOpen: num(ui.script.openNo) === old ? old : null,
      scriptEdit: num(ui.script.editNo) === old ? old : null,
      scriptDraft: num(ui.script.editNo) === old ? ui.script.draft : null,
      filmRate: ui.filmRate || 1,
    };
  }
  ui.activeNo = target;
  writeActiveNo(p?.id, target);
  // 旧 DOM 里可能还开着上一集的剧本编辑器：跳过下一次 DOM 捕获，
  // 否则 rerender 时会把上一集的输入框值当成新集的草稿写回来
  ui.skipCapture = true;
  const snap = ui.epUI[target] || {};
  ui.script.openNo = snap.scriptOpen ?? null;
  ui.script.editNo = snap.scriptEdit ?? null;
  ui.script.draft = snap.scriptDraft ?? null;
  ui.filmRate = snap.filmRate ?? 1;
  shotLb = { idx: 0, projectId: '', ctx: null, sheet: false };
  return old !== target;
}

/** 当前剧集作用域快照（只读，供渲染口径测试 / 排查串集问题） */
export function episodeScopeState() {
  return {
    activeNo: num(ui.activeNo),
    openNo: ui.script.openNo,
    editNo: ui.script.editNo,
    hasDraft: Boolean(ui.script.draft),
    filmRate: ui.filmRate || 1,
    skipCapture: Boolean(ui.skipCapture),
    savedNos: Object.keys(ui.epUI).map(Number),
  };
}

/** 第③步「分季 · 分集」卡片内嵌的「当前剧集」控制区（非悬浮）：季 + 集两级、四段进度、顺序制作位与定稿入口。
 *  身份展示已移到中间导航条（navHTML 的 pv-nav-ep / pv-rail-ep），这里只承载切换与推进操作。 */
export function activeEpisodeBarHTML(p, m) {
  const q = PMODEL.episodeQueue(p);
  if (!q.length) return '';
  const no = activeEpisodeNo(m);
  const item = q.find((x) => num(x.no) === no) || q[0];
  const ep = item.ep;
  const idx = q.findIndex((x) => num(x.no) === no);
  const prev = q[idx - 1]?.no || 0;
  const next = q[idx + 1]?.no || 0;
  const groups = PMODEL.seasonFinalProgress(p);
  const season = groups.find((g) => g.no === item.season) || { no: item.season, title: `第 ${item.season} 季`, finalized: 0, total: q.length };
  const chars = Array.isArray(m.characters) ? m.characters : [];
  const chips = FLOW_STAGES.map((s) => {
    const f = flowStage(ep, s.key);
    const mark = f.on === 'done' ? '✓' : f.on === 'doing' ? '◌' : f.on === 'error' ? '✕' : '·';
    return `<span class="epb-st ${f.on}" title="${esc(`${s.label} · ${f.info}`)}">${esc(s.label)} ${mark}</span>`;
  }).join('');
  const seasonOpts = groups.map((g) => {
    const base = PMODEL.seasonLabel(g.no);
    const custom = cut(g.title, 12) === base ? '' : ` · ${esc(cut(g.title, 12))}`;
    return `<option value="${g.no}"${g.no === item.season ? ' selected' : ''}>${base}${custom}（${g.finalized}/${g.total} 集已定稿）</option>`;
  }).join('');
  const opts = q.filter((x) => x.season === item.season).map((x) => {
    const n = num(x.no);
    return `<option value="${n}"${n === no ? ' selected' : ''}>${PMODEL.episodeLabelFull(x.season, n)} · ${esc(cut(x.ep.title || PMODEL.episodeNoLabel(n), 16))}${x.finalized ? ' ✓定稿' : ''}</option>`;
  }).join('');
  const charNote = chars.length
    ? `已沿用 ${chars.length} 位角色（本集出场 ${(ep.characterIds || []).length} 位），切集不重新提取`
    : '尚未建立，首次执行「角色·上下文」提取一次后所有集沿用';
  const stages = PMODEL.episodeStagesDone(ep);
  const finalizeAct = item.finalized
    ? `<button class="btn sm" data-act="finalize-ep" data-no="${no}" data-on="0" title="撤销定稿后可继续修改本集四段">↩ 撤销定稿</button>`
    : PMODEL.canFinalizeEpisode(ep)
      ? `<button class="btn sm primary" data-act="finalize-ep" data-no="${no}" data-on="1" title="四段已完成：定稿本集并自动进入顺序里的下一集">✓ 定稿本集并进入下一集</button>`
      : `<span class="epb-pending">四段还差 ${stages.missing.length} 段 · 全部完成后可定稿</span>`;
  const nextItem = PMODEL.nextPendingEpisode(p, no);
  const allFinal = q.every((x) => x.finalized);
  const nextLabel = nextItem
    ? `下一集 ${PMODEL.queueItemLabel(nextItem)}${nextItem.season !== item.season ? `（进入${PMODEL.seasonLabel(nextItem.season)}）` : ''}`
    : allFinal ? '✓ 本项目所有集已定稿' : '后面没有待定稿集 · 可用上方下拉回到前面未定稿集';
  return `<div class="epb" id="epb" aria-label="当前剧集">
    <div class="epb-main">
      <span class="epb-k">当前剧集</span>
      <span class="epb-no">${PMODEL.episodeLabelFull(item.season, no)}</span>
      <strong class="epb-title" title="${esc(ep.title || `第 ${no} 集`)}">${esc(cut(ep.title || `第 ${no} 集`, 20))}</strong>
      <span class="epb-stages">${chips}</span>
      <div class="epb-switch">
        <select data-season-select aria-label="切换当前季">${seasonOpts}</select>
        <button class="btn sm" data-act="ep-prev" data-no="${prev}" ${prev ? '' : 'disabled'}>‹ 上一集</button>
        <select data-ep-select aria-label="切换当前剧集">${opts}</select>
        <button class="btn sm" data-act="ep-next" data-no="${next}" ${next ? '' : 'disabled'}>下一集 ›</button>
      </div>
    </div>
    <div class="epb-queue">
      <span class="epb-q-label">顺序制作</span>
      <span>${esc(season.title)} · 第 <b>${item.indexInSeason}</b>/${item.seasonSize} 集 · 本季已定稿 <b>${season.finalized}</b>/${season.total}</span>
      <span class="epb-q-next">${item.finalized ? '✓ 本集已定稿' : esc(nextLabel)}</span>
      ${finalizeAct}
    </div>
    <div class="epb-notes">
      <span class="epb-note"><b>④⑤⑥⑦ 只作用于这一集</b> · 剧本 / 上下文 / 分镜 / 成片各集独立落盘，换集即换一套任务与产物；默认第一季第一集，定稿后自动进入下一集、本季做完进入下一季</span>
      <span class="epb-note shared"><b>👤 角色除外</b> · 角色库全项目共享：${esc(charNote)}</span>
    </div>
  </div>`;
}

/** 角色是唯一跨集共享的资源：存在就沿用，不存在才在首次执行时提取一次 */
export function sharedCharactersHTML(m, ep) {
  const chars = Array.isArray(m?.characters) ? m.characters : [];
  const cast = (ep?.characterIds || []).length;
  const note = chars.length
    ? `已沿用 <b>${chars.length}</b> 位角色（本集出场 ${cast} 位）：切换剧集不会重新提取，也不会为每集另建一套角色库。`
    : '尚未建立：首次执行「角色·上下文」会提取全书角色一次，之后所有剧集沿用同一份角色库。';
  return `<div class="pv-card epb-shared">
    <div class="pv-card-head"><span>👤 角色库 · 全项目共享（唯一例外）</span>
      <span class="pv-hint-inline">切集不重置 · 不重抽 · 定稿不重建</span></div>
    <div class="epb-shared-body"><span>${note}</span>
      <span>剧本 / 上下文 / 分镜 / 成片按集独立；只有角色设定与定妆图是全书共用——不同集出现同一角色时按角色 ID 直接复用，不重复提取、不重复出定妆图。下方「从原著提取角色」是项目级手动重提，通常不需要。</span></div>
  </div>`;
}

/** 单集某一段的展示状态：done / doing / error / part / todo */
function flowStage(ep, key) {
  const segs = ep?.segments || [];
  const grids = segs.filter((s) => s.gridUrl).length;
  if (key === 'script') {
    const sc = ep?.script;
    const done = Boolean(sc);
    const scenes = num(sc?.stats?.sceneCount, (sc?.scenes || []).length);
    return {
      key, done, force: done ? '1' : '0',
      on: done ? 'done' : 'todo',
      text: done ? '✓ 剧本' : '剧本未写',
      info: done ? `${scenes} 场 · ${SCRIPT_SOURCE[sc.source] || sc.source || '—'}` : '还没写本集剧本',
    };
  }
  const st = ep?.steps?.[key]?.status || 'pending';
  const done = epStepDoneLocal(ep, key);
  const meta = FLOW_STAGES.find((s) => s.key === key) || { label: key };
  let text = meta.label;
  if (key === 'context') text = done ? '✓ 上下文' : '上下文未跑';
  if (key === 'storyboard') text = done ? '✓ 分镜' : grids ? `${grids}/${segs.length} 分镜` : '分镜未出';
  if (key === 'deliver') text = done ? '✓ 成片' : '视频未出';
  const on = done ? 'done'
    : st === 'running' ? 'doing'
      : st === 'error' ? 'error'
        : (key === 'storyboard' && grids > 0) ? 'part' : 'todo';
  if (on === 'error') {
    text = key === 'context' ? '✕ 上下文失败' : key === 'storyboard' ? '✕ 分镜失败' : '✕ 视频失败';
  } else if (on === 'doing') {
    text = key === 'context' ? '◌ 上下文中' : key === 'storyboard' ? '◌ 分镜中' : '◌ 视频中';
  }
  return { key, done, force: done ? '1' : '0', on, text, info: epStepInfo(ep, key) };
}

/** 这一集的下一步：四段里第一个没完成的；全部完成返回 null */
function epNextStage(ep) {
  return FLOW_STAGES.find((s) => !flowStage(ep, s.key).done) || null;
}

/** 第③步用的说明条：分集一完成就讲清「按季按集顺序制作、四段完成后定稿」 */
export function episodeFlowIntroHTML(p, m) {
  const eps = m.episodes || [];
  if (!eps.length) return '';
  const q = PMODEL.episodeQueue(p);
  const cur = PMODEL.defaultEpisode(p) || q[0];
  if (!cur) return '';
  const stages = PMODEL.episodeStagesDone(cur.ep);
  const nextStage = FLOW_STAGES.find((s) => !stages[s.key]) || null;
  const counts = FLOW_STAGES.map((s) => {
    const n = eps.filter((e) => flowStage(e, s.key).done).length;
    return `<span class="${n === eps.length ? 'ok' : ''}">${esc(s.label)} <b>${n}</b>/${eps.length}</span>`;
  }).join('');
  const seasonLine = PMODEL.seasonFinalProgress(p).map((g) => {
    const base = PMODEL.seasonLabel(g.no);
    const custom = g.title === base ? '' : ` · ${esc(cut(g.title, 12))}`;
    return `<span class="fl-season ${g.allDone ? 'ok' : ''}">${base}${custom} <b>${g.finalized}</b>/${g.total} 定稿</span>`;
  }).join('');
  const queueLine = q.slice(0, 6).map(PMODEL.queueItemLabel).join(' → ') + (q.length > 6 ? ' → …' : '');
  const nextEp = PMODEL.nextPendingEpisode(p, cur.no);
  const nextEpLabel = nextEp
    ? `下一集 ${PMODEL.queueItemLabel(nextEp)}${nextEp.season !== cur.season ? `（${PMODEL.seasonLabel(nextEp.season)}）` : ''}`
    : '所有集已定稿';
  const finalizeBtn = PMODEL.canFinalizeEpisode(cur.ep)
    ? `<button class="btn sm primary" data-act="finalize-ep" data-no="${cur.no}" data-on="1">✓ 定稿 ${PMODEL.queueItemLabel(cur)} 并进入下一集</button>`
    : '';
  return `<div class="pv-card fl-intro">
    <div class="pv-card-head"><span>▥ 分集之后怎么走 · 顺序制作</span><span class="pv-hint-inline">${q.length} 集 / ${PMODEL.seasonFinalProgress(p).length} 季 · 默认第一季第一集</span></div>
    <div class="fl-queue-line"><span>制作队列</span><b>${esc(queueLine)}</b><em>当前制作位 ${PMODEL.queueItemLabel(cur)} · ${esc(nextEpLabel)}</em></div>
    <details class="fl-intro-more"><summary>展开层级说明 / 季进度 / 四段完成度</summary>
      <div class="fl-scope"><span class="fl-scope-k">项目级</span><span class="fl-scope-v">① 基础信息 · ② 准备故事 · ③ 分集拆解 —— 一次作用于全书</span></div>
      <div class="fl-scope"><span class="fl-scope-k on">剧集级</span><span class="fl-scope-v">④ 剧本 → ⑤ 角色·上下文 → ⑥ 分镜 → ⑦ 视频·成片 —— 每集各跑一遍，换集就换一套任务</span></div>
      <div class="fl-scope"><span class="fl-scope-k">例外</span><span class="fl-scope-v">👤 角色库全项目共享：已存在则沿用，切换剧集不重新提取、不为每集另建一套</span></div>
      <div class="fl-scope"><span class="fl-scope-k on">顺序</span><span class="fl-scope-v">先做第一季第一集，四段全完成后「定稿」自动进入同季第二集；本季全部定稿后进入顺序里的下一季第一集。允许用顶部条手动跳集，顺序只决定默认推进。</span></div>
      <div class="fl-seasons">${seasonLine}</div>
      <div class="fl-counts">${counts}</div>
    </details>
    <div class="fl-intro-foot">
      <button class="btn sm primary" data-act="start-ep-flow" data-no="${num(cur.no)}">▶ 从 ${PMODEL.queueItemLabel(cur)} 开始制作（下一步：${esc(nextStage?.label || '定稿本集')}）</button>
      ${finalizeBtn}
      <span class="pv-hint-inline">跳到第 ④ 步并选中这一集，后续 ⑤⑥⑦ 都默认作用在同一集上。</span>
    </div>
  </div>`;
}

/** 一行任务链（剧本台顶部用）：说清「这一集还差哪几段、换集就换一套任务」 */
export function flowChainLineHTML(activeKey) {
  return `<div class="fl-chainline"><span class="fl-chainline-lb">本集任务链</span>${FLOW_STAGES
    .map((s, i) => `${i ? '<em>→</em>' : ''}<span class="fl-chainstep ${activeKey === s.key ? 'on' : ''}">${esc(s.label)}</span>`)
    .join('')}<i>换集 = 换一套任务（角色库全书共享、同名角色直接复用）；四段都完成 → 定稿 → 顺序进入下一集。</i></div>`;
}

/** 当前选中剧集的任务面板：四段任务 + 定稿 / 撤销 + 本集详情入口 */
function flowPanelHTML(ep, focusKey, busyAny, m) {
  const no = num(ep.no);
  const charsN = Array.isArray(m?.characters) ? m.characters.length : 0;
  const locked = PMODEL.isFinalized(ep);
  const stages = PMODEL.episodeStagesDone(ep);
  const rows = FLOW_STAGES.map((s, i) => {
    const f = flowStage(ep, s.key);
    // 上下文段的角色来自全项目共享库：这是四段里唯一不随切集重置的东西
    const info = s.key === 'context'
      ? `${f.info} · ${charsN ? `沿用全书角色库 ${charsN} 位` : '首次执行会提取全书角色'}`
      : f.info;
    const act = s.key === 'script'
      ? `data-act="gen-ep-script" data-force="${f.force}"`
      : `data-act="run-ep-step" data-step="${s.key}" data-force="${f.force}"`;
    const busy = s.key === 'script'
      ? num(ui.script.busyNo) === no
      : ui.epStep.busyStep === s.key && num(ui.epStep.busyNo) === no;
    const disabled = busyAny || locked ? 'disabled' : '';
    return `<li class="fl-t ${f.on}${focusKey === s.key ? ' focus' : ''}${locked ? ' locked' : ''}">
      <span class="fl-t-no">${i + 1}</span>
      <div class="fl-t-main"><b>${esc(s.label)}</b><small>${esc(info)}${locked ? ' · 🔒 已定稿' : ''}</small></div>
      <button class="btn sm ${f.done ? '' : 'primary'}" ${act} data-no="${no}" ${disabled}>${busy ? '执行中…' : locked ? '🔒 锁定' : f.done ? '↻ 重做' : '▶ 执行'}</button>
    </li>`;
  }).join('');
  const finishAct = locked
    ? `<button class="btn sm" data-act="finalize-ep" data-no="${no}" data-on="0">↩ 撤销定稿（继续修改本集）</button>`
    : PMODEL.canFinalizeEpisode(ep)
      ? `<button class="btn sm primary" data-act="finalize-ep" data-no="${no}" data-on="1">✓ 定稿本集并进入下一集</button>`
      : '';
  const finishHint = locked
    ? '🔒 本集已定稿，四段产物锁定；撤销后才能重做，定稿不影响角色库（全书共用）。'
    : stages.done
      ? '四段都已完成：定稿后自动进入顺序里的下一集（本季做完进入下一季）。'
      : `四段还差 ${stages.missing.length} 段，全部完成后才能定稿。角色库是唯一例外，${charsN ? `沿用已有 ${charsN} 位` : '首次提取后全书共用'}。`;
  return `<div class="fl-panel">
    <div class="fl-panel-head"><b>当前剧集 · ${PMODEL.episodeLabelFull(PMODEL.seasonOf(ep), no)}《${esc(cut(ep.title || PMODEL.episodeNoLabel(no), 20))}》</b>
      <span>下面四段只作用于这一集，换集即换一套</span></div>
    <ol class="fl-tasks">${rows}</ol>
    <div class="fl-panel-foot">
      <button class="btn sm" data-act="open-episode" data-no="${no}">▤ 打开剧集详情</button>
      ${finishAct}
      <span class="pv-hint-inline">${finishHint}</span>
    </div>
  </div>`;
}

/** 剧集流水线主卡：按季分组、每集一行四段；已定稿集锁定并只读 */
export function episodeFlowHTML(p, m, focusKey) {
  const eps = m.episodes || [];
  if (!eps.length) return '<div class="pv-hint">还没有分集：先在第 ③ 步完成「分集拆解」，这里才会出现按集任务。</div>';
  // 全工作台只认一个当前集：顶部切换条 / 流水线 / 区头都通过 activeEpisodeNo 对齐
  ui.activeNo = activeEpisodeNo(m);
  const busyAny = Boolean(ui.epStep.busyNo || ui.epStep.batchBusy || ui.script.busyNo || ui.script.batchBusy);
  const focus = FLOW_STAGES.find((s) => s.key === focusKey) || null;
  const groups = PMODEL.seasonGroups(p);
  const progress = PMODEL.seasonFinalProgress(p);
  const q = PMODEL.episodeQueue(p);
  const finalizedN = q.filter((x) => x.finalized).length;
  const allDone = eps.filter((e) => !epNextStage(e)).length;
  const counts = FLOW_STAGES.map((s) => {
    const n = eps.filter((e) => flowStage(e, s.key).done).length;
    const on = focusKey === s.key ? ' on' : '';
    return `<span class="fl-count${on} ${n === eps.length ? 'ok' : ''}">${esc(s.label)} <b>${n}</b>/${eps.length}</span>`;
  }).join('');
  const missing = focusKey && focusKey !== 'script' ? epStepMissingNos(m, focusKey) : [];
  const scriptMissing = focusKey === 'script' ? eps.filter((e) => !e.script && !PMODEL.isFinalized(e)).length : 0;
  const batchN = focusKey === 'script' ? scriptMissing : missing.length;
  const batch = focusKey
    ? `<button class="btn sm" ${focusKey === 'script'
      ? 'data-act="gen-scripts" data-missing="1"'
      : `data-act="run-ep-steps" data-step="${focusKey}"`} ${!batchN || busyAny ? 'disabled' : ''}>✦ 补齐未完成「${esc(focus?.label || '')}」的集（${batchN}）</button>`
    : '';
  const rowHTML = (ep) => {
    const no = num(ep.no);
    const active = num(ui.activeNo) === no;
    const locked = PMODEL.isFinalized(ep);
    const chips = FLOW_STAGES.map((s) => {
      const f = flowStage(ep, s.key);
      const on = focusKey === s.key ? ' focus' : '';
      return `<span class="fl-st ${f.on}${on}" title="${esc(`${s.label} · ${f.info}`)}">${esc(f.text)}</span>`;
    }).join('');
    const next = epNextStage(ep);
    const nextRunning = next ? flowStage(ep, next.key).on === 'doing' : false;
    const nextBtn = locked
      ? '<span class="fl-locked">🔒 已定稿</span>'
      : next
        ? `<button class="btn sm primary fl-next" ${next.key === 'script'
          ? `data-act="gen-ep-script" data-force="${flowStage(ep, 'script').force}"`
          : `data-act="run-ep-step" data-step="${next.key}" data-force="${flowStage(ep, next.key).force}"`} data-no="${no}" ${busyAny || nextRunning ? 'disabled' : ''}>${nextRunning ? `进行中 · ${esc(next.label)}` : `下一步 · ${esc(next.label)}`}</button>`
        : '<span class="fl-alldone">✓ 四段已完成</span>';
    return `<div class="fl-row ${active ? 'on' : ''}${locked ? ' locked' : ''}" data-ep-row="${no}">
      <button class="fl-pick" data-act="pick-ep" data-no="${no}" aria-pressed="${active}" title="选中第 ${no} 集：下方只展开这一集的任务">
        <span class="fl-no">${PMODEL.episodeLabelFull(PMODEL.seasonOf(ep), no)}</span>
        <span class="fl-title">${esc(cut(ep.title || `第 ${no} 集`, 22))}</span>
      </button>
      <span class="fl-stages">${chips}</span>
      ${nextBtn}
      ${locked ? `<button class="btn sm fl-unfin" data-act="finalize-ep" data-no="${no}" data-on="0" title="撤销定稿后可以继续修改本集">↩ 撤销</button>` : ''}
      <button class="btn sm fl-detail" data-act="open-episode" data-no="${no}">详情</button>
      ${active ? flowPanelHTML(ep, focusKey, busyAny, m) : ''}
    </div>`;
  };
  const rows = groups.map((g) => {
    const pr = progress.find((x) => x.no === g.no) || { finalized: 0, total: g.episodes.length };
    return `<div class="fl-season-group">
      <div class="fl-season-head"><span class="fl-season-mark">${PMODEL.seasonLabel(g.no)}</span>
        ${g.title === PMODEL.seasonLabel(g.no) ? '' : `<b>${esc(g.title)}</b>`}<span>${g.episodes.length} 集 · 已定稿 <b>${pr.finalized}</b>/${pr.total}${pr.allDone ? ' ✓ 全季完成' : ''}</span></div>
      ${g.episodes.map(rowHTML).join('')}
    </div>`;
  }).join('');
  return `<div class="pv-card pv-flow">
    <div class="pv-card-head"><span>▥ 剧集流水线 · 按季顺序 · 每集四段任务</span>
      <span class="pv-hint-inline">${groups.length} 季 / ${eps.length} 集 · 已定稿 ${finalizedN}/${eps.length} · 四段全完成 ${allDone}/${eps.length}${focus ? ` · 当前在第 ${focus.stepNo} 步「${focus.label}」` : ''}</span></div>
    <div class="fl-scope"><span class="fl-scope-k">项目级</span><span class="fl-scope-v">准备故事 · 分集拆解 · 角色库 —— 一次作用于全书，与集无关；角色已存在则沿用，切集不重抽</span></div>
    <div class="fl-scope"><span class="fl-scope-k on">剧集级</span><span class="fl-scope-v">剧本 → 角色·上下文 → 分镜 → 视频·成片 —— 选中哪一集，下面四段就作用在哪一集；各集任务与产物完全独立</span></div>
    <div class="fl-scope"><span class="fl-scope-k on">顺序</span><span class="fl-scope-v">默认第一季第一集；四段全完成 → 定稿 → 自动进入同季下一集；本季全部定稿 → 进入下一季第一集。已定稿集锁定，撤销后才可重做。</span></div>
    <div class="fl-counts">${counts}</div>
    <div class="fl-list">${rows}</div>
    <div class="fl-acts">
      ${batch}
      <span class="pv-hint-inline">批量只补「这一段的未完成集」，跳过已定稿集；单集的深度操作（剧本编辑 / 分镜板逐段 / 成片播放）在剧集详情页。</span>
    </div>
  </div>`;
}

/** ⑤ 角色与上下文：按集任务在上，共享角色库在下（唯一例外，切集不重置） */
function contextConsoleHTML(p, m, st, busy) {
  const has = !!m.source?.text;
  const no = activeEpisodeNo(m);
  const ep = (m.episodes || []).find((e) => num(e.no) === no) || null;
  return `${episodeFlowHTML(p, m, 'context')}
    ${sharedCharactersHTML(m, ep)}
    <div class="epb-proj-label">↓ 以下是项目级角色资产（全项目共用，不属于任何一集）</div>
    <div class="pv-char-acts">
      <button class="btn sm primary" data-act="char-extract" data-mode="llm" ${!has || busy ? 'disabled' : ''}>✦ 从原著提取角色（LLM）</button>
      <button class="btn sm" data-act="char-extract" data-mode="heuristic" ${!has || busy ? 'disabled' : ''}>⚙ 启发式提取</button>
      <button class="btn sm" data-act="chars">👤 角色管理（多视图定妆）</button>
    </div>
    ${!has ? '<div class="pv-hint">先在第 ② 步准备故事，才能提取角色。</div>' : ''}
    <div data-portrait-area>${portraitAreaHTML(p, m)}</div>`;
}

/* ------------------------------------------------------------------ 分镜数据
 * 第⑤步的每一镜都要能回答三个问题：提示词写了什么、图到底出了没有、能不能点开看。
 * 这里把 shot → keyframe → review 的关系一次性摊平成卡片数据，
 * 渲染与灯箱共用同一份（避免统计用一套口径、行内用另一套）。
 */
let shotCards = [];
let shotLb = { idx: 0, projectId: '', ctx: null, sheet: false };

function storyboardShotData(p) {
  const nodes = p.nodes || [];
  const edges = p.edges || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childOf = (id, type) => edges.filter((e) => e.from === id)
    .map((e) => byId.get(e.to)).find((n) => n && n.type === type);
  const shots = nodes.filter((n) => n.type === 'shot')
    .sort((a, b) => (Number(a.data?.shot?.sequence || a.data?.shot?.shotNo || 0)
      - Number(b.data?.shot?.sequence || b.data?.shot?.shotNo || 0)));
  return shots.map((node, idx) => {
    const shot = node.data?.shot || {};
    const kf = childOf(node.id, 'keyframe');
    const rev = kf ? childOf(kf.id, 'review') : null;
    const candidates = (rev?.data?.candidates?.length ? rev.data.candidates : kf?.data?.candidates || [])
      .filter((c) => c?.url);
    const chosenUrl = rev?.data?.keyframeUrl || candidates[0]?.url || '';
    const chosen = candidates.find((c) => c.url === chosenUrl) || candidates[0] || null;
    return {
      idx, shotId: node.id, kfId: kf?.id || '',
      shotNo: shot.shotNo ?? idx + 1,
      size: shot.size || '', angle: shot.angle || '', movement: shot.movement || '',
      motion: shot.motionDesc || '', audio: shot.audioDesc || '',
      duration: shot.duration || '', characters: shot.characters || [],
      prompt: chosen?.prompt || shot.ffDesc || '',
      ffDesc: shot.ffDesc || '',
      url: chosen?.url || '', provider: chosen?.provider || '',
      real: isRealShot(chosen), candidates,
      // 画面设置下沉到相机位：灯箱里能说明「这一镜在分镜板第几格、什么画幅」
      panel: shot.panel ?? null,
      sheet: kf?.data?.sheet || rev?.data?.sheet || null,
      error: kf?.error || '',
    };
  });
}

/** ⑤ 分镜与画面：只出「分镜提示词 + 分镜图 + 分镜板」，视频留给第⑥步 */
function storyboardConsoleHTML(p, m) {
  const cards = storyboardShotData(p);
  shotCards = cards;
  const total = cards.length;
  const realN = cards.filter((c) => c.real).length;
  const placeholderN = cards.filter((c) => !c.real && c.url).length;
  const missingN = Math.max(0, total - realN - placeholderN);
  const grids = (m.episodes || []).reduce((a, ep) => a + (ep.segments || []).filter((s) => s.gridUrl).length, 0);
  const wantGrids = (m.episodes || []).reduce((a, ep) => a + (ep.segments || []).length, 0);
  const layout = storyboardLayout(m.storyboard?.layout);
  const stepState = (m.steps || []).find((s) => s.id === 'storyboard');
  // 「已完成但 0 张真图」是最误导人的状态：显式标红，不要让绿灯盖住缺口
  const doneButEmpty = stepState?.status === 'done' && realN === 0 && total > 0;
  // 服务端还是旧进程时，真实图口径不可信（旧版会把 mock 占位当已出图）：先提示重启
  const staleApi = Array.isArray(ui.api?.capabilities) && !ui.api.capabilities.includes('storyboard-real-image-check');
  const cells = [
    ['镜头', total],
    ['真实分镜图', `${realN}/${total}`],
    ['占位图', placeholderN],
    ['分镜板', wantGrids ? `${grids}/${wantGrids}` : grids],
    ['待出图', missingN],
  ];

  const rows = cards.map((c) => {
    const cls = c.real ? 'real' : c.url ? 'mock' : 'empty';
    const badge = c.real ? '<em class="pvs-badge ok">真实图</em>'
      : c.url ? '<em class="pvs-badge mock">占位图 · 未真实生成</em>'
        : '<em class="pvs-badge">待出图</em>';
    const thumbInner = c.url
      ? `<img src="${esc(c.url)}" alt="镜头 ${esc(String(c.shotNo))}" loading="lazy">`
      : '<span class="pvs-empty"><b>未出图</b><small>点此看提示词</small></span>';
    const panelTag = c.panel ? `<em class="pvs-panel">第 ${c.panel} 格</em>` : '';
    return `<article class="pvs-shot ${cls}">
      <button class="pvs-thumb" data-act="shot-open" data-idx="${c.idx}" title="点击查看大图与完整分镜提示词">
        ${thumbInner}
        <span class="pvs-no">#${esc(String(c.shotNo))}</span>
        ${c.url ? `<span class="pvs-mark ${c.real ? 'ok' : 'mock'}">${c.real ? '已出图' : '占位'}</span>` : ''}
      </button>
      <div class="pvs-body">
        <div class="pvs-spec"><b>${esc(c.size || '镜头')}</b><span>${esc([c.angle, c.movement].filter(Boolean).join(' · '))}</span>${badge}${panelTag}</div>
        <button class="pvs-prompt" data-act="shot-open" data-idx="${c.idx}" title="点击查看完整分镜提示词">${esc(cut(c.prompt, 120))}${c.prompt.length > 120 ? '<i class="pvs-more">… 查看全文</i>' : ''}</button>
        <div class="pvs-acts">
          <button class="btn sm" data-act="shot-open" data-idx="${c.idx}">🔍 大图 · 提示词</button>
          <button class="btn sm" data-act="shot-regen" data-idx="${c.idx}">↻ 重出本镜</button>
          ${c.error ? `<span class="pvs-err" title="${esc(c.error)}">出图报错</span>` : ''}
        </div>
      </div>
    </article>`;
  }).join('');

  return `${episodeFlowHTML(p, m, 'storyboard')}
    <div class="epb-proj-label">↓ 以下统计与分镜图为全项目画布汇总（跨集）；按集的分镜产物与执行在上方流水线 / 剧集详情页</div>
    <div class="pv-res-grid five">${cells.map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join('')}</div>
    ${doneButEmpty
      ? `<div class="pvs-warn">⚠ 这一步被标记为「已完成」，但 <b>0 张真实分镜图</b>${placeholderN ? `（${placeholderN} 张只是占位示意图）` : ''}${missingN ? `，另有 ${missingN} 镜未出图` : ''}。已按真实产物判定为失效：点右上角「↻ 重试本步」重新出图。</div>`
      : ''}
    ${staleApi ? '<div class="pvs-warn">服务端还是旧版本：当前统计可能把占位示意图算成「已出图」。请重启服务后再看本步。</div>' : ''}
    <div class="pv-taskbox" id="pv-taskbox" data-task-area>${taskPanelHTML(p, { kinds: TASK_KINDS_STEP6 })}</div>
    ${storyboardFrameSettingsHTML(p, m)}
    ${storyboardSheetsHTML(m)}
    ${total
      ? `<div class="pvs-head"><b>分镜提示词 · 分镜图</b><span>真实 ${realN}/${total} 镜${placeholderN ? ` · 占位 ${placeholderN}` : ''}${missingN ? ` · 待出 ${missingN}` : ''} · 每段 ${layout.cells} 格（${esc(layout.label)} ${layout.cols}×${layout.rows}）</span></div>
         <div class="pvs-list">${rows}</div>`
      : '<div class="pv-hint">还没有分镜：先执行第④步「RAG · 角色 · 层次分解」把事件 → 场景 → 镜头展开到画布，再来本步生成分镜提示词与画面。</div>'}
    <div class="pv-hint">本步只产出<b>分镜提示词 + 分镜图 + 分镜板</b>（每镜 best-of-2 择优；分镜板按上方版式每段合一张，格内带景别 / 机位 / 动作标注）；<b>视频片段与转场视频统一在第⑥步生成</b>。点缩略图可看大图与完整提示词，「↻ 重出本镜」只重跑这一镜。</div>
    <div class="pv-console-acts">
      <button class="btn sm primary" data-step="deliver">▶ 画面就绪，去第⑥步生成视频</button>
      <button class="btn sm" data-act="open-canvas">⬡ 在画布中查看分镜链</button>
    </div>`;
}

/* ------------------------------------------------ 第⑥步任务看板：局部重绘与交互 */
/** 本步只负责「画面」类任务：关键帧 + 择优。视频 / 转场任务要等到「成片交付」那一步才会发送。 */
const TASK_KINDS_STEP6 = ['keyframe', 'review'];
/** 只重绘任务看板（不重建整页，不打断其它步骤里正在编辑的表单） */
export function refreshTaskPanel() {
  const host = liveCtx?.host;
  const p = liveCtx?.p;
  if (!host || !p) return;
  const box = host.querySelector('#pv-taskbox');
  if (!box) return;
  box.innerHTML = taskPanelHTML(p, { kinds: TASK_KINDS_STEP6 });
  mountTaskPanelActs(host, liveCtx.ctx);
}

/**
 * 任务看板的交互挂载：刷新按钮 + prompt_id 复制。
 * 看板会被 refreshTaskPanel() 反复重建，所以每次重绘后都要重新绑定。
 */
function mountTaskPanelActs(host, ctx) {
  const box = host.querySelector('#pv-taskbox');
  if (!box) { stopTaskTicker(); return; }
  const toast = ctx?.toast || (() => {});
  box.querySelectorAll('[data-act="task-refresh"]').forEach((b) => b.addEventListener('click', () => {
    refreshTaskPanel();
    toast('任务状态已刷新', 'ok');
  }));
  /**
   * 「⟲ 检查已完成」：去 ComfyUI 核对本步任务。
   * 关键点：已经跑完的直接取回，不重新生成；仍在排队 / 执行中的只更新状态；
   * 只有 ComfyUI 侧也查不到的，才询问是否重新发送。
   */
  box.querySelectorAll('[data-act="task-reconcile"]').forEach((b) => b.addEventListener('click', async () => {
    const projectId = liveCtx?.p?.id;
    if (!projectId || b.disabled) return;
    const old = b.textContent;
    b.disabled = true;
    b.textContent = '核对中…';
    try {
      let d = await api(`/api/projects/${projectId}/comfy/reconcile`, {});
      if (!d.ok) {
        toast(d.message || '无法连接 ComfyUI：请确认本机 ComfyUI 已启动', 'err');
        return;
      }
      const taken = d.adopted?.length || 0;
      if (taken) {
        toast(`⟲ 已从 ComfyUI 取回 ${taken} 条已完成任务（没有重新生成）`, 'ok');
      } else if (!d.lost?.length) {
        toast(d.message || 'ComfyUI 里没有需要处理的任务', 'ok');
      }
      if (d.lost?.length) {
        const go = window.confirm(
          `有 ${d.lost.length} 条任务在 ComfyUI 里找不到结果（从未真正发出，或它的历史已被清空）。\n\n` +
          `· 确定：只重新发送这 ${d.lost.length} 条\n` +
          `· 取消：先标为「待发送」，稍后自己点「▶ 执行本步」`);
        if (go) {
          b.textContent = '重发中…';
          d = await api(`/api/projects/${projectId}/comfy/reconcile`, { resubmit: true });
          const ok = d.resubmit?.started;
          toast(ok
            ? `↻ 已重新发送 ${d.resubmit.count} 条任务${d.resubmit.run ? ` · 执行 ${d.resubmit.run.nodes} 个节点` : ''}`
            : (d.resubmit?.message || '重发未开始'), ok ? 'ok' : 'err');
        }
      } else if (d.running?.length || d.queued?.length) {
        const bits = [];
        if (d.running?.length) bits.push(`${d.running.length} 条仍在生成`);
        if (d.queued?.length) bits.push(`${d.queued.length} 条仍在 ComfyUI 排队`);
        toast(`${bits.join('，')}：完成后会自动取回，不用重新生成`, 'ok');
      }
      await ctx.onChanged?.();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      b.disabled = false;
      b.textContent = old;
    }
  }));
  box.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.copy;
    const ok = await copyPromptId(id);
    toast(ok ? `已复制 prompt_id：${id}` : '复制失败：请手动选中文本复制', ok ? 'ok' : 'err');
  }));
  // 有进行中任务时每秒刷新「已用时」；没有任务时 ticker 会自行退出
  startTaskTicker();
  // 页面一打开就静默对一次账：上次运行被中断会留下「排队中」的残留节点，
  // 不自动核对的话它们会一直挂着 —— ComfyUI 里可能早已跑完，也可能从未真正发出。
  maybeAutoReconcile(ctx);
}

let lastAutoCheck = { at: 0, projectId: '' };

/**
 * 打开第⑥步时的静默自检（15 秒内只跑一次，且只在确实有 queued/running 节点时才发请求）。
 * 服务端在项目正在运行时会直接跳过，所以不会干扰实时调度。
 * 结果通过 state 事件回到页面：取回的标完成，查无结果的转「待发送」，不再假装已发送。
 */
function maybeAutoReconcile(ctx) {
  const projectId = liveCtx?.p?.id;
  if (!projectId) return;
  const waiting = (liveCtx.p.nodes || []).some((n) => n.status === 'queued' || n.status === 'running');
  if (!waiting) return;
  const now = Date.now();
  if (lastAutoCheck.projectId === projectId && now - lastAutoCheck.at < 15000) return;
  lastAutoCheck = { at: now, projectId };
  api(`/api/projects/${projectId}/comfy/reconcile`, { auto: true })
    .then((d) => {
      if (!d?.ok || d.skipped) return;
      const adopted = d.adopted?.length || 0;
      const reset = d.reset?.length || 0;
      if (!adopted && !reset) return;
      const bits = [];
      if (adopted) bits.push(`从 ComfyUI 取回 ${adopted} 条已完成`);
      if (reset) bits.push(`${reset} 条查无结果，转为待发送`);
      const toast = ctx?.toast || (() => {});
      toast(`⟲ 自动核对：${bits.join(' · ')}`, 'ok');
    })
    .catch(() => { /* 自检失败不打扰用户，手动「⟲ 检查已完成」仍可用 */ });
}

/* -------------------------------------------------- 分镜灯箱：大图 + 完整提示词 + 重出本镜 */
function shotLbEl() {
  let el = document.getElementById('pvs-lb');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'pvs-lb';
  el.className = 'pvs-lb';
  el.hidden = true;
  el.innerHTML = `<div class="pvs-lb-mask" data-lb="close"></div>
    <div class="pvs-lb-panel" role="dialog" aria-modal="true" aria-label="分镜详情"><div class="pvs-lb-content"></div></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => {
    const hit = e.target.closest('[data-lb]');
    if (!hit) return;
    const act = hit.dataset.lb;
    if (act === 'close') closeShotLightbox();
    else if (act === 'prev') stepShotLightbox(-1);
    else if (act === 'next') stepShotLightbox(1);
    else if (act === 'copy') copyShotPrompt(hit);
    else if (act === 'regen') regenShotInLightbox(hit);
    else if (act === 'cand') {
      const card = shotCards[shotLb.idx];
      const cand = card?.candidates[Number(hit.dataset.i)];
      if (cand) paintShotLightbox({ ...card, url: cand.url, provider: cand.provider || '', real: isRealShot(cand) });
    }
  });
  document.addEventListener('keydown', (e) => {
    if (shotLbEl().hidden) return;
    // 分镜板预览没有「上一镜 / 下一镜」，只响应关闭，避免 ←/→ 把内容换成分镜图
    if (shotLb.sheet) {
      if (e.key === 'Escape') closeShotLightbox();
      return;
    }
    if (e.key === 'Escape') closeShotLightbox();
    else if (e.key === 'ArrowLeft') stepShotLightbox(-1);
    else if (e.key === 'ArrowRight') stepShotLightbox(1);
  });
  return el;
}

function openShotLightbox(idx, ctx) {
  const card = shotCards[idx];
  if (!card) return;
  if (ctx) shotLb.ctx = ctx;
  shotLb.idx = idx;
  shotLb.sheet = false;
  const el = shotLbEl();
  el.hidden = false;
  document.body.classList.add('pvs-lb-open');
  paintShotLightbox(card);
}

/**
 * 分镜板大图：复用同一个灯箱容器，只换内容。
 * 九宫格是横向大图、竖屏版式是超长图，浏览器 <img> 自然缩放比新窗口更省事。
 */
function openSheetPreview(url, title) {
  if (!url) return;
  const el = shotLbEl();
  shotLb.sheet = true;
  el.hidden = false;
  document.body.classList.add('pvs-lb-open');
  el.querySelector('.pvs-lb-content').innerHTML = `<div class="pvs-lb-head">
      <div class="pvs-lb-title"><b>${esc(title || '分镜板')}</b><span>版式由「分镜画面设置」决定 · 可下载 SVG 源文件</span></div>
      <div class="pvs-lb-tools">
        <a class="pvs-lb-ico" href="${esc(url)}" download target="_blank" rel="noopener" title="下载 / 新窗口打开">⤓</a>
        <button class="pvs-lb-ico" data-lb="close" title="关闭（Esc）">✕</button>
      </div>
    </div>
    <div class="pvs-sheet-full"><img src="${esc(url)}" alt="${esc(title || '分镜板')}"></div>`;
}

function closeShotLightbox() {
  const el = shotLbEl();
  el.hidden = true;
  el.querySelector('.pvs-lb-content').innerHTML = '';
  shotLb.sheet = false;
  document.body.classList.remove('pvs-lb-open');
}

function stepShotLightbox(delta) {
  const next = shotLb.idx + delta;
  if (next < 0 || next >= shotCards.length) return;
  shotLb.idx = next;
  paintShotLightbox(shotCards[next]);
}

function paintShotLightbox(card) {
  if (!card) return;
  const el = shotLbEl();
  const box = el.querySelector('.pvs-lb-content');
  const total = shotCards.length;
  const cands = card.candidates || [];
  const state = card.real
    ? '<em class="pvs-badge ok">真实图</em>'
    : card.url ? '<em class="pvs-badge mock">占位图 · 未真实生成</em>' : '<em class="pvs-badge">待出图</em>';
  box.innerHTML = `<div class="pvs-lb-head">
      <div class="pvs-lb-title"><b>镜头 #${esc(String(card.shotNo))}</b>
        <span>${esc([card.size, card.angle, card.movement].filter(Boolean).join(' · ') || '未填写镜头规格')}</span>${state}</div>
      <div class="pvs-lb-tools">
        <button class="pvs-lb-ico" data-lb="prev" title="上一镜（←）" ${shotLb.idx <= 0 ? 'disabled' : ''}>‹</button>
        <span class="pvs-lb-count">${shotLb.idx + 1} / ${total}</span>
        <button class="pvs-lb-ico" data-lb="next" title="下一镜（→）" ${shotLb.idx >= total - 1 ? 'disabled' : ''}>›</button>
        <button class="pvs-lb-ico" data-lb="close" title="关闭（Esc）">✕</button>
      </div>
    </div>
    <div class="pvs-lb-body">
      <div class="pvs-lb-media">
        ${card.url
          ? `<img src="${esc(card.url)}" alt="镜头 ${esc(String(card.shotNo))} 分镜图">`
          : `<div class="pvs-lb-none"><b>还没有分镜图</b><span>${esc(card.error || '点下方「↻ 重出本镜」生成本镜画面')}</span></div>`}
        ${cands.length > 1 ? `<div class="pvs-lb-cands">${cands.map((c, i) => `<button class="pvs-lb-cand ${c.url === card.url ? 'on' : ''}" data-lb="cand" data-i="${i}" title="候选 ${i + 1}">
          <img src="${esc(c.url)}" alt="候选 ${i + 1}"><small>${c.url === card.url ? '当前' : `候选 ${i + 1}`}</small></button>`).join('')}</div>` : ''}
      </div>
      <div class="pvs-lb-side">
        <dl class="pvs-lb-meta">
          <div><dt>景别</dt><dd>${esc(card.size || '—')}</dd></div>
          <div><dt>机位</dt><dd>${esc([card.angle, card.movement].filter(Boolean).join(' · ') || '—')}</dd></div>
          <div><dt>时长</dt><dd>${esc(card.duration ? `${card.duration}s` : '—')}</dd></div>
          <div><dt>出场</dt><dd>${esc((card.characters || []).join('、') || '—')}</dd></div>
          ${(card.panel || card.sheet)
    ? `<div><dt>分镜板格位</dt><dd>${esc(card.sheet
      ? `${storyboardLayout(card.sheet.layout).label} 第 ${card.panel || card.sheet.panel}/${card.sheet.cells} 格 · ${card.sheet.aspect || ''}`
      : `第 ${card.panel} 格`)}</dd></div>`
    : ''}
        </dl>
        ${card.sheet?.note ? `<div class="pvs-lb-note">画面设置：${esc(card.sheet.note)}</div>` : ''}
        <div class="pvs-lb-block">
          <div class="pvs-lb-label">分镜提示词 <span>${card.prompt.length} 字</span></div>
          <p class="pvs-lb-prompt">${esc(card.prompt || '（该镜头还没有提示词）')}</p>
        </div>
        ${card.motion ? `<div class="pvs-lb-block"><div class="pvs-lb-label">运动描述</div><p class="pvs-lb-prompt">${esc(card.motion)}</p></div>` : ''}
        ${card.audio ? `<div class="pvs-lb-block"><div class="pvs-lb-label">声音</div><p class="pvs-lb-prompt">${esc(card.audio)}</p></div>` : ''}
        <div class="pvs-lb-acts">
          <button class="btn sm" data-lb="copy">⧉ 复制提示词</button>
          <button class="btn sm primary" data-lb="regen" ${card.shotId ? '' : 'disabled'}>↻ 重出本镜</button>
        </div>
        <div class="pvs-lb-note">重出只影响这一镜：其它已出图的分镜不会被重新生成。</div>
      </div>
    </div>`;
}

async function copyShotPrompt(btn) {
  const text = shotCards[shotLb.idx]?.prompt || '';
  const old = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = '✓ 已复制';
  } catch {
    btn.textContent = '复制失败，请手动选中';
  }
  setTimeout(() => { btn.textContent = old; }, 1600);
}

async function regenShotInLightbox(btn, idx) {
  const which = Number.isInteger(idx) ? idx : shotLb.idx;
  const card = shotCards[which];
  if (!card?.shotId) return;
  const projectId = shotLb.projectId || liveCtx?.p?.id;
  if (!projectId) return;
  shotLb.idx = which;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '出图中…（约 1–5 分钟，含排队）';
  try {
    const d = await api(`/api/projects/${projectId}/storyboard/shots/${encodeURIComponent(card.shotId)}/regen`, {});
    if (d.ok) shotLb.ctx?.toast?.(d.message || '已重出分镜图', 'ok');
    else shotLb.ctx?.toast?.(d.message || '仍未拿到真实图', 'err');
    await shotLb.ctx?.onChanged?.();
    // onChanged 会整页重绘：shotCards 已刷新，按镜号找回同一镜继续看
    const again = shotCards.findIndex((c) => c.shotNo === card.shotNo);
    if (again >= 0) {
      shotLb.idx = again;
      if (!shotLbEl().hidden) paintShotLightbox(shotCards[again]);
    } else if (!shotLbEl().hidden) closeShotLightbox();
  } catch (err) {
    shotLb.ctx?.toast?.(err.message, 'err');
    btn.disabled = false;
    btn.textContent = old;
  }
}

/** ⑥ 视频与交付：先看片段生成进度，再谈成片 / 导演包 */
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 4];
function deliverConsoleHTML(p, m, stats, busy) {
  const d = m.deliverables || { video: true, pack: true };
  const final = p.nodes.find((n) => n.type === 'final');
  const film = stats.film || final?.data?.film;
  const pack = stats.pack || final?.data?.directorPack;
  const shots = p.nodes.filter((n) => n.type === 'shot').length;
  const videos = p.nodes.filter((n) => n.type === 'video');
  const withClip = videos.filter((n) => n.data?.clip).length;
  const realClips = videos.filter((n) => n.data?.clip?.provider === 'comfyui').length;
  const pending = Math.max(0, shots - withClip);
  const runtime = m.runtime || {};
  const clipCells = [
    ['镜头', shots],
    ['片段', `${withClip}/${videos.length || shots}`],
    ['真实片段', realClips],
    ['待生成', pending],
  ];
  const readyLine = !d.video ? ''
    : pending
      ? `<div class="pv-hint pvd-block">第 ⑤ 步只出了分镜图，本步会逐镜头调用 ComfyUI 图生视频（${runtime.clipSeconds || 3}s/段 × ${runtime.clipCount || shots} 段）；中途可停止，已生成的片段不会重烧。</div>`
      : `<div class="pv-hint pvd-ok">全部 ${shots} 个镜头都已有片段${realClips < shots ? `（其中真实 ComfyUI 片段 ${realClips} 个）` : ''}，可以拼成片 / 打包了。</div>`;
  const filmUrl = film?.url || (film?.file ? `/assets/${film.file}` : '');
  const filmMeta = film
    ? [`${(film.bytes / 1024 / 1024).toFixed(1)} MB`,
      Number.isFinite(Number(film.duration)) ? `${Number(film.duration).toFixed(1)}s` : '',
      film.width && film.height ? `${film.width}×${film.height}` : '',
      film.clips ? `${film.clips} 片段` : '',
      film.isRealVideo ? 'ComfyUI 真实片段拼接' : (film.source === 'preview-frames' ? '关键帧预览（非 AI 视频）' : '')]
      .filter(Boolean).join(' · ')
    : '';
  // 成片在线播放 + 成片时间线（与第⑥步分镜一一对应，点格切换播放该片段）
  const timeline = filmTimelineHTML(p);
  const player = filmUrl && d.video
    ? `<div class="pv-card pvf-player">
        <div class="pv-card-head"><span>🎬 成片在线播放</span>
          <span class="pv-hint-inline">${esc(filmMeta)}
            <button class="btn sm" data-act="dl-film">⇩ 下载 MP4</button></span></div>
        <video class="pvf-video" controls preload="metadata" src="${esc(filmUrl)}#t=0.1"></video>
        <div class="pvf-ratebar" role="group" aria-label="倍速播放">
          <span class="pvf-ratelb">倍速</span>
          ${SPEEDS.map((s) => `<button class="pvf-rate ${s === (ui.filmRate || 1) ? 'on' : ''}" data-rate="${s}">${s}×</button>`).join('')}
          <span class="pvf-ratetip">点时间线格子可跳播任意镜头 · 封面为视频首帧</span>
        </div>
      </div>`
    : '';
  return `${episodeFlowHTML(p, m, 'deliver')}
    <div class="epb-proj-label">↓ 以下成片 / 时间线 / 交付统计为全项目画布汇总（跨集）；按集成片在上方流水线与剧集详情页</div>
    ${player}${timeline.html}
    <div class="pv-res-grid four">${clipCells.map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join('')}</div>
    ${readyLine}
    <div class="pv-deliver-opts">
      <label class="pv-check"><input type="checkbox" data-del="video" ${d.video ? 'checked' : ''}> 成片视频 <small>ComfyUI 片段 → ffmpeg 拼接 MP4</small></label>
      <label class="pv-check"><input type="checkbox" data-del="pack" ${d.pack ? 'checked' : ''}> 导演包 <small>*.mmxpack.zip · 可导入导演工作台</small></label>
    </div>
    <div class="pv-deliver-outs">
      <div class="pv-out ${film?.file ? 'ok' : ''}"><strong>成片视频</strong><span>${film?.file ? `已生成 · ${esc(filmMeta)}` : d.video ? '未生成 · 片段齐了才会拼 MP4' : '本次不交付成片'}</span>
        ${film?.file ? `<button class="btn sm primary" data-act="dl-film">⇩ 下载 MP4</button>` : ''}</div>
      <div class="pv-out ${pack?.file ? 'ok' : ''}"><strong>导演包</strong><span>${pack?.file ? `已生成 · ${pack.fileCount || 0} 个文件` : '执行本步后生成'}</span>
        <button class="btn sm" data-act="dl-pack">▤ ${pack?.file ? '下载导演包' : '生成并下载'}</button></div>
    </div>`;
}

/* ------------------------------------------------- 文件 / 章节 → 剧集关联一览 */
function chapterMapHTML(m) {
  const sources = m.sources || [];
  const chapters = m.chapters || [];
  const eps = m.episodes || [];
  if (!sources.length && !chapters.length) {
    if (!eps.length) return '';
    const strategy = SPLIT_STRATEGIES.find((s) => s.id === m.split?.strategy)?.name || '自定义规则';
    return `<div class="pv-card pv-linkmap pv-linkmap-empty">
      <div class="pv-card-head"><span>🔗 文件 / 章节 → 剧集 自动关联</span><span class="pv-hint-inline">${eps.length} 集 · 待补全</span></div>
      <div class="pv-hint">本项目按「${esc(strategy)}」拆分，创建时未记录文件与章节出处。到第 ① 步「准备故事」重新上传一次小说（支持多文件），系统会自动把每个文件、每一章关联到对应剧集，分集列表与剧集详情会同步出现关联信息。</div>
    </div>`;
  }
  return `<div class="pv-card pv-linkmap">
    <div class="pv-card-head"><span>🔗 文件 / 章节 → 剧集 自动关联</span><span class="pv-hint-inline">${sources.length} 个来源 · ${chapters.length} 章 · ${eps.length} 集</span></div>
    ${sources.length ? `<div class="pv-src-list">${sources.map((f) => `<span class="pv-src-chip">📄 ${esc(f.name)} <small>${(f.chars || 0).toLocaleString()} 字 · ${(f.chapterTitles || []).length} 章</small></span>`).join('')}</div>` : ''}
    ${chapters.length ? `<div class="pv-chapter-list">${chapters.slice(0, 24).map((c) => `<div class="pv-chapter-row">
        <span class="pv-chapter-title">${esc(cut(c.title, 30))}</span>
        <span class="pv-chapter-file">${esc(cut(c.sourceName || '原著', 18))}</span>
        <i class="pv-chapter-line"></i>
        <button class="pv-chapter-ep" data-ep="${c.episodeNo}">第 ${c.episodeNo} 集 →</button>
      </div>`).join('')}</div>` : ''}
    <div class="pv-hint">章节按拆分规则归入对应剧集；点集号可查看该集原文、剧本、角色与宫格分镜。</div>
  </div>`;
}

/* ---------------------------------------------------------------- Tab 导航 */
function tabsHTML(ctx) {
  const m = ctx.project?.management || {};
  const src = ctx.source || {};
  const counts = {
    source: src.ok ? `${(src.stats?.totalChars || 0).toLocaleString()} 字` : '未导入',
    episodes: `${(m.episodes || []).length} 集`,
    assets: `${collectProjectAssets(ctx.project, ctx.assets || []).length} 项`,
  };
  return `<nav class="pv-tabs" role="tablist">${TABS.map((t) => `
    <button class="pv-tab ${ui.tab === t.id ? 'on' : ''}" data-tab="${t.id}" title="${esc(t.hint)}" role="tab" aria-selected="${ui.tab === t.id}">
      <span>${t.label}</span>${counts[t.id] ? `<em>${esc(counts[t.id])}</em>` : ''}
    </button>`).join('')}</nav>`;
}

/* ---------------------------------------------------------- 分季 / 分集管理 */
export function seasonsHTML(p, ctx) {
  const groups = PMODEL.seasonGroups(p);
  const eps = p.management?.episodes || [];
  const seasonCount = Math.max(1, groups.length);
  const seasonOptions = (active) => Array.from({ length: seasonCount }, (_, i) => i + 1)
    .map((n) => `<option value="${n}" ${n === active ? 'selected' : ''}>${esc(PMODEL.seasonTitle(p, n))}</option>`).join('');
  const cov = PMODEL.scriptCoverage(eps);
  const gridSegs = eps.reduce((n, e) => n + (e.segments || []).length, 0);
  const gridDone = eps.reduce((n, e) => n + (e.segments || []).filter((s) => s.gridUrl).length, 0);
  const videoCount = eps.filter((e) => e.video).length;
  const head = `<div class="pv-card-head sx-head">
      <div class="sx-head-tit"><span>▥ 分季 · 分集</span><small>${groups.length} 季 · ${eps.length} 集 · 默认第一季第一集；每集独立跑完 ④⑤⑥⑦ 四段后定稿，自动进入同季下一集、本季做完进入下一季</small></div>
      <div class="sx-head-acts">
        <button class="btn sm primary" data-act="add-season">＋ 新增一季</button>
        <details class="sx-more"><summary class="btn sm">更多操作 ▾</summary><div class="sx-more-body">
          <button class="btn sm" data-act="open-overall">🌐 全部组合画布</button>
          <button class="btn sm" data-act="export-scripts" ${!cov.written ? 'disabled' : ''}>⇩ 导出剧本</button>
          <button class="btn sm" data-act="gen-scripts" data-missing="1" ${!cov.missing ? 'disabled' : ''}>✦ 补齐缺失剧本</button>
        </div></details>
      </div>
    </div>
    ${activeEpisodeBarHTML(p, p.management || {})}
    <div class="sx-overview">
      <div class="sx-stat"><b>${groups.length}</b><span>季</span></div>
      <div class="sx-stat"><b>${eps.length}</b><span>集</span></div>
      <div class="sx-stat"><b>${cov.written}/${cov.total}</b><span>剧本</span></div>
      <div class="sx-stat"><b>${gridDone}/${gridSegs}</b><span>宫格图</span></div>
      <div class="sx-stat"><b>${videoCount}</b><span>视频</span></div>
      <div class="sx-stat accent"><b>${cov.percent}%</b><span>剧本覆盖</span></div>
    </div>
    <div class="sx-toolbar">
      <label class="sx-search">🔍<input id="sx-search" value="${esc(ui.epFilter.query)}" placeholder="搜索集号 / 标题 / 梗概 / 章节" spellcheck="false">
        <button type="button" data-act="sx-clear-filter" title="清空筛选">✕</button></label>
      <div class="sx-filters">${PMODEL.EPISODE_FILTERS.map((f) => `<button class="sx-chip ${ui.epFilter.status === f.id ? 'on' : ''}" data-sx-status="${f.id}">${f.label}</button>`).join('')}</div>
      <div class="sx-tool-acts">
        <span class="sx-shown">显示 <b id="sx-shown">${eps.length}</b> 集</span>
        <button class="btn sm primary" data-act="gen-scripts" data-missing="1" ${!cov.missing ? 'disabled' : ''}>✦ 补齐缺失剧本</button>
        <button class="btn sm" data-act="export-scripts" ${!cov.written ? 'disabled' : ''}>⇩ 导出剧本</button>
      </div>
    </div>`;
  if (!eps.length) {
    return `<div class="pv-card sx-wrap">${head}<div class="sx-empty">还没有分集。先到「📖 原著」导入小说并完成分集拆解，这里会自动按季列出每一集。</div></div>`;
  }
  const cards = groups.map((g) => {
    const gCov = PMODEL.scriptCoverage(g.episodes);
    const collapsed = ui.collapsedSeasons.includes(num(g.no));
    return `<section class="sx-season ${collapsed ? 'collapsed' : ''}" data-season="${g.no}">
      <div class="sx-season-head">
        <button class="sx-season-collapse" data-act="sx-toggle-season" data-no="${g.no}" title="${collapsed ? '展开' : '折叠'}本季" aria-expanded="${!collapsed}">${collapsed ? '▸' : '▾'}</button>
        <span class="sx-season-mark">${PMODEL.seasonLabel(g.no)}</span>
        <input class="sx-season-title" data-season-title="${g.no}" value="${esc(g.title)}" aria-label="第 ${g.no} 季标题" spellcheck="false">
        <span class="sx-season-count">${g.episodes.length} 集 · ${g.chars.toLocaleString()} 字</span>
        <span class="sx-season-cov" title="本季剧本覆盖 ${gCov.written}/${gCov.total}">剧本 ${gCov.written}/${gCov.total}<i><b style="width:${gCov.percent}%"></b></i></span>
        <div class="sx-season-acts">
          ${gCov.missing ? `<button class="btn sm" data-act="gen-season-scripts" data-no="${g.no}">✦ 补齐本季 ${gCov.missing} 集</button>` : ''}
          <details class="sx-more"><summary class="btn sm">更多操作 ▾</summary><div class="sx-more-body">
            <button class="btn sm" data-act="open-season-canvas" data-no="${g.no}" title="看这一季在组合画布中的位置">🌐 组合视图</button>
            ${g.no > 1 ? `<button class="btn sm danger-ghost" data-act="remove-season" data-no="${g.no}" title="删除该季，集回到第一季">✕ 删除季</button>` : ''}
          </div></details>
        </div>
      </div>
      <div class="sx-ep-grid">${g.episodes.map((ep) => {
        const no = Number(ep.no) || 0;
        const prod = PMODEL.episodeProduction(ep);
        const finalized = PMODEL.isFinalized(ep);
        const active = num(ui.activeNo) === no;
        const hay = [no, ep.title, ep.summary, ep.hook, ...(ep.chapters || []).map((c) => c?.title), ...(ep.sourceTitles || [])].join(' ').toLowerCase();
        return `<article class="sx-ep ${prod.script ? 'has-script' : 'no-script'}${finalized ? ' finalized' : ''}${active ? ' active' : ''}" data-ep-card data-hay="${esc(hay)}" data-script="${prod.script ? 1 : 0}" data-grids="${prod.grids}" data-video="${prod.video ? 1 : 0}">
          <div class="sx-ep-top"><span class="sx-ep-no">${PMODEL.episodeLabelFull(g.no, no)}</span>
            <span class="sx-ep-state ${finalized ? 'fin' : active ? 'cur' : ''}">${finalized ? '🔒 已定稿' : active ? '● 当前制作位' : '待制作'}</span>
            <label class="sx-ep-season">季
              <select data-ep-season="${no}" aria-label="第 ${no} 集所属季">${seasonOptions(PMODEL.seasonOf(ep))}</select>
            </label></div>
          <h3>${esc(cut(ep.title || `第 ${no} 集`, 26))}</h3>
          <p>${esc(cut(ep.summary || '暂无梗概', 68))}</p>
          <div class="sx-ep-badges">
            ${prod.script ? `<span class="on">剧本 ${prod.scenes} 场</span>` : '<span class="miss">剧本未写</span>'}
            <span class="${prod.grids ? 'on' : ''}">分镜 ${prod.grids}/${prod.segments || 0}</span>
            <span class="${prod.video ? 'on' : ''}">视频${prod.video ? ' ✓' : ''}</span>
            ${prod.pack ? '<span class="on">包 ✓</span>' : ''}
          </div>
          <div class="sx-ep-meta"><span>${(ep.chars || 0).toLocaleString()} 字</span><span>${(ep.chapters || []).length || (ep.sourceTitles || []).length} 章</span><span>${(ep.segments || []).length} 段</span>${prod.percent === 100 ? '<span class="ok">全完成</span>' : ''}</div>
          <div class="sx-ep-acts">
            <button class="btn sm ${active ? '' : 'primary'}" data-act="pick-ep" data-no="${no}" title="把这一集设为工作台当前剧集">${active ? '● 当前集' : '◎ 设为当前集'}</button>
            ${prod.script
              ? `<button class="btn sm" data-act="read-script" data-no="${no}" title="到第 ④ 步阅读 / 编辑本集剧本">✎ 剧本</button>`
              : `<button class="btn sm primary" data-act="gen-ep-script" data-no="${no}" data-force="0" ${ui.script.busyNo ? 'disabled' : ''}>✦ 写剧本</button>`}
            <details class="sx-more"><summary class="btn sm">更多 ▾</summary><div class="sx-more-body">
              <button class="btn sm" data-act="open-episode" data-no="${no}">▤ 剧集详情</button>
              <button class="btn sm" data-act="open-ep-canvas" data-no="${no}">⬡ 独立画布</button>
            </div></details>
          </div>
        </article>`;
      }).join('')}</div>
    </section>`;
  }).join('');
  return `<div class="pv-card sx-wrap">${head}${cards}
    <div class="sx-empty" id="sx-noresult" hidden>没有匹配的剧集。换个关键词，或点「全部」恢复。</div>
    <details class="sx-foot"><summary>查看分季 / 定稿 / 角色库说明</summary><div>季只做分组，集号保持全局唯一；制作顺序按「季升序 → 季内集号升序」，四段全完成后在工作台定稿即自动推进。「🌐 全部组合画布」把所有季、所有集的独立画布拼成一张总览图；角色库为全书共享，各集只记本集出场角色。</div></details>
  </div>`;
}

/** 搜索 / 状态筛选只切 DOM 显隐，不重建表单（避免输入时每敲一个字就失焦） */
function applyEpisodeFilter(host) {
  const q = String(ui.epFilter.query || '').trim().toLowerCase();
  const status = ui.epFilter.status || 'all';
  let shown = 0;
  host.querySelectorAll('[data-ep-card]').forEach((card) => {
    const okQ = !q || String(card.dataset.hay || '').includes(q);
    const okS = status === 'all'
      || (status === 'script' && card.dataset.script === '1')
      || (status === 'noscript' && card.dataset.script !== '1')
      || (status === 'grid' && num(card.dataset.grids) > 0)
      || (status === 'video' && card.dataset.video === '1');
    const on = okQ && okS;
    card.hidden = !on;
    if (on) shown += 1;
  });
  host.querySelectorAll('[data-season]').forEach((sec) => {
    const any = [...sec.querySelectorAll('[data-ep-card]')].some((c) => !c.hidden);
    sec.hidden = !any;
  });
  const empty = host.querySelector('#sx-noresult');
  if (empty) empty.hidden = shown > 0 || !host.querySelector('[data-ep-card]');
  const count = host.querySelector('#sx-shown');
  if (count) count.textContent = String(shown);
}

/* --------------------------------------------------------------- 资源归纳 Tab */
function assetsHTML(p, ctx) {
  const list = collectProjectAssets(p, ctx.assets || []);
  const byKind = {};
  for (const a of list) {
    const k = ASSET_KIND_LABEL[a.kind] ? a.kind : (a.type === 'video' ? 'video' : a.type === 'pack' ? 'pack' : 'image');
    (byKind[k] ||= []).push(a);
  }
  const order = ['cover', 'character', 'image', 'video', 'pack', 'other'];
  const chars = p.management?.characters || [];
  const cards = order.filter((k) => (byKind[k] || []).length).map((k) => `
    <section class="ax-group">
      <div class="ax-group-head"><span>${ASSET_KIND_LABEL[k]}</span><em>${byKind[k].length}</em></div>
      <div class="ax-grid">${byKind[k].map((a) => `
        <button class="ax-item" data-file="${esc(a.file)}" title="${esc(a.name || a.file)}">
          <span class="ax-thumb">${a.type === 'image'
            ? `<img loading="lazy" src="/assets/${esc(a.file)}" alt="">`
            : `<i>${a.type === 'video' ? '▶' : a.type === 'pack' ? '▤' : '📄'}</i>`}</span>
          <span class="ax-name">${esc(cut(a.name || a.file, 20))}</span>
          <small>${a.bytes ? `${(a.bytes / 1024).toFixed(0)} KB` : ASSET_KIND_LABEL[k]}</small>
        </button>`).join('')}</div>
    </section>`).join('');
  return `<div class="ax-wrap">
    <div class="ax-head">
      <div><h2>项目资源</h2><p>封面 / 角色定妆图 / 宫格分镜 / 视频 / 导演包，按类型统一归纳 · 共 ${list.length} 项</p></div>
      <div class="ax-head-acts">
        <button class="btn sm" data-act="refresh-assets">↻ 重扫资源</button>
        <button class="btn sm primary" data-act="open-assets">▣ 在资源库中管理</button>
      </div>
    </div>
    <div class="ax-summary">
      <div class="ax-stat"><b>${list.length}</b><span>资源文件</span></div>
      <div class="ax-stat"><b>${chars.length}</b><span>角色</span></div>
      <div class="ax-stat"><b>${(p.management?.episodes || []).length}</b><span>分集</span></div>
      <div class="ax-stat"><b>${(p.nodes || []).length}</b><span>主画布节点</span></div>
    </div>
    <div class="ax-char-acts"><button class="btn sm" data-act="chars">👤 角色管理</button><button class="btn sm" data-act="manage">▤ 项目管理面板</button></div>
    ${cards || '<div class="ax-empty">还没有生成资源。运行流水线或生成封面 / 角色定妆图 / 宫格分镜后，产物会自动归纳到这里。</div>'}
  </div>`;
}

/* ================================================================== 主渲染 */
/** 步骤状态：basic 步骤本地计算（基础信息是否已保存 / 已填），其余复用 STEPS 状态机 */
function basicStatus(m) {
  // ① 以「用户保存过基础信息」为准：保存动作由服务端打上 basicInfo.confirmedAt。
  // 这样「✓ 已保存」的提示与步骤状态永远同步，不会出现提示完成、步骤仍待执行的错位。
  if (m.basicInfo?.confirmedAt) return 'done';
  // 老项目 / AI 一键补全的项目没有确认时间，按字段回退判定（任一核心设定有值即算设置过）
  const b = m.bible || {};
  return (b.logline || b.genre || b.tone || b.audience || b.artStyle) ? 'done' : 'pending';
}
function stepStatus(m, id) {
  if (id === 'basic') return basicStatus(m);
  const s = (m.steps || []).find((x) => x.id === id);
  return s?.status || 'pending';
}

/* ===== 制作步骤窄栏：嵌在左侧面板与工作台之间（两态 DOM 同时存在，切换只改属性） =====
 * 展开 = 190px 完整步骤栏；收起 = 40px 状态轨（编号 + 完成状态 + 进度）。
 * 两态都在文档流内占位（sticky 跟随滚动），不再 fixed 覆盖步骤卡。 */
function currentStepLabel(id) {
  const i = WORKSHOP_STEPS.findIndex((s) => s.id === id);
  const s = WORKSHOP_STEPS[i < 0 ? 0 : i];
  return `${i < 0 ? 1 : i + 1} · ${s.name}`;
}

/** 状态轨圆点文案：完成 ✓ / 失败 ! / 其余显示步骤序号 */
function railDotText(stt, no) {
  if (stt === 'done') return '✓';
  if (stt === 'error') return '!';
  return String(no);
}

/** 制作步骤窄栏：展开为完整清单，收起为竖排状态轨；点击圆点 / 步骤行都直达对应步骤 */
export function navHTML(m, busy) {
  const total = WORKSHOP_STEPS.length;
  const done = WORKSHOP_STEPS.filter((s) => stepStatus(m, s.id) === 'done').length;
  const pct = total ? Math.round(done / total * 100) : 0;
  const current = (m.steps || []).find((s) => s.status === 'running') || (m.steps || []).find((s) => s.status === 'pending');
  const expanded = String(!ui.navCollapsed);
  // 「当前剧集」身份直接写进中间导航条，不再用顶部悬浮常驻条。
  // 展开态用紧凑短标签 第1季-1（集号 = 全局唯一 ep.no）；收起态 40px 状态轨拆两行显示同一串文字。
  const curNo = activeEpisodeNo(m);
  const curEp = (m.episodes || []).find((e) => num(e.no) === curNo);
  const curSeason = curEp ? PMODEL.seasonOf(curEp) : 0;
  const curLabel = curNo ? PMODEL.episodeLabelShort(curSeason, curNo) : '';
  const curTip = curLabel
    ? `当前剧集 ${curLabel}${curEp?.title ? ` · ${cut(curEp.title, 18)}` : ''} · 切换剧集在第③步「分季 · 分集」卡片内`
    : '当前剧集：还没有分集';
  const [curSeasonText, curNoText] = curLabel ? curLabel.split('-') : ['', ''];
  const navEp = `<div class="pv-nav-ep" title="${esc(curTip)}">
      <span class="pv-nav-ep-k">当前剧集</span>
      <b class="pv-nav-ep-no">${curLabel ? esc(curLabel) : '未分集'}</b>
      <span class="pv-nav-ep-hint">切换剧集在第③步分集卡内</span>
    </div>`;
  const railEp = curLabel
    ? `<div class="pv-rail-ep" title="${esc(curTip)}" aria-label="当前剧集 ${esc(curLabel)}">
        <span>${esc(curSeasonText)}</span><b>-${esc(curNoText)}</b></div>`
    : '';
  const railDots = WORKSHOP_STEPS.map((s, i) => {
    const stt = stepStatus(m, s.id);
    const active = ui.stepId === s.id;
    const tip = `${i + 1} · ${s.name} · ${STATUS_TEXT[stt] || stt}`;
    return `<button class="pv-rail-dot st-${stt} ${active ? 'on' : ''}" data-step="${s.id}"
      ${active ? 'aria-current="step"' : ''} title="${esc(tip)}" aria-label="${esc(tip)}">${railDotText(stt, i + 1)}</button>`;
  }).join('');
  return `<aside class="pv-nav" id="pv-nav" aria-label="制作步骤导航">
    <div class="pv-nav-head">
      <span class="pv-nav-title">步骤 <span class="pv-nav-count">${done}/${total}</span></span>
      <button class="pv-nav-toggle" data-act="toggle-nav" aria-expanded="${expanded}" aria-controls="pv-nav-body"
        title="收起制作步骤">⟨</button>
    </div>
    ${navEp}
    <div class="pv-nav-body" id="pv-nav-body">
      <div class="pv-nav-progress"><i style="width:${pct}%"></i></div>
      <ol class="pv-nav-list" aria-label="制作步骤 ${total} 项">
        ${WORKSHOP_STEPS.map((s, i) => {
          const stt = stepStatus(m, s.id);
          const isCur = current?.id === s.id && stt !== 'done';
          const active = ui.stepId === s.id;
          const sep = i === 3
            ? '<li class="pv-nav-sep" aria-hidden="true"><span>以下按集执行</span></li>'
            : '';
          const scopeTip = s.scope === 'episode' ? '剧集级 · 每集各跑一遍' : '项目级 · 一次作用于全书';
          return `${sep}<li><button class="pv-nav-item st-${stt} ${active ? 'on' : ''}" data-step="${s.id}"
            data-scope="${s.scope || 'project'}"
            ${active ? 'aria-current="step"' : ''} title="${esc(s.name)} · ${scopeTip} · ${STATUS_TEXT[stt] || stt}">
            <span class="pv-nav-num">${stt === 'done' ? '✓' : i + 1}</span>
            <span class="pv-nav-name">${esc(s.name)}</span>
            ${isCur ? '<span class="pv-nav-now">下一步</span>' : ''}
          </button></li>`;
        }).join('')}
      </ol>
      <div class="pv-nav-foot">
        <button class="btn primary sm" data-act="run-next" ${busy || done === total ? 'disabled' : ''}>${busy ? '执行中…' : done === total ? '✓ 完成' : '▶ 下一步'}</button>
        <button class="btn sm" data-act="run-all" ${busy || done === total ? 'disabled' : ''}>⏩ 全部</button>
      </div>
      <div class="pv-nav-scope-tip" title="④ 之后按集精修；角色库全项目共享，已存在则沿用">①–③ 项目级 · ④ 起按集</div>
    </div>
  </aside>
  <div class="pv-rail" id="pv-rail" aria-label="制作步骤状态">
    <button class="pv-rail-head" data-act="toggle-nav" aria-expanded="${expanded}" aria-controls="pv-nav-body"
      title="展开制作步骤 · 当前 ${esc(currentStepLabel(ui.stepId))}">
      <b data-rail-count>${done}/${total}</b><span class="pv-rail-chev">›</span>
    </button>
    ${railEp}
    <div class="pv-rail-bar" title="已完成 ${done}/${total}"><i style="width:${pct}%"></i></div>
    <div class="pv-rail-dots">${railDots}</div>
  </div>`;
}

/** 收起态状态轨：当前步提示与高亮跟随滚动联动（不重建 DOM） */
function updateRail(host, id) {
  const label = currentStepLabel(id);
  host.querySelectorAll('.pv-rail-head').forEach((b) => {
    b.title = `展开制作步骤 · 当前 ${label}`;
  });
  host.querySelectorAll('.pv-rail-dot').forEach((d) => {
    const on = d.dataset.step === id;
    d.classList.toggle('on', on);
    if (on) d.setAttribute('aria-current', 'step'); else d.removeAttribute('aria-current');
  });
}

/** 展开 / 收起：只改 data-nav 属性，不重建 DOM（不会丢失正在编辑的表单） */
function setNavCollapsed(host, collapsed) {
  ui.navCollapsed = !!collapsed;
  writeNavPref(ui.navCollapsed);
  const shell = host.querySelector('.pv-shell-steps');
  if (shell) shell.dataset.nav = ui.navCollapsed ? 'collapsed' : 'expanded';
  host.querySelectorAll('[data-act="toggle-nav"]').forEach((b) => {
    b.setAttribute('aria-expanded', String(!ui.navCollapsed));
    b.title = ui.navCollapsed ? '展开制作步骤' : '收起制作步骤';
  });
  const toggle = host.querySelector('.pv-nav-toggle');
  if (toggle) toggle.textContent = ui.navCollapsed ? '›' : '⟨';
  updateRail(host, ui.stepId);
}

/** 单个步骤区块：编号 + 标题 + 状态 + 执行按钮 + 内容 */
export function stepSectionHTML(s, no, m, body, busy) {
  const st = stepStatus(m, s.id);
  // 「设置基础信息」在状态机里没有独立步骤（字段都落在 bible 上），
  // 它的对话入口挂到第 ① 步——那边的 Agent 动作正是改创作设定。
  const chatId = s.id === 'basic' ? 'upload' : s.id;
  const chatCount = (m.stepChats?.[chatId]?.messages || []).length;
  // 步骤区头的 token 汇总：工作台主视图也要能一眼看出「这一步花了多少」
  const stepState = (m.steps || []).find((x) => x.id === chatId) || null;
  const execTok = stepState?.tokens?.total || 0;
  const chatTok = stepState?.chatTokens?.total || 0;
  const tokSum = execTok + chatTok;
  const tokBadge = tokSum
    ? `<span class="pv-step-tok" title="执行 ${execTok} tok · 对话 ${chatTok} tok">Σ ${tokSum >= 1000 ? `${(tokSum / 1000).toFixed(1)}k` : tokSum} tok</span>`
    : '';
  // 剧集级步骤：区头动作只作用于「当前剧集」，不再提供含糊的「执行本步」整跑
  const epScope = s.scope === 'episode';
  const scopeNo = epScope ? activeEpisodeNo(m) : 0;
  const actEp = scopeNo ? (m.episodes || []).find((e) => num(e.no) === scopeNo) : null;
  const actNo = actEp ? num(actEp.no) : 0;
  const stageIdx = epScope ? FLOW_STAGES.findIndex((x) => x.key === s.id) + 1 : 0;
  const seasonNo = actEp ? PMODEL.seasonOf(actEp) : 1;
  const scopePill = epScope
    ? `<span class="pv-pill pv-pill-scope" title="这一步按集执行：换一集就是换一套任务；按季按集顺序推进">剧集级${actNo ? ` · ${PMODEL.episodeLabelFull(seasonNo, actNo)} · 第 ${stageIdx || 1}/4 段` : ''}</span>`
    : `<span class="pv-pill pv-pill-scope" title="这一步一次作用于全书">项目级</span>`;
  const locked = actEp && PMODEL.isFinalized(actEp);
  let mainAct = '';
  if (!s.auto) {
    if (epScope && locked) {
      mainAct = '<button class="btn sm" disabled title="本集已定稿：在流水线或顶部条撤销定稿后可继续修改">🔒 本集已定稿</button>';
    } else if (!epScope) {
      mainAct = `<button class="btn primary sm" data-act="run-step" data-id="${s.id}" ${busy ? 'disabled' : ''}>${st === 'error' ? '↻ 重试本步' : st === 'done' ? '↻ 重新执行' : '▶ 执行本步'}</button>`;
    } else if (!actNo) {
      mainAct = '<button class="btn sm" disabled title="还没有分集：先完成第 ③ 步">▶ 先分集</button>';
    } else if (s.id === 'script') {
      const force = actEp?.script ? '1' : '0';
      mainAct = `<button class="btn primary sm" data-act="gen-ep-script" data-no="${actNo}" data-force="${force}" ${busy ? 'disabled' : ''} title="只生成${PMODEL.episodeLabelFull(seasonNo, actNo)}的剧本；换集用顶部「当前剧集」条">▶ ${force === '1' ? '重写本集剧本' : '生成本集剧本'}</button>`;
    } else {
      const force = epStepDoneLocal(actEp, s.id) ? '1' : '0';
      mainAct = `<button class="btn primary sm" data-act="run-ep-step" data-step="${s.id}" data-no="${actNo}" data-force="${force}" ${busy ? 'disabled' : ''} title="只执行${PMODEL.episodeLabelFull(seasonNo, actNo)}的本步；换集用顶部「当前剧集」条">▶ 执行本集（${PMODEL.episodeNoLabel(actNo)}）</button>`;
    }
  }
  return `<section class="pv-sstep ${ui.stepId === s.id ? 'pv-sstep-active' : ''}" id="step-${s.id}">
    <div class="pv-sstep-head">
      <span class="pv-sstep-num">${no}</span>
      <div class="pv-sstep-tit"><strong>${no}. ${esc(s.name)}</strong><small>${esc(s.desc || '')}</small></div>
      ${scopePill}
      ${tokBadge}
      <span class="pv-pill st-${st}">${STATUS_TEXT[st] || st}</span>
      <button class="btn sm pv-chat-btn" data-act="chat-step" data-id="${chatId}"
        title="和 Agent 对话修改这一步（记录会保留）">💬${chatCount ? ` ${chatCount}` : ' 对话'}</button>
      ${mainAct}
    </div>
    <div class="pv-sstep-body">${body}</div>
  </section>`;
}

/** 步骤② 准备故事：来源卡片 + 上传/AI 表单 + 可折叠原著阅读器 */
function storyBodyHTML(m, ctx) {
  const srcToggle = `<div class="pv-step-sub"><button class="btn sm" data-act="toggle-source" aria-expanded="${ui.sourceOpen}" aria-controls="pv-source-host">${ui.sourceOpen ? '▴ 收起原著与统计' : '📖 查看原著与统计'}</button></div>`;
  const srcHost = ui.sourceOpen ? `<div id="pv-source-host" class="pv-source-host"></div>` : '';
  return `${sourceCardHTML(m)}${uploadConsoleHTML(m)}${srcToggle}${srcHost}`;
}

export function renderProjectView(host, ctx = {}) {
  if (!host) return;
  if (ui.skipCapture) ui.skipCapture = false;
  else captureState(host);
  const p = ctx.project;
  if (!p) {
    host.innerHTML = '<div class="pv-empty"><span class="big">◈</span>从左侧选择一个项目，或 ＋ 新建创作项目</div>';
    return;
  }
  const m = p.management || {};
  if (m.kind !== 'novel') {
    host.innerHTML = `<div class="pv-empty"><span class="big">⬡</span>
      这是标准流水线项目，画布是它的主战场。<br>
      <button class="btn primary" data-act="open-canvas" style="margin-top:14px">⬡ 打开画布视图</button></div>`;
    host.querySelector('[data-act="open-canvas"]')?.addEventListener('click', () => ctx.onOpenCanvas?.());
    return;
  }
  if (ui.projectId !== p.id) resetUi(p);

  const stats = ctx.stats || {};
  const busy = !!ctx.busy;
  const current = (m.steps || []).find((s) => s.status === 'running') || (m.steps || []).find((s) => s.status === 'pending');
  if (!ui.stepId || !WORKSHOP_STEPS.some((s) => s.id === ui.stepId)) ui.stepId = 'basic';

  // 渲染前统一对齐「当前剧集」：导航条、③ 分集卡内的控制区、区头、四张流水线卡必须指向同一集。
  // 必须在拼装 bodies 之前做——seasonsHTML 内部会渲染控制区与每集「当前制作位」标记。
  ui.activeNo = activeEpisodeNo(m);

  // 各步骤内容（大面板按需求融入对应步骤）
  // ① 项目信息后面接「导演 Agent 技能」：选策略 → 一键跑完全流程
  const dirBusy = !!ctx.directorBusy || !!busy;
  const dirPlan = ctx.directorPlan || {
    warnings: !m.source?.text ? ['项目还没有原著：运行时会按一句话构想生成演示小说（未配置模型为内置模板）'] : [],
  };
  const basicBody = `${infoCardHTML(p, m)}${directorPanelHTML({
    skills: ctx.directorSkills,
    groups: ctx.directorSkillGroups,
    skillId: ui.director.skillId || m.director?.skillId || 'full',
    paletteKey: ui.director.paletteKey || m.director?.paletteKey || null,
    busy: dirBusy, progress: ui.director.progress,
    idea: ui.director.idea, plan: dirPlan, hasSource: !!m.source?.text,
    runtime: ctx.runtime || m.runtime,
    aspect: p.settings?.aspect,
  })}`;
  const uploadBody = storyBodyHTML(m, ctx);
  // 第③步默认只展开「分集控制台 → 顺序制作 → 分季分集」；章节映射是查证用的长表，收进折叠区（入口不删）
  const chapters = chapterMapHTML(m);
  const chaptersCard = chapters
    ? `<details class="pv-more"><summary>🔗 文件 / 章节 → 剧集 自动关联（展开查看）</summary><div class="pv-more-body">${chapters}</div></details>`
    : '';
  const episodesBody = `${episodesConsoleHTML(m, { status: stepStatus(m, 'episodes') }, busy)}${episodeFlowIntroHTML(p, m)}${seasonsHTML(p, ctx)}${chaptersCard}`;
  const scriptBody = scriptConsoleHTML(p, m, { status: stepStatus(m, 'script') });
  const contextBody = contextConsoleHTML(p, m, { status: stepStatus(m, 'context') }, busy);
  const storyboardBody = storyboardConsoleHTML(p, m, stats);
  // ⑦ 交付步骤顶部先给「最终产物验收报告」（实时核对优先，lastRun 只是历史快照），再是交付设置与资源；
  //    末尾附每步耗时 / Token 统计表
  const deliverBody = `${directorReportHTML({
    report: m.director?.lastRun,
    verification: p.verification,
    deliverRunning: stepStatus(m, 'deliver') === 'running',
    busy: dirBusy,
  })}`
    + `${deliverConsoleHTML(p, m, stats, busy)}${stepStatsTableHTML(m)}${resourceCardHTML(p, m, stats)}${assetsHTML(p, ctx)}`;
  const bodies = { basic: basicBody, upload: uploadBody, episodes: episodesBody, script: scriptBody, context: contextBody, storyboard: storyboardBody, deliver: deliverBody };

  host.innerHTML = `<div class="pv-shell pv-shell-steps" data-nav="${ui.navCollapsed ? 'collapsed' : 'expanded'}">
    ${navHTML(m, busy)}
    <main class="pv-ssteps" id="pv-steps">
      ${WORKSHOP_STEPS.map((s, i) => stepSectionHTML(s, i + 1, m, bodies[s.id], busy)).join('')}
    </main>
  </div>`;

  // 原著阅读器按需挂载（折叠时不在 DOM 内）
  if (ui.sourceOpen) {
    const sh = host.querySelector('#pv-source-host');
    if (sh) SV.renderSourceView(sh, {
      project: p, source: ctx.source || null, toast: ctx.toast,
      onOpenEpisode: (no) => ctx.onOpenEpisode?.(no),
      onReupload: () => ctx.onReupload?.(),
      onOpenAssets: () => ctx.onOpenAssets?.(),
    });
  }
  // 导航后平滑滚动到目标步骤
  if (ui.scrollTo) {
    const el = host.querySelector(`#step-${ui.scrollTo}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    spyLockUntil = Date.now() + 1200;
    ui.scrollTo = null;
  }
  bindEvents(host, ctx, { m });
  // 每次渲染后重装滚动联动，先清旧监听避免累积
  spyCleanup?.();
  spyCleanup = installScrollSpy(host);
  syncActive(host, ui.stepId);   // 同时对齐窄屏横向步骤条与收起态状态轨
  applyEpisodeFilter(host);      // 分季分集：恢复上次的搜索 / 状态筛选

  // 记录本次渲染上下文：任务卡局部重绘 / 进度恢复都用它，避免闭包拿到旧项目对象
  liveCtx = { host, ctx, p, m };
  const portraitArea = host.querySelector('[data-portrait-area]');
  if (portraitArea) bindPortraitActs(portraitArea, ctx);
  if (ui.portraitJob?.id && ui.portraitJob.status === 'running') {
    watchPortraitJob(ui.portraitJob.id, { toast: ctx.toast, ctx, p });
  } else if (!ui.portraitJob && (m.characters || []).length) {
    restorePortraitJob(p);
  }
}

/** 顶栏「更多」/ 首页流程卡直达某个工作台 Tab（映射到步骤） */
export function setWorkshopTab(id) {
  const map = { overview: 'basic', source: 'upload', episodes: 'episodes', assets: 'deliver' };
  const step = map[id] || 'basic';
  ui.stepId = step; ui.scrollTo = step;
}

/** app.js 在 bootstrap / 配置变化后同步 ComfyUI 摘要，工作台据此决定一键出图按钮的可用态 */
export function setComfySummary(comfy) {
  ui.comfy = comfy && typeof comfy === 'object' ? comfy : null;
}

/** app.js 在 bootstrap 后同步服务端 API 能力：旧进程缺角色出图任务接口时，界面直接提示重启 */
export function setApiInfo(api) {
  ui.api = api && typeof api === 'object' ? api : null;
}

/** 服务端是否在跑旧代码（缺少角色定妆后台任务能力） */
function apiStale() {
  const caps = ui.api?.capabilities;
  return !Array.isArray(caps) || !caps.includes('char-portrait-jobs');
}

/* ------------------------------------------------ 角色定妆后台任务（进度 / 恢复 / 暂停） */
let liveCtx = null;          // 最近一次渲染的 { host, ctx, p, m }，供 CSS 局部重绘与任务轮询复用
let jobPollTimer = null;
const settledJobIds = new Set();
const restoreTried = new Set();

/** 刷新页面 / 切回工作台：恢复「正在跑 / 刚跑完」的任务状态（不重复弹完成提示） */
async function restorePortraitJob(p) {
  if (!p?.id || restoreTried.has(p.id)) return;
  restoreTried.add(p.id);
  try {
    const d = await api(`/api/projects/${p.id}/characters/jobs`);
    const job = d.job;
    if (!job) return;
    const fresh = ui.portraitJob?.id === job.id ? ui.portraitJob : job;
    ui.portraitJob = fresh;
    paintPortraitArea();
    if (job.status === 'running') {
      watchPortraitJob(job.id, { toast: liveCtx?.ctx?.toast, ctx: liveCtx?.ctx, p });
    } else {
      // 已完成但本地角色数据可能落后：静默拉一次最新项目
      await liveCtx?.ctx?.onChanged?.();
      rerenderLive();
    }
  } catch { /* 没有任务或接口暂不可用：保持空态 */ }
}

/** 只重绘第④步的任务卡区域，不打断用户滚动 / 编辑其它步骤 */
function paintPortraitArea() {
  if (!liveCtx) return;
  const area = liveCtx.host?.querySelector('[data-portrait-area]');
  if (!area) return;
  area.innerHTML = portraitAreaHTML(liveCtx.p, liveCtx.p.management || {});
  bindPortraitActs(area, liveCtx.ctx);
}

function bindPortraitActs(root, ctx) {
  const p = liveCtx?.p;
  if (!p) return;
  const toast = ctx?.toast || (() => {});
  root.querySelectorAll('[data-act="char-gen-all"]').forEach((b) => b.addEventListener('click', () => startPortraitJob({ toast, ctx, p })));
  root.querySelectorAll('[data-act="char-regen-all"]').forEach((b) => b.addEventListener('click', () => {
    const chars = p.management?.characters || [];
    const total = chars.length * PVIEWS.length + chars.length;
    if (!window.confirm(`覆盖重生成全部 ${chars.length} 位角色的 ${total} 张图？\n已在 ComfyUI 队列中的任务不受影响，单张约 30 秒，可随时暂停。`)) return;
    startPortraitJob({ toast, ctx, p, force: true });
  }));
  root.querySelectorAll('[data-act="char-gen-one"]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    startPortraitJob({ toast, ctx, p, characterIds: [b.dataset.char], force: b.dataset.force === '1' });
  }));
  // 单张视图重生成：空格 / 占位图点整格，真实图点右下角「↻」
  root.querySelectorAll('[data-act="char-regen-view"]').forEach((el) => el.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const c = (p.management?.characters || []).find((x) => x.id === el.dataset.char);
    if (c) regenCharView({ toast, ctx, p, c, key: el.dataset.view });
  }));
  root.querySelectorAll('[data-act="char-job-cancel"]').forEach((b) => b.addEventListener('click', async () => {
    const jobId = ui.portraitJob?.id;
    if (!jobId) return;
    b.disabled = true;
    try {
      const d = await api(`/api/projects/${p.id}/characters/jobs/${jobId}`, { action: 'cancel' });
      if (d.job) applyPortraitJob(d.job);
      toast('已请求暂停：当前这张生成结束后停止', 'ok');
    } catch (e2) { toast(e2.message, 'err'); b.disabled = false; }
  }));
  root.querySelectorAll('[data-act="char-detail"]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const c = (p.management?.characters || []).find((x) => x.id === b.dataset.char);
    if (c) openCharacterDetail(c, {
      projectId: p.id, toast, comfy: ui.comfy, apiStale: apiStale(),
      onChanged: async () => { await ctx?.onChanged?.(); rerenderLive(); },
      onEdit: () => ctx?.onManage?.('characters'),
    });
  }));
}

/** 单张重新生成：不走队列任务（只有一张），直接调用单视图接口并局部更新 */
async function regenCharView({ toast = () => {}, ctx, p, c, key } = {}) {
  if (apiStale()) {
    toast('服务端仍在运行旧版本：请重启服务（npm start）后再生成，否则只会得到占位图', 'err');
    return;
  }
  if (!ui.comfy?.imageWorkflow) {
    toast('还没有 ComfyUI 出图工作流：请到「设置 → 本地 ComfyUI」导入一份「导出(API)」格式的图像工作流', 'err');
    return;
  }
  if (ui.viewRegen) { toast('已有一张在生成，请等它完成', 'warn'); return; }
  const label = key === 'sheet' ? '定妆板' : (PVIEWS.find((v) => v.key === key)?.label || key);
  ui.viewRegen = { charId: c.id, view: key };
  paintPortraitArea();
  try {
    const d = await api(`/api/projects/${p.id}/characters/views`, withCharImage({
      characterId: c.id, view: key, requireReal: true,
    }));
    const updated = (d.characters || []).find((x) => x.id === c.id);
    if (updated) Object.assign(c, updated);
    toast(`「${c.name}·${label}」已重新生成（${d.provider || 'comfyui'}）`, 'ok');
    await ctx?.onChanged?.();
  } catch (e) {
    toast(`「${c.name}·${label}」重新生成失败：${e.message}`, 'err');
  } finally {
    ui.viewRegen = null;
    paintPortraitArea();
  }
}

function rerenderLive() {
  if (!liveCtx) return;
  renderProjectView(liveCtx.host, liveCtx.ctx);
}

/** 启动后台任务：POST 立即返回 jobId，之后用 SSE + 轮询双通道更新卡片。
 *  force=true：忽略「只补缺失」，已生成的真实图也覆盖重出（全部重新生成）。 */
async function startPortraitJob({ toast = () => {}, ctx, p, characterIds = null, force = false } = {}) {
  if (apiStale()) {
    toast('服务端仍在运行旧版本：请重启服务（终端 Ctrl+C 后重新 npm start）再生成，否则只会得到占位图', 'err');
    return;
  }
  if (!ui.comfy?.imageWorkflow) {
    toast('还没有 ComfyUI 出图工作流：请到「设置 → 本地 ComfyUI」导入一份「导出(API)」格式的图像工作流', 'err');
    return;
  }
  try {
    const d = await api(`/api/projects/${p.id}/characters/views/all`, withCharImage({
      scope: 'all', includeSheet: true,
      onlyMissing: !force, regenerateMock: true, requireReal: true,
      concurrency: 2,
      ...(characterIds ? { characterIds } : {}),
    }));
    if (!d.jobId) {
      // 旧服务端没有任务接口：立即给出可执行的修复动作，而不是让用户等一个挂住的同步请求
      throw new Error(d.message || '服务端未返回任务号，可能仍在运行旧版本，请重启服务后重试');
    }
    if (d.job) applyPortraitJob(d.job);
    if (d.jobId) watchPortraitJob(d.jobId, { toast, ctx, p });
    toast(d.message || '已开始生成角色图', 'ok');
    paintPortraitArea();
  } catch (e) {
    toast(`启动生成失败：${e.message}`, 'err');
  }
}

/** 轮询兜底：SSE 断线 / 页面重连时仍能拿到权威进度 */
function watchPortraitJob(jobId, { toast, ctx, p } = {}) {
  clearInterval(jobPollTimer);
  jobPollTimer = setInterval(async () => {
    try {
      const d = await api(`/api/projects/${p.id}/characters/jobs/${jobId}`);
      if (!d.job) return;
      applyPortraitJob(d.job);
      if (d.job.status !== 'running') {
        clearInterval(jobPollTimer); jobPollTimer = null;
        await settlePortraitJob(d.job, { toast, ctx, p });
      }
    } catch { /* 网络抖动：下一轮继续 */ }
  }, 2500);
}

/** 任务结束后：拉取最新项目（拿到全部真实图 URL）+ 重绘 + 如实播报结果 */
async function settlePortraitJob(job, { toast = () => {}, ctx, p } = {}) {
  if (!job || settledJobIds.has(job.id)) return;
  settledJobIds.add(job.id);
  clearInterval(jobPollTimer); jobPollTimer = null;
  if (!liveCtx?.host?.querySelector('[data-portrait-area]')) return;   // 不在工作台：由 app.js 提示
  try { await ctx?.onChanged?.(); } catch { /* ignore */ }
  // onChanged 只刷新项目列表/侧栏，工作台需要显式重绘才能拿到 onChanged 里的最新 management
  rerenderLive();
  const tail = job.videoReady?.label || '';
  const tone = job.status === 'done' ? 'ok' : 'warn';
  toast([job.message || '角色定妆任务结束', tail].filter(Boolean).join(' · '), tone);
  if (job.failedCount) toast(`有 ${job.failedCount} 张生成失败：${(job.failed || []).slice(0, 2).join('；')}`, 'err');
}

/** SSE / 轮询写入任务状态；非运行态自动触发收尾（去重） */
export function applyPortraitJob(job) {
  if (!job) return;
  ui.portraitJob = job;
  paintPortraitArea();
  if (job.status !== 'running') {
    const ctx = liveCtx?.ctx;
    const p = liveCtx?.p;
    settlePortraitJob(job, { toast: ctx?.toast, ctx, p });
  }
}

/** SSE 逐张进度：更新卡片状态与缩略图（服务端已落盘，前端只做展示） */
export function applyPortraitEvent(e) {
  if (!e || !e.jobId) return;
  const job = ui.portraitJob && ui.portraitJob.id === e.jobId
    ? ui.portraitJob
    : (ui.portraitJob = { id: e.jobId, status: 'running', total: e.total, done: 0, byChar: {}, current: null });
  job.status = 'running';
  job.total = Number(e.total) || job.total;
  job.done = Number.isFinite(Number(e.done)) ? Number(e.done) : job.done;
  const one = job.byChar[e.characterId]
    || (job.byChar[e.characterId] = { id: e.characterId, name: e.name, status: 'pending', views: {}, total: 6 });
  one.name = e.name || one.name;
  if (e.view) {
    one.views[e.view] = { status: e.status, provider: e.provider || '', url: e.url || '' };
    const done = Object.entries(one.views).filter(([k, v]) => k !== 'sheet' && (v.status === 'done' || v.status === 'skip')).length;
    const failed = Object.entries(one.views).filter(([k, v]) => k !== 'sheet' && v.status === 'error').length;
    one.status = Object.entries(one.views).some(([k, v]) => k !== 'sheet' && v.status === 'running') ? 'running'
      : failed && !done ? 'error' : done >= 5 ? 'done' : 'running';
  }
  job.current = e.status === 'running'
    ? { characterId: e.characterId, name: e.name, view: e.view, label: e.label }
    : null;
  // 图上屏：把刚落盘的 URL 写进本地角色对象，卡片缩略图立即出现
  if (e.url && e.characterId) {
    const c = (liveCtx?.p?.management?.characters || []).find((x) => x.id === e.characterId);
    if (c) {
      if (e.view === 'sheet') c.sheet = { ...(c.sheet || {}), url: e.url, provider: e.provider || '' };
      else if (e.view) c.views = { ...(c.views || {}), [e.view]: { ...(c.views?.[e.view] || {}), url: e.url, provider: e.provider || '' } };
    }
  }
  paintPortraitArea();
  // 最后一张完成（无具体视图的事件）→ 拉权威状态并收尾
  if (!e.view && (e.status === 'done' || e.status === 'error') && Number(e.done) >= Number(e.total)) {
    const p = liveCtx?.p; const ctx = liveCtx?.ctx;
    if (p) api(`/api/projects/${p.id}/characters/jobs/${e.jobId}`)
      .then((d) => { if (d.job) applyPortraitJob(d.job); })
      .catch(() => {});
    if (ctx) settlePortraitJob({ id: e.jobId, status: e.status === 'done' ? 'done' : 'error', message: '角色定妆任务结束' }, { toast: ctx.toast, ctx, p });
  }
}

/* ===== 步骤高亮的轻量同步：滚动联动 / 点击导航都不重建 DOM ===== */
let spyCleanup = null;
let spyLockUntil = 0;

/** 只切 class 与 aria-current，避免 rerender 重建 DOM 丢失用户正在编辑的表单 */
function syncActive(host, id) {
  host.querySelectorAll('.pv-nav-item').forEach((b) => {
    const on = b.dataset.step === id;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
  });
  host.querySelectorAll('.pv-sstep').forEach((s) => s.classList.toggle('pv-sstep-active', s.id === `step-${id}`));
  updateRail(host, id);   // 收起态状态轨的高亮 / 当前步提示跟随滚动联动
  // 窄屏下步骤条是横向滚动的：把当前项滚进可视范围，避免被挤出屏幕（隐藏时跳过）
  const list = host.querySelector('.pv-nav-list');
  const btn = host.querySelector(`.pv-nav-item[data-step="${id}"]`);
  if (list && btn && list.offsetWidth > 0 && getComputedStyle(list).flexDirection === 'row') {
    const l = list.getBoundingClientRect(), r = btn.getBoundingClientRect();
    if (r.left < l.left + 4) list.scrollLeft -= (l.left + 4 - r.left);
    else if (r.right > l.right - 4) list.scrollLeft += (r.right - (l.right - 4));
  }
}

/** 滚动联动：判断哪个步骤区块顶部已越过判定线，轻量切高亮（不触发 captureState/rerender） */
function installScrollSpy(host) {
  const sections = [...host.querySelectorAll('.pv-sstep')];
  if (!sections.length) return () => {};
  // 滚动容器优先取 host 自身（#project-view overflow:auto），否则向上找
  let scroller = host;
  while (scroller && scroller !== document.body && !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)) {
    scroller = scroller.parentElement;
  }
  scroller = (!scroller || scroller === document.body) ? window : scroller;
  let raf = 0;
  const update = () => {
    raf = 0;
    if (Date.now() < spyLockUntil) return;   // 点击导航后的平滑滚动期间锁定，避免高亮抖动
    const base = (scroller === window ? 0 : scroller.getBoundingClientRect().top) + 120;
    let activeId = sections[0].id;
    for (const s of sections) if (s.getBoundingClientRect().top <= base) activeId = s.id;
    // 滚到底部时强制高亮最后一步：末步区块较矮，顶部可能永远越不过判定线
    if (scroller !== window && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8) {
      activeId = sections[sections.length - 1].id;
    }
    const id = activeId.replace('step-', '');
    if (id !== ui.stepId) { ui.stepId = id; syncActive(host, id); }
  };
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  const onResize = () => { syncActive(host, ui.stepId); onScroll(); };  // 窗口变窄时对齐横向步骤条与状态轨
  window.addEventListener('resize', onResize);
  return () => {
    scroller.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    if (raf) cancelAnimationFrame(raf);
  };
}

/* ================================================================== 事件绑定 */
function bindEvents(host, ctx, { m }) {
  const p = ctx.project;
  const toast = ctx.toast || (() => {});
  const q = (sel) => host.querySelector(sel);
  const rerender = () => {
    // 优先用宿主提供的最新上下文（项目对象可能已被 SSE / 导演运行刷新替换）；
    // 直接复用闭包里的旧 ctx 会让刚写回的管理状态（如导演验收报告）在重绘中丢失。
    if (typeof ctx.onRerender === 'function') ctx.onRerender();
    else { renderProjectView(host, ctx); mountModelPickers(); }
  };
  /** 各 AI 入口旁的模型下拉（rerender 会重建 DOM，每次重挂；选择由 localStorage 记忆） */
  const mountModelPickers = () => {
    const aiFill = q('[data-act="ai-fill"]');
    if (aiFill && !host.querySelector('[data-model-pick="bible"]')) ensureModelPicker('bible', aiFill.parentElement, aiFill);
    const aiCover = q('[data-act="ai-cover"]');
    if (aiCover && !host.querySelector('[data-model-pick="cover"]')) ensureModelPicker('cover', aiCover.parentElement, aiCover);
    const novelBtn = host.querySelector('[data-ai="outline"]');
    if (novelBtn && !host.querySelector('[data-model-pick="novel"]')) ensureModelPicker('novel', novelBtn.parentElement, novelBtn);
    const charBtn = host.querySelector('[data-act="char-extract"]');
    if (charBtn && !host.querySelector('[data-model-pick="chars"]')) ensureModelPicker('chars', charBtn.parentElement, charBtn);
    // 剧本台：单集 / 批量生成都按「项目 + episode 入口」记忆模型选择
    const scriptBtn = q('[data-act="gen-scripts"][data-missing="1"]');
    if (scriptBtn && !host.querySelector('[data-model-pick="episode"]')) ensureModelPicker('episode', scriptBtn.parentElement, scriptBtn);
    // 本次使用的 ComfyUI 接口：角色与封面入口（同类档案少于 2 份时不插入）
    if (charBtn) ensureInterfacePicker('character-view', charBtn.parentElement, charBtn);
    if (aiCover) ensureInterfacePicker('cover', aiCover.parentElement, aiCover);
  };
  const manage = async (action, value, silent = false) => {
    try {
      const d = await api(`/api/projects/${p.id}/manage`, { action, value });
      if (!silent) toast(d.message || '已更新', 'ok');
      // 重命名会同时改项目 name 与 management.title：本地立即同步，不等 SSE 回灌
      if (action === 'rename') {
        const next = String(value || '').trim();
        if (next) { p.name = next; ui.projectName = next; }
      }
      p.management = d.management || p.management;
      await ctx.onChanged?.();
      rerender();
      return d;
    } catch (e) { toast(e.message, 'err'); return null; }
  };
  /** 保存项目名称（工作台内联编辑）：名称没变直接跳过，失败时保留用户输入 */
  const saveName = async (silent = false) => {
    const el = q('#pv-name');
    if (!el) return true;
    const name = String(el.value || '').trim();
    if (!name) { toast('项目名称不能为空', 'err'); el.focus(); return false; }
    if (name === p.name) return true;
    return !!(await manage('rename', name, silent));
  };
  /** 默认轻量：只切高亮 + 平滑滚动，不重建 DOM（不丢失正在编辑的表单）。
   *  需要展开上传/AI 表单的入口传 { rerender: true } 走整页渲染。 */
  const gotoStep = (id, opts = {}) => {
    ui.stepId = id;
    if (opts.rerender) { ui.scrollTo = id; rerender(); return; }
    ui.scrollTo = null;
    syncActive(host, id);
    spyLockUntil = Date.now() + 1200;
    host.querySelector(`#step-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const switchTab = (id) => { ui.tab = id; ctx.onTabChange?.(id); rerender(); };

  // Tab 导航（顶部标签 + 概览里的快捷入口共用 data-tab）
  host.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  q('[data-act="view-source"]')?.addEventListener('click', () => switchTab('source'));
  host.querySelectorAll('[data-act="open-overall"]').forEach((b) => b.addEventListener('click', () => ctx.onOpenOverallCanvas?.()));
  host.querySelectorAll('[data-act="open-episode"]').forEach((b) => b.addEventListener('click', () => ctx.onOpenEpisode?.(Number(b.dataset.no))));
  host.querySelectorAll('[data-act="open-ep-canvas"]').forEach((b) => b.addEventListener('click', () => ctx.onOpenEpisodeCanvas?.(Number(b.dataset.no))));
  host.querySelectorAll('[data-act="open-season-canvas"]').forEach((b) => b.addEventListener('click', () => ctx.onOpenOverallCanvas?.()));
  host.querySelectorAll('[data-act="add-season"]').forEach((b) => b.addEventListener('click', () => ctx.onAddSeason?.()));
  host.querySelectorAll('[data-act="remove-season"]').forEach((b) => b.addEventListener('click', () => ctx.onRemoveSeason?.(Number(b.dataset.no))));
  host.querySelectorAll('[data-ep-season]').forEach((sel) => sel.addEventListener('change', () => {
    ctx.onAssignSeason?.(Number(sel.dataset.epSeason), Number(sel.value));
  }));
  host.querySelectorAll('[data-season-title]').forEach((inp) => inp.addEventListener('change', () => {
    ctx.onRenameSeason?.(Number(inp.dataset.seasonTitle), inp.value);
  }));

  /* ---- 分季分集：搜索 / 筛选 / 折叠（只切 DOM，不重建表单） ---- */
  const sxSearch = q('#sx-search');
  if (sxSearch) sxSearch.addEventListener('input', () => { ui.epFilter.query = sxSearch.value; applyEpisodeFilter(host); });
  host.querySelectorAll('[data-act="sx-clear-filter"]').forEach((b) => b.addEventListener('click', () => {
    ui.epFilter = { query: '', status: 'all' };
    if (sxSearch) sxSearch.value = '';
    host.querySelectorAll('[data-sx-status]').forEach((x) => x.classList.toggle('on', x.dataset.sxStatus === 'all'));
    applyEpisodeFilter(host);
  }));
  host.querySelectorAll('[data-sx-status]').forEach((b) => b.addEventListener('click', () => {
    ui.epFilter.status = b.dataset.sxStatus;
    host.querySelectorAll('[data-sx-status]').forEach((x) => x.classList.toggle('on', x === b));
    applyEpisodeFilter(host);
  }));
  host.querySelectorAll('[data-act="sx-toggle-season"]').forEach((b) => b.addEventListener('click', () => {
    const no = Number(b.dataset.no);
    const sec = b.closest('[data-season]');
    const collapsed = !ui.collapsedSeasons.includes(no);
    ui.collapsedSeasons = collapsed ? [...ui.collapsedSeasons, no] : ui.collapsedSeasons.filter((x) => x !== no);
    if (sec) sec.classList.toggle('collapsed', collapsed);
    b.textContent = collapsed ? '▸' : '▾';
    b.setAttribute('aria-expanded', String(!collapsed));
    b.title = collapsed ? '展开本季' : '折叠本季';
  }));

  /* ---- 剧本：单集生成 / 批量补齐 / 阅读 / 编辑保存 / 导出 ---- */
  const syncProject = async () => {
    try {
      const fresh = await api(`/api/projects/${p.id}`);
      if (fresh?.management) p.management = fresh.management;
    } catch { /* 拉取失败时保留本地已写入的单集结果 */ }
  };
  const episodeOf = (no) => (p.management?.episodes || []).find((e) => Number(e.no) === Number(no));
  const generateEpisode = async (no) => {
    if (ui.script.busyNo) return;
    ui.script.busyNo = Number(no);
    rerender();
    try {
      const d = await api(`/api/projects/${p.id}/episodes/${no}/script`, withModelId('episode', {}));
      const ep = episodeOf(no);
      if (ep && d.script) ep.script = d.script;
      ui.script.busyNo = null;
      ui.script.openNo = Number(no);
      toast(d.message || '剧本已生成', 'ok');
      await ctx.onChanged?.();
      rerender();
    } catch (err) {
      ui.script.busyNo = null;
      toast(err.message, 'err');
      rerender();
    }
  };
  const generateBatch = async (onlyMissing, nos) => {
    if (ui.script.batchBusy) return;
    ui.script.batchBusy = onlyMissing ? 'missing' : 'all';
    rerender();
    try {
      const d = await api(`/api/projects/${p.id}/episodes/scripts`,
        withModelId('episode', { onlyMissing, force: !onlyMissing, ...(nos ? { nos } : {}) }));
      await syncProject();
      ui.script.batchBusy = '';
      toast(d.message || `已生成 ${d.generated} 集剧本`, d.ok === false ? 'err' : 'ok');
      await ctx.onChanged?.();
      rerender();
    } catch (err) {
      ui.script.batchBusy = '';
      toast(err.message, 'err');
      rerender();
    }
  };
  host.querySelectorAll('[data-act="gen-ep-script"]').forEach((b) => b.addEventListener('click', () => {
    const no = Number(b.dataset.no);
    const ep = (p.management?.episodes || []).find((e) => Number(e.no) === no);
    if (PMODEL.isFinalized(ep)) { toast('这一集已定稿：请先撤销定稿再重做', 'err'); return; }
    if (b.dataset.force === '1' && !window.confirm(`重写第 ${no} 集剧本？当前内容会被覆盖。`)) return;
    setActiveEpisode(p, no);
    generateEpisode(no);
  }));
  host.querySelectorAll('[data-act="gen-scripts"]').forEach((b) => b.addEventListener('click', () => {
    const onlyMissing = b.dataset.missing === '1';
    // 已定稿集锁定：批量动作只作用于未定稿集
    const openNos = (p.management?.episodes || [])
      .filter((e) => !PMODEL.isFinalized(e)).map((e) => Number(e.no));
    if (!openNos.length) { toast('所有集都已定稿：先撤销定稿再批量生成', 'err'); return; }
    if (!onlyMissing) {
      const cov = PMODEL.scriptCoverage((p.management?.episodes || []).filter((e) => !PMODEL.isFinalized(e)));
      if (cov.written && !window.confirm(`将重写 ${cov.total} 集未定稿剧本（已有 ${cov.written} 集），继续？`)) return;
    }
    generateBatch(onlyMissing, openNos);
  }));
  host.querySelectorAll('[data-act="gen-season-scripts"]').forEach((b) => b.addEventListener('click', () => {
    const no = Number(b.dataset.no);
    const nos = (p.management?.episodes || [])
      .filter((e) => PMODEL.seasonOf(e) === no && !e.script && !PMODEL.isFinalized(e)).map((e) => Number(e.no));
    if (!nos.length) { toast('本季没有待补的剧本（或已全部定稿）', 'ok'); return; }
    generateBatch(true, nos);
  }));

  // 当前剧集：顶部切换条 / 流水线 / 说明条共用同一个入口，切换即隔离各集界面状态
  const selectEp = (no) => {
    if (!setActiveEpisode(p, no)) return;
    rerender();
  };
  host.querySelectorAll('[data-act="pick-ep"]').forEach((b) => b.addEventListener('click', () => selectEp(b.dataset.no)));
  host.querySelectorAll('[data-act="ep-prev"], [data-act="ep-next"]').forEach((b) => b.addEventListener('click', () => selectEp(b.dataset.no)));
  host.querySelectorAll('[data-ep-select]').forEach((sel) => sel.addEventListener('change', () => selectEp(sel.value)));
  // 季下拉：选季 = 选中该季顺序上的第一集（空季给明确提示）
  host.querySelectorAll('[data-season-select]').forEach((sel) => sel.addEventListener('change', () => {
    const season = Number(sel.value);
    const first = PMODEL.episodeQueue(p).find((x) => x.season === season);
    if (!first) { toast('这一季还没有分集：先在第 ③ 步把集移进来', 'warn'); rerender(); return; }
    selectEp(first.no);
  }));
  host.querySelectorAll('[data-act="start-ep-flow"]').forEach((b) => b.addEventListener('click', () => {
    setActiveEpisode(p, Number(b.dataset.no) || ui.activeNo);
    ui.script.openNo = num(ui.activeNo);
    gotoStep('script', { rerender: true });
  }));

  // 定稿 / 撤销定稿：定稿后自动切到顺序里的下一集并回到第 ④ 步
  host.querySelectorAll('[data-act="finalize-ep"]').forEach((b) => b.addEventListener('click', async () => {
    const no = Number(b.dataset.no);
    const on = b.dataset.on !== '0';
    const ep = (p.management?.episodes || []).find((e) => Number(e.no) === no);
    if (!ep) return;
    if (on && !PMODEL.canFinalizeEpisode(ep)) {
      toast('这一集的 ④⑤⑥⑦ 四段还没全部完成，不能定稿', 'warn');
      return;
    }
    if (!on && !window.confirm(`撤销第 ${no} 集的定稿？撤销后可以继续修改本集四段产物。`)) return;
    const cur = PMODEL.episodeQueue(p).find((x) => x.no === no);
    const next = on ? PMODEL.nextPendingEpisode(p, no) : null;
    // 先改 UI 状态，再由 onFinalizeEpisode 统一落盘 + 重绘（一次渲染对齐全部视图）
    if (next) setActiveEpisode(p, next.no);
    else if (!on) setActiveEpisode(p, no);
    ui.stepId = 'script';
    ui.scrollTo = 'script';
    if (ctx.onFinalizeEpisode) await ctx.onFinalizeEpisode(no, on);
    else rerender();
    if (on) {
      const label = PMODEL.episodeLabelFull(cur?.season || 1, no);
      const othersPending = PMODEL.episodeQueue(p).some((x) => x.no !== no && !x.finalized);
      const tail = next
        ? `→ 继续 ${PMODEL.queueItemLabel(next)}${next.season !== cur?.season ? `（进入${PMODEL.seasonLabel(next.season)}）` : ''}`
        : othersPending ? '✓ 本集已定稿（还有其它未定稿集，可用顶部条切换）' : '✓ 本项目所有集已定稿';
      toast(`${label} 已定稿 ${tail}`, 'ok');
    } else {
      toast(`第 ${no} 集已撤销定稿，可继续修改`, 'ok');
    }
  }));

  // 分集制作：单集执行第⑤⑥⑦步（后端 episode-runner，状态记 ep.steps）
  host.querySelectorAll('[data-act="run-ep-step"]').forEach((b) => b.addEventListener('click', async () => {
    const no = Number(b.dataset.no);
    const stepId = String(b.dataset.step || '');
    if (!EP_STEP_TITLES[stepId] || ui.epStep.busyNo || ui.epStep.batchBusy) return;
    const targetEp = (p.management?.episodes || []).find((e) => Number(e.no) === no);
    if (PMODEL.isFinalized(targetEp)) { toast('这一集已定稿：请先撤销定稿再重做', 'err'); return; }
    if (b.dataset.force === '1' && !window.confirm(`重做第 ${no} 集「${EP_STEP_TITLES[stepId]}」？该集本步已有产物会被覆盖。`)) return;
    setActiveEpisode(p, no);
    ui.epStep = { busyNo: no, busyStep: stepId, batchBusy: '' };
    rerender();
    try {
      const d = await api(`/api/projects/${p.id}/episodes/${no}/step`, { stepId });
      const ep = (p.management?.episodes || []).find((e) => Number(e.no) === no);
      if (ep && d.episode) Object.assign(ep, d.episode);
      toast(d.message || (d.ok ? '执行完成' : '执行失败'), d.ok ? 'ok' : 'err');
      await ctx.onChanged?.();
    } catch (err) {
      toast(err.message, 'err');
    }
    ui.epStep = { busyNo: null, busyStep: '', batchBusy: '' };
    rerender();
  }));
  // 分集制作：批量补齐未完成的集（单集失败不阻断后续）
  host.querySelectorAll('[data-act="run-ep-steps"]').forEach((b) => b.addEventListener('click', async () => {
    const stepId = String(b.dataset.step || '');
    if (!EP_STEP_TITLES[stepId] || ui.epStep.busyNo || ui.epStep.batchBusy) return;
    const nos = epStepMissingNos(p.management || {}, stepId);
    if (!nos.length) { toast('所有集都已完成本步', 'ok'); return; }
    ui.epStep = { busyNo: null, busyStep: '', batchBusy: stepId };
    rerender();
    try {
      const d = await api(`/api/projects/${p.id}/episodes/steps`, { stepId, nos });
      if (Array.isArray(d.episodes)) p.management.episodes = d.episodes;
      toast(d.message || '批量执行完成', d.ok ? 'ok' : 'err');
      await ctx.onChanged?.();
    } catch (err) {
      toast(err.message, 'err');
    }
    ui.epStep = { busyNo: null, busyStep: '', batchBusy: '' };
    rerender();
  }));
  host.querySelectorAll('[data-act="toggle-script"]').forEach((b) => b.addEventListener('click', () => {
    const no = Number(b.dataset.no);
    setActiveEpisode(p, no);
    ui.script.openNo = num(ui.script.openNo) === no ? null : no;
    ui.script.editNo = null;
    ui.script.draft = null;
    rerender();
  }));
  host.querySelectorAll('[data-act="read-script"]').forEach((b) => b.addEventListener('click', () => {
    const no = Number(b.dataset.no);
    setActiveEpisode(p, no);
    ui.script.openNo = no;
    ui.script.editNo = null;
    ui.script.draft = null;
    gotoStep('script', { rerender: true });
  }));
  host.querySelectorAll('[data-act="edit-script"]').forEach((b) => b.addEventListener('click', () => {
    const no = Number(b.dataset.no);
    setActiveEpisode(p, no);
    const ep = episodeOf(no);
    ui.script.openNo = no;
    ui.script.editNo = no;
    ui.script.draft = ep?.script ? JSON.parse(JSON.stringify(ep.script)) : null;
    rerender();
  }));
  host.querySelectorAll('[data-act="cancel-script"]').forEach((b) => b.addEventListener('click', () => {
    ui.script.editNo = null;
    ui.script.draft = null;
    rerender();
  }));
  host.querySelectorAll('[data-act="save-script"]').forEach((b) => b.addEventListener('click', async () => {
    const no = Number(b.dataset.no);
    const payload = readScriptDraft(host);
    if (!payload) return;
    b.disabled = true;
    b.textContent = '保存中…';
    try {
      const d = await api(`/api/projects/${p.id}/episodes/${no}/script`, { script: payload }, 'PUT');
      const ep = episodeOf(no);
      if (ep && d.script) ep.script = d.script;
      ui.script.editNo = null;
      ui.script.draft = null;
      toast(d.message || '剧本已保存', 'ok');
      await ctx.onChanged?.();
      rerender();
    } catch (err) {
      b.disabled = false;
      b.textContent = '✓ 保存剧本';
      toast(err.message, 'err');
    }
  }));
  host.querySelectorAll('[data-act="export-scripts"]').forEach((b) => b.addEventListener('click', () => {
    window.open(`/api/projects/${p.id}/scripts/export`, '_blank');
  }));
  host.querySelectorAll('[data-act="open-assets"]').forEach((b) => b.addEventListener('click', () => ctx.onOpenAssets?.()));
  host.querySelectorAll('[data-act="refresh-assets"]').forEach((b) => b.addEventListener('click', () => ctx.onRefreshAssets?.()));
  host.querySelectorAll('[data-file]').forEach((b) => b.addEventListener('click', () => ctx.onPreviewAsset?.(b.dataset.file)));

  // 步骤导航（展开栏的步骤行 + 收起轨的状态点，两者共用 data-step）
  host.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => gotoStep(b.dataset.step)));
  // 制作步骤窄栏展开 / 收起：只切属性，不重建 DOM，避免丢失正在编辑的表单
  host.querySelectorAll('[data-act="toggle-nav"]').forEach((b) => b.addEventListener('click', () => setNavCollapsed(host, !ui.navCollapsed)));
  // 步骤② 原著阅读器折叠切换
  q('[data-act="toggle-source"]')?.addEventListener('click', () => { ui.sourceOpen = !ui.sourceOpen; rerender(); });
  q('[data-act="run-next"]')?.addEventListener('click', () => ctx.onRunStep?.(null, false));
  q('[data-act="run-all"]')?.addEventListener('click', () => ctx.onRunStep?.(null, true));
  // 每个步骤区都有自己的「执行本步」按钮，必须全量绑定（早期 querySelector 只绑首个，后 5 个失效）
  host.querySelectorAll('[data-act="run-step"]').forEach((b) => b.addEventListener('click', () => ctx.onRunStep?.(b.dataset.id, false, true)));
  // 分步对话入口：每一步都能开一个只改这一步的会话（basic 已在上游映射到 upload）
  host.querySelectorAll('[data-act="chat-step"]').forEach((b) => b.addEventListener('click', () => ctx.onChatStep?.(b.dataset.id)));

  // 第⑤步：点缩略图 / 提示词 → 大图灯箱（看完整提示词）；「↻ 重出本镜」只重跑这一镜
  shotLb.projectId = p.id;
  host.querySelectorAll('[data-act="shot-open"]').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    openShotLightbox(Number(b.dataset.idx), ctx);
  }));
  host.querySelectorAll('[data-act="shot-regen"]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    regenShotInLightbox(b, Number(b.dataset.idx));
  }));
  // 第⑥步：任务状态看板（已发送 / 进行中 / 已完成）
  // 看板本身由 SSE 触发的 refreshTaskPanel() 局部重绘；这里只管它的两个交互：
  // 「↻ 刷新」立刻按当前项目数据重画一次，prompt_id 点击即可复制。
  mountTaskPanelActs(host, ctx);
  // 第⑤步：分镜画面设置（版式 / 画幅 / 格内信息 / 提示词公式）
  // 版式切换只改本地选中态与描述，点「保存并重排」才提交——避免点一下就重排全项目。
  const sbBox = host.querySelector('[data-sbs]');
  if (sbBox) {
    const readSb = () => {
      const val = (k, fb) => sbBox.querySelector(`[data-sb="${k}"]`)?.value || fb;
      const chk = (k, fb) => {
        const el = sbBox.querySelector(`[data-sb="${k}"]`);
        return el ? el.checked : fb;
      };
      const prompt = {};
      STORYBOARD_PROMPT_PARTS.forEach((x) => {
        const el = sbBox.querySelector(`[data-sbp="${x.id}"]`);
        prompt[x.id] = el ? el.checked : true;
      });
      return {
        layout: sbBox.dataset.layout || 'grid9',
        aspect: val('aspect', 'inherit'),
        captionMode: val('captionMode', 'spec'),
        source: val('source', 'mixed'),
        guides: val('guides', 'thirds'),
        showNo: chk('showNo', true),
        watermark: chk('watermark', true),
        prompt,
      };
    };
    const syncSb = () => {
      const s = readSb();
      const desc = sbBox.querySelector('[data-sb-desc]');
      if (desc) desc.textContent = storyboardDescription(s, p.settings?.aspect);
      // 格数变了要提前告诉用户「重排后会多/少几格」，而不是等落盘才发现
      const hint = sbBox.querySelector('[data-sb-hint]');
      if (hint) {
        const l = storyboardLayout(s.layout);
        hint.textContent = s.source === 'schematic'
          ? `当前只画示意：重排后 ${l.cells} 格全部为剪影占位，不引用真实分镜图`
          : `重排只合成 SVG（每段 ${l.cells} 格），不会重新出图，也不烧 GPU`;
      }
    };
    sbBox.querySelectorAll('[data-sb-layout]').forEach((b) => b.addEventListener('click', () => {
      sbBox.dataset.layout = b.dataset.sbLayout;
      sbBox.querySelectorAll('[data-sb-layout]').forEach((x) => x.classList.toggle('on', x === b));
      syncSb();
    }));
    sbBox.querySelectorAll('[data-sb], [data-sbp]').forEach((el) => el.addEventListener('change', syncSb));
    syncSb();
    sbBox.querySelector('[data-act="sb-save"]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try { await ctx.onSaveStoryboard?.(readSb()); }
      catch (err) { toast(err.message, 'err'); }
      finally { btn.disabled = false; }
    });
    sbBox.querySelector('[data-act="sb-apply"]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const old = btn.textContent;
      btn.disabled = true;
      btn.textContent = '重排中…';
      try { await ctx.onComposeStoryboard?.(readSb()); }
      catch (err) { toast(err.message, 'err'); btn.textContent = old; }
      finally { btn.disabled = false; }
    });
  }
  host.querySelectorAll('[data-act="sheet-open"]').forEach((b) => b.addEventListener('click', () => {
    openSheetPreview(b.dataset.url, b.dataset.title);
  }));

  // 资源 / 管理入口：多个 Tab 里可能出现同名按钮，统一按全部匹配绑定
  host.querySelectorAll('[data-panel="assets"] [data-act="assets"]').forEach((b) => b.addEventListener('click', () => ctx.onOpenAssets?.()));
  host.querySelectorAll('[data-act="chars"]').forEach((b) => b.addEventListener('click', () => ctx.onManage?.('characters')));
  host.querySelectorAll('[data-act="manage"]').forEach((b) => b.addEventListener('click', () => ctx.onManage?.()));
  // 角色详情：资源卡缩略 chip / 第④步角色条目 → 与角色管理共用的详情页
  host.querySelectorAll('[data-char-detail]').forEach((el) => el.addEventListener('click', () => {
    const c = (p.management?.characters || []).find((x) => x.id === el.dataset.charDetail);
    if (!c) return;
    openCharacterDetail(c, {
      projectId: p.id, toast, comfy: ui.comfy, apiStale: apiStale(),
      onChanged: async () => { await ctx.onChanged?.(); rerender(); },
      onEdit: () => ctx.onManage?.('characters'),
    });
  }));
  host.querySelectorAll('[data-act="cover"]').forEach((b) => b.addEventListener('click', () => ctx.onOpenCover?.()));
  q('[data-act="open-canvas"]')?.addEventListener('click', () => ctx.onOpenCanvas?.());
  q('[data-act="goto-upload"]')?.addEventListener('click', () => { ui.upload.open = true; gotoStep('upload', { rerender: true }); });
  q('[data-act="goto-ai"]')?.addEventListener('click', () => { ui.ai.open = true; gotoStep('upload', { rerender: true }); });
  q('[data-act="toggle-upload"]')?.addEventListener('click', () => { ui.upload.open = !ui.upload.open; rerender(); });
  q('[data-act="toggle-ai"]')?.addEventListener('click', () => { ui.ai.open = !ui.ai.open; rerender(); });

  // 项目信息：保存（含项目名称）+ AI 一键生成（信息 + 封面）
  const aiBtns = () => [q('[data-act="ai-fill"]'), q('[data-act="ai-cover"]')].filter(Boolean);
  const setAiBusy = (busy, text) => {
    const fill = q('[data-act="ai-fill"]');
    aiBtns().forEach((b) => { b.disabled = busy; });
    if (fill) fill.textContent = busy ? (text || '✦ AI 生成中…') : '✦ AI 一键生成';
  };
  const generateCover = async (requirement) => {
    const d = await api(`/api/projects/${p.id}/cover/ai`, withCoverImage({ requirement }));
    toast(d.message || '封面已生成', 'ok');
    return d;
  };
  q('[data-act="save-info"]')?.addEventListener('click', async () => {
    captureState(host);
    const idea = String(q('#pv-bi-idea')?.value || '').trim();
    const value = { ...ui.info };
    if (idea && !value.logline) value.logline = idea.slice(0, 300);
    // 名称与其它字段一起提交：先改名（本地立即同步），再存设定
    if (!(await saveName())) return;
    // 只提交真正改动过的字段，避免把未编辑的空值当修改写回
    const b = m.bible || {};
    const changed = {};
    for (const [k, val] of Object.entries(value)) {
      if (String(val ?? '') !== String(b[k] ?? '')) changed[k] = val;
    }
    // 即使一个字段没改，也发一次保存：点「保存项目信息」本身就是对第 ① 步的确认，
    // 服务端会记下 basicInfo.confirmedAt，步骤状态随之变为「已完成」——
    // 不能出现「✓ 已保存」提示与「待执行」并存的自相矛盾。
    const d = await manage('bible', changed);
    if (d?.ok) {
      ui.info = {}; ui.projectName = null;
      const msg = q('#pv-info-msg'); if (msg) msg.textContent = '✓ 已保存 · 第 ① 步已完成';
    }
  });
  // 名称输入框回车即保存，符合「改完立刻生效」的直觉
  q('#pv-name')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    saveName();
  });
  q('[data-act="ai-fill"]')?.addEventListener('click', async () => {
    captureState(host);
    const idea = String(q('#pv-bi-idea')?.value || '').trim();
    setAiBusy(true);
    try {
      const d = await api(`/api/projects/${p.id}/bible/ai`, withModelId('bible', { idea, regenerate: true }));
      toast(d.message || '已补全', 'ok');
      // AI 可能会重新命名项目：本地立即同步，避免标题栏/列表看起来「没改」
      if (d.name) { p.name = d.name; ui.projectName = d.name; }
      ui.info = {};
      ui.skipCapture = true;   // 服务端已改写 bible：丢弃 DOM 里的旧编辑稿，直接渲染新数据
      try { await generateCover(idea); } catch (err) { toast(err.message, 'err'); }
      await ctx.onChanged?.();
      rerender();
    } catch (err) { toast(err.message, 'err'); setAiBusy(false); }
  });
  q('[data-act="ai-cover"]')?.addEventListener('click', async (e) => {
    const idea = String(q('#pv-bi-idea')?.value || '').trim();
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = '🖼 生成中…';
    try {
      await generateCover(idea);
      await ctx.onChanged?.();
      rerender();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false; btn.textContent = '🖼 AI 生成封面';
    }
  });
  host.querySelectorAll('[data-set]').forEach((el) => el.addEventListener('change', () => {
    manage('settings', { [el.dataset.set]: el.value });
  }));

  // ① 上传小说：单文件 / 多文件 / 粘贴正文三条入口，统一按拆分规则提交
  const setUploadMsg = (text, err = false) => {
    ui.upload.msg = text; ui.upload.err = err;
    const msgEl = q('.pv-up-msg');
    if (msgEl) { msgEl.textContent = text; msgEl.classList.toggle('err', err); }
  };
  const paintFiles = () => {
    const box = q('#pv-up-files');
    if (!box) return;
    box.innerHTML = ui.upload.files.length
      ? ui.upload.files.map((f, i) => fileChipHTML(f, i, ui.upload.files.length)).join('')
      : '<span class="pv-up-files-hint">未选择文件 · 也可直接在下方粘贴正文</span>';
  };
  /* 多文件排序：文件名字典序会把「第10章」排在「第2章」前面，这里用自然排序
   * （数字按数值比较）；读取本身是异步的，再用按下标落位的 batch 保证
   * 合并顺序与列表展示顺序一致，不受各文件读取完成先后影响。 */
  const natCmp = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' }).compare;
  const readFiles = (fileList) => {
    const files = [...(fileList || [])].filter((f) => /\.(txt|md|markdown|json|text)$/i.test(f.name))
      .sort((a, b) => natCmp(a.name, b.name));
    if (!files.length) { setUploadMsg('请选择 .txt / .md 文本文件', true); return; }
    if (ui.upload.files.length + files.length > 200) { setUploadMsg('一次最多导入 200 个文件，请合并小文件后再上传', true); return; }
    let pending = files.length;
    const batch = new Array(files.length);
    for (const [i, file] of files.entries()) {
      const reader = new FileReader();
      reader.onload = () => {
        batch[i] = { name: file.name, text: String(reader.result || '') };
        pending -= 1;
        if (pending <= 0) {
          ui.upload.files.push(...batch.filter(Boolean));
          paintFiles();
          const total = ui.upload.files.reduce((a, f) => a + f.text.length, 0);
          if (total > 10_000_000) {
            setUploadMsg(`多文件合计 ${(total).toLocaleString()} 字，超过单项目 10,000,000 字上限 · 请删掉部分文件或分批上传`, true);
            return;
          }
          const seasonSize = Math.max(1, Number(q('#pv-up-season')?.value) || 12);
          setUploadMsg(`已选择 ${ui.upload.files.length} 个文件（按文件名排序 · 可用 ↑/↓ 调整）· 合计 ${total.toLocaleString()} 字 · 预计拆约 ${Math.min(600, Math.max(1, Math.ceil(total / (Number(q('#pv-up-target')?.value) || 1200))))} 集 · 超过 ${seasonSize} 集自动分季`);
          const clearBtn = q('[data-up="clear"]'); if (clearBtn) clearBtn.disabled = false;
        }
      };
      reader.readAsText(file, 'utf-8');
    }
  };
  const readSplit = () => ({
    strategy: q('[data-up-split].selected')?.dataset.upSplit || m.split?.strategy || 'chapter',
    targetChars: Number(q('#pv-up-target')?.value) || m.split?.targetChars || 1200,
    maxEpisodes: Number(q('#pv-up-max')?.value) || m.split?.maxEpisodes || 4,
    seasonSize: Math.max(1, Number(q('#pv-up-season')?.value) || m.split?.seasonSize || 12),
  });

  q('#pv-up-files')?.addEventListener('click', (e) => {
    const mv = e.target.closest('[data-up-move]');
    if (mv) {
      e.preventDefault();
      const i = Number(mv.dataset.upMove);
      const j = i + Number(mv.dataset.dir);
      if (j < 0 || j >= ui.upload.files.length) return;
      const [moved] = ui.upload.files.splice(i, 1);
      ui.upload.files.splice(j, 0, moved);
      paintFiles();
      setUploadMsg(`顺序已调整 · 「${cut(moved.name, 22)}」现在第 ${j + 1} 个合并`);
      return;
    }
    const rm = e.target.closest('[data-up-remove]');
    if (!rm) return;
    e.preventDefault();
    ui.upload.files.splice(Number(rm.dataset.upRemove), 1);
    paintFiles();
    setUploadMsg(ui.upload.files.length ? `已选择 ${ui.upload.files.length} 个文件` : '文件已清空');
  });
  host.querySelectorAll('[data-up-split]').forEach((b) => b.addEventListener('click', () => {
    host.querySelectorAll('[data-up-split]').forEach((x) => x.classList.toggle('selected', x === b));
    ui.upload.strategy = b.dataset.upSplit;
  }));
  host.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', async () => {
    const act = b.dataset.up;
    if (act === 'file') {
      const input = document.createElement('input');
      input.type = 'file'; input.multiple = true;
      input.accept = '.txt,.md,.markdown,.text,text/plain,text/markdown';
      input.onchange = () => readFiles(input.files);
      input.click();
    } else if (act === 'clear') {
      ui.upload.files = []; paintFiles(); b.disabled = true;
      setUploadMsg('文件已清空，可重新选择或粘贴正文');
    } else if (act === 'sample') {
      try {
        const d = await api('/api/novel/sample');
        ui.upload.text = d.text; ui.upload.filename = d.filename;
        const ta = q('#pv-up-text'); if (ta) ta.value = d.text;
        setUploadMsg(`示例已载入 · ${d.text.trim().length} 字`);
      } catch (e2) { setUploadMsg(e2.message, true); }
    } else if (act === 'submit') {
      const split = readSplit();
      const files = ui.upload.files.slice();
      const text = String(q('#pv-up-text')?.value || '').trim();
      if (!files.length && text.length < 40) {
        setUploadMsg(`正文至少需要 40 字（当前 ${text.length} 字）`, true);
        return;
      }
      // 自动分集预算：按「每集目标字数」估算需要的集数，超过当前上限时自动上调
      // （默认 4 集会把百万字长篇并成 4 个巨型集，用户仍可在提交前手动改小）
      const srcLen = files.length ? files.reduce((a, f) => a + (f.text || '').length, 0) : text.length;
      const need = Math.ceil(srcLen / Math.max(300, split.targetChars || 1200));
      if (need > split.maxEpisodes) split.maxEpisodes = Math.min(600, need);
      if (files.length) {
        // 提交前先在本地把总量卡住：超限的大包发到服务端会被 413 拒收，白白等一次失败
        const total = files.reduce((a, f) => a + (f.text || '').length, 0);
        if (total > 10_000_000) {
          setUploadMsg(`多文件合计 ${(total).toLocaleString()} 字，超过单项目 10,000,000 字上限 · 请删掉部分文件或分批上传`, true);
          return;
        }
      }
      b.disabled = true;
      setUploadMsg('正在合并文件、解析章节并自动分集…');
      try {
        const payload = files.length
          ? { files, split }
          : { text, filename: ui.upload.filename, split };
        const out = await api(`/api/projects/${p.id}/source`, payload);
        ui.upload = { open: false, filename: '', text: '', msg: '', err: false, files: [], strategy: '', targetChars: 0, maxEpisodes: 0 };
        ui.stepId = 'episodes';
        await ctx.onSourceUploaded?.(out);
      } catch (e2) {
        b.disabled = false;
        setUploadMsg(e2.message, true);
      }
    }
  }));

  // 分集列表 / 章节映射：点击集号直达剧集详情
  host.querySelectorAll('[data-ep]').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    ctx.onOpenEpisode?.(Number(b.dataset.ep));
  }));

  // ① AI 生成小说
  host.querySelectorAll('[data-ai]').forEach((b) => b.addEventListener('click', async () => {
    if (ui.ai.busy) return;
    captureState(host);
    ui.ai.idea = String(q('#pv-ai-idea')?.value || ui.ai.idea).trim();
    if (!ui.ai.idea) { toast('先写一句故事构想，AI 才有创作方向', 'err'); q('#pv-ai-idea')?.focus(); return; }
    const act = b.dataset.ai;
    if (act === 'outline') {
      ui.ai.busy = true; ui.ai.busyText = '生成大纲中…'; ui.ai.message = '正在生成大纲…'; rerender();
      try {
        const d = await api(`/api/projects/${p.id}/novel/ai`, withModelId('novel', {
          mode: 'outline', idea: ui.ai.idea, chapterCount: ui.ai.chapterCount,
        }));
        ui.ai.outline = d.outline; ui.ai.source = d.source; ui.ai.message = d.message || '';
      } catch (e2) { ui.ai.message = e2.message; toast(e2.message, 'err'); }
      ui.ai.busy = false; ui.ai.busyText = ''; rerender();
    } else if (act === 'full') {
      captureState(host);
      ui.ai.busy = true; ui.ai.busyText = '逐章生成正文中…'; ui.ai.message = '正在逐章生成正文，LLM 模式下可能需要几分钟…'; rerender();
      try {
        const out = await api(`/api/projects/${p.id}/novel/ai`, withModelId('novel', {
          mode: 'full', idea: ui.ai.idea, outline: ui.ai.outline,
          chapterCount: ui.ai.chapterCount, chapterChars: ui.ai.chapterChars, split: m.split,
        }));
        toast(`✦ ${out.message}`, 'ok');
        ui.ai = { open: false, idea: ui.ai.idea, chapterCount: ui.ai.chapterCount, chapterChars: ui.ai.chapterChars, outline: null, source: '', message: '', busy: false, busyText: '' };
        ui.stepId = 'episodes';
        await ctx.onSourceUploaded?.(out);
      } catch (e2) {
        ui.ai.busy = false; ui.ai.busyText = ''; ui.ai.message = e2.message;
        toast(e2.message, 'err'); rerender();
      }
    }
  }));

  // ② 分集
  host.querySelectorAll('[data-split]').forEach((b) => b.addEventListener('click', () => {
    host.querySelectorAll('[data-split]').forEach((x) => x.classList.toggle('selected', x === b));
  }));
  q('[data-act="re-split"]')?.addEventListener('click', async () => {
    const strategy = host.querySelector('[data-split].selected')?.dataset.split || m.split?.strategy;
    const targetChars = Number(q('#pv-sp-target')?.value) || m.split?.targetChars;
    const maxEpisodes = Number(q('#pv-sp-max')?.value) || m.split?.maxEpisodes;
    const seasonSize = Math.max(1, Number(q('#pv-sp-season')?.value) || m.split?.seasonSize || 12);
    const d = await manage('split', { strategy, targetChars, maxEpisodes, seasonSize }, true);
    if (d?.ok) ctx.onRunStep?.('episodes', false, true);
  });

  // ④ 角色提取
  host.querySelectorAll('[data-act="char-extract"]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = '提取中…';
    try {
      const d = await api(`/api/projects/${p.id}/characters/extract`, withModelId('chars', { mode: b.dataset.mode }));
      const st = d.stats ? ` · 候选 ${d.stats.candidates} / 片段 ${d.stats.fragments} / 证据 ${d.stats.verified}✓ ${d.stats.dropped}✗` : '';
      const cleaned = d.removed?.length ? ` · 清理 ${d.removed.length} 个误提取（${d.removed.slice(0, 3).join('、')}${d.removed.length > 3 ? '…' : ''}）` : '';
      // 提取即配声：服务端已为新角色自动分配互不重复的音色
      const vMsg = d.voice?.applied ? ` · 自动绑定音色 ${d.voice.applied} 位` : '';
      toast(`${d.message || `新增 ${d.added || 0} · 合并 ${d.merged || 0}`}${vMsg}${cleaned}${st}`, d.fellBack ? 'err' : 'ok');
      await ctx.onChanged?.();
      rerender();
    } catch (e2) { toast(e2.message, 'err'); b.disabled = false; b.textContent = b.dataset.mode === 'llm' ? '✦ 从原著提取角色（LLM）' : '⚙ 启发式提取'; }
  }));

  // ④ 一键生成全部角色图：由角色任务卡（bindPortraitActs）统一接管，
  //    走「后台任务 + SSE/轮询进度」，不再挂在一个长同步请求上。

  // 导演 Agent：技能选择 → 一键全流程 → 验收报告复跑
  const directorBusy = () => !!ctx.directorBusy || !!ctx.busy;
  const dirSkillId = () => ui.director.skillId || m.director?.skillId || 'full';
  host.querySelectorAll('[data-dir="skill"]').forEach((b) => b.addEventListener('click', async () => {
    if (directorBusy()) return;
    captureState(host);
    const id = b.dataset.id;
    try {
      const out = await ctx.onSelectDirectorSkill?.(id);
      ui.director.skillId = id;
      if (p.management) {
        // styleId 一并写回本地：换导演后主色回到该档案默认色，面板需立即反映
        p.management.director = {
          ...(p.management.director || {}), skillId: id,
          styleId: out?.director?.styleId || null, paletteKey: out?.director?.paletteKey || null,
        };
      }
      toast(out?.message || `已切换导演技能「${id}」`, 'ok');
      rerender();
    } catch (e2) { toast(e2.message, 'err'); }
  }));
  // 主色调切换：只改色不改导演，选张艺谋的四色之一即可看到画面主色变化
  host.querySelectorAll('[data-dir="palette"]').forEach((b) => b.addEventListener('click', async () => {
    if (directorBusy()) return;
    captureState(host);
    const key = b.dataset.key;
    try {
      const out = await ctx.onSelectDirectorPalette?.(key);
      if (p.management?.director) p.management.director.paletteKey = key;
      ui.director.paletteKey = key;
      toast(out?.message || '主色调已切换', 'ok');
      rerender();
    } catch (e2) { toast(e2.message, 'err'); }
  }));
  // 导演风格统一管理：方形卡网格旁的入口 —— 详情 / 删除自定义 / AI 对话生成新风格
  host.querySelectorAll('[data-dir="manage"]').forEach((b) => b.addEventListener('click', () => {
    if (directorBusy()) return;
    openDirectorManager({
      onChanged: async () => { await ctx.onChanged?.(); rerender(); },
    });
  }));
  host.querySelectorAll('[data-dir="run"], [data-dir="rerun"]').forEach((b) => b.addEventListener('click', async () => {
    if (directorBusy()) return;
    captureState(host);
    const idea = String(q('#pv-dir-idea')?.value || ui.director.idea || '').trim();
    b.disabled = true;
    try {
      await ctx.onRunDirector?.({ skillId: dirSkillId(), idea });
    } catch (e2) { toast(e2.message, 'err'); }
    finally { rerender(); }
  }));
  // 短剧成片规格：预设点选 + 字段联动即时预览 + 保存（total/clip/fps/成片模式）
  // 预览只改文案与选中态、绝不整块重绘：否则用户正在敲总时长时输入框会失焦。
  const rtBox = host.querySelector('[data-rt-box]');
  if (rtBox) {
    const rtTotal = rtBox.querySelector('#pv-rt-total');
    const rtClip = rtBox.querySelector('#pv-rt-clip');
    const rtClipAny = rtBox.querySelector('#pv-rt-clip-any');
    const rtFps = rtBox.querySelector('#pv-rt-fps');
    const rtRes = rtBox.querySelector('#pv-rt-res');
    const rtPolicy = rtBox.querySelector('#pv-rt-policy');
    const rtEq = rtBox.querySelector('[data-rt-eq]');
    const rtBadge = rtBox.querySelector('.rt-badge');
    const rtCustom = rtBox.querySelector('[data-rt-custom]');
    const rtCustomHint = rtBox.querySelector('[data-rt-custom-hint]');
    const rtNote = rtBox.querySelector('[data-rt-policy-note]');
    const rtSave = rtBox.querySelector('[data-rt="save"]');

    /** 读当前表单值：每片段选「自定义…」时取旁边数字框；分辨率为该画幅档位之一 */
    const readRt = () => ({
      totalSeconds: Number(rtTotal?.value),
      clipSeconds: rtClip?.value === 'custom' ? Number(rtClipAny?.value) : Number(rtClip?.value),
      fps: Number(rtFps?.value),
      resolution: rtRes?.value || '',
      aspect: p.settings?.aspect,
      filmPolicy: rtPolicy?.value === 'preview' ? 'preview' : 'real',
    });

    /** 表单初始值：用于判断「已改动未保存」，避免用户点完预设以为已生效 */
    const rtBaseline = JSON.stringify(readRt());

    const syncRt = () => {
      // 「自定义…」与数字框互相显隐：选了自定义必须能立刻输入，选回档位则收起
      const custom = rtClip?.value === 'custom';
      if (rtClipAny) rtClipAny.hidden = !custom;
      const raw = readRt();
      const spec = previewRuntimeSpec(raw);
      const ok = raw.totalSeconds > 0 && raw.clipSeconds > 0;
      // 命中的预设（用对齐后的值匹配，与卡片高亮同一口径）；都不命中即「自定义」
      const hit = ok ? matchRuntimePreset(spec.totalSeconds, spec.clipSeconds) : '';
      if (rtEq) {
        rtEq.innerHTML = ok
          ? `${spec.totalSeconds}s ÷ ${spec.clipSeconds}s = <b>${spec.clipCount} 个片段</b> · ${spec.fps}fps · ${spec.totalFrames} 帧 · ${spec.resolution}${spec.aligned ? `（总时长按 ${spec.clipSeconds}s 对齐为 ${spec.totalSeconds}s）` : ''}`
          : '<b>总时长与每片段时长都必须是正数</b>';
      }
      if (rtBadge) rtBadge.textContent = ok ? `${spec.clipCount} 片段 · ${spec.totalSeconds}s` : '规格无效';
      if (rtCustomHint) rtCustomHint.textContent = !ok ? '—' : (hit ? '改任一项即自定义' : `${spec.clipCount} 个 ${spec.clipSeconds}s 片段`);
      rtBox.querySelectorAll('[data-rt-preset]').forEach((b) => {
        const on = b.dataset.rtPreset === hit;
        b.classList.toggle('selected', on);
        b.setAttribute('aria-checked', String(on));
      });
      rtCustom?.classList.toggle('selected', !hit);
      if (rtSave) {
        const dirty = JSON.stringify(readRt()) !== rtBaseline;
        rtSave.classList.toggle('dirty', dirty);
        rtSave.title = dirty ? '规格已改动，尚未保存' : '规格与已保存值一致';
      }
      if (rtNote) {
        rtNote.textContent = FILM_POLICY_OPTIONS.find((p) => p.id === raw.filmPolicy)?.note || '';
        rtNote.classList.toggle('warn', raw.filmPolicy === 'preview');
      }
    };

    rtBox.querySelectorAll('[data-rt-preset]').forEach((b) => b.addEventListener('click', () => {
      const preset = RUNTIME_PRESETS.find((p) => p.id === b.dataset.rtPreset);
      if (!preset) return;
      // 点预设 = 把两条时长填好并选中，用户可继续微调或直接保存
      if (rtTotal) rtTotal.value = String(preset.totalSeconds);
      if (rtClip) rtClip.value = String(preset.clipSeconds);
      if (rtClipAny) rtClipAny.value = String(preset.clipSeconds);
      syncRt();
    }));
    [rtTotal, rtFps, rtPolicy, rtRes].forEach((el) => {
      el?.addEventListener('input', syncRt);
      el?.addEventListener('change', syncRt);
    });
    rtClip?.addEventListener('change', syncRt);
    rtClipAny?.addEventListener('input', syncRt);
    syncRt();

    rtBox.querySelector('[data-rt="save"]')?.addEventListener('click', async (e2) => {
      const btn = e2.currentTarget;
      const raw = readRt();
      const spec = previewRuntimeSpec(raw);
      // 只提交合法字段：分辨率串由预览归一（非法档位会回落画幅默认档）
      const payload = {
        totalSeconds: raw.totalSeconds,
        clipSeconds: raw.clipSeconds,
        fps: Number.isFinite(Number(raw.fps)) && Number(raw.fps) > 0 ? Number(raw.fps) : undefined,
        resolution: spec.resolution,
        filmPolicy: raw.filmPolicy,
      };
      if (!(payload.totalSeconds > 0) || !(payload.clipSeconds > 0)) {
        toast('总时长与每片段时长都必须是正数', 'err');
        return;
      }
      btn.disabled = true;
      try { await ctx.onSaveRuntime?.(payload); }
      catch (err) { toast(err.message, 'err'); btn.disabled = false; }
    });
  }
  host.querySelectorAll('[data-dir="pack"]').forEach((b) => b.addEventListener('click', () => ctx.onDownloadPack?.()));
  host.querySelectorAll('[data-dir="scroll-top"]').forEach((b) => b.addEventListener('click', () => gotoStep('basic')));

  // ⑥ 交付
  host.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('change', () => {
    manage('deliverables', { [el.dataset.del]: el.checked });
  }));
  host.querySelectorAll('[data-act="dl-film"]').forEach((b) => b.addEventListener('click', () => { window.location.href = `/api/projects/${p.id}/film`; }));
  host.querySelectorAll('[data-act="dl-pack"]').forEach((b) => b.addEventListener('click', () => ctx.onDownloadPack?.()));
  // ⑦ 成片时间线：点任意一格 → 主播放器切换到该镜头片段并按当前倍速播放（逐镜核对）；⟶第⑥步按钮跳转
  host.querySelectorAll('.pvf-cell[data-clip]').forEach((cell) => cell.addEventListener('click', () => {
    const src = cell.dataset.clip;
    if (!src) return;
    const video = host.querySelector('.pvf-video');
    if (!video) { toast('成片还没生成：先执行第⑦步拼出 MP4', 'err'); return; }
    video.src = src;
    video.playbackRate = ui.filmRate || 1;
    video.play().catch(() => { /* 自动播放被拦截时保持手动播放 */ });
    video.scrollIntoView({ behavior: 'smooth', block: 'center' });
    host.querySelectorAll('.pvf-cell.on').forEach((el) => el.classList.remove('on'));
    cell.classList.add('on');
  }));
  // 倍速播放：作用于成片与跳播的单镜片段；选中态记进 ui，重绘后不丢
  const filmVideo = host.querySelector('.pvf-video');
  if (filmVideo && ui.filmRate !== 1) filmVideo.playbackRate = ui.filmRate;
  host.querySelectorAll('.pvf-rate[data-rate]').forEach((btn) => btn.addEventListener('click', () => {
    const rate = Number(btn.dataset.rate) || 1;
    ui.filmRate = rate;
    const video = host.querySelector('.pvf-video');
    if (video) video.playbackRate = rate;
    host.querySelectorAll('.pvf-rate').forEach((b) => b.classList.toggle('on', Number(b.dataset.rate) === rate));
  }));
  q('[data-act="goto-storyboard"]')?.addEventListener('click', () => gotoStep('storyboard'));
  mountModelPickers();
}

/** 首页流程卡片「进入这一步」：切到工作台并定位对应步骤操作台 */
export function setWorkshopStep(id) {
  if (!id) return;
  ui.stepId = id;
  ui.scrollTo = id;
  // 已有原著的项目默认收起上传表单；从流程卡进来时直接展开，保证「进入这一步」即可操作
  if (id === 'upload') ui.upload.open = true;
}

/**
 * SSE「director:progress」：只改进度文案 / 宽度 / 按钮态，不重建 DOM。
 * 全流程约 20 秒，期间 project:meta 会多次触发重绘，ui.director.progress 保证进度不丢。
 */
export function setDirectorProgress(host, e = {}) {
  const total = Number(e.total) || 0;
  const index = Number(e.index) || 0;
  let ratio = Number(e.percent);
  if (!Number.isFinite(ratio)) ratio = e.phase === 'done' ? 1 : total ? index / total : 0;
  const percent = Math.max(0, Math.min(1, ratio));
  ui.director.progress = { phase: e.phase, label: e.label || '', percent, status: e.status };
  if (!host) return;
  const pct = Math.round(percent * 100);
  const box = host.querySelector('[data-dir-progress]');
  if (box) {
    box.classList.add('show');
    const bar = box.querySelector('.dir-progress-bar i');
    if (bar) bar.style.width = `${pct}%`;
    const msg = box.querySelector('[data-dir-msg]');
    if (msg) msg.textContent = e.label || '';
    const num = box.querySelector('[data-dir-pct]');
    if (num) num.textContent = `${pct}%`;
    box.classList.toggle('done', e.phase === 'done');
    box.classList.toggle('error', e.status === 'error' || e.status === 'blocked');
  }
  const running = e.phase !== 'done' && !['blocked', 'error'].includes(e.status);
  host.querySelectorAll('[data-dir="run"], [data-dir="rerun"], [data-dir="skill"]').forEach((b) => { b.disabled = running; });
  const runBtn = host.querySelector('[data-dir="run"]');
  if (runBtn) runBtn.textContent = running ? '⏳ 导演智能体执行中…' : '▶ 一键完成最终产物全流程';
}
