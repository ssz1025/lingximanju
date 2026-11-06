// 应用状态机：API、SSE、UI 绑定、快捷键与业务流程
import { CanvasController } from './canvas.js';
import { NODE_TYPES, PALETTE_ORDER, typeOf, STATUS_LABEL } from './nodes.js';
import * as UI from './panels.js';
import { openLinkPicker, closeLinkPicker, isLinkPickerOpen } from './link-picker.js';

const $ = (id) => document.getElementById(id);
const state = {
  project: null, projects: [], templates: [], agents: [], selected: [],
  running: false, logs: [], movedByUser: false, nodeCountBeforeRun: 0,
};
let saveTimer = null;
let renderScheduled = false;
let inspectorScheduled = false;
let bigGraphHinted = false;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`响应不是 JSON：${text.slice(0, 80)}`); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ---------------- 画布实例 ---------------- */
const canvas = new CanvasController({
  onChange: (reason) => {
    if (!['undo', 'redo'].includes(reason)) state.movedByUser = true;
    persist();
    updateStats();
  },
  onSelect: (ids) => { state.selected = ids; scheduleInspector(); },
  onContextMenu: (id, x, y) => openContextMenu(id, x, y),
  onDblClick: (id) => { switchInspector('props'); canvas.select([id]); },
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
  if (e.type === 'state' && e.reason === 'created') { refreshProjects(); return; }
  const p = state.project;
  if (!p || (e.projectId && e.projectId !== p.id)) return;

  switch (e.type) {
    case 'run:start':
      state.running = true; state.nodeCountBeforeRun = p.nodes.length;
      state.logs = []; updateRunUI();
      UI.toast('编排已启动，画布会随智能体执行自动生长', 'ok');
      break;
    case 'node:status': {
      const n = p.nodes.find((x) => x.id === e.nodeId);
      if (!n) break;
      n.status = e.status;
      if (e.progress !== undefined) n.progress = e.progress;
      if (e.error) n.error = e.error;
      canvas.updateNode(n.id);
      if (state.selected.includes(n.id)) scheduleInspector();
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
    case 'chat':
      UI.appendChat(e.role || 'assistant', e.content);
      break;
    case 'state': {
      if (!e.project) break;
      state.project = e.project;
      canvas.setProject(e.project, { keepViewport: e.reason !== 'template' });
      if (e.reason === 'template') { canvas.fitView(); UI.toast('已应用流水线模板', 'ok'); }
      if (e.reason === 'arrange') UI.toast('画布已按依赖拓扑整理', 'ok');
      if (['storyboard'].includes(e.reason)) UI.toast('Agent 已在画布上生成镜头链', 'ok');
      renderInspector(); updateStats(); updateHeader();
      break;
    }
    case 'run:done':
    case 'run:error':
      state.running = false;
      updateRunUI();
      if (e.type === 'run:error' && e.status !== 'cancelled') UI.toast(e.message || '运行异常结束', 'err');
      else if (e.status === 'cancelled') UI.toast('运行已取消，已完成节点保留');
      else {
        const s = e.summary || {};
        UI.toast(`编排完成 · ${s.nodeCount || 0} 节点 · ${s.waves || 0} 波 · ${((s.durationMs || 0) / 1000).toFixed(1)}s`, 'ok');
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

async function syncProject() {
  if (!state.project) return;
  const fresh = await api(`/api/projects/${state.project.id}`);
  state.project = fresh;
  canvas.setProject(fresh, { keepViewport: true });
  updateStats(); renderInspector(); updateHeader();
}

/* ---------------- 渲染 ---------------- */
function updateHeader() {
  const p = state.project;
  if (!p) return;
  $('project-name').value = p.name;
  $('project-mode').textContent = (state.templates.find((t) => t.id === p.mode)?.name) || p.mode || '';
  const c = state.comfy || {};
  const backend = c.imageWorkflow || c.videoWorkflow ? '本地 ComfyUI' : 'Mock 自绘';
  $('stat-provider').textContent = `${p.settings?.provider === 'openai' ? 'openai' : 'mock'} + ${backend}`;
}
function updateStats() {
  const p = state.project;
  if (!p) return;
  $('stat-nodes').textContent = `${p.nodes.length} 节点`;
  $('stat-edges').textContent = `${p.edges.length} 连线`;
}
function updateRunUI() {
  $('btn-run').hidden = state.running;
  $('btn-stop').hidden = !state.running;
  const box = $('run-status');
  box.className = `run-status ${state.running ? 'running' : ''}`;
  $('run-status-text').textContent = state.running ? '智能体运行中…' : '就绪';
}

function renderSidebar() {
  $('project-list').innerHTML = state.projects.map((p) => `
    <div class="project-item ${p.id === state.project?.id ? 'active' : ''}" data-id="${p.id}">
      <span class="pi-icon">◈</span>
      <span class="pi-main"><span class="pi-name">${escapeHTML(p.name)}${p.nodeCount > 0 && p.doneCount === p.nodeCount ? '<span class="pi-tag">全完成</span>' : ''}</span>
      <span class="pi-sub">${p.nodeCount} 节点 · ${p.doneCount} 已完成</span></span>
      <button class="pi-del" data-del="${p.id}" title="删除项目">×</button>
    </div>`).join('');
  $('project-list').querySelectorAll('.project-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.dataset.del) {
        e.stopPropagation();
        if (!window.confirm('确定删除这个项目？此操作不可撤销。')) return;
        api(`/api/projects/${e.target.dataset.del}`, { method: 'DELETE' }).then(() => {
          UI.toast('项目已删除');
          refreshProjects().then(() => state.projects[0] && loadProject(state.projects[0].id));
        });
        return;
      }
      loadProject(el.dataset.id);
    });
  });

  $('template-list').innerHTML = state.templates.map((t) => `
    <div class="template-item" data-id="${t.id}">
      <span class="ti-icon">${t.icon}</span>
      <span><span class="ti-name">${escapeHTML(t.name)}${t.badge ? `<span class="badge">${t.badge}</span>` : ''}</span>
      <span class="ti-desc">${escapeHTML(t.description)}</span></span>
    </div>`).join('');
  $('template-list').querySelectorAll('.template-item').forEach((el) => {
    el.addEventListener('click', () => applyTemplate(el.dataset.id));
  });

  $('node-palette').innerHTML = PALETTE_ORDER.map((key) => {
    const t = NODE_TYPES[key];
    return `<div class="palette-item" draggable="true" data-type="${key}" style="--nc:${t.color}" title="拖入画布：${t.label}"><span class="pl-dot"></span><span>${t.icon} ${t.label}</span></div>`;
  }).join('');
  $('node-palette').querySelectorAll('.palette-item').forEach((el) => {
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', el.dataset.type); e.dataTransfer.effectAllowed = 'copy'; });
    el.addEventListener('dblclick', () => {
      const r = $('canvas-wrapper').getBoundingClientRect();
      const w = canvas.screenToWorld(r.left + r.width / 2 - 134, r.top + r.height / 2 - 70);
      canvas.addNodeAt(el.dataset.type, w.x, w.y);
    });
  });

  $('agent-count').textContent = `${state.agents.length} 个`;
  $('agent-list').innerHTML = state.agents.map((a) => `
    <div class="agent-item" title="${escapeHTML(a.description || '')}" style="--ag:${a.color || '#8b9bff'}">
      <span class="ag-ico">${a.icon || '◇'}</span><span>${escapeHTML(a.label)}</span><span class="ag-grp">${escapeHTML(a.group || '')}</span>
    </div>`).join('');
}

function renderInspector() {
  const p = state.project;
  const node = p?.nodes.find((n) => n.id === state.selected[0]) || null;
  UI.renderInspector(node, p, { onFieldChange, onAction });
}
function escapeHTML(s = '') { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ---------------- 业务动作 ---------------- */
async function refreshProjects() {
  const data = await api('/api/bootstrap');
  state.projects = data.projects; state.templates = data.templates; state.agents = data.agents;
  state.comfy = data.comfy || state.comfy;
  renderSidebar();
  return data;
}
async function loadProject(id) {
  const p = await api(`/api/projects/${id}`);
  state.project = p; state.selected = []; state.movedByUser = false;
  const savedViewport = p.viewport && Number.isFinite(p.viewport.zoom) && p.viewport.zoom > 0;
  canvas.setProject(p);
  updateHeader(); updateStats(); updateRunUI(); renderSidebar(); renderInspector();
  // 有保存过的视口就尊重它：大图强行 fit-all 会把节点缩到几十像素，看起来像空画布。
  // 需要看全图时用画布右下角的「⤢ 适应视图」，节点全在视口外时也会自动出现回到内容按钮。
  if (!savedViewport) setTimeout(() => canvas.fitView(), 60);
  if (p.nodes.length > 20 && !bigGraphHinted) {
    bigGraphHinted = true;
    UI.toast(`已载入 ${p.nodes.length} 节点的完成示例 · 滚轮放大看细节，⤢ 查看全图`, 'ok');
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
    await api(`/api/projects/${state.project.id}/run`, { method: 'POST', body: JSON.stringify({ nodeId }) });
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
  const n = state.project?.nodes.find((x) => x.id === id);
  if (!n) return;
  if (key === '__title') n.title = value;
  else if (key === '__agent') n.agent = value.trim() || null;
  else n.data[key] = (typeof n.data[key] === 'number' || ['sceneLimit', 'shotsPerScene'].includes(key)) ? Number(value) : value;
  canvas.updateNode(id);
  persist();
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
      switchInspector('agent');
      $('chat-input').value = `请解释 @${id} 的上游依赖和数据来源`;
      $('chat-input').focus();
      break;
    case 'download-film': {
      const n = state.project?.nodes.find((x) => x.id === id);
      if (!n?.data?.film?.file) { UI.toast('尚未生成成片，请先接入 ComfyUI 视频工作流并运行流水线', 'err'); break; }
      window.location.href = `/api/projects/${state.project.id}/film`;
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
  $('insp-agent').hidden = tab !== 'agent';
  if (tab === 'agent') $('chat-input')?.focus();
}
async function sendChat(text) {
  const msg = (text ?? $('chat-input').value).trim();
  if (!msg || !state.project) return;
  $('chat-input').value = '';
  UI.appendChat('user', msg);
  try {
    await api(`/api/projects/${state.project.id}/chat`, { method: 'POST', body: JSON.stringify({ message: msg }) });
  } catch (e) { UI.appendChat('assistant', `请求失败：${e.message}`); }
}

/* ---------------- 事件绑定 ---------------- */
function bindUI() {
  $('btn-new-project').addEventListener('click', () => UI.openNewProject(state.templates, async (payload) => {
    try {
      const p = await api('/api/projects', { method: 'POST', body: JSON.stringify(payload) });
      await refreshProjects();
      await loadProject(p.id);
      UI.toast('项目已创建，点击「运行完整流水线」开始', 'ok');
    } catch (e) { UI.toast(e.message, 'err'); }
  }));
  $('btn-import').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const p = await api('/api/import', { method: 'POST', body: await file.text() });
        await refreshProjects(); await loadProject(p.id);
        UI.toast('项目导入成功', 'ok');
      } catch (e) { UI.toast(`导入失败：${e.message}`, 'err'); }
    };
    input.click();
  });
  $('btn-run').addEventListener('click', () => run());
  $('btn-stop').addEventListener('click', async () => {
    try { await api(`/api/projects/${state.project.id}/stop`, { method: 'POST', body: '{}' }); UI.toast('已发送停止指令'); }
    catch (e) { UI.toast(e.message, 'err'); }
  });
  $('btn-arrange').addEventListener('click', () => arrange());
  $('btn-fit').addEventListener('click', () => canvas.fitView());
  $('btn-help').addEventListener('click', UI.openHelp);
  $('btn-settings').addEventListener('click', () => UI.openSettings(state.project, (settings) => {
    state.project.settings = settings;
    persist(true);
    updateHeader();
    api('/api/comfyui/config').then((r) => r.json()).then((d) => { state.comfy = d.summary; updateHeader(); }).catch(() => {});
    UI.toast('项目设置已保存', 'ok');
  }));
  $('btn-director-pack').addEventListener('click', () => exportPack(false));
  $('btn-export').addEventListener('click', async () => {
    const data = await api(`/api/projects/${state.project.id}/export`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.project.name || 'lingximanju'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    UI.toast('项目 JSON 已导出', 'ok');
  });
  $('btn-theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('cc-theme', next);
  });
  $('project-name').addEventListener('change', (e) => {
    if (!state.project) return;
    state.project.name = e.target.value.trim() || '未命名影片';
    persist(true); refreshProjects();
  });
  $('btn-sidebar-toggle').addEventListener('click', () => { $('sidebar').classList.add('collapsed'); $('btn-sidebar-expand').hidden = false; });
  $('btn-sidebar-expand').addEventListener('click', () => { $('sidebar').classList.remove('collapsed'); $('btn-sidebar-expand').hidden = true; });
  $('btn-insp-toggle').addEventListener('click', () => {
    const el = $('inspector');
    el.classList.toggle('collapsed');
    $('btn-insp-toggle').textContent = el.classList.contains('collapsed') ? '‹' : '›';
  });
  document.querySelectorAll('.insp-tab').forEach((b) => b.addEventListener('click', () => switchInspector(b.dataset.tab)));
  $('btn-send').addEventListener('click', () => sendChat());
  $('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'ENTER' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  document.querySelectorAll('.chat-chips button').forEach((b) => b.addEventListener('click', () => sendChat(b.dataset.q)));
  document.querySelectorAll('.canvas-toolbar button').forEach((b) => b.addEventListener('click', () => {
    const act = b.dataset.act;
    if (act === 'zoom-in') canvas.setZoom(canvas.vp.zoom * 1.2);
    if (act === 'zoom-out') canvas.setZoom(canvas.vp.zoom / 1.2);
    if (act === 'fit') canvas.fitView();
    if (act === 'layout') arrange();
  }));

  const wrapper = $('canvas-wrapper');
  wrapper.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  wrapper.addEventListener('drop', (e) => {
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
    if (e.code === 'Space' && !typing) { e.preventDefault(); canvas.setSpace(true); return; }
    if (e.key === 'Escape') { UI.hideContextMenu(); canvas.select([]); return; }
    if (typing || $('modal-root').children.length) return;
    const cmd = e.metaKey || e.ctrlKey;
    if (cmd && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) canvas.redo(); else canvas.undo(); return; }
    if (cmd && e.key.toLowerCase() === 'a') { e.preventDefault(); canvas.selectAll(); return; }
    if (cmd && e.key.toLowerCase() === 'd') { e.preventDefault(); canvas.duplicateSelection(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); canvas.deleteSelection(); return; }
    if (e.key.toLowerCase() === 'f') { canvas.fitView(); return; }
    if (e.key.toLowerCase() === 'l') { arrange(); return; }
    if (e.key.toLowerCase() === 'r') { run(); return; }
    if (e.key === '?' ) { UI.openHelp(); return; }
    if (e.key === '+' || e.key === '=') { canvas.setZoom(canvas.vp.zoom * 1.2); return; }
    if (e.key === '-') { canvas.setZoom(canvas.vp.zoom / 1.2); return; }
  });
  document.addEventListener('keyup', (e) => { if (e.code === 'Space') canvas.setSpace(false); });
  window.addEventListener('resize', () => canvas.drawMinimap());
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
  state.projects = data.projects; state.templates = data.templates; state.agents = data.agents;
  state.comfy = data.comfy || state.comfy;
  renderSidebar();
  if (data.recent) await loadProject(data.recent);
  initSSE();
  UI.appendChat('assistant', '你好，我是画布协作者。我可以读整张图、解释依赖、检查一致性、整理布局，也能直接给场景补镜头链。试试下面的快捷指令吧。');
  setTimeout(() => canvas.fitView(), 200);
}

boot().catch((e) => {
  document.getElementById('log-stream').textContent = `启动失败：${e.message}`;
  UI.toast(`启动失败：${e.message}`, 'err');
});
