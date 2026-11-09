/* ============================================================================
 * 剧集产物服务：单集剧本、每段宫格图、单集导演包、单集 ComfyUI 视频。
 *
 * 所有产物都回写 project.management.episodes[no-1]，由路由层 saveProject 落盘，
 * 与项目 JSON 全量覆盖写的既有约定保持一致。
 * ==========================================================================*/
import { createZip } from './zip.mjs';
import { placeholderFrame, characterViewFrame } from './raster.mjs';
import { storyboardGridSVG, gridShotList } from './grid-art.mjs';
import { readAsset, writeAsset, writeAssetBinary, uid } from './store.mjs';
import { createProviders } from './providers.mjs';
import { effectiveProjectSettings, resolveModelSettings } from './app-settings.mjs';
import { resolveRuntimeSpec } from './runtime-spec.mjs';
import { parseWorkflow } from './comfyui.mjs';
import { splitSegments, matchEpisodeCharacters, reconstructEpisodeText } from './episode-model.mjs';
import { resolveCharacterRefs, refsManifest, describeRefs } from './character-refs.mjs';

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
  const chars = (m.characters || []).filter((c) => (ep.characterIds || []).includes(c.id));
  const vars = {
    title: `${m.bible?.title || project.name} · 第 ${ep.no} 集`,
    episodeNo: ep.no, episodeTitle: ep.title,
    logline: ep.summary || m.bible?.logline || '',
    hook: ep.hook || '', genre: m.bible?.genre || '', style: project.settings?.style || 'cinematic',
    originalText: cut(ep.text, 4000),
    characters: chars.map((c) => ({ name: c.name, role: c.role, appearance: c.appearance })),
    chapters: (ep.chapters || []).map((c) => c.title),
  };
  let out;
  try {
    out = await providers.generate('screenplay', vars);
  } catch (err) {
    throw new Error(`剧本生成失败：${err.message}`);
  }
  const source = providers.mode === 'openai' && !out?.__fallback ? 'llm' : 'mock';
  const script = {
    episodeNo: ep.no,
    title: String(out?.title || vars.title).slice(0, 120),
    genre: String(out?.genre || vars.genre || '剧情').slice(0, 60),
    logline: String(out?.logline || vars.logline).slice(0, 300),
    style: String(out?.style || vars.style),
    characters: Array.isArray(out?.characters) ? out.characters.slice(0, 12) : chars.map((c) => ({ name: c.name, role: c.role, appearance: c.appearance })),
    scenes: (Array.isArray(out?.scenes) ? out.scenes : []).slice(0, 20).map((s, i) => ({
      id: s.id || `S${i + 1}`, location: s.location || '', time: s.time || '',
      summary: s.summary || '', script: Array.isArray(s.script) ? s.script.map(String) : [],
    })),
    source, provider: providers.mode, generatedAt: Date.now(),
  };
  // Mock 兜底时补一场以本集原文为依据的开场，保证「剧本」与本集内容一致而非通用模板
  if (source === 'mock' && !script.scenes.length) {
    script.scenes = [{
      id: 'S1', location: (ep.chapters || [])[0]?.title || '本集开场', time: '未指定',
      summary: cut(ep.summary, 120), script: ep.text.split(/\n+/).filter(Boolean).slice(0, 8).map((t) => cut(t, 160)),
    }];
  }
  ep.script = script;
  ep.updatedAt = Date.now();
  return script;
}

/* ------------------------------ 每段宫格图 ------------------------------ */
/**
 * 为一段生成 3×3 宫格图。
 * opts.keyframes：可传入真实关键帧 URL 数组，按顺序填进 9 个格子。
 * opts.mode='comfy' 时尝试用 ComfyUI 出图填满 9 格（慢，按需单段调用）。
 */
export async function generateSegmentGrid(project, m, ep, segmentNo, opts = {}) {
  ensureEpisodeBody(project, ep);
  const seg = (ep.segments || []).find((s) => Number(s.no) === Number(segmentNo));
  if (!seg) throw new Error(`第 ${segmentNo} 段不存在`);
  const style = project.settings?.style || 'cinematic';
  const cells = Array.from({ length: 9 }, (_, i) => ({ ...(seg.cells?.[i] || { no: i + 1, caption: `镜头 ${i + 1}` }) }));

  if (Array.isArray(opts.keyframes) && opts.keyframes.length) {
    const urls = opts.keyframes.filter(Boolean);
    cells.forEach((c, i) => { if (urls[i % urls.length]) c.url = urls[i % urls.length]; });
  } else if (opts.mode === 'comfy') {
    const cfg = opts.cfg || {};
    const providers = createProviders({
      ...effectiveProjectSettings(project),
      comfy: { ...cfg, enabled: true, outputMode: 'both' },
    }, opts.log || (() => {}));
    for (let i = 0; i < 9; i += 1) {
      try {
        const img = await providers.image({
          kind: 'keyframe', label: `${ep.title} · ${seg.title} · 格 ${i + 1}`,
          prompt: cells[i].prompt || cells[i].caption,
          style, shotNo: i + 1, seed: `${project.id}-ep${ep.no}-seg${seg.no}-${i}`,
        });
        cells[i].url = img.url;
      } catch (err) {
        // 单格失败不阻断整张宫格图：其余格子仍可用占位渲染
        if (opts.log) opts.log('warn', `宫格 ${i + 1} 出图失败：${err.message}`);
      }
    }
  }

  const svg = storyboardGridSVG({
    title: `第 ${ep.no} 集 · 第 ${seg.no} 段宫格图`,
    subtitle: `${ep.title}｜${seg.chars} 字 · ${(ep.chapters || []).map((c) => c.title).join(' / ') || '原著拆分'}`,
    cells, style, seed: `${project.id}-ep${ep.no}-seg${seg.no}`,
  });
  const file = `${uid('grid')}.svg`;
  const url = writeAsset(file, svg);
  seg.cells = cells;
  seg.gridUrl = url;
  seg.gridFile = file;
  seg.status = 'done';
  seg.updatedAt = Date.now();
  ep.updatedAt = Date.now();
  return { segment: seg, gridUrl: url, gridFile: file, realFrames: cells.filter((c) => c.url).length };
}

/** 一次生成本集所有段落的宫格图；从项目画布抽取已有关键帧按序复用 */
export function collectProjectKeyframes(project) {
  const out = [];
  for (const n of (project.nodes || [])) {
    if (['review', 'keyframe', 'shot', 'transition'].includes(n.type)) {
      const u = n.data?.keyframeUrl || n.data?.poster || n.data?.candidates?.[0]?.url || n.data?.transition?.url;
      if (u) out.push(u);
    }
  }
  return out;
}

export async function generateEpisodeGrids(project, m, ep, opts = {}) {
  ensureEpisodeBody(project, ep);
  const keyframes = opts.keyframes || collectProjectKeyframes(project);
  const results = [];
  for (const seg of ep.segments) {
    results.push(await generateSegmentGrid(project, m, ep, seg.no, { keyframes, cfg: opts.cfg, log: opts.log }));
  }
  return { segments: ep.segments, generated: results.length, keyframeCount: keyframes.length };
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

  const groups = (ep.segments || []).map((seg, i) => {
    const groupNo = String(i + 1).padStart(2, '0');
    const shots = gridShotList(seg, no);
    const firstUrl = seg.cells?.find((c) => c.url)?.url || null;
    put(`asset_groups/${groupNo}/start.png`, imageEntry(firstUrl, { style, shotNo: i + 1, kind: 'episode-start' }));
    putJSON(`asset_groups/${groupNo}/group.json`, {
      group: i + 1, episodeNo: no, segmentNo: seg.no, title: seg.title,
      start_frame: 'start.png', shotCount: shots.length, shots,
      prompt: `第 ${no} 集 · ${seg.title}｜${cut(seg.text, 120)}`,
      negative_prompt: neg, width, height, fps,
    });
    if (seg.gridFile) {
      const buf = readAsset(seg.gridFile);
      if (buf) put(`grids/segment_${groupNo}.svg`, buf);
    }
    return { group: i + 1, segmentNo: seg.no, title: seg.title, shotCount: shots.length };
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
    hasScript: Boolean(ep.script), hasVideo: Boolean(ep.video),
    note: '本包只包含第 ' + no + ' 集内容；整项目导演包请用顶栏「▤ 导演包」。',
    generatedAt: Date.now(),
  });
  put('extra/README.md', [
    `# 第 ${no} 集导演包`, '',
    `- 项目：${project.name}`, `- 本集：${ep.title}`, `- 段落 / 宫格图：${(ep.segments || []).length} 组`,
    `- 出场角色：${shared.map((c) => c.name).join('、') || '未关联'}`, '',
    'asset_groups/NN/group.json 为每段 9 格分镜；grids/ 是可直接查看的 3×3 宫格图；',
    'extra/episode.txt 是本集拆分的原始内容，extra/script.json 是本集剧本。',
    '在 ComfyUI 导演工作台用「Import pack」导入 pack.json 即可还原时间线。', '',
  ].join('\n'));

  const filename = `lingximanju-${ascii(project.id)}-ep${no}-${dateTag()}.mmxpack.zip`;
  const buffer = createZip(entries);
  return {
    filename, buffer,
    meta: {
      episodeNo: no, shotCount: (ep.segments || []).length * 9,
      fileCount: entries.length, groups, bytes: buffer.length,
      target: 'minimax-h3', scope: 'episode',
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
  if (!cfg.videoWorkflow) throw new Error('尚未导入视频工作流：设置 → 本地 ComfyUI → 导入视频工作流 JSON（导出 API 格式）');
  try { parseWorkflow(cfg.videoWorkflow, '视频工作流'); }
  catch (err) { throw new Error(`视频工作流无效：${err.message}`); }

  const first = (ep.segments || []).find((s) => s.gridUrl)?.gridUrl
    || (ep.segments || [])[0]?.cells?.[0]?.url || '';
  const prompt = [
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
