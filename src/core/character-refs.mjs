/* ============================================================================
 * 角色参考图解析（Character References）
 *
 * 视频链路（关键帧 / 镜头片段 / 转场 / 导演包）需要的是「这个角色长什么样」的
 * 图像证据，而项目里这些证据散落在三个地方，过去各取一处、互相不知道对方存在：
 *   1) management.characters[].views  —— 角色管理面板生成的定妆多视图（最权威）
 *   2) 画布 character 节点的 portraitUrl —— 角色造型智能体产出的一张合图
 *   3) 资源库里同名的角色资产            —— 其他项目复用过来的定妆图
 * 结果：面板里精修过 5 张定妆图，视频却只拿画布节点那张早年的合图当参考，
 * 身份不一致问题「明明修了却还在」。
 *
 * 这里给出唯一入口 resolveCharacterRefs()，按优先级取图、按视图偏好排序、
 * 按张数上限截断，并把「每个角色实际用了几张、为什么用这几张」如实返回，
 * 让上层既能用对图，也能在日志/验收里说清楚。
 * ==========================================================================*/
import { CHARACTER_VIEWS, charNameKey } from './characters.mjs';

/**
 * 视图偏好：视频参考最需要的是「能对上脸」和「能对上转身角度」，
 * 因此正面 + 面部特写优先，3/4 侧次之，背面最后（背面信息量最低）。
 */
export const REF_VIEW_PRIORITY = ['front', 'closeup', 'threeQuarter', 'side', 'back'];

/** 每个角色默认最多给几张参考图（ComfyUI 多 LoadImage 插槽 + 视频模型 token 都有限） */
export const DEFAULT_REFS_PER_CHARACTER = 3;
/** 一次出图最多几张参考图（与 comfyui.normalizeRefs 的 8 张上限对齐） */
export const MAX_REFS_TOTAL = 8;

const viewLabel = (key) => CHARACTER_VIEWS.find((v) => v.key === key)?.label || key;

/** 从角色对象按视图偏好抽出可用参考图（含定妆板兜底） */
function viewsToRefs(character, limit = DEFAULT_REFS_PER_CHARACTER) {
  const out = [];
  for (const key of REF_VIEW_PRIORITY) {
    const url = character?.views?.[key]?.url;
    if (url) out.push({ url, view: key, label: viewLabel(key), source: 'management', slot: 'view' });
  }
  // 视图全缺时退到定妆板：至少保证「有图可比对」而不是纯文字
  if (!out.length && character?.sheet?.url) {
    out.push({ url: character.sheet.url, view: 'sheet', label: '定妆板', source: 'management', slot: 'sheet' });
  }
  return out.slice(0, Math.max(1, limit));
}

/** 画布 character 节点上的角色（旧链路：只有一张 portraitUrl 合图） */
function canvasCharacters(project) {
  const out = [];
  for (const n of project?.nodes || []) {
    if (n.type !== 'character' || !Array.isArray(n.data?.characters)) continue;
    for (const c of n.data.characters) {
      if (!c?.name) continue;
      out.push({
        name: c.name, role: c.role || '', appearance: c.appearance || '',
        refs: c.portraitUrl
          ? [{ url: c.portraitUrl, view: 'sheet', label: '三视图合图', source: 'canvas', slot: 'portrait' }]
          : [],
        origin: 'canvas',
      });
    }
  }
  return out;
}

/**
 * 解析用于视频 / 导演包的角色参考图。
 *
 * @param {object} project
 * @param {object} opts
 * @param {Array<string>} [opts.names]  只取这些角色（镜头出场角色），空 = 全部
 * @param {number} [opts.perCharacter]  每个角色最多几张（默认 3）
 * @param {number} [opts.maxTotal]      一次总共最多几张（默认 8，与 ComfyUI 插槽上限对齐）
 * @param {boolean} [opts.includeSheet] 是否允许把定妆板作为参考（默认仅在无视图时兜底）
 * @param {string[]} [opts.views]       只取这些视图 key（默认按偏好顺序全取）
 * @param {boolean} [opts.dedupe]       跨角色去重同一 URL（默认 true）
 * @returns {{characters:Array<{name,role,appearance,refs,origin,hasViews}>,
 *            urls:string[], perCharacter:number, truncated:boolean, notes:string[],
 *            stats:{characters:number, refs:number, fromManagement:number, fromCanvas:number}}}
 */
export function resolveCharacterRefs(project, opts = {}) {
  const {
    names = null, perCharacter = DEFAULT_REFS_PER_CHARACTER,
    maxTotal = MAX_REFS_TOTAL, includeSheet = false, views = null, dedupe = true,
  } = opts;
  const m = project?.management || {};
  const notes = [];
  const wanted = Array.isArray(names) && names.length
    ? new Set(names.map(charNameKey).filter(Boolean)) : null;
  const viewFilter = Array.isArray(views) && views.length ? new Set(views) : null;

  const list = [];
  const seenNames = new Set();

  // ① 管理面板的定妆多视图：最权威，优先取
  for (const c of (m.characters || [])) {
    if (!c?.name) continue;
    const key = charNameKey(c.name);
    if (wanted && !wanted.has(key)) continue;
    if (seenNames.has(key)) continue;
    let refs = viewsToRefs(c, perCharacter);
    if (viewFilter) refs = refs.filter((r) => viewFilter.has(r.view));
    // 指定视图都不存在时，定妆板仍是可用参考（除非调用方明确只允许指定视图）
    if (!refs.length && c.sheet?.url && (!viewFilter || includeSheet)) {
      refs = [{ url: c.sheet.url, view: 'sheet', label: '定妆板', source: 'management', slot: 'sheet' }];
    }
    seenNames.add(key);
    list.push({
      id: c.id || key, name: c.name, role: c.role || '',
      appearance: c.staticFeatures || c.appearance || c.viewPrompt || '',
      refs, origin: 'management', hasViews: refs.some((r) => r.view !== 'sheet'),
      styleLock: c.styleLock || '',
      palette: Array.isArray(c.palette) ? c.palette : [],
    });
  }

  // ② 画布 character 节点：管理面板没有对应角色时补位（老项目 / 标准流水线项目）
  for (const c of canvasCharacters(project)) {
    const key = charNameKey(c.name);
    if (wanted && !wanted.has(key)) continue;
    if (seenNames.has(key)) continue;
    let refs = c.refs;
    if (viewFilter) refs = refs.filter((r) => viewFilter.has(r.view));
    if (!refs.length) continue;
    seenNames.add(key);
    list.push({
      id: key, name: c.name, role: c.role, appearance: c.appearance,
      refs: refs.slice(0, perCharacter), origin: c.origin, hasViews: false,
    });
  }

  if (wanted) {
    const missing = [...wanted].filter((k) => !seenNames.has(k));
    if (missing.length) notes.push(`以下出场角色没有可用定妆图：${missing.join('、')}（将只按文字描述生成）`);
  }

  // ③ 汇总 + 去重 + 总量截断
  const urls = [];
  let truncated = false;
  for (const c of list) {
    const kept = [];
    for (const r of c.refs) {
      if (dedupe && urls.includes(r.url)) { kept.push({ ...r, shared: true }); continue; }
      if (urls.length >= maxTotal) { c.refs = kept; truncated = true; break; }
      urls.push(r.url);
      kept.push(r);
    }
    c.refs = kept;
  }
  if (truncated) notes.push(`参考图总数超过 ${maxTotal} 张上限，已按角色顺序截断（优先保留靠前角色的正面与面部参考）`);

  const fromManagement = list.filter((c) => c.origin === 'management').length;
  const fromCanvas = list.filter((c) => c.origin === 'canvas').length;
  return {
    characters: list,
    urls,
    perCharacter,
    truncated,
    notes,
    stats: {
      characters: list.length,
      refs: urls.length,
      fromManagement,
      fromCanvas,
      withoutRefs: list.filter((c) => !c.refs.length).length,
    },
  };
}

/**
 * 给「单个镜头出场角色」解析参考图：镜头只出现 1–3 人时，
 * 不要把全项目角色的参考图都塞进工作流的插槽（会挤掉首帧与锚点图）。
 */
export function resolveShotCharacterRefs(project, shotCharacters = [], opts = {}) {
  const names = (Array.isArray(shotCharacters) ? shotCharacters : [])
    .map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean);
  // 镜头没标注出场角色时退回全项目，保证至少能拿到身份参考
  const all = resolveCharacterRefs(project, { ...opts, names: names.length ? names : null });
  if (!names.length && all.characters.length > 3) {
    return {
      ...all,
      characters: all.characters.slice(0, 3),
      urls: all.characters.slice(0, 3).flatMap((c) => c.refs.map((r) => r.url)),
      notes: [...all.notes, '镜头未标注出场角色，已按全项目前 3 位角色的定妆图取参考'],
    };
  }
  return all;
}

/** 参考图摘要串（写进日志 / 导演包 manifest，便于人工核对用了哪几张） */
export function describeRefs(character) {
  if (!character?.refs?.length) return `${character?.name || '角色'}：无参考图（纯文字）`;
  const bits = character.refs.map((r) => r.label).join(' + ');
  return `${character.name}：${bits}`;
}

/** 参考图清单 → 导演包用的纯数据结构（只保留可序列化字段，不含内部 slot 语义） */
export function refsManifest(characters = []) {
  return (Array.isArray(characters) ? characters : []).map((c, i) => ({
    slot: i + 1, name: c.name, role: c.role || '',
    origin: c.origin || '', styleLock: c.styleLock || '',
    refs: (c.refs || []).map((r) => ({ url: r.url, view: r.view, label: r.label })),
  }));
}
