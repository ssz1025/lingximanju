/* ============================================================================
 * 剧集产物服务：单集剧本、每段宫格图、单集导演包、单集 ComfyUI 视频。
 *
 * 所有产物都回写 project.management.episodes[no-1]，由路由层 saveProject 落盘，
 * 与项目 JSON 全量覆盖写的既有约定保持一致。
 * ==========================================================================*/
import { createZip } from './zip.mjs';
import { placeholderFrame, characterViewFrame } from './raster.mjs';
import { storyboardGridSVG, gridShotList } from './grid-art.mjs';
import { resolveStoryboardSettings, describeStoryboardSettings, cellsOf, layoutOf } from './storyboard-settings.mjs';
import { readAsset, writeAsset, writeAssetBinary, uid } from './store.mjs';
import { createProviders } from './providers.mjs';
import { effectiveProjectSettings, resolveModelSettings } from './app-settings.mjs';
import { resolveRuntimeSpec } from './runtime-spec.mjs';
import { parseWorkflow } from './comfyui.mjs';
import { hasWorkflowFor, resolveInterface } from './comfy-config.mjs';
import { splitSegments, matchEpisodeCharacters, reconstructEpisodeText } from './episode-model.mjs';
import { resolveCharacterRefs, refsManifest, describeRefs } from './character-refs.mjs';
import { resolveFrameVisualPack, buildFramePrompts, blockingSVG } from './shot-visuals.mjs';
import { buildScriptVars, normalizeEpisodeScript, mergeScriptEdit } from './episode-script.mjs';
import { isRealImage, allowMockArtifacts } from './keyframe-status.mjs';

const cut = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const dateTag = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

/** 老项目没有持久化原文时按需还原并补齐分段 */
export function ensureEpisodeBody(project, ep) {
  if (!ep.text) ep.text = reconstructEpisodeText(project, ep) || cut(ep.summary, 600);
  if (!Array.isArray(ep.segments) || !ep.segments.length) ep.segments = splitSegments(ep.text, 6, ep.no);
  if (!Array.isArray(ep.characterIds)) ep.characterIds = matchEpisodeCharacters(ep, project.management?.characters || []);
  return ep;
}

/* ------------------------------ 单集剧本 ------------------------------ */
export async function generateEpisodeScript(project, m, ep, opts = {}) {
  ensureEpisodeBody(project, ep);
  const log = opts.log || (() => {});
  const providers = createProviders(resolveModelSettings(project, opts.modelId), log);
  // 上下文里带上一集结尾、本集钩子、下一集走向与时长预算：
  // 单集独立生成最容易出现「每集都像第一集」，这些字段让编剧智能体知道自己在整部剧的哪一格。
  const vars = buildScriptVars(project, m, ep, opts);
  let out;
  try {
    out = await providers.generate('screenplay', vars);
  } catch (err) {
    throw new Error(`剧本生成失败：${err.message}`);
  }
  const source = providers.mode === 'openai' && !out?.__fallback ? 'llm' : 'mock';
  const script = normalizeEpisodeScript(out, { project, m, ep, vars, source, provider: providers.mode });
  ep.script = script;
  ep.updatedAt = Date.now();
  return script;
}

/** 人工编辑保存：只覆盖可编辑字段，来源标记 manual，统计与质量告警重算 */
export function saveEpisodeScript(project, m, ep, patch = {}) {
  const script = mergeScriptEdit(ep.script, patch, { ep, m });
  ep.script = script;
  ep.updatedAt = Date.now();
  return script;
}

/* ------------------------------ 每段宫格图 ------------------------------ */
/** 把段落格子补齐 / 裁剪到当前版式的格子数：换版式不丢已有说明，只增删槽位 */
function fitCells(seg, count) {
  const prev = Array.isArray(seg.cells) ? seg.cells : [];
  return Array.from({ length: count }, (_, i) => (prev[i]
    ? { ...prev[i], no: i + 1 }
    : { no: i + 1, caption: `格 ${i + 1}`, prompt: '', url: '' }));
}

/**
 * 把真实分镜帧按段序填进格子：格子不只是「一张图」，还要带上这一镜的
 * 景别 / 机位 / 运动 / 时长 / 动作，分镜板才读得懂（行业标注惯例）。
 * offset 让每段从关键帧池的不同位置开始取样，避免每段宫格图都是同样前 N 镜。
 */
function applyFrames(cells, frames, offset) {
  if (!Array.isArray(frames) || !frames.length) return cells;
  cells.forEach((c, i) => {
    const f = frames[(((offset + i) % frames.length) + frames.length) % frames.length];
    if (!f) return;
    c.url = f.url;
    c.shotNo = f.shotNo ?? c.shotNo ?? null;
    c.size = f.size || c.size || '';
    c.angle = f.angle || c.angle || '';
    c.movement = f.movement || c.movement || '';
    c.spec = f.spec || [f.size, f.angle, f.movement].filter(Boolean).join(' · ');
    c.action = f.action || c.caption || '';
    c.duration = f.duration || c.duration || null;
    c.prompt = f.prompt || c.prompt || '';
    c.characters = f.characters || c.characters || [];
  });
  return cells;
}

/**
 * 为每一格补齐「视觉物料包」：站位图（新生成）、角色参考清单（多视图 / 妆照 /
 * 槽位用途）与精确提示词（首帧出图 + 图生视频）。宫格视图在分镜板 SVG 落盘后回填。
 * 纯确定性 SVG + 参考图解析，不烧 GPU；重排分镜板时每格都会重算一次。
 */
function attachCellVisuals({ project, cells, settings, style, segmentLabel }) {
  let blockings = 0;
  let promptsReady = 0;
  let refCount = 0;
  for (const c of cells) {
    const shot = {
      shotNo: c.shotNo, sequence: c.shotNo ?? c.no, size: c.size || '',
      angle: c.angle || '', movement: c.movement || '',
      characters: c.characters || [], ffDesc: c.action || c.caption || '',
      motionDesc: c.action || c.caption || '', duration: c.duration || null,
    };
    const visual = resolveFrameVisualPack(project, shot);
    const prompts = buildFramePrompts({ shot, visual, settings, style, duration: shot.duration });
    const svg = blockingSVG({
      label: `第 ${c.no}/${cells.length} 格`, shot,
      characters: visual.characters, aspect: settings.resolvedAspect, style,
      seed: `${segmentLabel}-${c.no}`,
    });
    c.blockingFile = `${uid('blocking')}.svg`;
    c.blockingUrl = writeAsset(c.blockingFile, svg);
    c.imagePrompt = prompts.imagePrompt;
    c.videoPrompt = prompts.videoPrompt;
    c.visual = {
      characters: visual.characters.map((ch) => ({
        name: ch.name, role: ch.role, missing: ch.missing,
        views: ch.refs.map((r) => ({ view: r.view, label: r.label, url: r.url })),
        sheet: ch.sheet?.url || null,
      })),
      slots: prompts.refSlots.map((s) => ({ slot: s.slot, label: s.label, url: s.url, usage: s.usage })),
      refNote: prompts.refNote,
      notes: visual.notes || [],
    };
    blockings += 1;
    if (c.videoPrompt) promptsReady += 1;
    refCount += visual.stats.total;
  }
  return { blockings, promptsReady, refCount };
}

/**
 * 为一段生成分镜板（版式由分镜画面设置决定，默认九宫格）。
 * opts.frames：真实分镜帧 [{url, shotNo, size, angle, movement, action, prompt}]，按顺序填格。
 * opts.keyframes：只给 URL 数组时的兼容入口。
 * opts.offset：从帧池第几张开始取（多段时由 generateEpisodeGrids 顺移）。
 * opts.mode='comfy' 时尝试用 ComfyUI 出图填满缺图的格子（慢，按需单段调用）。
 */
export async function generateSegmentGrid(project, m, ep, segmentNo, opts = {}) {
  ensureEpisodeBody(project, ep);
  const seg = (ep.segments || []).find((s) => Number(s.no) === Number(segmentNo));
  if (!seg) throw new Error(`第 ${segmentNo} 段不存在`);
  const style = project.settings?.style || 'cinematic';
  const settings = opts.settings || resolveStoryboardSettings(project);
  const layout = layoutOf(settings);
  const count = cellsOf(settings);
  const cells = fitCells(seg, count);
  const frames = Array.isArray(opts.frames) && opts.frames.length
    ? opts.frames
    : (Array.isArray(opts.keyframes) ? opts.keyframes.filter(Boolean).map((url) => ({ url })) : []);
  applyFrames(cells, frames, Number(opts.offset) || 0);
  // 只画示意：不引用真实图（改版式时快速预览用）
  if (settings.source === 'schematic') cells.forEach((c) => { c.url = ''; });
  if (opts.mode === 'comfy') {
    const cfg = opts.cfg || {};
    const providers = createProviders({
      ...effectiveProjectSettings(project),
      comfy: { ...cfg, enabled: true, outputMode: 'both' },
    }, opts.log || (() => {}));
    for (let i = 0; i < count; i += 1) {
      if (cells[i].url) continue;                     // 已有真实图不重复烧 GPU
      try {
        const img = await providers.image({
          kind: 'keyframe', label: `${ep.title} · ${seg.title} · 格 ${i + 1}`,
          interfaceId: String(cfg.requestInterfaceId || ''),
          prompt: cells[i].prompt || cells[i].caption,
          style, shotNo: i + 1, seed: `${project.id}-ep${ep.no}-seg${seg.no}-${i}`,
        });
        cells[i].url = img.url;
      } catch (err) {
        // 单格失败不阻断整张分镜板：其余格子仍可用占位渲染
        if (opts.log) opts.log('warn', `宫格 ${i + 1} 出图失败：${err.message}`);
      }
    }
  }

  // 每格视觉物料：站位图（新生成）+ 角色参考清单（多视图 / 妆照）+ 精确提示词。
  // 宫格视图（本段分镜板）在下方 SVG 落盘后回填到每格 cell.gridUrl。
  const visuals = attachCellVisuals({ project, cells, settings, style, segmentLabel: `ep${ep.no}-seg${seg.no}` });

  const svg = storyboardGridSVG({
    title: `第 ${ep.no} 集 · 第 ${seg.no} 段分镜板`,
    subtitle: `${ep.title}｜${seg.chars} 字 · ${(ep.chapters || []).map((c) => c.title).join(' / ') || '原著拆分'}`,
    cells, style, seed: `${project.id}-ep${ep.no}-seg${seg.no}`,
    settings,
    aspect: settings.resolvedAspect || (settings.aspect !== 'inherit' ? settings.aspect : undefined),
  });
  const file = `${uid('grid')}.svg`;
  const url = writeAsset(file, svg);
  // 宫格视图回填到每格：分镜画面的「图片证据」之一，下游（导演包 / 视频提示词）按格引用
  cells.forEach((c) => { c.gridUrl = url; });
  seg.cells = cells;
  seg.gridUrl = url;
  seg.gridFile = file;
  seg.gridLayout = settings.layout;
  seg.gridCells = count;
  seg.status = 'done';
  seg.updatedAt = Date.now();
  ep.updatedAt = Date.now();
  return {
    segment: seg, gridUrl: url, gridFile: file,
    realFrames: cells.filter((c) => c.url).length, cells: count, layout: layout.id,
    visuals,
  };
}

/**
 * 从画布抽取真实分镜帧（图片 + 镜头规格）。
 * 宫格图是「画面已定版」的汇总物料：mock 自绘 SVG 占位不能混进去冒充成果
 * （真实口径与第⑤步验收一致；离线测试夹具的项目例外，见 allowMockArtifacts）。
 */
export function collectProjectFrames(project) {
  const out = [];
  const seen = new Map();      // url → index，review 与 keyframe 常常同图，后到的规格更全
  const allowMock = allowMockArtifacts(project);
  for (const n of (project.nodes || [])) {
    if (!['review', 'keyframe', 'shot', 'transition'].includes(n.type)) continue;
    const u = n.data?.keyframeUrl || n.data?.poster || n.data?.candidates?.[0]?.url || n.data?.transition?.url;
    if (!u) continue;
    const chosen = (n.data?.candidates || []).find((c) => c?.url === u) || n.data?.candidates?.[0] || null;
    const provider = chosen?.provider || '';
    if (!isRealImage({ url: u, provider }, { allowMock })) continue;
    const shot = n.data?.shot || {};
    const frame = {
      url: u,
      shotNo: shot.shotNo ?? null,
      size: shot.size || '',
      angle: shot.angle || '',
      movement: shot.movement || '',
      duration: shot.duration || null,
      action: shot.ffDesc || n.data?.summary || '',
      prompt: chosen?.prompt || shot.ffDesc || '',
      characters: shot.characters || [],
    };
    if (seen.has(u)) {
      const idx = seen.get(u);
      out[idx] = { ...out[idx], ...frame, spec: [frame.size, frame.angle, frame.movement].filter(Boolean).join(' · ') };
      continue;
    }
    seen.set(u, out.length);
    out.push({ ...frame, spec: [frame.size, frame.angle, frame.movement].filter(Boolean).join(' · ') });
  }
  // 按镜头序号排序：宫格板要按剧情顺序读，而不是按节点创建顺序
  return out.sort((a, b) => {
    const sa = Number(a.shotNo);
    const sb = Number(b.shotNo);
    if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sa - sb;
    return 0;
  });
}

/** 只要 URL 的旧入口（导演包 / 兼容调用） */
export function collectProjectKeyframes(project) {
  return collectProjectFrames(project).map((f) => f.url);
}

export async function generateEpisodeGrids(project, m, ep, opts = {}) {
  ensureEpisodeBody(project, ep);
  const settings = opts.settings || resolveStoryboardSettings(project);
  const frames = opts.frames || collectProjectFrames(project);
  const count = cellsOf(settings);
  const results = [];
  const visuals = { blockings: 0, promptsReady: 0, refCount: 0 };
  // 每段 N 格：按段序在帧池里顺移取样，避免「每段宫格图都是同样前 N 镜」（N 由版式决定）
  const segs = ep.segments || [];
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    const r = await generateSegmentGrid(project, m, ep, seg.no, {
      frames, offset: i * count, settings, cfg: opts.cfg, log: opts.log,
      mode: opts.mode,
    });
    for (const k of Object.keys(visuals)) visuals[k] += r.visuals?.[k] || 0;
    results.push(r);
  }
  return {
    segments: ep.segments, generated: results.length,
    keyframeCount: frames.length, cells: count, layout: settings.layout,
    visuals,
  };
}

/**
 * 全项目按当前画面设置重排分镜板（纯 SVG 合成，不动关键帧、不烧 GPU）。
 * 保存版式 / 画幅 / 说明条设置后由业务智能体调用；步骤收尾也走这里。
 */
export async function regenerateProjectGrids(project, m, opts = {}) {
  const settings = opts.settings || resolveStoryboardSettings(project);
  const frames = opts.frames || collectProjectFrames(project);
  const out = {
    settings, frameCount: frames.length, grids: 0, episodes: 0, segments: 0,
    cells: cellsOf(settings), layout: settings.layout, description: describeStoryboardSettings(settings),
    visuals: { blockings: 0, promptsReady: 0, refCount: 0 },
  };
  for (const ep of (m?.episodes || [])) {
    try {
      const r = await generateEpisodeGrids(project, m, ep, { settings, frames, cfg: opts.cfg, log: opts.log });
      out.grids += r.generated || 0;
      out.segments += (ep.segments || []).length;
      out.episodes += 1;
      for (const k of Object.keys(out.visuals)) out.visuals[k] += r.visuals?.[k] || 0;
    } catch (err) {
      if (opts.log) opts.log('warn', `第 ${ep.no} 集分镜板生成失败：${err.message}`);
    }
  }
  return out;
}

/* ------------------------------ 单集导演包 ------------------------------ */
const ascii = (s = '') => String(s).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'project';

function imageEntry(url, opts) {
  if (url) {
    const m = String(url).match(/\/assets\/([A-Za-z0-9_.-]+)/);
    if (m) {
      const buf = readAsset(m[1]);
      if (buf && /\.(png|jpe?g|webp|bmp)$/i.test(m[1])) return buf;
    }
  }
  // 导演台槽位只收位图：角色槽位即使缺图也画成人物轮廓（而非风景），
  // 避免「空槽位」被下游误读成某个角色的定妆参考。
  if (opts?.kind === 'character') {
    return characterViewFrame({
      view: opts.view || 'front', palette: opts.palette || [], style: opts.style,
      seed: opts.seed || String(url || ''), label: opts.label || '',
    });
  }
  return placeholderFrame(opts);
}

/** 纯构建：只按「本集」的段落 / 宫格图 / 角色打包，不扫描全项目镜头 */
export function buildEpisodePack(project, m, ep, cfg = {}) {
  ensureEpisodeBody(project, ep);
  const style = project.settings?.style || 'cinematic';
  const entries = [];
  const put = (name, data) => entries.push({ name, data });
  const putJSON = (name, obj) => put(name, JSON.stringify(obj, null, 2) + '\n');
  const no = Number(ep.no) || 1;
  const chars = (m.characters || []).filter((c) => (ep.characterIds || []).includes(c.id)).slice(0, 3);
  const neg = cfg.negativePrompt || '';
  const width = Number(cfg.width) || 864;
  const height = Number(cfg.height) || 480;
  const fps = Number(cfg.fps) || 24;
  // 分镜板版式随包交接：下游按同一套格子数理解 shotCount 与 grids/*.svg
  const sheet = resolveStoryboardSettings(project);
  const cellsPerSeg = cellsOf(sheet);
  const sheetLayout = layoutOf(sheet);

  const groups = (ep.segments || []).map((seg, i) => {
    const groupNo = String(i + 1).padStart(2, '0');
    const shots = gridShotList(seg, no);
    const firstUrl = seg.cells?.find((c) => c.url)?.url || null;
    put(`asset_groups/${groupNo}/start.png`, imageEntry(firstUrl, { style, shotNo: i + 1, kind: 'episode-start' }));
    // 每格站位图入包：下游不用回源服务也能看到「谁站在哪、机位在哪」
    const blockingFiles = [];
    for (const c of (seg.cells || [])) {
      if (!c.blockingFile) continue;
      const buf = readAsset(c.blockingFile);
      if (buf) {
        const name = `blocking/segment_${groupNo}_cell_${String(c.no || blockingFiles.length + 1).padStart(2, '0')}.svg`;
        put(name, buf);
        blockingFiles.push({ cellNo: c.no || blockingFiles.length + 1, file: name });
      }
    }
    // 组提示词优先用第⑤步生成的精确图生视频提示词；老项目退回段落摘要
    const promptCell = (seg.cells || []).find((c) => c.videoPrompt);
    putJSON(`asset_groups/${groupNo}/group.json`, {
      group: i + 1, episodeNo: no, segmentNo: seg.no, title: seg.title,
      start_frame: 'start.png', shotCount: shots.length, shots,
      storyboard: {
        layout: sheetLayout.id, cols: sheetLayout.cols, rows: sheetLayout.rows,
        cells: cellsPerSeg, aspect: sheet.resolvedAspect,
      },
      grid: seg.gridFile ? `grids/segment_${groupNo}.svg` : null,
      blocking: blockingFiles,
      prompt: promptCell?.videoPrompt || `第 ${no} 集 · ${seg.title}｜${cut(seg.text, 120)}`,
      negative_prompt: neg, width, height, fps,
    });
    if (seg.gridFile) {
      const buf = readAsset(seg.gridFile);
      if (buf) put(`grids/segment_${groupNo}.svg`, buf);
    }
    return { group: i + 1, segmentNo: seg.no, title: seg.title, shotCount: shots.length, blockingCount: blockingFiles.length };
  });

  // 公共参考图：本集出场角色的多视图定妆（MiniMax H3 导演台 Picture1..3 槽位）
  // 槽位本身只有 3 个（index 0/1/2），所以每个槽位只放该角色最权威的一张（正面优先），
  // 其余视图作为同槽位附加参考落盘，并在 character_sheet.json 里指明角度与用法 ——
  // 旧实现只取 views.front 一张，中近景镜头没有面部参考，身份一样会漂。
  const episodeChars = chars.map((c, i) => {
    const one = resolveCharacterRefs(project, {
      names: [c.name], perCharacter: 4, maxTotal: 12, includeSheet: true,
    });
    const entry = one.characters[0];
    return {
      slot: i + 1, name: c.name, role: c.role || '', appearance: c.appearance || '',
      refs: entry?.refs?.length ? entry.refs : [],
      origin: entry?.origin || 'management', styleLock: c.styleLock || '',
      palette: Array.isArray(c.palette) ? c.palette : [],
      refSummary: entry ? describeRefs(entry) : `${c.name}：无定妆图（纯文字）`,
    };
  });

  const shared = [];
  for (let i = 0; i < 3; i += 1) {
    const c = episodeChars[i];
    const refs = c?.refs?.length
      ? c.refs
      : [{ url: null, view: 'front', label: '定妆图（缺失）' }];
    // 首张占公开槽位 PictureN.png；其余角度写 PictureN-<view>.png
    refs.forEach((ref, j) => {
      const viewKey = ref.view || (j === 0 ? 'front' : `view${j + 1}`);
      const name = j === 0 ? `Picture${i + 1}.png` : `Picture${i + 1}-${viewKey}.png`;
      const buf = imageEntry(ref.url, {
        style: project.settings?.style, kind: 'character', view: viewKey,
        palette: c?.palette, label: c?.name, seed: `ep${no}-char${i + 1}-${viewKey}`,
      });
      put(`shared_params/${name}`, buf);
    });
    if (c) {
      shared.push({
        slot: i + 1, name: c.name, role: c.role, appearance: c.appearance,
        primaryView: refs[0]?.view || 'front',
        imageFile: `shared_params/Picture${i + 1}.png`,
        viewFiles: refs.map((ref, j) => ({
          view: ref.view || 'front',
          label: ref.label || '',
          imageFile: `shared_params/${j === 0 ? `Picture${i + 1}.png` : `Picture${i + 1}-${ref.view || `view${j + 1}`}.png`}`,
          primary: j === 0,
        })),
        refSummary: c.refSummary,
      });
    } else {
      // 本集出场角色不足 3 位时仍占住槽位，避免导演台读到空 index
      shared.push({ slot: i + 1, name: '', role: '', placeholder: true });
    }
  }
  putJSON('shared_params/character_sheet.json', {
    format: 'lingximanju-character-sheet', version: 1,
    scope: 'episode', episodeNo: no, generatedAt: new Date().toISOString(),
    note: '本集出场角色的多视图定妆参考。PictureN 为首选（正面）槽位图，PictureN-<view> 为同角色其他角度。',
    characters: refsManifest(episodeChars.map((c) => ({
      ...c, refs: c.refs.length ? c.refs : [],
    }))).map((c, i) => ({
      ...c,
      primaryView: episodeChars[i]?.refs?.[0]?.view || null,
      imageFile: `shared_params/Picture${i + 1}.png`,
      refSummary: episodeChars[i]?.refSummary || '',
      viewFiles: episodeChars[i]?.refs?.map((ref, j) => ({
        view: ref.view, label: ref.label,
        imageFile: `shared_params/${j === 0 ? `Picture${i + 1}.png` : `Picture${i + 1}-${ref.view}.png`}`,
        primary: j === 0,
      })) || [],
    })),
  });
  putJSON('shared_params/shared_params.json', {
    style, negative_prompt: neg, width, height, fps,
    characters: shared, episodeNo: no,
  });
  putJSON('pack.json', {
    format: 'minimax-h3-director-pack', formatVersion: 1,
    title: `${m.bible?.title || project.name} · 第 ${no} 集`,
    episodeNo: no, episodeTitle: ep.title,
    scope: 'episode', source: 'lingximanju',
    storyboard: {
      layout: sheetLayout.id, cols: sheetLayout.cols, rows: sheetLayout.rows,
      cellsPerSegment: cellsPerSeg, aspect: sheet.resolvedAspect,
      description: describeStoryboardSettings(sheet),
    },
    createdAt: Date.now(), groups: groups.length,
  });
  // 单集导演包时间线与项目成片规格同源，不再写死 5s / start = i*5
  const runtime = resolveRuntimeSpec(project);
  putJSON('timeline.json', {
    episodeNo: no, fps,
    clipSeconds: runtime.clipSeconds,
    totalSeconds: Math.round(groups.length * runtime.clipSeconds * 100) / 100,
    groups: groups.map((g, i) => ({
      group: g.group, start: Math.round(i * runtime.clipSeconds * 100) / 100,
      duration: runtime.clipSeconds, segmentNo: g.segmentNo, title: g.title,
    })),
  });
  putJSON('extra/shots.json', (ep.segments || []).flatMap((seg) => gridShotList(seg, no)));
  put(`extra/episode.txt`, `第 ${no} 集 · ${ep.title}\n来源章节：${(ep.chapters || []).map((c) => c.title).join(' / ')}\n\n${ep.text || ''}\n`);
  putJSON('extra/script.json', ep.script || { episodeNo: no, note: '本集尚未生成剧本' });
  putJSON('extra/manifest.json', {
    project: project.name, projectId: project.id, episodeNo: no, episodeTitle: ep.title,
    scope: 'episode', groups, characters: shared.map((c) => c.name).filter(Boolean),
    characterSheets: shared.filter((c) => !c.placeholder).map((c) => ({
      slot: c.slot, name: c.name, primaryView: c.primaryView,
      imageFile: c.imageFile, viewFiles: c.viewFiles, refSummary: c.refSummary,
    })),
    characterRefs: shared.reduce((n, c) => n + (c.viewFiles?.length || 0), 0),
    segmentCount: (ep.segments || []).length, gridCount: (ep.segments || []).filter((s) => s.gridUrl).length,
    storyboardLayout: sheetLayout.id, cellsPerSegment: cellsPerSeg,
    hasScript: Boolean(ep.script), hasVideo: Boolean(ep.video),
    note: '本包只包含第 ' + no + ' 集内容；整项目导演包请用顶栏「▤ 导演包」。',
    generatedAt: Date.now(),
  });
  put('extra/README.md', [
    `# 第 ${no} 集导演包`, '',
    `- 项目：${project.name}`, `- 本集：${ep.title}`, `- 段落 / 分镜板：${(ep.segments || []).length} 组`,
    `- 分镜版式：${describeStoryboardSettings(sheet)}`,
    `- 每格物料：站位图入 blocking/（每格一张）；shots 里带首帧提示词 imagePrompt 与图生视频提示词 videoPrompt`,
    `- 出场角色：${shared.map((c) => c.name).join('、') || '未关联'}`, '',
    `asset_groups/NN/group.json 为每段 ${cellsPerSeg} 格分镜；grids/ 是可直接查看的 ${sheetLayout.cols}×${sheetLayout.rows} 分镜板；`,
    'extra/episode.txt 是本集拆分的原始内容，extra/script.json 是本集剧本。',
    '在 ComfyUI 导演工作台用「Import pack」导入 pack.json 即可还原时间线。', '',
  ].join('\n'));

  const filename = `lingximanju-${ascii(project.id)}-ep${no}-${dateTag()}.mmxpack.zip`;
  const buffer = createZip(entries);
  return {
    filename, buffer,
    meta: {
      episodeNo: no, shotCount: (ep.segments || []).length * cellsPerSeg,
      fileCount: entries.length, groups, bytes: buffer.length,
      target: 'minimax-h3', scope: 'episode',
      storyboard: { layout: sheetLayout.id, cellsPerSegment: cellsPerSeg, aspect: sheet.resolvedAspect },
    },
  };
}

export function exportEpisodePack(project, m, ep, cfg = {}) {
  const built = buildEpisodePack(project, m, ep, cfg);
  const file = `${uid('pack')}.zip`;
  const url = writeAssetBinary(file, built.buffer);
  return { url, file, filename: built.filename, bytes: built.buffer.length, ...built.meta, downloadName: built.filename };
}

/* ------------------------------ 单集 ComfyUI 视频 ------------------------------ */
/**
 * 真正调用本地 ComfyUI 视频工作流：以本集第一张宫格图为首帧、集摘要为运动提示词。
 * 未配置视频工作流时明确拒绝（不伪装成 Mock 成功），前端据此引导去设置里导入。
 */
export async function generateEpisodeVideo(project, m, ep, cfg = {}, opts = {}) {
  ensureEpisodeBody(project, ep);
  if (!cfg.enabled) throw new Error('本地 ComfyUI 未启用：设置 → 本地 ComfyUI 勾选「启用」');
  // 板块绑定优先：校验真正会被执行的那一份工作流，而不是只看全局镜像
  const videoWf = resolveInterface(cfg, { kind: 'video', scope: 'video' }).workflow;
  if (!hasWorkflowFor(cfg, 'video') || !videoWf) throw new Error('尚未导入视频工作流：设置 → 本地 ComfyUI → 导入视频工作流 JSON（导出 API 格式）');
  try { parseWorkflow(videoWf, '视频工作流'); }
  catch (err) { throw new Error(`视频工作流无效：${err.message}`); }

  const first = (ep.segments || []).find((s) => s.gridUrl)?.gridUrl
    || (ep.segments || [])[0]?.cells?.[0]?.url || '';
  // 优先用第⑤步为每格生成的精确图生视频提示词（含首帧锚定 / 运镜 / 角色一致性 /
  // 时长画幅 / 禁止项）；老项目没有这些字段时才退回集摘要的粗粒度提示词。
  const promptCell = (ep.segments || []).flatMap((s) => s.cells || []).find((c) => c.videoPrompt);
  const prompt = promptCell?.videoPrompt || [
    `第 ${ep.no} 集《${ep.title}》`,
    cut(ep.summary || ep.text, 160),
    `风格：${project.settings?.style || 'cinematic'}`,
    '保持角色外观与场景光线连续，镜头平稳推进，无文字水印',
  ].filter(Boolean).join('。');
  const log = opts.log || (() => {});
  const providers = createProviders({
    ...effectiveProjectSettings(project),
    comfy: { ...cfg, enabled: true, outputMode: 'video' },
  }, log);
  const duration = Math.max(3, Math.min(10, Number(opts.duration) || 5));
  const out = await providers.video({
    prompt, frames: [first], duration, shotNo: Number(ep.no) || 1,
    interfaceId: String(opts.interfaceId || cfg?.requestInterfaceId || ''),
    style: project.settings?.style || 'cinematic',
  });
  if (out.provider !== 'comfyui' || !out.url) {
    throw new Error('本地 ComfyUI 未返回视频片段：请检查视频工作流与 /system_stats 连通性，或在设置里关闭「失败回退 Mock」以查看原始报错');
  }
  const video = {
    url: out.url, file: out.file || String(out.url).split('/').pop(),
    poster: out.poster || first, prompt, promptId: out.promptId || '',
    durationMs: 0, duration, provider: 'comfyui', at: Date.now(),
  };
  ep.video = video;
  ep.updatedAt = Date.now();
  return video;
}
