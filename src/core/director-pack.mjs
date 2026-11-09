// 导演包导出：把无限画布上的剧本 / 分镜 / 角色 / 关键帧，打包成可被 ComfyUI 导演工作台导入的结构
//
// 目标 A（默认，minimax-h3）：*.mmxpack.zip，遵循 ComfyUI_MiniMaxH3_Director 的导入规范：
//   pack.json / shared_params/shared_params.json / asset_groups/NN/group.json / timeline.json
//   format = "minimax-h3-director-pack"，formatVersion = 1，路径全部 ASCII
//   导入端 toolbar「Import pack」即可还原时间线、公共参考图、每组首帧与提示词
// 目标 B（generic）：通用 ComfyUI 包，manifest + shots.json + images/ + workflows/*.json
//
// 两种包都会额外携带 extra/（人可读分镜、来源信息、原始 API 工作流），不影响导演台读取。
import { createZip } from './zip.mjs';
import { placeholderFrame, characterViewFrame } from './raster.mjs';
import { readAsset, writeAssetBinary, uid } from './store.mjs';
import { resolveRuntimeSpec } from './runtime-spec.mjs';
import { resolveCharacterRefs, refsManifest, describeRefs } from './character-refs.mjs';

const PACK_FORMAT = 'minimax-h3-director-pack';
const PACK_VERSION = 1;

function asciiSlug(text = '') {
  return String(text).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
}

/**
 * 画布资产 URL → 可放进包的二进制（槽位只接受位图）。
 * 缺失 / 非位图时生成等价 PNG 占位：
 *  - 角色视图按 view 语义画成人形（正面/3-4 侧/侧面/背面/特写），保住「这是谁、哪个角度」
 *  - 其余（首帧 / 锚点 / 海报）用分镜占位帧
 * 旧实现把角色 SVG 也换成风景占位图，下游因此拿到与角色无关的参考图。
 */
function media(url, opts = {}) {
  const isCharacter = opts.kind === 'character' || opts.kind === 'character-view';
  const fallback = () => ({
    data: isCharacter
      ? characterViewFrame({
        view: opts.view || 'front', palette: opts.palette || [], style: opts.style,
        seed: opts.seed, label: opts.label || '',
      })
      : placeholderFrame(opts),
    ext: '.png', synthetic: true,
  });
  if (!url) return fallback();
  const m = String(url).match(/\/assets\/([A-Za-z0-9_.-]+)/);
  if (!m) return fallback();
  const buf = readAsset(m[1]);
  if (!buf) return fallback();
  const ext = (m[1].match(/\.[A-Za-z0-9]{1,6}$/) || ['.png'])[0].toLowerCase();
  // SVG 无法被导演台/ComfyUI 的图片槽位直接读取，按语义栅格化（而不是丢弃成风景图）
  if (ext === '.svg') return fallback();
  if (!/\.(png|jpe?g|webp|bmp)$/.test(ext)) return fallback();
  return { data: buf, ext, synthetic: false };
}

function incomingNode(project, nodeId, predicate) {
  return project.edges
    .filter((e) => e.to === nodeId)
    .map((e) => project.nodes.find((n) => n.id === e.from))
    .find((n) => n && (!predicate || predicate(n)));
}

/** 收集每个镜头组的完整制作信息 */
export function collectShotPackages(project) {
  const runtime = resolveRuntimeSpec(project);
  const videos = project.nodes.filter((n) => n.type === 'video' && n.data?.clip);
  const seq = (n) => Number(n.data?.sequence ?? n.data?.shot?.sequence ?? n.data?.shot?.shotNo ?? 0);
  videos.sort((a, b) => seq(a) - seq(b));
  const transitions = project.nodes.filter((n) => n.type === 'transition' && n.data?.transition?.url);
  return videos.map((n, i) => {
    const shot = n.data?.shot || {};
    const clip = n.data?.clip || {};
    const review = incomingNode(project, n.id, (x) => x.type === 'review');
    const shotNo = Number(shot.shotNo) || i + 1;
    const keyframeUrl = review?.data?.keyframeUrl || n.data?.poster || clip.poster || (n.data?.frames || [])[0] || null;
    const endUrl = transitions[i]?.data?.transition?.url || null;
    const prompt = [
      `镜头 ${shotNo}｜${shot.size || '中景'}｜${shot.angle || '平视'}｜${shot.movement || '固定'}`,
      shot.ffDesc || '',
      shot.motionDesc ? `动作与运镜：${shot.motionDesc}` : '',
      shot.audioDesc ? `声音设计：${shot.audioDesc}` : '',
      i > 0 ? '承接上一镜头的运动与光线，保持角色外观与空间关系连续' : '建立本场戏的空间与人物关系',
    ].filter(Boolean).join('。');
    return {
      index: i + 1, shotNo, nodeId: n.id,
      title: n.title || `镜头 ${shotNo}`,
      prompt, shot, clip, keyframeUrl, endUrl,
      duration: Number(n.data?.duration || clip.duration || shot.duration) || runtime.clipSeconds,
      realVideo: Boolean(clip.file && clip.provider === 'comfyui'),
    };
  });
}

/**
 * 收集导演包用的角色参考。
 *
 * 过去只扫画布 `character` 节点上的一张三视图合图，管理面板精修的 5 张定妆图
 * 完全没进包 —— 交接包里角色参考还是早期那张草图，下游导演台当然还原不出定妆。
 * 现在统一走 resolveCharacterRefs：管理面板定妆多视图优先，画布节点补位。
 */
function collectCharacters(project) {
  // 每个角色取最多 4 张（正面 / 面部特写 / 3/4 侧 / 侧面），导演台槽位仍是 3 个角色，
  // 多出来的视图作为同槽位的附加参考落盘，由 character_sheet.json 指明用法。
  const resolved = resolveCharacterRefs(project, { perCharacter: 4, maxTotal: 16 });
  return resolved.characters
    .filter((c) => c.refs.length || c.appearance)
    .slice(0, 3)
    .map((c, i) => ({
      name: c.name || `角色 ${i + 1}`,
      role: c.role || '',
      appearance: c.appearance || '',
      url: c.refs[0]?.url || null,
      refs: c.refs.map((r) => ({ url: r.url, view: r.view, label: r.label })),
      refCount: c.refs.length,
      refSummary: describeRefs(c),
      palette: c.palette || [],
      origin: c.origin, styleLock: c.styleLock || '',
      slot: i + 1,
    }));
}

/**
 * 把一个角色的多视图逐张落盘，返回该角色在包内的参考图清单。
 * 首张（最权威视图，通常为正面）写成 `{base}{ext}`（导演台槽位命名），
 * 其余角度写成 `{base}-{view}{ext}`，既保留工具链可识别的命名，
 * 又能让下游按 view 标签取到对应角度。
 */
function putCharacterViews(put, character, prefix, base) {
  const views = character.refs?.length
    ? character.refs
    : [{ url: character.url || null, view: 'sheet', label: '定妆图' }];
  const out = [];
  views.forEach((ref, i) => {
    const viewKey = ref.view || (i === 0 ? 'front' : `view${i + 1}`);
    const m = media(ref.url, {
      seed: `char-${character.name}-${viewKey}`, shotNo: character.slot || i + 1,
      style: character.styleLock || '', kind: 'character', view: viewKey,
      palette: character.palette || [], label: character.name,
    });
    const name = i === 0 ? `${base}${m.ext}` : `${base}-${viewKey}${m.ext}`;
    put(`${prefix}/${name}`, m.data);
    out.push({
      view: viewKey, label: ref.label || '', imageFile: `${prefix}/${name}`,
      fileName: name, synthetic: m.synthetic, primary: i === 0,
    });
  });
  return out;
}

function shotPromptExtra(project, characters, style) {
  const script = project.nodes.find((n) => n.type === 'script')?.data?.script;
  const parts = [
    `【全片一致性锁定】风格：${style || 'cinematic'}。`,
    script?.title ? `片名《${script.title}》，${script.genre || ''}。` : '',
    characters.length ? `角色设定：${characters.map((c) => `${c.name}（${c.appearance || c.role}）`).join('；')}。` : '',
    '要求：角色面部、发型、服装与配色跨镜头保持一致；不出现多余人物、变形手部、文字水印；镜头之间遵守 180 度轴线。',
  ];
  return parts.filter(Boolean).join('');
}

function buildMiniMaxEntries(project, cfg, ctx) {
  const { shots, characters, style, width, height, fps } = ctx;
  const negative = cfg.negativePrompt || '';
  const entries = [];
  const put = (name, data) => entries.push({ name, data });
  const putJSON = (name, obj) => put(name, JSON.stringify(obj, null, 2) + '\n');

  // ---- 公共参数：角色造型图占 Picture1..3 ----
  // 兼容性约束：导演台插件按 index 0/1/2 对应三个参考槽位，多塞条目会挤掉真实槽位，
  // 因此 shared_params.json 的 refs 仍严格 3 条（每个角色取最权威的一张），
  // 其余视图落盘到 shared_params/ 并以 characters 明细 + character_sheet.json 告知用法。
  const sharedRefs = [];
  const sharedCharacters = [];
  for (const c of characters) {
    const views = putCharacterViews(put, c, 'shared_params', `Picture${c.slot}`);
    c.viewFiles = views; // 回写：manifest / README / extra 都靠它说明包内到底有哪些图
    const primary = views[0];
    sharedRefs.push({
      index: c.slot - 1, imageFile: primary.imageFile, fileName: primary.fileName,
      type: 'input', subfolder: 'shared_params', character: c.name,
    });
    sharedCharacters.push({
      ...c,
      primaryView: primary.view,
      imageFile: primary.imageFile,
      viewFiles: views,
    });
  }
  const commonPrompt = shotPromptExtra(project, characters, style);
  const sharedJSON = {
    commonEnabled: true, commonCollapsed: false,
    prompt: commonPrompt,
    refs: sharedRefs, refAudios: [], refVideos: [],
    // 附加字段：导演台会原样保存，不会被误认成槽位
    characters: sharedCharacters.map((c) => ({
      slot: c.slot, name: c.name, role: c.role, primaryView: c.primaryView,
      imageFile: c.imageFile, viewFiles: c.viewFiles, refSummary: c.refSummary,
      styleLock: c.styleLock || '',
    })),
  };
  putJSON('shared_params/shared_params.json', sharedJSON);
  // 角色定妆参考清单：人可读 + 可程序化消费，明确「每个角色有哪几张视图、分别是什么角度」
  putJSON('shared_params/character_sheet.json', {
    format: 'lingximanju-character-sheet', version: 1,
    generatedAt: new Date().toISOString(),
    style, styleLock: characters[0]?.styleLock || '',
    note: '每个角色的多视图定妆参考。PictureN 为首选（正面）槽位图，PictureN-<view> 为同角色的其他角度。'
      + '把 PictureN 接到参考图槽位即可；需要更严格的身份约束时再追加同角色的特写/侧身图。',
    characters: refsManifest(sharedCharacters).map((c, i) => ({
      ...c, primaryView: sharedCharacters[i].primaryView,
      imageFile: sharedCharacters[i].imageFile,
      viewFiles: sharedCharacters[i].viewFiles,
    })),
  });

  // ---- 每个镜头一个素材组 ----
  const segments = [];
  const timelineShots = [];
  const groupSummaries = [];
  let cursor = 0;
  for (const s of shots) {
    const folder = `asset_groups/${String(s.index).padStart(2, '0')}`;
    const start = media(s.keyframeUrl, { seed: `shot-${s.shotNo}`, shotNo: s.shotNo, style, kind: 'start' });
    const startName = `start${start.ext}`;
    put(`${folder}/${startName}`, start.data);

    // 组内额外参考：上一镜头的转场锚点，槽位从 Picture4 续编（公共参数已占 1–3）
    const groupRefs = [];
    if (s.index > 1 && s.endUrl) {
      const m = media(s.endUrl, { seed: `anchor-${s.shotNo}`, shotNo: s.shotNo, style, kind: 'anchor' });
      const name = 'Picture4' + m.ext;
      put(`${folder}/${name}`, m.data);
      groupRefs.push({
        index: 3, imageFile: `${folder}/${name}`, fileName: name,
        type: 'input', subfolder: folder, note: '跨机位空间锚点 / 上一镜头尾帧',
      });
    }
    const frameCount = Math.max(25, Math.round(s.duration * fps));
    const startImage = { imageFile: `${folder}/${startName}`, width, height };
    const group = {
      id: `shot_${s.shotNo}`,
      prompt: s.prompt, negativePrompt: negative,
      durationSec: s.duration, frameCount, length: frameCount, start: cursor,
      taskType: '', refs: groupRefs, refAudios: [], refVideos: [],
      continuityFromPrev: s.index > 1, refImageSize: 'match',
      startImage, endImage: null,
      genImage: { imageFile: startImage.imageFile, fileName: startName },
      imageFile: startImage.imageFile,
    };
    putJSON(`${folder}/group.json`, group);
    segments.push(group);
    timelineShots.push({
      id: group.id, durationSec: s.duration, prompt: s.prompt, negativePrompt: negative,
      continuityFromPrev: group.continuityFromPrev, startImage, endImage: null,
    });
    groupSummaries.push({
      no: s.shotNo, title: s.title, duration: s.duration, frameCount,
      prompt: s.prompt, startFrame: startImage.imageFile,
      keyframeSynthetic: start.synthetic, hasAnchor: groupRefs.length > 0,
      realVideo: s.realVideo, clipFile: s.clip?.file || null, nodeId: s.nodeId,
    });
    cursor += frameCount;
  }

  const output = {
    mode: 'fixed', width, height, frameRate: fps,
    exportMode: 'all', audioMode: 'generate', refImageSize: 'match',
    continuityEnabled: shots.length > 1, continuityOverlapFrames: 22,
  };
  const taskType = 'fl2v';
  // 不写 widgets.task_type：导入端会依据 pack.taskType 自行换成界面所需的合法枚举值
  const packMeta = {
    format: PACK_FORMAT, formatVersion: PACK_VERSION, taskType,
    widgets: {
      steps: Number(cfg.steps) || 25, cfg: Number(cfg.cfg) || 1,
      seed: 0, sampler: 'res_multistep', scheduler: 'simple',
      shift_video: 12, shift_audio: 3,
    },
    output,
  };
  putJSON('pack.json', packMeta);

  const timeline = {
    version: 5, timelineMode: 'fl2v', editMode: 'segment',
    frameRate: fps, totalFrames: cursor || 124,
    global: {
      taskType, prompt: commonPrompt,
      commonEnabled: true, commonCollapsed: false,
      refs: sharedRefs, refAudios: [], refVideos: [],
      referenceVideo: {}, continuousReference: false,
    },
    output,
    segments: segments.length ? segments : [{ id: 'g0', start: 0, length: 124, frameCount: 124, prompt: '', refs: [], refAudios: [], refVideos: [], genImage: { imageFile: '' } }],
    shots: timelineShots, keyframes: [],
    video: { fileName: '', videoFile: '', subfolder: '', type: 'input', frames: [], frameMap: [] },
    videoClips: [], runSelectEnabled: false, runSelection: [],
  };
  putJSON('timeline.json', timeline);

  return { entries, groupSummaries, sharedRefs, output, taskType, totalFrames: cursor, commonPrompt };
}

function buildGenericEntries(project, cfg, ctx) {
  const { shots, characters, style } = ctx;
  const entries = [];
  const put = (name, data) => entries.push({ name, data });
  const putJSON = (name, obj) => put(name, JSON.stringify(obj, null, 2) + '\n');
  for (const c of characters) {
    const views = putCharacterViews(put, c, 'images', `char-${String(c.slot).padStart(2, '0')}`);
    c.genericFiles = views;
    c.viewFiles = views;
  }
  for (const s of shots) {
    const m = media(s.keyframeUrl, { seed: `shot-${s.shotNo}`, shotNo: s.shotNo, style, kind: 'start' });
    put(`images/shot-${String(s.index).padStart(2, '0')}-start${m.ext}`, m.data);
  }
  putJSON('shots.json', {
    format: 'lingximanju-comfyui-shots', version: 1,
    aspect: `${ctx.width}:${ctx.height}`, fps: ctx.fps,
    negativePrompt: cfg.negativePrompt || '',
    characters, shots: shots.map((s, i) => ({
      no: s.shotNo, title: s.title, duration: s.duration,
      prompt: s.prompt, shot: s.shot,
      startImage: `images/shot-${String(i + 1).padStart(2, '0')}-start.png`,
      clip: s.clip?.file || null,
    })),
  });
  for (const [key, label] of [['imageWorkflow', 'image'], ['videoWorkflow', 'video']]) {
    if (cfg[key]) putJSON(`workflows/${label}_api.json`, typeof cfg[key] === 'string' ? JSON.parse(cfg[key]) : cfg[key]);
  }
  return { entries, groupSummaries: shots.map((s, i) => ({ no: s.shotNo, title: s.title, duration: s.duration, startFrame: `images/shot-${String(i + 1).padStart(2, '0')}-start.png`, realVideo: s.realVideo })) };
}

/**
 * 生成导演包（内存），不落盘。
 * @returns {{filename:string, buffer:Buffer, meta:Object}}
 */
export function buildDirectorPack(project, cfg = {}) {
  const target = cfg.packTarget === 'generic' ? 'generic' : 'minimax-h3';
  const style = project.settings?.style || 'cinematic';
  const ctx = {
    shots: collectShotPackages(project),
    characters: collectCharacters(project),
    style,
    width: Number(cfg.width) || 864,
    height: Number(cfg.height) || 480,
    fps: Number(cfg.fps) || 24,
  };
  const extra = target === 'generic'
    ? buildGenericEntries(project, cfg, ctx)
    : buildMiniMaxEntries(project, cfg, ctx);

  const slug = asciiSlug(project.id || project.name || 'project');
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const filename = target === 'generic'
    ? `lingximanju-${slug}-${stamp}-comfyui-pack.zip`
    : `lingximanju-${slug}-${stamp}.mmxpack.zip`;

  const script = project.nodes.find((n) => n.type === 'script')?.data?.script || null;
  const manifest = {
    generator: 'lingximanju', format: target === 'generic' ? 'lingximanju-comfyui-pack' : PACK_FORMAT,
    formatVersion: PACK_VERSION, target, generatedAt: new Date().toISOString(),
    project: { id: project.id, name: project.name, mode: project.mode, style },
    script: script ? { title: script.title, genre: script.genre, logline: script.logline } : null,
    output: extra.output || { width: ctx.width, height: ctx.height, frameRate: ctx.fps },
    shotCount: ctx.shots.length,
    characterRefs: ctx.characters.reduce((n, c) => n + (c.refs?.length || 0), 0),
    characterCount: ctx.characters.length,
    // 角色定妆明细：哪些角色进了包、每个角色带了几张哪几个角度，验收时可核对
    characterSheets: refsManifest(ctx.characters).map((c, i) => ({
      ...c,
      primaryView: ctx.characters[i]?.refs?.[0]?.view || null,
      refSummary: ctx.characters[i]?.refSummary || '',
      files: ctx.characters[i]?.viewFiles || ctx.characters[i]?.genericFiles || [],
    })),
    styleLock: ctx.characters.find((c) => c.styleLock)?.styleLock || '',
    realVideoClips: ctx.shots.filter((s) => s.realVideo).length,
    groups: extra.groupSummaries,
    note: ctx.shots.some((s) => s.realVideo)
      ? '关键帧与视频片段来自本地 ComfyUI 实际输出。'
      : '当前为 Mock 模式：SVG 分镜已渲染为 PNG 占位槽位图；在设置里导入 ComfyUI 出图工作流后重新运行即可替换为真实画面。',
  };

  const entries = [...extra.entries];
  const charLines = ctx.characters.map((c) => {
    const views = (c.viewFiles || c.genericFiles || []).map((v) => v.fileName).join('、');
    return `- ${c.name}${c.role ? `（${c.role}）` : ''}：${views || '无定妆图，仅文字描述'}`;
  });
  const readme = [
    `# ${target === 'generic' ? 'lingximanju 通用 ComfyUI 导演包' : 'lingximanju → MiniMax H3 Director 导演包'}`,
    '',
    `- 项目：${project.name || '未命名'}`,
    `- 镜头组：${ctx.shots.length}　角色：${ctx.characters.length}（${manifest.characterRefs} 张定妆参考图）　输出：${ctx.width}×${ctx.height} @ ${ctx.fps}fps`,
    manifest.styleLock ? `- 风格锁定：${manifest.styleLock}` : '',
    charLines.length ? ['', '角色定妆参考：', ...charLines].join('\n') : '',
    '',
    target === 'generic' ? [
      '用法：',
      '1. 将 workflows/ 下的 *_api.json 拖入 ComfyUI 画布（这是「导出(API)」格式，可直接运行）。',
      '2. images/ 中为各镜头首帧与角色定妆图（`char-01.png` 为首选视图，`char-01-closeup.png`、`char-01-threeQuarter.png` 等同角色其他角度），可作为 LoadImage 节点输入。',
      '3. shots.json 提供每个镜头的提示词、景别、运镜与时长。',
    ].join('\n') : [
      '用法：',
      '1. 确认 ComfyUI ≥ 0.30.0，并已安装 AIMixer/ComfyUI_MiniMaxH3_Director 插件与官方 MiniMax H3 节点。',
      '2. 在导演台节点工具栏点击「Import pack / 导入导演包」，选择本 zip。',
      '3. 导入会覆盖当前节点时间轴（插件会先确认）；公共参考图、每组首帧与提示词会自动还原。',
      '4. 按 taskType fl2v 选用 fl2va UNET；如需参考图模式 r2v 请改用 ref2va UNET。',
      '',
      '目录：pack.json（格式与采样参数）、shared_params/（公共角色参考与一致性提示词，',
      'character_sheet.json 列出每个角色的多视图定妆明细：PictureN 为首选正面，PictureN-<view> 为其他角度）、',
      'asset_groups/NN/group.json（逐镜头提示词 / 首帧 / 时长）、timeline.json（无损时间线）、extra/（人可读分镜与原始工作流）。',
      '模型权重不包含在包内。',
    ].join('\n'),
    '',
    manifest.note,
    '',
    '本包由 lingximanju 无限画布智能体制片流水线生成，未复制任何第三方源码。',
    '',
  ].join('\n');

  if (target === 'minimax-h3') {
    entries.push({ name: 'extra/shots.json', data: JSON.stringify({
      format: 'lingximanju-shots', version: 1,
      shots: ctx.shots.map((s) => ({
        no: s.shotNo, title: s.title, duration: s.duration,
        prompt: s.prompt, shot: s.shot,
        keyframeUrl: s.keyframeUrl, endUrl: s.endUrl,
        clipFile: s.clip?.file || null, realVideo: s.realVideo,
      })),
      characters: refsManifest(ctx.characters).map((c, i) => ({
        ...c,
        appearance: ctx.characters[i]?.appearance || '',
        refSummary: ctx.characters[i]?.refSummary || '',
        primaryView: ctx.characters[i]?.refs?.[0]?.view || null,
        viewFiles: ctx.characters[i]?.viewFiles || [],
      })),
      styleLock: manifest.styleLock,
      script,
    }, null, 2) + '\n' });
    for (const [key, label] of [['imageWorkflow', 'image'], ['videoWorkflow', 'video']]) {
      if (!cfg[key]) continue;
      try {
        const wf = typeof cfg[key] === 'string' ? JSON.parse(cfg[key]) : cfg[key];
        entries.push({ name: `extra/comfyui_${label}_workflow_api.json`, data: JSON.stringify(wf, null, 2) + '\n' });
      } catch { /* 忽略无效工作流 */ }
    }
    const poster = media(project.nodes.find((n) => n.type === 'final')?.data?.poster, { style, kind: 'poster' });
    entries.push({ name: 'extra/poster.png', data: poster.ext === '.png' ? poster.data : placeholderFrame({ style, kind: 'poster' }) });
  } else {
    entries.push({ name: 'README.md', data: readme });
  }
  entries.push({ name: target === 'generic' ? 'manifest.json' : 'extra/manifest.json', data: JSON.stringify(manifest, null, 2) + '\n' });
  if (target === 'minimax-h3') entries.push({ name: 'extra/README.md', data: readme });

  const buffer = createZip(entries);
  return { filename, buffer, meta: { ...manifest, fileCount: entries.length, bytes: buffer.length } };
}

/** 生成并落盘，返回可在前端直接下载的 URL */
export function exportDirectorPack(project, cfg = {}) {
  const built = buildDirectorPack(project, cfg);
  const file = `${uid('pack')}.zip`;
  const url = writeAssetBinary(file, built.buffer);
  return {
    url, file, filename: built.filename,
    bytes: built.buffer.length, ...built.meta,
    downloadName: built.filename,
  };
}
