/* ============================================================================
 * 分镜画面视觉物料（Shot Visuals）· 纯逻辑 + 确定性 SVG，无网络依赖
 *
 * 目标：让「每一个分镜画面」不再是孤零零一张图 + 一行文字，而是一个完整的
 * 视觉物料包 + 精确提示词，供「多参考图 + 文 → 出图 / 图生视频」直接消费：
 *
 *   · 角色图片 / 多视图 / 妆照 —— 出场角色的定妆证据（管理面板多视图最权威，
 *     画布节点与资源库兜底），逐张标明「哪一槽位、哪个角度、用来锁什么」；
 *   · 宫格视图 —— 该画面所在段的分镜板（episode-service 生成后回填 gridUrl）；
 *   · 站位图 —— 新生成的确定性 SVG：取景框 + 机位 + 出场角色站位与景别，
 *     让「谁站在哪、镜头多远」在出图前就能对齐（俯视站位是分镜行业惯例）；
 *   · 精确提示词 —— buildFramePrompts() 按分镜画面设置的提示词公式开关，
 *     拼出首帧出图提示词（imagePrompt）与图生视频提示词（videoPrompt），
 *     并输出参考图槽位清单（refSlots），提示词里逐槽位写明每张图的用途，
 *     杜绝「参考图扔进去但模型不知道哪张是谁」。
 *
 * 本文件不做 IO：SVG 由调用方（episode-service / storyboard-agent）落盘。
 * ==========================================================================*/
import { resolveShotCharacterRefs, describeRefs } from './character-refs.mjs';
import { aspectLabel, framePromptNote, layoutOf, panelIndexOf } from './storyboard-settings.mjs';

const esc = (s = '') => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const cut = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

function hash(str = '') {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** 画幅解析：resolvedAspect 优先，其次显式 aspect，'inherit'/缺失回落横屏 16:9 */
function settings_aspect(settings = {}) {
  if (settings.resolvedAspect) return settings.resolvedAspect;
  if (settings.aspect && settings.aspect !== 'inherit') return settings.aspect;
  return '16:9';
}

/* ------------------------------ 视觉物料包 ------------------------------ */

/** 管理面板里按名字找角色（拿妆照 sheet 与调色板；refs 口径仍走 character-refs） */
function managementCharacter(project, name) {
  const key = String(name || '').replace(/[\s《》「」『』"'·]/g, '').toLowerCase();
  return (project?.management?.characters || []).find((c) => (
    String(c?.name || '').replace(/[\s《》「」『』"'·]/g, '').toLowerCase() === key
  )) || null;
}

/**
 * 解析「单个分镜画面」的视觉物料包。
 *
 * @param {object} project
 * @param {object} shot 镜头 / 格数据：{characters:[名称], size, angle, movement, ...}
 * @param {object} [opts] 透传 resolveShotCharacterRefs（perCharacter / maxTotal 等）
 * @returns {{
 *   characters: Array<{name, role, refs, sheet, palette, missing}>,
 *   viewUrls: string[], sheetUrls: string[], urls: string[],
 *   slots: Array<{slot, url, label, kind, character, view, usage}>,
 *   notes: string[], stats: {characters, viewRefs, sheetRefs, total},
 *   summary: string,
 * }}
 * slots 即 ComfyUI LoadImage 槽位清单：前 N 张是角色参考（多视图 + 妆照），
 * 首帧 / 宫格视图 / 站位图属于「上下文参考」，由工作流的图像插槽各自消费。
 */
export function resolveFrameVisualPack(project, shot = {}, opts = {}) {
  const names = (Array.isArray(shot.characters) ? shot.characters : [])
    .map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean);
  const resolved = resolveShotCharacterRefs(project, names, {
    perCharacter: 3, maxTotal: 8, includeSheet: true, ...opts,
  });
  const characters = [];
  const slots = [];
  const seen = new Set();
  let slotNo = 0;
  for (const c of resolved.characters) {
    const raw = managementCharacter(project, c.name);
    const sheetUrl = raw?.sheet?.url || null;
    const entry = {
      name: c.name, role: c.role || '',
      refs: (c.refs || []).map((r) => ({ ...r })),
      sheet: sheetUrl ? { url: sheetUrl, label: '妆照 / 定妆板' } : null,
      palette: Array.isArray(c.palette) && c.palette.length ? c.palette : (Array.isArray(raw?.palette) ? raw.palette : []),
      missing: !(c.refs || []).length && !sheetUrl,
    };
    // 多视图逐张进槽位：每张都写明「锁什么」——正面锁身份、特写锁五官、侧身锁转身
    for (const r of entry.refs) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      slotNo += 1;
      const usage = r.view === 'closeup' ? '锁定五官与妆容'
        : r.view === 'front' ? '锁定身份与服装基准'
          : r.view === 'back' ? '锁定背影与发型轮廓'
            : '锁定转身角度与体型比例';
      slots.push({ slot: slotNo, url: r.url, label: `${entry.name}·${r.label}`, kind: 'view', character: entry.name, view: r.view, usage });
    }
    // 妆照单独排：整板信息量最大，兜底身份（有视图时排在最后，作为补充而非主参考）
    if (entry.sheet && !seen.has(entry.sheet.url)) {
      seen.add(entry.sheet.url);
      slotNo += 1;
      slots.push({ slot: slotNo, url: entry.sheet.url, label: `${entry.name}·妆照`, kind: 'sheet', character: entry.name, view: 'sheet', usage: '整板定妆对照，兜底服装与配色' });
    }
    characters.push(entry);
  }
  const missing = characters.filter((c) => c.missing).map((c) => c.name);
  const notes = [...resolved.notes];
  // 与 ComfyUI LoadImage 插槽上限（8）对齐：超出部分如实记录，不静默丢图
  if (slots.length > 8) {
    notes.push(`参考图槽位超过 8 张上限，只保留前 8 张（${slots.slice(8).map((s) => s.label).join('、')} 未入槽）`);
    slots.length = 8;
  }
  if (missing.length) notes.push(`以下出场角色没有任何定妆证据（多视图与妆照皆缺）：${missing.join('、')}，将只按文字外观描述出图`);
  const viewUrls = slots.filter((s) => s.kind === 'view').map((s) => s.url);
  const sheetUrls = slots.filter((s) => s.kind === 'sheet').map((s) => s.url);
  return {
    characters,
    viewUrls,
    sheetUrls,
    urls: slots.map((s) => s.url),
    slots,
    notes,
    stats: {
      characters: characters.length,
      viewRefs: viewUrls.length,
      sheetRefs: sheetUrls.length,
      total: slots.length,
    },
    summary: characters.length
      ? characters.map((c) => describeRefs({ name: c.name, refs: c.refs })).join('｜')
      : '本镜没有标注出场角色',
  };
}

/* ------------------------------ 站位图（blocking diagram） ------------------------------ */

const BLOCKING_SIZE = { '16:9': [720, 405], '9:16': [405, 720], '1:1': [540, 540], '4:3': [640, 480] };

/** 站位槽位：1 人居中，2 人左中右里挑两侧，3-4 人均分；都避开取景框边缘 */
const BLOCKING_SLOTS = {
  1: [0.50],
  2: [0.34, 0.64],
  3: [0.26, 0.50, 0.74],
  4: [0.20, 0.40, 0.60, 0.80],
};

/** 景别 → 人物在取景框里的身高占比（特写几乎占满、远景只占一小截） */
const SIZE_SCALE = [
  [/特写|面部/, 0.86],
  [/近景/, 0.62],
  [/中景|中近/, 0.42],
  [/全景|中远/, 0.26],
  [/远景|大远景|航拍|俯瞰/, 0.14],
];

/** 运动关键词 → 机位箭头方向（站位图上直接画出来，不用再脑补） */
function movementArrow(movement = '') {
  if (/推|前/.test(movement)) return { dx: 0, dy: -34, label: '推进' };
  if (/拉|后|退/.test(movement)) return { dx: 0, dy: 34, label: '后拉' };
  if (/左/.test(movement)) return { dx: -34, dy: 0, label: '左移' };
  if (/右/.test(movement)) return { dx: 34, dy: 0, label: '右移' };
  if (/摇|移|跟|环绕/.test(movement)) return { dx: 26, dy: -12, label: '运镜' };
  return { dx: 0, dy: 0, label: '固定' };
}

function personSVG(cx, baseY, height, color, name, fontSize, index) {
  const headR = Math.max(5, height * 0.11);
  const headY = baseY - height + headR;
  const shoulder = baseY - height + headR * 2.6;
  const parts = [];
  parts.push(`<circle cx="${cx.toFixed(1)}" cy="${headY.toFixed(1)}" r="${headR.toFixed(1)}" fill="${color}"/>`);
  parts.push(`<path d="M${(cx - headR * 1.5).toFixed(1)} ${baseY.toFixed(1)} Q${cx.toFixed(1)} ${(shoulder - headR * 1.2).toFixed(1)} ${(cx + headR * 1.5).toFixed(1)} ${baseY.toFixed(1)} Z" fill="${color}" fill-opacity="0.9"/>`);
  parts.push(`<rect x="${(cx - headR - 2).toFixed(1)}" y="${(baseY + 3).toFixed(1)}" width="${((headR + 2) * 2).toFixed(1)}" height="${Math.max(12, fontSize + 6)}" rx="4" fill="${color}" fill-opacity="0.92"/>`);
  parts.push(`<text x="${cx.toFixed(1)}" y="${(baseY + 3 + Math.max(12, fontSize + 6) / 2 + 4).toFixed(1)}" text-anchor="middle" font-size="${fontSize}" font-weight="600" fill="#10151d" font-family="sans-serif">${esc(cut(name || `主体${index + 1}`, 8))}</text>`);
  return parts.join('');
}

/**
 * 生成一个分镜画面的站位图（确定性 SVG）。
 *
 * 画面内容：取景框（按成片画幅）+ 三分线 + 地平线 + 底部机位标记（含运动箭头）
 * + 出场角色站位（人数 1–4，超过 4 人合并为「群体」）+ 底部图例（角色 / 景别机位运动）。
 * 无角色信息时画一个「主体」占位站位，保证每个格子都有站位图可看。
 *
 * @param {object} o {label, shot:{size,angle,movement,characters,sequence,shotNo}, characters:[{name,palette}], aspect, style, seed}
 * @returns {string} SVG 字符串
 */
export function blockingSVG(o = {}) {
  const shot = o.shot || {};
  const aspect = BLOCKING_SIZE[o.aspect] ? o.aspect : '16:9';
  const [W, H] = BLOCKING_SIZE[aspect];
  const seed = o.seed || o.label || 'blocking';
  const colors = {
    cinematic: ['#f4b268', '#8b9bff', '#7fd8a8', '#e88aa4'],
    noir: ['#ff9a5c', '#7c8aa5', '#b8c4d8', '#d8b26a'],
    anime: ['#ffb2c4', '#9fc7ff', '#b7f0d8', '#e6c9ff'],
    watercolor: ['#e2cea4', '#b7d3c4', '#d8b2b2', '#a4c8e2'],
  };
  const palette = colors[o.style] || colors.cinematic;
  const chars = (Array.isArray(o.characters) && o.characters.length
    ? o.characters.map((c) => (typeof c === 'string' ? { name: c } : c)).filter((c) => c?.name)
    : [{ name: '主体' }]).slice(0, 4);
  const groupNote = (Array.isArray(shot.characters) ? shot.characters.length : chars.length) > 4 ? ' + 群众' : '';
  const xs = BLOCKING_SLOTS[chars.length] || BLOCKING_SLOTS[4];
  const size = String(shot.size || '中景');
  const scale = (SIZE_SCALE.find(([re]) => re.test(size)) || [null, 0.42])[1];
  const specText = [shot.size, shot.angle, shot.movement].filter(Boolean).join(' · ') || '中景 · 平视 · 固定';
  const arrow = movementArrow(shot.movement || '');
  const margin = 30;
  const baseY = H - 64;
  const maxH = (H - 120) * 0.72;
  const fs = Math.max(11, Math.min(15, Math.round(W / 44)));
  const parts = [];

  parts.push(`<defs><linearGradient id="bgd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#131c2a"/><stop offset="1" stop-color="#1e3048"/></linearGradient></defs>`);
  parts.push(`<rect width="${W}" height="${H}" fill="url(#bgd)"/>`);
  // 取景框 + 三分线 + 地平线
  parts.push(`<rect x="${margin}" y="${margin}" width="${W - margin * 2}" height="${H - margin * 2 - 46}" rx="10" fill="none" stroke="#f4b268" stroke-opacity="0.55" stroke-width="1.5"/>`);
  for (const f of [1 / 3, 2 / 3]) {
    parts.push(`<line x1="${margin + (W - margin * 2) * f}" y1="${margin}" x2="${margin + (W - margin * 2) * f}" y2="${H - margin - 46}" stroke="#f4b268" stroke-opacity="0.14"/>`);
    parts.push(`<line x1="${margin}" y1="${margin + (H - margin * 2 - 46) * f}" x2="${W - margin}" y2="${margin + (H - margin * 2 - 46) * f}" stroke="#f4b268" stroke-opacity="0.14"/>`);
  }
  parts.push(`<line x1="${margin}" y1="${baseY}" x2="${W - margin}" y2="${baseY}" stroke="#8fa0b8" stroke-opacity="0.5" stroke-dasharray="6 5"/>`);

  // 出场角色站位：确定性微扰，同一格每次重排站位不跳变
  chars.forEach((c, i) => {
    const jitter = ((hash(`${seed}-${c.name}`) % 60) - 30) / 1000;
    const cx = margin + (W - margin * 2) * Math.min(0.92, Math.max(0.08, xs[i] + jitter));
    const h = maxH * scale * (0.9 + ((hash(`${seed}-h${i}`) % 20) / 100));
    const color = (c.palette && c.palette[0]) || palette[i % palette.length];
    parts.push(personSVG(cx, baseY, h, color, c.name, fs, i));
  });

  // 机位标记 + 运动箭头（底部中央）
  const camX = W / 2;
  const camY = H - margin - 26;
  parts.push(`<polygon points="${camX - 10},${camY + 8} ${camX + 10},${camY + 8} ${camX},${camY - 8}" fill="#eef3fb"/>`);
  parts.push(`<circle cx="${camX}" cy="${camY + 12}" r="4" fill="#eef3fb"/>`);
  if (arrow.dx || arrow.dy) {
    parts.push(`<line x1="${camX}" y1="${camY - 12}" x2="${camX + arrow.dx}" y2="${camY - 12 + arrow.dy}" stroke="#f4b268" stroke-width="2" marker-end="url(#arr)"/>`);
    parts.push(`<defs><marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 Z" fill="#f4b268"/></marker></defs>`);
  }
  parts.push(`<text x="${camX}" y="${camY + 30}" text-anchor="middle" font-size="${fs}" fill="#c3cede" font-family="sans-serif">机位 · ${esc(shot.angle || '平视')} · ${esc(arrow.label)}</text>`);

  // 图例条
  parts.push(`<rect x="${margin}" y="${H - 40}" width="${W - margin * 2}" height="26" rx="6" fill="#0c1420" opacity="0.85"/>`);
  parts.push(`<text x="${margin + 10}" y="${H - 22}" font-size="${fs}" fill="#eef3fb" font-family="sans-serif">${esc(cut(`${chars.map((c) => c.name).join('、')}${groupNote} ｜ ${specText}`, Math.floor((W - margin * 2) / (fs * 0.62))))}</text>`);
  parts.push(`<text x="${W - margin - 8}" y="${margin + 18}" text-anchor="end" font-size="${fs}" fill="#f4b268" fill-opacity="0.9" font-family="sans-serif">站位图${o.label ? ` · ${esc(cut(o.label, 16))}` : ''}</text>`);
  parts.push(`<text x="${margin + 8}" y="${margin + 18}" font-size="${fs}" fill="#8fa0b8" font-family="sans-serif">${esc(aspectLabel(aspect))}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
}

/* ------------------------------ 精确提示词 ------------------------------ */

/**
 * 按「分镜画面设置的提示词公式」为单个分镜画面拼出精确提示词。
 *
 * 与 visual.mjs 关键帧智能体的旧拼接相比，本函数补齐了任务要求的三件事：
 *   1) 参考图逐槽位写明用途（哪张锁身份、哪张锁转身、哪张是妆照兜底），
 *      多参考图出图 / 出视频时模型不再「有图但不知道哪张是谁」；
 *   2) 图生视频提示词（videoPrompt）独立成段：首帧锚定 + 运动运镜 + 角色一致性
 *      + 时长画幅 + 禁止项，供第⑥步逐镜头直接投喂；
 *   3) 站位图 / 宫格视图作为上下文参考写进 refPlan，出图提示词明确要求
 *      「按站位图的相对位置安排人物」。
 *
 * @param {object} o {shot, visual(resolveFrameVisualPack 的结果), settings(分镜画面设置), style, styleLabel, negative, duration}
 * @returns {{imagePrompt, videoPrompt, refSlots, refPlan, refNote, lines:{spec,char,ref,style,continuity,frame,motion}}}
 */
export function buildFramePrompts(o = {}) {
  const shot = o.shot || {};
  // resolvedAspect 缺失时由显式画幅推导（'inherit' 没有 project 上下文无法解析，回落横屏）；
  // framePromptNote 只认 resolvedAspect，不兜底会整段写成默认横屏。
  const resolvedAspect = settings_aspect(o.settings);
  const settings = { ...(o.settings || {}), resolvedAspect };
  const parts = settings.prompt || { spec: true, character: true, style: true, continuity: true, aspect: true };
  const visual = o.visual || { slots: [], characters: [], stats: { total: 0 } };
  const seq = Number(shot.sequence ?? shot.shotNo) || 1;
  const layout = layoutOf(settings);
  const panel = panelIndexOf(settings, seq);
  const duration = Number(shot.duration) || Number(o.duration) || null;

  const specLine = parts.spec !== false
    ? `镜头规格：${[shot.size, shot.angle, shot.movement].filter(Boolean).join(' · ') || '中景 · 平视 · 固定'}`
    : '';
  const charBits = (visual.characters || []).map((c) => {
    const views = (c.refs || []).map((r) => r.label).join('/');
    return `${c.name}${c.role ? `（${c.role}）` : ''}${views ? `［参考：${views}${c.sheet ? ' + 妆照' : ''}］` : '［无定妆图，按文字外观］'}`;
  });
  const charLine = parts.character !== false && charBits.length
    ? `出场角色：${charBits.join('；')}（严格保持定妆身份、发型服装与配色不变）`
    : '';
  const refBits = (visual.slots || []).slice(0, 8)
    .map((s) => `参考图槽位${s.slot}＝${s.label}（${s.usage}）`);
  const refLine = refBits.length
    ? `${refBits.join('；')}。人物面部、发型、服装以参考图为准，不得新增装饰`
    : '无角色参考图槽位：按出场角色的文字外观描述出图，全片保持同一外观';
  const styleText = [o.styleLabel, o.style].filter(Boolean).join(' · ');
  const styleLine = parts.style !== false && styleText ? `风格锚点：${styleText}` : '';
  const continuityLine = parts.continuity !== false
    ? '空间连续性：与上一镜保持机位轴线、光线方向、场景陈设与角色外观一致'
    : '';
  const frameLine = parts.aspect !== false ? framePromptNote(settings, { sequence: seq }) : '';
  const subject = shot.ffDesc || shot.action || shot.caption || '按剧本动作呈现画面';
  const blockingLine = '构图按站位图安排：人物相对位置与远近关系以站位图为准，镜头运动方向与站位图机位箭头一致';

  const imagePrompt = [
    `画面：${cut(subject, 160)}`,
    specLine,
    refLine,
    charLine,
    blockingLine,
    styleLine,
    continuityLine,
    frameLine,
  ].filter(Boolean).join('｜');

  const motion = shot.motionDesc || cut(subject, 60) || '角色动作自然延续';
  const moveText = shot.movement ? `运镜：${shot.movement}` : '运镜：镜头平稳';
  const videoPrompt = [
    `以首帧画面为起点，不改变构图与人物位置`,
    cut(motion, 120),
    moveText,
    shot.audioDesc ? `声音设计：${cut(shot.audioDesc, 60)}` : '',
    (visual.characters || []).length
      ? `出场角色（${visual.characters.map((c) => c.name).join('、')}）的面部、发型、服装与首帧及参考图完全一致，不换人不变形`
      : '画面主体外观与首帧完全一致',
    duration ? `时长 ${duration}s${o.fps ? `（${o.fps}fps）` : ''}` : '',
    parts.aspect !== false ? `画幅 ${aspectLabel(settings.resolvedAspect || settings.aspect || '16:9')}` : '',
    '动作连贯自然，无闪烁跳帧、无文字水印、无新增人物',
  ].filter(Boolean).join('；');

  const refSlots = (visual.slots || []).map((s) => ({ ...s }));
  const refPlan = [
    ...refSlots.map((s) => ({ slot: s.slot, kind: s.kind, label: s.label, url: s.url, usage: s.usage })),
    { slot: 'keyframe', kind: 'keyframe', label: '首帧关键帧（已择优）', usage: '图生视频起点帧' },
    settings.layout ? { slot: 'grid', kind: 'grid', label: `${layout.label}宫格视图（本段分镜板）`, usage: '确认本格在整段里的前后文与构图密度' } : null,
    { slot: 'blocking', kind: 'blocking', label: '站位图（本格新生成）', usage: '人物相对位置 / 景别远近 / 运镜方向' },
  ].filter(Boolean);
  const refNote = refSlots.length
    ? `多参考图 ${refSlots.length} 张（多视图 ${visual.stats?.viewRefs ?? refSlots.filter((s) => s.kind === 'view').length} 张 + 妆照 ${visual.stats?.sheetRefs ?? refSlots.filter((s) => s.kind === 'sheet').length} 张）+ 首帧 + 宫格视图 + 站位图`
    : '无角色定妆参考，按文字外观 + 首帧 + 站位图生成';
  return {
    imagePrompt,
    videoPrompt,
    refSlots,
    refPlan,
    refNote,
    lines: {
      spec: specLine, char: charLine, ref: refLine, style: styleLine,
      continuity: continuityLine, frame: frameLine, blocking: blockingLine,
    },
    panel,
  };
}

/** 供导演包 / 日志用的紧凑摘要（一行说清这一镜带了哪些视觉物料） */
export function describeFrameVisuals(visual, prompts) {
  const n = visual?.stats?.total || 0;
  const chars = (visual?.characters || []).length;
  const bits = [`角色 ${chars} 位`, `参考图 ${n} 张（多视图 ${visual?.stats?.viewRefs || 0} + 妆照 ${visual?.stats?.sheetRefs || 0}）`, '站位图 1 张', '宫格视图 1 张'];
  return `${bits.join(' · ')}${prompts?.videoPrompt ? ' · 视频提示词就绪' : ''}`;
}
