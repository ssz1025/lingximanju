// 叙事组 / 资产组 / 镜头规划智能体
import { defineAgent } from '../core/agent.mjs';
import { hash } from '../core/artwork.mjs';
import { matchCharacters, registerAsset } from '../core/assets.mjs';
import { buildCharacterPrompt } from '../core/characters.mjs';
import { chunkNovel, KnowledgeBase, retrieveRelevantChunks,
  saveKnowledgeCache, loadKnowledgeCache, formatFragments } from '../core/knowledge.mjs';
import { topoLayers } from '../core/graph.mjs';
import { resolveRuntimeSpec, allocateShots, shotSequenceStarts } from '../core/runtime-spec.mjs';
import { parseScriptLine, formatDuration, episodeCodeOf } from '../core/screenplay.mjs';
import { extractCharacters } from '../core/novel.mjs';
import { isLikelyPersonName, SURNAMES, NON_PERSON_NAMES } from '../core/character-names.mjs';
import { resolveStoryboardSettings, panelIndexOf, describeStoryboardSettings } from '../core/storyboard-settings.mjs';

const textOf = (v) => String(v || '').trim();
// 截断时补上没闭合的引号：剧本 / 分集卡片上的「他还说：「别回头…」」不能缺右引号
const brief = (s, n = 46) => {
  const t = String(s || '');
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const open = (cut.match(/[「“]/g) || []).length;
  const close = (cut.match(/[」”]/g) || []).length;
  return `${cut}${open > close ? '」' : ''}…`;
};

function findScript(ctx) {
  // 上游可能是 script 节点，也可能是携带剧本副本的 RAG / 规划节点
  return ctx.upstream.find((n) => n.data?.script)?.data?.script || ctx.node.data.script || null;
}

/* ---------------------------------------------------------- 式(1) 的输入准备
 * 「剧本不够详细」的另一个根因在输入端：旧实现只把分集 summary + 300 字摘录
 * 交给编剧，模型手上没有细节可写，只能还回概述。这里改为每集最多 750 字原文、
 * 最多 12 集（≈9k 字），并把项目角色属性一起下发，让剧本能落到具体的人与物。
 */
const SCRIPT_MAX_EPISODES = 12;
const SCRIPT_EXCERPT_PER_EPISODE = 750;

/** 分集简报：优先用 management.episodes 的完整原文，其次才是节点上缓存的梗概 */
function episodeBriefs(project, node = {}) {
  const list = Array.isArray(project.management?.episodes) ? project.management.episodes : [];
  const src = list.length ? list : (Array.isArray(node.data?.novelEpisodes) ? node.data.novelEpisodes : []);
  return src.slice(0, SCRIPT_MAX_EPISODES).map((e, i) => {
    const raw = String(e.text || e.excerpt || '').replace(/\s+/g, ' ').trim();
    const no = Number(e.no) || i + 1;
    const code = episodeCodeOf(no);
    return {
      no,
      // v3：集 / 场编号随分集简报下发，模型才知道该把场次头写成 EP003-SC001
      episodeCode: code,
      sceneCodePrefix: `${code}-SC`,
      title: textOf(e.title),
      summary: brief(textOf(e.summary), 200),
      hook: brief(textOf(e.hook), 160),
      excerpt: raw.length > SCRIPT_EXCERPT_PER_EPISODE ? `${raw.slice(0, SCRIPT_EXCERPT_PER_EPISODE)}…` : raw,
      sourceTitles: Array.isArray(e.sourceTitles) ? e.sourceTitles.slice(0, 3) : [],
    };
  });
}

/**
 * 从原著正文里认出「谁在这部戏里说话」。
 * 只用于剧本兜底：优先「名字 + 冒号 + 引号」这种最强说话人信号，
 * 其次「名字 + 说 / 问 / 皱眉 / 转身」这类叙述提示。抽不到再退回通用启发式抽取。
 */
function castFromText(text = '', limit = 8) {
  const s = String(text || '');
  if (!s) return [];
  const score = new Map();
  const bump = (raw, w) => {
    const name = String(raw || '').trim();
    if (name.length < 2) return;
    // 「刘左」这种真实人名会被通用规则里的方位词规则挡掉（左 / 右），
    // 但姓氏开头、又不是明确的非人名（回头 / 刀光 / 门口）时应当收下
    const ok = isLikelyPersonName(name)
      || (SURNAMES.includes(name[0]) && !NON_PERSON_NAMES.has(name));
    if (!ok) return;
    score.set(name, (score.get(name) || 0) + w);
  };
  // 冒号前那一小段（「林夏举着灯笼站在门口：」「沈砚把铜钱放在桌上：」）里认名字：
  // 小说很少规规矩矩写「林夏：」，多数是「名字 + 动作 + ：」。取这段里最靠左的「姓氏 + 一个字」，
  // 那就是这句的主语 / 说话人；从右往左会被「站在门口」里的常见姓氏字抢走（夏 → 夏举）。
  for (const m of s.matchAll(/([^。！？\n]{1,14})[：:]\s*[「“"]/g)) {
    const head = m[1];
    for (let i = 0; i < head.length - 1; i += 1) {
      if (!SURNAMES.includes(head[i])) continue;
      const name = head.slice(i, i + 2);
      if (isLikelyPersonName(name) || !NON_PERSON_NAMES.has(name)) { bump(name, 3); break; }
    }
  }
  // 沈砚低声说 / 刘左皱眉 / 林夏站在（引号台词之外的叙述提示）
  for (const m of s.matchAll(/(?<![\u4e00-\u9fa5])([\u4e00-\u9fa5]{2,4})(?=(?:低声|沉声|轻声|冷笑|苦笑|皱眉|点头|摇头|转身|抬头|开口|说道|问道|回答|说|问|答|道|喊|叫|站起|走进|推开|盯着|看着))/g)) bump(m[1], 1);
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .slice(0, limit).map(([name]) => name);
}

/** 角色表：优先项目管理里维护的结构化属性（人工改过的也算数），其次才是启发式候选 */
function scriptCast(project, node = {}) {
  const managed = (project.management?.characters || []).filter((c) => c && c.name);
  const toEntry = (c, i) => ({
    name: c.name, role: c.role || (i === 0 ? '主角' : '配角'), age: c.age || '',
    gender: c.gender || '', personality: c.personality || '', appearance: c.appearance || '',
  });
  const fromNode = Array.isArray(node.data?.characters) ? node.data.characters.filter((c) => c?.name) : [];
  const text = String(project.management?.source?.text || node.data?.text || node.data?.novelExcerpt || '');
  // 第 ③ 步常常在第 ④ 步「角色资产库」之前跑：这时管理里的角色表还是空的（或只有主角）。
  // 只有一两个人却要写对话戏时，Provider 会把所有台词判给同一个名字，
  // 所以少于 2 人时用正文里认出来的说话人补齐；人工维护过 2 人以上则完全以管理表为准。
  if (managed.length >= 2) return managed.slice(0, 12).map(toEntry);
  const detected = castFromText(text, 8);
  const names = [...new Set([...managed.map((c) => c.name), ...detected, ...fromNode.map((c) => c.name)])].slice(0, 8);
  if (names.length) {
    const byName = new Map([...fromNode, ...managed].map((c) => [c.name, c]));
    return names.map((name, i) => toEntry({ ...byName.get(name), name }, i));
  }
  return extractCharacters(text, 6).map((c) => c.name).filter(Boolean)
    .map((name, i) => toEntry({ name }, i));
}

function countDialogue(script = {}) {
  let n = 0;
  for (const s of (Array.isArray(script.scenes) ? script.scenes : [])) {
    for (const line of (Array.isArray(s.script) ? s.script : [])) {
      if (parseScriptLine(line).kind === 'dialogue') n += 1;
    }
  }
  return n;
}

defineAgent({
  id: 'screenwriter', label: '编剧智能体', group: '叙事', icon: '✎', color: '#a78bfa',
  description: '把一句话创意 / 小说分集写成详尽的统一格式剧本（论文式 1）：逐集展开场次，每场带人物、目标、冲突、转折、节拍与转场',
  async run(ctx) {
    const idea = textOf(ctx.node.data.text) || textOf(ctx.inputs.find((i) => i.text)?.text) || '一位侦探在雨夜收到一封没有署名的信';
    const bible = ctx.project.management?.bible || {};
    const episodes = episodeBriefs(ctx.project, ctx.node);
    const characters = scriptCast(ctx.project, ctx.node);
    const runtime = ctx.settings?.runtime?.schema === 1 ? ctx.settings.runtime : resolveRuntimeSpec(ctx.project);
    ctx.progress(0.2);
    // 创作项目：小说标题 / 分集梗概与原文 / 原著角色随输入下发，保证剧本来自用户上传的内容
    const script = await ctx.providers.generate('screenplay', {
      idea, style: ctx.settings.style,
      title: ctx.node.data.novelTitle || bible.title || undefined,
      genre: bible.genre || undefined,
      tone: bible.tone || undefined,
      logline: bible.logline || undefined,
      worldview: bible.worldview ? brief(bible.worldview, 240) : undefined,
      episodes: episodes.length ? episodes : undefined,
      characters: characters.length ? characters : ctx.node.data.characters || undefined,
      novelExcerpt: ctx.node.data.novelExcerpt || undefined,
      // 时长规格随输入下发：写剧本时就知道这一集大概多长，避免写出 20 分钟塞进 30 秒的戏
      runtime: { totalSeconds: runtime.totalSeconds, clipSeconds: runtime.clipSeconds, clipCount: runtime.clipCount },
    }, ctx.signal);

    const scenes = Array.isArray(script.scenes) ? script.scenes : [];
    const dialogue = countDialogue(script);
    const duration = Number(script.durationSec) || 0;
    ctx.log('think', `识别到 ${script.characters?.length || 0} 位角色、${scenes.length} 场、${dialogue} 句对白，预估 ${formatDuration(duration)}，正在统一剧本格式`);
    if (duration > runtime.totalSeconds) {
      // 剧本是「故事需要多长」，成片规格是「这一版拍多长」：两者不一致时说清楚，别让用户以为算错了
      ctx.log('info', `剧本预估 ${formatDuration(duration)}，超过成片规格 ${runtime.totalSeconds}s：第⑤步会按规格截取镜头，长剧本用于分集拍摄`);
    }
    if (episodes.length && scenes.length) {
      const missing = episodes.map((e) => e.no).filter((no) => !scenes.some((s) => Number(s.episodeNo) === Number(no)));
      if (missing.length) ctx.log('warn', `第 ${missing.join('、')} 集还没有对应场次（剧本覆盖 ${scenes.length} 场），可在「本集剧本」里单独补齐`);
    }
    ctx.progress(0.8);
    ctx.setTitle(`剧本 · ${script.title}`);
    ctx.patch({
      text: idea, script,
      summary: `${script.genre || '未分类'}｜${scenes.length} 场 · ${dialogue} 句对白 · 预估 ${formatDuration(duration)}`,
      sceneCount: scenes.length, characterCount: script.characters?.length || 0,
      dialogueCount: dialogue, durationSec: duration,
      acts: Array.isArray(script.acts) ? script.acts.length : 0,
      coverage: script.coverage || null,
    });
  },
});

defineAgent({
  id: 'rag', label: 'RAG 上下文智能体', group: '叙事', icon: '⌕', color: '#22d3ee',
  description: '原著 512/128 分块建索引 → 按事件 processChain 逐条检索 → 相关片段随分解链下发（论文式 6）',
  async run(ctx) {
    const script = findScript(ctx);
    // 式(6)：创作项目用「整本原著」建索引，而不是只看已压缩的剧本，避免分解丢失伏笔
    const original = textOf(ctx.node.data.originalCorpus);
    const corpus = original || (script
      ? [script.logline, ...script.scenes.map((s) => `${s.location}：${s.summary}`), ...script.characters.map((c) => `${c.name}：${c.appearance}`)].join('。')
      : textOf(ctx.node.data.corpus));
    ctx.progress(0.35);
    // 对齐 ViMax：RecursiveCharacterTextSplitter(512,128) 分块 → FAISS 索引落盘（本仓库用 BM25）
    const chunks = chunkNovel(corpus);
    const cacheFile = saveKnowledgeCache(ctx.project.id, chunks);
    const kb = new KnowledgeBase(chunks);
    // 概览检索：以节点标题 + 剧本梗概为 query，命中片段写入节点供面板展示
    const overview = retrieveRelevantChunks(kb, [`${ctx.node.title} ${script?.logline || ''}`], { topK: 6, threshold: 0 });
    const context = await ctx.providers.generate('context', { corpus, query: ctx.node.title }, ctx.signal);
    ctx.progress(0.9);
    ctx.patch({
      context, corpus: brief(corpus, 300), script,
      knowledgeId: ctx.project.id, cacheFile, chunkCount: chunks.length,
      indexSize: corpus.length, passages: overview.length,
      summary: `${chunks.length} 个知识块（512/128）· 命中 ${overview.length} 段上下文`,
    });
    ctx.log('think', `原著已切成 ${chunks.length} 块并建立索引；按事件 processChain 逐条检索相关片段，随局部规划下发`);
  },
});

defineAgent({
  id: 'decomposer', label: '层次化叙事分解', group: '叙事', icon: '⑂', color: '#22d3ee',
  description: '事件 → 场景 → 镜头递归分解，运行中动态展开画布（论文式 5）',
  async run(ctx) {
    // 上游（RAG 节点）可能带着旧一轮的空剧本副本（scenes/characters 都为空）：
    // 优先取「非空」的那份，再退回画布剧本节点，最后才是空骨架——
    // 否则角色表会丢成空数组，分镜里出现主题模板的玩具角色而不是原著角色。
    const usable = (s) => s && (Array.isArray(s.scenes) && s.scenes.length
      || Array.isArray(s.characters) && s.characters.length);
    const fromUpstream = findScript(ctx);
    const fromScriptNode = ctx.project.nodes.find((n) => n.type === 'script')?.data?.script || null;
    // 画布剧本节点是式(1)的唯一事实来源；上游节点的 script 只是随路副本，
    // 可能是旧一轮的陈旧拷贝（有场景但角色表为空），因此优先取剧本节点本身。
    let script = usable(fromScriptNode) ? fromScriptNode
      : usable(fromUpstream) ? fromUpstream
        : (fromUpstream || fromScriptNode || { scenes: [], characters: [] });
    /**
     * 剧本兜底：第③步没跑通（历史项目 / 节点中断 / 模型异常）时 script.scenes 为空，
     * 后面的 events 只能拆出 0 个事件 → 0 场景 → 0 镜头，第⑤步就永远「没有分镜」。
     * 这里按分集梗概 / 原著段落临时补出可拍摄的场景，让分解链继续往下走；
     * 明确记一条 warn，提示用户回第③步重跑以拿到完整剧本与台词（不假装剧本已生成）。
     */
    if (!Array.isArray(script.scenes) || !script.scenes.length) {
      const eps = (ctx.project.management?.episodes || []).filter((e) => e && (e.summary || e.text));
      const source = textOf(ctx.node.data.originalCorpus) || textOf(ctx.project.management?.source?.text);
      const chunks = source ? chunkNovel(source) : [];
      const fallbackScenes = (eps.length
        ? eps.map((e, i) => ({
          id: `sc_fallback_${i + 1}`,
          location: e.title || `第 ${e.no || i + 1} 集`,
          time: i === 0 ? '开篇' : '接续',
          summary: textOf(e.summary) || brief(String(e.text || '').replace(/\s+/g, ' '), 80),
        }))
        : chunks.slice(0, 3).map((c, i) => ({
          id: `sc_fallback_${i + 1}`,
          location: `原著段落 ${i + 1}`,
          time: i === 0 ? '开篇' : '接续',
          summary: brief(String(c.text || '').replace(/\s+/g, ' '), 80),
        }))).slice(0, 4);
      if (fallbackScenes.length) {
        script = {
          ...script,
          scenes: fallbackScenes,
          logline: script.logline || fallbackScenes[0].summary || '',
          characters: script.characters || [],
          __fallback: true,
        };
        ctx.log('warn', `第③步剧本为空，已按分集梗概临时建立 ${fallbackScenes.length} 个场景继续分解；建议回到第③步重跑以获得完整剧本与台词`);
      }
    }
    const context = ctx.upstream.find((n) => n.data?.context)?.data?.context || null;
    const sceneLimit = Math.max(1, Math.min(4, Number(ctx.node.data.sceneLimit) || 2));
    // 重跑分解前先清掉上一轮展开的节点：本节点 data.spawned 记录了它创建的 id，
    // 连带删除这些节点下游的镜头链（关键帧 / 择优 / 片段 / 转场），否则重跑会留下两套重复节点。
    const CORE_TYPES = new Set(['idea', 'script', 'episode', 'rag', 'character', 'plan', 'camera', 'final', 'note', 'upload']);
    const spawned = Array.isArray(ctx.node.data.spawned) ? ctx.node.data.spawned.filter(Boolean) : [];
    if (spawned.length) {
      const byId = new Map(ctx.project.nodes.map((n) => [n.id, n]));
      const doomed = new Set(spawned.filter((id) => byId.has(id) && !CORE_TYPES.has(byId.get(id).type)));
      let grew = true;
      while (grew) {
        grew = false;
        for (const e of ctx.project.edges) {
          if (doomed.has(e.from) && !doomed.has(e.to)) { doomed.add(e.to); grew = true; }
        }
      }
      for (const id of [...doomed]) if (CORE_TYPES.has(byId.get(id)?.type)) doomed.delete(id);
      if (doomed.size) {
        ctx.project.nodes = ctx.project.nodes.filter((n) => !doomed.has(n.id));
        ctx.project.edges = ctx.project.edges.filter((e) => !doomed.has(e.from) && !doomed.has(e.to));
        ctx.log('info', `已清理上一轮展开的 ${doomed.size} 个节点，重新生成事件 → 场景 → 镜头链`);
      }
    }
    // 短剧时长规格：全片镜头总数必须精确等于片段总数（30s / 3s → 10 个镜头）
    const runtime = ctx.settings?.runtime?.schema === 1 ? ctx.settings.runtime : resolveRuntimeSpec(ctx.project);
    ctx.progress(0.25);
    const result = await ctx.providers.generate('events', { scenes: script.scenes.slice(0, sceneLimit), idea: script.logline }, ctx.signal);
    const events = (result.events || []).slice(0, sceneLimit);
    // 先摊平全部场景，再按「总片段数」分配每场景镜头预算，避免各场景各自取默认值导致片段数失控
    const sceneGroups = events.map((e) => (e.scenes && e.scenes.length
      ? e.scenes
      : [{ title: e.title, location: '内景', time: '夜', summary: e.summary }]));
    const sceneCount = sceneGroups.reduce((a, g) => a + g.length, 0);
    const budgets = allocateShots(sceneCount, runtime);
    const sequenceStarts = shotSequenceStarts(sceneCount, runtime);
    let flatIndex = 0;
    ctx.log('think', `拆解为 ${events.length} 个事件，按 processChain 保持因果顺序`);
    ctx.progress(0.55);

    // 式(6)：按事件 processChain 的每一条做检索（ViMax retrieve_relevant_chunks 的语义）
    // 未建索引时从 RAG 节点的原著全文兜底重建，保证单独运行分解节点也有上下文
    const ragNode = ctx.upstream.find((n) => n.data?.knowledgeId);
    let chunks = ragNode ? loadKnowledgeCache(ragNode.data.knowledgeId) : [];
    if (!chunks.length) {
      const fallback = textOf(ctx.node.data.originalCorpus) || textOf(ctx.node.data.corpus) || textOf(context?.corpus);
      chunks = chunkNovel(fallback);
      if (chunks.length) saveKnowledgeCache(ctx.project.id, chunks);
    }
    const kb = new KnowledgeBase(chunks);
    const perEventFragments = events.map((event) => {
      const chain = (event.processChain || []).filter(Boolean);
      const hits = kb ? retrieveRelevantChunks(kb, chain, { topK: 10, threshold: 0.7 }) : [];
      // 一条都没命中时退化为「标题 + 梗概」宽召回，保证每个事件至少带原文上下文
      if (!hits.length && chunks.length) {
        return retrieveRelevantChunks(kb, [`${event.title || ''} ${event.summary || ''}`], { topK: 3, threshold: 0 });
      }
      return hits;
    });
    if (chunks.length) ctx.log('info', `知识库 ${chunks.length} 块 · 逐事件检索命中 ${perEventFragments.map((f) => f.length).join('/')} 段`);

    const created = [];
    const shotPlan = [];
    let sceneIndex = 0;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const relevantChunks = perEventFragments[i];
      const fragments = formatFragments(relevantChunks, 4);
      const eventNode = ctx.addNodeAndEdge({
        type: 'event', agent: null, status: 'done',
        title: event.title || `事件 ${i + 1}`,
        data: { event, context, script, relevantChunks, fragments, depth: 1, summary: brief(event.summary, 40) },
      }, ctx.node.id, 'flow');
      created.push(eventNode.id);
      // 式(5)：事件 → 场景 → 镜头递归展开——事件下所有场景都要生成场景节点，不能只取 scenes[0]
      const sceneSpecs = sceneGroups[i];
      for (const sceneSpec of sceneSpecs) {
        const shotCount = budgets[flatIndex] || 0;
        const sequenceStart = sequenceStarts[flatIndex] || 1;
        flatIndex += 1;
        // 片段数少于场景数时，多出来的场景不生成镜头，保证全片片段数精确
        if (!shotCount) continue;
        const sceneNode = ctx.addNodeAndEdge({
          type: 'scene', agent: 'storyboard',
          title: `场景 ${sceneIndex + 1} · ${sceneSpec.location || sceneSpec.title}`,
          data: { scene: sceneSpec, script, context, relevantChunks, fragments, index: sceneIndex,
            shotCount, sequenceStart, clipSeconds: runtime.clipSeconds, depth: 2,
            summary: brief(sceneSpec.summary, 40) },
        }, eventNode.id, 'flow');
        created.push(sceneNode.id);
        // 预生成镜头概要，供机位依赖图与一致性报告使用；片段随 shots 提示词下发（式 6）
        const shots = await ctx.providers.generate('shots', {
          scene: sceneSpec, count: shotCount, clipSeconds: runtime.clipSeconds, idea: script.logline,
          characters: script.characters, fragments,
        }, ctx.signal);
        const planned = (shots.shots || []).slice(0, shotCount).map((s, k) => ({
          ...s, shotNo: sequenceStart + k, sequence: sequenceStart + k, duration: runtime.clipSeconds,
        }));
        shotPlan.push({ event: i + 1, scene: sceneIndex + 1, location: sceneSpec.location, shots: planned,
          shotCount, sequenceStart, fragmentsUsed: (relevantChunks || []).length });
        sceneIndex += 1;
      }
    }
    ctx.progress(0.95);
    const plannedShots = shotPlan.reduce((a, s) => a + s.shots.length, 0);
    ctx.patch({
      events, shotPlan, context, script,
      knowledgeChunks: chunks.length, fragmentsPerEvent: perEventFragments.map((f) => f.length),
      hierarchy: ['事件', '场景', '镜头'], eventCount: events.length,
      sceneCount: sceneIndex, plannedShots,
      runtime: { clipCount: runtime.clipCount, clipSeconds: runtime.clipSeconds, totalSeconds: runtime.totalSeconds },
      spawned: created, summary: `${events.length} 事件 → ${sceneIndex} 场景 → ${plannedShots} 镜头（${runtime.clipSeconds}s/段 · ${runtime.totalSeconds}s）`,
    });
    ctx.log('info', `画布已展开 ${created.length} 个规划节点；事件专属原文片段（FRAGMENT）已随节点下发`);
  },
});

defineAgent({
  id: 'character', label: '角色造型智能体', group: '资产', icon: '◉', color: '#f472b6',
  description: '抽取角色并复用项目角色库的正面基准图（缺图时才生成），供所有镜头以 ref 边复用；优先匹配资源库已生成的角色',
  async run(ctx) {
    const script = findScript(ctx) || { characters: [] };
    ctx.progress(0.2);
    // 优先消费项目管理「角色」维护的结构化属性（LLM/启发式提取 + 手动增删改）
    const managed = (ctx.project.management?.characters || []).filter((c) => c && c.name);
    let wanted;
    if (managed.length) {
      wanted = managed.map((c) => ({
        name: c.name, role: c.role || '原著角色',
        appearance: buildCharacterPrompt(c) || c.appearance || `${c.name}角色设定`,
        palette: c.palette || [],
        // 画布立绘直接复用项目管理里已经修好的「正面基准图」：
        // 过去这里只带文字人设，角色节点会另出一张早期合图，于是角色面板修好了
        // 定妆图、视频与关键帧仍在用那张老图，身份永远对不上。
        frontUrl: String(c.views?.front?.url || ''),
        frontPrompt: String(c.views?.front?.prompt || ''),
        frontRefs: Array.isArray(c.views?.front?.refs) ? c.views.front.refs : [],
      }));
      ctx.log('info', `使用项目管理中维护的 ${wanted.length} 位角色属性驱动造型生成（${wanted.filter((c) => c.frontUrl).length} 位已有正面基准图，画布直接复用）`);
    } else {
      const res = await ctx.providers.generate('characters', { characters: script.characters }, ctx.signal);
      wanted = res.characters || [];
    }
    // 优先匹配：资源库里已有同名角色定妆图（可来自其他项目）→ 直接复用，不再重复生成
    const { map: matched, reused } = matchCharacters(wanted);
    if (reused) ctx.log('info', `资源库命中 ${reused}/${wanted.length} 位已生成角色，直接复用定妆图（可打标签共享给其他项目）`);
    const characters = [];
    let generated = 0;
    for (let i = 0; i < wanted.length; i++) {
      const c = wanted[i];
      // 项目角色库里的正面基准图优先于跨项目资源库命中：它是本项目当前这版定妆，
      // 也是后续所有视图 / 关键帧 / 视频参考图的唯一身份锚点。
      if (c.frontUrl) {
        characters.push({
          ...c, portraitUrl: c.frontUrl, assetKind: '正面基准图',
          reused: true, matchedAssetId: '', matchedFrom: '项目角色库 · 正面视图',
        });
        ctx.progress(0.2 + (i + 1) / (wanted.length + 1) * 0.7);
        continue;
      }
      const hit = matched[c.name];
      if (hit) {
        characters.push({
          ...c, portraitUrl: `/assets/${hit.file}`, assetKind: '三视图',
          reused: true, matchedAssetId: hit.id, matchedFrom: hit.sourceProjectName || hit.sourceProjectId || '资源库',
        });
        ctx.progress(0.2 + (i + 1) / (wanted.length + 1) * 0.7);
        continue;
      }
      const img = await ctx.providers.image({
        kind: 'character', label: c.name, prompt: c.appearance,
        style: ctx.settings.style, seed: `${ctx.project.id}-${c.name}`,
      }, ctx.signal);
      // 登记进资源库：类型=角色 + 名称=角色名，后续项目按名匹配即可复用
      const file = String(img.url || '').startsWith('/assets/') ? img.url.slice(8) : '';
      if (file) {
        registerAsset({
          file, kind: 'character', name: c.name,
          tags: ['角色', c.role || c.name].filter(Boolean),
          sourceProjectId: ctx.project.id, sourceProjectName: ctx.project.name,
        });
      }
      characters.push({ ...c, portraitUrl: img.url, assetKind: '三视图', reused: false });
      generated++;
      ctx.progress(0.2 + (i + 1) / (wanted.length + 1) * 0.7);
    }
    ctx.patch({
      characters, registry: characters.map((c) => c.name),
      reusedCount: reused, generatedCount: generated,
      summary: `${characters.length} 位角色 · 复用 ${reused} · 新生成 ${generated} · 三视图已锁定`,
    });
    ctx.log('info', reused
      ? `角色资产库就绪：复用 ${reused} 张、新生成 ${generated} 张；后续镜头通过 ref 边引用，避免跨镜头身份漂移`
      : '角色资产库就绪，后续镜头通过 ref 边引用，避免跨镜头身份漂移');
  },
});

defineAgent({
  id: 'storyboard', label: '分镜智能体', group: '镜头', icon: '▤', color: '#60a5fa',
  description: '把场景转为镜头规格，并在画布上生长出完整的生成链（论文式 2 / 7 / 8）',
  async run(ctx) {
    const d = ctx.node.data;
    const scene = d.scene || { location: '场景', summary: '' };
    const runtime = ctx.settings?.runtime?.schema === 1 ? ctx.settings.runtime : resolveRuntimeSpec(ctx.project);
    const clipSeconds = Number(d.clipSeconds) || runtime.clipSeconds;
    const sequenceStart = Number(d.sequenceStart) || 1;
    // 镜头数来自 decomposer 按片段总数下发的预算，不再各场景各自取默认 2~5
    const count = Math.max(1, Math.min(runtime.clipCount, Number(d.shotCount ?? d.shotsPerScene) || 3));
    ctx.progress(0.2);
    // 导演风格随上下文下发（编排器注入 settings.aesthetic）；
    // 分镜阶段就要带上主色 / 光线 / 媒介，否则后续出图只能看见镜头本身而看不见风格。
    const aesthetic = ctx.settings?.aesthetic || null;
    // 分镜画面设置随分镜规划下发：镜头按「分镜板第几格」组织景别变化，
    // 出来的九宫格才是一段完整的镜头语法（远→中→近→特写），而不是九张同景别。
    const sheet = resolveStoryboardSettings(ctx.project);
    const res = await ctx.providers.generate('shots', {
      scene, count, clipSeconds, idea: d.script?.logline,
      characters: d.script?.characters,
      fragments: d.fragments || formatFragments(d.relevantChunks, 4),
      aesthetic,
      frame: {
        layout: sheet.layout, cols: sheet.cols, rows: sheet.rows, cells: sheet.cells,
        aspect: sheet.resolvedAspect, note: describeStoryboardSettings(sheet),
      },
    }, ctx.signal);
    const shots = (res.shots || []).slice(0, count).map((s, i) => ({
      ...s, sequence: sequenceStart + i, shotNo: sequenceStart + i, duration: clipSeconds,
      // 每镜写入风格锚点：出图 / 出片 / 导演包都会读 shot.aesthetic，保证风格真的落到画面上
      aestheticId: aesthetic?.id || null,
      paletteName: aesthetic?.paletteName || null,
      medium: aesthetic?.medium?.length ? aesthetic.medium[(sequenceStart + i) % aesthetic.medium.length] : null,
      // 格位：分镜板（九宫格 / 六宫格…）里这一镜落在第几格，宫格图与灯箱都按它对齐
      panel: panelIndexOf(sheet, sequenceStart + i),
    }));
    // LLM 少给镜头时补齐，保证「片段数 = clipCount」严格成立（零 Key mock 会正好给 count 个）
    const template = shots[shots.length - 1] || {
      size: '中景', angle: '平视', movement: '固定',
      ffDesc: `${scene.location || scene.title || '场景'}｜延续上一镜头的空间与光线`,
      motionDesc: '镜头保持，角色动作延续', audioDesc: '环境音延续', characters: [],
    };
    while (shots.length < count) {
      const i = shots.length;
      shots.push({ ...template, sequence: sequenceStart + i, shotNo: sequenceStart + i,
        duration: clipSeconds, ffDesc: `${template.ffDesc}（续镜 ${i + 1}）` });
    }
    const charNode = ctx.project.nodes.find((n) => n.type === 'character');
    const cameraNode = ctx.project.nodes.find((n) => n.type === 'camera');
    const finalNode = ctx.project.nodes.find((n) => n.type === 'final');
    ctx.log('think', `为「${scene.location || scene.title}」规划 ${shots.length} 个镜头，建立机位链与空间锚点`);
    ctx.progress(0.45);

    let prevTail = null;
    const chain = [];
    shots.forEach((shot, i) => {
      const shotNode = ctx.addNodeAndEdge({
        type: 'shot', agent: null, status: 'done',
        title: `镜头 ${d.index !== undefined ? `${d.index + 1}-` : ''}${shot.shotNo} · ${shot.size}`,
        data: { shot, scene, depth: 3, summary: brief(shot.ffDesc, 46) },
      }, ctx.node.id, 'flow');

      const keyNode = ctx.addNodeAndEdge({
        type: 'keyframe', agent: 'keyframe',
        title: `关键帧 · ${d.index !== undefined ? `${d.index + 1}-` : ''}${shot.shotNo}`,
        data: { shot, scene, k: ctx.settings.k || 2 },
      }, shotNode.id, 'flow');
      if (charNode) ctx.addEdges([{ from: charNode.id, to: keyNode.id, kind: 'ref' }]);
      if (prevTail) ctx.addEdges([{ from: prevTail, to: keyNode.id, kind: 'anchor' }]);

      const reviewNode = ctx.addNodeAndEdge({
        type: 'review', agent: 'review', title: `VLM 择优 · ${shot.shotNo}`,
        data: { shot, k: ctx.settings.k || 2 },
      }, keyNode.id, 'flow');

      const videoNode = ctx.addNodeAndEdge({
        type: 'video', agent: 'video', title: `视频片段 · ${shot.shotNo}`,
        data: { shot, clipSeconds, sequence: shot.sequence },
      }, reviewNode.id, 'flow');
      if (finalNode) ctx.addEdges([{ from: videoNode.id, to: finalNode.id, kind: 'flow' }]);

      // 跨机位的转场视频：作为下一镜头的空间锚点（论文式 8）
      if (i < shots.length - 1) {
        const transNode = ctx.addNodeAndEdge({
          type: 'transition', agent: 'transition', title: `转场锚点 ${shot.shotNo}→${shot.shotNo + 1}`,
          data: { shot, nextShot: shots[i + 1], fromCam: `机位 ${String.fromCharCode(65 + Math.floor(i / 2))}` },
        }, reviewNode.id, 'anchor');
        prevTail = transNode.id;
        chain.push(transNode.id);
      }
      chain.push(shotNode.id, keyNode.id, reviewNode.id, videoNode.id);
    });

    // 镜头完成后把视频汇总给机位图节点做一致性报告
    if (cameraNode) {
      const videoIds = chain.filter((id) => {
        const n = ctx.project.nodes.find((x) => x.id === id);
        return n && n.type === 'video';
      });
      for (const vid of videoIds) ctx.addEdges([{ from: vid, to: cameraNode.id, kind: 'ref' }]);
    }

    ctx.progress(0.95);
    ctx.patch({
      shots, shotCount: shots.length, chain, scene,
      sheet: { layout: sheet.layout, cols: sheet.cols, rows: sheet.rows, cells: sheet.cells, aspect: sheet.resolvedAspect },
      summary: `${shots.length} 镜头 · ${shots.length - 1} 转场锚点 · ${shots.length * 4 + shots.length - 1} 个节点 · 分镜板 ${sheet.cols}×${sheet.rows}`,
    });
  },
});

defineAgent({
  id: 'camera-graph', label: '机位依赖图智能体', group: '镜头', icon: '⌗', color: '#fbbf24',
  description: '构建机位依赖图、统计视觉锚点与并行层（论文式 7 / 3.5）',
  async run(ctx) {
    const plan = ctx.upstream.find((n) => n.data?.shotPlan)?.data || ctx.node.data;
    const shotPlan = plan.shotPlan || [];
    const flatShots = shotPlan.flatMap((s) => s.shots || []);
    ctx.progress(0.3);
    const res = await ctx.providers.generate('cameras', { shots: flatShots }, ctx.signal);
    const cams = res.cameras || [];
    // 式(7)：并行层是机位依赖图的真实拓扑分层——parent 链决定层次，同层机位无相互依赖可并发
    const camEdges = cams
      .filter((c) => c.parent && cams.some((p) => p.id === c.parent))
      .map((c) => ({ from: c.parent, to: c.id, kind: 'flow' }));
    const parallelLayers = Math.max(1, topoLayers(cams, camEdges).layers.length);
    const anchors = (ctx.project.edges || []).filter((e) => e.kind === 'anchor').length;
    const videos = (ctx.project.nodes || []).filter((n) => n.type === 'video');
    const doneVideos = videos.filter((n) => n.status === 'done').length;
    ctx.progress(0.9);
    // 第⑤步只出分镜图：此时片段通常还是 0/N，不能让它看起来像「漏生成」。
    const clipNote = doneVideos ? `${doneVideos}/${videos.length} 个片段已出` : `${videos.length} 个片段待第⑥步生成`;
    ctx.patch({
      cameras: cams, anchorCount: anchors, parallelLayers,
      shotCount: flatShots.length, videoReady: `${doneVideos}/${videos.length}`,
      summary: `${cams.length} 个机位 · ${parallelLayers} 个可并发层 · ${anchors} 条视觉锚点 · ${clipNote}`,
    });
    ctx.log('think', `拓扑分层完成：无依赖机位可并发生成，依赖机位继承前驱视觉锚点`);
  },
});
