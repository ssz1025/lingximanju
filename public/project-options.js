/* ============================================================================
 * 项目基础信息预设选项
 *
 * 「设置基础信息」与项目管理弹窗共用同一份枚举：类型 / 受众 / 基调 / 美术风格 /
 * 结局类型全部用下拉框选择，避免每次都要用户手敲。
 * 历史项目里已有的自由文本不会被丢弃：不在枚举中的旧值会作为「自定义」选项显示。
 * 零依赖、无副作用，可被 node --test 直接导入。
 * ==========================================================================*/
import { esc } from './utils.js';

export const GENRES = ['悬疑', '科幻', '古风', '都市', '爱情', '喜剧', '恐怖', '武侠', '奇幻', '现实'];
export const AUDIENCES = ['青少年', '青年', '女性向', '男性向', '全年龄', '亲子'];
export const TONES = ['治愈', '紧张', '热血', '暗黑', '轻松', '温情', '悬疑'];
export const ART_STYLES = ['写实电影', '日系动画', '国风水墨', '赛博朋克', '欧美漫画', '3D 渲染', '水彩绘本', '复古胶片'];
export const ENDINGS = ['HE 圆满', 'BE 悲剧', 'OE 开放', '反转结局', '循环结局'];
export const EPISODE_COUNTS = ['4', '6', '8', '12', '16', '24'];

/* ---------------------------------------------------------------- 短剧成片规格
 * 「总时长 / 每片段」原来是两个裸数字输入框：用户只能凭感觉敲数，不知道 30s
 * 到底意味着几个片段、也不知道行业里常见规格长什么样。这里把常见成片规格
 * 做成可点选的预设，同时保留自定义输入；推导口径必须与
 * src/core/runtime-spec.mjs 的 normalizeRuntimeSpec 完全一致，否则界面预览的
 * 片段数会和保存后的真实值不一致。 */

/** 常见短剧成片规格（totalSeconds 均能被 clipSeconds 整除，不触发对齐修正） */
export const RUNTIME_PRESETS = [
  { id: 'spot30', label: '30s 预告', totalSeconds: 30, clipSeconds: 3, hint: '10 个 3s 片段' },
  { id: 'short60', label: '60s 短剧', totalSeconds: 60, clipSeconds: 3, hint: '20 个 3s 片段' },
  { id: 'short90', label: '90s 短剧', totalSeconds: 90, clipSeconds: 5, hint: '18 个 5s 片段' },
  { id: 'short120', label: '2 分钟', totalSeconds: 120, clipSeconds: 5, hint: '24 个 5s 片段' },
  { id: 'short180', label: '3 分钟', totalSeconds: 180, clipSeconds: 5, hint: '36 个 5s 片段' },
];

/** 每片段可选时长（秒）。视频模型常见单段 2–8s，超出就走自定义数字输入 */
export const CLIP_SECONDS_OPTIONS = [2, 3, 4, 5, 6, 8];
/** 帧率可选值：24 电影感（默认）/ 25 国内电视 / 30 流畅 */
export const FPS_OPTIONS = [24, 25, 30];
/** 与服务端 runtime-spec.mjs LIMITS 对齐的输入边界 */
export const RUNTIME_LIMITS = { totalMin: 1, totalMax: 600, clipMin: 0.5, clipMax: 30, clipCountMax: 120 };

/* ---------------------------------------------------------------- 成片分辨率
 * 同一画幅有标清 / 高清 / 全高三档，横竖屏各一套宽高；与服务端
 * src/core/runtime-spec.mjs 的 RESOLUTION_TIERS 同源同文（前端不 import 服务端模块），
 * 改这里必须同步改那边，否则界面预览的分辨率会和保存后的真实值不一致。 */
export const RESOLUTION_TIERS = {
  '16:9': [
    { width: 864, height: 480, label: '864×480 横屏 · 标清' },
    { width: 1280, height: 720, label: '1280×720 横屏 · 高清' },
    { width: 1920, height: 1080, label: '1920×1080 横屏 · 全高清' },
  ],
  '9:16': [
    { width: 480, height: 864, label: '480×864 竖屏 · 标清' },
    { width: 720, height: 1280, label: '720×1280 竖屏 · 高清' },
    { width: 1080, height: 1920, label: '1080×1920 竖屏 · 全高清' },
  ],
};
export const ASPECT_LABELS = { '16:9': '横屏', '9:16': '竖屏' };
export function normalizeAspect(v) { return String(v || '') === '9:16' ? '9:16' : '16:9'; }
export function resolutionTiersFor(aspect) { return RESOLUTION_TIERS[normalizeAspect(aspect)]; }

/**
 * 前端即时推算：与 src/core/runtime-spec.mjs#normalizeRuntimeSpec 同口径。
 * 片段数由「总时长 ÷ 每片段」推导，不能整除时把总时长对齐到整数个片段，
 * 并用 aligned 如实标记——预览里显示的数字必须就是保存后落盘的数字。
 * 分辨率结合画幅归一：显式分辨率必须是该画幅档位之一；画幅换向后按档位序号
 * 映射到新画幅同档（16:9 的「高清」切到 9:16 仍是高清），否则回落画幅默认档。
 * @param {{totalSeconds?:number, clipSeconds?:number, fps?:number, aspect?:string, resolution?:string, width?:number, height?:number}} raw
 */
export function previewRuntimeSpec(raw = {}) {
  const num = (v, fb) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : fb; };
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const round2 = (n) => Math.round(n * 100) / 100;
  const requested = num(raw.totalSeconds, 30);
  const clipSeconds = round2(clamp(num(raw.clipSeconds, 3), RUNTIME_LIMITS.clipMin, RUNTIME_LIMITS.clipMax));
  const fps = Math.round(clamp(num(raw.fps, 24), 1, 120));
  const clipCount = clamp(Math.round(requested / clipSeconds), 1, RUNTIME_LIMITS.clipCountMax);
  const totalSeconds = round2(clipCount * clipSeconds);
  const aspect = normalizeAspect(raw.aspect);
  const tiers = RESOLUTION_TIERS[aspect];
  // 与服务端 pickResolution 同逻辑：分辨率串 / 宽高两种写法统一走
  // 「档位精确匹配 → 跨画幅按档位序号映射 → 回落画幅默认档」三级归一
  const m = String(raw.resolution || '').trim().match(/^(\d{2,5})\s*[×xX*]\s*(\d{2,5})$/);
  const w = m ? Number(m[1]) : Math.round(num(raw.width, 0));
  const h = m ? Number(m[2]) : Math.round(num(raw.height, 0));
  let res = (w > 0 && h > 0)
    ? tiers.find((t) => t.width === w && t.height === h) || null
    : null;
  if (!res && w > 0 && h > 0) {
    const oldAspect = w > h ? '16:9' : '9:16';
    if (oldAspect !== aspect) {
      const idx = RESOLUTION_TIERS[oldAspect].findIndex((t) => t.width === w && t.height === h);
      if (idx >= 0) res = tiers[idx];
    }
  }
  if (!res) res = tiers[0];
  return {
    totalSeconds,
    requestedTotalSeconds: round2(requested),
    clipSeconds,
    clipCount,
    fps,
    framesPerClip: Math.round(clipSeconds * fps),
    totalFrames: clipCount * Math.round(clipSeconds * fps),
    aspect,
    width: res.width,
    height: res.height,
    resolution: `${res.width}×${res.height}`,
    resolutionLabel: res.label,
    aligned: Math.abs(totalSeconds - round2(requested)) > 0.001,
  };
}

/** 当前「总时长 + 每片段」命中哪条预设；不在任何预设上返回空串（界面显示为自定义） */
export function matchRuntimePreset(totalSeconds, clipSeconds) {
  const total = Number(totalSeconds);
  const clip = Number(clipSeconds);
  const hit = RUNTIME_PRESETS.find((p) => p.totalSeconds === total && p.clipSeconds === clip);
  return hit ? hit.id : '';
}

/**
 * 数值型 <option> 列表。当前值不在候选里时追加一项并选中，
 * 避免历史项目保存的 7.5s 之类规格被下拉框「悄悄改成」列表里的第一个值。
 */
export function numberOptions(current, list, unit = '', emptyLabel = '') {
  const v = Number(current);
  const vals = list.map(Number);
  const has = Number.isFinite(v) && v > 0;
  const items = [...list];
  if (has && !vals.includes(v)) items.push(v);
  const out = [];
  if (emptyLabel) out.push(`<option value=""${has ? '' : ' selected'}>${esc(emptyLabel)}</option>`);
  for (const item of items) {
    const n = Number(item);
    const label = `${n}${unit}${has && n === v && !vals.includes(v) ? '（自定义）' : ''}`;
    out.push(`<option value="${esc(n)}"${has && n === v ? ' selected' : ''}>${esc(label)}</option>`);
  }
  return out.join('');
}

/** 生成 <option> 列表：空值占位 + 预设项；当前值不在预设里时追加为「自定义」并选中 */
export function selectOptions(current, list, emptyLabel = '未设定') {
  const v = String(current ?? '').trim();
  const out = [`<option value=""${v ? '' : ' selected'}>${esc(emptyLabel)}</option>`];
  const custom = v && !list.includes(v);
  for (const item of (custom ? [v, ...list] : list)) {
    const label = custom && item === v ? `${item}（自定义）` : item;
    out.push(`<option value="${esc(item)}"${item === v ? ' selected' : ''}>${esc(label)}</option>`);
  }
  return out.join('');
}

/* ------------------------------------------------------------ 分镜画面设置
 * 版式 / 画幅 / 格内信息 / 构图参考 / 提示词公式。与 src/core/storyboard-settings.mjs
 * 的 STORYBOARD_* 同源同文（前端不 import 服务端模块）：改这里必须同步改那边，
 * 否则面板上选「六宫格」而服务端仍按九宫格排版。
 * 真实几何（版面宽高、单格大小）由服务端 sheetSpec 推导，这里只负责选项与预览。 */
export const STORYBOARD_LAYOUTS = [
  { id: 'grid9', cols: 3, rows: 3, cells: 9, label: '九宫格', size: '3 × 3', hint: '动作序列 / 蒙太奇，一段九格最完整' },
  { id: 'grid6', cols: 3, rows: 2, cells: 6, label: '六宫格', size: '3 × 2', hint: '对话 / 详细场景，单格更大更好读' },
  { id: 'grid4', cols: 2, rows: 2, cells: 4, label: '四宫格', size: '2 × 2', hint: '关键瞬间 / 提案演示，一格一个转折' },
  { id: 'strip4', cols: 4, rows: 1, cells: 4, label: '条漫四联', size: '4 × 1', hint: '横向连续动作，一格接一格' },
  { id: 'grid25', cols: 5, rows: 5, cells: 25, label: '二十五宫格', size: '5 × 5', hint: '整集总览 / 角色一致性检查' },
  { id: 'single', cols: 1, rows: 1, cells: 1, label: '单图', size: '1 × 1', hint: '主镜头 / 封面级单张分镜' },
];

export const STORYBOARD_ASPECTS = [
  { id: 'inherit', label: '跟随项目画幅' },
  { id: '16:9', label: '横屏 16:9' },
  { id: '9:16', label: '竖屏 9:16' },
  { id: '1:1', label: '方形 1:1' },
  { id: '4:3', label: '横屏 4:3' },
];

export const STORYBOARD_SOURCES = [
  { id: 'mixed', label: '真实分镜图优先', hint: '有真实图铺图，缺图用示意剪影占位' },
  { id: 'keyframe', label: '只排真实分镜图', hint: '缺图的格子留空并标「待出图」' },
  { id: 'schematic', label: '只画示意', hint: '不引用真实图，纯版式示意' },
];

export const STORYBOARD_CAPTIONS = [
  { id: 'spec', label: '镜头规格 + 动作', hint: '景别 · 机位 · 运动 + 动作摘要' },
  { id: 'action', label: '只要动作', hint: '画面里发生了什么' },
  { id: 'prompt', label: '分镜提示词', hint: '格内显示提示词摘要' },
  { id: 'none', label: '不显示', hint: '纯画面，适合交付给下游' },
];

export const STORYBOARD_GUIDES = [
  { id: 'none', label: '不画参考线' },
  { id: 'thirds', label: '三分线' },
  { id: 'center', label: '中心十字' },
];

export const STORYBOARD_PROMPT_PARTS = [
  { id: 'spec', label: '景别 · 机位 · 运动', hint: '镜头语言写进提示词' },
  { id: 'character', label: '角色身份锚点', hint: '出场角色与定妆参考' },
  { id: 'style', label: '风格锚点', hint: '导演风格 / 主色 / 媒介' },
  { id: 'continuity', label: '空间连续性', hint: '与上一镜的轴线、光线关系' },
  { id: 'aspect', label: '画幅与构图', hint: '成片画幅 + 格位提示' },
];

export function storyboardLayout(id) {
  return STORYBOARD_LAYOUTS.find((l) => l.id === id) || STORYBOARD_LAYOUTS[0];
}

/** 与 core/storyboard-settings.mjs#describeStoryboardSettings 同口径的一句话描述 */
export function storyboardDescription(s = {}, projectAspect = '16:9') {
  const layout = storyboardLayout(s.layout);
  const aspect = s.aspect && s.aspect !== 'inherit' ? s.aspect : projectAspect;
  const aspectText = aspect === '9:16' ? '竖屏 9:16' : aspect === '1:1' ? '方形 1:1' : aspect === '4:3' ? '横屏 4:3' : '横屏 16:9';
  const source = (STORYBOARD_SOURCES.find((x) => x.id === s.source) || STORYBOARD_SOURCES[0]).label;
  return `${layout.label} ${layout.cols}×${layout.rows} · ${layout.cells} 格/段 · ${aspectText} · ${source}`;
}
