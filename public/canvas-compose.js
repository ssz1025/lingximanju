/* ============================================================================
 * 画布组合纯函数：单集种子画布 / 全项目组合总览 / 范围标签与下拉选项。
 *
 * 设计约定
 *  - 无 DOM、无 fetch、无副作用，可被 node --test 直接导入。
 *  - 所有返回值都是全新对象；绝不修改 project 或 ep（含不写回 ep.canvas）。
 *  - 历史数据兜底：ep.text / chapters[].text / segments[].text 可能是原文全文，
 *    这里只取标题与摘要字段并截断到 ≤120 字，绝不把大段原文塞进节点 data。
 *  - id 全部由入参确定性推导（无 Date / random），连续调用结果 deepEqual。
 * ==========================================================================*/
import { seasonGroups, seasonTitle, scopeKeyOf, parseScopeKey, seasonOf } from './project-model.js';
import { num, cut } from './utils.js';

const arr = (v) => (Array.isArray(v) ? v : []);
// 截断后总长度不超过 n（含省略号），保证摘要字段「≤120 字」
const clone = (o) => (o && typeof o === 'object' ? JSON.parse(JSON.stringify(o)) : o);

// 节点 type -> agent（与 public/nodes.js 的 NODE_TYPES 对齐，不引入 DOM 模块）
const AGENT_BY_TYPE = {
  idea: 'screenwriter', script: 'screenwriter', rag: 'rag', plan: 'decomposer',
  episode: null, event: 'rag', scene: 'storyboard', shot: 'keyframe',
  character: 'character', camera: 'camera-graph', keyframe: 'keyframe',
  review: 'review', video: 'video', transition: 'transition', final: 'composer', note: null,
};

const SEED_VIEWPORT = Object.freeze({ x: 40, y: 30, zoom: 0.72 });
const NOT_FOUND_VIEWPORT = Object.freeze({ x: 60, y: 40, zoom: 0.8 });
const OVERALL_VIEWPORT = Object.freeze({ x: 40, y: 40, zoom: 0.45 });

/** 构造一个符合数据契约的完整节点（带全部默认字段） */
function makeNode(id, type, title, x, y, data = {}, status = 'idle', meta = {}) {
  return {
    id, type, agent: AGENT_BY_TYPE[type] ?? null, title,
    x, y, w: 268, status, progress: 0, error: '',
    data, meta,
  };
}

/** 按集号查 episode，找不到返回 null（兼容缺 management / episodes） */
function findEpisode(project, no) {
  return arr(project?.management?.episodes).find((e) => num(e?.no) === num(no)) || null;
}

/** 章节 / 分段条目的短标签，绝不读取 .text（可能是原文全文） */
function labelOf(item, fallback) {
  if (item == null) return fallback;
  if (typeof item === 'object') return String(item.title || item.name || item.label || fallback);
  return String(item || fallback);
}

/** ≤120 字摘要，优先 summary，其次标题类字段，绝不回退到 .text */
function shortOf(item) {
  if (item == null) return '';
  if (typeof item !== 'object') return cut(item, 120);
  return cut(item.summary || item.title || item.name || item.label || '', 120);
}

/* ---------------------------------------------------------------------------
 * 1. seedEpisodeCanvas(project, no)
 * -------------------------------------------------------------------------*/
export function seedEpisodeCanvas(project, no) {
  const ep = findEpisode(project, no);
  if (!ep) return { nodes: [], edges: [], viewport: { ...NOT_FOUND_VIEWPORT } };

  const epNo = num(no);
  const epTitle = String(ep.title ?? '未命名');
  const nodes = [];
  const edges = [];

  // 单集画布统一的作用域标记：meta 供画布过滤，data.scopeRef 供组合画布反查
  const tag = (node) => {
    node.meta = { ...(node.meta || {}), scope: 'episode', episodeNo: epNo };
    node.data = {
      ...(node.data || {}),
      episodeNo: epNo,
      scopeRef: { kind: 'episode', no: epNo },
    };
    return node;
  };

  // --- root -------------------------------------------------------------
  const rootId = `ep_${epNo}_root`;
  nodes.push(tag(makeNode(rootId, 'episode', `第 ${epNo} 集 · ${cut(epTitle, 40)}`, 60, 60, {
    episode: {
      no: epNo,
      title: cut(epTitle, 40),
      chars: num(ep.chars),
      summary: cut(ep.summary, 120),
      hook: cut(ep.hook, 120),
      sourceTitles: arr(ep.sourceTitles).map((t) => cut(t, 60)),
    },
  })));

  // --- 章节（note 列）---------------------------------------------------
  let chapters = arr(ep.chapters);
  if (!chapters.length) chapters = arr(ep.sourceTitles);
  if (!chapters.length) chapters = ['本集原文'];
  chapters.forEach((c, idx) => {
    const i = idx + 1;
    const chId = `ep_${epNo}_ch_${i}`;
    nodes.push(tag(makeNode(chId, 'note', cut(labelOf(c, `章节 ${i}`), 30), 380, 60 + (i - 1) * 140, {
      text: shortOf(c),
    })));
    edges.push({ id: `ep_${epNo}_e_root_ch_${i}`, from: rootId, to: chId, kind: 'flow' });
  });

  // --- 分段（scene 列）+ 对应宫格图（keyframe 列）-----------------------
  let segments = arr(ep.segments);
  if (!segments.length) segments = [{ title: '待分镜' }];
  segments.forEach((s, idx) => {
    const j = idx + 1;
    const segTitle = labelOf(s, `分段 ${j}`);
    const segId = `ep_${epNo}_seg_${j}`;
    nodes.push(tag(makeNode(segId, 'scene', cut(segTitle, 30), 720, 60 + (j - 1) * 140, {
      summary: cut((s && typeof s === 'object' ? s.summary : '') || segTitle, 120),
      segment: {
        no: num(s?.no, j),
        title: cut(segTitle, 40),
        chars: num(s?.chars),
        cells: Array.isArray(s?.cells) ? s.cells.length : num(s?.cells),
      },
    })));
    if (s?.gridUrl) {
      const gridId = `ep_${epNo}_grid_${j}`;
      nodes.push(tag(makeNode(gridId, 'keyframe', cut(segTitle, 30), 1060, 60 + (j - 1) * 140, {
        url: String(s.gridUrl),
      })));
      edges.push({ id: `ep_${epNo}_e_seggrid_${j}`, from: segId, to: gridId, kind: 'flow' });
    }
  });

  // 章节 -> 分段（按序号取模映射）
  chapters.forEach((_, idx) => {
    const i = idx + 1;
    const j = ((i - 1) % segments.length) + 1;
    edges.push({
      id: `ep_${epNo}_e_chseg_${i}`,
      from: `ep_${epNo}_ch_${i}`,
      to: `ep_${epNo}_seg_${j}`,
      kind: 'flow',
    });
  });

  // --- x=1400 产物列 ----------------------------------------------------
  const colY = (k) => 60 + (k - 1) * 140;
  const scriptId = `ep_${epNo}_script`;
  const characterId = `ep_${epNo}_character`;
  const packId = `ep_${epNo}_pack`;
  const videoId = `ep_${epNo}_video`;
  nodes.push(tag(makeNode(scriptId, 'script', '剧本', 1400, colY(1), {}, ep.script ? 'done' : 'idle')));
  nodes.push(tag(makeNode(characterId, 'character', '角色资产', 1400, colY(2), {
    count: arr(ep.characterIds).length,
  })));
  nodes.push(tag(makeNode(packId, 'final', '导演包', 1400, colY(3), {}, ep.pack ? 'done' : 'idle')));
  nodes.push(tag(makeNode(videoId, 'video', '视频片段', 1400, colY(4), {}, ep.video ? 'done' : 'idle')));

  // --- 结尾 final（最右）-----------------------------------------------
  const finalId = `ep_${epNo}_final`;
  nodes.push(tag(makeNode(finalId, 'final', `第 ${epNo} 集 · 成片交付`, 1740, 60)));

  // --- 关系边 -----------------------------------------------------------
  edges.push({ id: `ep_${epNo}_e_ref_script`, from: rootId, to: scriptId, kind: 'ref' });
  edges.push({ id: `ep_${epNo}_e_ref_character`, from: rootId, to: characterId, kind: 'ref' });
  edges.push({ id: `ep_${epNo}_e_pack_final`, from: packId, to: finalId, kind: 'flow' });
  edges.push({ id: `ep_${epNo}_e_video_final`, from: videoId, to: finalId, kind: 'flow' });

  return { nodes, edges, viewport: { ...SEED_VIEWPORT } };
}

/* ---------------------------------------------------------------------------
 * 2. composeOverallCanvas(project)
 * -------------------------------------------------------------------------*/
export function composeOverallCanvas(project) {
  const groups = seasonGroups(project);
  const episodeCount = groups.reduce((n, g) => n + g.episodes.length, 0);
  const zeroStats = { seasonCount: 0, episodeCount: 0, nodeCount: 0, edgeCount: 0, seededCount: 0 };
  if (!episodeCount) {
    return { nodes: [], edges: [], viewport: { ...OVERALL_VIEWPORT }, stats: { ...zeroStats } };
  }

  // --- 第一遍：取画布（缺失则临时 seed，绝不写回）+ 包围盒 ---------------
  const items = [];
  let seededCount = 0;
  for (let s = 0; s < groups.length; s += 1) {
    const g = groups[s];
    for (let i = 0; i < g.episodes.length; i += 1) {
      const ep = g.episodes[i];
      let canvas = (ep.canvas && Array.isArray(ep.canvas.nodes) && ep.canvas.nodes.length)
        ? ep.canvas : null;
      if (!canvas) {
        canvas = seedEpisodeCanvas(project, num(ep.no));
        seededCount += 1;
      }
      const cnodes = arr(canvas.nodes);
      const cedges = arr(canvas.edges);
      const maxX = cnodes.length
        ? Math.max(...cnodes.map((n) => num(n?.x) + num(n?.w, 268))) + 100 : 900;
      const maxY = cnodes.length
        ? Math.max(...cnodes.map((n) => num(n?.y))) + 220 : 600;
      items.push({ s, i, epNo: num(ep.no), cnodes, cedges, maxX, maxY });
    }
  }

  const cellW = Math.max(900, ...items.map((it) => it.maxX));
  const cellH = Math.max(600, ...items.map((it) => it.maxY));

  // 节点上限保护：总节点（含季标题）超过 600 时每集只保留前 40 个
  const rawTotal = items.reduce((n, it) => n + it.cnodes.length, 0) + groups.length;
  const clipped = rawTotal > 600;
  const KEEP = 40;

  const nodes = [];
  const edges = [];
  // 每季每集保留下来的节点（用于裁剪后计算跨集衔接，保证不产生悬空边）
  const perGroupEpisodes = groups.map(() => []);

  // 季标题节点（行首）
  for (let s = 0; s < groups.length; s += 1) {
    const g = groups[s];
    const seasonNo = g.no;
    const seasonOx = 80;
    const seasonOy = 80 + s * (cellH + 180);
    nodes.push(makeNode(`cp_season_${seasonNo}`, 'note',
      `${seasonTitle(project, seasonNo)} · ${g.episodes.length} 集`,
      seasonOx, seasonOy - 70, { scopeRef: { kind: 'season', no: seasonNo } }));
  }

  // --- 第二遍：复制节点 / 边并加前缀与偏移 -----------------------------
  for (const it of items) {
    const { s, i, epNo } = it;
    const ox = 80 + (i % 3) * cellW;
    const oy = 80 + s * (cellH + 180) + Math.floor(i / 3) * (cellH + 120);
    const srcNodes = clipped ? it.cnodes.slice(0, KEEP) : it.cnodes;
    const kept = [];
    const keptOrig = new Set();

    for (const n of srcNodes) {
      const pid = `cp_${epNo}_${n.id}`;
      kept.push({ origId: n.id, pid });
      keptOrig.add(n.id);
      nodes.push({
        ...clone(n),
        id: pid,
        x: num(n?.x) + ox,
        y: num(n?.y) + oy,
        data: {
          ...(clone(n?.data) || {}),
          scopeRef: { kind: 'episode', no: epNo },
          sourceNodeId: n.id,
        },
        meta: clone(n?.meta) || {},
      });
    }

    for (const e of it.cedges) {
      if (!keptOrig.has(e.from) || !keptOrig.has(e.to)) continue; // 过滤指向被丢弃节点的边
      edges.push({
        ...clone(e),
        id: `cp_${epNo}_${e.id}`,
        from: `cp_${epNo}_${e.from}`,
        to: `cp_${epNo}_${e.to}`,
      });
    }

    perGroupEpisodes[s].push({ epNo, kept });
  }

  // --- 跨集衔接（按集号升序，裁剪之后计算，端点必然存在）----------------
  for (let s = 0; s < groups.length; s += 1) {
    const eps = perGroupEpisodes[s];
    for (let k = 0; k + 1 < eps.length; k += 1) {
      const prev = eps[k];
      const next = eps[k + 1];
      if (!prev.kept.length || !next.kept.length) continue;
      const findPid = (ep, origId) => ep.kept.find((x) => x.origId === origId)?.pid;
      const from = findPid(prev, `ep_${prev.epNo}_final`) || prev.kept[prev.kept.length - 1].pid;
      const to = findPid(next, `ep_${next.epNo}_root`) || next.kept[0].pid;
      edges.push({ id: `cp_link_${prev.epNo}_${next.epNo}`, from, to, kind: 'ref' });
    }
  }

  return {
    nodes,
    edges,
    viewport: { ...OVERALL_VIEWPORT },
    stats: {
      seasonCount: groups.length,
      episodeCount,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      seededCount,
    },
  };
}

/* ---------------------------------------------------------------------------
 * 3. canvasScopeLabel(project, key)
 * -------------------------------------------------------------------------*/
/** 分集标题常以「第 N 集 · 」开头，避免下拉里出现「第 1 集 · 第 1 集 · …」 */
function epShortTitle(ep, n = 16) {
  const raw = String(ep?.title || '未命名').replace(/^第\s*\d+\s*集\s*[·:：\-]?\s*/, '').trim();
  return cut(raw || '未命名', n);
}

export function canvasScopeLabel(project, key) {
  const { kind, no } = parseScopeKey(key);
  if (kind === 'overall') return '全部 · 组合画布';
  if (kind === 'main') return '项目主画布';

  const ep = findEpisode(project, no);
  if (!ep) return `第 ${no} 集`;
  let label = `第 ${no} 集 · ${epShortTitle(ep, 16)}`;
  if (seasonGroups(project).length > 1) {
    label = `${seasonTitle(project, seasonOf(ep))} · ${label}`;
  }
  return label;
}

/* ---------------------------------------------------------------------------
 * 4. canvasScopeOptions(project)
 * -------------------------------------------------------------------------*/
export function canvasScopeOptions(project) {
  const options = [
    { key: scopeKeyOf('overall'), label: canvasScopeLabel(project, scopeKeyOf('overall')), group: '总览' },
    { key: scopeKeyOf('main'), label: canvasScopeLabel(project, scopeKeyOf('main')), group: '总览' },
  ];
  for (const g of seasonGroups(project)) {
    options.push({ key: '', label: seasonTitle(project, g.no), group: '分季', divider: true });
    for (const ep of g.episodes) {
      const no = num(ep.no);
      options.push({
        key: scopeKeyOf('episode', no),
        label: `第 ${no} 集 · ${epShortTitle(ep, 16)}`,
        group: '分集',
      });
    }
  }
  return options;
}
