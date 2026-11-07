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

/** 把某一集移动到指定季（返回新的 episodes 数组） */
export function assignEpisodeSeason(episodes, no, season) {
  const target = Math.max(1, Math.floor(num(season, 1)));
  return (Array.isArray(episodes) ? episodes : []).map((ep) =>
    num(ep?.no) === num(no) ? { ...ep, season: target } : ep);
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
    return { ...ep, season: 1 };
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

/** 画布范围键：overall（全部组合） / main（项目主画布） / ep:<no>（单集画布） */
export function scopeKeyOf(kind, no = 0) {
  if (kind === 'episode') return `ep:${num(no, 0)}`;
  return kind === 'main' ? 'main' : 'overall';
}

/** 解析画布范围键 */
export function parseScopeKey(key) {
  const s = String(key || 'overall');
  if (s.startsWith('ep:')) return { kind: 'episode', no: num(s.slice(3), 0) };
  return { kind: s === 'main' ? 'main' : 'overall', no: 0 };
}
