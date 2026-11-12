/* ============================================================================
 * 角色定妆任务（Portrait Jobs）
 *
 * 为什么需要它：一次「一键生成全部角色图」是 12 位角色 × 6 张图 ≈ 72 次 ComfyUI
 * 出图，单张 30s 左右，整体 30–40 分钟。过去这条路是一个同步 HTTP 请求：
 *   - 浏览器只能干等，卡片一直停在「待生成」，看起来像没开始；
 *   - 请求被代理/网络中断后，前端拿不到任何进度，用户以为失败；
 *   - 页面刷新就丢失「正在跑」这件事（虽然图逐张落盘了，但没有任务态可查）。
 *
 * 现在改成后台任务：POST 立即返回 jobId，生成在服务端继续跑，逐张通过 SSE
 * 广播进度，前端与 /characters/jobs/:id 都能查到同一份任务状态。
 * ==========================================================================*/
import { emit } from './events.mjs';
import { normalizeViewsByChar, portraitPlanFor, characterReadyForVideo, ensureCharacterPortraits, normalizeInterfaceByView } from './character-portrait.mjs';
import { resolveViewKeys } from './characters.mjs';

/** 任务保留时长：完成后仍可查询，便于刷新页面恢复「刚跑完」的状态 */
const KEEP_MS = 30 * 60 * 1000;
const jobs = new Map();          // jobId → job
const activeByProject = new Map(); // projectId → jobId
/** 进度落盘的节流间隔：每张图完成都写一次项目文件太浪费，3s 一次足够恢复 */
const PERSIST_EVERY_MS = 3000;

/**
 * 把任务快照交给调用方落盘（hooks.persist）。
 * 为什么要落盘：任务表只在内存里，服务重启 / 进程退出 / 30 分钟淘汰之后，
 * 第⑤步「角色与上下文」的任务进度条与「最近一次」状态就彻底看不见了 ——
 * 用户看到的就是「进度和状态没有」。落盘后刷新、重启、隔天都能查回来。
 * 节流按任务各自计时：多项目并行时不会互相把对方的落盘挤掉。
 */
function persistSnapshot(job, hooks, force = false) {
  if (typeof hooks.persist !== 'function') return;
  const now = Date.now();
  if (!force && now - (job.persistedAt || 0) < PERSIST_EVERY_MS) return;
  job.persistedAt = now;
  try {
    hooks.persist(publicJob(job));
  } catch { /* 落盘失败不影响生成：任务状态仍可从内存查 */ }
}

/**
 * 内存任务表丢了之后，把落盘快照整理成「可展示的历史任务」。
 * running 却已经没有内存任务 → 说明进程重启 / 任务被中断：
 * 显示为 interrupted，并把卡在 running 的单张视图退回 pending（避免永久扫光转圈）。
 */
export function stalePortraitJob(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const job = JSON.parse(JSON.stringify(snapshot));
  if (job.status === 'running') {
    job.status = 'interrupted';
    job.ok = false;
    job.current = null;
    job.message = `上次任务被中断（服务重启或进程退出）· 已完成 ${job.done || 0}/${job.total || 0}`;
    job.interruptedAt = Date.now();
    job.finishedAt = job.finishedAt || null;
    for (const one of Object.values(job.byChar || {})) {
      for (const v of Object.values(one?.views || {})) {
        if (v && v.status === 'running') v.status = 'pending';
      }
      if (one && one.status === 'running') one.status = 'partial';
    }
  }
  return job;
}

function prune(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && job.finishedAt && now - job.finishedAt > KEEP_MS) {
      jobs.delete(id);
      if (activeByProject.get(job.projectId) === id) activeByProject.delete(job.projectId);
    }
  }
  // 兜底：最多保留 50 条，按开始时间淘汰最老的已完成任务
  if (jobs.size > 50) {
    const done = [...jobs.values()].filter((j) => j.status !== 'running')
      .sort((a, b) => a.startedAt - b.startedAt);
    for (const j of done) {
      if (jobs.size <= 50) break;
      jobs.delete(j.id);
      if (activeByProject.get(j.projectId) === j.id) activeByProject.delete(j.projectId);
    }
  }
}

function nextId() {
  return `pj_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** 对外可见的任务状态（不含 project 等大对象） */
export function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id, projectId: job.projectId, projectName: job.projectName,
    status: job.status, ok: job.ok,
    total: job.total, done: job.done, generated: job.generated, skipped: job.skipped,
    sheets: job.sheets, failed: job.failed.slice(0, 20), failedCount: job.failed.length,
    characters: job.characters, scope: job.scope, sheet: job.sheet,
    // 本次按视图选用的接口档案（正面可用专用工作流），便于任务回溯
    interfaceId: job.interfaceId || '', interfaceByView: job.interfaceByView || null,
    viewsByChar: job.viewsByChar || null,
    current: job.current, byChar: job.byChar,
    message: job.message, error: job.error || '',
    videoReady: job.videoReady,
    startedAt: job.startedAt, finishedAt: job.finishedAt || null,
  };
}

/** 某个角色当前的汇总状态：pending | running | done | partial | error */
function charStateOf(views = {}, total = 0) {
  const list = Object.values(views);
  if (!list.length) return 'pending';
  if (list.some((v) => v.status === 'running')) return 'running';
  const okCount = list.filter((v) => v.status === 'done' || v.status === 'skip').length;
  const errCount = list.filter((v) => v.status === 'error').length;
  if (errCount && okCount === 0) return 'error';
  if (errCount) return 'partial';
  return okCount >= total ? 'done' : 'running';
}

/**
 * 启动一个角色定妆后台任务。
 * @param {object} o { project, m, opts, hooks:{ save, onFinish } }
 * @returns {object} publicJob
 */
export function startPortraitJob({ project, m, opts = {}, hooks = {} } = {}) {
  prune();
  const projectId = project?.id;
  const existingId = activeByProject.get(projectId);
  const existing = existingId ? jobs.get(existingId) : null;
  if (existing?.status === 'running') return publicJob(existing);

  const scope = String(opts.scope || 'core');
  const includeSheet = opts.sheet === true || opts.includeSheet === true;
  const targetIds = Array.isArray(opts.characterIds) && opts.characterIds.length
    ? new Set(opts.characterIds.map(String)) : null;
  const targets = (m.characters || []).filter((c) => !targetIds || targetIds.has(String(c.id)));
  // 「重试失败任务」会带 viewsByChar：每位角色只重出指定的失败视图。
  // 任务总数与 byChar.total 必须和业务层 ensureCharacterPortraits 用同一份计划，
  // 否则 done 会超过 total、进度条失真。
  const explicitViews = normalizeViewsByChar(opts.viewsByChar);
  const planOpts = { views: resolveViewKeys(scope), sheet: includeSheet, onlyMissing: opts.onlyMissing !== false };
  const plans = new Map(targets.map((c) => [String(c.id), portraitPlanFor(c, explicitViews, planOpts)]));
  const total = [...plans.values()].reduce((n, p) => n + p.keys.length + (p.sheet ? 1 : 0), 0);

  const job = {
    id: nextId(), projectId, projectName: project?.name || '',
    status: 'running', ok: false,
    total, done: 0, generated: 0, skipped: 0, sheets: 0,
    failed: [], characters: targets.length, scope, sheet: includeSheet,
    current: null, byChar: {}, message: '任务已开始', error: '',
    interfaceId: String(opts.interfaceId || '').slice(0, 60),
    interfaceByView: normalizeInterfaceByView(opts.interfaceByView),
    viewsByChar: explicitViews,
    startedAt: Date.now(), finishedAt: null, cancel: false,
  };
  for (const c of targets) {
    const plan = plans.get(String(c.id));
    job.byChar[c.id] = { id: c.id, name: c.name, status: 'pending', views: {}, total: plan.keys.length + (plan.sheet ? 1 : 0) };
  }
  jobs.set(job.id, job);
  activeByProject.set(projectId, job.id);

  const log = (level, message) => emit('log', { projectId, level, message });
  emit('character:job', { projectId, job: publicJob(job) });
  persistSnapshot(job, hooks, true);   // 起点就落盘：中途重启也能看到「跑到第几张」

  const onProgress = (evt) => {
    job.done = evt.done ?? job.done;
    job.current = evt.status === 'running'
      ? { characterId: evt.characterId, name: evt.name, view: evt.view, label: evt.label }
      : null;
    const one = job.byChar[evt.characterId];
    if (one && evt.view) {
      one.views[evt.view] = {
        status: evt.status, provider: evt.provider || '', url: evt.url || '', error: evt.error || '',
      };
      one.status = charStateOf(one.views, one.total);
    }
    persistSnapshot(job, hooks);       // 逐张进度节流落盘
    emit('character:batch', {
      projectId, jobId: job.id,
      done: job.done, total: job.total,
      characterId: evt.characterId || '', name: evt.name || '',
      view: evt.view || '', label: evt.label || '',
      status: evt.status || 'running', provider: evt.provider || '',
      url: evt.url || '', error: evt.error || '',
    });
  };

  // 后台跑：不 await，HTTP 响应立即返回 jobId。
  (async () => {
    try {
      const out = await ensureCharacterPortraits({
        project, m,
        scope, onlyMissing: opts.onlyMissing !== false, sheet: includeSheet,
        characterIds: opts.characterIds || null,
        regenerateMock: opts.regenerateMock === true,
        requireReal: opts.requireReal === true,
        interfaceId: String(opts.interfaceId || '').slice(0, 60),
        interfaceByView: normalizeInterfaceByView(opts.interfaceByView),
        viewsByChar: explicitViews,
        concurrency: Math.max(1, Math.min(3, Number(opts.concurrency) || 2)),
        shouldStop: () => job.cancel,
        modelId: opts.modelId || '',
        save: () => hooks.save?.(),
        log,
        onProgress,
      });
      job.generated = out.generated;
      job.skipped = out.skipped;
      job.sheets = out.sheets;
      job.failed = Array.isArray(out.failed) ? out.failed : [];
      job.message = out.message || job.message;
      job.ok = Boolean(out.ok);
      job.status = out.cancelled ? 'cancelled'
        : (job.failed.length === 0 ? 'done' : (out.generated > 0 ? 'partial' : 'error'));
      if (job.status === 'error') job.error = job.failed[0] || '全部生成失败';
      const ready = Object.fromEntries((m.characters || []).map((c) => [c.id, characterReadyForVideo(c)]));
      const readyList = Object.values(ready);
      const blocked = (m.characters || []).filter((c) => !ready[c.id]?.ok).map((c) => c.name);
      job.videoReady = {
        total: readyList.length,
        ready: readyList.filter((r) => r.ok).length,
        blocked,
        label: blocked.length
          ? `${blocked.length} 位角色还不可进视频（${blocked.slice(0, 3).join('、')}${blocked.length > 3 ? ' 等' : ''}）`
          : `${readyList.length} 位角色均可进入视频生成`,
      };
    } catch (err) {
      job.status = 'error';
      job.error = err.message;
      job.message = `批量定妆失败：${err.message}`;
      log('error', `角色定妆任务失败：${err.message}`);
    } finally {
      job.finishedAt = Date.now();
      job.current = null;
      for (const one of Object.values(job.byChar)) {
        if (one.status === 'running') one.status = 'error';
      }
      persistSnapshot(job, hooks, true);   // 终态必须落盘：刷新 / 重启后还能看到「最近一次」
      try { hooks.save?.(); hooks.onFinish?.(); } catch { /* 落盘/广播失败不应吞掉任务结果 */ }
      emit('character:job', { projectId, job: publicJob(job) });
      emit('character:batch', {
        projectId, jobId: job.id, done: job.total, total: job.total,
        status: job.status === 'done' ? 'done' : 'error',
        name: '', view: '', label: '', jobStatus: job.status,
      });
      if (activeByProject.get(projectId) === job.id) activeByProject.delete(projectId);
      prune();
    }
  })();

  return publicJob(job);
}

/** 查询单个任务 */
export function getPortraitJob(jobId) {
  prune();
  const job = jobs.get(String(jobId || ''));
  if (!job) return null;
  // 项目可能被删除，任务状态仍可查；但返回时补齐为可序列化结构
  return publicJob(job);
}

/** 查询项目当前（或最近一次）任务 */
export function getProjectPortraitJob(projectId) {
  prune();
  const activeId = activeByProject.get(String(projectId || ''));
  if (activeId && jobs.has(activeId)) return publicJob(jobs.get(activeId));
  let latest = null;
  for (const job of jobs.values()) {
    if (job.projectId === projectId && (!latest || job.startedAt > latest.startedAt)) latest = job;
  }
  return latest ? publicJob(latest) : null;
}

/** 请求暂停：当前这一张跑完后停止，已生成的图保留 */
export function cancelPortraitJob(jobId) {
  const job = jobs.get(String(jobId || ''));
  if (!job || job.status !== 'running') return getPortraitJob(jobId);
  job.cancel = true;
  job.message = '正在暂停：当前这张生成结束后停止…';
  emit('character:job', { projectId: job.projectId, job: publicJob(job) });
  return publicJob(job);
}

/** 测试用：清空任务表 */
export function _resetPortraitJobs() {
  jobs.clear();
  activeByProject.clear();
}
