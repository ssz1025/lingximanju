/* ============================================================================
 * 工作台第 ⑥ 步「分镜与画面」· 任务状态看板
 *
 * 这一步的产物是一条条真正发给生成后端的任务（每镜 keyframe × k、择优、视频片段、转场），
 * 用户需要能一眼回答三件事：
 *   ① 已经发出去多少条（排队中 / 已完成 / 失败）
 *   ② 现在正在跑哪几条、跑到多少、已经用了多久
 *   ③ 哪一条失败了，失败原因是什么、ComfyUI 的 prompt_id 是哪个
 *
 * 数据来源就是画布节点本身（status / progress / meta.queuedAt / meta.startedAt / error），
 * 不额外维护一份任务表——节点是唯一事实来源，刷新页面后依然对得上。
 * collectShotTasks / taskPanelHTML 都是纯函数，可直接在 node 里单测。
 * ==========================================================================*/
import { esc, cut } from './utils.js';

const KINDS = {
  keyframe: { label: '关键帧', icon: '⌗' },
  review: { label: '择优', icon: '✓' },
  video: { label: '视频片段', icon: '▶' },
  transition: { label: '转场', icon: '⇄' },
};

const STATUS = {
  pending: { label: '待发送', cls: 'pending' },
  // planned = 已排进本次运行的计划，但还没提交到 ComfyUI（受并发上限约束，等前面出完才轮到）。
  // 这一档必须和「已发送」分开：否则 40 个镜头一次性全标成已发送，用户去 ComfyUI 只看得到两条。
  planned: { label: '等待发送', cls: 'pending' },
  queued: { label: '已发送 · 排队中', cls: 'queued' },
  running: { label: '生成中', cls: 'running' },
  done: { label: '已完成', cls: 'done' },
  error: { label: '失败', cls: 'error' },
  skipped: { label: '已跳过', cls: 'skipped' },
};

/** 毫秒 → 可读耗时（<1h 用 mm:ss，超过用 h:mm:ss） */
export function fmtDur(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 沿入边向上找最近的镜头节点：keyframe / review / video 的提示词都以 shot 为准 */
function shotOf(node, byId, parentsOf) {
  if (node?.data?.shot?.shotNo !== undefined) return node.data.shot;
  const seen = new Set([node.id]);
  const queue = [...(parentsOf.get(node.id) || [])];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const n = byId.get(id);
    if (!n) continue;
    if (n.type === 'shot') return n.data?.shot || {};
    queue.push(...(parentsOf.get(n.id) || []));
  }
  return null;
}

/**
 * 把画布节点摊平成任务数组。
 * @param {object} project
 * @param {{kinds?: string[]}} [opts] kinds 限定任务类型（第⑥步只看画面类，视频/转场留给第⑦步）
 * @returns {Array<{nodeId, kind, kindLabel, icon, title, shotNo, size, status, statusLabel,
 *   progress, prompt, promptId, provider, error, queuedAt, startedAt, finishedAt, durationMs}>}
 */
export function collectShotTasks(project, opts = {}) {
  const want = Array.isArray(opts.kinds) && opts.kinds.length ? new Set(opts.kinds) : null;
  const nodes = project?.nodes || [];
  const edges = project?.edges || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parentsOf = new Map();
  for (const e of edges) {
    if (!parentsOf.has(e.to)) parentsOf.set(e.to, []);
    parentsOf.get(e.to).push(e.from);
  }
  const tasks = [];
  for (const node of nodes) {
    const kind = KINDS[node.type] ? node.type : null;
    if (!kind || (want && !want.has(kind))) continue;
    const shot = shotOf(node, byId, parentsOf);
    const meta = node.meta || {};
    const cand = node.data?.candidates?.[0] || null;
    const clip = node.data?.clip || null;
    const promptId = cand?.promptId || clip?.promptId || node.data?.promptId || meta.promptId || '';
    // 「已发送」的唯一证据：拿到了任务号（prompt_id），或提交时写下了时间戳。
    // 只看 status=queued 是不够的 —— 调度器一启动就把整批目标标成 queued 占位，
    // 真正交给 ComfyUI 的只有并发上限那么多条。
    const submittedAt = Number(meta.submittedAt) || 0;
    const submitted = Boolean(promptId) || submittedAt > 0;
    const raw = STATUS[node.status] ? node.status : 'pending';
    const status = raw === 'queued' && !submitted ? 'planned' : raw;
    const prompt = cand?.prompt || shot?.ffDesc || node.data?.summary || node.title || '';
    const label = status === 'planned'
      ? (kind === 'review' ? '等待执行' : '等待发送')
      : STATUS[status].label;
    tasks.push({
      nodeId: node.id,
      kind,
      kindLabel: KINDS[kind].label,
      icon: KINDS[kind].icon,
      title: node.title || KINDS[kind].label,
      shotNo: shot?.shotNo ?? null,
      size: shot?.size || '',
      status,
      submitted,
      statusLabel: label,
      statusCls: STATUS[status].cls,
      progress: Number(node.progress) || 0,
      prompt: String(prompt || ''),
      promptId,
      provider: cand?.provider || clip?.provider || meta.provider || '',
      error: node.error || '',
      queuedAt: Number(meta.queuedAt) || 0,
      submittedAt,
      startedAt: Number(meta.startedAt) || 0,
      finishedAt: Number(meta.finishedAt) || 0,
      durationMs: Number(meta.durationMs) || 0,
    });
  }
  // 镜头号优先、同类按类型顺序：看板从上到下就是分镜的推进顺序
  const kindOrder = { keyframe: 0, review: 1, video: 2, transition: 3 };
  return tasks.sort((a, b) => (Number(a.shotNo ?? 1e9) - Number(b.shotNo ?? 1e9))
    || (kindOrder[a.kind] - kindOrder[b.kind]));
}

/** 分组 + 计数：进行中 / 已发送·ComfyUI 排队 / 本次运行等待发送 / 已完成与失败 / 待发送 */
export function groupTasks(tasks) {
  const running = tasks.filter((t) => t.status === 'running')
    .sort((a, b) => (a.startedAt || Infinity) - (b.startedAt || Infinity));
  const queued = tasks.filter((t) => t.status === 'queued')
    .sort((a, b) => (a.queuedAt || Infinity) - (b.queuedAt || Infinity));
  const planned = tasks.filter((t) => t.status === 'planned')
    .sort((a, b) => (a.queuedAt || Infinity) - (b.queuedAt || Infinity));
  const settled = tasks.filter((t) => t.status === 'done' || t.status === 'error' || t.status === 'skipped')
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  const pending = tasks.filter((t) => t.status === 'pending');
  return {
    running, queued, planned, settled, pending,
    counts: {
      total: tasks.length,
      running: running.length,
      queued: queued.length,
      planned: planned.length,
      done: tasks.filter((t) => t.status === 'done').length,
      error: tasks.filter((t) => t.status === 'error').length,
      pending: pending.length,
    },
  };
}

function rowHTML(t) {
  const now = Date.now();
  const since = t.status === 'running' ? (t.startedAt || t.submittedAt || t.queuedAt)
    : t.status === 'queued' ? (t.submittedAt || t.queuedAt)
      : t.status === 'planned' ? t.queuedAt : 0;
  // 时间戳可能缺失（升级前跑过的老任务）：宁可显示「—」，也不要把 1970 年算成已跑了几十年
  const timed = (t.status === 'running' || t.status === 'queued' || t.status === 'planned') && since > 0;
  const elapsed = timed ? fmtDur(now - since)
    : t.durationMs ? fmtDur(t.durationMs) : '—';
  const pct = Math.max(3, Math.min(100, Math.round((t.progress || 0) * 100)));
  const head = [
    t.shotNo !== null ? `#${esc(String(t.shotNo))}` : '',
    t.size ? esc(t.size) : '',
    esc(t.kindLabel),
  ].filter(Boolean).join(' · ');
  const timeText = timed ? `⏱ ${elapsed}` : elapsed;
  const timeTitle = t.status === 'running' ? '已用时'
    : t.status === 'queued' ? '已排队（交给 ComfyUI 之后）'
      : t.status === 'planned' ? '已在本次运行里等待多久' : '本次耗时';
  const idTitle = t.promptId ? '复制 ComfyUI prompt_id：'
    : t.status === 'planned' ? '还没提交到 ComfyUI，所以还没有 prompt_id：并发跑完前面的任务才轮到它'
      : '非 ComfyUI 任务（未配置本地出图工作流，或升级前跑的老任务）';
  return `<div class="ptk-row st-${t.statusCls}" data-node="${esc(t.nodeId)}">
    <span class="ptk-ico" title="${esc(t.kindLabel)}">${t.icon}</span>
    <span class="ptk-main">
      <b>${head}</b>
      <small title="${esc(t.prompt)}">${esc(cut(t.prompt || '（还没有提示词）', 92))}</small>
    </span>
    <span class="ptk-state">
      ${t.status === 'running'
        ? `<span class="ptk-bar"><i style="width:${pct}%"></i></span><span class="ptk-pct">${pct}%</span>`
        : ''}
      <span class="ptk-pill ${t.statusCls}">${esc(t.statusLabel)}</span>
    </span>
    <span class="ptk-time" data-elapsed="${timed ? since : 0}" title="${timeTitle}">${timeText}</span>
    ${t.promptId
      ? `<button class="ptk-id" data-copy="${esc(t.promptId)}" title="${idTitle}${esc(t.promptId)}">${esc(cut(t.promptId, 8))}</button>`
      : `<span class="ptk-id none" title="${idTitle}">—</span>`}
    ${t.error ? `<span class="ptk-err" title="${esc(t.error)}">${esc(cut(t.error, 18))}</span>` : ''}
  </div>`;
}

const MAX_ROWS = 12;

/**
 * 任务看板整块 HTML（不含外层 data-task-area，由调用方套壳）。
 * @returns {string}
 */
export function taskPanelHTML(project, opts = {}) {
  const tasks = collectShotTasks(project, opts);
  const g = groupTasks(tasks);
  const c = g.counts;
  if (!tasks.length) {
    return `<div class="ptk-head">
      <b>任务状态</b>
      <span class="ptk-sum">还没有可调度任务</span>
    </div>
    <div class="ptk-empty">先执行第⑤步「RAG · 角色 · 层次分解」，把事件 → 场景 → 镜头展开到画布；之后每次「▶ 执行本步」或「↻ 重出本镜」发出的任务都会实时显示在这里。</div>`;
  }
  const active = g.running.length + g.queued.length + g.planned.length;
  const sum = [
    `<b${g.running.length ? ' class="on"' : ''}>进行中 ${g.running.length}</b>`,
    `ComfyUI 排队 ${c.queued}`,
    c.planned ? `等待发送 ${c.planned}` : '',
    `已完成 ${c.done}`,
    `<b${c.error ? ' class="bad"' : ''}>失败 ${c.error}</b>`,
    c.pending ? `待发送 ${c.pending}` : '',
  ].filter(Boolean).join(' · ');

  const group = (title, list) => (list.length
    ? `<div class="ptk-gtitle"><span>${title}</span><em>${list.length}</em></div>
      <div class="ptk-rows">${list.slice(0, MAX_ROWS).map(rowHTML).join('')}</div>
      ${list.length > MAX_ROWS ? `<div class="ptk-more">另有 ${list.length - MAX_ROWS} 条未列出（统计已计入）</div>` : ''}`
    : '');
  // 顺序按「下一步要做什么」排：进行中 → ComfyUI 排队 → 本次运行等待发送 → 待发送 → 已完成。
  // 三档必须分开：前两档是真在 GPU 上的任务，第三档只是本地运行计划里排着队、还没提交，
  // 混在一起就会出现「页面说全发出去了，ComfyUI 里只有两条」的错觉。
  const rows = [
    group('进行中', g.running),
    group('已发送 · ComfyUI 排队中', g.queued),
    group('本次运行 · 等待发送（并发满了，还没提交）', g.planned),
    group('待发送', g.pending),
    group('已发送 · 最近完成', g.settled),
  ].filter(Boolean).join('');

  return `<div class="ptk-head">
      <b>任务状态</b>
      <span class="ptk-sum">${sum}</span>
      <button class="btn sm" data-act="task-reconcile" title="去 ComfyUI 核对：已完成的任务直接取回，仍在队列的保留，查无结果的才重发">⟲ 检查已完成</button>
      <button class="btn sm" data-act="task-refresh" title="立即同步一次任务状态">↻ 刷新</button>
    </div>
    ${rows || '<div class="ptk-empty">所有任务都在待发送状态：点右侧「▶ 执行本步」开始生成画面。</div>'}
    <div class="ptk-foot">
      ${active
        ? '<span class="ptk-live"><i></i>实时同步中 · 每秒刷新耗时</span>'
        : '<span>数据来自画布节点 · 刷新页面后依然可查</span>'}
      <span>prompt_id 可点击复制，便于到 ComfyUI 的队列 / 历史里复查</span>
      ${Array.isArray(opts.kinds) && opts.kinds.length
        ? `<span class="ptk-scope">仅统计本步的画面任务（${opts.kinds.map((k) => KINDS[k]?.label || k).join(' / ')}）；视频与转场任务在「成片交付」里发送</span>`
        : ''}
    </div>`;
}

/* ---------------------------------------------------------------- 挂载 / 刷新 */

let ticker = null;

/** 每秒只改「已用时」文本，不重建 DOM：不打断滚动，也不闪缩略图 */
export function startTaskTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    const box = document.getElementById('pv-taskbox');
    if (!box) { clearInterval(ticker); ticker = null; return; }
    box.querySelectorAll('[data-elapsed]').forEach((el) => {
      const since = Number(el.dataset.elapsed) || 0;
      if (since > 0) el.textContent = `⏱ ${fmtDur(Date.now() - since)}`;
    });
  }, 1000);
}

export function stopTaskTicker() {
  if (ticker) { clearInterval(ticker); ticker = null; }
}

/** 复制 prompt_id：看板上唯一的交互，失败时回退到选中文本 */
export async function copyPromptId(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
