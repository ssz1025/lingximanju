/* ============================================================================
 * 成片真实性策略（Film Policy）· 纯逻辑层，无 IO
 *
 * 问题背景：此前 composer 在没有 ComfyUI 真实片段时，会用本机 ffmpeg 把关键帧
 * 渲染成静态片段拼出一条 MP4，验收只看 `film.file` 是否存在就判「达成」。
 * 结果：ComfyUI 一次都没调用，用户却看到「30s 成片已生成 / 全流程已达成」。
 *
 * 现在把「成片是不是 AI 真实生成的」做成可核对的一等公民：
 *   - policy='real'（默认）：必须每个片段都来自 ComfyUI 视频工作流，且成片由
 *     这些真实片段拼接；少一段、或成片是 preview-frames，一律判 missing。
 *   - policy='preview'：显式允许关键帧预览成片，但必须标 degraded 并写明
 *     「不是 AI 视频」，绝不允许冒充真实短剧。
 *
 * 判定只依赖节点与产物中已经落盘的标记，不依赖运行环境，便于单测与复刻。
 * ==========================================================================*/

export const FILM_POLICIES = Object.freeze([
  {
    id: 'real', label: '真实 AI 视频', icon: '🎬',
    tagline: '每个片段都由 ComfyUI 视频工作流生成，成片由真实片段拼接',
    note: '未接入 ComfyUI 或部分片段失败时不会伪装成成片，验收如实判缺失',
  },
  {
    id: 'preview', label: '关键帧预览', icon: '🖼',
    tagline: '仅供零 Key / 无 GPU 时走通流程，成片是静态关键帧的等长拼接',
    note: '产物明确标注「非 AI 视频」，验收记为降级，不计入真实成片',
  },
]);

export const DEFAULT_FILM_POLICY = 'real';
export const POLICY_BY_ID = Object.fromEntries(FILM_POLICIES.map((p) => [p.id, p]));

export function normalizeFilmPolicy(value) {
  const id = String(value ?? '').trim().toLowerCase();
  return POLICY_BY_ID[id] ? id : DEFAULT_FILM_POLICY;
}

/** 片段是否真实：ComfyUI 工作流产物、有视频文件、未标合成预览 */
export function isRealClip(clip) {
  if (!clip || typeof clip !== 'object') return false;
  if (clip.synthetic === true) return false;
  if (clip.isRealVideo === false) return false;
  if (String(clip.provider || '') !== 'comfyui') return false;
  const file = String(clip.file || '');
  return Boolean(file) && /\.(mp4|webm|mov|mkv|m4v)$/i.test(file);
}

/** 成片是否由真实片段拼接 */
export function isRealFilm(film) {
  if (!film || !film.file) return false;
  if (film.isRealVideo === false) return false;
  if (film.source === 'preview-frames') return false;
  return film.source === 'comfyui' || film.isRealVideo === true;
}

/**
 * 汇总一次交付的真实性快照。
 * @param {object} o { project, film, policy, clipCount }
 * @returns {{policy, realClips, clipCount, allReal, isRealVideo, level, detail, blockers}}
 */
export function evaluateFilm({ project, film = null, policy = DEFAULT_FILM_POLICY, clipCount = null } = {}) {
  const mode = normalizeFilmPolicy(policy);
  const videos = (project?.nodes || []).filter((n) => n.type === 'video');
  const real = videos.filter((n) => isRealClip(n.data?.clip));
  const total = Number(clipCount) || videos.length;
  const realFilm = isRealFilm(film);
  const preview = film?.source === 'preview-frames' || film?.isRealVideo === false;
  const blockers = [];

  if (!film?.file) blockers.push('没有成片 MP4');
  else if (preview && mode === 'real') blockers.push('成片是关键帧预览（非 AI 视频）');
  if (mode === 'real' && real.length < total) {
    blockers.push(`真实 AI 片段 ${real.length}/${total} 个`);
  }
  if (mode === 'real' && film?.file && !realFilm) blockers.push('成片不是由 ComfyUI 真实片段拼接');

  let level = 'ok';
  if (blockers.length) level = mode === 'real' ? 'missing' : 'degraded';
  else if (preview) level = 'degraded';

  const detail = mode === 'real'
    ? (blockers.length
      ? `未达成真实成片：${blockers.join('；')}`
      : `${real.length} 个 ComfyUI 真实片段拼接 · ${film?.measured ? 'ffprobe 实测 ' : ''}${film?.duration ?? '?'}s`)
    : (preview
      ? `关键帧预览成片（非 AI 视频）· ${real.length}/${total} 个真实片段 · 已在验收中如实降级`
      : blockers.length ? `预览模式仍有缺失：${blockers.join('；')}` : '预览模式产物已就绪');

  return {
    policy: mode,
    policyLabel: POLICY_BY_ID[mode].label,
    realClips: real.length,
    clipCount: total,
    allReal: mode === 'real' ? real.length === total && realFilm : real.length === total,
    isRealVideo: realFilm,
    filmSource: film?.source || null,
    level,
    detail,
    blockers,
  };
}

/** 给前端 / bootstrap 的公开清单 */
export function filmPolicyPublic() {
  return FILM_POLICIES.map((p) => ({ ...p }));
}
