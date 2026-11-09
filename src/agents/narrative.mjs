// 叙事组 / 资产组 / 镜头规划智能体
import { defineAgent } from '../core/agent.mjs';
import { hash } from '../core/artwork.mjs';
import { matchCharacters, registerAsset } from '../core/assets.mjs';
import { buildCharacterPrompt } from '../core/characters.mjs';
import { chunkNovel, KnowledgeBase, retrieveRelevantChunks,
  saveKnowledgeCache, loadKnowledgeCache, formatFragments } from '../core/knowledge.mjs';
import { topoLayers } from '../core/graph.mjs';
import { resolveRuntimeSpec, allocateShots, shotSequenceStarts } from '../core/runtime-spec.mjs';

const textOf = (v) => String(v || '').trim();
const brief = (s, n = 46) => (String(s || '').length > n ? `${String(s).slice(0, n)}…` : String(s || ''));

function findScript(ctx) {
  // 上游可能是 script 节点，也可能是携带剧本副本的 RAG / 规划节点
  return ctx.upstream.find((n) => n.data?.script)?.data?.script || ctx.node.data.script || null;
}

defineAgent({
  id: 'screenwriter', label: '编剧智能体', group: '叙事', icon: '✎', color: '#a78bfa',
  description: '把一句话创意扩展为统一格式的剧本（论文式 1）',
  async run(ctx) {
    const idea = textOf(ctx.node.data.text) || textOf(ctx.inputs.find((i) => i.text)?.text) || '一位侦探在雨夜收到一封没有署名的信';
    ctx.progress(0.2);
    // 创作项目：小说标题 / 分集梗概 / 原著角色随输入下发，保证剧本来自用户上传的内容
    const script = await ctx.providers.generate('screenplay', {
      idea, style: ctx.settings.style,
      title: ctx.node.data.novelTitle || undefined,
      episodes: ctx.node.data.novelEpisodes || undefined,
      characters: ctx.node.data.characters || undefined,
      novelExcerpt: ctx.node.data.novelExcerpt || undefined,
    }, ctx.signal);
    ctx.log('think', `识别到 ${script.characters.length} 位角色、${script.scenes.length} 个场景，正在统一剧本格式`);
    ctx.progress(0.8);
    ctx.setTitle(`剧本 · ${script.title}`);
    ctx.patch({
      text: idea, script,
      summary: `${script.genre}｜${script.logline}`,
      sceneCount: script.scenes.length, characterCount: script.characters.length,
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
    const script = findScript(ctx) || { scenes: [], characters: [] };
    const context = ctx.upstream.find((n) => n.data?.context)?.data?.context || null;
    const sceneLimit = Math.max(1, Math.min(4, Number(ctx.node.data.sceneLimit) || 2));
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
          fragments,
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
  description: '抽取角色、生成三视图定妆资产，供所有镜头以 ref 边复用；优先匹配资源库已生成的角色',
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
      }));
      ctx.log('info', `使用项目管理中维护的 ${wanted.length} 位角色属性驱动造型生成`);
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
    const res = await ctx.providers.generate('shots', {
      scene, count, clipSeconds, idea: d.script?.logline,
      fragments: d.fragments || formatFragments(d.relevantChunks, 4),
      aesthetic,
    }, ctx.signal);
    const shots = (res.shots || []).slice(0, count).map((s, i) => ({
      ...s, sequence: sequenceStart + i, shotNo: sequenceStart + i, duration: clipSeconds,
      // 每镜写入风格锚点：出图 / 出片 / 导演包都会读 shot.aesthetic，保证风格真的落到画面上
      aestheticId: aesthetic?.id || null,
      paletteName: aesthetic?.paletteName || null,
      medium: aesthetic?.medium?.length ? aesthetic.medium[(sequenceStart + i) % aesthetic.medium.length] : null,
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
      summary: `${shots.length} 镜头 · ${shots.length - 1} 转场锚点 · ${shots.length * 4 + shots.length - 1} 个节点`,
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
    ctx.patch({
      cameras: cams, anchorCount: anchors, parallelLayers,
      shotCount: flatShots.length, videoReady: `${doneVideos}/${videos.length}`,
      summary: `${cams.length} 个机位 · ${parallelLayers} 个可并发层 · ${anchors} 条视觉锚点 · ${videos.length} 个片段节点`,
    });
    ctx.log('think', `拓扑分层完成：无依赖机位可并发生成，依赖机位继承前驱视觉锚点`);
  },
});
