/* ============================================================================
 * 短剧时长规格（Runtime Spec）· 纯逻辑层，无任何 IO
 *
 * 以前「片段多长 / 一共几个片段」散落在 5 处硬编码里：
 *   providers shots.duration = 4 + (i%3)、visual.video 默认 5、composer 默认 5、
 *   stitchClips 默认 5、episode-service timeline 固定 5。
 * 结果 30s/3s 的需求无法表达，系统还会把 12 片段 / 60s 当成「全流程已达成」。
 *
 * 现在由项目级规格统一驱动：
 *   totalSeconds / clipSeconds → clipCount → 镜头预算 → 单片段时长 → 导演包时间线 → 验收。
 * 本文件只做计算与校验，供后端、前端快照、单元测试共用。
 *
 * 另带 `filmPolicy`：real = 只认 ComfyUI 真实视频片段拼出的成片；
 * preview = 显式允许关键帧预览成片但必须标降级。默认 real，杜绝
 * 「ffmpeg 拼静态图冒充 AI 短剧」被验收判成全流程达成。
 * ==========================================================================*/
import { normalizeFilmPolicy, DEFAULT_FILM_POLICY } from './film-policy.mjs';

export { normalizeFilmPolicy, DEFAULT_FILM_POLICY } from './film-policy.mjs';

/** 默认就是用户要的「30s 短剧 / 每片段 3s」 */
export const DEFAULT_RUNTIME = Object.freeze({
  totalSeconds: 30,
  clipSeconds: 3,
  fps: 24,
  filmPolicy: DEFAULT_FILM_POLICY,
});

const LIMITS = Object.freeze({
  totalMin: 1, totalMax: 600,
  clipMin: 0.5, clipMax: 30,
  clipCountMax: 120,
  fpsMin: 1, fpsMax: 120,
});

const round2 = (n) => Math.round(n * 100) / 100;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const positive = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * 归一时长规格。片数由 total/clip 推导，绝不独立存储，避免两者互相矛盾。
 * 不能整除时把总时长对齐到 clipCount * clipSeconds，并用 aligned 如实标记
 * （保证「每片段严格 3s」优先，而不是让最后一段变成零头）。
 */
export function normalizeRuntimeSpec(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const requestedTotal = positive(src.totalSeconds, DEFAULT_RUNTIME.totalSeconds);
  const clipSeconds = round2(clamp(positive(src.clipSeconds, DEFAULT_RUNTIME.clipSeconds), LIMITS.clipMin, LIMITS.clipMax));
  const fps = Math.round(clamp(positive(src.fps, DEFAULT_RUNTIME.fps), LIMITS.fpsMin, LIMITS.fpsMax));
  const clipCount = clamp(Math.round(requestedTotal / clipSeconds), 1, LIMITS.clipCountMax);
  const totalSeconds = round2(clipCount * clipSeconds);
  const framesPerClip = Math.round(clipSeconds * fps);
  return {
    schema: 1,
    enabled: src.enabled !== false,
    totalSeconds,
    requestedTotalSeconds: round2(requestedTotal),
    clipSeconds,
    clipCount,
    fps,
    framesPerClip,
    totalFrames: clipCount * framesPerClip,
    filmPolicy: normalizeFilmPolicy(src.filmPolicy),
    aligned: Math.abs(totalSeconds - requestedTotal) > 0.001,
  };
}

/** 从项目读取规格；老项目 / 标准项目都回落到默认值，绝不抛错 */
export function resolveRuntimeSpec(project) {
  return normalizeRuntimeSpec(project?.management?.runtime || DEFAULT_RUNTIME);
}

/** 纯函数时间线：每段严格 clipSeconds，累计恰为 totalSeconds */
export function clipTimeline(specOrRaw = DEFAULT_RUNTIME) {
  const spec = specOrRaw?.schema === 1 ? specOrRaw : normalizeRuntimeSpec(specOrRaw);
  return Array.from({ length: spec.clipCount }, (_, i) => ({
    index: i + 1,
    start: round2(i * spec.clipSeconds),
    duration: spec.clipSeconds,
    end: round2((i + 1) * spec.clipSeconds),
  }));
}

/**
 * 把 clipCount 个片段精确分配到 sceneCount 个场景（前余数个场景各多一个镜头）。
 * 这是「30s → 10 个镜头」落地的关键：分镜总数恒等于片段总数，不多不少。
 */
export function allocateShots(sceneCount, specOrRaw = DEFAULT_RUNTIME) {
  const spec = specOrRaw?.schema === 1 ? specOrRaw : normalizeRuntimeSpec(specOrRaw);
  const n = Math.max(1, Math.floor(Number(sceneCount) || 1));
  const base = Math.floor(spec.clipCount / n);
  const rest = spec.clipCount % n;
  return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}

/** 每个场景的全局起始镜头序号，供时间线 / 导演包稳定排序 */
export function shotSequenceStarts(sceneCount, specOrRaw = DEFAULT_RUNTIME) {
  const budgets = allocateShots(sceneCount, specOrRaw);
  let cursor = 1;
  return budgets.map((n) => {
    const start = cursor;
    cursor += n;
    return start;
  });
}

/**
 * 最终产物时长验收（纯函数）。filmSeconds 由外部用 ffprobe 探测后传入，
 * 这样纯逻辑层不依赖 ffmpeg，真实 MP4 也纳入同一份清单。
 */
export function verifyRuntime(project, specOrNull = null, opts = {}) {
  const spec = specOrNull?.schema === 1 ? specOrNull : resolveRuntimeSpec(project);
  const nodes = project?.nodes || [];
  const videos = nodes.filter((n) => n.type === 'video');
  const durations = videos.map((n) => Number(n.data?.duration ?? n.data?.clip?.duration ?? n.data?.shot?.duration ?? 0));
  const final = nodes.find((n) => n.type === 'final');
  const timeline = Array.isArray(final?.data?.timeline) ? final.data.timeline : [];
  const timelineTotal = round2(timeline.reduce((a, t) => a + (Number(t?.duration) || 0), 0));
  const packShots = final?.data?.directorPack?.shotCount;

  const checks = [
    {
      id: 'clipCount', label: '片段数量',
      expected: spec.clipCount, actual: videos.length,
      ok: videos.length === spec.clipCount,
      detail: `${videos.length} 个片段 / 目标 ${spec.clipCount} 个`,
    },
    {
      id: 'clipDuration', label: '每片段时长',
      expected: spec.clipSeconds, actual: [...new Set(durations)],
      ok: durations.length > 0 && durations.every((d) => Math.abs(d - spec.clipSeconds) < 0.001),
      detail: durations.length ? `各片段时长 ${[...new Set(durations)].join(' / ')}s · 目标 ${spec.clipSeconds}s` : '尚无片段',
    },
    {
      id: 'totalSeconds', label: '成片总时长',
      expected: spec.totalSeconds, actual: timelineTotal,
      ok: Math.abs(timelineTotal - spec.totalSeconds) < 0.001,
      detail: `时间线合计 ${timelineTotal}s / 目标 ${spec.totalSeconds}s`,
    },
    {
      id: 'packShots', label: '导演包镜头组',
      expected: spec.clipCount, actual: packShots ?? null,
      ok: packShots === spec.clipCount,
      detail: packShots == null ? '尚未导出导演包' : `${packShots} 组 / 目标 ${spec.clipCount} 组`,
    },
  ];
  if (Number.isFinite(Number(opts.filmSeconds))) {
    const filmSeconds = round2(Number(opts.filmSeconds));
    checks.push({
      id: 'filmSeconds', label: 'MP4 实际时长',
      expected: spec.totalSeconds, actual: filmSeconds,
      ok: Math.abs(filmSeconds - spec.totalSeconds) <= 0.5,
      detail: `ffprobe 实测 ${filmSeconds}s / 目标 ${spec.totalSeconds}s`,
    });
  }
  // 真实模式下，光是「有一条 30s 的 MP4」不够：必须确认这条 MP4 来自 ComfyUI
  // 真实片段。否则 ffmpeg 拼的静态关键帧也能凑够 30s 而被误判为达标。
  if (opts.requireRealFilm) {
    checks.push({
      id: 'filmSource', label: '成片来自真实 AI 视频',
      expected: true, actual: opts.filmIsReal === true,
      ok: opts.filmIsReal === true,
      detail: opts.filmIsReal === true
        ? '由 ComfyUI 视频工作流片段拼接'
        : '成片不是 ComfyUI 真实片段拼接（或未产出真实成片）',
    });
  }
  const failures = checks.filter((c) => !c.ok);
  return {
    ok: failures.length === 0,
    spec,
    checks,
    failures,
    clipCount: videos.length,
    totalSeconds: timelineTotal,
    summary: failures.length
      ? `时长规格未达成：${failures.map((f) => f.label).join('、')}`
      : `${spec.clipCount} 个片段 × ${spec.clipSeconds}s = ${spec.totalSeconds}s`,
  };
}
