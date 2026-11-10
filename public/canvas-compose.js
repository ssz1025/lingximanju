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

/** 单集画布统一的作用域标记：meta 供画布过滤，data.scopeRef 供组合画布反查 */
function tagNode(node, epNo) {
  node.meta = { ...(node.meta || {}), scope: 'episode', episodeNo: epNo };
  node.data = {
    ...(node.data || {}),
    episodeNo: epNo,
    scopeRef: { kind: 'episode', no: epNo },
  };
  return node;
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

  // 单集画布统一的作用域标记（复用 tagNode）
  const tag = (node) => tagNode(node, epNo);

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

  // --- 第一遍：取画布（缺失则播种；已有画布也先做资源同步，保证新分镜板 / 角色图可见） ---
  const items = [];
  let seededCount = 0;
  for (let s = 0; s < groups.length; s += 1) {
    const g = groups[s];
    for (let i = 0; i < g.episodes.length; i += 1) {
      const ep = g.episodes[i];
      const hadCanvas = Boolean(ep.canvas && Array.isArray(ep.canvas.nodes) && ep.canvas.nodes.length);
      if (!hadCanvas) seededCount += 1;
      // syncEpisodeCanvasResources 是纯函数：播种 / 增补资源节点都不写回 ep.canvas
      const canvas = syncEpisodeCanvasResources(project, num(ep.no)).canvas;
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
 * 2.5 资源同步：把最新生成的分镜板 / 角色定妆图等同步进单集画布
 *
 * 背景：ep.canvas 一旦播种就随项目持久化，之后在工作台生成分镜板（ep.segments[].gridUrl）
 * 或角色定妆图（m.characters[].views）只会改剧集数据，画布上看不到也没有连线。
 * 本函数以「确定性 id + 幂等增改」把资源节点补进画布：
 *  - 段节点 ep_<no>_seg_<j> / 分镜板节点 ep_<no>_grid_<j>（段 → 分镜板 flow 边）
 *  - 角色节点 ep_<no>_chr_<charId>（资产节点 → 角色 ref 边），资产节点带缩略图数据
 *  - 清理已失效的自动节点（分段重切后多余的 seg/grid、取消关联的 chr）
 *  - 绝不移动既有节点，也不删除用户手搭的节点（只认确定性 id 的自动节点）
 * 纯函数：不修改入参 project / ep.canvas，返回 { canvas, changed }。
 * -------------------------------------------------------------------------*/

/** 角色的任一可用定妆图：优先正面，其次任意视图 */
function portraitUrlOf(char) {
  const views = char?.views && typeof char.views === 'object' ? char.views : {};
  return String(views.front?.url || Object.values(views).find((v) => v?.url)?.url || '');
}

/** 本集出场角色：优先 characterIds 精确关联，否则按姓名 / 别名在原文中出现兜底 */
function involvedCharacters(ep, allChars) {
  const chars = arr(allChars).filter((c) => c?.id);
  let picked = [];
  if (Array.isArray(ep?.characterIds) && ep.characterIds.length) {
    const byId = new Map(chars.map((c) => [String(c.id), c]));
    picked = ep.characterIds.map((id) => byId.get(String(id))).filter(Boolean);
  } else {
    const text = String(ep?.text || '') + String(ep?.summary || '');
    if (text) {
      picked = chars.filter((c) => {
        const names = [c.name, ...(Array.isArray(c.aliases) ? c.aliases : [])]
          .filter((n) => String(n || '').trim().length >= 2);
        return names.some((n) => text.includes(n));
      }).slice(0, 12);
    }
  }
  return picked.map((char) => ({ char, url: portraitUrlOf(char) }));
}

export function syncEpisodeCanvasResources(project, no) {
  const epNo = num(no);
  const ep = findEpisode(project, epNo);
  const hadCanvas = Boolean(ep?.canvas && Array.isArray(ep.canvas.nodes) && ep.canvas.nodes.length);

  // 无画布数据时播种；有则克隆（绝不直接改入参的 ep.canvas）
  let canvas;
  if (!ep) {
    canvas = { nodes: [], edges: [], viewport: { ...NOT_FOUND_VIEWPORT } };
    return { canvas, changed: false };
  }
  canvas = hadCanvas ? clone(ep.canvas) : seedEpisodeCanvas(project, epNo);
  if (!Array.isArray(canvas.edges)) canvas.edges = [];
  if (!canvas.viewport) canvas.viewport = { ...SEED_VIEWPORT };

  // changed 以「与项目里已持久化的 ep.canvas 是否一致」为基准（本函数是纯函数，不写回）
  const storedJson = JSON.stringify(ep.canvas || null);
  const nodeById = new Map(canvas.nodes.map((n) => [String(n?.id), n]));
  const edgeById = new Map(canvas.edges.map((e) => [String(e?.id), e]));
  const putNode = (node) => {
    if (!nodeById.has(node.id)) { canvas.nodes.push(node); nodeById.set(node.id, node); }
  };
  const putEdge = (edge) => {
    // 端点必须真实存在，避免制造悬空边
    if (edgeById.has(edge.id) || !nodeById.has(edge.from) || !nodeById.has(edge.to)) return;
    canvas.edges.push(edge); edgeById.set(edge.id, edge);
  };

  const segments = arr(ep.segments);
  const involved = involvedCharacters(ep, project?.management?.characters);

  // --- 分段节点 + 分镜板节点（含 URL 更新） ------------------------------
  segments.forEach((s, idx) => {
    const j = idx + 1;
    const segId = `ep_${epNo}_seg_${j}`;
    const segTitle = cut(labelOf(s, `分段 ${j}`), 30);
    const segData = {
      summary: cut((s && typeof s === 'object' ? s.summary : '') || segTitle, 120),
      segment: {
        no: num(s?.no, j),
        title: cut(labelOf(s, `分段 ${j}`), 40),
        chars: num(s?.chars),
        cells: Array.isArray(s?.cells) ? s.cells.length : num(s?.cells),
      },
    };
    const segNode = nodeById.get(segId);
    if (segNode) {
      if (segNode.title !== segTitle) segNode.title = segTitle;
      segNode.data = { ...(segNode.data || {}), ...segData };
    } else {
      putNode(tagNode(makeNode(segId, 'scene', segTitle, 720, 60 + (j - 1) * 140, segData), epNo));
    }
    const gridUrl = s?.gridUrl ? String(s.gridUrl) : '';
    const gridId = `ep_${epNo}_grid_${j}`;
    if (gridUrl) {
      const gridNode = nodeById.get(gridId);
      if (gridNode) {
        if (gridNode.data?.url !== gridUrl) gridNode.data = { ...(gridNode.data || {}), url: gridUrl };
        if (gridNode.status !== 'done') gridNode.status = 'done';
      } else {
        putNode(tagNode(makeNode(gridId, 'keyframe', cut(labelOf(s, `分段 ${j}`), 30), 1060, 60 + (j - 1) * 140, {
          url: gridUrl,
        }, 'done'), epNo));
      }
      putEdge({ id: `ep_${epNo}_e_seggrid_${j}`, from: segId, to: gridId, kind: 'flow' });
    }
  });

  // --- 角色定妆图节点 + 资产节点汇总 ------------------------------------
  const assetId = `ep_${epNo}_character`;
  const rootId = `ep_${epNo}_root`;
  const anchorId = nodeById.has(assetId) ? assetId : (nodeById.has(rootId) ? rootId : null);
  involved.forEach(({ char, url }, i) => {
    const chrId = `ep_${epNo}_chr_${char.id}`;
    const chrNode = nodeById.get(chrId);
    if (chrNode) {
      if (chrNode.title !== char.name) chrNode.title = String(char.name);
      chrNode.data = { ...(chrNode.data || {}), name: char.name, url };
      if (url && chrNode.status !== 'done') chrNode.status = 'done';
    } else {
      putNode(tagNode(makeNode(chrId, 'character', String(char.name), 1400, 60 + (5 + i) * 140, {
        name: char.name, url,
      }, url ? 'done' : 'idle'), epNo));
    }
    if (anchorId) putEdge({ id: `ep_${epNo}_e_charasset_${char.id}`, from: anchorId, to: chrId, kind: 'ref' });
  });
  const assetNode = nodeById.get(assetId);
  if (assetNode) {
    const nextData = { ...(assetNode.data || {}), count: involved.length };
    if (involved.length) {
      // 只在有角色时写入缩略图数据，避免空数组 diff 导致每次同步都误报变化
      nextData.characters = involved.map(({ char, url }) => ({ name: char.name, portraitUrl: url }));
    }
    if (JSON.stringify(assetNode.data) !== JSON.stringify(nextData)) assetNode.data = nextData;
    if (involved.some((x) => x.url) && assetNode.status === 'idle') assetNode.status = 'done';
  }

  // --- 产物节点状态只升不降（剧本 / 导演包 / 视频生成后点亮） -----------
  [['script', Boolean(ep.script)], ['pack', Boolean(ep.pack)], ['video', Boolean(ep.video)]]
    .forEach(([key, done]) => {
      const n = nodeById.get(`ep_${epNo}_${key}`);
      if (n && done && n.status === 'idle') n.status = 'done';
    });

  // --- 清理失效的自动节点：重切后多余的分段 / 无图分镜板 / 取消关联的角色
  const involvedIds = new Set(involved.map(({ char }) => String(char.id)));
  const segRe = new RegExp(`^ep_${epNo}_seg_(\\d+)$`);
  const gridRe = new RegExp(`^ep_${epNo}_grid_(\\d+)$`);
  const chrRe = new RegExp(`^ep_${epNo}_chr_(.+)$`);
  const drop = new Set();
  for (const n of canvas.nodes) {
    const id = String(n?.id || '');
    const ms = id.match(segRe);
    if (ms && num(ms[1]) > segments.length) { drop.add(id); continue; }
    const mg = id.match(gridRe);
    if (mg && (num(mg[1]) > segments.length || !arr(ep.segments)[num(mg[1]) - 1]?.gridUrl)) { drop.add(id); continue; }
    const mc = id.match(chrRe);
    if (mc && !involvedIds.has(mc[1])) drop.add(id);
  }
  if (drop.size) {
    canvas.nodes = canvas.nodes.filter((n) => !drop.has(String(n?.id)));
    canvas.edges = canvas.edges.filter((e) => !drop.has(String(e?.from)) && !drop.has(String(e?.to)));
  }

  return { canvas, changed: JSON.stringify(canvas) !== storedJson };
}

/* ---------------------------------------------------------------------------
 * 2.6 主画布角色资产同步：工作台生成的定妆图同步进主画布的「角色资产」节点
 * 直接就地更新 project.nodes（主画布本身就是 project），返回是否有变化。
 * -------------------------------------------------------------------------*/
export function syncMainCanvasCharacterAssets(project) {
  const characters = arr(project?.management?.characters)
    .map((c) => ({ name: String(c?.name || ''), portraitUrl: portraitUrlOf(c) }))
    .filter((c) => c.name);
  let changed = false;
  for (const n of arr(project?.nodes)) {
    if (n?.type !== 'character') continue;
    const nextData = { ...(n.data || {}), count: characters.length, characters };
    if (JSON.stringify(n.data) !== JSON.stringify(nextData)) { n.data = nextData; changed = true; }
    if (characters.length && n.status === 'idle') { n.status = 'done'; changed = true; }
  }
  return changed;
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
