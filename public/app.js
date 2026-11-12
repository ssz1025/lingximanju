// 应用状态机：API、SSE、UI 绑定、快捷键与业务流程
import { CanvasController } from './canvas.js';
import { NODE_TYPES, PALETTE_ORDER, typeOf, STATUS_LABEL } from './nodes.js';
import * as UI from './panels.js';
import { openLinkPicker, closeLinkPicker, isLinkPickerOpen } from './link-picker.js';
import { openAssetLibrary } from './asset-manager.js';
import { openAIChat } from './chat-hub.js';
import * as AIChat from './chat-hub.js';
import { openCreationWizard } from './wizard.js';
import * as PM from './project-manager.js';
import * as PV from './project-view.js';
import * as HV from './home-view.js';
import * as EV from './episode-view.js';
import * as SC from './startup-check.js';
import * as PS from './project-sidebar.js';
import * as SV from './source-view.js';
import * as PMODEL from './project-model.js';
import * as CC from './canvas-compose.js';
import { ensureModelPicker, withModelId, setModelProjectScope } from './model-picker.js';
import { setInterfaceProjectScope } from './interface-picker.js';
import { hasOpenPage, closeTopPage, closeAllPages } from './page.js';
import { $, escapeHTML } from './utils.js';
import { EMPTY_CANVAS_PROJECT, groupScopeOptions, scopeOptionsSignature, scopeHint, isScopeReadOnly } from './canvas-scope.js';

const state = {
  project: null, projects: [], templates: [], agents: [], selected: [],
  running: false, logs: [], movedByUser: false, nodeCountBeforeRun: 0,
  steps: [], stats: {}, projectStats: {}, stepBusy: false,
  liveTokens: null,   // 本次运行的实时 token 计数（llm:usage 事件驱动，落库后清空）
  directorSkills: [], // /api/bootstrap 的导演 Agent 技能清单（4 流程 + 10 风格）
  directorSkillGroups: [], // 技能分组元数据：顺序与说明由后端下发，前端不硬编码
  directorPlan: null, // 项目级运行计划（/director/skills 快照）
  directorBusy: false,// 导演智能体全流程执行中（禁用工作台其它执行入口）
  runtimeDefaults: null, // /api/bootstrap 的短剧成片规格默认值（30s / 3s / 10 片段）
  // 'home' 项目列表页（落地页） | 'workshop' 项目工作台 | 'canvas' 无限画布 | 'episode' 剧集详情
  view: 'home',
  settings: null,     // 应用级模型配置摘要（/api/bootstrap → settings）
  comfy: null,        // 本地 ComfyUI 配置摘要（含工作流是否导入）
  api: null,          // 服务端 API 能力清单（识别「改了代码但没重启」的旧进程）
  recentId: null,
  episodeNo: null,
  // 画布范围：'overall' 全部组合画布 | 'main' 项目主画布 | 'ep:<no>' 某一集独立画布
  canvasScope: 'overall',
  overallGraph: null,   // 组合图只在内存里，由各集画布实时派生，不落盘
  sourceView: null,     // GET /api/projects/:id/source 的统计与原文（按项目缓存）
  assetIndex: [],       // /api/assets 索引，工作台「资源」Tab 与侧栏共用
  workshopTab: 'overview',
};
let appliedScopeKey = '';
let saveTimer = null;
let renderScheduled = false;
let inspectorScheduled = false;
let bigGraphHinted = false;
let homeRefreshTimer = null;
let episodeRefreshTimer = null;
let sidebarRefreshTimer = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`响应不是 JSON：${text.slice(0, 80)}`); }
  // 后端错误有两种形状：路由层用 { error }，管理动作用 { ok:false, message }。
  // 只认 error 会让「北野武没有主色调 bamboo-green，可选：…」这类最有用的提示变成光秃秃的 HTTP 400。
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
  return data;
}

/* ---------------- 画布实例 ---------------- */
const canvas = new CanvasController({
  onChange: (reason) => {
    if (!['undo', 'redo'].includes(reason)) state.movedByUser = true;
    // 组合总览是派生视图，拖动节点只改内存图，不应触发整份项目 JSON 写回
    if (state.canvasScope !== 'overall') persist();
    updateStats();
  },
  onSelect: (ids) => { state.selected = ids; scheduleInspector(); },
  onContextMenu: (id, x, y) => openContextMenu(id, x, y),
  onDblClick: (id) => {
    // 组合总览里的节点双击 → 直接跳到它所属的那一集独立画布
    if (state.canvasScope === 'overall') {
      const node = state.overallGraph?.nodes.find((n) => n.id === id);
      const ref = node?.data?.scopeRef;
      if (ref?.kind === 'episode' && ref.no) { openEpisodeCanvas(ref.no, node.data.sourceNodeId); return; }
      if (ref?.kind === 'season') { openWorkshopTab('episodes'); return; }
    }
    switchInspector('props'); canvas.select([id]);
  },
  onViewport: () => {},
  onConnectDrop: (info) => {
    if (!info.overCanvas || !state.project) return;
    // 修饰键保留原来的「直接连 anchor / ref」快捷操作
    if (info.to && (info.altKey || info.shiftKey)) {
      canvas.addEdge(info.from, info.to, info.altKey ? 'anchor' : 'ref');
      return;
    }
    if (info.to) showRelationPicker(info);
    else showNextNodePicker(info);
  },
});

/* ---------------- 拖拽后的连线选择器 ---------------- */
// 参照 ViMax 流水线（event→scene→shot→关键帧→择优→视频→成片）给出的后继推荐
const NEXT_TYPES = {
  idea: ['script', 'rag', 'plan', 'character', 'note'],
  script: ['plan', 'rag', 'event', 'character', 'note'],
  rag: ['plan', 'script', 'note'],
  plan: ['event', 'scene', 'character', 'camera'],
  event: ['scene', 'shot', 'character', 'camera'],
  scene: ['shot', 'camera', 'character', 'keyframe'],
  shot: ['keyframe', 'review', 'camera', 'character', 'transition'],
  character: ['keyframe', 'shot', 'camera'],
  camera: ['keyframe', 'transition', 'shot'],
  keyframe: ['review', 'video', 'transition', 'camera'],
  review: ['video', 'transition', 'keyframe'],
  video: ['transition', 'final', 'review'],
  transition: ['final', 'video', 'review'],
  final: ['note', 'video'],
  note: ['idea', 'script', 'note'],
};
const DEFAULT_NEXT = ['script', 'plan', 'shot', 'keyframe', 'video', 'final', 'note'];

/** 节点类型 → 选择器条目（选中即新建） */
function typeItems(keys, badge = '新建') {
  return keys.filter((k) => NODE_TYPES[k]).map((k) => {
    const t = NODE_TYPES[k];
    return { id: `type:${k}`, icon: t.icon, label: t.label, hint: t.group, color: t.color,
      badge, keywords: `${k} ${t.agent || ''}`, type: k };
  });
}

/** 画布已有节点 → 选择器条目（选中即连线）；已连接的标为不可选，按离落点距离排序 */
function nodeItems(excludeId, badge = '连接', origin = null) {
  const nodes = (state.project?.nodes || []).filter((n) => n.id !== excludeId);
  const linked = new Set((state.project?.edges || []).filter((e) => e.from === excludeId).map((e) => e.to));
  const items = nodes.map((n) => {
    const t = typeOf(n.type);
    const already = linked.has(n.id);
    return { id: `node:${n.id}`, icon: t.icon, label: n.title || t.label,
      hint: already ? '已连接' : t.label, color: t.color, badge: already ? '已连接' : badge,
      disabled: already, keywords: `${n.type} ${n.id}`, nodeId: n.id,
      _x: n.x || 0, _y: n.y || 0 };
  });
  if (origin) {
    const dist = (it) => (it._x - origin.x) ** 2 + (it._y - origin.y) ** 2;
    items.sort((a, b) => Number(!!a.disabled) - Number(!!b.disabled) || dist(a) - dist(b));
  }
  return items;
}

/** 端口拖线松手在空白处：选下一个节点，选完立即创建并连接 */
function showNextNodePicker(info) {
  const from = (state.project?.nodes || []).find((n) => n.id === info.from);
  if (!from) return;
  const recommended = (NEXT_TYPES[from.type] || DEFAULT_NEXT).slice(0, 6);
  const existing = nodeItems(info.from, '连接', info.world);
  const groups = [
    { key: 'recommend', label: '推荐后继', hint: '新建并自动连接', items: typeItems(recommended, '推荐') },
    { key: 'all', label: '全部节点类型', hint: '新建节点', items: typeItems(PALETTE_ORDER, '新建') },
    ...(existing.length ? [{
      key: 'existing', label: '画布上已有节点', items: existing, limit: 8,
      hint: existing.length > 8 ? `最近 8 / 共 ${existing.length}` : '直接连到该节点',
    }] : []),
  ];
  openLinkPicker({
    x: info.clientX, y: info.clientY,
    title: '选择下一个节点',
    subtitle: `从「${from.title}」拖出 · 选择后立即建立连线`,
    groups,
    onPick: (item) => {
      if (item.type) {
        const node = canvas.addNodeAt(item.type, Math.round(info.world.x - 134), Math.round(info.world.y - 60));
        canvas.addEdge(info.from, node.id, 'flow');
        canvas.select([node.id]);
        UI.toast(`已新建「${item.label}」并连接到「${from.title}」`, 'ok');
      } else if (item.nodeId) {
        const edge = canvas.addEdge(info.from, item.nodeId, 'flow');
        canvas.select([item.nodeId]);
        UI.toast(edge ? `已连接到「${item.label}」` : '连线已存在', edge ? 'ok' : 'err');
      }
    },
  });
}

/** 端口拖线松手在已有节点上：先选连接关系，选完立即连线 */
function showRelationPicker(info) {
  const from = (state.project?.nodes || []).find((n) => n.id === info.from);
  const to = (state.project?.nodes || []).find((n) => n.id === info.to);
  if (!from || !to) return;
  const kinds = [
    { key: 'flow', icon: '→', label: '流程依赖', hint: '默认 · DAG 执行顺序', color: '#8b9bff', badge: 'Enter' },
    { key: 'anchor', icon: '⌖', label: '空间锚点', hint: '转场 / 机位一致性', color: '#fbbf24' },
    { key: 'ref', icon: '⧉', label: '资产引用', hint: '角色 / 关键帧引用', color: '#34d399' },
  ];
  openLinkPicker({
    x: info.clientX, y: info.clientY,
    title: `连接到「${to.title}」`,
    subtitle: `从「${from.title}」拖出 · 选择连线类型后直接链接`,
    placeholder: '搜索连接关系…',
    groups: [{
      key: 'kind', label: '连接关系',
      items: kinds.map((k) => ({ id: `kind:${k.key}`, icon: k.icon, label: k.label, hint: k.hint,
        color: k.color, badge: k.badge, keywords: `${k.key} ${k.label}`, kind: k.key })),
    }],
    onPick: (item) => {
      const edge = canvas.addEdge(info.from, info.to, item.kind);
      canvas.select([info.to]);
      UI.toast(edge ? `已建立${item.label}连线` : '连线已存在', edge ? 'ok' : 'err');
    },
  });
}

/** 从左侧节点库拖入画布后：可选地把新节点接到某个已有节点之后 */
function showAttachPicker(node, clientX, clientY, origin) {
  const items = nodeItems(node.id, '上游', origin);
  if (!items.length) return;
  openLinkPicker({
    x: clientX, y: clientY,
    title: '连接到已有节点',
    subtitle: `「${node.title}」将接在所选节点之后 · 按 Esc 可跳过`,
    placeholder: '搜索已有节点…',
    groups: [{ key: 'existing', label: '画布上已有节点', items, limit: 8,
      hint: items.length > 8 ? `最近 8 / 共 ${items.length}` : '所选 → 新节点' }],
    onPick: (item) => {
      const edge = canvas.addEdge(item.nodeId, node.id, 'flow');
      canvas.select([node.id]);
      UI.toast(edge ? `已把「${node.title}」接到「${item.label}」之后` : '连线已存在', 'ok');
    },
  });
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => { renderScheduled = false; canvas.render(); updateStats(); });
}
function scheduleInspector() {
  if (inspectorScheduled) return;
  inspectorScheduled = true;
  requestAnimationFrame(() => { inspectorScheduled = false; renderInspector(); });
}

function persist(immediate = false) {
  if (!state.project || state.running) return;
  clearTimeout(saveTimer);
  const run = () => {
    saveTimer = null;
    if (!state.project || state.running) return;
    api(`/api/projects/${state.project.id}`, { method: 'PUT', body: JSON.stringify(state.project) })
      .catch((e) => UI.toast(`保存失败：${e.message}`, 'err'));
  };
  if (immediate) run(); else saveTimer = setTimeout(run, 420);
}

/* ---------------- SSE ---------------- */
function initSSE() {
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch { return; }
    handleEvent(e);
  };
  es.onerror = () => { /* EventSource 自动重连 */ };
}

function handleEvent(e) {
  if (e.type === 'hello') return;
  if (e.type === 'state' && e.reason === 'created') {
    refreshProjects().then(() => renderHomeView()).catch(() => {});
    return;
  }
  // 落地页没有打开任何项目：项目元数据变化也要刷新列表（合并成一次防抖请求）
  if (state.view === 'home' && ['state', 'project:meta', 'episode:update'].includes(e.type)) scheduleHomeRefresh();

  const p = state.project;
  if (!p || (e.projectId && e.projectId !== p.id)) return;

  // 剧集域产物（剧本 / 宫格图 / 角色 / 导演包 / 视频）落盘：静默刷新详情页，不打断当前标签页
  if (e.type === 'episode:update') {
    scheduleEpisodeRefresh();
    scheduleSidebarRefresh();   // 剧集产物落盘：项目侧栏的资源列表同步出现新图 / 新视频
    if (state.view === 'workshop') renderProjectView();
    if (state.view === 'home') renderHomeView();
    return;
  }
  if (e.type === 'episode:progress') {
    const box = $('log-stream');
    if (box) {
      box.className = 'log-stream lv-info';
      box.textContent = `剧集剧本生成 ${e.done}/${e.total} · 第 ${e.episodeNo || '?'} 集`;
    }
    scheduleEpisodeRefresh();
    return;
  }
  if (e.type === 'character:batch') {
    // 逐张进度直接驱动工作台第④步的任务角色卡（缩略图 + 进度 + 状态），不再只写日志框
    PV.applyPortraitEvent(e);
    const box = $('log-stream');
    if (e.status === 'running' && box) {
      box.className = 'log-stream lv-info';
      box.textContent = `角色定妆图 ${Number(e.done) + 1}/${e.total} · ${e.name || ''} · ${e.label || e.view || ''}`;
    }
    // 逐张落盘：防抖后重扫项目资源，定妆图会实时出现在左侧资源列表
    scheduleSidebarRefresh();
    return;
  }
  if (e.type === 'character:job') {
    PV.applyPortraitJob(e.job);
    if (e.job && e.job.status !== 'running') {
      // 工作台里由任务卡统一播报（带可进视频/失败明细）；不在工作台时才在这里提示
      if (state.view !== 'workshop') {
        UI.toast(e.job.status === 'done'
          ? `角色图生成完成：${e.job.generated} 张真实出图`
          : `角色图任务结束：${e.job.message || e.job.error || ''}`,
        e.job.status === 'done' ? 'ok' : 'warn');
      }
      scheduleEpisodeRefresh();
      scheduleSidebarRefresh();
    }
    return;
  }

  // 导演智能体阶段进度：只更新工作台文案 / 进度条，不重建 DOM（全流程约 20s）
  if (e.type === 'director:progress') {
    if (state.view === 'workshop') PV.setDirectorProgress($('project-view'), e);
    const box = $('log-stream');
    if (box) {
      box.className = `log-stream ${['error', 'blocked'].includes(e.status) ? 'lv-error' : 'lv-info'}`;
      box.textContent = `导演智能体 · ${e.label || e.phase || ''}`;
    }
    if (e.status === 'blocked') UI.toast(e.label || '导演智能体被前置条件阻断', 'err');
    return;
  }

  // 项目管理层广播：六步状态、统计与进度，驱动步骤面板 / 侧栏 / 顶栏同步刷新
  if (e.type === 'project:meta') {
    p.management = e.management;
    // 服务端随事件附带的实时最终产物验收：第⑦步面板显示「当前状态」而不是历史快照
    if (e.verification) p.verification = e.verification;
    // e.stats 是「单个项目」的统计；state.stats 是侧栏用的「全部项目」统计，二者不能混用
    if (e.stats) state.projectStats = e.stats;
    state.liveTokens = null;   // 步骤落库后以持久化数据为准，清实时计数
    renderStepPanel(); renderCanvasStepBar(); updateHeader(); scheduleSidebarRefresh();
    renderCanvasTools();  // 节点图生长后，本项目节点 / 智能体统计同步更新
    renderProjectView();
    scheduleEpisodeRefresh();  // 角色 / 分集等管理动作后，剧集详情里的出场名单同步刷新
    return;
  }

  // 单次 LLM 调用的 token 用量：实时累加展示（步骤完成后由 project:meta 的持久化数据接管）
  if (e.type === 'llm:usage') {
    state.liveTokens = e.tokens ? { ...e.tokens, estimated: !!e.estimated } : null;
    updateRunUI();
    renderStepPanel();
    return;
  }

  switch (e.type) {
    case 'run:start':
      state.running = true; state.nodeCountBeforeRun = p.nodes.length;
      state.liveTokens = null;
      state.logs = []; updateRunUI();
      UI.toast('编排已启动，画布会随智能体执行自动生长', 'ok');
      break;
    case 'node:status': {
      const n = p.nodes.find((x) => x.id === e.nodeId);
      if (!n) break;
      n.status = e.status;
      if (e.progress !== undefined) n.progress = e.progress;
      if (e.error) n.error = e.error;
      // 排队 / 开始 / 完成时间随事件下发：第⑥步「任务状态」看板据此显示已排队多久、已用多久，
      // 不落盘的话刷新页面就只剩一个没有时间基准的「生成中」。
      if (e.queuedAt || e.startedAt || e.finishedAt || e.durationMs !== undefined) {
        n.meta = { ...(n.meta || {}) };
        if (e.queuedAt) n.meta.queuedAt = e.queuedAt;
        if (e.startedAt) n.meta.startedAt = e.startedAt;
        if (e.finishedAt) n.meta.finishedAt = e.finishedAt;
        if (e.durationMs !== undefined) n.meta.durationMs = e.durationMs;
      }
      // prompt_id / 提交时间等运行痕迹：看板要显示「发出去的是哪一条」，
      // 对账时也靠它去 ComfyUI 历史里把结果认回来
      if (e.meta && typeof e.meta === 'object') n.meta = { ...(n.meta || {}), ...e.meta };
      canvas.updateNode(n.id);
      if (state.selected.includes(n.id)) scheduleInspector();
      if (state.view === 'workshop') PV.refreshTaskPanel?.();
      break;
    }
    case 'node:data': {
      const n = p.nodes.find((x) => x.id === e.nodeId);
      if (!n) break;
      if (e.data) n.data = e.data;
      if (e.patch) {
        const { __title, ...rest } = e.patch;
        if (__title !== undefined) n.title = __title;
        n.data = { ...(n.data || {}), ...rest };
      }
      canvas.updateNode(n.id);
      if (state.selected.includes(n.id)) scheduleInspector();
      if (state.view === 'workshop') PV.refreshTaskPanel?.();
      break;
    }
    case 'node:add':
      if (!p.nodes.some((n) => n.id === e.node.id)) { p.nodes.push(e.node); scheduleRender(); }
      break;
    case 'edge:add':
      if (!p.edges.some((x) => x.id === e.edge.id)) { p.edges.push(e.edge); canvas.scheduleEdges(); }
      break;
    case 'log': {
      state.logs.push(e);
      if (state.logs.length > 300) state.logs.shift();
      const stream = $('log-stream');
      stream.className = `log-stream lv-${e.level || 'info'}`;
      stream.textContent = `${e.agent ? `[${e.agent}] ` : ''}${e.message}`;
      stream.title = state.logs.slice(-12).map((x) => x.message).join('\n');
      break;
    }
    case 'production:chat':
      // 制片助手的后台任务：结果已写进会话记录，由统一面板重新拉取
      AIChat.onServerEvent?.(e);
      break;
    case 'state': {
      if (!e.project) break;
      state.project = e.project;
      // 保持当前画布范围（全部组合 / 主画布 / 单集），不要被全量状态回灌悄悄切走
      syncCanvasScope({ keepViewport: e.reason !== 'template' });
      if (e.reason === 'template') { canvas.fitView(); UI.toast('已应用流水线模板', 'ok'); }
      if (e.reason === 'arrange') UI.toast('画布已按依赖拓扑整理', 'ok');
      if (['storyboard'].includes(e.reason)) UI.toast('Agent 已在画布上生成镜头链', 'ok');
      renderInspector(); updateStats(); updateHeader();
      renderStepPanel(); renderCanvasStepBar();
      renderProjectView();
      scheduleEpisodeRefresh();  // 项目全量状态广播时也带上剧集详情，避免原文 / 剧本 / 产物过期
      break;
    }
    case 'run:done':
    case 'run:error':
      state.running = false;
      state.liveTokens = null;
      updateRunUI();
      if (e.type === 'run:error' && e.status !== 'cancelled') UI.toast(e.message || '运行异常结束', 'err');
      else if (e.status === 'cancelled') UI.toast('运行已取消，已完成节点保留');
      else {
        const s = e.summary || {};
        const tk = s.tokens?.total;
        const tokNote = tk ? ` · ${(tk >= 1000 ? (tk / 1000).toFixed(1) + 'k' : tk)} tokens` : '';
        UI.toast(`编排完成 · ${s.nodeCount || 0} 节点 · ${s.waves || 0} 波 · ${((s.durationMs || 0) / 1000).toFixed(1)}s${tokNote}`, 'ok');
      }
      syncProject().then(() => {
        if (!state.movedByUser && state.project && state.project.nodes.length > state.nodeCountBeforeRun + 6) {
          arrange(true);
        } else canvas.fitView();
      });
      break;
    default: break;
  }
}

/** 项目列表页的 SSE 刷新：合并连续事件，避免每次广播都打一次 /api/bootstrap */
function scheduleHomeRefresh() {
  if (state.view !== 'home') return;
  clearTimeout(homeRefreshTimer);
  homeRefreshTimer = setTimeout(() => {
    refreshProjects().then(() => renderHomeView()).catch(() => {});
  }, 260);
}

/** 剧集详情页的 SSE 刷新：静默重拉详情，保留当前标签页与滚动上下文 */
function scheduleEpisodeRefresh() {
  if (state.view !== 'episode') return;
  clearTimeout(episodeRefreshTimer);
  episodeRefreshTimer = setTimeout(() => EV.refreshEpisodeView(), 180);
}

/** 产物落盘后的项目侧栏刷新：防抖合批，强制重取资产索引，进度与资源一起更新 */
function scheduleSidebarRefresh() {
  if (state.view === 'home' || !state.project) return;
  clearTimeout(sidebarRefreshTimer);
  sidebarRefreshTimer = setTimeout(() => {
    if (state.view === 'home' || !state.project) return;
    PS.invalidateAssets();
    refreshProjectSidebar({ forceAssets: true });
  }, 260);
}

async function syncProject() {
  if (!state.project) return;
  const fresh = await api(`/api/projects/${state.project.id}`);
  state.project = fresh;
  syncCanvasScope({ keepViewport: true });
  updateStats(); renderInspector(); updateHeader();
  // 任何项目刷新都同步步骤面板，避免顶栏进度与六步卡状态出现短暂不一致
  renderStepPanel(); renderCanvasStepBar();
  renderProjectView();
}

/* ---------------- 渲染 ---------------- */
function stepVisual() {
  const m = state.project?.management;
  const steps = m?.steps || [];
  const total = state.steps.length || 6;
  const done = steps.filter((s) => s.status === 'done').length;
  const running = steps.some((s) => s.status === 'running');
  const failed = steps.some((s) => s.status === 'error');
  const current = steps.find((s) => s.status === 'running') || steps.find((s) => s.status === 'pending');
  const overall = failed ? 'error' : running ? 'running' : (m?.kind === 'novel' && done === total) ? 'done' : 'draft';
  return { isNovel: m?.kind === 'novel', steps, total, done, running, failed, current, overall,
    percent: total ? Math.round(done / total * 100) : 0 };
}

/** 顶栏项目封面：与侧栏项目卡同源（自定义封面 / 名称首字兜底） */
function paintProjectCover(p) {
  const el = $('project-cover');
  if (!el) return;
  if (!p) { el.hidden = true; el.innerHTML = ''; return; }
  const url = p.management?.cover?.url;
  el.hidden = false;
  el.innerHTML = url
    ? `<img src="${escapeHTML(url)}" alt="">`
    : `<i>${escapeHTML(String(p.name || '?')[0])}</i>`;
}

function updateHeader() {
  const p = state.project;
  $('btn-close-project').hidden = !p || state.view === 'home';
  if (!p) {
    // 项目列表页 / 未打开项目：清掉顶栏里的项目态控件，避免残留上一个项目的信息
    $('project-name').value = '';
    $('project-mode').textContent = '';
    $('step-chip').hidden = true;
    $('top-progress').hidden = true;
    $('btn-step-run').hidden = true;
    $('stat-provider').textContent = '—';
    paintProjectCover(null);
    return;
  }
  $('project-name').value = p.name;
  paintProjectCover(p);
  $('project-mode').textContent = (state.templates.find((t) => t.id === p.mode)?.name) || p.mode || '';
  const c = state.comfy || {};
  const backend = c.imageWorkflow || c.videoWorkflow ? '本地 ComfyUI' : 'Mock 自绘';
  $('stat-provider').textContent = `本项目 · ${p.settings?.provider === 'openai' ? 'openai' : 'mock'} + ${backend}`;

  // 明确的视觉提示：状态胶囊 + 顶部进度条 + 下一步按钮 + 画布步骤导航条
  const v = stepVisual();
  const chip = $('step-chip');
  chip.hidden = !v.isNovel;
  chip.className = `step-chip st-${v.overall}`;
  $('step-chip-text').textContent = v.isNovel
    ? `${v.done}/${v.total} 步 · ${v.failed ? '失败可重试' : v.running ? '执行中' : v.overall === 'done' ? '全部完成' : '待执行'}`
    : '';
  const bar = $('top-progress');
  bar.hidden = !v.isNovel;
  const fill = bar.querySelector('i');
  if (fill) fill.style.width = `${v.percent}%`;
  $('btn-step-run').hidden = !v.isNovel || v.overall === 'done' || state.stepBusy || scopeReadOnly();
  $('btn-step-run').textContent = state.stepBusy ? '执行中…' : `▶ 第 ${v.current?.no || v.total} 步`;
  $('canvas-hint').hidden = v.isNovel || scopeReadOnly(); // 步骤条占据画布顶部，避免两层提示重叠
}
function updateStats() {
  const p = state.project;
  if (!p) {
    // 项目关闭后不留上一个项目的计数（首页由 #stat-home 显示项目总数）
    $('stat-nodes').textContent = '—';
    $('stat-edges').textContent = '—';
    $('stat-provider').textContent = '—';
    $('stat-zoom').textContent = '';
    return;
  }
  // 画布视图里显示当前范围（组合 / 单集）的节点数，而不是永远显示主画布
  const g = state.view === 'canvas' && state.canvasScope !== 'main' ? (canvas.project || p) : p;
  $('stat-nodes').textContent = `${(g.nodes || []).length} 节点`;
  $('stat-edges').textContent = `${(g.edges || []).length} 连线`;
}
function updateRunUI() {
  $('btn-run').hidden = state.running || scopeReadOnly();
  $('btn-stop').hidden = !state.running || scopeReadOnly();
  const box = $('run-status');
  box.className = `run-status ${state.running ? 'running' : ''}`;
  const t = state.liveTokens;
  const tok = state.running && t?.total ? ` · ${(t.total >= 1000 ? (t.total / 1000).toFixed(1) + 'k' : t.total)} tok` : '';
  $('run-status-text').textContent = state.running ? `智能体运行中…${tok}` : '就绪';
}

/* ==========================================================================
 * 项目会话外壳：打开项目后，顶栏品牌 / 侧栏页脚 / 状态栏 / 资源库入口
 * 都切换成「当前项目」语境；关闭项目后恢复中性的项目列表语境。
 * ========================================================================*/
function updateChrome() {
  const info = PS.projectChrome(state.project, {
    view: state.view, episodeNo: state.episodeNo, projectCount: state.projects.length,
  });
  $('brand-title').textContent = info.brandTitle;
  $('brand-sub').textContent = info.brandSub;
  $('side-foot-text').textContent = info.foot;
  $('stat-home').hidden = info.inProject;
  $('stat-home').textContent = info.homeStatus;
  $('btn-asset-lib').title = info.assetLibTitle;
  $('btn-close-project').hidden = !info.inProject;
  // 浏览器标签、画布空态引导也只讲当前项目，避免残留应用级 / 上一个项目的文字
  document.title = info.title;
  const tip = $('canvas-empty-tip');
  if (tip) tip.textContent = info.inProject
    ? `「${state.project?.name || '本项目'}」还没有节点：从左侧「本项目画布节点」拖入一个，或应用一套模板。`
    : '从左侧节点库拖入一个节点，或应用一套流水线模板。';
}

/** 主题是应用外观偏好，项目会话内通过侧栏项目设置的小图标或 T 快捷键切换 */
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem('cc-theme', next);
}

/** 项目会话内所有资源库入口默认只看本项目；弹窗里仍可一键退出范围看全库 */
function openProjectAssetLibrary(opts = {}) {
  const scoped = !!state.project && state.view !== 'home';
  return openAssetLibrary({ ...opts, ...(scoped ? { project: state.project } : {}) });
}

/* ==========================================================================
 * 原著统计 / 资源索引 / 画布范围（全部组合 · 主画布 · 每集独立画布）
 * ========================================================================*/
/** 后端 GET /source 提供统计、惰性重建的章节与原文；断线时本地兜底不白屏 */
async function ensureSourceView(force = false) {
  const p = state.project;
  if (!p) { state.sourceView = null; return null; }
  if (!force && state.sourceView?.projectId === p.id) return state.sourceView;
  let d;
  try {
    d = await api(`/api/projects/${p.id}/source`);
  } catch {
    // 后端 GET /source 尚未重启 / 暂不可达：用前端等价实现兜底，章节与全文照常可读
    d = PMODEL.localSourceView(p);
  }
  state.sourceView = { ...d, projectId: p.id };
  return state.sourceView;
}

/** 资源索引由工作台「资源」Tab 与侧栏共用，避免两处各自请求 */
async function refreshAssetIndex(force = false) {
  if (!force && state.assetIndex.length) return state.assetIndex;
  try { const d = await api('/api/assets'); state.assetIndex = d.assets || []; }
  catch { state.assetIndex = []; }
  return state.assetIndex;
}

/** 当前范围对应的那份 { nodes, edges, viewport }；单集画布首次进入时播种并落盘 */
function activeCanvasGraph() {
  const p = state.project;
  if (!p) return EMPTY_CANVAS_PROJECT;
  const { kind, no } = PMODEL.parseScopeKey(state.canvasScope);
  if (kind === 'main') {
    // 工作台新生成的角色定妆图同步进主画布的角色资产节点（缩略图 + 计数）
    if (CC.syncMainCanvasCharacterAssets(p)) persist();
    return p;
  }
  if (kind === 'episode') {
    const ep = (p.management?.episodes || []).find((e) => Number(e.no) === no);
    if (!ep) { state.canvasScope = 'overall'; return composeGraph(); }
    // 每次绑定都做资源同步：新分镜板 / 角色定妆图自动补进画布并连线（幂等，无变化不落盘）
    const synced = CC.syncEpisodeCanvasResources(p, no);
    if (synced.changed) { ep.canvas = synced.canvas; persist(); }
    const graph = ep.canvas;
    if (!Array.isArray(graph.edges)) graph.edges = [];
    if (!graph.viewport) graph.viewport = { x: 40, y: 30, zoom: 0.72 };
    return graph;
  }
  return composeGraph();
}
function composeGraph() {
  state.overallGraph = CC.composeOverallCanvas(state.project);
  return state.overallGraph;
}

/**
 * 把画布控制器重新绑到当前范围。SSE 全量状态回灌时也走这里，
 * 否则会悄悄把范围重置成主画布；切换范围时必须清空撤销栈。
 */
function syncCanvasScope(opts = {}) {
  const p = state.project;
  const key = p ? state.canvasScope : '';
  const changed = appliedScopeKey !== key;
  const graph = p ? activeCanvasGraph() : EMPTY_CANVAS_PROJECT;
  canvas.setProject(graph, {
    keepViewport: !!opts.keepViewport && !changed,
    resetHistory: changed || !!opts.resetHistory,
  });
  appliedScopeKey = key;
  updateCanvasScopeUI();
  updateStats();
}

function setCanvasScope(key, opts = {}) {
  state.canvasScope = key || 'overall';
  syncCanvasScope({ keepViewport: false });
  if (opts.focusNodeId) {
    const node = canvas.project?.nodes.find((n) => n.id === opts.focusNodeId);
    if (node) { canvas.select([node.id]); canvas.focusNode(node.id); }
  }
}

function updateCanvasScopeUI() {
  const sel = $('canvas-scope');
  if (!sel) return;
  const p = state.project;
  const options = p ? CC.canvasScopeOptions(p) : [{ key: 'overall', label: '全部 · 组合画布', group: '总览' }];
  // 每季一个 optgroup：divider 之前是「总览」，之后是该季的所有集
  const grouped = groupScopeOptions(options);
  const sig = scopeOptionsSignature(p?.id, grouped);
  // SSE 会频繁全量回灌状态，选项没变就不要重建 <select>（否则会打断用户操作）
  if (sel.dataset.sig !== sig) {
    sel.innerHTML = grouped.map((g) => `<optgroup label="${escapeHTML(g.label)}">${g.items
      .map((o) => `<option value="${escapeHTML(o.key)}">${escapeHTML(o.label)}</option>`).join('')}</optgroup>`).join('');
    sel.dataset.sig = sig;
  }
  sel.value = state.canvasScope;
  if (sel.selectedIndex < 0) { state.canvasScope = 'overall'; sel.value = 'overall'; }
  const { kind } = PMODEL.parseScopeKey(state.canvasScope);
  const hint = $('canvas-scope-hint');
  if (hint) hint.textContent = scopeHint(kind, state.overallGraph?.stats?.episodeCount || 0);
  const bar = $('canvas-scopebar');
  if (bar) bar.hidden = !p || state.view !== 'canvas';
  // 组合总览是派生视图：运行 / 布局类动作统一避开它（按钮显隐看 scopeReadOnly）
  $('btn-arrange').title = kind === 'overall' ? '组合总览为派生视图，请切到主画布或单集画布' : '按依赖拓扑自动布局 (L)';
  updateRunUI();
  updateHeader();
}

/** 组合总览只读：禁止在这张派生图上跑流水线或改动主画布 */
function scopeReadOnly() {
  return isScopeReadOnly(state.project, state.view, state.canvasScope);
}

function openOverallCanvas() { setView('canvas'); setCanvasScope('overall'); }
function openEpisodeCanvas(no, focusNodeId) {
  setView('canvas');
  setCanvasScope(PMODEL.scopeKeyOf('episode', Number(no)), { focusNodeId });
}
function openWorkshopTab(tab) {
  setView('workshop');
  PV.setWorkshopTab(tab);
  renderProjectView();
}

/** 季 / 集调整只改 management，立刻落盘并刷新侧栏、工作台与组合图 */
function applySeasonMutation(fn, msg) {
  const p = state.project;
  if (!p) return;
  const m = p.management || (p.management = {});
  fn(m);
  m.updatedAt = Date.now();
  persist(true);
  refreshProjectSidebar();
  renderProjectView();
  if (state.view === 'canvas') syncCanvasScope({ keepViewport: true });
  renderCanvasTools();
  if (msg) UI.toast(msg, 'ok');
}

/**
 * 项目工作台唯一的用户退出入口。
 * 只有两处 UI 可以调用：顶栏右上角「#btn-close-project」与
 * 左侧「项目设置 → 退出项目」（project-sidebar.js 的 data-act="exit-project"）。
 * 其余曾经的出口（侧栏项目卡 ✕ / ⌂ 项目列表 / 剧集面包屑 / H 快捷键）全部移除，
 * 避免误触退出、也保证「关闭项目」这一动作只有一个可追踪的来源。
 * 项目被删除 / 被外部移除时的自动收尾直接调 closeProject({ silent: true })，
 * 那是内部清理，不属于用户出口。
 */
function requestExitProject() {
  if (!state.project || state.view === 'home') return undefined;
  const menu = $('more-menu');
  if (menu) menu.hidden = true;
  return closeProject();
}

/**
 * 关闭项目会话（不是简单切视图）：清空项目态 / 画布 / 项目级浮层 / 日志与对话，
 * 然后回到项目列表。用户出口统一经 requestExitProject() 进来，
 * 保证「关闭后返回项目列表」时页面不残留上一个项目的任何内容。
 */
async function closeProject(opts = {}) {
  const p = state.project;
  const closedId = p?.id || null;
  if (p) {
    state.recentId = p.id;               // 列表页的「继续」按钮指向刚关闭的项目
    // 有未落盘的画布 / 改名改动才立即写回；避免「打开→关闭」也写一次项目文件
    if (!state.running && saveTimer) persist(true);
  }
  clearTimeout(saveTimer); saveTimer = null;
  clearTimeout(homeRefreshTimer);
  clearTimeout(episodeRefreshTimer);
  clearTimeout(sidebarRefreshTimer);
  // 管理面板 / 资源库 / 封面 / 预览等浮层都绑定着旧项目，关闭时一并收起
  $('modal-root')?.replaceChildren();
  while (hasOpenPage()) closeTopPage();   // 页面宿主同样绑定旧项目，退出项目时全部收起
  setModelProjectScope('');               // 模型选择回到应用级默认，不带上一个项目的记忆
  setInterfaceProjectScope('');           // ComfyUI 接口选择同理，按项目分别记忆
  state.project = null;
  state.selected = [];
  state.episodeNo = null;
  state.running = false;
  state.stepBusy = false;
  state.liveTokens = null;
  state.logs = [];
  state.projectStats = {};
  state.canvasScope = 'overall';
  state.overallGraph = null;
  state.sourceView = null;
  state.assetIndex = [];
  state.workshopTab = 'overview';
  appliedScopeKey = '';
  $('more-menu').hidden = true;
  canvas.setProject(EMPTY_CANVAS_PROJECT);
  PS.invalidateAssets();
  refreshProjectSidebar();              // 项目侧栏清空
  renderCanvasTools();                  // 画布工具恢复中性文案，不带上一个项目的统计
  renderInspector(); renderStepPanel(); renderCanvasStepBar();
  const stream = $('log-stream');
  if (stream) { stream.className = 'log-stream'; stream.textContent = '项目列表 · 选择项目继续创作'; stream.title = ''; }
  setView('home');
  updateHeader(); updateStats(); updateRunUI(); updateChrome();
  try { await refreshProjects(); } catch { /* 后端暂不可达时保留缓存列表 */ }
  // /api/bootstrap 的 recent 只是列表首项；这里优先把「继续」指向刚关闭的项目
  if (closedId && state.projects.some((x) => x.id === closedId)) state.recentId = closedId;
  else if (!state.projects.some((x) => x.id === state.recentId)) state.recentId = state.projects[0]?.id || null;
  renderHomeView(); updateChrome();
  if (p && !opts.silent) UI.toast('项目已关闭 · 返回项目列表', 'ok');
}

/* ---------------- 项目侧栏：进入项目后左侧只服务当前项目 ---------------- */
/**
 * 侧栏所需回调全部在此组装：项目导航 / 资源库 / 管理面板 / 设置 / 封面 / 导出。
 * 项目列表、新建、导入不在项目内出现；退出只有「项目设置 → 退出项目」与顶栏右上角按钮。
 */
function projectSidebarCtx(opts = {}) {
  return {
    project: state.project, view: state.view, steps: state.steps,
    episodeNo: state.episodeNo, toast: UI.toast,
    forceAssets: !!opts.forceAssets,
    onExitProject: requestExitProject,
    onView: (v) => setView(v),
    onEpisode: (no) => openEpisode(no),
    onEpisodeCanvas: (no) => openEpisodeCanvas(no),
    onOverallCanvas: () => openOverallCanvas(),
    onWorkshopTab: (tab) => openWorkshopTab(tab),
    onManage: (tab) => { closeAllPages(); openManagePanel(tab); },
    onOpenAssets: () => { closeAllPages(); openProjectAssetLibrary({ mode: 'manage' }); },
    onRefreshAssets: async () => { await refreshAssetIndex(true); renderProjectView(); },
    onReupload: () => { PV.setWorkshopStep('upload'); openWorkshopTab('overview'); },
    onAssignSeason: (no, season) => applySeasonMutation((m) => {
      m.episodes = PMODEL.assignEpisodeSeason(m.episodes, no, season);
    }, `第 ${no} 集已移到第 ${season} 季`),
    onRenameSeason: (no, title) => applySeasonMutation((m) => {
      m.seasons = PMODEL.setSeasonTitle(m.seasons, no, title);
    }),
    onAddSeason: () => applySeasonMutation((m) => {
      const r = PMODEL.addSeason(m.seasons, PMODEL.seasonGroups(state.project));
      m.seasons = r.seasons;
    }, '已新增一季 · 在分集卡片里把集移进去'),
    onRemoveSeason: (no) => applySeasonMutation((m) => {
      const r = PMODEL.removeSeason(m.seasons, m.episodes, no);
      m.seasons = r.seasons; m.episodes = r.episodes;
    }, '该季已合并回第一季'),
    onSettings: () => { closeAllPages(); openSettingsDialog(); },
    onTheme: () => toggleTheme(),
    onHelp: () => { closeAllPages(); UI.openHelp(state.project); },
    onCover: () => {
      closeAllPages();
      openStepChatFor('cover');
    },
    onExport: () => { if (state.project) exportProjectJson(state.project.id); },
  };
}
function refreshProjectSidebar(opts = {}) {
  PS.renderProjectSidebar($('project-sidebar'), projectSidebarCtx(opts));
}

/** 六步任务面板 / 画布步骤条：两者的点击都回到同一套业务动作 */
function stepPanelCtx() {
  return {
    project: state.project, steps: state.steps, busy: state.stepBusy,
    liveTokens: state.liveTokens,
    onRunStep: (id, all) => runStep(id, all),
    onReset: (id) => resetSteps(id),
    onFocus: (id) => focusStepNodes(id),
    onManage: () => openManagePanel(),
    onCreate: () => openWizard(),
    // 分步对话：这一步聊过的内容、改了什么、花了多少 token 都在同一个面板里
    onChatStep: (stepId) => openStepChatFor(stepId),
    // 骨架项目第 ① 步：上传小说成功后刷新项目（节点注入 + ①② 完成）
    onSourceUploaded: async (out) => {
      UI.toast(out.message, 'ok');
      await refreshProjects();
      await loadProject(state.project.id);
      PM.setExpandedStep('episodes');
      renderStepPanel();
    },
    onNeedSource: () => UI.toast('先上传小说（①② 会自动完成），再执行后续步骤', 'err'),
  };
}
function renderStepPanel() { PM.renderStepPanel($('insp-steps'), stepPanelCtx()); }

/**
 * 打开统一 AI 对话面板（定位到某个档位）。
 * 全项目只有一个面板：重复打开只是切档位，不会叠出一堆对话页。
 * onChanged 里必须重新拉项目：对话可能改了创作设定 / 分集参数 / 重跑了某步，
 * 面板上的状态、token 账目与画布节点都会变，只刷 UI 不重拉会显示旧数据。
 */
function openStepChatFor(stepId, prefill = '') {
  if (!state.project) return;
  return openAIChat({
    projectId: state.project.id,
    projectName: state.project.name,
    scope: stepId,
    prefill,
    onChanged: async (d) => {
      await loadProject(state.project.id, { keepPages: true, view: state.view });
      renderStepPanel(); renderCanvasStepBar(); updateStats();
      if (d?.reran) {
        const rdef = (state.steps || []).find((s) => s.id === d.reran.stepId);
        UI.toast(`${rdef ? `第 ${rdef.no} 步` : '步骤'}已按你的要求重跑`, d.reran.ok ? 'ok' : 'err');
      }
    },
  });
}
function renderCanvasStepBar() {
  PM.renderCanvasStepBar($('canvas-stepbar'), {
    project: state.project, steps: state.steps,
    onJump: (id) => { PM.setExpandedStep(id); switchInspector('steps'); renderStepPanel(); focusStepNodes(id); },
  });
}

/**
 * 画布工具区（模板 / 节点库 / 智能体）：打开项目后也只讲当前项目——
 * 模板标注本项目当前模板，节点库显示本项目各类型节点数，智能体只列本项目在用的。
 */
function renderCanvasTools() {
  const p = state.project;
  const inProject = !!p;
  const stats = PS.collectToolStats(p, NODE_TYPES);
  const head = (listId, label, hint) => {
    const sec = $(listId).closest('.side-section')?.querySelector('.section-head');
    if (!sec) return;
    const spans = sec.querySelectorAll(':scope > span');
    if (spans[0]) spans[0].textContent = label;
    if (spans[1]) spans[1].textContent = hint;
    else {
      const s = document.createElement('span');
      s.className = 'section-hint';
      s.textContent = hint;
      sec.appendChild(s);
    }
  };
  head('template-list', inProject ? '本项目模板' : '流水线模板', inProject ? '点击应用到本项目' : '点击应用');
  head('node-palette', inProject ? '本项目画布节点' : '节点库', inProject ? `拖入本项目 · 共 ${stats.nodeCount} 个` : '拖入画布');
  head('agent-list', inProject ? '本项目智能体' : '智能体', '');

  $('template-list').innerHTML = state.templates.map((t) => {
    const badge = inProject && t.id === stats.templateId ? '当前' : t.badge;
    return `
    <div class="template-item" data-id="${t.id}">
      <span class="ti-icon">${t.icon}</span>
      <span><span class="ti-name">${escapeHTML(t.name)}${badge ? `<span class="badge">${escapeHTML(badge)}</span>` : ''}</span>
      <span class="ti-desc">${escapeHTML(t.description)}</span></span>
    </div>`;
  }).join('');
  $('template-list').querySelectorAll('.template-item').forEach((el) => {
    el.addEventListener('click', () => applyTemplate(el.dataset.id));
  });

  $('node-palette').innerHTML = PALETTE_ORDER.map((key) => {
    const t = NODE_TYPES[key];
    const n = stats.typeCount[key] || 0;
    return `<div class="palette-item" draggable="true" data-type="${key}" style="--nc:${t.color}" title="拖入${inProject ? '本项目画布' : '画布'}：${t.label}${n ? ` · 本项目已用 ${n} 个` : ''}"><span class="pl-dot"></span><span>${t.icon} ${t.label}${n ? `<em class="pl-count">${n}</em>` : ''}</span></div>`;
  }).join('');
  $('node-palette').querySelectorAll('.palette-item').forEach((el) => {
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', el.dataset.type); e.dataTransfer.effectAllowed = 'copy'; });
    el.addEventListener('dblclick', () => {
      const r = $('canvas-stage').getBoundingClientRect();
      const w = canvas.screenToWorld(r.left + r.width / 2 - 134, r.top + r.height / 2 - 70);
      canvas.addNodeAt(el.dataset.type, w.x, w.y);
    });
  });

  const used = inProject ? state.agents.filter((a) => stats.agentCount[a.id]) : state.agents;
  $('agent-count').textContent = inProject ? `${used.length} 个在用` : `${state.agents.length} 个`;
  $('agent-list').innerHTML = used.length
    ? used.map((a) => `
    <div class="agent-item" title="${escapeHTML(a.description || '')}" style="--ag:${a.color || '#8b9bff'}">
      <span class="ag-ico">${a.icon || '◇'}</span><span>${escapeHTML(a.label)}</span><span class="ag-grp">${inProject ? `${stats.agentCount[a.id] || 0} 节点` : escapeHTML(a.group || '')}</span>
    </div>`).join('')
    : (inProject ? '<div class="agent-empty">运行本项目流水线后，这里会列出用到的智能体</div>' : '');
}
function renderSidebar() {
  refreshProjectSidebar();
  renderCanvasTools();
}

/** 当前画布范围内可见的节点（单集 / 组合画布不再是 project.nodes） */
function activeNodeList() {
  if (state.view === 'canvas' && state.canvasScope !== 'main') return canvas.project?.nodes || [];
  return state.project?.nodes || [];
}
function renderInspector() {
  const p = state.project;
  const node = activeNodeList().find((n) => n.id === state.selected[0]) || null;
  UI.renderInspector(node, p, { onFieldChange, onAction });
}

/* ---------------- 业务动作 ---------------- */
/** /api/bootstrap 是列表页、步骤定义、模型配置的唯一数据源 */
function applyBootstrap(data) {
  state.projects = data.projects || [];
  state.templates = data.templates || [];
  state.agents = data.agents || [];
  if (Array.isArray(data.directorSkills)) state.directorSkills = data.directorSkills;
  if (Array.isArray(data.directorSkillGroups)) state.directorSkillGroups = data.directorSkillGroups;
  if (data.runtimeDefaults) state.runtimeDefaults = data.runtimeDefaults;
  state.comfy = data.comfy || state.comfy;
  PV.setComfySummary(state.comfy);   // 工作台第④步「一键生成全部角色图」按钮的可用态
  if (data.api) { state.api = data.api; PV.setApiInfo(data.api); }
  else { state.api = null; PV.setApiInfo(null); }   // 旧进程：明确按「能力缺失」处理，禁用生成并提示重启
  if (data.steps) state.steps = data.steps;
  if (data.stats) state.stats = data.stats;
  if (data.settings) state.settings = data.settings;
  if (data.recent) state.recentId = data.recent;
  updateConfigChip();
}
async function refreshProjects() {
  const data = await api('/api/bootstrap');
  applyBootstrap(data);
  renderSidebar();
  updateChrome();
  return data;
}
async function loadProject(id, opts = {}) {
  const p = await api(`/api/projects/${id}`);
  state.project = p; state.recentId = id;
  setModelProjectScope(p.id, p.name);    // 各 AI 入口的模型选择按项目分别记忆
  setInterfaceProjectScope(p.id, p.name); // 各生成入口的接口选择同样按项目分别记忆
  state.selected = []; state.movedByUser = false;
  state.sourceView = null; state.assetIndex = []; state.overallGraph = null;
  state.workshopTab = 'overview';
  appliedScopeKey = '';
  // 创作项目默认展示「全部组合画布」，标准流水线留在主画布
  state.canvasScope = p.management?.kind === 'novel' ? 'overall' : 'main';
  const savedViewport = p.viewport && Number.isFinite(p.viewport.zoom) && p.viewport.zoom > 0;
  syncCanvasScope({ keepViewport: true });
  updateHeader(); updateStats(); updateRunUI(); renderSidebar(); renderInspector();
  renderStepPanel(); renderCanvasStepBar();
  // 创作项目默认进入「项目工作台」（整个页面都是项目信息 + 路线图）；
  // 标准流水线项目留在画布视图。顶栏「▦ 工作台 / ⬡ 画布」随时切换。
  setView(opts.view || (p.management?.kind === 'novel' ? 'workshop' : 'canvas'), { keepPages: opts.keepPages });
  // 原著统计 / 资源索引异步补齐，就绪后再静默重绘工作台与侧栏
  Promise.all([ensureSourceView(), refreshAssetIndex()]).then(() => {
    if (state.project?.id !== p.id) return;
    refreshProjectSidebar();
    if (state.view === 'workshop') renderProjectView();
  }).catch(() => {});
  // 有保存过的视口就尊重它：大图强行 fit-all 会把节点缩到几十像素，看起来像空画布。
  // 需要看全图时用画布右下角的「⤢ 适应视图」，节点全在视口外时也会自动出现回到内容按钮。
  if (!savedViewport && state.view === 'canvas') setTimeout(() => canvas.fitView(), 60);
  if (p.nodes.length > 20 && !bigGraphHinted) {
    bigGraphHinted = true;
    UI.toast(`已载入 ${p.nodes.length} 节点的完成示例 · 滚轮放大看细节，⤢ 查看全图`, 'ok');
  }
}

/* ==========================================================================
 * 视图切换：home 项目列表 / workshop 工作台 / canvas 无限画布 / episode 剧集详情
 * 四个视图共用同一个 #workspace，靠 hidden + body class 切换；所有 ctx 在这里组装，
 * 页面模块只拿回调、不直接改全局状态，保证导航与状态联动是单向的。
 * ========================================================================*/
const VIEWS = ['home', 'workshop', 'canvas', 'episode'];
const GUIDE_STEPS = ['upload', 'episodes', 'script', 'context', 'storyboard', 'deliver'];

/** 从剧集详情返回时落到哪儿：创作项目回工作台，标准流水线回画布 */
function backView() {
  return state.project?.management?.kind === 'novel' ? 'workshop' : 'canvas';
}

function setView(view, opts = {}) {
  const next = VIEWS.includes(view) ? view : 'home';
  // 视图切换 = 离开当前整页视图：先把页面栈清空，否则 body-page 仍会盖住工作区。
  // keepPages 用于「项目数据重载但视图不变」的场景（如管理面板里改完信息回写），
  // 此时页面必须留着，否则用户保存一次就被踢出面板。
  if (!opts.keepPages) closeAllPages();
  state.view = next;
  document.body.classList.toggle('view-home', next === 'home');
  document.body.classList.toggle('view-workshop', next === 'workshop');
  document.body.classList.toggle('view-episode', next === 'episode');

  $('home-view').hidden = next !== 'home';
  $('episode-view').hidden = next !== 'episode';
  $('project-view').hidden = next !== 'workshop';
  $('canvas-wrapper').hidden = next !== 'canvas';
  $('inspector').hidden = next !== 'canvas';

  $('home-title').hidden = next !== 'home';
  $('btn-close-project').hidden = next === 'home' || !state.project;
  const toggle = $('btn-view-toggle');
  toggle.textContent = next === 'workshop' ? '⬡ 画布' : '▦ 工作台';
  toggle.title = next === 'workshop' ? '切换到画布视图（高级节点编辑）' : '切换到项目工作台（路线图与项目信息）';

  updateHeader();
  updateConfigChip();
  updateCrumb();
  updateChrome();
  const scopeBar = $('canvas-scopebar');
  if (scopeBar) scopeBar.hidden = next !== 'canvas' || !state.project;
  $('more-menu').hidden = true;
  // 项目内视图的侧栏高亮（工作台 / 画布 / 剧集）随视图切换即时更新
  if (next !== 'home') refreshProjectSidebar();
  if (next === 'home') renderHomeView();
  else if (next === 'workshop') renderProjectView();
  else if (next === 'episode') EV.renderEpisodeView($('episode-view'), episodeViewCtx(), !!opts.force);
  else { syncCanvasScope({ keepViewport: true }); canvas.drawMinimap(); }
}

/** 顶栏面包屑：剧集详情可一键回工作台 / 画布；退出项目只用右上角按钮或项目设置 */
function updateCrumb() {
  const el = $('view-crumb');
  const p = state.project;
  if (state.view === 'episode') {
    el.hidden = false;
    el.innerHTML = `<button class="vc-link" data-crumb="workshop">${escapeHTML(p?.name || '项目')}</button>`
      + `<span class="vc-sep">/</span><span>第 ${state.episodeNo || 1} 集</span>`;
    return;
  }
  // 工作台 / 画布：顶栏已有「项目封面 + 可编辑项目名 + 进度 + 右上角退出」，
  // 不再重复一条「项目列表 / 项目名」面包屑，避免整屏都是同一个项目名。
  el.hidden = true;
  el.innerHTML = '';
}

/** 顶栏「⚠ 模型未配置」：只要跳过过引导，仍保留一个随时可补配的入口 */
function updateConfigChip() {
  const chip = $('btn-config-chip');
  if (!chip) return;
  const need = SC.configNeedsAttention(state.settings, state.comfy);
  chip.hidden = !need;
  if (!need) return;
  const misses = [];
  if (!SC.llmReady(state.settings)) misses.push('文本大模型');
  if (!state.comfy?.imageWorkflow || !state.comfy?.videoWorkflow) misses.push('ComfyUI 工作流');
  chip.textContent = '⚠ 模型未配置';
  chip.title = `待配置：${misses.join('、')} · 点击打开设置（内置模板仍可完整体验流程）`;
}

/* ---------------------------------------------------------------- 项目列表页 */
function homeViewCtx() {
  return {
    projects: state.projects, stats: state.stats, steps: state.steps,
    settings: state.settings, comfy: state.comfy,
    recentId: state.recentId, currentId: state.project?.id, toast: UI.toast,
    onOpen: (id) => loadProject(id).catch((e) => UI.toast(`打开项目失败：${e.message}`, 'err')),
    onCreate: () => openWizard(),
    onImport: () => importProject(),
    onSettings: () => openSettingsDialog(),
    onGuide: (id) => guideToStep(id),
    onDuplicate: (id) => duplicateProject(id),
    onDelete: (id) => deleteProject(id),
    onExport: (id) => exportProjectJson(id),
    onRefresh: async () => { await refreshProjects(); renderHomeView(); UI.toast('项目列表已刷新', 'ok'); },
  };
}
function renderHomeView() {
  if (state.view !== 'home') return;
  HV.renderHomeView($('home-view'), homeViewCtx());
}

/** 首页六步流程图卡：定位到对应步骤操作台；没有当前项目时先打开最近的 */
async function guideToStep(id) {
  const stepId = GUIDE_STEPS.includes(id) ? id : 'upload';
  if (!state.project) {
    const target = state.recentId || state.projects[0]?.id;
    if (!target) {
      UI.toast('先新建一个漫剧项目，就能进入这一步（只需填一个名字）', 'ok');
      openWizard();
      return;
    }
    try { await loadProject(target, { view: 'workshop' }); }
    catch (e) { UI.toast(`打开项目失败：${e.message}`, 'err'); return; }
  }
  PV.setWorkshopStep(stepId);
  PM.setExpandedStep(stepId);
  if (state.view !== 'workshop') setView('workshop');
  else renderProjectView();
  renderStepPanel();
  const label = state.steps.find((s) => s.id === stepId)?.title || stepId;
  UI.toast(`已定位到「${label}」操作台`, 'ok');
}

function importProject() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'application/json,.json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const p = await api('/api/import', { method: 'POST', body: await file.text() });
      await refreshProjects();
      await loadProject(p.id);
      UI.toast('项目导入成功', 'ok');
    } catch (e) { UI.toast(`导入失败：${e.message}`, 'err'); }
  };
  input.click();
}

async function exportProjectJson(id) {
  try {
    const data = await api(`/api/projects/${id}/export`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `${data.name || 'lingximanju'}.json`;
    a.click(); URL.revokeObjectURL(a.href);
    UI.toast('项目 JSON 已导出', 'ok');
  } catch (e) { UI.toast(`导出失败：${e.message}`, 'err'); }
}

async function duplicateProject(id) {
  try {
    await api(`/api/projects/${id}/duplicate`, { method: 'POST', body: '{}' });
    await refreshProjects();
    renderHomeView();
    UI.toast('已复制项目副本', 'ok');
  } catch (e) { UI.toast(`复制失败：${e.message}`, 'err'); }
}

async function deleteProject(id) {
  const p = state.projects.find((x) => x.id === id);
  if (!window.confirm(`确定删除项目「${p?.name || id}」？此操作不可撤销。`)) return;
  try {
    await api(`/api/projects/${id}`, { method: 'DELETE' });
    // 删掉的正是当前项目：关闭会话回列表（不自动跳进另一个项目）
    if (state.project?.id === id) {
      await closeProject({ silent: true });
      UI.toast('项目已删除 · 返回项目列表', 'ok');
      return;
    }
    await refreshProjects();
    renderHomeView();
    UI.toast('项目已删除', 'ok');
  } catch (e) { UI.toast(`删除失败：${e.message}`, 'err'); }
}

/* ------------------------------------------------------------ 全局模型配置 */
function openSettingsDialog() {
  // 项目列表页 / 首次启动引导进入时 project 可能为 null，panels.js 已支持
  const inProject = !!state.project;
  UI.openSettings(state.project, (settings) => {
    if (state.project) { state.project.settings = settings; persist(true); }
    refreshAppConfig();
    UI.toast(inProject ? '本项目运行参数已保存 · 模型库为共享配置' : '设置已保存 · 全局模型对所有项目生效', 'ok');
  });
}
async function refreshAppConfig() {
  try {
    const d = await api('/api/settings');
    state.settings = d.settings || state.settings;
    state.comfy = d.comfy || state.comfy;
    PV.setComfySummary(state.comfy);
  } catch { /* 后端暂不可达时保留缓存 */ }
  updateHeader(); updateConfigChip(); renderHomeView();
  if (state.view === 'episode') EV.refreshEpisodeView();
}

/* ---------------------------------------------------------------- 剧集详情 */
async function openEpisode(no) {
  if (!state.project) { UI.toast('请先打开一个项目', 'err'); return; }
  const n = Number(no);
  const max = state.project.management?.episodes?.length || 0;
  if (!Number.isFinite(n) || n < 1 || (max && n > max)) { UI.toast('剧集不存在，请先重新分集', 'err'); return; }
  state.episodeNo = n;
  setView('episode');
}
function episodeViewCtx() {
  return {
    projectId: state.project?.id, no: state.episodeNo, toast: UI.toast,
    onBack: () => setView(backView()),
    onNavigate: (no) => openEpisode(no),
    onSettings: () => openSettingsDialog(),
    onManageCharacters: () => openManagePanel('characters'),
    onOpenEpisodeCanvas: (no) => openEpisodeCanvas(no),
    onOpenOverallCanvas: () => openOverallCanvas(),
    onLocateCanvasNode: (nodeId) => {
      setView('canvas');
      setCanvasScope('main');       // 主画布节点定位：先确保在正确的范围
      canvas.select([nodeId]);
      canvas.focusNode(nodeId);
    },
  };
}

/* ---------------------------------------------------------------- 项目工作台 */
function projectViewCtx() {
  return {
    project: state.project, steps: state.steps, stats: state.projectStats,
    busy: state.stepBusy, liveTokens: state.liveTokens, toast: UI.toast,
    source: state.sourceView, assets: state.assetIndex,
    workshopTab: state.workshopTab,
    directorSkills: state.directorSkills, directorSkillGroups: state.directorSkillGroups,
    directorPlan: state.directorPlan,
    directorBusy: state.directorBusy,
    runtime: state.project?.management?.runtime || state.runtimeDefaults,
    onSaveRuntime: (payload) => saveRuntime(payload),
    // 第⑤步分镜画面设置：保存 / 保存并按新版式重排分镜板（纯 SVG，不出图）
    onSaveStoryboard: (settings) => saveStoryboardSettings(settings, { regen: false }),
    onComposeStoryboard: (settings) => saveStoryboardSettings(settings, { regen: true }),
    onTabChange: (tab) => { state.workshopTab = tab; },
    // 工作台内部触发的重绘必须走这里重新取 ctx：syncProject() 会替换 state.project 对象，
    // 若沿用渲染时闭包里的旧 ctx，会把刚落盘的导演验收报告重新渲染成空态。
    onRerender: () => renderProjectView(),
    onSelectDirectorSkill: (id) => selectDirectorSkill(id),
    onSelectDirectorPalette: (key) => selectDirectorPalette(key),
    onRunDirector: (payload) => runDirectorFlow(payload),
    onRunStep: (id, all, force) => runStep(id, all, force),
    onChatStep: (id) => openStepChatFor(id),
    onManage: (tab) => openManagePanel(tab),
    // 剧本台「本次剧本模型」条与失败弹窗的去配置入口
    onSettings: () => openSettingsDialog(),
    onOpenCanvas: () => setView('canvas'),
    onOpenEpisode: (no) => openEpisode(no),
    onOpenEpisodeCanvas: (no) => openEpisodeCanvas(no),
    onOpenOverallCanvas: () => openOverallCanvas(),
    onOpenAssets: () => openProjectAssetLibrary({ mode: 'manage' }),
    onRefreshAssets: async () => { await refreshAssetIndex(true); renderProjectView(); },
    onPreviewAsset: (file) => openAssetLibrary({ mode: 'manage', files: [file] }),
    onReupload: () => { PV.setWorkshopStep('upload'); openWorkshopTab('overview'); },
    onOpenCover: () => openStepChatFor('cover'),
    onDownloadPack: () => exportPack(false),
    // 季 / 集管理：只改 management，立即落盘并刷新所有联动视图
    onAssignSeason: (no, season) => applySeasonMutation((m) => {
      m.episodes = PMODEL.assignEpisodeSeason(m.episodes, no, season);
    }, `第 ${no} 集已移到第 ${season} 季`),
    onRenameSeason: (no, title) => applySeasonMutation((m) => {
      m.seasons = PMODEL.setSeasonTitle(m.seasons, no, title);
    }),
    onAddSeason: () => applySeasonMutation((m) => {
      const r = PMODEL.addSeason(m.seasons, PMODEL.seasonGroups(state.project));
      m.seasons = r.seasons;
    }, '已新增一季 · 在分集卡片里把集移进去'),
    onRemoveSeason: (no) => applySeasonMutation((m) => {
      const r = PMODEL.removeSeason(m.seasons, m.episodes, no);
      m.seasons = r.seasons; m.episodes = r.episodes;
    }, '该季已合并回第一季'),
    // 定稿 / 撤销定稿：沿用季管理的 mutate + persist(true) 模式，落盘并刷新全部联动视图
    onFinalizeEpisode: (no, on) => applySeasonMutation((m) => {
      m.episodes = PMODEL.markFinalized(m.episodes, no, on);
    }, on ? `第 ${no} 集已定稿` : `第 ${no} 集已撤销定稿`),
    // 管理动作（保存信息 / 分集参数 / 交付物 / 画面设置）后：侧栏与顶栏同步，工作台由调用方重绘
    onChanged: async () => { await refreshProjects(); updateHeader(); refreshProjectSidebar(); },
    // 上传 / AI 生成小说注入成功：刷新项目（节点注入 + ①② 完成 + 分集列表）
    onSourceUploaded: async (out) => {
      UI.toast(out.message || '小说已注入项目', 'ok');
      await refreshProjects();
      await loadProject(state.project.id);
      await ensureSourceView(true);
      openWorkshopTab('source');
    },
  };
}
function renderProjectView() {
  if (state.view !== 'workshop') return;
  PV.renderProjectView($('project-view'), projectViewCtx());
}
/* ---------------- 创作项目管理：向导 / 六步执行 / 管理面板 ---------------- */
function openWizard() {
  openCreationWizard({
    toast: UI.toast,
    // 极简向导（只填项目名称）创建后直接落到项目工作台，从「准备故事」开始
    onCreated: async (project) => {
      await refreshProjects();
      PV.setWorkshopStep('upload');
      PM.setExpandedStep('upload');
      await loadProject(project.id, { view: 'workshop' });
      UI.toast('项目已创建 · 从「准备故事」开始上传小说', 'ok');
    },
  });
}

/** 项目级导演技能选择：只保存制片策略，不触发制作流程 */
async function selectDirectorSkill(skillId) {
  const p = state.project;
  if (!p) throw new Error('请先打开一个项目');
  const out = await api(`/api/projects/${p.id}/director/skills`, {
    method: 'POST', body: JSON.stringify({ skillId }),
  });
  if (p.management) {
    const prev = p.management.director || {};
    p.management.director = {
      ...prev, skillId: out.skillId,
      // 风格与主色一起回写：换导演后主色回到该档案默认色，面板立刻反映
      styleId: out.director?.styleId ?? null,
      paletteKey: out.director?.paletteKey ?? null,
      treatment: out.director?.treatment ?? prev.treatment ?? null,
      lastRun: out.director?.lastRun ?? prev.lastRun ?? null,
    };
  }
  state.directorPlan = out.plan || null;
  await refreshProjects();
  updateHeader(); refreshProjectSidebar();
  return out;
}

/**
 * 切换当前导演风格的主色调（张艺谋四色 / 王家卫四色…）。
 * 只改 paletteKey，不换导演；下一次出图与分镜就按新主色走。
 */
async function selectDirectorPalette(paletteKey) {
  const p = state.project;
  if (!p) throw new Error('请先打开一个项目');
  const out = await api(`/api/projects/${p.id}/director/skills`, {
    method: 'POST', body: JSON.stringify({ paletteKey }),
  });
  if (p.management?.director) p.management.director.paletteKey = out.director?.paletteKey || paletteKey;
  state.directorPlan = out.plan || null;
  await refreshProjects();
  updateHeader(); refreshProjectSidebar();
  return out;
}

/**
 * 保存项目级短剧成片规格。片段数由服务端推导并回写，
 * 下一次一键全流程会按新片段数重新分配镜头预算与时间线。
 */
async function saveRuntime({ totalSeconds, clipSeconds, fps, resolution, filmPolicy } = {}) {
  const p = state.project;
  if (!p) throw new Error('请先打开一个项目');
  // 只把真正给出的字段发给后端：缺省项沿用已有设置，不会被 undefined 覆盖成默认值
  const payload = { totalSeconds, clipSeconds };
  if (Number.isFinite(Number(fps)) && Number(fps) > 0) payload.fps = Number(fps);
  const resText = String(resolution || '').trim();
  if (/^\d{2,5}[×xX*]\d{2,5}$/.test(resText)) payload.resolution = resText.replace(/[xX*]/, '×');
  if (filmPolicy === 'real' || filmPolicy === 'preview') payload.filmPolicy = filmPolicy;
  const out = await api(`/api/projects/${p.id}/runtime`, {
    method: 'POST', body: JSON.stringify(payload),
  });
  if (p.management) p.management.runtime = out.spec;
  await refreshProjects();
  updateHeader(); refreshProjectSidebar(); renderProjectView();
  UI.toast(out.message || '成片规格已保存', 'ok');
  return out;
}

/**
 * 保存分镜画面设置（第⑤步操作台）。
 * regen=false：只落设置（manage 的 storyboard 动作）。
 * regen=true ：保存后立刻按新版式重排所有段的分镜板——纯 SVG 合成，
 *              不动关键帧、不烧 GPU，所以可以随手切版式对比。
 */
async function saveStoryboardSettings(settings, { regen = false } = {}) {
  const p = state.project;
  if (!p) throw new Error('请先打开一个项目');
  const payload = settings && typeof settings === 'object' ? settings : {};
  const out = regen
    ? await api(`/api/projects/${p.id}/storyboard/sheets`, {
      method: 'POST', body: JSON.stringify({ settings: payload }),
    })
    : await api(`/api/projects/${p.id}/manage`, {
      method: 'POST', body: JSON.stringify({ action: 'storyboard', value: payload }),
    });
  if (p.management && out.management?.storyboard) p.management.storyboard = out.management.storyboard;
  await syncProject();
  UI.toast(out.message || (regen ? '分镜板已重排' : '分镜画面设置已保存'), 'ok');
  return out;
}

/**
 * 导演智能体一键全流程：技能能力 → 六步制作链路 → 导演包 → 最终产物验收。
 * 期间 SSE 的 director:progress 会实时推进工作台进度条，project:meta 会刷新步骤状态。
 */
async function runDirectorFlow({ skillId, idea } = {}) {
  const p = state.project;
  if (!p || state.directorBusy || state.stepBusy) return;
  if (p.management?.kind !== 'novel') { UI.toast('导演智能体只作用于小说创作项目', 'err'); return; }
  state.directorBusy = true;
  state.stepBusy = true;
  PV.setDirectorProgress($('project-view'), {
    phase: 'setup', label: '导演智能体启动 · 载入技能', index: 0, total: 1, status: 'running',
  });
  renderProjectView(); renderStepPanel(); updateHeader();
  UI.toast('导演智能体已启动 · 正依次跑完全部制作步骤与最终产物验收', 'ok');
  let finalLabel = '导演智能体已结束';
  try {
    const out = await api(`/api/projects/${p.id}/director/run`, {
      method: 'POST', body: JSON.stringify({ skillId: skillId || undefined, idea: idea || undefined }),
    });
    finalLabel = out.message || finalLabel;
    state.directorPlan = out.plan || state.directorPlan;
    UI.toast(out.ok ? `✓ ${out.message}` : `⚠ ${out.message}`, out.ok ? 'ok' : 'err');
    await syncProject();
    await refreshProjects();
  } catch (e) {
    finalLabel = `导演智能体失败：${e.message}`;
    UI.toast(finalLabel, 'err');
  } finally {
    state.directorBusy = false;
    state.stepBusy = false;
    PV.setDirectorProgress($('project-view'), {
      phase: 'done', label: finalLabel, percent: 1, status: 'done',
    });
    renderStepPanel(); renderCanvasStepBar(); updateHeader(); refreshProjectSidebar();
    renderProjectView();
  }
}

async function runStep(stepId, all = false, force = false) {
  const p = state.project;
  if (!p || state.stepBusy) return;
  if (p.management?.kind !== 'novel') { UI.toast('这是标准流水线项目，请用「运行完整流水线」', 'err'); return; }
  state.stepBusy = true;
  PM.setExpandedStep(all ? null : (stepId || null));
  renderStepPanel(); updateHeader(); renderProjectView();
  const label = all ? '全部执行' : `第 ${state.steps.find((s) => s.id === stepId)?.no || ''} 步`;
  UI.toast(`${label}开始 · 画布节点会随智能体执行实时生长`, 'ok');
  try {
    const out = await api(`/api/projects/${p.id}/step`, {
      method: 'POST', body: JSON.stringify({ stepId: stepId || undefined, all, force: force || undefined }),
    });
    if (!out.ok) throw new Error(out.error || '执行失败');
    state.project.management = out.management;
    if (out.stats) state.projectStats = out.stats;
    const failed = (out.executed || []).filter((x) => x.status === 'error');
    UI.toast(failed.length ? `${label}中断：${failed[0].note}` : `${label}完成 · ${out.progress.label} 步`, failed.length ? 'err' : 'ok');
    await syncProject();
    await refreshProjects();
  } catch (e) {
    UI.toast(`${label}失败：${e.message}`, 'err');
  } finally {
    state.stepBusy = false;
    renderStepPanel(); renderCanvasStepBar(); updateHeader(); refreshProjectSidebar();
    renderProjectView();
  }
}

async function resetSteps(stepId) {
  const p = state.project;
  if (!p?.management || state.stepBusy) return;
  try {
    const out = await api(`/api/projects/${p.id}/step`, {
      method: 'POST', body: JSON.stringify({ action: 'reset', stepId: stepId || undefined }),
    });
    p.management = out.management;
    renderStepPanel(); renderCanvasStepBar(); updateHeader(); refreshProjectSidebar();
    UI.toast(stepId ? '该步骤已重置，可重新执行' : '六步任务状态已全部重置', 'ok');
  } catch (e) { UI.toast(e.message, 'err'); }
}

function focusStepNodes(stepId) {
  const def = state.steps.find((s) => s.id === stepId);
  if (!def || !state.project) return;
  const types = new Set(def.scope || []);
  let nodes = def.auto
    ? state.project.nodes.filter((n) => n.type === 'episode')
    : state.project.nodes.filter((n) => types.has(n.type));
  if (!nodes.length) nodes = state.project.nodes.filter((n) => n.type === 'idea' || n.type === 'note');
  const ids = nodes.slice(0, 8).map((n) => n.id);
  canvas.select(ids);
  if (ids[0]) canvas.focusNode(ids[0]);
  UI.toast(`已定位「${def.title}」相关 ${nodes.length} 个画布节点`, 'ok');
}

async function openManagePanel(tab) {
  if (!state.project) return;
  const v = stepVisual();
  // 打开时拉取当前项目的真实统计（节点 / 产物 / 运行记录），不用侧栏的全局统计
  try {
    const d = await api(`/api/projects/${state.project.id}/manage`);
    if (d.stats) state.projectStats = d.stats;
    if (d.management) state.project.management = d.management;
  } catch { /* 后端不可达时退回缓存的统计 */ }
  PM.openProjectManager({
    project: state.project, stats: state.projectStats, comfy: state.comfy, api: state.api, tab,
    progress: { label: `${v.done}/${v.total}`, percent: v.percent },
    toast: UI.toast,
    onOpenChat: (scope) => openStepChatFor(scope),
    onChanged: (deleted) => onProjectsChanged(deleted),
    onRunStep: (id) => runStep(id, false),
    onOpenEpisode: (no) => openEpisode(no),
    onDownload: (kind) => {
      if (kind === 'pack') return exportPack(false);
      const final = state.project.nodes.find((n) => n.type === 'final');
      if (!final?.data?.film?.file) return UI.toast('尚未生成成片 MP4：接入 ComfyUI 视频工作流后由 ffmpeg 拼接', 'err');
      window.location.href = `/api/projects/${state.project.id}/film`;
    },
  });
}

async function onProjectsChanged(deleted = false) {
  const data = await refreshProjects();
  const exists = state.project && data.projects.some((p) => p.id === state.project.id);
  if (deleted || !exists) {
    // 项目在管理面板里被删除 / 已被外部移除：关闭会话回项目列表，不自动打开别的项目
    await closeProject({ silent: true });
  } else {
    // 保留当前视图：从剧集详情里改项目管理信息，不该把用户弹回工作台。
    // keepPages：管理面板本身是整页视图，重载项目数据不能把它关掉。
    await loadProject(state.project.id, {
      view: state.view === 'home' ? undefined : state.view,
      keepPages: true,
    });
    renderStepPanel(); renderCanvasStepBar(); updateHeader();
  }
}

async function applyTemplate(id) {
  if (!state.project) return;
  if (!window.confirm('应用模板会替换当前画布上的所有节点，确定继续？（当前项目会被覆盖）')) return;
  try {
    await api(`/api/projects/${state.project.id}/template`, { method: 'POST', body: JSON.stringify({ template: id }) });
    refreshProjects();
  } catch (e) { UI.toast(e.message, 'err'); }
}
async function run(nodeId = null) {
  if (!state.project || state.running) return;
  try {
    await api(`/api/projects/${state.project.id}/run`, { method: 'POST', body: JSON.stringify(withModelId('run', { nodeId })) });
  } catch (e) { UI.toast(e.message, 'err'); }
}
async function arrange(silent = false) {
  if (!state.project) return;
  try {
    await api(`/api/projects/${state.project.id}/arrange`, { method: 'POST', body: '{}' });
    if (!silent) UI.toast('已按依赖拓扑整理画布', 'ok');
    setTimeout(() => canvas.fitView(), 120);
  } catch (e) { UI.toast(e.message, 'err'); }
}
function onFieldChange(id, key, value) {
  const n = activeNodeList().find((x) => x.id === id);
  if (!n) return;
  if (key === '__title') n.title = value;
  else if (key === '__agent') n.agent = value.trim() || null;
  else { n.data = n.data || {}; n.data[key] = (typeof n.data[key] === 'number' || ['sceneLimit', 'shotsPerScene'].includes(key)) ? Number(value) : value; }
  canvas.updateNode(id);
  if (state.canvasScope !== 'overall') persist();
  UI.toast('已更新节点属性', 'ok');
}
/** 生成 / 下载导演包；regen=true 时强制按当前画布重新打包 */
async function exportPack(regen = false) {
  if (!state.project) return;
  try {
    const final = state.project.nodes.find((n) => n.type === 'final');
    const need = regen || !final?.data?.directorPack?.file;
    if (need) {
      const out = await api(`/api/projects/${state.project.id}/director-pack`, { method: 'POST', body: '{}' });
      if (final) {
        final.data = { ...(final.data || {}), directorPack: {
          url: out.url, file: out.file, filename: out.filename, bytes: out.bytes,
          shotCount: out.shotCount, fileCount: out.fileCount, target: out.format, groups: out.groups,
        } };
        renderInspector();
      }
      UI.toast('导演包已按当前画布生成，开始下载', 'ok');
    } else UI.toast('开始下载导演包', 'ok');
    window.location.href = `/api/projects/${state.project.id}/director-pack`;
  } catch (e) { UI.toast(e.message, 'err'); }
}

async function onAction(act, id) {
  switch (act) {
    case 'rerun': run(id); break;
    case 'focus': canvas.focusNode(id); break;
    case 'dup': canvas.select([id]); canvas.duplicateSelection(); break;
    case 'delete': canvas.select([id]); canvas.deleteSelection(); break;
    case 'chat':
      // 画布 Agent 现在也走统一面板（画布档位），不再有独立的侧栏对话。
      // 预填 @节点ID：画布 Agent 靠它定位节点（与旧侧栏输入框同一套说法）。
      openStepChatFor('canvas', `请解释 @${id} 的上游依赖和数据来源`);
      break;
    case 'download-film': {
      const n = state.project?.nodes.find((x) => x.id === id);
      if (!n?.data?.film?.file) { UI.toast('尚未生成成片，请先接入 ComfyUI 视频工作流并运行流水线', 'err'); break; }
      window.location.href = `/api/projects/${state.project.id}/film`;
      break;
    }
    case 'pick-asset': {
      const n = state.project?.nodes.find((x) => x.id === id);
      if (!n) break;
      openProjectAssetLibrary({
        mode: 'pick', accept: 'image',
        onPick: (a) => {
          // character 节点写角色头像；其余节点写 poster——它是卡片与检查器预览的首位兜底字段
          if (n.type === 'character' && n.data.characters?.[0]) n.data.characters[0].portraitUrl = a.url;
          else n.data.poster = a.url;
          canvas.updateNode(id);
          persist();
          renderInspector();
          UI.toast('已从资源库选用图片', 'ok');
        },
      });
      break;
    }
    case 'download-pack': exportPack(false); break;
    case 'regen-pack': exportPack(true); break;
    default: break;
  }
}
function openContextMenu(id, x, y) {
  UI.hideContextMenu();
  if (id) {
    UI.showContextMenu(x, y, [
      { icon: '↻', label: '从此处重跑', action: () => run(id) },
      { icon: '⌖', label: '聚焦节点', action: () => canvas.focusNode(id) },
      { icon: '✎', label: '编辑属性', action: () => { switchInspector('props'); canvas.select([id]); } },
      { icon: '@', label: '问画布 Agent', action: () => onAction('chat', id) },
      { icon: '⧉', label: '复制节点', action: () => onAction('dup', id) },
      { sep: true },
      { icon: '✕', label: '删除节点', danger: true, action: () => onAction('delete', id) },
    ]);
  } else {
    const w = canvas.screenToWorld(x, y);
    UI.showContextMenu(x, y, [
      { icon: '✦', label: '新建创意节点', action: () => canvas.addNodeAt('idea', w.x, w.y) },
      { icon: '✎', label: '新建便签', action: () => canvas.addNodeAt('note', w.x, w.y) },
      { icon: '▧', label: '新建镜头规格', action: () => canvas.addNodeAt('shot', w.x, w.y) },
      { sep: true },
      { icon: '⤢', label: '适应视图', action: () => canvas.fitView() },
      { icon: '⌗', label: '自动布局', action: () => arrange() },
    ]);
  }
}
function switchInspector(tab) {
  document.querySelectorAll('.insp-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('insp-props').hidden = tab !== 'props';
  $('insp-steps').hidden = tab !== 'steps';
  $('insp-agent').hidden = tab !== 'agent';
  if (tab === 'steps') renderStepPanel();
}

/* ---------------- 事件绑定 ---------------- */
function bindUI() {
  // 「更多」菜单：项目内的次要操作统一收口，点条目等价于点原顶栏按钮
  const moreMenu = $('more-menu');
  $('btn-more').addEventListener('click', (e) => {
    e.stopPropagation();
    moreMenu.hidden = !moreMenu.hidden;
  });
  moreMenu.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    moreMenu.hidden = true;
    if (b.dataset.target) { $(b.dataset.target)?.click(); return; }
    const act = b.dataset.more;
    if (act === 'overall') openOverallCanvas();
    else if (act === 'source') openWorkshopTab('source');
    else if (act === 'seasons') openWorkshopTab('episodes');
    else if (act === 'assets') openWorkshopTab('assets');
  });
  document.addEventListener('click', (e) => {
    if (!moreMenu.hidden && !e.target.closest('.more-wrap')) moreMenu.hidden = true;
  });
  // 画布范围切换：全部组合 / 主画布 / 每一集独立画布
  $('canvas-scope').addEventListener('change', (e) => {
    setCanvasScope(e.target.value);
    setTimeout(() => canvas.fitView(), 30);
  });
  $('btn-scope-fit').addEventListener('click', () => canvas.fitView());
  // 项目会话退出出口 1/2：顶栏右上角「退出项目」
  $('btn-close-project').addEventListener('click', requestExitProject);
  $('btn-config-chip').addEventListener('click', () => openSettingsDialog());
  $('view-crumb').addEventListener('click', (e) => {
    const b = e.target.closest('[data-crumb]');
    if (b?.dataset.crumb === 'workshop') setView(backView());
  });
  $('btn-view-toggle').addEventListener('click', () => setView(state.view === 'workshop' ? 'canvas' : 'workshop'));
  // 统一 AI 对话：全项目只有一个面板，重复点击只是切档位
  $('btn-ai-chat').addEventListener('click', () => openStepChatFor('project'));
  $('btn-project-manage').addEventListener('click', () => openManagePanel());
  $('btn-step-run').addEventListener('click', () => runStep(null, false));
  // 模型下拉：完整流水线运行（顶栏）一个；画布 Agent 的模型选择改在统一面板里按档位记忆
  ensureModelPicker('run', $('btn-run').parentElement, $('btn-run'));
  $('btn-run').addEventListener('click', () => run());
  $('btn-stop').addEventListener('click', async () => {
    if (!state.project) return;
    try { await api(`/api/projects/${state.project.id}/stop`, { method: 'POST', body: '{}' }); UI.toast('已发送停止指令'); }
    catch (e) { UI.toast(e.message, 'err'); }
  });
  $('btn-arrange').addEventListener('click', () => arrange());
  $('btn-fit').addEventListener('click', () => canvas.fitView());
  $('btn-help').addEventListener('click', () => UI.openHelp(state.project));
  $('btn-asset-lib').addEventListener('click', () => openProjectAssetLibrary({ mode: 'manage' }));
  $('btn-settings').addEventListener('click', () => openSettingsDialog());
  $('btn-director-pack').addEventListener('click', () => { if (state.project) exportPack(false); });
  $('btn-export').addEventListener('click', () => {
    if (state.project) exportProjectJson(state.project.id);
  });
  $('btn-theme').addEventListener('click', () => toggleTheme());
  $('project-name').addEventListener('change', (e) => {
    if (!state.project) return;
    state.project.name = e.target.value.trim() || '未命名影片';
    persist(true); refreshProjects();
  });
  $('btn-sidebar-toggle').addEventListener('click', () => { $('sidebar').dataset.userToggled = '1'; $('sidebar').classList.add('collapsed'); $('btn-sidebar-expand').hidden = false; });
  $('btn-sidebar-expand').addEventListener('click', () => { $('sidebar').dataset.userToggled = '1'; $('sidebar').classList.remove('collapsed'); $('btn-sidebar-expand').hidden = true; });
  $('btn-insp-toggle').addEventListener('click', () => {
    const el = $('inspector');
    el.classList.toggle('collapsed');
    $('btn-insp-toggle').textContent = el.classList.contains('collapsed') ? '‹' : '›';
  });
  document.querySelectorAll('.insp-tab').forEach((b) => b.addEventListener('click', () => switchInspector(b.dataset.tab)));
  // 检查器里的「Agent 对话」页签不再自带输入框：跳到统一面板的画布档位
  $('btn-insp-ai-chat').addEventListener('click', () => openStepChatFor('canvas'));
  document.querySelectorAll('.canvas-toolbar button').forEach((b) => b.addEventListener('click', () => {
    const act = b.dataset.act;
    if (act === 'zoom-in') canvas.setZoom(canvas.vp.zoom * 1.2);
    if (act === 'zoom-out') canvas.setZoom(canvas.vp.zoom / 1.2);
    if (act === 'fit') canvas.fitView();
    if (act === 'layout') arrange();
  }));

  // 落点只认画布舞台：从画布侧栏拖到侧栏自身不建节点
  const stage = $('canvas-stage');
  stage.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('text/plain');
    if (!NODE_TYPES[type]) return;
    const w = canvas.screenToWorld(e.clientX, e.clientY);
    const node = canvas.addNodeAt(type, Math.round(w.x - 134), Math.round(w.y - 60));
    UI.toast(`已添加「${typeOf(type).label}」节点 · 可选要连接的上游`, 'ok');
    showAttachPicker(node, e.clientX, e.clientY, w);
  });

  document.addEventListener('pointerdown', (e) => {
    if (!$('context-menu').contains(e.target)) UI.hideContextMenu();
  });

  document.addEventListener('keydown', (e) => {
    // 连线选择器打开时接管键盘，避免 R / Delete / Space 等误触发画布快捷键
    if (isLinkPickerOpen()) {
      if (e.key === 'Escape') closeLinkPicker('cancel');
      return;
    }
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = ['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable;
    if (e.code === 'Space' && !typing && state.view === 'canvas') { e.preventDefault(); canvas.setSpace(true); return; }
    if (e.key === 'Escape') {
      UI.hideContextMenu();
      if (hasOpenPage()) { closeTopPage(); return; }
      if (state.view === 'episode' && !$('modal-root').children.length) { setView(backView()); return; }
      canvas.select([]);
      return;
    }
    if (typing || $('modal-root').children.length || hasOpenPage()) return;
    const cmd = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    // H 不再是退出快捷键：退出只在右上角按钮与「项目设置 → 退出项目」两处
    // 所有视图通用：帮助跟随当前项目；T 切换主题（项目内顶栏不显示应用级按钮）
    if (e.key === '?') { UI.openHelp(state.project); return; }
    if (k === 't' && !cmd) { toggleTheme(); return; }
    // 项目列表页：屏蔽画布快捷键，避免误删节点 / 误跑流水线
    if (state.view === 'home') {
      if (k === 'n') openWizard();
      return;
    }
    // 剧集详情页：只保留导航与通用操作
    if (state.view === 'episode') {
      if (k === 'v') setView(backView());
      else if (k === 'p') openManagePanel('characters');
      else if (k === 'n') openWizard();
      return;
    }
    // 工作台视图：屏蔽画布快捷键，只保留通用操作；V 在两个视图间切换
    if (state.view === 'workshop') {
      if (k === 'n') openWizard();
      else if (k === 's') runStep(null, false);
      else if (k === 'p') openManagePanel();
      else if (k === 'v') setView('canvas');
      return;
    }
    if (k === 'v' && state.project?.management?.kind === 'novel') { setView('workshop'); return; }
    // 组合总览是派生视图：禁止会改动主画布 / 撤销栈的动作
    if (scopeReadOnly() && (e.key === 'Delete' || e.key === 'Backspace'
      || (cmd && ['z', 'd'].includes(k)) || ['r', 'l'].includes(k))) {
      UI.toast('组合总览为派生视图 · 请切到主画布或单集画布再编辑', 'err');
      return;
    }
    if (cmd && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) canvas.redo(); else canvas.undo(); return; }
    if (cmd && e.key.toLowerCase() === 'a') { e.preventDefault(); canvas.selectAll(); return; }
    if (cmd && e.key.toLowerCase() === 'd') { e.preventDefault(); canvas.duplicateSelection(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); canvas.deleteSelection(); return; }
    if (e.key.toLowerCase() === 'f') { canvas.fitView(); return; }
    if (e.key.toLowerCase() === 'l') { arrange(); return; }
    if (e.key.toLowerCase() === 'r') { run(); return; }
    if (e.key.toLowerCase() === 'n') { openWizard(); return; }
    if (e.key.toLowerCase() === 'p') { openManagePanel(); return; }
    if (e.key.toLowerCase() === 's') { runStep(null, false); return; }
    if (e.key === '+' || e.key === '=') { canvas.setZoom(canvas.vp.zoom * 1.2); return; }
    if (e.key === '-') { canvas.setZoom(canvas.vp.zoom / 1.2); return; }
  });
  document.addEventListener('keyup', (e) => { if (e.code === 'Space') canvas.setSpace(false); });
  /** 窄屏（≤900px）下 #sidebar 是 z-index 浮层，默认展开会盖住工作台内容：
   *  自动收起，用户点顶栏 › 可随时展开；用户手动操作过后不再自动干预。 */
  const syncNarrowSidebar = () => {
    const sb = $('sidebar');
    if (!sb || sb.dataset.userToggled === '1') return;
    const narrow = window.innerWidth <= 900;
    sb.classList.toggle('collapsed', narrow);
    $('btn-sidebar-expand').hidden = !narrow;
  };
  window.addEventListener('resize', () => { canvas.drawMinimap(); syncNarrowSidebar(); });
  syncNarrowSidebar();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('btn-theme').textContent = theme === 'dark' ? '☀' : '☾';
}

/* ---------------- 启动 ---------------- */
async function boot() {
  applyTheme(localStorage.getItem('cc-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  bindUI();
  const data = await api('/api/bootstrap');
  applyBootstrap(data);
  state.recentId = data.recent || state.projects[0]?.id || null;
  renderSidebar();
  // 落地页：项目列表 + 六步图文流程；不再自动打开最近项目，避免新手一进来就掉进画布
  setView('home');
  renderStepPanel(); renderCanvasStepBar(); updateRunUI();
  initSSE();

  const qs = new URLSearchParams(window.location.search);
  // 启动检查：模型未配置且用户没跳过过时弹引导框；「先跳过」写入本地 + 服务端
  setTimeout(() => {
    SC.checkModelConfig({
      settings: state.settings, comfy: state.comfy,
      onConfigure: () => openSettingsDialog(),
      onSkip: () => {
        state.settings = { ...(state.settings || {}), skipConfigCheck: true };
        updateConfigChip(); renderHomeView();
        UI.toast('已跳过 · 内置模板可完整体验流程，随时可点顶栏 ⚠ 补配模型', 'ok');
      },
    });
    // 门户卡片 / 书签可用 ?new=1 直达新建创作项目向导
    if (qs.get('new') === '1') openWizard();
  }, 360);

  // 深链：?project=<id>[&ep=<no>] —— 从外部直接落到工作台或某一集详情
  const deepProject = qs.get('project');
  if (deepProject && state.projects.some((p) => p.id === deepProject)) {
    await loadProject(deepProject);
    const ep = Number(qs.get('ep'));
    if (Number.isFinite(ep) && ep > 0) await openEpisode(ep);
  }
}

boot().catch((e) => {
  document.getElementById('log-stream').textContent = `启动失败：${e.message}`;
  UI.toast(`启动失败：${e.message}`, 'err');
});
