// 图算法：DAG 校验、拓扑分层、上下游子图、自动布局
export function indexEdges(edges = []) {
  const out = new Map(), inc = new Map();
  for (const e of edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    if (!inc.has(e.to)) inc.set(e.to, []);
    out.get(e.from).push(e.to);
    inc.get(e.to).push(e.from);
  }
  return { out, inc };
}

export function descendants(edges, rootId) {
  const { out } = indexEdges(edges);
  const seen = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of out.get(cur) || []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen;
}

export function ancestors(edges, nodeId) {
  const { inc } = indexEdges(edges);
  const seen = new Set([nodeId]);
  const queue = [nodeId];
  while (queue.length) {
    const cur = queue.shift();
    for (const prev of inc.get(cur) || []) {
      if (!seen.has(prev)) { seen.add(prev); queue.push(prev); }
    }
  }
  return seen;
}

/** Kahn 分层：同一层内的节点互不依赖，可并发执行 */
export function topoLayers(nodes = [], edges = []) {
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const indeg = new Map(ids.map((id) => [id, 0]));
  const out = new Map(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (!idSet.has(e.from) || !idSet.has(e.to) || e.from === e.to) continue;
    out.get(e.from).push(e.to);
    indeg.set(e.to, indeg.get(e.to) + 1);
  }
  const layers = [];
  let frontier = ids.filter((id) => indeg.get(id) === 0);
  const visited = new Set();
  while (frontier.length) {
    layers.push(frontier);
    const next = [];
    for (const id of frontier) {
      visited.add(id);
      for (const to of out.get(id)) {
        indeg.set(to, indeg.get(to) - 1);
        if (indeg.get(to) === 0 && !visited.has(to)) next.push(to);
      }
    }
    frontier = [...new Set(next)];
  }
  return { layers, order: layers.flat(), hasCycle: visited.size < ids.length, cycles: ids.filter((id) => !visited.has(id)) };
}

/** 只保留指定节点集合内部的边 */
export function subgraph(nodes, edges, idSet) {
  return {
    nodes: nodes.filter((n) => idSet.has(n.id)),
    edges: edges.filter((e) => idSet.has(e.from) && idSet.has(e.to)),
  };
}

/** 拓扑分层自动布局，返回 {id: {x,y}} */
export function autoLayout(nodes = [], edges = [], opts = {}) {
  const gapX = opts.gapX ?? 300;
  const gapY = opts.gapY ?? 190;
  const originX = opts.originX ?? 60;
  const originY = opts.originY ?? 60;
  // anchor（视觉锚点）与 ref（资产引用）不是执行依赖，不参与分层；
  // 若把它们算进 DAG，一张 11 层的图会被拉成 18 层的长条，画布宽到无法阅读。
  const depEdges = opts.allEdges ? edges : edges.filter((e) => !e.kind || e.kind === 'flow');
  const { layers, hasCycle, cycles } = topoLayers(nodes, depEdges);
  const positions = {};
  const maxRows = Math.max(...layers.map((l) => l.length), 1);
  layers.forEach((layer, li) => {
    const columnHeight = layer.length * gapY;
    const offsetY = originY + Math.max(0, (maxRows * gapY - columnHeight) / 2);
    layer.forEach((id, ri) => {
      positions[id] = { x: originX + li * gapX, y: offsetY + ri * gapY };
    });
  });
  if (hasCycle) {
    cycles.forEach((id, i) => { positions[id] = { x: originX, y: originY + (maxRows + i + 1) * gapY }; });
  }
  return positions;
}

export function validate(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id));
  const bad = edges.filter((e) => !ids.has(e.from) || !ids.has(e.to));
  const { hasCycle, cycles } = topoLayers(nodes, edges);
  return { ok: bad.length === 0 && !hasCycle, dangling: bad.length, cycles };
}
