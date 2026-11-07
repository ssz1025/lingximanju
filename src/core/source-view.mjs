/* ============================================================================
 * 导入原著的数据统计与原文读取 · 纯逻辑层（无 DOM、无 I/O、不修改入参）
 *
 * 原著全文唯一落点是 management.source.text；历史项目可能只有全文，
 * chapters[] / sources[] / episodes[].text 全为空，需要借助 parseNovel 惰性重建。
 * 本模块只把项目数据「投影」成阅读器与统计面板所需的视图，不落盘、不写回。
 * ==========================================================================*/
import { parseNovel } from './novel.mjs';

const str = (v) => String(v ?? '');
const arr = (v) => (Array.isArray(v) ? v : []);
/** 统计数值一律兜底为有限 number：Number(...) || 0 处理 NaN/空值，再滤掉 ±Infinity */
const num = (v) => {
  const n = Number(v) || 0;
  return Number.isFinite(n) ? n : 0;
};
/** 与 parseNovel 内的 clean 同口径：去 \r、折叠行内空格、去首尾空白 */
const clean = (s) => str(s).replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
const cleanLen = (s) => clean(s).length;
const norm = clean;

/** 空项目 / 无原文时的全 0 视图 */
function emptyView() {
  return {
    ok: false,
    stats: {
      title: '', filename: '', uploadedAt: 0, totalChars: 0, chapterCount: 0,
      paragraphCount: 0, sourceCount: 0, episodeCount: 0, seasonCount: 0,
      characterCount: 0, avgCharsPerEpisode: 0, minEpisodeChars: 0,
      maxEpisodeChars: 0, linkedChapterCount: 0,
    },
    chapters: [], sources: [], episodes: [], text: '',
  };
}

/**
 * 从原文按「本章标题 → 下一章标题」切片出每章正文（不含标题行，与 parseNovel
 * 的 chapter.text 口径一致）。按标题在行内的位置顺序定位，互不越界。
 */
function sliceChapterTexts(text, titles) {
  const lines = text.split('\n');
  const targets = titles.map(norm);
  const starts = [];
  let cursor = 0;
  for (const target of targets) {
    let found = -1;
    if (target) {
      for (let i = cursor; i < lines.length; i += 1) {
        if (norm(lines[i]) === target) { found = i; break; }
      }
    }
    starts.push(found);
    if (found >= 0) cursor = found + 1;
  }
  return titles.map((_, i) => {
    const start = starts[i];
    if (start < 0) return '';
    let end = lines.length;
    for (let j = i + 1; j < starts.length; j += 1) {
      if (starts[j] > start) { end = starts[j]; break; }
    }
    return lines.slice(start + 1, end).join('\n').trim();
  });
}

/** 章节标题出现在某集 sourceTitles 中 → 该集集号 */
function inferEpisodeNo(title, episodes) {
  const t = str(title);
  if (!t) return 0;
  const hit = episodes.find((e) => arr(e?.sourceTitles).some((s) => str(s) === t));
  return hit ? (num(hit.no) || 0) : 0;
}

/** 章节标题出现在某来源 chapterTitles 中 → 该来源文件名 */
function inferSourceName(title, sources, fallback) {
  const t = str(title);
  if (!t) return fallback;
  const hit = sources.find((s) => arr(s?.chapterTitles).some((c) => str(c) === t));
  return hit ? (str(hit.name) || fallback) : fallback;
}

/** season 字段可以是数字或对象（{no}/{season}/{id}），统一取成可去重的值 */
function seasonKey(v) {
  const raw = v && typeof v === 'object' ? (v.no ?? v.season ?? v.id ?? 1) : v;
  return num(raw) || 1;
}

/**
 * 构建原著视图。
 * @param {object} project 项目对象（只读）
 * @returns {{ok:boolean, stats:object, chapters:Array, sources:Array, episodes:Array, text:string}}
 */
export function buildSourceView(project) {
  const m = project?.management;
  const source = m?.source;
  const text = str(source?.text);
  if (!text) return emptyView();

  const filename = str(source?.filename);
  const fallbackName = filename || '粘贴文本';

  // 全文只解析一次：既拿 paragraphCount，也在 chapters 缺失时用于惰性重建。
  const parsed = parseNovel(text, filename);
  // totalChars 取 source 的持久化值（clean(raw).length 口径），缺失时用同口径的
  // parseNovel.totalChars 兜底；绝不把 chapters[].chars 之和混进来。
  const totalChars = num(source?.totalChars) || num(parsed.totalChars);
  const paragraphCount = num(parsed.paragraphCount)
    || text.split(/\n+/).map((s) => s.trim()).filter(Boolean).length;

  const rawChapters = arr(m?.chapters);
  const rawSources = arr(m?.sources);
  const rawEpisodes = arr(m?.episodes);
  const rawSeasons = arr(m?.seasons);
  const characters = arr(m?.characters);

  // 章节：优先管理数据（补 text / episodeNo / sourceName），为空时从原文重建。
  let chapters;
  if (rawChapters.length) {
    const titles = rawChapters.map((c) => str(c?.title));
    const bodies = sliceChapterTexts(text, titles);
    chapters = rawChapters.map((c, i) => ({
      no: num(c?.no) || (i + 1),
      title: str(c?.title) || `第 ${i + 1} 章`,
      chars: num(c?.chars) || cleanLen(bodies[i]),
      sourceName: str(c?.sourceName),
      episodeNo: num(c?.episodeNo) || 0,
      text: bodies[i],
    }));
  } else {
    chapters = parsed.chapters.map((c, i) => ({
      no: num(c?.no) || (i + 1),
      title: str(c?.title) || `第 ${i + 1} 章`,
      chars: num(c?.chars) || cleanLen(str(c?.text)),
      sourceName: '',
      episodeNo: 0,
      text: str(c?.text),
    }));
  }

  // 来源：为空但存在原文时合成一条，chapterTitles 用当前章节标题。
  const sources = rawSources.length
    ? rawSources.map((s) => ({
      name: str(s?.name),
      chars: num(s?.chars),
      chapterTitles: arr(s?.chapterTitles).map(str),
    }))
    : [{ name: fallbackName, chars: totalChars, chapterTitles: chapters.map((c) => c.title) }];

  // 缺省关联：episodeNo 从 episodes[].sourceTitles 推断，sourceName 从 sources[].chapterTitles 推断。
  for (const c of chapters) {
    if (!c.episodeNo) c.episodeNo = inferEpisodeNo(c.title, rawEpisodes);
    if (!c.sourceName) c.sourceName = inferSourceName(c.title, sources, fallbackName);
  }

  const episodes = rawEpisodes.map((e, i) => {
    const chapterCount = arr(e?.chapters).length || arr(e?.sourceTitles).length;
    return {
      no: num(e?.no) || (i + 1),
      title: str(e?.title),
      chars: num(e?.chars),
      chapterCount: num(chapterCount),
      season: num(e?.season) || 1,
    };
  });

  const seasonCount = rawSeasons.length
    ? new Set(rawSeasons.map(seasonKey)).size
    : new Set(episodes.map((e) => e.season)).size;

  const epChars = episodes.map((e) => e.chars);
  const sumEpChars = epChars.reduce((a, b) => a + b, 0);
  const avgCharsPerEpisode = epChars.length ? Math.round(sumEpChars / epChars.length) : 0;
  const minEpisodeChars = epChars.length ? Math.min(...epChars) : 0;
  const maxEpisodeChars = epChars.length ? Math.max(...epChars) : 0;

  const stats = {
    title: str(source?.title),
    filename,
    uploadedAt: num(source?.uploadedAt),
    totalChars,
    chapterCount: num(source?.chapterCount) || chapters.length,
    paragraphCount,
    sourceCount: sources.length,
    episodeCount: episodes.length,
    seasonCount,
    characterCount: characters.length,
    avgCharsPerEpisode,
    minEpisodeChars,
    maxEpisodeChars,
    linkedChapterCount: chapters.filter((c) => num(c.episodeNo) > 0).length,
  };

  return { ok: true, stats, chapters, sources, episodes, text };
}
