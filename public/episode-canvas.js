/* ============================================================================
 * 剧集资源无限画布：展示「章节 → 本集 → 段落 → 宫格图 / 角色 / 剧本 / 产物」
 * 以及项目真实画布上的连线关系。
 *
 * 与 public/canvas.js 的区别：这是只读的资源关系视图，自带平移 / 缩放 / 节点拖动 /
 * 点击检查器，不依赖任何全局 DOM id，可反复挂载在剧集详情页里。
 * ==========================================================================*/
const esc = (s = '') => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const NODE_W = 208;
const NODE_H = 78;
const COLORS = {
  episode: '#ff8a4c', chapter: '#8b9bff', segment: '#38bdf8', grid: '#34d399',
  character: '#f472b6', script: '#fbbf24', pack: '#a78bfa', video: '#fb7185', canvas: '#94a3b8',
};
const KIND_LABEL = {
  episode: '本集', chapter: '章节', segment: '段落', grid: '宫格图',
  character: '角色', script: '剧本', pack: '导演包', video: '视频', canvas: '画布节点',
};

/**
 * @param {HTMLElement} host 容器（内容会被替换）
 * @param {Object} graph {nodes:[{id,kind,label,sub,x,y,url,nodeId}], edges:[{from,to,kind,label}]}
 * @param {Object} opts {onSelect(node), onOpenNodeInCanvas(nodeId)}
 */
export function mountEpisodeCanvas(host, graph, opts = {}) {
  if (!host) return;
  const nodes = (graph?.nodes || []).map((n) => ({ ...n, x: Number(n.x) || 0, y: Number(n.y) || 0 }));
  const edges = graph?.edges || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const vp = { x: 40, y: 20, z: 0.72 };
  host.innerHTML = `<div class="ecv">
    <div class="ecv-toolbar">
      <button data-ecv="in" title="放大">＋</button><span class="ecv-zoom">72%</span><button data-ecv="out" title="缩小">－</button>
      <button data-ecv="fit" title="适应全部资源">⤢ 适应视图</button>
      <span class="ecv-tip">拖拽空白处平移 · 滚轮缩放 · 拖动节点重排 · 点击查看资源</span>
      <span class="ecv-count">${nodes.length} 个资源 · ${edges.length} 条链接</span>
    </div>
    <div class="ecv-stage">
      <div class="ecv-world">
        <svg class="ecv-edges" width="4200" height="3200" xmlns="http://www.w3.org/2000/svg"></svg>
        <div class="ecv-nodes"></div>
      </div>
      <div class="ecv-empty" ${nodes.length ? 'hidden' : ''}>暂无资源链接，先生成宫格图或剧本后再来看</div>
    </div>
    <div class="ecv-inspector" hidden></div>
  </div>`;

  const stage = host.querySelector('.ecv-stage');
  const world = host.querySelector('.ecv-world');
  const svg = host.querySelector('.ecv-edges');
  const layer = host.querySelector('.ecv-nodes');
  const zoomLabel = host.querySelector('.ecv-zoom');
  const inspector = host.querySelector('.ecv-inspector');

  const applyTransform = () => {
    world.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.z})`;
    if (zoomLabel) zoomLabel.textContent = `${Math.round(vp.z * 100)}%`;
  };
  const center = (n) => ({ x: n.x + NODE_W, y: n.y + NODE_H / 2 });
  const start = (n) => ({ x: n.x, y: n.y + NODE_H / 2 });

  function drawEdges() {
    const paths = [];
    for (const e of edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      const p1 = center(a), p2 = start(b);
      const dx = Math.max(48, Math.abs(p2.x - p1.x) * 0.45);
      const d = `M${p1.x} ${p1.y} C${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`;
      const color = e.kind === 'ref' ? '#8b9bff' : e.kind === 'anchor' ? '#fbbf24' : '#4a5c78';
      paths.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-opacity="0.75" ${e.kind === 'ref' ? 'stroke-dasharray="6 5"' : ''}/>`);
      if (e.label) {
        paths.push(`<text x="${(p1.x + p2.x) / 2}" y="${(p1.y + p2.y) / 2 - 7}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(e.label)}</text>`);
      }
    }
    svg.innerHTML = paths.join('');
  }

  function drawNodes() {
    layer.innerHTML = nodes.map((n) => {
      const c = COLORS[n.kind] || '#8b9bff';
      const thumb = n.url && n.kind === 'grid'
        ? `<img class="ecv-thumb" src="${esc(n.url)}" alt="">` : '';
      return `<div class="ecv-node st-${esc(n.state || 'idle')}" data-id="${esc(n.id)}" style="left:${n.x}px;top:${n.y}px;--nc:${c}">
        <span class="ecv-node-kind">${KIND_LABEL[n.kind] || n.kind}</span>
        <strong title="${esc(n.label)}">${esc(n.label)}</strong>
        <small title="${esc(n.sub || '')}">${esc(n.sub || '')}</small>
        ${thumb}
        <i class="ecv-port"></i>
      </div>`;
    }).join('');
  }

  function select(n) {
    const c = COLORS[n.kind] || '#8b9bff';
    inspector.hidden = false;
    inspector.innerHTML = `<div class="ecv-ins-head"><span style="--nc:${c}">${KIND_LABEL[n.kind] || n.kind}</span><button data-ecv="close">✕</button></div>
      <strong>${esc(n.label)}</strong>
      <p>${esc(n.sub || '')}</p>
      ${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener">↗ 打开资源</a>` : ''}
      ${n.nodeId ? `<button class="btn sm" data-ecv="gocanvas">⬡ 在项目画布中定位</button>` : ''}
      <div class="ecv-ins-meta">坐标 ${Math.round(n.x)}, ${Math.round(n.y)} · ID ${esc(n.id)}</div>`;
    inspector.querySelector('[data-ecv="close"]').addEventListener('click', () => { inspector.hidden = true; });
    inspector.querySelector('[data-ecv="gocanvas"]')?.addEventListener('click', () => opts.onOpenNodeInCanvas?.(n.nodeId));
    opts.onSelect?.(n);
  }

  function fit() {
    if (!nodes.length) return;
    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    const maxX = Math.max(...nodes.map((n) => n.x + NODE_W));
    const maxY = Math.max(...nodes.map((n) => n.y + NODE_H));
    const rect = stage.getBoundingClientRect();
    const z = Math.max(0.28, Math.min(1.15, Math.min((rect.width - 80) / (maxX - minX + 80), (rect.height - 80) / (maxY - minY + 80))));
    vp.z = z;
    vp.x = (rect.width - (maxX - minX) * z) / 2 - minX * z;
    vp.y = (rect.height - (maxY - minY) * z) / 2 - minY * z;
    applyTransform();
  }

  // 节点：点击选中 / 拖动重排
  let drag = null;
  layer.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.ecv-node');
    if (!el) return;
    const n = byId.get(el.dataset.id);
    if (!n) return;
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    drag = { n, el, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y, moved: false };
  });
  layer.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.sx) / vp.z;
    const dy = (e.clientY - drag.sy) / vp.z;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    drag.n.x = Math.round(drag.ox + dx);
    drag.n.y = Math.round(drag.oy + dy);
    drag.el.style.left = `${drag.n.x}px`;
    drag.el.style.top = `${drag.n.y}px`;
    drawEdges();
  });
  layer.addEventListener('pointerup', () => {
    if (drag && !drag.moved) select(drag.n);
    drag = null;
  });

  // 画布平移
  let pan = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.ecv-node') || e.button !== 0) return;
    pan = { sx: e.clientX, sy: e.clientY, ox: vp.x, oy: vp.y };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('panning');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pan) return;
    vp.x = pan.ox + e.clientX - pan.sx;
    vp.y = pan.oy + e.clientY - pan.sy;
    applyTransform();
  });
  const endPan = () => { pan = null; stage.classList.remove('panning'); };
  stage.addEventListener('pointerup', endPan);
  stage.addEventListener('pointercancel', endPan);

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const next = Math.max(0.2, Math.min(2, vp.z * (e.deltaY < 0 ? 1.12 : 0.89)));
    vp.x = mx - (mx - vp.x) * (next / vp.z);
    vp.y = my - (my - vp.y) * (next / vp.z);
    vp.z = next;
    applyTransform();
  }, { passive: false });

  host.querySelector('.ecv-toolbar').addEventListener('click', (e) => {
    const act = e.target.closest('[data-ecv]')?.dataset.ecv;
    if (act === 'in') { vp.z = Math.min(2, vp.z * 1.2); applyTransform(); }
    if (act === 'out') { vp.z = Math.max(0.2, vp.z / 1.2); applyTransform(); }
    if (act === 'fit') fit();
  });

  drawNodes();
  drawEdges();
  applyTransform();
  requestAnimationFrame(fit);
}
