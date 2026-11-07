/* ============================================================================
 * 剧集领域纯逻辑：章节 ↔ 剧集关联、分段、角色匹配、单集资源链接图。
 *
 * 无 DOM、无 I/O、无第三方依赖，可被路由层与测试直接复用。
 * 剧集数据落在 project.management.episodes[]（项目 JSON 全量覆盖写），
 * 因此「原文 / 剧本 / 宫格图 / 导演包 / 视频」都只需扩展这个数组即可持久化。
 * ==========================================================================*/
const clean = (s) => String(s ?? '').replace(/\r/g, '').trim();
const cut = (s, n) => { const t = clean(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const sentences = (text) => String(text || '').split(/(?<=[。！？!?；;])/).map(clean).filter((s) => s.length > 1);

/** 稳定 id：同一集同一段重复生成时保持不变，避免已生成的资源被当成新节点 */
export const segmentId = (epNo, segNo) => `seg_${Number(epNo) || 1}_${Number(segNo) || 1}`;

/**
 * 把 parseNovel 的章节挂到 splitEpisodes 的集上。
 * 优先用「标题出现在该集文本中 / 出现在 sourceTitles」精确匹配；
 * 按字数/段落切分时章节可能被截断，退化为「原著字符偏移落在哪一集」。
 * @returns { chapters: Array, byEpisode: Object<number, Array> }
 */
export function linkChapters(novel, episodes, chapterSources = []) {
  const eps = Array.isArray(episodes) ? episodes : [];
  const chapters = Array.isArray(novel?.chapters) ? novel.chapters : [];
  const source = String(novel?.text || '');
  let cursor = 0;
  const ranges = eps.map((ep) => {
    const start = cursor;
    cursor += Number(ep.chars) || clean(ep.text).length;
    return { no: ep.no, start, end: cursor };
  });
  const byEpisode = {};
  for (const ep of eps) byEpisode[ep.no] = [];

  const out = chapters.map((c, i) => {
    const title = clean(c.title) || `第 ${i + 1} 章`;
    const meta = Array.isArray(chapterSources) ? chapterSources[i] : null;
    let epNo = 0;
    const exact = eps.find((ep) => (Array.isArray(ep.sourceTitles) && ep.sourceTitles.includes(title))
      || String(ep.text || '').includes(title));
    if (exact) epNo = exact.no;
    if (!epNo) {
      const probe = clean(c.text).slice(0, 24);
      const at = probe ? source.indexOf(probe) : -1;
      const hit = at >= 0 ? ranges.find((r) => at >= r.start && at < r.end) : null;
      epNo = hit?.no || ranges[Math.min(ranges.length - 1, Math.floor(i / Math.max(1, chapters.length) * ranges.length))]?.no || eps[0]?.no || 0;
    }
    const row = {
      no: i + 1, title, chars: Number(c.chars) || clean(c.text).length,
      sourceName: meta?.sourceName || novel?.filename || '', episodeNo: epNo,
    };
    if (byEpisode[epNo]) byEpisode[epNo].push(row);
    return row;
  });
  return { chapters: out, byEpisode };
}

/**
 * 生成落在 management.episodes[] 的剧集记录。
 * 重算分集时按「集号 + 文本指纹」保留已经生成过的剧本 / 宫格图 / 导演包 / 视频，
 * 避免改一次集数就把用户成果清空。
 */
export function buildEpisodeRecords(episodes, novel, chapterSources = [], previous = []) {
  const { byEpisode } = linkChapters(novel, episodes, chapterSources);
  const prevByNo = new Map((Array.isArray(previous) ? previous : []).map((e) => [Number(e.no), e]));
  return (Array.isArray(episodes) ? episodes : []).map((ep) => {
    const prev = prevByNo.get(Number(ep.no));
    const text = String(ep.text || prev?.text || '');
    const sameText = prev && prev.text === text;
    return {
      no: Number(ep.no), title: ep.title, chars: Number(ep.chars) || 0,
      summary: ep.summary || '', hook: ep.hook || '',
      sourceTitles: Array.isArray(ep.sourceTitles) ? ep.sourceTitles : [],
      text, excerpt: ep.excerpt || '', strategy: ep.strategy || '',
      chapters: byEpisode[ep.no] || [],
      characterIds: sameText && Array.isArray(prev.characterIds) ? prev.characterIds : [],
      script: sameText ? (prev.script || null) : null,
      segments: sameText && Array.isArray(prev.segments) ? prev.segments : [],
      pack: sameText ? (prev.pack || null) : null,
      video: sameText ? (prev.video || null) : null,
      updatedAt: Date.now(),
    };
  });
}

/** 老项目兼容：没有持久化 text 时，从原著全文按来源章节切片还原该集原文 */
export function reconstructEpisodeText(project, ep) {
  const source = String(project?.management?.source?.text || '');
  if (!source) return '';
  const titles = Array.isArray(ep?.sourceTitles) ? ep.sourceTitles.filter(Boolean) : [];
  let start = 0;
  if (titles.length) {
    const at = source.indexOf(titles[0]);
    if (at >= 0) start = at;
  }
  const size = Math.max(Number(ep?.chars) || 1200, 800);
  return source.slice(start, start + size);
}

/**
 * 把一集原文切成若干「段」，每段对应一张 3×3 宫格图（9 个分镜格）。
 * 目标段数 3–6，按段落聚合尽量均衡；段落太少时按句子二次切分。
 */
export function splitSegments(text, maxSegments = 6, epNo = 1) {
  const body = clean(text);
  if (!body) return [];
  let units = body.split(/\n+/).map(clean).filter(Boolean);
  if (units.length < 3) units = sentences(body);
  if (!units.length) units = [body];
  const total = units.reduce((a, u) => a + u.length, 0);
  const count = Math.max(1, Math.min(maxSegments, Math.ceil(total / 420), units.length));
  const groups = Array.from({ length: count }, () => []);
  const loads = new Array(count).fill(0);
  for (const u of units) {
    let at = 0;
    for (let i = 1; i < count; i += 1) if (loads[i] < loads[at]) at = i;
    groups[at].push(u);
    loads[at] += u.length;
  }
  return groups.map((g, i) => {
    const segText = g.join('\n');
    const no = i + 1;
    const lines = sentences(segText);
    const cells = Array.from({ length: 9 }, (_, c) => {
      const base = lines.length ? lines[Math.floor(c / 9 * lines.length)] : segText.slice(c * 20, c * 20 + 20);
      const caption = cut(base || `镜头 ${c + 1}`, 16) || `镜头 ${c + 1}`;
      return {
        no: c + 1, caption,
        prompt: `第 ${epNo} 集 · 段 ${no} · 格 ${c + 1}｜${cut(base || '叙事镜头', 40)}`,
        url: '',
      };
    });
    return {
      id: segmentId(epNo, no), no, title: `第 ${no} 段 · ${cut(g[0] || '', 14)}`,
      text: segText, chars: clean(segText).length,
      cells, gridUrl: '', gridFile: '', status: 'idle',
    };
  });
}

/** 在原文中按姓名 / 别名匹配本集出场角色 */
export function matchEpisodeCharacters(episode, characters = []) {
  const text = String(episode?.text || '');
  if (!text) return [];
  const ids = [];
  for (const c of (Array.isArray(characters) ? characters : [])) {
    const names = [c?.name, ...(Array.isArray(c?.aliases) ? c.aliases : [])].filter((n) => String(n || '').trim().length >= 2);
    if (names.some((n) => text.includes(n)) && c?.id) ids.push(c.id);
  }
  return ids;
}

/**
 * 单集资源链接图：章节 → 本集 → 段落 → 宫格图，外加角色 / 剧本 / 导演包 / 视频
 * 以及项目真实画布上与该集直连的节点。前端用它渲染可平移缩放的无限画布。
 */
export function buildEpisodeGraph(project, m, ep) {
  const no = Number(ep?.no) || 1;
  const nodes = [];
  const edges = [];
  const add = (node) => { nodes.push(node); return node.id; };
  const link = (from, to, kind = 'flow', label = '') => edges.push({ id: `e_${from}_${to}`, from, to, kind, label });

  const epId = add({
    id: 'episode', kind: 'episode', label: `第 ${no} 集 · ${ep?.title || ''}`,
    sub: `${ep?.chars || 0} 字 · ${(ep?.chapters || []).length} 章 · ${(ep?.segments || []).length} 段`,
    x: 380, y: 300, state: 'ready',
  });
  const chapters = Array.isArray(ep?.chapters) ? ep.chapters : [];
  chapters.forEach((c, i) => {
    const id = add({ id: `ch_${i}`, kind: 'chapter', label: c.title, sub: `${c.sourceName || '原著'} · ${c.chars} 字`, x: 40, y: 40 + i * 130, state: 'ready' });
    link(id, epId, 'flow', '归属本集');
  });

  const segments = Array.isArray(ep?.segments) ? ep.segments : [];
  segments.forEach((s, i) => {
    const id = add({ id: `seg_${i}`, kind: 'segment', label: s.title, sub: `${s.chars} 字 · 9 格`, x: 720, y: 40 + i * 150, state: s.gridUrl ? 'done' : 'idle' });
    link(epId, id, 'flow', `第 ${i + 1} 段`);
    if (s.gridUrl) {
      const gid = add({ id: `grid_${i}`, kind: 'grid', label: `宫格图 ${i + 1}`, sub: '3 × 3 分镜', url: s.gridUrl, x: 1060, y: 40 + i * 150, state: 'done' });
      link(id, gid, 'ref', '对应图');
    }
  });

  const allChars = Array.isArray(m?.characters) ? m.characters : [];
  const ids = Array.isArray(ep?.characterIds) && ep.characterIds.length ? ep.characterIds : matchEpisodeCharacters(ep, allChars);
  const picked = allChars.filter((c) => ids.includes(c.id)).slice(0, 8);
  picked.forEach((c, i) => {
    const id = add({
      id: `chr_${c.id}`, kind: 'character', label: c.name, sub: c.role || '本集角色',
      url: c.views?.front?.url || '', x: 1060, y: 40 + (segments.length + i + 1) * 150, state: c.views?.front?.url ? 'done' : 'idle',
    });
    link(epId, id, 'ref', '出场');
  });

  const extras = [
    ['script', '剧本', ep?.script ? `${(ep.script.scenes || []).length} 场` : '未生成', Boolean(ep?.script)],
    ['pack', '导演包', ep?.pack ? '已导出' : '未导出', Boolean(ep?.pack)],
    ['video', '视频', ep?.video ? 'ComfyUI 已生成' : '未生成', Boolean(ep?.video)],
  ];
  extras.forEach(([key, label, sub, done], i) => {
    const id = add({ id: key, kind: key, label, sub, url: key === 'pack' ? ep?.pack?.url : ep?.video?.url, x: 1400, y: 60 + i * 160, state: done ? 'done' : 'idle' });
    link(epId, id, 'ref', '产物');
  });

  // 真实画布：定位本集 episode 节点及其直接上下游，把画布里的连线一并带进资源图
  const graphNodes = Array.isArray(project?.nodes) ? project.nodes : [];
  const graphEdges = Array.isArray(project?.edges) ? project.edges : [];
  const own = graphNodes.find((n) => n.type === 'episode' && Number(n.data?.episode?.no) === no);
  if (own) {
    const idsSet = new Set([own.id]);
    for (const e of graphEdges) {
      if (e.from === own.id) idsSet.add(e.to);
      if (e.to === own.id) idsSet.add(e.from);
    }
    const related = graphNodes.filter((n) => idsSet.has(n.id)).slice(0, 10);
    related.forEach((n, i) => {
      add({
        id: `gn_${n.id}`, kind: 'canvas', label: n.title || n.type,
        sub: `画布节点 · ${n.type}${n.status ? ` · ${n.status}` : ''}`,
        nodeId: n.id, x: 40 + (i % 2) * 200, y: 980 + Math.floor(i / 2) * 130, state: n.status || 'idle',
      });
    });
    for (const e of graphEdges) {
      if (idsSet.has(e.from) && idsSet.has(e.to)) link(`gn_${e.from}`, `gn_${e.to}`, e.kind || 'flow', '画布连线');
    }
    link(epId, `gn_${own.id}`, 'ref', '画布入口');
  }
  return { nodes, edges, episodeNo: no };
}
