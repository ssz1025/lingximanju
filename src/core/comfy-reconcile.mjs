// ComfyUI 任务对账：把「ComfyUI 已经跑完、但页面还显示排队中」的任务认领回来
//
// 为什么需要这一层：节点状态存在项目 JSON 里，而「正在跑」只活在本进程内存。
// 服务重启、请求超时、手动取消之后，画布上会留下 status=queued/running 的节点，
// 但 ComfyUI 那边的队列和历史是独立进程，图很可能已经出好了。
// 过去点「执行本步」会把这些残留节点一律复位成 idle 再全量重烧——既费卡又丢结果。
//
// 对账口径（唯一事实来源是 ComfyUI 自己的 /queue 与 /history）：
//   ① prompt_id 命中历史且有产物  → 下载产物写回节点，标记完成（不重新生成）
//   ② prompt_id 命中历史但执行失败 → 标记失败，带上 ComfyUI 的报错
//   ③ prompt_id 还在队列          → 保留「排队 / 生成中」，不重发
//   ④ 都没有 → 按产物文件名前缀（lingximanju_keyframe_12_…）+ 时间窗兜底匹配
//   ⑤ 兜底也找不到 → 认定这条从未真正发出 / 结果已被 ComfyUI 清空 → 复位为待执行
import { loadProject, saveProject } from './store.mjs';
import { emit } from './events.mjs';
import { resolveComfyConfig } from './comfy-config.mjs';
import {
  fetchComfySnapshot, downloadHistoryOutputs, historyPromptGraph, historyFilenamePrefix,
  parseArtifactPrefix, historyStartedAt, historyOutcome,
} from './comfyui.mjs';

/** 会真正提交到 ComfyUI 的节点类型 → 产物文件名前缀里的类别 */
const KIND_BY_TYPE = { keyframe: 'keyframe', video: 'clip', transition: 'transition' };
const GEN_TYPES = new Set(Object.keys(KIND_BY_TYPE));
/** 时间窗容差：节点 queuedAt 与 ComfyUI execution_start 之间的时钟 / 链路误差 */
const MATCH_SLACK_MS = 30_000;
/** 判过「查无结果」的节点还能被追认的时长：覆盖「判定时还没跑完、随后才出图」的情况 */
const LOST_GRACE_MS = 30 * 60_000;

/** 节点上所有可能的 prompt_id（提交时写 meta，完成后写候选 / 片段） */
export function nodePromptIds(node) {
  const out = [];
  const meta = node?.meta || {};
  if (meta.promptId) out.push(meta.promptId);
  for (const id of Array.isArray(meta.promptIds) ? meta.promptIds : []) if (id) out.push(id);
  for (const c of Array.isArray(node?.data?.candidates) ? node.data.candidates : []) {
    if (c?.promptId) out.push(c.promptId);
  }
  if (node?.data?.clip?.promptId) out.push(node.data.clip.promptId);
  if (node?.data?.transition?.video?.promptId) out.push(node.data.transition.video.promptId);
  return [...new Set(out)];
}

/** ComfyUI 历史 → 可检索条目（只保留本项目前缀，其他任务不参与兜底匹配） */
export function buildHistoryEntries(history) {
  const entries = [];
  for (const [promptId, item] of Object.entries(history || {})) {
    const graph = historyPromptGraph(item);
    const prefix = historyFilenamePrefix(graph);
    const tag = parseArtifactPrefix(prefix);
    const outcome = historyOutcome(item);
    entries.push({
      promptId, prefix, tag,
      at: historyStartedAt(item),
      state: outcome.state,
      error: outcome.error || '',
      outputs: outcome.outputs,
      item,
      claimed: false,
    });
  }
  return entries.sort((a, b) => (a.at || 0) - (b.at || 0));
}

/** 节点对应的镜号：关键帧 / 视频节点都从 shot 或 sequence 上取 */
function shotNoOf(node) {
  const shot = node?.data?.shot || {};
  const n = Number(shot.shotNo ?? node?.data?.sequence ?? shot.sequence);
  return Number.isFinite(n) ? n : null;
}

/**
 * 兜底匹配：升级前的任务没写 prompt_id，只能靠「产物前缀 + 镜号 + 时间窗」认。
 * 只在未被认领的条目里挑最晚的一条，避免把上一轮的旧图当成这次的结果。
 *
 * 前缀里的镜号并不总是存在：转场图统一叫 lingximanju_transition_1_（第 1 个参数是固定值），
 * 视频老任务也可能没有镜号。这种情况下如果同类型还有多条残留节点，任何配对都是猜的 ——
 * 宁可判「查无结果」让用户重发，也不能把 A 段的画面挂到 B 段上。只有同类型只剩一条时
 * 才允许这种宽松匹配（opts.allowLoose）。
 */
export function fuzzyMatchEntry(entries, node, opts = {}) {
  const kind = KIND_BY_TYPE[node?.type];
  if (!kind) return null;
  const shotNo = shotNoOf(node);
  const pool = entries.filter((e) => !e.claimed && e.tag?.kind === kind);
  const queuedAt = Number(node?.meta?.queuedAt || node?.meta?.startedAt) || 0;
  const floor = queuedAt ? queuedAt - MATCH_SLACK_MS : 0;
  // 有排队时间就以它为界：宁可判定「查无结果」让用户重发，也不能把上一轮的旧图认成本次产物。
  // 只有完全没有时间基准的老节点才退回全量候选。
  const window = floor ? pool.filter((e) => (e.at || 0) >= floor) : pool;
  const exact = shotNo !== null ? window.filter((e) => e.tag.shotNo === shotNo) : [];
  const scope = exact.length ? exact : (opts.allowLoose ? window : []);
  const usable = scope.filter((e) => e.state !== 'running');
  return usable.length ? usable[usable.length - 1] : null;
}

/**
 * 队列兜底匹配：节点没记住 prompt_id（升级前提交的任务），但 ComfyUI 的队列里确实有一条
 * 同类别、同镜号的任务正在跑或在等。认领它，绝不能当成「从未发出」再发一遍 ——
 * 那等于把正在算的任务又烧一次，还要多排一轮队。
 *
 * 转场的前缀镜号是固定值（lingximanju_transition_1_…），多条同时残留时无法区分，
 * 只有同类型仅剩一条时才允许宽松认领。
 */
export function queueMatchEntry(queueItems, node, opts = {}) {
  const kind = KIND_BY_TYPE[node?.type];
  if (!kind) return null;
  const pool = (queueItems || []).filter((e) => !e.claimed && e.tag?.kind === kind);
  if (!pool.length) return null;
  if (kind === 'transition') return opts.allowLoose ? pool[0] : null;
  const shotNo = shotNoOf(node);
  if (shotNo === null) return opts.allowLoose ? pool[0] : null;
  const exact = pool.filter((e) => e.tag.shotNo === shotNo);
  return exact.length ? exact[0] : null;
}

/** 把下载到的产物写回节点数据（关键帧候选 / 视频片段 / 转场锚点） */
export function applyHistoryAssets(node, entry, assets) {
  const images = assets.filter((a) => a.kind === 'image');
  const videos = assets.filter((a) => a.kind === 'video');
  const primary = videos[0] || images[0];
  if (!primary) return false;
  const data = node.data || {};
  const stamp = { adopted: true, adoptedAt: Date.now(), adoptedFrom: 'comfyui-history' };
  if (node.type === 'keyframe') {
    const prompt = data.prompt || data.candidates?.[0]?.prompt || '';
    const added = images.map((a) => ({
      url: a.url, provider: 'comfyui', promptId: entry.promptId, prompt,
      refs: data.refs || [], refsUsed: null, ...stamp,
    }));
    // 同一 prompt_id 重复对账时以最新下载为准，不重复堆候选
    const keep = (Array.isArray(data.candidates) ? data.candidates : [])
      .filter((c) => c?.promptId !== entry.promptId);
    node.data = { ...data, candidates: [...keep, ...added] };
    return added.length > 0;
  }
  if (node.type === 'video') {
    node.data = {
      ...data,
      clip: {
        url: primary.url, file: primary.file, provider: 'comfyui', isRealVideo: true,
        promptId: entry.promptId,
        poster: data.keyframeUrl || images[0]?.url || data.poster || null,
        ...stamp,
      },
    };
    return true;
  }
  if (node.type === 'transition') {
    const prev = data.transition || {};
    const anchor = images[0]?.url || primary.url;
    node.data = {
      ...data,
      url: data.url || anchor,
      transition: {
        ...prev,
        url: prev.url || anchor,
        ...(videos[0]
          ? { video: { url: videos[0].url, file: videos[0].file, provider: 'comfyui', promptId: entry.promptId, ...stamp } }
          : {}),
        ...stamp,
      },
    };
    return true;
  }
  return false;
}

function markAdopted(node, entry, projectId, runId) {
  node.status = 'done';
  node.progress = 1;
  node.error = '';
  node.meta = {
    ...(node.meta || {}),
    promptId: entry.promptId,
    finishedAt: Date.now(),
    adoptedAt: Date.now(),
    adoptedFrom: 'comfyui-history',
  };
  emit('node:data', { projectId, runId, nodeId: node.id, data: node.data });
  emit('node:status', {
    projectId, runId, nodeId: node.id, status: 'done', progress: 1,
    startedAt: node.meta.startedAt || null, finishedAt: node.meta.finishedAt,
    meta: { promptId: entry.promptId, adoptedAt: node.meta.adoptedAt },
  });
}

/**
 * 项目级对账。会就地修改 project 并广播事件，落盘交给调用方（便于与 run 共用一次 save）。
 * @param {object} project
 * @param {object} [opts]
 * @param {object} [opts.config]  ComfyUI 配置，缺省按项目解析
 * @param {object} [opts.snapshot] 直接注入 { queue, history }（测试 / 复用快照）
 * @param {Function} [opts.download] 注入产物下载（测试用）
 * @param {string} [opts.runId]
 * @param {boolean} [opts.resetMissing=true] 找不到结果的残留节点是否复位成待执行
 * @returns {Promise<{ok:boolean, reason?:string, message?:string, adopted:Array, running:Array,
 *   queued:Array, lost:Array, reset:Array, counts:Object}>}
 */
export async function reconcileProjectComfy(project, opts = {}) {
  const { runId = null, resetMissing = true } = opts;
  const config = opts.config || resolveComfyConfig(project);
  const projectId = project?.id;
  const empty = { adopted: [], running: [], queued: [], lost: [], reset: [], late: [] };
  if (!project) return { ok: false, reason: 'no-project', message: '项目不存在', ...empty };

  let snapshot = opts.snapshot;
  if (!snapshot) {
    try {
      snapshot = await fetchComfySnapshot(config, { signal: opts.signal });
    } catch (err) {
      return { ok: false, reason: 'offline', message: `无法连接 ComfyUI：${err.message}`, ...empty };
    }
  }
  const { queue, history } = snapshot;
  const runningIds = queue?.running || new Set();
  const pendingIds = queue?.pending || new Set();
  const queueItems = Array.isArray(queue?.items) ? queue.items : [];
  const entries = buildHistoryEntries(history);
  const byPid = new Map(entries.map((e) => [e.promptId, e]));
  const download = opts.download
    || ((cfg, item, o) => downloadHistoryOutputs(cfg, item, o));

  const report = { ok: true, adopted: [], running: [], queued: [], lost: [], reset: [], late: [] };
  const stale = (project.nodes || []).filter((n) => n.status === 'queued' || n.status === 'running');
  /**
   * 上一轮对账判过「查无结果」的节点：复位成待执行了，但它可能只是在判定时还没跑完。
   * 30 分钟内再对账一次，只要 ComfyUI 历史里出现了对应产物就直接认领，
   * 避免「刚复位完，ComfyUI 那边紧接着出图了，用户一点执行本步又重烧一遍」。
   */
  const leftovers = (project.nodes || []).filter((n) => n.status === 'idle'
    && GEN_TYPES.has(n.type)
    && Number(n.meta?.lostAt) > 0
    && Date.now() - Number(n.meta.lostAt) < LOST_GRACE_MS);
  const work = [...stale, ...leftovers];
  // 同类型只剩一条时，兜底匹配才是确定的；多条同时残留只能靠 prompt_id 精确认领
  const staleCountByType = work.reduce((acc, n) => {
    if (GEN_TYPES.has(n.type)) acc[n.type] = (acc[n.type] || 0) + 1;
    return acc;
  }, {});

  for (const node of work) {
    const isStale = node.status === 'queued' || node.status === 'running';
    const pidList = nodePromptIds(node);
    let entry = null;

    // ①/② 精确命中历史：有产物直接认领，执行失败则照实标红
    for (const pid of pidList) {
      const hit = byPid.get(pid);
      if (hit) { entry = hit; break; }
    }
    // ③ 明确还在 ComfyUI 队列里：保留状态，绝不重发
    if (!entry) {
      const pid = pidList.find((id) => runningIds.has(id) || pendingIds.has(id));
      if (pid) {
        const isRunning = runningIds.has(pid);
        node.status = isRunning ? 'running' : 'queued';
        node.meta = {
          ...(node.meta || {}),
          promptId: pid,
          ...(isRunning && !node.meta?.startedAt ? { startedAt: Date.now() } : {}),
        };
        emit('node:status', {
          projectId, runId, nodeId: node.id,
          status: node.status, progress: node.progress || 0,
          meta: { promptId: pid, comfy: isRunning ? 'running' : 'pending' },
        });
        (isRunning ? report.running : report.queued).push({
          id: node.id, type: node.type, title: node.title, shotNo: shotNoOf(node), promptId: pid,
        });
        continue;
      }
    }
    // ④ 兜底：靠前缀 + 镜号 + 时间窗认领老任务
    if (!entry) {
      entry = fuzzyMatchEntry(entries, node, { allowLoose: staleCountByType[node.type] <= 1 });
    }

    if (entry) {
      entry.claimed = true;
      if (entry.state === 'error') {
        node.status = 'error';
        node.error = `ComfyUI 执行失败（${entry.promptId.slice(0, 8)}）：${entry.error || '未知错误'}`;
        node.meta = { ...(node.meta || {}), promptId: entry.promptId, finishedAt: Date.now() };
        emit('node:status', {
          projectId, runId, nodeId: node.id, status: 'error', progress: node.progress || 0,
          error: node.error, meta: { promptId: entry.promptId },
        });
        report.lost.push({
          id: node.id, type: node.type, title: node.title, shotNo: shotNoOf(node),
          promptId: entry.promptId, reason: 'error', error: node.error,
        });
        continue;
      }
      let assets = [];
      try {
        assets = await download(config, entry.item, { log: opts.log });
      } catch (err) {
        assets = [];
        opts.log?.('warn', `取回 ${entry.promptId.slice(0, 8)} 的产物失败：${err.message}`);
      }
      if (applyHistoryAssets(node, entry, assets)) {
        markAdopted(node, entry, projectId, runId);
        report.adopted.push({
          id: node.id, type: node.type, title: node.title, shotNo: shotNoOf(node),
          promptId: entry.promptId, files: assets.length,
        });
        continue;
      }
      // 历史里没产物也下载不到 → 按丢失处理
    }

    // ③b 队列兜底：历史里没有（说明还没跑完），但队列里有同镜任务 → 认领它的 prompt_id。
    // 升级前提交的老任务没留 prompt_id，若不这样认，会被判成「从未发出」而重发一遍。
    if (!entry) {
      const qHit = queueMatchEntry(queueItems, node, { allowLoose: staleCountByType[node.type] <= 1 });
      if (qHit) {
        qHit.claimed = true;
        const isRunning = qHit.state === 'running';
        node.status = isRunning ? 'running' : 'queued';
        node.progress = Number(node.progress) || 0;
        node.meta = {
          ...(node.meta || {}),
          promptId: qHit.promptId,
          ...(isRunning && !node.meta?.startedAt ? { startedAt: Date.now() } : {}),
        };
        emit('node:status', {
          projectId, runId, nodeId: node.id,
          status: node.status, progress: node.progress,
          meta: { promptId: qHit.promptId, comfy: isRunning ? 'running' : 'pending' },
        });
        (isRunning ? report.running : report.queued).push({
          id: node.id, type: node.type, title: node.title, shotNo: shotNoOf(node), promptId: qHit.promptId,
        });
        continue;
      }
    }

    // ⑤ 找不到：ComfyUI 侧没有这条任务（从未发出 / 历史已清空）
    if (GEN_TYPES.has(node.type)) {
      if (!isStale) {
        // 已经复位过的节点：这次仍然没等到产物，保持待执行即可，不必反复报「丢失」
        report.late.push({ id: node.id, type: node.type, title: node.title, shotNo: shotNoOf(node) });
        continue;
      }
      report.lost.push({
        id: node.id, type: node.type, title: node.title, shotNo: shotNoOf(node),
        promptId: pidList[0] || '', reason: pidList.length ? 'gone' : 'never-sent',
      });
      if (resetMissing) {
        node.status = 'idle';
        node.progress = 0;
        node.meta = { ...(node.meta || {}), lostAt: Date.now(), lostReason: pidList.length ? 'gone' : 'never-sent' };
        emit('node:status', { projectId, runId, nodeId: node.id, status: 'idle', progress: 0 });
        report.reset.push({ id: node.id, type: node.type, title: node.title });
      }
    } else {
      // 非 ComfyUI 节点（择优 / 机位等）卡在排队中一定是残留：复位成待执行
      node.status = 'idle';
      node.progress = 0;
      emit('node:status', { projectId, runId, nodeId: node.id, status: 'idle', progress: 0 });
      report.reset.push({ id: node.id, type: node.type, title: node.title });
    }
  }

  report.counts = {
    adopted: report.adopted.length,
    running: report.running.length,
    queued: report.queued.length,
    lost: report.lost.length,
    reset: report.reset.length,
    late: report.late.length,
  };
  report.message = summarize(report.counts);
  return report;
}

function summarize(c) {
  const bits = [];
  if (c.adopted) bits.push(`取回 ${c.adopted} 条已完成`);
  if (c.running) bits.push(`${c.running} 条仍在运行`);
  if (c.queued) bits.push(`${c.queued} 条仍在排队`);
  if (c.lost) bits.push(`${c.lost} 条不存在`);
  return bits.length ? bits.join(' · ') : 'ComfyUI 里没有待对账的任务';
}

/* ------------------------------------------------------------------ 后台观察 */

const watchers = new Map();

/**
 * 后台等「还在 ComfyUI 跑」的任务完成，完成后自动取回并落盘。
 * 一次执行结束时调用即可：用户不需要守着页面，也不用再点一次生成。
 */
export function watchComfyJobs(projectId, config, opts = {}) {
  if (watchers.has(projectId)) return false;
  const intervalMs = Math.max(2000, Number(opts.intervalMs) || 5000);
  const until = Date.now() + (Number(opts.timeoutMs) || 30 * 60 * 1000);
  const tick = async () => {
    const timer = watchers.get(projectId);
    if (!timer) return;
    if (Date.now() > until || timer.dead) { stopWatch(projectId); return; }
    let project = null;
    try { project = loadProject(projectId); } catch { /* ignore */ }
    if (!project) { stopWatch(projectId); return; }
    const pending = (project.nodes || []).filter((n) => n.status === 'queued' || n.status === 'running');
    if (!pending.length) { stopWatch(projectId); return; }
    let report = null;
    try {
      report = await reconcileProjectComfy(project, {
        config, resetMissing: false,
        log: (lv, msg) => emit('log', { projectId, level: lv, message: msg }),
      });
    } catch { return; }
    if (report?.ok && report.adopted.length) {
      saveProject(project);
      emit('state', { projectId, project, reason: 'comfy-adopted' });
      emit('log', {
        projectId, level: 'info',
        message: `从 ComfyUI 取回 ${report.adopted.length} 条已完成任务（未重新生成）：${report.adopted
          .map((a) => `${a.type === 'keyframe' ? '关键帧' : a.type === 'video' ? '片段' : '转场'}${a.shotNo ? ` #${a.shotNo}` : ''}`)
          .join('、')}`,
      });
    }
  };
  watchers.set(projectId, { timer: setInterval(tick, intervalMs), dead: false, startedAt: Date.now() });
  setTimeout(tick, 1500);
  return true;
}

export function stopWatch(projectId) {
  const w = watchers.get(projectId);
  if (!w) return false;
  w.dead = true;
  clearInterval(w.timer);
  watchers.delete(projectId);
  return true;
}

export const isWatchingComfyJobs = (projectId) => watchers.has(projectId);
