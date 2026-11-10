/* ============================================================================
 * 项目数据模型纯函数：季 / 集分组、季管理、集标签。
 *
 * 设计约定
 *  - 「季」是轻量的分组视图，不改动既有的全局唯一集号 no（老项目完全兼容）：
 *    每集上的 season 字段（缺省 1）决定归属，management.seasons[] 只存季标题。
 *  - 所有函数都不修改入参，返回新数组 / 新值，便于 Node 单测与前端状态更新。
 *  - 无 DOM、无 fetch，可在 node --test 中直接导入。
 * ==========================================================================*/

/** 一集所属的季（历史数据没有 season 时归入第一季） */
import { esc, cut, num } from './utils.js';

export function seasonOf(ep) {
  const n = num(ep?.season, 0);
  return n > 0 ? Math.floor(n) : 1;
}

/** 季标题：management.seasons[] 里有自定义名称就用它，否则「第 N 季」 */
export function seasonTitle(project, no) {
  const m = project?.management || {};
  const found = (Array.isArray(m.seasons) ? m.seasons : []).find((s) => num(s?.no) === num(no));
  return String(found?.title || `第 ${num(no, 1)} 季`);
}

/**
 * 按季分组，永远返回按季号升序的数组。
 * 没有季号的集全部落在第一季；季标题缺失自动补默认名。
 * @returns {Array<{no:number,title:string,episodes:Array<object>,chars:number}>}
 */
export function seasonGroups(project) {
  const m = project?.management || {};
  const eps = Array.isArray(m.episodes) ? m.episodes : [];
  const declared = Array.isArray(m.seasons) ? m.seasons : [];
  if (!eps.length && !declared.length) return [];
  const map = new Map();
  // 先登记 seasons[] 里声明过的季：新建的空季也要显示，否则用户没法把集移进去
  for (const s of declared) {
    const no = Math.max(1, Math.floor(num(s?.no, 0)));
    if (!map.has(no)) map.set(no, { no, title: seasonTitle(project, no), episodes: [], chars: 0 });
  }
  for (const ep of eps) {
    const no = seasonOf(ep);
    if (!map.has(no)) map.set(no, { no, title: seasonTitle(project, no), episodes: [], chars: 0 });
    const g = map.get(no);
    g.episodes.push(ep);
    g.chars += num(ep?.chars);
  }
  return [...map.values()].sort((a, b) => a.no - b.no).map((g) => ({
    ...g,
    episodes: [...g.episodes].sort((a, b) => num(a?.no) - num(b?.no)),
  }));
}

/** 季 / 集数量摘要（侧栏、统计条共用） */
export function seasonSummary(project) {
  const groups = seasonGroups(project);
  const episodes = groups.reduce((n, g) => n + g.episodes.length, 0);
  return {
    seasonCount: groups.length,
    episodeCount: episodes,
    chars: groups.reduce((n, g) => n + g.chars, 0),
    perSeason: groups.map((g) => ({ no: g.no, title: g.title, count: g.episodes.length })),
  };
}

/**
 * 中文季 / 集标签：界面上不再使用 EP、S01、S01E02 这类英文缩略。
 * 所有选集控件、制作队列、状态提示都走这三个函数，保证同一集在任何地方写法一致。
 * 集号沿用全局唯一的 ep.no（季只是分组视图），因此「第 2 季 第 4 集」是正常写法。
 */
export function seasonLabel(season) {
  const n = num(season, 0);
  return `第 ${n > 0 ? Math.floor(n) : '?'} 季`;
}

/** 只写集号的短标签（季已在邻近标题里说明时用） */
export function episodeNoLabel(no) {
  const n = num(no, 0);
  return `第 ${n > 0 ? n : '?'} 集`;
}

/** 完整的剧集选择标签：第 1 季 第 1 集 */
export function episodeLabelFull(season, no) {
  return `${seasonLabel(season)} ${episodeNoLabel(no)}`;
}

/**
 * 导航条专用紧凑标签：第1季-1（无空格、连字符、集号沿用全局唯一编号）。
 * 只用于中间制作步骤窄栏 / 收起态状态轨；其它位置仍用 episodeLabelFull 的完整中文标签。
 * 异常值兜底「第?季-?」，绝不产出 undefined / NaN。
 */
export function episodeLabelShort(season, no) {
  const s = num(season, 0);
  const n = num(no, 0);
  return `第${s > 0 ? Math.floor(s) : '?'}季-${n > 0 ? n : '?'}`;
}

/** 队列项 → 完整中文标签（episodeQueue / nextPendingEpisode 返回值可直接传） */
export function queueItemLabel(item) {
  return episodeLabelFull(item?.season, item?.no);
}

/** 集的短标签，兼容缺 title / 缺 no 的老数据 */
export function episodeLabel(ep) {
  const no = num(ep?.no, 0);
  return `第 ${no || '?'} 集 · ${cut(ep?.title || '未命名', 16)}`;
}

/** 集在页面上的完整标题（HTML 已转义） */
export function episodeTitleHTML(project, ep) {
  const no = num(ep?.no, 0);
  return esc(`第 ${no || '?'} 集 · ${cut(ep?.title || '未命名', 22)}`);
}

/** 把某一集移动到指定季（返回新的 episodes 数组）；手动移过的集不再是「自动归季」 */
export function assignEpisodeSeason(episodes, no, season) {
  const target = Math.max(1, Math.floor(num(season, 1)));
  return (Array.isArray(episodes) ? episodes : []).map((ep) =>
    num(ep?.no) === num(no) ? { ...ep, season: target, seasonAuto: false } : ep);
}

/** 新增/重命名季时规范化 seasons[]（返回新数组，绝不会写出重复季号） */
export function setSeasonTitle(seasons, no, title) {
  const target = Math.max(1, Math.floor(num(no, 1)));
  const clean = String(title ?? '').trim().slice(0, 24);
  const list = (Array.isArray(seasons) ? seasons : []).filter((s) => num(s?.no) !== target);
  list.push(clean ? { no: target, title: clean } : { no: target });
  return list.sort((a, b) => num(a?.no) - num(b?.no));
}

/** 追加一季，返回 { seasons, no }；no 为新建季号 */
export function addSeason(seasons, groups = []) {
  const used = new Set([
    ...(Array.isArray(seasons) ? seasons : []).map((s) => num(s?.no)),
    ...(Array.isArray(groups) ? groups : []).map((g) => num(g?.no)),
    1,
  ]);
  let no = 2;
  while (used.has(no)) no += 1;
  return { seasons: [...(Array.isArray(seasons) ? seasons : []), { no }], no };
}

/** 删除一季：该季的集回到第一季，返回 { seasons, episodes, moved } */
export function removeSeason(seasons, episodes, no) {
  const target = Math.max(1, Math.floor(num(no, 1)));
  if (target === 1) return { seasons, episodes, moved: 0 }; // 第一季是兜底季，不允许删
  let moved = 0;
  const nextEpisodes = (Array.isArray(episodes) ? episodes : []).map((ep) => {
    if (seasonOf(ep) !== target) return ep;
    moved += 1;
    return { ...ep, season: 1, seasonAuto: false };
  });
  return {
    seasons: (Array.isArray(seasons) ? seasons : []).filter((s) => num(s?.no) !== target),
    episodes: nextEpisodes,
    moved,
  };
}

/* --------------------------------------------------------------------------
 * 原著统计的前端等价实现：后端 GET /source 未重启 / 暂不可达时兜底，
 * 保证「原著」Tab 在任何情况下都能显示统计、章节目录与全文。
 * 与 src/core/source-view.mjs 口径一致，纯函数、不修改入参。
 * ------------------------------------------------------------------------*/
const CHAPTER_RE = /^\s*(?:第\s*[一二三四五六七八九十百千零〇两0-9]+\s*[章节回卷集部篇](?:\s*[：:\-—.、]?\s*.{0,40})?|Chapter\s+\d+|CHAPTER\s+\d+|[0-9]{1,3}\s*[、.．]\s*.{1,40})\s*$/;

export function localSourceView(project) {
  const m = project?.management || {};
  const s = m.source || {};
  const text = String(s.text || '');
  const eps = Array.isArray(m.episodes) ? m.episodes : [];
  let lines = text.replace(/\r\n?/g, '\n').split('\n');
  // 与 parseNovel 一致：首行若是短书名（非章节标记、无句末标点）不并入正文
  const firstIdx = lines.findIndex((l) => l.trim());
  const first = firstIdx >= 0 ? lines[firstIdx].replace(/[ \t]+/g, ' ').trim() : '';
  if (first && first.length <= 24 && !CHAPTER_RE.test(first) && !/[。！？!?，,；;]$/.test(first)) {
    lines = lines.slice(firstIdx + 1);
  }
  const chapters = [];
  let cur = null;
  for (const line of lines) {
    const t = line.replace(/[ \t]+/g, ' ').trim();
    if (!t) continue;
    if (CHAPTER_RE.test(t) && t.length <= 46) {
      if (cur && cur.text.trim()) chapters.push(cur);
      cur = { title: t, text: '' };
    } else {
      if (!cur) cur = { title: '开篇', text: '' };
      cur.text += (cur.text ? '\n' : '') + t;
    }
  }
  if (cur && cur.text.trim()) chapters.push(cur);
  if (!chapters.length && text.trim()) chapters.push({ title: '正文', text: text.trim() });

  const titleIndex = new Map();
  for (const ep of eps) {
    for (const t of (Array.isArray(ep?.sourceTitles) ? ep.sourceTitles : [])) {
      titleIndex.set(String(t).trim(), num(ep?.no));
    }
  }
  const sources = (Array.isArray(m.sources) && m.sources.length)
    ? m.sources
    : (text ? [{ name: s.filename || '粘贴文本', chars: text.length, chapterTitles: chapters.map((c) => c.title) }] : []);
  const sourceOf = new Map();
  for (const f of sources) for (const t of (Array.isArray(f?.chapterTitles) ? f.chapterTitles : [])) sourceOf.set(String(t).trim(), f.name);
  const outChapters = chapters.map((c, i) => ({
    no: i + 1, title: c.title, chars: c.text.length,
    sourceName: sourceOf.get(c.title) || sources[0]?.name || '',
    episodeNo: titleIndex.get(c.title) || 0, text: c.text,
  }));
  const chars = eps.map((e) => num(e?.chars));
  const sum = chars.reduce((a, b) => a + b, 0);
  return {
    ok: !!text,
    stats: {
      title: s.title || project?.name || '', filename: s.filename || '', uploadedAt: num(s.uploadedAt),
      totalChars: num(s.totalChars) || text.length,
      chapterCount: num(s.chapterCount) || outChapters.length,
      paragraphCount: text.split(/\n+/).filter((x) => x.trim()).length,
      sourceCount: sources.length, episodeCount: eps.length,
      seasonCount: seasonGroups(project).length,
      characterCount: (Array.isArray(m.characters) ? m.characters : []).length,
      avgCharsPerEpisode: chars.length ? Math.round(sum / chars.length) : 0,
      minEpisodeChars: chars.length ? Math.min(...chars) : 0,
      maxEpisodeChars: chars.length ? Math.max(...chars) : 0,
      linkedChapterCount: outChapters.filter((c) => c.episodeNo > 0).length,
    },
    chapters: outChapters,
    sources: sources.map((f) => ({ name: f?.name || '', chars: num(f?.chars), chapterTitles: f?.chapterTitles || [] })),
    episodes: eps.map((e) => ({
      no: num(e?.no), title: e?.title || '', chars: num(e?.chars),
      chapterCount: (Array.isArray(e?.chapters) ? e.chapters.length : 0) || (Array.isArray(e?.sourceTitles) ? e.sourceTitles.length : 0),
      season: seasonOf(e),
    })),
    text,
  };
}

/* --------------------------------------------------------------------------
 * 分季分集的「制作进度」与筛选：工作台卡片、统计条、剧本覆盖率共用。
 * 全部为纯函数，不修改入参，可在 node --test 中直接断言。
 * ------------------------------------------------------------------------*/

/* --------------------------------------------------------------------------
 * 顺序制作队列：分季分集之后，按「季升序 → 季内集号升序 → 定稿」串行推进。
 * 集号仍是全局唯一，季只是分组视图；手动移过季的集由 seasonGroups 决定入队顺序。
 * 定稿状态写在 ep.finalized = { at, season, no }；老项目没有这个字段 = 未定稿。
 * ------------------------------------------------------------------------*/

export const EPISODE_STAGE_KEYS = ['script', 'context', 'storyboard', 'deliver'];

/** 单集某一段是否完成：前端流水线、区头、后端定稿判定共用这一份口径 */
export function episodeStageDone(ep, key) {
  if (key === 'script') return Boolean(ep?.script);
  const st = ep?.steps?.[key]?.status;
  if (st === 'done') return true;
  if (st === 'running' || st === 'error') return false;
  if (key === 'context') return Boolean(ep?.script) && (ep?.characterIds || []).length > 0;
  if (key === 'storyboard') {
    const segs = Array.isArray(ep?.segments) ? ep.segments : [];
    return segs.length > 0 && segs.every((s) => Boolean(s?.gridUrl));
  }
  if (key === 'deliver') return Boolean(ep?.film?.file);
  return false;
}

/** 四段是否全部完成：能不能定稿的硬门槛 */
export function episodeStagesDone(ep) {
  const stages = Object.fromEntries(EPISODE_STAGE_KEYS.map((k) => [k, episodeStageDone(ep, k)]));
  return {
    ...stages,
    done: EPISODE_STAGE_KEYS.every((k) => stages[k]),
    missing: EPISODE_STAGE_KEYS.filter((k) => !stages[k]),
  };
}

export function isFinalized(ep) { return Boolean(ep?.finalized?.at); }

/** 定稿 / 撤销定稿（返回新的 episodes 数组，不改入参） */
export function markFinalized(episodes, no, on = true) {
  return (Array.isArray(episodes) ? episodes : []).map((ep) => {
    if (num(ep?.no) !== num(no)) return ep;
    if (on) return { ...ep, finalized: { at: Date.now(), season: seasonOf(ep), no: num(ep.no) } };
    const next = { ...ep };
    delete next.finalized;
    return next;
  });
}

/** 顺序队列：季升序 + 季内集号升序，每项带季号 / 季内序号 / 定稿与四段状态 */
export function episodeQueue(project) {
  return seasonGroups(project).flatMap((g) => g.episodes.map((ep, i) => ({
    season: g.no,
    seasonTitle: g.title,
    no: num(ep?.no),
    ep,
    indexInSeason: i + 1,
    seasonSize: g.episodes.length,
    finalized: isFinalized(ep),
    stagesDone: episodeStagesDone(ep).done,
  })));
}

/** 当前制作位：第一个未定稿的集（首次 = 第一季第一集；全部定稿 = 最后一集） */
export function defaultEpisode(project) {
  const q = episodeQueue(project);
  if (!q.length) return null;
  return q.find((x) => !x.finalized) || q[q.length - 1];
}

/** 定稿后的下一集：只往后找未定稿的，天然跨季；后面没有则返回 null */
export function nextPendingEpisode(project, currentNo) {
  const q = episodeQueue(project);
  const i = q.findIndex((x) => num(x.no) === num(currentNo));
  if (i < 0) return defaultEpisode(project);
  return q.slice(i + 1).find((x) => !x.finalized) || null;
}

/** 队列里相邻的一集（上一集 / 下一集用，跨季也连续） */
export function adjacentEpisode(project, currentNo, delta = 1) {
  const q = episodeQueue(project);
  const i = q.findIndex((x) => num(x.no) === num(currentNo));
  if (i < 0) return null;
  return q[i + delta] || null;
}

/** 每季定稿进度：第 1 季 3/12 集已定稿 */
export function seasonFinalProgress(project) {
  return seasonGroups(project).map((g) => {
    const finalized = g.episodes.filter(isFinalized).length;
    return {
      no: g.no, title: g.title, total: g.episodes.length, finalized,
      allDone: g.episodes.length > 0 && finalized === g.episodes.length,
    };
  });
}

/** 能否定稿本集：四段全完成且尚未定稿 */
export function canFinalizeEpisode(ep) {
  return !isFinalized(ep) && episodeStagesDone(ep).done;
}

/** 单集的制作阶段：剧本 → 分镜 → 视频，任一环节缺失即未完成 */
export function episodeProduction(ep) {
  const segs = Array.isArray(ep?.segments) ? ep.segments : [];
  const script = ep?.script || null;
  const grids = segs.filter((s) => Boolean(s?.gridUrl)).length;
  const scenes = num(script?.stats?.sceneCount, Array.isArray(script?.scenes) ? script.scenes.length : 0);
  const lines = num(script?.stats?.lineCount, 0);
  const chars = num(script?.stats?.chars, 0);
  const stages = [
    { key: 'script', label: '剧本', done: Boolean(script) },
    { key: 'grid', label: '分镜', done: segs.length > 0 && grids === segs.length, partial: grids > 0 && grids < segs.length },
    { key: 'video', label: '视频', done: Boolean(ep?.video) },
  ];
  return {
    script: Boolean(script), scenes, lines, chars,
    source: script?.source || '',
    grids, segments: segs.length,
    video: Boolean(ep?.video), pack: Boolean(ep?.pack),
    percent: Math.round(stages.filter((s) => s.done).length / stages.length * 100),
    stages,
  };
}

/** 剧本覆盖率：工作台 ④ 剧本创作与分季分集的统计条共用 */
export function scriptCoverage(episodes = []) {
  const list = Array.isArray(episodes) ? episodes : [];
  const written = list.filter((e) => e?.script);
  const scenes = written.reduce((n, e) => n + num(e.script?.stats?.sceneCount, (e.script?.scenes || []).length), 0);
  const chars = written.reduce((n, e) => n + num(e.script?.stats?.chars, 0), 0);
  const bySource = { llm: 0, mock: 0, manual: 0 };
  for (const e of written) if (bySource[e.script?.source] !== undefined) bySource[e.script.source] += 1;
  return {
    total: list.length, written: written.length, missing: list.length - written.length,
    percent: list.length ? Math.round(written.length / list.length * 100) : 0,
    scenes, chars, bySource,
    missingNos: list.filter((e) => !e?.script).map((e) => num(e?.no)),
  };
}

export const EPISODE_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'script', label: '已写剧本' },
  { id: 'noscript', label: '待写剧本' },
  { id: 'grid', label: '已出分镜' },
  { id: 'video', label: '已出视频' },
];

/** 按关键词 + 制作状态筛选按季分组（空季在筛选时隐藏，全量时保留以便移集） */
export function filterSeasonGroups(groups = [], { query = '', status = 'all' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const hit = (ep) => {
    const prod = episodeProduction(ep);
    if (status === 'script' && !prod.script) return false;
    if (status === 'noscript' && prod.script) return false;
    if (status === 'grid' && !prod.grids) return false;
    if (status === 'video' && !prod.video) return false;
    if (!q) return true;
    const hay = [
      ep?.no, ep?.title, ep?.summary, ep?.hook,
      ...(Array.isArray(ep?.chapters) ? ep.chapters.map((c) => c?.title) : []),
      ...(Array.isArray(ep?.sourceTitles) ? ep.sourceTitles : []),
    ].join(' ').toLowerCase();
    return hay.includes(q);
  };
  const filtering = Boolean(q) || status !== 'all';
  return (Array.isArray(groups) ? groups : []).map((g) => ({
    ...g,
    episodes: (g.episodes || []).filter(hit),
  })).filter((g) => (filtering ? g.episodes.length > 0 : true));
}

/** 画布范围键：overall（全部组合） / main（项目主画布） / ep:<no>（单集画布） */export function scopeKeyOf(kind, no = 0) {
  if (kind === 'episode') return `ep:${num(no, 0)}`;
  return kind === 'main' ? 'main' : 'overall';
}

/** 解析画布范围键 */
export function parseScopeKey(key) {
  const s = String(key || 'overall');
  if (s.startsWith('ep:')) return { kind: 'episode', no: num(s.slice(3), 0) };
  return { kind: s === 'main' ? 'main' : 'overall', no: 0 };
}
