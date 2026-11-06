// 生成组 / 交付组智能体：关键帧、VLM 择优、视频片段、转场锚点、成片组装
import { defineAgent } from '../core/agent.mjs';
import { stitchClips } from '../core/film.mjs';
import { exportDirectorPack } from '../core/director-pack.mjs';

function incomingSources(ctx, kind) {
  return ctx.project.edges
    .filter((e) => e.to === ctx.node.id && (!kind || e.kind === kind))
    .map((e) => ctx.project.nodes.find((n) => n.id === e.from))
    .filter(Boolean);
}

defineAgent({
  id: 'keyframe', label: '关键帧生成', group: '生成', icon: '▣', color: '#34d399',
  description: '按镜头规格生成 k 张候选，并继承角色资产与视觉锚点（论文式 3 上半 / 7）',
  async run(ctx) {
    const shot = ctx.node.data.shot || ctx.inputs.find((i) => i.shot)?.shot || {};
    const k = Math.max(1, Math.min(4, Number(ctx.settings.k) || Number(ctx.node.data.k) || 2));
    const refs = [];
    for (const src of incomingSources(ctx, 'ref')) {
      const portraits = (src.data?.characters || []).map((c) => c.portraitUrl).filter(Boolean);
      refs.push(...portraits);
    }
    for (const src of incomingSources(ctx, 'anchor')) {
      if (src.data?.keyframeUrl) refs.push(src.data.keyframeUrl);
      if (src.data?.transition?.url) refs.push(src.data.transition.url);
    }
    ctx.log('think', `镜头 ${shot.shotNo || '?'} 继承 ${refs.length} 个视觉锚点，生成 ${k} 张候选`);
    const candidates = [];
    for (let i = 0; i < k; i++) {
      const prompt = `${shot.ffDesc || ''}｜候选 ${i + 1}：${i === 0 ? '严格遵循机位与构图' : '在光照与景深上做轻微变体'}`;
      const img = await ctx.providers.image({
        kind: 'keyframe', label: `${shot.size || '镜头'} · ${shot.shotNo || i}`,
        shotNo: shot.shotNo || i + 1, size: shot.size, angle: shot.angle, movement: shot.movement,
        prompt, characters: shot.characters || [], style: ctx.settings.style,
        seed: `${ctx.node.id}-${i}`, refs,
      }, ctx.signal);
      candidates.push({ url: img.url, prompt, refs, provider: img.provider, width: img.width, height: img.height });
      ctx.progress(0.15 + ((i + 1) / k) * 0.75);
    }
    ctx.patch({ candidates, shot, refs, k, summary: `${k} 张候选 · ${refs.length} 个锚点引用` });
  },
});

defineAgent({
  id: 'review', label: 'VLM 质量择优', group: '生成', icon: '✓', color: '#34d399',
  description: '按视觉保真 / 叙事一致 / 规格遵循打分，选出最优关键帧（论文式 4）',
  async run(ctx) {
    const source = incomingSources(ctx, 'flow')[0] || ctx.upstream[0];
    const candidates = source?.data?.candidates || ctx.node.data.candidates || [];
    if (!candidates.length) throw new Error('没有可评审的关键帧候选');
    ctx.progress(0.35);
    const verdict = await ctx.providers.judge({
      candidates, criteria: ['视觉保真度', '叙事一致性', '镜头规格遵循'],
      shotTitle: `${ctx.node.data.shot?.size || '镜头'} ${ctx.node.data.shot?.shotNo || ''}`,
    }, ctx.signal);
    const selected = candidates[Math.min(verdict.index, candidates.length - 1)];
    ctx.progress(0.9);
    // judgeMode 显式区分真实 VLM 看图择优与启发式回退，不再假装是 VLM 打分
    const modeNote = verdict.judgeMode === 'vlm' ? ' · VLM 看图择优'
      : verdict.fallback ? ' · VLM 不可用，回退启发式' : ' · 启发式打分';
    ctx.patch({
      selected: verdict.index, scores: verdict.scores, reason: verdict.reason,
      criteria: verdict.criteria, judgeMode: verdict.judgeMode, keyframeUrl: selected.url, candidates,
      rejected: candidates.filter((_, i) => i !== verdict.index).map((c) => c.url),
      summary: `选中候选 ${verdict.index + 1}/${candidates.length} · 最高分 ${Math.max(...verdict.scores).toFixed(3)}${modeNote}`,
    });
    ctx.log('info', `评审（${verdict.judgeMode === 'vlm' ? 'VLM' : '启发式'}）：${verdict.reason}`);
  },
});

defineAgent({
  id: 'video', label: '镜头视频生成', group: '生成', icon: '▶', color: '#fb923c',
  description: '以选中关键帧 + 运动描述生成镜头片段（论文式 3 下半）',
  async run(ctx) {
    const review = incomingSources(ctx, 'flow')[0] || ctx.upstream[0];
    const shot = ctx.node.data.shot || review?.data?.shot || {};
    const keyframeUrl = review?.data?.keyframeUrl || null;
    const reviewNode = incomingSources(ctx, 'flow')[0];
    const transNode = ctx.project.edges
      .filter((e) => e.from === reviewNode?.id && e.kind === 'anchor')
      .map((e) => ctx.project.nodes.find((n) => n.id === e.to))
      .find((n) => n?.type === 'transition');
    const transition = transNode?.data?.transition?.url;
    const frames = [...new Set([keyframeUrl, transition].filter(Boolean))];
    if (!frames.length) throw new Error('缺少关键帧，无法生成视频片段');
    ctx.progress(0.3);
    const clip = await ctx.providers.video({ frames, duration: shot.duration || 5, prompt: shot.motionDesc }, ctx.signal);
    ctx.progress(0.9);
    ctx.patch({ clip, poster: clip.poster, duration: clip.duration, frames, shot, summary: `${clip.duration}s · ${frames.length} 帧预览` });
  },
});

defineAgent({
  id: 'transition', label: '转场空间锚点', group: '生成', icon: '⇄', color: '#fb923c',
  description: '为跨机位镜头生成平滑转场，锁定三维空间关系（论文式 8）',
  async run(ctx) {
    const review = incomingSources(ctx, 'anchor')[0] || ctx.upstream[0];
    const from = ctx.node.data.fromCam || '机位 A';
    const to = `机位 ${String.fromCharCode((from.charCodeAt(from.length - 1) || 65) + 1)}`;
    const spatial = await ctx.providers.generate('spatial', { fromCam: from, toCam: to }, ctx.signal);
    const img = await ctx.providers.image({
      kind: 'transition', from, to, style: ctx.settings.style,
      prompt: spatial.cameraPath, seed: ctx.node.id,
    }, ctx.signal);
    const keyframeUrl = review?.data?.keyframeUrl || null;
    // 式(8)：空间锚点取自「端点视图」——生成终点机位视图，与起点关键帧成对传递给下游
    const endView = await ctx.providers.image({
      kind: 'keyframe', style: ctx.settings.style, shotNo: 0,
      prompt: `终点机位视角：${spatial.spatialNotes}｜${spatial.axisRule} 轴线，空间状态与起点视图一致`,
      seed: `${ctx.node.id}-end`,
    }, ctx.signal);
    const transition = {
      url: img.url, ...spatial,
      fromFrame: keyframeUrl, toFrame: endView.url,
      frames: [keyframeUrl, endView.url].filter(Boolean),
    };
    // ComfyUI 可用时生成真实转场视频；Mock 下保持帧序列预览不产假视频
    if (ctx.providers.comfyActive && transition.frames.length === 2) {
      try {
        const clip = await ctx.providers.video({
          frames: transition.frames, duration: 2,
          prompt: `${spatial.cameraPath}；${spatial.spatialNotes}`,
        }, ctx.signal);
        transition.video = clip;
        ctx.log('info', `转场视频已生成（${clip.provider}）`);
      } catch (err) {
        ctx.log('warn', `转场视频生成失败，保留端点视图锚点：${err.message}`);
      }
    }
    ctx.patch({
      transition,
      url: img.url,
      summary: `${from} → ${to} · ${spatial.axisRule} 轴线 · 端点视图 ${transition.frames.length} 帧${transition.video ? ' · 含转场视频' : ''}`,
    });
    ctx.log('think', `空间锚点已建立：${spatial.spatialNotes}`);
  },
});

defineAgent({
  id: 'composer', label: '成片组装', group: '交付', icon: '✦', color: '#facc15',
  description: '汇总所有镜头片段，生成时间线、封面与一致性报告',
  async run(ctx) {
    const videos = ctx.project.nodes.filter((n) => n.type === 'video' && n.data?.clip);
    const camera = ctx.project.nodes.find((n) => n.type === 'camera');
    const script = ctx.project.nodes.find((n) => n.type === 'script')?.data?.script;
    const title = script?.title || ctx.project.name || '未命名影片';
    const timeline = videos.map((n, i) => ({
      index: i + 1, nodeId: n.id, title: n.title,
      poster: n.data.poster, duration: n.data.duration || 5,
      shotNo: n.data.shot?.shotNo || i + 1,
    }));
    const duration = timeline.reduce((a, t) => a + t.duration, 0);
    ctx.progress(0.55);
    const poster = await ctx.providers.image({
      kind: 'poster', label: title, shotCount: timeline.length,
      duration, style: ctx.settings.style, seed: ctx.project.id,
    }, ctx.signal);

    // 两条交付路径：① 本地 ComfyUI 片段 → ffmpeg 成片；② 导演包 → 导入 ComfyUI 导演工作台
    const cfg = ctx.settings?.comfy || {};
    const outputMode = cfg.outputMode || 'both';
    const realClips = videos.filter((n) => n.data?.clip?.file && n.data.clip?.provider === 'comfyui');
    let film = null;
    let directorPack = null;
    if (outputMode !== 'director-pack' && cfg.stitch !== false && realClips.length) {
      film = stitchClips(realClips.map((n) => n.data.clip));
      ctx.log('info', film
        ? `成片已由 ${film.clips} 个 ComfyUI 片段拼接（${film.method}）`
        : '未能拼接成片：本机 ffmpeg 不可用或片段编码不一致，已保留逐镜头片段');
    }
    ctx.progress(0.8);
    if (outputMode !== 'video') {
      const pack = exportDirectorPack(ctx.project, cfg);
      directorPack = {
        url: pack.url, file: pack.file, filename: pack.filename, bytes: pack.bytes,
        target: pack.format, shotCount: pack.shotCount, fileCount: pack.fileCount,
        groups: pack.groups, note: pack.note,
      };
      ctx.log('info', `导演包已生成：${pack.filename} · ${pack.shotCount} 组镜头 · ${pack.fileCount} 个文件`);
    }
    ctx.progress(0.95);
    const deliverables = {
      outputMode,
      video: film ? { url: film.url, file: film.file, clips: film.clips, method: film.method, bytes: film.bytes }
        : outputMode === 'director-pack' ? { clips: 0, note: '本次只导出导演包，视频由 ComfyUI 导演工作台生成' }
          : realClips.length ? { clips: realClips.length, note: '逐镜头片段已生成，未合并为单文件' }
            : { clips: 0, note: 'Mock 模式为帧序列预览；导入 ComfyUI 视频工作流后产出真实片段' },
      directorPack: directorPack ? { url: directorPack.url, filename: directorPack.filename, bytes: directorPack.bytes } : null,
    };
    ctx.patch({
      timeline, duration, shotCount: timeline.length, poster: poster.url,
      film, directorPack, deliverables, outputMode,
      cameraReport: camera?.data || null,
      report: {
        clips: timeline.length, anchors: ctx.project.edges.filter((e) => e.kind === 'anchor').length,
        refs: ctx.project.edges.filter((e) => e.kind === 'ref').length,
        cameras: camera?.data?.cameras?.length || 0,
        realClips: realClips.length,
      },
      summary: `${timeline.length} 个片段 · ${duration}s · ${film ? '成片已生成' : '预览已生成'}${directorPack ? ' · 导演包已导出' : ''}`,
    });
    ctx.log('info', `交付完成：产物模式 ${outputMode}${film ? ' / 成片 MP4' : ''}${directorPack ? ' / 导演包' : ''}`);
  },
});
