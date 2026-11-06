/* ============================================================================
 * 新建「创作项目」：上传小说 → 分集 → 画布骨架 + 项目管理元数据
 *
 * 复用 buildTemplate('novel2video') 的完整 DAG（画布必须保留、可任意改写），
 * 在原图之上插入「小说上传 / 分集目录」节点，并把原著全文、分集表、交付设置
 * 注入对应节点，使后续智能体真正读到用户上传的内容。
 * 六步任务由 src/core/project-steps.mjs 定义，见 docs/THEORY.md。
 * ==========================================================================*/
import { buildTemplate } from './templates.mjs';
import { makeNode, makeEdge } from '../core/agent.mjs';
import { parseNovel, splitEpisodes, validateNovelInput, extractCharacters } from '../core/novel.mjs';
import { createManagement, ensureManagement } from '../core/project-steps.mjs';

const cut = (s, n) => { const t = String(s || '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** 交付物 → composer 读取的 outputMode（src/agents/visual.mjs） */
export function outputModeOf(deliverables = {}) {
  const video = deliverables.video !== false;
  const pack = deliverables.pack !== false;
  return video && pack ? 'both' : video ? 'video' : 'director-pack';
}

export function buildNovelProject(opts = {}) {
  const checked = validateNovelInput(opts.text, { filename: opts.filename, split: opts.split });
  if (!checked.ok) throw new Error(checked.message);
  const { novel, episodes } = checked;
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
  const name = String(opts.name || '').trim().slice(0, 80) || `${novel.title} · 小说分集`;
  const characters = extractCharacters(novel.text);
  const firstEpisodeExcerpt = cut(episodes[0]?.text || novel.text, 1000);
  const logline = cut(episodes[0]?.summary || novel.text, 70);

  // 基础 DAG：idea → script → rag/character → plan → camera → final，另有 note
  const project = buildTemplate('novel2video', {
    name, style: opts.style || 'cinematic',
    idea: `${novel.title}｜${logline}`,
  });

  const idea = project.nodes.find((n) => n.type === 'idea');
  const script = project.nodes.find((n) => n.type === 'script');
  const rag = project.nodes.find((n) => n.type === 'rag');
  const characterNode = project.nodes.find((n) => n.type === 'character');
  const plan = project.nodes.find((n) => n.type === 'plan');
  const note = project.nodes.find((n) => n.type === 'note');

  idea.title = `小说上传 · ${cut(novel.title, 14)}`;
  idea.data = {
    text: cut(novel.text, 160), kind: '小说原著',
    summary: `${novel.title}｜${novel.chapterCount} 章 · ${novel.totalChars} 字 · 拆为 ${episodes.length} 集`,
    novel: { id: novel.id, title: novel.title, filename: novel.filename, totalChars: novel.totalChars, chapterCount: novel.chapterCount },
    chapterTitles: novel.chapters.slice(0, 12).map((c) => c.title),
  };
  // 原著全文不重复塞进画布节点（太大），统一存 management.source.text
  idea.data.fullTextRef = 'management.source.text';

  script.title = '剧本生成 · 式(1)';
  script.agent = 'screenwriter';
  script.data = {
    text: `《${novel.title}》｜${logline}\n${firstEpisodeExcerpt}`,
    novelTitle: novel.title,
    novelExcerpt: firstEpisodeExcerpt,
    novelEpisodes: episodes.map((e) => ({ no: e.no, title: e.title, summary: e.summary, hook: e.hook, sourceTitles: e.sourceTitles })),
    characters,
    summary: `等待编剧智能体 · ${episodes.length} 集梗概已注入`,
  };

  rag.title = '原著索引 / RAG · 式(6)';
  rag.data = {
    ...(rag.data || {}),
    originalCorpus: novel.text.slice(0, 12000),
    corpus: novel.text.slice(0, 12000),
    summary: `待索引原著 ${novel.totalChars} 字（${novel.chapterCount} 章）`,
  };
  characterNode.data = { ...(characterNode.data || {}), novelCharacters: characters, summary: `待抽取角色 · 原著候选 ${characters.length} 位` };
  plan.data = { ...(plan.data || {}), sceneLimit: Math.max(1, Math.min(4, episodes.length)), shotsPerScene: 3, summary: `事件 → 场景 → 镜头 · 按 ${episodes.length} 集建立分集梗概` };

  // 分集目录：左侧纵向一列，不干扰主 DAG；每集用 ref 边把数据传给剧本节点
  const episodeNodes = episodes.map((ep, i) => makeNode({
    type: 'episode', agent: null, status: 'done',
    title: ep.title, x: 60 + (i % 2) * 150, y: 620 + Math.floor(i / 2) * 150,
    data: {
      episode: { no: ep.no, title: ep.title, chars: ep.chars, summary: ep.summary, hook: ep.hook, sourceTitles: ep.sourceTitles },
      text: cut(ep.text, 120),
      summary: `${ep.chars} 字｜${ep.summary}`,
      kind: '分集',
    },
  }));
  // 两列时 x=210 会靠近 script(x=380) 但 y≥620 不重叠；保持连线清晰
  for (const n of episodeNodes) {
    project.nodes.push(n);
    project.edges.push(makeEdge(idea.id, n.id, 'flow'));
    project.edges.push(makeEdge(n.id, script.id, 'ref'));
  }

  note.data = {
    ...(note.data || {}),
    title: '创作项目 · 六步任务',
    text: `① 上传小说（已完成）\n② 分集拆解：${episodes.length} 集（已完成）\n③ 剧本与格式统一 · 式(1)\n④ RAG / 角色 / 层次分解 · 式(5)(6)\n⑤ 分镜 · 机位 · 择优 · 式(2)(3)(4)(7)(8)\n⑥ 成片视频 / 导演包交付\n\n右侧「任务步骤」Tab 可逐步执行；画布始终可拖拽、缩放、连线。`,
    summary: '六步任务 · 见右侧「任务步骤」',
  };

  project.management = createManagement({
    kind: 'novel', title: name,
    deliverables, split,
    source: { filename: novel.filename, title: novel.title, totalChars: novel.totalChars, chapterCount: novel.chapterCount, text: novel.text },
    episodes,
  });
  project.settings = {
    ...(project.settings || {}),
    k: 2, concurrency: 3, style: opts.style || 'cinematic', aspect: opts.aspect || '16:9',
    comfy: { ...(project.settings?.comfy || {}), outputMode: outputModeOf(deliverables) },
  };
  project.viewport = { x: 40, y: 20, zoom: 0.6 };
  return { project, novel, episodes };
}

/**
 * 重新执行第 ② 步「分集拆解」：按最新参数重算，替换画布上的分集节点，
 * 并把新的分集梗概同步给剧本 / 分解节点。原著全文始终保留在 management.source.text。
 */
export function refreshEpisodes(project, opts = {}) {
  const m = ensureManagement(project);
  if (m.kind !== 'novel' || !m.source?.text) throw new Error('当前项目不是小说创作项目，无法重新分集');
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

  for (const [i, ep] of episodes.entries()) {
    const n = makeNode({
      type: 'episode', agent: null, status: 'done', title: ep.title,
      x: 60 + (i % 2) * 150, y: 620 + Math.floor(i / 2) * 150,
      data: {
        episode: { no: ep.no, title: ep.title, chars: ep.chars, summary: ep.summary, hook: ep.hook, sourceTitles: ep.sourceTitles },
        text: cut(ep.text, 120), summary: `${ep.chars} 字｜${ep.summary}`, kind: '分集',
      },
    });
    project.nodes.push(n);
    if (idea) project.edges.push(makeEdge(idea.id, n.id, 'flow'));
    if (script) project.edges.push(makeEdge(n.id, script.id, 'ref'));
  }
  if (script) {
    script.data = {
      ...(script.data || {}),
      novelEpisodes: episodes.map((e) => ({ no: e.no, title: e.title, summary: e.summary, hook: e.hook, sourceTitles: e.sourceTitles })),
      novelExcerpt: cut(episodes[0]?.text || novel.text, 1000),
    };
  }
  if (plan) plan.data = { ...(plan.data || {}), sceneLimit: Math.max(1, Math.min(4, episodes.length)) };
  if (rag) rag.data = { ...(rag.data || {}), summary: `待索引原著 ${novel.totalChars} 字（${novel.chapterCount} 章）` };
  if (idea) idea.data = { ...(idea.data || {}), summary: `${novel.title}｜${novel.chapterCount} 章 · ${novel.totalChars} 字 · 拆为 ${episodes.length} 集` };

  m.episodes = episodes.map((e) => ({ no: e.no, title: e.title, chars: e.chars, summary: e.summary, hook: e.hook, sourceTitles: e.sourceTitles }));
  m.split = split;
  m.updatedAt = Date.now();
  return { episodes, novel, message: `已按 ${split.strategy} 策略重新拆为 ${episodes.length} 集` };
}
