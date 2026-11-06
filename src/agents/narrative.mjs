// 叙事组 / 资产组 / 镜头规划智能体
import { defineAgent } from '../core/agent.mjs';
import { hash } from '../core/artwork.mjs';

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
    const script = await ctx.providers.generate('screenplay', { idea, style: ctx.settings.style }, ctx.signal);
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
  description: '索引原著并按节点描述检索，补全分解时丢失的全局信息（论文式 6）',
  async run(ctx) {
    const script = findScript(ctx);
    const corpus = script
      ? [script.logline, ...script.scenes.map((s) => `${s.location}：${s.summary}`), ...script.characters.map((c) => `${c.name}：${c.appearance}`)].join('。')
      : textOf(ctx.node.data.corpus);
    ctx.progress(0.35);
    const context = await ctx.providers.generate('context', { corpus, query: ctx.node.title }, ctx.signal);
    ctx.progress(0.9);
    ctx.patch({
      context, corpus, script,
      indexSize: corpus.length, passages: context.passages?.length || 0,
      summary: `索引 ${corpus.length} 字 · 命中 ${context.passages?.length || 0} 段上下文`,
    });
    ctx.log('think', `建立原文索引，检索到 ${context.passages?.length || 0} 段相关上下文，将随局部规划下发`);
  },
});

defineAgent({
  id: 'decomposer', label: '层次化叙事分解', group: '叙事', icon: '⑂', color: '#22d3ee',
  description: '事件 → 场景 → 镜头递归分解，运行中动态展开画布（论文式 5）',
  async run(ctx) {
    const script = findScript(ctx) || { scenes: [], characters: [] };
    const context = ctx.upstream.find((n) => n.data?.context)?.data?.context || null;
    const sceneLimit = Math.max(1, Math.min(4, Number(ctx.node.data.sceneLimit) || 2));
    const shotsPerScene = Math.max(2, Math.min(5, Number(ctx.node.data.shotsPerScene) || 3));
    ctx.progress(0.25);
    const result = await ctx.providers.generate('events', { scenes: script.scenes.slice(0, sceneLimit), idea: script.logline }, ctx.signal);
    const events = (result.events || []).slice(0, sceneLimit);
    ctx.log('think', `拆解为 ${events.length} 个事件，按 processChain 保持因果顺序`);
    ctx.progress(0.55);

    const created = [];
    events.forEach((event, i) => {
      const eventNode = ctx.addNodeAndEdge({
        type: 'event', agent: null, status: 'done',
        title: event.title || `事件 ${i + 1}`,
        data: { event, context, script, depth: 1, summary: brief(event.summary, 40) },
      }, ctx.node.id, 'flow');
      const sceneSpec = (event.scenes && event.scenes[0]) || { title: event.title, location: '内景', time: '夜', summary: event.summary };
      const sceneNode = ctx.addNodeAndEdge({
        type: 'scene', agent: 'storyboard',
        title: `场景 ${i + 1} · ${sceneSpec.location || sceneSpec.title}`,
        data: { scene: sceneSpec, script, context, index: i, shotsPerScene, depth: 2,
          summary: brief(sceneSpec.summary, 40) },
      }, eventNode.id, 'flow');
      created.push(eventNode.id, sceneNode.id);
    });

    // 预生成镜头概要，供机位依赖图与一致性报告使用
    const shotPlan = [];
    for (let i = 0; i < events.length; i++) {
      const sceneSpec = (events[i].scenes && events[i].scenes[0]) || {};
      const shots = await ctx.providers.generate('shots', { scene: sceneSpec, count: shotsPerScene, idea: script.logline }, ctx.signal);
      shotPlan.push({ scene: i + 1, location: sceneSpec.location, shots: shots.shots || [] });
    }
    ctx.progress(0.95);
    ctx.patch({
      events, shotPlan, context, script,
      hierarchy: ['事件', '场景', '镜头'], eventCount: events.length,
      sceneCount: events.length, plannedShots: shotPlan.reduce((a, s) => a + s.shots.length, 0),
      spawned: created, summary: `${events.length} 事件 → ${events.length} 场景 → ${shotPlan.reduce((a, s) => a + s.shots.length, 0)} 镜头`,
    });
    ctx.log('info', `画布已展开 ${created.length} 个规划节点；RAG 上下文随节点下发`);
  },
});

defineAgent({
  id: 'character', label: '角色造型智能体', group: '资产', icon: '◉', color: '#f472b6',
  description: '抽取角色、生成三视图定妆资产，供所有镜头以 ref 边复用',
  async run(ctx) {
    const script = findScript(ctx) || { characters: [] };
    ctx.progress(0.2);
    const res = await ctx.providers.generate('characters', { characters: script.characters }, ctx.signal);
    const characters = [];
    for (let i = 0; i < (res.characters || []).length; i++) {
      const c = res.characters[i];
      const img = await ctx.providers.image({
        kind: 'character', label: c.name, prompt: c.appearance,
        style: ctx.settings.style, seed: `${ctx.project.id}-${c.name}`,
      }, ctx.signal);
      characters.push({ ...c, portraitUrl: img.url, assetKind: '三视图' });
      ctx.progress(0.2 + (i + 1) / (res.characters.length + 1) * 0.7);
    }
    ctx.patch({ characters, registry: characters.map((c) => c.name), summary: `${characters.length} 位角色 · 三视图已锁定` });
    ctx.log('info', `角色资产库就绪，后续镜头通过 ref 边引用，避免跨镜头身份漂移`);
  },
});

defineAgent({
  id: 'storyboard', label: '分镜智能体', group: '镜头', icon: '▤', color: '#60a5fa',
  description: '把场景转为镜头规格，并在画布上生长出完整的生成链（论文式 2 / 7 / 8）',
  async run(ctx) {
    const d = ctx.node.data;
    const scene = d.scene || { location: '场景', summary: '' };
    const count = Math.max(2, Math.min(5, Number(d.shotsPerScene) || 3));
    ctx.progress(0.2);
    const res = await ctx.providers.generate('shots', { scene, count, idea: d.script?.logline }, ctx.signal);
    const shots = res.shots || [];
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
        data: { shot },
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
    const anchors = (ctx.project.edges || []).filter((e) => e.kind === 'anchor').length;
    const videos = (ctx.project.nodes || []).filter((n) => n.type === 'video');
    const doneVideos = videos.filter((n) => n.status === 'done').length;
    ctx.progress(0.9);
    ctx.patch({
      cameras: res.cameras || [], anchorCount: anchors,
      parallelLayers: Math.max(1, Math.ceil(flatShots.length / Math.max(1, ctx.settings.concurrency || 3))),
      shotCount: flatShots.length, videoReady: `${doneVideos}/${videos.length}`,
      summary: `${(res.cameras || []).length} 个机位 · ${anchors} 条视觉锚点 · ${videos.length} 个片段节点`,
    });
    ctx.log('think', `拓扑分层完成：无依赖机位可并发生成，依赖机位继承前驱视觉锚点`);
  },
});
