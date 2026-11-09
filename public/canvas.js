// 无限画布引擎（全自主实现）：视口变换、缩放平移、节点拖拽、连线、框选、小地图、撤销重做
import { createNodeEl, decorateNode, typeOf } from './nodes.js';
import { clamp, uid } from './utils.js';

const clone = (o) => JSON.parse(JSON.stringify(o));

export class CanvasController {
  constructor(cb = {}) {
    this.cb = cb;
    // 舞台 = 画布可视区（不含左侧 #canvas-side），坐标 / 拖拽 / 缩放都以它为基准
    this.wrapper = document.getElementById('canvas-stage');
    this.viewport = document.getElementById('canvas-viewport');
    this.nodeLayer = document.getElementById('node-layer');
    this.edgeLayer = document.getElementById('edge-layer');
    this.grid = document.getElementById('grid');
    this.selectionBox = document.getElementById('selection-box');
    this.connectLine = document.getElementById('connect-line');
    this.connectPath = document.getElementById('connect-path');
    this.miniCanvas = document.getElementById('minimap-canvas');
    this.project = null;
    this.vp = { x: 80, y: 60, zoom: 0.8 };
    this.nodeEls = new Map();
    this.selection = new Set();
    this.history = [];
    this.future = [];
    this.spaceDown = false;
    this.drag = null;
    this.mini = null;
    this.raf = null;
    // 节点全部在视口外时给出「回到内容」入口，避免大图被误认为空画布
    document.getElementById('canvas-offscreen')?.addEventListener('click', () => this.fitView());
    this.bind();
  }

  /* ---------------- 数据与渲染 ---------------- */
  /**
   * 绑定一份画布数据（{ nodes, edges, viewport }）。
   * 项目主画布 / 单集独立画布 / 组合总览会共用同一个控制器反复切换数据源，
   * 因此 resetHistory 必须清掉撤销栈，否则 undo 会把 A 画布的快照写回 B 画布。
   */
  setProject(project, { keepViewport = false, resetHistory = false } = {}) {
    this.project = project;
    if (resetHistory) { this.history = []; this.future = []; }
    if (!keepViewport) this.vp = { ...(project.viewport || { x: 80, y: 60, zoom: 0.8 }) };
    this.selection.clear();
    this.render();
    this.applyTransform();
  }

  render() {
    if (!this.project) return;
    const ids = new Set(this.project.nodes.map((n) => n.id));
    for (const [id, el] of this.nodeEls) {
      if (!ids.has(id)) { el.remove(); this.nodeEls.delete(id); }
    }
    for (const node of this.project.nodes) {
      let el = this.nodeEls.get(node.id);
      if (!el) { el = createNodeEl(node); this.nodeLayer.appendChild(el); this.nodeEls.set(node.id, el); }
      else decorateNode(el, node);
    }
    this.applySelection();
    this.renderEdges();
    this.drawMinimap();
    this.syncEmptyState();
  }

  // 空画布提示只在真正没有节点时出现。除 hidden 属性外再显式设置内联 display，
  // 防止样式表中的 display 规则覆盖浏览器默认的 [hidden] 行为导致提示常驻悬浮。
  syncEmptyState() {
    const empty = document.getElementById('canvas-empty');
    if (!empty) return;
    const isEmpty = !this.project || this.project.nodes.length === 0;
    empty.hidden = !isEmpty;
    empty.style.display = isEmpty ? '' : 'none';
  }

  updateNode(id) {
    const node = this.project?.nodes.find((n) => n.id === id);
    const el = this.nodeEls.get(id);
    if (!node || !el) return this.render();
    decorateNode(el, node);
    if (this.selection.has(id)) el.classList.add('selected');
    this.scheduleEdges();
  }

  scheduleEdges() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = null; this.renderEdges(); this.drawMinimap(); });
  }

  renderEdges() {
    if (!this.project) return;
    const parts = [];
    for (const e of this.project.edges) {
      const a = this.project.nodes.find((n) => n.id === e.from);
      const b = this.project.nodes.find((n) => n.id === e.to);
      if (!a || !b) continue;
      const ea = this.nodeEls.get(a.id), eb = this.nodeEls.get(b.id);
      const ha = ea?.offsetHeight || 130, hb = eb?.offsetHeight || 130;
      const x1 = (a.x || 0) + (a.w || 268), y1 = (a.y || 0) + ha / 2;
      const x2 = b.x || 0, y2 = (b.y || 0) + hb / 2;
      const dx = Math.max(58, Math.abs(x2 - x1) * 0.42);
      const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      const cls = [
        'edge-path', `kind-${e.kind || 'flow'}`,
        (this.selection.has(a.id) || this.selection.has(b.id)) ? 'highlight' : '',
        (a.status === 'running' || b.status === 'running') ? 'active' : '',
      ].filter(Boolean).join(' ');
      parts.push(`<path class="${cls}" d="${d}" data-edge="${e.id}"></path>`);
      if (e.kind === 'anchor') {
        parts.push(`<circle cx="${x2 - 4}" cy="${y2}" r="2.6" fill="#fbbf24" opacity=".85"></circle>`);
      }
    }
    this.edgeLayer.innerHTML = parts.join('');
  }

  applyTransform() {
    const { x, y, zoom } = this.vp;
    this.viewport.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    this.grid.style.setProperty('--grid-size', `${24 * zoom}px`);
    this.grid.style.setProperty('--grid-x', `${x}px`);
    this.grid.style.setProperty('--grid-y', `${y}px`);
    const pct = `${Math.round(zoom * 100)}%`;
    const label = document.getElementById('zoom-label');
    if (label) label.textContent = pct;
    const stat = document.getElementById('stat-zoom');
    if (stat) stat.textContent = pct;
    if (this.project) this.project.viewport = { ...this.vp };
    this.cb.onViewport?.(this.vp);
    this.drawMinimap();
    this.updateOffscreenHint();
  }

  /** 有节点但一个都看不到时，显示可点击的「回到内容」提示 */
  updateOffscreenHint() {
    const hint = document.getElementById('canvas-offscreen');
    if (!hint) return;
    const nodes = this.project?.nodes || [];
    const r = this.rect();
    if (!nodes.length || !r.width || !r.height) { hint.hidden = true; return; }
    const visible = nodes.some((n) => {
      const sx = (n.x || 0) * this.vp.zoom + this.vp.x;
      const sy = (n.y || 0) * this.vp.zoom + this.vp.y;
      const w = (n.w || 268) * this.vp.zoom;
      const h = 150 * this.vp.zoom;
      return sx + w > 0 && sx < r.width && sy + h > 0 && sy < r.height;
    });
    hint.hidden = visible;
  }

  /* ---------------- 坐标 ---------------- */
  rect() { return this.wrapper.getBoundingClientRect(); }
  screenToWorld(sx, sy) {
    const r = this.rect();
    return { x: (sx - r.left - this.vp.x) / this.vp.zoom, y: (sy - r.top - this.vp.y) / this.vp.zoom };
  }
  worldToScreen(wx, wy) {
    const r = this.rect();
    return { x: r.left + wx * this.vp.zoom + this.vp.x, y: r.top + wy * this.vp.zoom + this.vp.y };
  }
  zoomAt(factor, sx, sy) {
    const r = this.rect();
    const px = sx - r.left, py = sy - r.top;
    const nz = clamp(this.vp.zoom * factor, 0.1, 2.5);
    if (nz === this.vp.zoom) return;
    this.vp.x = px - (px - this.vp.x) * (nz / this.vp.zoom);
    this.vp.y = py - (py - this.vp.y) * (nz / this.vp.zoom);
    this.vp.zoom = nz;
    this.applyTransform();
  }
  setZoom(z) {
    const r = this.rect();
    this.zoomAt(clamp(z, 0.1, 2.5) / this.vp.zoom, r.left + r.width / 2, r.top + r.height / 2);
  }
  fitView() {
    if (!this.project?.nodes.length) return;
    const nodes = this.project.nodes;
    const minX = Math.min(...nodes.map((n) => n.x || 0));
    const minY = Math.min(...nodes.map((n) => n.y || 0));
    const maxX = Math.max(...nodes.map((n) => (n.x || 0) + (n.w || 268)));
    const maxY = Math.max(...nodes.map((n) => (n.y || 0) + (this.nodeEls.get(n.id)?.offsetHeight || 150)));
    const r = this.rect();
    const z = clamp(Math.min((r.width - 100) / Math.max(1, maxX - minX), (r.height - 100) / Math.max(1, maxY - minY)), 0.1, 1.3);
    this.vp.zoom = z;
    this.vp.x = (r.width - (maxX - minX) * z) / 2 - minX * z;
    this.vp.y = (r.height - (maxY - minY) * z) / 2 - minY * z;
    this.applyTransform();
  }
  focusNode(id) {
    const n = this.project?.nodes.find((x) => x.id === id);
    if (!n) return;
    const r = this.rect();
    this.vp.x = r.width / 2 - ((n.x || 0) + 134) * this.vp.zoom;
    this.vp.y = r.height / 2 - ((n.y || 0) + 80) * this.vp.zoom;
    this.applyTransform();
    this.select([id]);
  }

  /* ---------------- 选择与历史 ---------------- */
  select(ids, additive = false) {
    if (!additive) this.selection.clear();
    for (const id of ids) {
      if (additive && this.selection.has(id)) this.selection.delete(id);
      else this.selection.add(id);
    }
    this.applySelection();
    this.renderEdges();
    this.cb.onSelect?.([...this.selection]);
  }
  applySelection() {
    for (const [id, el] of this.nodeEls) el.classList.toggle('selected', this.selection.has(id));
  }
  getSelection() { return [...this.selection]; }
  selectAll() { this.select(this.project.nodes.map((n) => n.id)); }

  pushHistory() {
    if (!this.project) return;
    this.history.push(clone({ nodes: this.project.nodes, edges: this.project.edges, viewport: { ...this.vp } }));
    if (this.history.length > 30) this.history.shift();
    this.future = [];
  }
  restore(snap) {
    this.project.nodes = snap.nodes;
    this.project.edges = snap.edges;
    this.vp = { ...snap.viewport };
    this.selection.clear();
    this.render();
    this.applyTransform();
  }
  undo() {
    if (!this.history.length) return false;
    this.future.push(clone({ nodes: this.project.nodes, edges: this.project.edges, viewport: { ...this.vp } }));
    this.restore(this.history.pop());
    this.cb.onChange?.('undo');
    return true;
  }
  redo() {
    if (!this.future.length) return false;
    this.history.push(clone({ nodes: this.project.nodes, edges: this.project.edges, viewport: { ...this.vp } }));
    this.restore(this.future.pop());
    this.cb.onChange?.('redo');
    return true;
  }

  /* ---------------- 增删改 ---------------- */
  addNodeAt(type, wx, wy, extra = {}) {
    this.pushHistory();
    const t = typeOf(type);
    const node = {
      id: uid('n'), type, agent: t.agent, title: extra.title || t.label,
      x: Math.round(wx), y: Math.round(wy), w: 268, status: 'idle', progress: 0, error: '',
      data: extra.data || { summary: '双击或右键编辑此节点' }, meta: {},
    };
    this.project.nodes.push(node);
    this.render();
    this.select([node.id]);
    this.cb.onChange?.('node-added');
    return node;
  }
  addEdge(from, to, kind = 'flow') {
    if (from === to) return null;
    if (this.project.edges.some((e) => e.from === from && e.to === to && e.kind === kind)) return null;
    this.pushHistory();
    const edge = { id: uid('e'), from, to, kind };
    this.project.edges.push(edge);
    this.renderEdges();
    this.cb.onChange?.('edge-added');
    return edge;
  }
  deleteSelection() {
    if (!this.selection.size) return;
    this.pushHistory();
    const ids = new Set(this.selection);
    this.project.nodes = this.project.nodes.filter((n) => !ids.has(n.id));
    this.project.edges = this.project.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to));
    this.selection.clear();
    this.render();
    this.cb.onSelect?.([]);
    this.cb.onChange?.('nodes-deleted');
  }
  duplicateSelection() {
    if (!this.selection.size) return;
    this.pushHistory();
    const map = new Map();
    const created = [];
    for (const n of this.project.nodes.filter((x) => this.selection.has(x.id))) {
      const copy = clone(n);
      copy.id = uid('n'); copy.x += 36; copy.y += 36; copy.title = `${n.title} · 副本`;
      copy.status = 'idle'; copy.progress = 0; copy.meta = {};
      map.set(n.id, copy.id);
      this.project.nodes.push(copy);
      created.push(copy.id);
    }
    for (const e of this.project.edges.filter((x) => map.has(x.from) && map.has(x.to))) {
      this.project.edges.push({ id: uid('e'), from: map.get(e.from), to: map.get(e.to), kind: e.kind });
    }
    this.render();
    this.select(created);
    this.cb.onChange?.('nodes-duplicated');
  }
  applyPositions(pos, animate = true) {
    for (const n of this.project.nodes) {
      if (!pos[n.id]) continue;
      n.x = pos[n.id].x; n.y = pos[n.id].y;
      const el = this.nodeEls.get(n.id);
      if (el) {
        if (animate) el.style.transition = 'left .35s cubic-bezier(.2,.8,.2,1), top .35s cubic-bezier(.2,.8,.2,1)';
        el.style.left = `${n.x}px`; el.style.top = `${n.y}px`;
        if (animate) setTimeout(() => { el.style.transition = ''; }, 380);
      }
    }
    this.renderEdges();
    this.drawMinimap();
  }
  setSpace(down) { this.spaceDown = down; this.wrapper.style.cursor = down ? 'grab' : ''; }

  /* ---------------- 小地图 ---------------- */
  drawMinimap() {
    if (!this.miniCanvas || !this.project) return;
    const c = this.miniCanvas, ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    const nodes = this.project.nodes;
    const r = this.rect();
    const vx0 = -this.vp.x / this.vp.zoom, vy0 = -this.vp.y / this.vp.zoom;
    const vw = r.width / this.vp.zoom, vh = r.height / this.vp.zoom;
    const minX = Math.min(vx0, ...nodes.map((n) => n.x || 0)) - 100;
    const minY = Math.min(vy0, ...nodes.map((n) => n.y || 0)) - 100;
    const maxX = Math.max(vx0 + vw, ...nodes.map((n) => (n.x || 0) + 268)) + 100;
    const maxY = Math.max(vy0 + vh, ...nodes.map((n) => (n.y || 0) + 160)) + 100;
    const scale = Math.min((W - 12) / Math.max(1, maxX - minX), (H - 12) / Math.max(1, maxY - minY));
    const ox = (W - (maxX - minX) * scale) / 2 - minX * scale;
    const oy = (H - (maxY - minY) * scale) / 2 - minY * scale;
    this.mini = { scale, minX, minY, ox, oy };
    for (const n of nodes) {
      const t = typeOf(n.type);
      ctx.fillStyle = t.color;
      ctx.globalAlpha = this.selection.has(n.id) ? 1 : 0.62;
      ctx.fillRect((n.x || 0) * scale + ox, (n.y || 0) * scale + oy, Math.max(3, 268 * scale), Math.max(2, 90 * scale));
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#ff8a4c'; ctx.lineWidth = 1.5;
    ctx.strokeRect(vx0 * scale + ox, vy0 * scale + oy, vw * scale, vh * scale);
    ctx.fillStyle = 'rgba(255,138,76,.07)';
    ctx.fillRect(vx0 * scale + ox, vy0 * scale + oy, vw * scale, vh * scale);
  }
  minimapTo(sx, sy) {
    if (!this.mini) return;
    const rect = this.miniCanvas.getBoundingClientRect();
    const { scale, ox, oy } = this.mini;
    const wx = ((sx - rect.left) * (this.miniCanvas.width / rect.width) - ox) / scale;
    const wy = ((sy - rect.top) * (this.miniCanvas.height / rect.height) - oy) / scale;
    const r = this.rect();
    this.vp.x = r.width / 2 - wx * this.vp.zoom;
    this.vp.y = r.height / 2 - wy * this.vp.zoom;
    this.applyTransform();
  }

  /* ---------------- 交互 ---------------- */
  bind() {
    this.wrapper.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
    }, { passive: false });

    this.wrapper.addEventListener('dblclick', (e) => {
      const el = e.target.closest('.node');
      if (el) this.cb.onDblClick?.(el.dataset.id);
    });
    this.wrapper.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const el = e.target.closest('.node');
      this.cb.onContextMenu?.(el?.dataset.id || null, e.clientX, e.clientY);
    });

    this.wrapper.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      const portOut = e.target.closest('.port-out');
      const nodeEl = e.target.closest('.node');
      const panMode = this.spaceDown || e.button === 1 || e.altKey && !nodeEl;
      if (portOut && nodeEl) {
        e.preventDefault();
        this.drag = { type: 'connect', from: nodeEl.dataset.id, sx: e.clientX, sy: e.clientY };
        this.connectLine.hidden = false;
        return;
      }
      if (nodeEl && !panMode) {
        const id = nodeEl.dataset.id;
        if (e.shiftKey) this.select([id], true);
        else if (!this.selection.has(id)) this.select([id]);
        const nodes = this.project.nodes.filter((n) => this.selection.has(n.id));
        this.drag = {
          type: 'node', sx: e.clientX, sy: e.clientY, moved: false, historyPushed: false,
          before: clone({ nodes: this.project.nodes, edges: this.project.edges, viewport: { ...this.vp } }),
          starts: nodes.map((n) => ({ id: n.id, x: n.x || 0, y: n.y || 0 })),
        };
        for (const n of nodes) this.nodeEls.get(n.id)?.classList.add('dragging');
        return;
      }
      if (panMode) {
        this.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, x: this.vp.x, y: this.vp.y };
        this.wrapper.style.cursor = 'grabbing';
        return;
      }
      this.drag = { type: 'box', sx: e.clientX, sy: e.clientY };
      this.selectionBox.hidden = false;
    });

    window.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) return;
      if (d.type === 'pan') {
        this.vp.x = d.x + (e.clientX - d.sx);
        this.vp.y = d.y + (e.clientY - d.sy);
        this.applyTransform();
      } else if (d.type === 'node') {
        const dx = (e.clientX - d.sx) / this.vp.zoom;
        const dy = (e.clientY - d.sy) / this.vp.zoom;
        if (Math.abs(dx) + Math.abs(dy) > 2) {
          if (!d.moved && !d.historyPushed) {
            this.history.push(d.before);
            if (this.history.length > 30) this.history.shift();
            this.future = [];
            d.historyPushed = true;
          }
          d.moved = true;
        }
        for (const s of d.starts) {
          const n = this.project.nodes.find((x) => x.id === s.id);
          if (!n) continue;
          n.x = Math.round(s.x + dx); n.y = Math.round(s.y + dy);
          const el = this.nodeEls.get(s.id);
          if (el) { el.style.left = `${n.x}px`; el.style.top = `${n.y}px`; }
        }
        this.scheduleEdges();
      } else if (d.type === 'box') {
        const r = this.rect();
        const x = Math.min(d.sx, e.clientX) - r.left, y = Math.min(d.sy, e.clientY) - r.top;
        const w = Math.abs(e.clientX - d.sx), h = Math.abs(e.clientY - d.sy);
        Object.assign(this.selectionBox.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
      } else if (d.type === 'connect') {
        const from = this.project.nodes.find((n) => n.id === d.from);
        const el = this.nodeEls.get(d.from);
        const start = this.worldToScreen((from?.x || 0) + (from?.w || 268), (from?.y || 0) + (el?.offsetHeight || 130) / 2);
        const r = this.rect();
        const x1 = start.x - r.left, y1 = start.y - r.top;
        const x2 = e.clientX - r.left, y2 = e.clientY - r.top;
        const dx = Math.max(50, Math.abs(x2 - x1) * 0.45);
        this.connectPath.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
      }
    });

    window.addEventListener('pointerup', (e) => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      this.connectLine.hidden = true;
      this.selectionBox.hidden = true;
      this.wrapper.style.cursor = this.spaceDown ? 'grab' : '';
      if (d.type === 'node') {
        for (const s of d.starts) this.nodeEls.get(s.id)?.classList.remove('dragging');
        if (d.moved) { this.cb.onChange?.('nodes-moved'); this.drawMinimap(); }
      } else if (d.type === 'box') {
        const a = this.screenToWorld(d.sx, d.sy);
        const b = this.screenToWorld(e.clientX, e.clientY);
        const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
        const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
        if (x2 - x1 < 4 && y2 - y1 < 4) this.select([], false);
        else {
          const hits = this.project.nodes.filter((n) => {
            const h = this.nodeEls.get(n.id)?.offsetHeight || 150;
            return (n.x || 0) < x2 && (n.x || 0) + (n.w || 268) > x1 && (n.y || 0) < y2 && (n.y || 0) + h > y1;
          }).map((n) => n.id);
          this.select(hits, e.shiftKey);
        }
      } else if (d.type === 'connect') {
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const target = hit?.closest('.node');
        const to = target?.dataset.id;
        const info = {
          from: d.from, to: to && to !== d.from ? to : null,
          clientX: e.clientX, clientY: e.clientY,
          world: this.screenToWorld(e.clientX, e.clientY),
          overCanvas: !!hit?.closest('#canvas-stage'),
          altKey: e.altKey, shiftKey: e.shiftKey,
        };
        // 交给 UI 层弹「选择下一个节点 / 连接关系」浮层；未挂回调时沿用直接连线的旧行为
        if (this.cb.onConnectDrop) this.cb.onConnectDrop(info);
        else if (info.to) this.addEdge(d.from, info.to, e.altKey ? 'anchor' : e.shiftKey ? 'ref' : 'flow');
      }
    });

    this.miniCanvas?.addEventListener('pointerdown', (e) => {
      this.drag = { type: 'minimap' };
      this.minimapTo(e.clientX, e.clientY);
      const move = (ev) => this.minimapTo(ev.clientX, ev.clientY);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); this.drag = null; };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }
}
