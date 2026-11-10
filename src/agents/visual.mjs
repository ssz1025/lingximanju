// 生成组 / 交付组智能体：关键帧、VLM 择优、视频片段、转场锚点、成片组装
import { defineAgent } from '../core/agent.mjs';
import { stitchClips } from '../core/film.mjs';
import { exportDirectorPack } from '../core/director-pack.mjs';
import { resolveRuntimeSpec } from '../core/runtime-spec.mjs';
import { renderPreviewFilm } from '../core/preview-film.mjs';
import { isRealClip, evaluateFilm, normalizeFilmPolicy } from '../core/film-policy.mjs';
import { resolveFrameVisualPack, buildFramePrompts } from '../core/shot-visuals.mjs';
import { resolveStoryboardSettings, describeStoryboardSettings, framePromptNote, panelIndexOf } from '../core/storyboard-settings.mjs';

function incomingSources(ctx, kind) {
  return ctx.project.edges
    .filter((e) => e.to === ctx.node.id && (!kind || e.kind === kind))
    .map((e) => ctx.project.nodes.find((n) => n.id === e.from))
    .filter(Boolean);
}

/**
 * 提交即记录 prompt_id。
 * 服务重启 / 请求中断后，ComfyUI 往往已经把图跑完了，但我们只留了一个「排队中」的节点。
 * 把 prompt_id 写进 node.meta，就能在「任务状态 → 检查已完成」时凭它直接取回结果，
 * 而不是因为不知道发的是哪一条只能重新烧一遍。
 */
function trackPrompt(ctx) {
  return (promptId) => {
    const prev = Array.isArray(ctx.node.meta?.promptIds) ? ctx.node.meta.promptIds : [];
    ctx.setMeta({
      promptId,
      submittedAt: Date.now(),
      promptIds: [...prev.slice(-7), promptId],
    });
  };
}

defineAgent({
  id: 'keyframe', label: '关键帧生成', group: '生成', icon: '▣', color: '#34d399',
  description: '按镜头规格生成 k 张候选，并继承角色资产与视觉锚点（论文式 3 上半 / 7）',
  async run(ctx) {
    const shot = ctx.node.data.shot || ctx.inputs.find((i) => i.shot)?.shot || {};
    const k = Math.max(1, Math.min(4, Number(ctx.settings.k) || Number(ctx.node.data.k) || 2));
    const refs = [];
    // ① 出场角色的视觉物料包：定妆多视图 + 妆照（管理面板最权威，画布 / 资源库兜底）。
    //    每张参考图都带「槽位 + 用途」，提示词逐槽位写清楚哪张锁身份、哪张锁转身、
    //    哪张是妆照兜底 —— 多参考图出图不再「有图但模型不知道哪张是谁」。
    const visual = resolveFrameVisualPack(ctx.project, shot);
    refs.push(...visual.urls);
    if (visual.characters.length) {
      ctx.log('think', `镜头 ${shot.shotNo || '?'} 角色参考：${visual.summary}`);
      for (const note of visual.notes || []) ctx.log('warn', note);
    }
    // ② 画布 ref 边上的角色头像与锚点图作为补充（去重，避免同一张图重复上传）
    for (const src of incomingSources(ctx, 'ref')) {
      const portraits = (src.data?.characters || []).map((c) => c.portraitUrl).filter(Boolean);
      refs.push(...portraits);
    }
    for (const src of incomingSources(ctx, 'anchor')) {
      if (src.data?.keyframeUrl) refs.push(src.data.keyframeUrl);
      if (src.data?.transition?.url) refs.push(src.data.transition.url);
    }
    const uniqueRefs = [...new Set(refs)].slice(0, 8);   // 与 ComfyUI LoadImage 插槽上限对齐
    // 分镜画面设置随上下文进入提示词：格位 / 画幅 / 景别机位 / 角色 / 风格 / 连续性。
    // 过去提示词只拼 ffDesc + 「候选 N」，同一段里九个格子画出来像九张不同项目；
    // 现在每镜都知道自己在分镜板的第几格、要按什么画幅与构图出图。
    const sheet = resolveStoryboardSettings(ctx.project);
    const parts = sheet.prompt || {};
    const panel = panelIndexOf(sheet, shot.sequence ?? shot.shotNo ?? 1);
    const specLine = parts.spec
      ? [shot.size, shot.angle, shot.movement].filter(Boolean).join(' · ') : '';
    const refLine = visual.slots.length
      ? `参考图槽位：${visual.slots.map((s) => `槽位${s.slot}＝${s.label}（${s.usage}）`).join('；')}。人物面部、发型、服装以参考图为准，不得新增装饰`
      : '无角色参考图：按出场角色文字外观出图，全片保持同一外观';
    const charLine = parts.character && (shot.characters || []).length
      ? `出场角色：${(shot.characters || []).join('、')}（严格保持定妆与身份）` : '';
    const styleLine = parts.style && (shot.medium || shot.paletteName)
      ? `风格锚点：${[shot.medium, shot.paletteName].filter(Boolean).join(' · ')}` : '';
    const continuityLine = parts.continuity
      ? '空间连续性：与上一镜保持机位轴线、光线方向与角色外观一致' : '';
    const frameLine = parts.aspect ? framePromptNote(sheet, shot) : '';
    ctx.log('think', `镜头 ${shot.shotNo || '?'} 继承 ${uniqueRefs.length} 张参考图（角色多视图 ${visual.stats.viewRefs} 张 + 妆照 ${visual.stats.sheetRefs} 张 + 锚点/资产 ${uniqueRefs.length - visual.urls.length} 张），生成 ${k} 张候选 · 分镜板第 ${panel} 格`);
    const candidates = [];
    for (let i = 0; i < k; i++) {
      const prompt = [
        shot.ffDesc || '',
        specLine,
        refLine,
        charLine,
        styleLine,
        continuityLine,
        frameLine,
        `候选 ${i + 1}：${i === 0 ? '严格遵循机位与构图' : '在光照与景深上做轻微变体'}`,
      ].filter(Boolean).join('｜');
      const img = await ctx.providers.image({
        kind: 'keyframe', label: `${shot.size || '镜头'} · ${shot.shotNo || i}`,
        shotNo: shot.shotNo || i + 1, size: shot.size, angle: shot.angle, movement: shot.movement,
        prompt, characters: shot.characters || [], style: ctx.settings.style,
        seed: `${ctx.node.id}-${i}`, refs: uniqueRefs,
        onPromptId: trackPrompt(ctx),
      }, ctx.signal);
      candidates.push({ url: img.url, prompt, refs: uniqueRefs, provider: img.provider,
        refsUsed: img.refsUsed ?? null, width: img.width, height: img.height,
        // ComfyUI 提交号留痕：工作台「任务状态」据此显示这一镜发出去的是哪个 prompt_id，
        // 也方便用户拿着 id 去 ComfyUI 的队列 / 历史里复查。
        promptId: img.promptId || null });
      ctx.progress(0.15 + ((i + 1) / k) * 0.75);
    }
    ctx.patch({
      candidates, shot, refs: uniqueRefs, k,
      // 画面设置落到节点：分镜灯箱据此显示「第几格 / 什么画幅」，而不是只有一张图
      sheet: {
        layout: sheet.layout, cols: sheet.cols, rows: sheet.rows, cells: sheet.cells,
        aspect: sheet.resolvedAspect, panel, note: describeStoryboardSettings(sheet),
      },
      // 参考图槽位留痕：这一镜到底用了哪几张多视图 / 妆照、各锁什么，验收可直接核对
      refSlots: visual.slots,
      refNotes: visual.notes,
      characterRefs: visual.characters.map((c) => ({
        name: c.name, refs: c.refs.map((r) => ({ url: r.url, view: r.view, label: r.label })),
        sheet: c.sheet?.url || null,
      })),
      summary: `${k} 张候选 · ${uniqueRefs.length} 张参考（多视图 ${visual.stats.viewRefs} + 妆照 ${visual.stats.sheetRefs}）· 第 ${panel} 格`,
    });
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
    // 单片段时长由项目成片规格统一决定，不再用 shot 里散落的 4/5/6 或默认 5s
    const runtime = ctx.settings?.runtime?.schema === 1 ? ctx.settings.runtime : resolveRuntimeSpec(ctx.project);
    const clipSeconds = Number(ctx.node.data?.clipSeconds) || runtime.clipSeconds;
    // 图生视频提示词：分镜画面在第⑤步已为每格生成精确 videoPrompt（首帧锚定 +
    // 运动运镜 + 角色一致性 + 时长画幅 + 禁止项）；画布镜头没有现成字段时，
    // 现场按同一公式构建 —— 多参考图（定妆多视图 / 妆照）+ 首帧 + 站位图一并提供。
    const sheet = resolveStoryboardSettings(ctx.project);
    const visual = resolveFrameVisualPack(ctx.project, shot);
    const built = buildFramePrompts({
      shot: { ...shot, duration: clipSeconds }, visual, settings: sheet,
      style: ctx.settings.style, duration: clipSeconds, fps: runtime.fps,
    });
    const prompt = shot.videoPrompt || built.videoPrompt;
    ctx.log('think', `镜头 ${shot.shotNo || '?'} 图生视频参考：${built.refNote}`);
    const clip = await ctx.providers.video({
      frames, duration: clipSeconds, prompt,
      negative: '文字、水印、人物变形、闪烁跳帧、新增人物',
      // 镜号进文件名前缀（lingximanju_clip_<镜号>）：中断后能按镜号从 ComfyUI 历史里精准认领
      shotNo: shot.shotNo || ctx.node.data?.shot?.shotNo || 1,
      onPromptId: trackPrompt(ctx),
    }, ctx.signal);
    ctx.progress(0.9);
    ctx.patch({ clip, poster: clip.poster, duration: clipSeconds, clipSeconds,
      sequence: ctx.node.data?.sequence ?? shot.sequence ?? null,
      frames, shot, prompt,
      // 参考图计划留痕：这一镜的视频用哪些图（多视图 / 妆照 / 首帧 / 站位图）与用途
      refPlan: built.refPlan, refNote: built.refNote,
      summary: `${clipSeconds}s · ${frames.length} 帧预览 · ${built.refNote}` });
  },
});

defineAgent({
  id: 'transition', label: '转场空间锚点', group: '生成', icon: '⇄', color: '#fb923c',
  description: '为跨机位镜头生成平滑转场，锁定三维空间关系（论文式 8）',
  async run(ctx) {
    /** 端点帧（起点关键帧 + 终点机位视图）已经落盘时才走这条续跑路径：
     *  第⑥步补转场视频只重算视频，不重出两张端点图。 */
    const existing = ctx.node.data?.transition;
    if (ctx.node.data?.videoOnly && existing?.frames?.length === 2) {
      if (!ctx.providers.comfyActive) {
        ctx.patch({ videoPending: false, summary: `${existing.fromCam || '机位'} 转场端点帧已就绪 · 未接 ComfyUI，不生成转场视频` });
        return;
      }
      const clip = await ctx.providers.video({
        frames: existing.frames, duration: 2,
        prompt: `${existing.cameraPath}；${existing.spatialNotes}`,
        onPromptId: trackPrompt(ctx),
      }, ctx.signal);
      ctx.patch({
        transition: { ...existing, video: clip },
        videoPending: false,
        summary: `${existing.fromCam || '机位'} 转场视频已补齐 · ${clip.provider}`,
      });
      ctx.log('info', `转场视频已补齐（${clip.provider}）`);
      return;
    }

    const review = incomingSources(ctx, 'anchor')[0] || ctx.upstream[0];
    const from = ctx.node.data.fromCam || '机位 A';
    const to = `机位 ${String.fromCharCode((from.charCodeAt(from.length - 1) || 65) + 1)}`;
    const spatial = await ctx.providers.generate('spatial', { fromCam: from, toCam: to }, ctx.signal);
    const img = await ctx.providers.image({
      kind: 'transition', from, to, style: ctx.settings.style,
      prompt: spatial.cameraPath, seed: ctx.node.id,
      onPromptId: trackPrompt(ctx),
    }, ctx.signal);
    const keyframeUrl = review?.data?.keyframeUrl || null;
    // 式(8)：空间锚点取自「端点视图」——生成终点机位视图，与起点关键帧成对传递给下游
    const endView = await ctx.providers.image({
      kind: 'keyframe', style: ctx.settings.style, shotNo: 0,
      prompt: `终点机位视角：${spatial.spatialNotes}｜${spatial.axisRule} 轴线，空间状态与起点视图一致`,
      seed: `${ctx.node.id}-end`,
      onPromptId: trackPrompt(ctx),
    }, ctx.signal);
    const transition = {
      url: img.url, ...spatial,
      fromFrame: keyframeUrl, toFrame: endView.url,
      frames: [keyframeUrl, endView.url].filter(Boolean),
    };
    // 第⑤步（videoStage=false）只建端点帧；转场视频留到第⑥步用 videoOnly 续跑，
    // 避免「分镜图还没定版就开始烧图生视频」。
    if (ctx.settings?.videoStage === true && ctx.providers.comfyActive && transition.frames.length === 2) {
      try {
        const clip = await ctx.providers.video({
          frames: transition.frames, duration: 2,
          prompt: `${spatial.cameraPath}；${spatial.spatialNotes}`,
          onPromptId: trackPrompt(ctx),
        }, ctx.signal);
        transition.video = clip;
        ctx.log('info', `转场视频已生成（${clip.provider}）`);
      } catch (err) {
        ctx.log('warn', `转场视频生成失败，保留端点视图锚点：${err.message}`);
      }
    } else if (transition.frames.length === 2) {
      transition.videoPending = true;
    }
    ctx.patch({
      transition,
      url: img.url,
      videoPending: transition.videoPending === true,
      summary: `${from} → ${to} · ${spatial.axisRule} 轴线 · 端点视图 ${transition.frames.length} 帧${transition.video ? ' · 含转场视频' : transition.videoPending ? ' · 转场视频待第⑥步生成' : ''}`,
    });
    ctx.log('think', `空间锚点已建立：${spatial.spatialNotes}`);
  },
});

defineAgent({
  id: 'composer', label: '成片组装', group: '交付', icon: '✦', color: '#facc15',
  description: '汇总所有镜头片段，生成时间线、封面与一致性报告',
  async run(ctx) {
    const runtime = ctx.settings?.runtime?.schema === 1 ? ctx.settings.runtime : resolveRuntimeSpec(ctx.project);
    // 按全局镜头序号排序，而不是按波次完成的数组顺序，保证成片播放顺序正确
    const seq = (n) => Number(n.data?.sequence ?? n.data?.shot?.sequence ?? n.data?.shot?.shotNo ?? 0);
    const videos = ctx.project.nodes.filter((n) => n.type === 'video' && n.data?.clip)
      .sort((a, b) => seq(a) - seq(b));
    const camera = ctx.project.nodes.find((n) => n.type === 'camera');
    const script = ctx.project.nodes.find((n) => n.type === 'script')?.data?.script;
    const title = script?.title || ctx.project.name || '未命名影片';
    const timeline = videos.map((n, i) => ({
      index: i + 1, nodeId: n.id, title: n.title,
      poster: n.data.poster, duration: Number(n.data.duration) || runtime.clipSeconds,
      shotNo: n.data.shot?.shotNo || i + 1,
      sequence: seq(n) || i + 1,
    }));
    const duration = Math.round(timeline.reduce((a, t) => a + t.duration, 0) * 100) / 100;
    ctx.progress(0.55);
    const poster = await ctx.providers.image({
      kind: 'poster', label: title, shotCount: timeline.length,
      duration, style: ctx.settings.style, seed: ctx.project.id,
    }, ctx.signal);

    // 两条交付路径：① ComfyUI 真实片段 → ffmpeg 成片；② 导演包 → 导入 ComfyUI 导演工作台
    // filmPolicy='real'（默认）时，只要有一个片段不是 ComfyUI 真实产物就不生成成片，
    // 绝不用「关键帧预览 MP4」冒充 AI 短剧；只有显式切到 preview 才允许降级产物。
    const cfg = ctx.settings?.comfy || {};
    const outputMode = cfg.outputMode || 'both';
    const policy = normalizeFilmPolicy(runtime.filmPolicy);
    const realClipNodes = videos.filter((n) => isRealClip(n.data?.clip));
    const allReal = realClipNodes.length > 0 && realClipNodes.length === runtime.clipCount;
    const promptIds = realClipNodes.map((n) => n.data.clip.promptId).filter(Boolean);
    let film = null;
    let filmNote = '';
    let directorPack = null;
    if (outputMode !== 'director-pack' && cfg.stitch !== false) {
      if (policy === 'real') {
        if (allReal) {
          film = stitchClips(realClipNodes.map((n) => n.data.clip), { clipSeconds: runtime.clipSeconds });
          filmNote = film
            ? `真实成片：${film.clips} 个 ComfyUI 片段拼接（${film.method}）· ffprobe ${film.measured ? `实测 ${film.duration}s` : '不可用'}`
            : '真实片段已就绪，但 ffmpeg 拼接失败，未产出成片';
        } else {
          filmNote = `真实成片未达成：${realClipNodes.length}/${runtime.clipCount} 个片段由 ComfyUI 真实生成，未产出 MP4（不拿关键帧预览冒充）`;
        }
      } else if (allReal) {
        film = stitchClips(realClipNodes.map((n) => n.data.clip), { clipSeconds: runtime.clipSeconds });
        filmNote = film ? `真实片段拼接成片（${film.method}）` : 'ffmpeg 拼接失败';
      } else {
        film = renderPreviewFilm(ctx.project, runtime);
        filmNote = film
          ? `关键帧预览成片（非 AI 视频）：${film.clips} 段 × ${runtime.clipSeconds}s = ${film.duration}s`
          : '本机 ffmpeg 不可用，未产出预览成片';
      }
      ctx.log('info', filmNote);
    } else {
      filmNote = outputMode === 'director-pack' ? '本次只导出导演包，成片由 ComfyUI 导演工作台生成' : '未开启片段拼接';
    }
    const filmReality = evaluateFilm({
      project: ctx.project, film, policy, clipCount: runtime.clipCount,
    });
    ctx.progress(0.8);
    if (outputMode !== 'video') {
      const pack = exportDirectorPack(ctx.project, cfg);
      directorPack = {
        url: pack.url, file: pack.file, filename: pack.filename, bytes: pack.bytes,
        target: pack.format, shotCount: pack.shotCount, fileCount: pack.fileCount,
        groups: pack.groups, note: pack.note,
        // 角色定妆入包明细：让「包里有几个角色、各带几张哪几个角度」在节点上就能核对，
        // 而不是下载 zip 解开才知道定妆到底进没进包
        characterCount: pack.characterCount || 0,
        characterRefs: pack.characterRefs || 0,
        characterSheets: pack.characterSheets || [],
        styleLock: pack.styleLock || '',
      };
      const charNote = pack.characterCount
        ? ` · ${pack.characterCount} 位角色 ${pack.characterRefs} 张定妆参考图`
        : ' · 尚无角色定妆图（每位角色只有文字描述）';
      ctx.log('info', `导演包已生成：${pack.filename} · ${pack.shotCount} 组镜头 · ${pack.fileCount} 个文件${charNote}`);
    }
    ctx.progress(0.95);
    const deliverables = {
      outputMode,
      filmPolicy: policy,
      video: film
        ? { url: film.url, file: film.file, clips: film.clips, method: film.method, bytes: film.bytes,
          source: film.source || null, isRealVideo: film.isRealVideo === true }
        : { clips: realClipNodes.length, note: filmNote, blocked: !film },
      directorPack: directorPack ? { url: directorPack.url, filename: directorPack.filename, bytes: directorPack.bytes } : null,
    };
    ctx.patch({
      timeline, duration, shotCount: timeline.length, poster: poster.url,
      runtime: {
        totalSeconds: runtime.totalSeconds, clipSeconds: runtime.clipSeconds,
        clipCount: runtime.clipCount, fps: runtime.fps,
        actualClipCount: timeline.length, actualTotalSeconds: duration,
      },
      film, directorPack, deliverables, outputMode,
      filmPolicy: policy, filmNote, filmReality,
      // 真实调用留痕：每个 ComfyUI 片段的 prompt_id 落盘，供对话记录与复刻指南引用
      comfyPromptIds: promptIds,
      cameraReport: camera?.data || null,
      report: {
        clips: timeline.length, anchors: ctx.project.edges.filter((e) => e.kind === 'anchor').length,
        refs: ctx.project.edges.filter((e) => e.kind === 'ref').length,
        cameras: camera?.data?.cameras?.length || 0,
        realClips: realClipNodes.length,
        filmPolicy: policy,
        filmSource: film?.source || null,
      },
      summary: `${timeline.length} 个片段 · ${duration}s · ${film ? (film.isRealVideo ? '真实 AI 成片已生成' : '关键帧预览成片（非 AI 视频）') : '未产出成片'}${directorPack ? ' · 导演包已导出' : ''}`,
    });
    ctx.log('info', `交付完成：产物模式 ${outputMode}${film ? (film.isRealVideo ? ' / ComfyUI 真实成片' : ' / 预览成片') : ' / 未产出成片'}${directorPack ? ' / 导演包' : ''}`);
  },
});
