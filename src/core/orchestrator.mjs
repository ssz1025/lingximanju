// 编排器：拓扑分层 → 同层并发 → 状态机 → 事件 → 取消 / 断点续跑
import { loadProject, saveProject } from './store.mjs';
import { emit } from './events.mjs';
import { topoLayers, descendants, indexEdges } from './graph.mjs';
import { getAgent, TYPE_AGENT, buildContext } from './agent.mjs';
import { createProviders } from './providers.mjs';
import { resolveComfyConfig } from './comfy-config.mjs';
import { resolveModelSettings } from './app-settings.mjs';
import { uid } from './store.mjs';

const activeRuns = new Map();
export const isRunning = (projectId) => activeRuns.has(projectId);

export function stopProject(projectId) {
  const run = activeRuns.get(projectId);
  if (!run) return false;
  run.controller.abort();
  emit('log', { projectId, runId: run.runId, level: 'warn', message: '收到取消指令，正在停止队列中的任务…' });
  return true;
}

/**
 * 计算本次运行的目标节点。
 * scope（可选）是「创作项目六步任务」传入的节点类型白名单：只调度该步对应的节点，
 * 动态展开出的其它阶段节点留给后续步骤。不传 scope 时保持原来的「跑完整流水线」行为。
 */
function computeTargets(project, nodeId, scope) {
  const { edges, nodes } = project;
  if (nodeId) return descendants(edges, nodeId);
  const types = new Set(scope || []);
  const inScope = (id) => !types.size || types.has(nodes.find((n) => n.id === id)?.type);
  const roots = nodes.filter((n) => (n.status === 'idle' || n.status === 'error') && inScope(n.id)).map((n) => n.id);
  const set = new Set();
  for (const id of roots) for (const d of descendants(edges, id)) if (inScope(d)) set.add(d);
  return set;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function runProject(projectId, opts = {}) {
  const project = opts.project || loadProject(projectId);
  if (!project) throw new Error('项目不存在');
  if (activeRuns.has(projectId)) throw new Error('该项目已有运行中的任务');

  const controller = new AbortController();
  const { signal } = controller;
  const runId = uid('run');
  const startedAt = Date.now();
  const runState = { runId, pending: new Set(), dirty: false };
  activeRuns.set(projectId, { controller, runId, startedAt });

  // ComfyUI 连接与 workflow 模板是全局配置；模型走全局模型库（对话框可选 modelId），
  // 项目 settings 可局部覆盖产出模式；图片规格（宽高/步数/CFG）由画幅自动决定
  const settings = {
    ...resolveModelSettings(project, opts.modelId),
    comfy: resolveComfyConfig(project),
  };
  const concurrency = Math.max(1, Math.min(8, Number(settings.concurrency) || 3));
  const scopeTypes = new Set(opts.scope || []);
  const inScope = (id) => !scopeTypes.size || scopeTypes.has(project.nodes.find((n) => n.id === id)?.type);
  const providers = createProviders(settings, (level, message) =>
    emit('log', { projectId, runId, level, message }),
  // Token 归集：providers 每次真实 LLM 调用回调一次 → 运行级累加并实时广播
  (record) => {
    stats.tokens.prompt += record.promptTokens || 0;
    stats.tokens.completion += record.completionTokens || 0;
    stats.tokens.total += record.totalTokens || 0;
    stats.tokens.calls += record.calls || 0;
    if (record.fallback) stats.fallbacks += 1;
    emit('llm:usage', { projectId, runId, ...record, tokens: { ...stats.tokens } });
  });

  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; try { saveProject(project); } catch { /* ignore */ } }, 120);
  };
  const flush = () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try { saveProject(project); } catch { /* ignore */ }
  };

  emit('run:start', { projectId, runId, mode: providers.mode, comfy: providers.comfyActive, concurrency, nodeId: opts.nodeId || null });
  emit('log', { projectId, runId, level: 'info', message: `启动编排 · LLM=${providers.mode} · 生成后端=${providers.comfyActive ? '本地 ComfyUI' : 'Mock 自绘'} · 并发=${concurrency} · best-of-k=${settings.k || 2}` });

  const stats = { waves: 0, executed: 0, failed: 0, cost: 0, fallbacks: 0,
    tokens: { prompt: 0, completion: 0, total: 0, calls: 0 } };
  let outcome = 'done';

  try {
    const targets = computeTargets(project, opts.nodeId, opts.scope);
    if (!targets.size) {
      emit('log', { projectId, runId, level: 'info', message: '没有待执行节点（全部已完成），如需重算请右键节点选择「从此处重跑」。' });
    } else {
      for (const id of targets) {
        const node = project.nodes.find((n) => n.id === id);
        if (node && node.status !== 'done') {
          node.status = 'queued'; node.progress = 0; node.error = '';
          emit('node:status', { projectId, runId, nodeId: id, status: 'queued', progress: 0 });
        }
      }
      scheduleSave();

      const waiting = new Set(); // 等待动态分支的汇聚节点，暂不参与层选择
      while ((targets.size || waiting.size) && !signal.aborted && stats.waves < 60) {
        // 只有当其它可运行节点全部处理完，才把等待中的汇聚节点放回队列
        if (!targets.size) {
          for (const id of waiting) targets.add(id);
          waiting.clear();
          runState.forceJoin = true;
        }
        const { layers } = topoLayers(project.nodes, project.edges);
        const layerOf = new Map();
        layers.forEach((ids, i) => ids.forEach((id) => layerOf.set(id, i)));

        // 上游失败 → 跳过下游
        const { inc } = indexEdges(project.edges);
        for (const id of [...targets]) {
          const parents = (inc.get(id) || []).map((pid) => project.nodes.find((n) => n.id === pid)).filter(Boolean);
          if (parents.some((p) => p.status === 'error' || p.status === 'skipped')) {
            const node = project.nodes.find((n) => n.id === id);
            if (node) {
              node.status = 'skipped'; node.error = '上游节点未完成';
              emit('node:status', { projectId, runId, nodeId: id, status: 'skipped', progress: 0 });
            }
            targets.delete(id);
          }
        }
        if (!targets.size) break;

        const layerNumbers = [...targets].map((id) => layerOf.get(id) ?? 0);
        const minLayer = Math.min(...layerNumbers);
        const wave = [...targets].filter((id) => (layerOf.get(id) ?? 0) === minLayer);
        stats.waves += 1;
        emit('log', { projectId, runId, level: 'info', message: `第 ${stats.waves} 波：${wave.length} 个节点就绪，按并发 ${concurrency} 调度` });

        const deferred = new Set();
        for (const batch of chunk(wave, concurrency)) {
          if (signal.aborted) break;
          const results = await Promise.allSettled(batch.map((id) => executeNode(id)));
          results.forEach((r, i) => {
            if (r.status === 'fulfilled' && r.value?.deferred) deferred.add(batch[i]);
          });
        }
        for (const id of wave) {
          targets.delete(id);
          if (deferred.has(id)) waiting.add(id);
        }
        // 运行中动态展开的节点加入后续波次
        for (const id of runState.pending) {
          if (!targets.has(id) && !waiting.has(id)) {
            const n = project.nodes.find((x) => x.id === id);
            if (n && (n.status === 'idle' || n.status === 'queued') && inScope(id)) targets.add(id);
          }
        }
        runState.pending.clear();
        scheduleSave();
      }
    }
    if (signal.aborted) outcome = 'cancelled';
  } catch (err) {
    outcome = 'error';
    emit('log', { projectId, runId, level: 'error', message: `编排异常：${err.message}` });
  } finally {
    flush();
    activeRuns.delete(projectId);
  }

  async function executeNode(nodeId) {
    const node = project.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    // 汇聚节点（join）：等待运行中动态生成的分支全部完成
    const join = node.data?.join;
    if (join && !runState.forceJoin) {
      const peers = project.nodes.filter((n) => n.type === join.type);
      const unfinished = peers.filter((n) => n.status !== 'done' && n.status !== 'skipped');
      if (peers.length < (join.min || 1) || unfinished.length) return { deferred: true };
    }
    const agent = getAgent(node.agent || TYPE_AGENT[node.type]);
    const parents = project.edges.filter((e) => e.to === nodeId)
      .map((e) => project.nodes.find((n) => n.id === e.from)).filter(Boolean);
    if (!agent) {
      node.status = 'skipped';
      emit('node:status', { projectId, runId, nodeId, status: 'skipped', progress: 0 });
      emit('log', { projectId, runId, level: 'warn', message: `「${node.title}」没有绑定智能体，已跳过` });
      return;
    }

    const ctx = buildContext({
      project, node, inputs: parents.map((p) => p.data || {}), upstream: parents,
      providers, signal, runState, settings,
    });
    node.status = 'running'; node.progress = 0.05; node.error = '';
    emit('node:status', { projectId, runId, nodeId, status: 'running', progress: 0.05 });
    ctx.log('think', `${agent.label} 正在处理「${node.title}」…`);
    const t0 = Date.now();
    const fallbacksBefore = stats.fallbacks;

    try {
      await agent.run(ctx);
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      node.status = 'done'; node.progress = 1; node.error = '';
      const durationMs = Date.now() - t0;
      const cost = agent.group === '生成' ? 0.045 : agent.group === '叙事' ? 0.012 : 0.006;
      node.meta = { ...(node.meta || {}), durationMs, cost, runId, provider: providers.mode,
        llmFallback: stats.fallbacks - fallbacksBefore };
      stats.executed += 1; stats.cost += cost;
      emit('node:status', { projectId, runId, nodeId, status: 'done', progress: 1 });
      emit('node:data', { projectId, runId, nodeId, data: node.data });
      ctx.log('info', `${agent.label} 完成 · ${durationMs}ms · $${cost.toFixed(3)}`);
    } catch (err) {
      if (err?.name === 'AbortError' || signal.aborted) {
        node.status = 'idle'; node.progress = 0;
        emit('node:status', { projectId, runId, nodeId, status: 'idle', progress: 0 });
        return;
      }
      node.status = 'error'; node.error = err?.message || String(err);
      stats.failed += 1;
      emit('node:status', { projectId, runId, nodeId, status: 'error', progress: node.progress, error: node.error });
      ctx.log('error', `「${node.title}」失败：${node.error}`);
    }
    scheduleSave();
  }

  const finishedAt = Date.now();
  const summary = {
    id: runId, startedAt, finishedAt, status: outcome,
    nodeCount: stats.executed, waves: stats.waves, failed: stats.failed, fallbacks: stats.fallbacks,
    durationMs: finishedAt - startedAt, cost: Number(stats.cost.toFixed(3)), provider: providers.mode,
    tokens: { ...stats.tokens },
  };
  project.runs = [summary, ...(project.runs || [])].slice(0, 20);
  flush();
  emit(outcome === 'done' ? 'run:done' : 'run:error', {
    projectId, runId, status: outcome, summary,
    message: outcome === 'cancelled' ? '运行已取消' : outcome === 'error' ? '运行异常结束' : '编排完成',
  });
  return summary;
}
