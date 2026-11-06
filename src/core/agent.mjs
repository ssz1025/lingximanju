// Agent 基类：注册表 + 执行上下文。编排器只依赖这里的接口。
import { uid } from './store.mjs';
import { emit } from './events.mjs';

const registry = new Map();

/** 节点类型 → 默认智能体（用户手动拖入的节点也能运行） */
export const TYPE_AGENT = {
  idea: 'screenwriter', script: 'decomposer', plan: 'decomposer', rag: 'rag',
  event: 'rag', scene: 'storyboard', storyboard: 'storyboard', shot: 'keyframe',
  character: 'character', camera: 'camera-graph', keyframe: 'keyframe',
  review: 'review', video: 'video', transition: 'transition', final: 'composer', note: null,
};

export function defineAgent(def) {
  if (!def?.id || typeof def.run !== 'function') throw new Error('defineAgent 需要 id 与 run');
  registry.set(def.id, { group: '通用', icon: '◇', ...def });
  return def;
}

export function getAgent(id) { return registry.get(id) || null; }

export function listAgents() {
  return [...registry.values()].map(({ run, ...meta }) => meta);
}

export function makeNode({ type, agent, title, x = 0, y = 0, data = {}, status = 'idle', id }) {
  return {
    id: id || uid('n'), type, agent: agent === undefined ? TYPE_AGENT[type] : agent,
    title: title || type, x, y, w: 268, status, progress: 0, error: '',
    data, meta: {},
  };
}

export function makeEdge(from, to, kind = 'flow') {
  return { id: uid('e'), from, to, kind };
}

/**
 * 构造一次 Agent 执行的上下文。
 * runCtx 由编排器注入：{ project, node, inputs, upstream, providers, signal, runState }
 */
export function buildContext(runCtx) {
  const { project, node, inputs, upstream, providers, signal, runState, settings } = runCtx;
  const projectId = project.id;
  const touch = () => { project.updatedAt = Date.now(); runState.dirty = true; };

  return {
    project, node, inputs, upstream, providers, settings: settings || project.settings || {}, signal,
    log(level, message) {
      emit('log', { projectId, runId: runState.runId, level, agent: node.agent, nodeId: node.id, message: String(message) });
    },
    progress(value) {
      node.progress = Math.max(0, Math.min(1, Number(value) || 0));
      emit('node:status', { projectId, runId: runState.runId, nodeId: node.id, status: 'running', progress: node.progress });
    },
    patch(obj = {}) {
      node.data = { ...(node.data || {}), ...obj };
      touch();
      emit('node:data', { projectId, runId: runState.runId, nodeId: node.id, patch: obj });
    },
    setTitle(title) {
      node.title = title;
      touch();
      emit('node:data', { projectId, runId: runState.runId, nodeId: node.id, patch: { __title: title } });
    },
    addNodes(nodes = []) {
      const created = nodes.map((n) => makeNode(n));
      project.nodes.push(...created);
      for (const n of created) {
        emit('node:add', { projectId, runId: runState.runId, node: n });
        if (n.agent) runState.pending.add(n.id);
      }
      touch();
      return created;
    },
    addEdges(edges = []) {
      const created = edges.map((e) => (e.id ? e : makeEdge(e.from, e.to, e.kind)));
      project.edges.push(...created);
      for (const e of created) emit('edge:add', { projectId, runId: runState.runId, edge: e });
      touch();
      return created;
    },
    addNodeAndEdge(nodeDef, fromId, kind = 'flow') {
      const src = fromId ? project.nodes.find((n) => n.id === fromId) : null;
      const baseX = (src ? src.x : node.x || 0) + 320;
      // 只统计「同一个父节点」已有的子节点数，让兄弟节点在父节点下方整齐排开。
      // 旧实现统计同一 x 列的全图节点，导致 y 随每次生成不断累加，最终把画布拉成
      // 一条数千像素高的对角长龙（节点全部跑到视口外，看起来像空画布）。
      const siblings = fromId ? project.edges.filter((e) => e.from === fromId).length : 0;
      const baseY = (src ? src.y : node.y || 0) + Math.min(siblings, 5) * 190;
      const [created] = this.addNodes([{ x: baseX, y: baseY, ...nodeDef }]);
      if (fromId) this.addEdges([{ from: fromId, to: created.id, kind }]);
      return created;
    },
  };
}
