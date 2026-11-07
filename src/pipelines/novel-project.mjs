/* ============================================================================
 * 新建「创作项目」：上传小说 → 分集 → 画布骨架 + 项目管理元数据
 *
 * 复用 buildTemplate('novel2video') 的完整 DAG（画布必须保留、可任意改写），
 * 在原图之上插入「小说上传 / 分集目录」节点，并把原著全文、分集表、交付设置
 * 注入对应节点，使后续智能体真正读到用户上传的内容。
 * 六步任务由 src/core/project-steps.mjs 定义，见 docs/THEORY.md。
 *
 * 两种创建路径（产出一致的节点结构）：
 *   · 上传后创建（text 非空）→ 骨架 + 立即 attachSource，①② 步创建即完成
 *   · 极简创建（不传 text）  → 只建骨架，六步全待执行，小说上传延后到第 ① 步
 * ==========================================================================*/
import { buildTemplate } from './templates.mjs';
import { makeNode, makeEdge } from '../core/agent.mjs';
import { parseNovel, splitEpisodes, validateNovelInput, extractCharacters, mergeNovelFiles } from '../core/novel.mjs';
import { createManagement, ensureManagement, finishStep } from '../core/project-steps.mjs';
import { mergeExtracted } from '../core/characters.mjs';
import { linkChapters, buildEpisodeRecords, splitSegments, matchEpisodeCharacters } from '../core/episode-model.mjs';

const cut = (s, n) => { const t = String(s || '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
/** 式(1) 输入归一：各集中部摘录拼接（≤2400 字），覆盖全部分集而非只取第一集 */
const joinExcerpts = (eps) => cut((eps || []).map((e) => `【${e.title}】${e.excerpt || ''}`).join('\n'), 2400);

/**
 * 把「解析 + 分集」的结果落成项目里的三类关联数据：
 *   · management.chapters —— 每章带 episodeNo 与来源文件名
 *   · management.sources  —— 每个导入文件的章节清单
 *   · management.episodes —— 每集带原文、章节清单、段落（宫格图槽位）、出场角色
 * 保留同集同文本下已生成的剧本 / 宫格图 / 导演包 / 视频，重算分集不清空成果。
 */
function materializeEpisodes(m, novel, episodes, chapterSources, sources, characters) {
  const meta = chapterSources.length ? chapterSources
    : novel.chapters.map((c) => ({ title: c.title, sourceName: novel.filename || '粘贴文本', chars: c.chars }));
  const linked = linkChapters(novel, episodes, meta);
  const records = buildEpisodeRecords(episodes, novel, meta, m.episodes);
  for (const ep of records) {
    if (!Array.isArray(ep.segments) || !ep.segments.length) ep.segments = splitSegments(ep.text, 6, ep.no);
    if (!Array.isArray(ep.characterIds) || !ep.characterIds.length) ep.characterIds = matchEpisodeCharacters(ep, characters);
  }
  m.episodes = records;
  m.chapters = linked.chapters;
  m.sources = sources.length ? sources : [{
    name: novel.filename || '粘贴文本', chars: novel.totalChars,
    chapterTitles: novel.chapters.map((c) => c.title),
  }];
  return records;
}

/** 统一的输入解析：单文本 / 粘贴 / 多文件三条入口收敛到同一份原著 + 出处元数据 */
function resolveSource(opts = {}) {
  if (Array.isArray(opts.files) && opts.files.length) {
    const merged = mergeNovelFiles(opts.files);
    if (!merged.ok) throw new Error(merged.message);
    return { text: merged.text, filename: merged.filename, sources: merged.sources, chapterSources: merged.chapterSources, message: merged.message };
  }
  return {
    text: opts.text, filename: opts.filename,
    sources: opts.sources || [], chapterSources: opts.chapterSources || [], message: '',
  };
}

/** 分集画布节点：带 episodeNo / 章节 / 段落数，并指向 management 里的原文（不重复塞全文） */
function episodeNode(ep, i) {
  return makeNode({
    type: 'episode', agent: null, status: 'done', title: ep.title,
    x: 60 + (i % 2) * 150, y: 620 + Math.floor(i / 2) * 150,
    data: {
      episode: { no: ep.no, title: ep.title, chars: ep.chars, summary: ep.summary, hook: ep.hook, sourceTitles: ep.sourceTitles },
      episodeNo: ep.no,
      chapters: (ep.chapters || []).map((c) => c.title),
      segmentCount: (ep.segments || []).length,
      text: cut(ep.text, 120),
      fullTextRef: `management.episodes[${ep.no - 1}].text`,
      summary: `${ep.chars} 字｜${ep.summary}`,
      kind: '分集',
    },
  });
}

/** 交付物 → composer 读取的 outputMode（src/agents/visual.mjs） */
export function outputModeOf(deliverables = {}) {
  const video = deliverables.video !== false;
  const pack = deliverables.pack !== false;
  return video && pack ? 'both' : video ? 'video' : 'director-pack';
}

/** 交付物与分集参数解析（骨架与完整创建共用） */
function resolveOpts(opts = {}) {
  const deliverables = {
    video: opts.deliverables?.video !== false,
    pack: opts.deliverables?.pack !== false,
  };
  if (!deliverables.video && !deliverables.pack) throw new Error('至少要选择一种交付物');
  const split = {
    strategy: opts.split?.strategy || 'chapter',
    targetChars: Number(opts.split?.targetChars) || 1200,
    maxEpisodes: Number(opts.split?.maxEpisodes) || 4,
  };
  return { deliverables, split };
}

/**
 * 极简创建的骨架项目：不上传小说也能先建项目——保留完整 DAG（画布必须保留），
 * 六步全部待执行；小说解析与分集延后到第 ① 步（attachSource）完成。
 */
export function buildNovelSkeleton(opts = {}) {
  const { deliverables, split } = resolveOpts(opts);
  const name = String(opts.name || '').trim().slice(0, 80) || '未命名创作项目';
  const ideaText = String(opts.idea || '').trim().slice(0, 300);

  const project = buildTemplate('novel2video', {
    name, style: opts.style || 'cinematic',
    idea: ideaText ? `${name}｜${cut(ideaText, 60)}` : `${name}｜待上传小说`,
  });

  const idea = project.nodes.find((n) => n.type === 'idea');
  const script = project.nodes.find((n) => n.type === 'script');
  const rag = project.nodes.find((n) => n.type === 'rag');
  const characterNode = project.nodes.find((n) => n.type === 'character');
  const plan = project.nodes.find((n) => n.type === 'plan');
  const note = project.nodes.find((n) => n.type === 'note');

  idea.title = '小说上传 · 待开始';
  idea.data = {
    text: '', kind: '小说原著',
    summary: '尚未上传小说 · 执行第 ① 步即可选择文件或粘贴正文',
  };

  script.title = '剧本生成 · 式(1)';
  script.agent = 'screenwriter';
  script.data = { ...(script.data || {}), summary: '待第 ①② 步完成后注入分集梗概' };

  rag.title = '原著索引 / RAG · 式(6)';
  rag.data = { ...(rag.data || {}), summary: '待上传小说后建立原著索引' };

  characterNode.data = { ...(characterNode.data || {}), summary: '待上传小说后抽取角色并匹配资源库' };
  plan.data = { ...(plan.data || {}), sceneLimit: 2, shotsPerScene: 3, summary: '待上传小说后展开事件 → 场景 → 镜头' };

  note.data = {
    ...(note.data || {}),
    title: '创作项目 · 六步任务',
    text: '① 上传小说 · 待执行\n② 分集拆解 · 待执行\n③ 剧本与格式统一 · 式(1)\n④ RAG / 角色 / 层次分解 · 式(5)(6)\n⑤ 分镜 · 机位 · 择优 · 式(2)(3)(4)(7)(8)\n⑥ 成片视频 / 导演包交付\n\n右侧「任务步骤」Tab 可逐步执行；画布始终可拖拽、缩放、连线。',
    summary: '六步任务 · 待上传小说',
  };

  project.management = createManagement({ kind: 'novel', title: name, deliverables, split, skeleton: true });
  // 创建时可选带上一句话构想：写入创作设定 logline，供 AI 补全 / AI 生成小说复用
  if (ideaText) {
    project.management.bible.logline = ideaText;
    project.management.history[0].detail = '新建创作项目（含一句话构想，待上传小说）';
  }
  project.settings = {
    ...(project.settings || {}),
    k: 2, concurrency: 3, style: opts.style || 'cinematic', aspect: opts.aspect || '16:9',
    comfy: { ...(project.settings?.comfy || {}), outputMode: outputModeOf(deliverables) },
  };
  project.viewport = { x: 40, y: 20, zoom: 0.6 };
  return project;
}

/**
 * 上传 / 粘贴小说：解析 → 分集 → 注入画布节点，并把第 ①② 步标记完成。
 * 骨架项目与「上传后创建」的项目共用此入口。
 */
export function attachSource(project, opts = {}) {
  const m = ensureManagement(project);
  if (m.kind !== 'novel') throw new Error('只有创作项目可以上传小说');
  const split = { ...(m.split || {}), ...(opts.split || {}) };
  // 多文件：合并成一份带「文件 → 章节」出处的原著；单文件 / 粘贴保持原行为
  const input = resolveSource(opts);
  const checked = validateNovelInput(input.text, { filename: input.filename, split });
  if (!checked.ok) throw new Error(checked.message);
  const { novel, episodes } = checked;
  const characters = extractCharacters(novel.text);
  const firstEpisodeExcerpt = cut(episodes[0]?.text || novel.text, 1000);
  const logline = cut(episodes[0]?.summary || novel.text, 70);

  // 重复上传：先清掉旧分集节点与其连线
  const oldIds = new Set(project.nodes.filter((n) => n.type === 'episode').map((n) => n.id));
  if (oldIds.size) {
    project.nodes = project.nodes.filter((n) => !oldIds.has(n.id));
    project.edges = project.edges.filter((e) => !oldIds.has(e.from) && !oldIds.has(e.to));
  }

  const idea = project.nodes.find((n) => n.type === 'idea');
  const script = project.nodes.find((n) => n.type === 'script');
  const rag = project.nodes.find((n) => n.type === 'rag');
  const characterNode = project.nodes.find((n) => n.type === 'character');
  const plan = project.nodes.find((n) => n.type === 'plan');
  const note = project.nodes.find((n) => n.type === 'note');

  idea.title = `小说上传 · ${cut(novel.title, 14)}`;
  idea.data = {
    ...(idea.data || {}),
    text: cut(novel.text, 160), kind: '小说原著',
    summary: `${novel.title}｜${novel.chapterCount} 章 · ${novel.totalChars} 字 · 拆为 ${episodes.length} 集`,
    novel: { id: novel.id, title: novel.title, filename: novel.filename, totalChars: novel.totalChars, chapterCount: novel.chapterCount },
    chapterTitles: novel.chapters.slice(0, 12).map((c) => c.title),
    // 原著全文不重复塞进画布节点（太大），统一存 management.source.text
    fullTextRef: 'management.source.text',
  };

  script.title = '剧本生成 · 式(1)';
  script.agent = 'screenwriter';
  script.data = {
    ...(script.data || {}),
    text: `《${novel.title}》｜${logline}\n${firstEpisodeExcerpt}`,
    novelTitle: novel.title,
    novelExcerpt: joinExcerpts(episodes),
    novelEpisodes: episodes.map((e) => ({ no: e.no, title: e.title, summary: e.summary, hook: e.hook, excerpt: e.excerpt, sourceTitles: e.sourceTitles })),
    characters,
    summary: `等待编剧智能体 · ${episodes.length} 集梗概已注入`,
  };

  rag.data = {
    ...(rag.data || {}),
    originalCorpus: novel.text.slice(0, 12000),
    corpus: novel.text.slice(0, 12000),
    summary: `待索引原著 ${novel.totalChars} 字（${novel.chapterCount} 章）`,
  };
  characterNode.data = { ...(characterNode.data || {}), novelCharacters: characters, summary: `待抽取角色 · 原著候选 ${characters.length} 位` };
  plan.data = { ...(plan.data || {}), sceneLimit: Math.max(1, Math.min(4, episodes.length)), shotsPerScene: 3, summary: `事件 → 场景 → 镜头 · 按 ${episodes.length} 集建立分集梗概` };

  // 分集目录：左侧纵向一列，不干扰主 DAG；每集用 ref 边把数据传给剧本节点
  // 先落关联数据（章节 / 剧集 / 段落），画布节点再从同一份数据生成，避免两处口径不一致
  m.characters = mergeExtracted(m.characters || [], characters, { source: 'heuristic' }).characters;
  const records = materializeEpisodes(m, novel, episodes, input.chapterSources, input.sources, m.characters);
  const episodeNodes = records.map((ep, i) => episodeNode(ep, i));
  for (const n of episodeNodes) {
    project.nodes.push(n);
    if (idea) project.edges.push(makeEdge(idea.id, n.id, 'flow'));
    if (script) project.edges.push(makeEdge(n.id, script.id, 'ref'));
  }

  note.data = {
    ...(note.data || {}),
    title: '创作项目 · 六步任务',
    text: `① 上传小说（已完成）\n② 分集拆解：${episodes.length} 集（已完成）\n③ 剧本与格式统一 · 式(1)\n④ RAG / 角色 / 层次分解 · 式(5)(6)\n⑤ 分镜 · 机位 · 择优 · 式(2)(3)(4)(7)(8)\n⑥ 成片视频 / 导演包交付\n\n右侧「任务步骤」Tab 可逐步执行；画布始终可拖拽、缩放、连线。`,
    summary: '六步任务 · 见右侧「任务步骤」',
  };

  m.source = {
    filename: novel.filename || '', title: novel.title,
    totalChars: novel.totalChars, chapterCount: novel.chapterCount,
    uploadedAt: Date.now(), text: novel.text,
  };
  m.split = split;
  const t0 = Date.now();
  finishStep(m, 'upload', { ok: true, note: `已解析 ${input.sources.length || 1} 个来源 · ${novel.chapterCount} 章 · ${novel.totalChars} 字`, durationMs: Date.now() - t0 });
  finishStep(m, 'episodes', { ok: true, note: `按 ${split.strategy} 策略拆为 ${episodes.length} 集 · 章节已自动关联`, durationMs: Date.now() - t0 });
  m.updatedAt = Date.now();

  return {
    novel, episodes, records,
    chapters: m.chapters, sources: m.sources,
    message: `${input.message ? `${input.message} · ` : ''}已上传《${novel.title}》· ${novel.chapterCount} 章 ${novel.totalChars} 字 · 自动关联并拆为 ${episodes.length} 集`,
  };
}

/**
 * 新建创作项目。
 *   text 非空 → 骨架 + 立即注入（保持原「上传后创建」行为，①② 创建即完成）
 *   text 为空 → 极简骨架，六步全待执行，小说延后到第 ① 步上传
 */
export function buildNovelProject(opts = {}) {
  const hasFiles = Array.isArray(opts.files) && opts.files.some((f) => String(f?.text || '').trim());
  const hasText = String(opts.text || '').trim().length > 0 || hasFiles;
  let name = opts.name;
  if (hasText && !String(name || '').trim()) {
    // 未命名时保持原行为：用书名命名（校验失败则不建项目）
    const src = hasFiles && !opts.text ? resolveSource({ files: opts.files }) : { text: opts.text, filename: opts.filename };
    const v = validateNovelInput(src.text, { filename: src.filename, split: opts.split });
    if (!v.ok) throw new Error(v.message);
    name = `${v.novel.title} · 小说分集`;
  }
  const project = buildNovelSkeleton({ ...opts, name });
  if (!hasText) return { project, novel: null, episodes: [], skeleton: true };
  const r = attachSource(project, opts);
  return { project, ...r, skeleton: false };
}

/**
 * 重新执行第 ② 步「分集拆解」：按最新参数重算，替换画布上的分集节点，
 * 并把新的分集梗概同步给剧本 / 分解节点。原著全文始终保留在 management.source.text。
 */
export function refreshEpisodes(project, opts = {}) {
  const m = ensureManagement(project);
  if (m.kind !== 'novel') throw new Error('当前项目不是小说创作项目，无法重新分集');
  if (!m.source?.text) throw new Error('尚未上传小说，先完成第 ① 步再重新分集');
  const split = { ...(m.split || {}), ...(opts.split || {}) };
  const checked = validateNovelInput(m.source.text, { filename: m.source.filename, split });
  if (!checked.ok) throw new Error(checked.message);
  const { novel, episodes } = checked;

  const oldIds = new Set(project.nodes.filter((n) => n.type === 'episode').map((n) => n.id));
  project.nodes = project.nodes.filter((n) => !oldIds.has(n.id));
  project.edges = project.edges.filter((e) => !oldIds.has(e.from) && !oldIds.has(e.to));
  const idea = project.nodes.find((n) => n.type === 'idea');
  const script = project.nodes.find((n) => n.type === 'script');
  const plan = project.nodes.find((n) => n.type === 'plan');
  const rag = project.nodes.find((n) => n.type === 'rag');

  // 复用上传时的关联逻辑：章节重挂到新集、段落重新切分，同集同文本保留已生成产物
  const chapterSources = (m.chapters || []).map((c) => ({ title: c.title, sourceName: c.sourceName, chars: c.chars }));
  const records = materializeEpisodes(m, novel, episodes, chapterSources, m.sources || [], m.characters || []);
  for (const [i, ep] of records.entries()) {
    const n = episodeNode(ep, i);
    project.nodes.push(n);
    if (idea) project.edges.push(makeEdge(idea.id, n.id, 'flow'));
    if (script) project.edges.push(makeEdge(n.id, script.id, 'ref'));
  }
  if (script) {
    script.data = {
      ...(script.data || {}),
      novelEpisodes: episodes.map((e) => ({ no: e.no, title: e.title, summary: e.summary, hook: e.hook, excerpt: e.excerpt, sourceTitles: e.sourceTitles })),
      novelExcerpt: joinExcerpts(episodes),
    };
  }
  if (plan) plan.data = { ...(plan.data || {}), sceneLimit: Math.max(1, Math.min(4, episodes.length)) };
  if (rag) rag.data = { ...(rag.data || {}), summary: `待索引原著 ${novel.totalChars} 字（${novel.chapterCount} 章）` };
  if (idea) idea.data = { ...(idea.data || {}), summary: `${novel.title}｜${novel.chapterCount} 章 · ${novel.totalChars} 字 · 拆为 ${episodes.length} 集` };

  m.split = split;
  m.updatedAt = Date.now();
  return { episodes, records, novel, chapters: m.chapters, message: `已按 ${split.strategy} 策略重新拆为 ${episodes.length} 集 · 章节关联已同步` };
}
