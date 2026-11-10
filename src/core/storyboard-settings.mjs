/* ============================================================================
 * 分镜画面设置（Storyboard Sheet Spec）· 纯逻辑层，无任何 IO
 *
 * 调研结论（分镜板 / 故事板行业惯例 + AI 漫剧实践）：
 *   · 3×3 九宫格：动作序列、蒙太奇，一段九格最完整；缺点是单格较小。
 *   · 3×2 六宫格：对话与详细场景，单格更大，读起来更省力。
 *   · 2×2 四宫格：关键瞬间 / 提案演示，一格只讲一个转折。
 *   · 5×5 二十五宫格：整集总览与角色一致性检查（国内 AI 漫剧常用）。
 *   · 4×1 条漫四联：横向连续动作，一格接一格。
 *   · 1×1 单图：主镜头 / 封面级分镜。
 *   · 每一格应带「景别 / 机位 / 运动 / 时长 / 动作」标注，而不是只有一个序号；
 *     分镜板是一格格拍好的镜头，所以格子画幅必须等于成片画幅。
 *
 * 因此版面尺寸由「格子数 × 单格画幅」推导，而不是把整张图硬压成某个比例：
 *   同一套设置下换版式，单格不会被拉成奇怪的长条。
 *
 * 本文件只做归一与推导，供 grid-art / episode-service / agents / 前端预览共用。
 * ==========================================================================*/

/** 版式预设：cols × rows 决定每段格子数；cells 为推导值，不手写避免不一致 */
export const STORYBOARD_LAYOUTS = [
  {
    id: 'grid9', cols: 3, rows: 3, label: '九宫格', size: '3 × 3',
    hint: '动作序列 / 蒙太奇，一段九格最完整',
  },
  {
    id: 'grid6', cols: 3, rows: 2, label: '六宫格', size: '3 × 2',
    hint: '对话 / 详细场景，单格更大更好读',
  },
  {
    id: 'grid4', cols: 2, rows: 2, label: '四宫格', size: '2 × 2',
    hint: '关键瞬间 / 提案演示，一格一个转折',
  },
  {
    id: 'strip4', cols: 4, rows: 1, label: '条漫四联', size: '4 × 1',
    hint: '横向连续动作，一格接一格',
  },
  {
    id: 'grid25', cols: 5, rows: 5, label: '二十五宫格', size: '5 × 5',
    hint: '整集总览 / 角色一致性检查',
  },
  {
    id: 'single', cols: 1, rows: 1, label: '单图', size: '1 × 1',
    hint: '主镜头 / 封面级单张分镜',
  },
].map((l) => ({ ...l, cells: l.cols * l.rows }));

export const LAYOUT_BY_ID = Object.fromEntries(STORYBOARD_LAYOUTS.map((l) => [l.id, l]));
const DEFAULT_LAYOUT = LAYOUT_BY_ID.grid9;

/** 宫格板画幅：inherit = 跟随项目成片画幅（推荐），其余为显式覆盖 */
export const STORYBOARD_ASPECTS = [
  { id: 'inherit', label: '跟随项目画幅' },
  { id: '16:9', label: '横屏 16:9' },
  { id: '9:16', label: '竖屏 9:16' },
  { id: '1:1', label: '方形 1:1' },
  { id: '4:3', label: '横屏 4:3' },
];

/** 格内画面来源：真实分镜图优先 / 只排真实图 / 只画示意 */
export const STORYBOARD_SOURCES = [
  { id: 'mixed', label: '真实分镜图优先', hint: '有真实图铺图，缺图用示意剪影占位' },
  { id: 'keyframe', label: '只排真实分镜图', hint: '缺图的格子留空并标「待出图」，不画占位' },
  { id: 'schematic', label: '只画示意', hint: '不引用真实图，纯版式示意（改版式时预览用）' },
];

/** 说明条内容：镜头规格 / 动作描述 / 分镜提示词 / 不显示 */
export const STORYBOARD_CAPTIONS = [
  { id: 'spec', label: '镜头规格 + 动作', hint: '景别 · 机位 · 运动 + 动作摘要' },
  { id: 'action', label: '只要动作', hint: '画面里发生了什么' },
  { id: 'prompt', label: '分镜提示词', hint: '格内显示提示词摘要，便于对词' },
  { id: 'none', label: '不显示', hint: '纯画面，适合交付给下游' },
];

/** 构图参考线：无 / 三分线 / 中心十字 */
export const STORYBOARD_GUIDES = [
  { id: 'none', label: '不画参考线' },
  { id: 'thirds', label: '三分线' },
  { id: 'center', label: '中心十字' },
];

/** 提示词公式开关（关键帧智能体按此拼提示词） */
export const PROMPT_PARTS = [
  { id: 'spec', label: '景别 · 机位 · 运动', hint: '镜头语言必须写进提示词' },
  { id: 'character', label: '角色身份锚点', hint: '出场角色与定妆参考' },
  { id: 'style', label: '风格锚点', hint: '导演风格 / 主色 / 媒介' },
  { id: 'continuity', label: '空间连续性', hint: '与上一镜的机位、光线、轴线关系' },
  { id: 'aspect', label: '画幅与构图', hint: '成片画幅 + 格位构图提示' },
];

export const DEFAULT_STORYBOARD = Object.freeze({
  schema: 1,
  layout: DEFAULT_LAYOUT.id,
  aspect: 'inherit',
  source: 'mixed',
  captionMode: 'spec',
  guides: 'thirds',
  showNo: true,
  watermark: true,
  prompt: Object.freeze({
    spec: true, character: true, style: true, continuity: true, aspect: true,
  }),
  updatedAt: 0,
});

const str = (v, max = 60) => String(v ?? '').trim().slice(0, max);
const bool = (v, fb) => (v === undefined || v === null ? fb : Boolean(v));

function oneOf(list, id, fallback) {
  const hit = list.find((x) => x.id === id);
  return hit ? hit.id : fallback;
}

/**
 * 归一设置：只保留已知字段，杜绝任意请求体写进项目 JSON。
 * cols / rows / cells 是推导值一并落盘，前端与宫格渲染不必各自再查表。
 */
export function normalizeStoryboardSettings(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const layout = LAYOUT_BY_ID[str(src.layout, 24)] || DEFAULT_LAYOUT;
  const promptSrc = src.prompt && typeof src.prompt === 'object' ? src.prompt : {};
  return {
    schema: 1,
    layout: layout.id,
    cols: layout.cols,
    rows: layout.rows,
    cells: layout.cells,
    aspect: oneOf(STORYBOARD_ASPECTS, src.aspect, DEFAULT_STORYBOARD.aspect),
    source: oneOf(STORYBOARD_SOURCES, src.source, DEFAULT_STORYBOARD.source),
    captionMode: oneOf(STORYBOARD_CAPTIONS, src.captionMode, DEFAULT_STORYBOARD.captionMode),
    guides: oneOf(STORYBOARD_GUIDES, src.guides, DEFAULT_STORYBOARD.guides),
    showNo: bool(src.showNo, DEFAULT_STORYBOARD.showNo),
    watermark: bool(src.watermark, DEFAULT_STORYBOARD.watermark),
    prompt: Object.fromEntries(PROMPT_PARTS.map((p) => [p.id, bool(promptSrc[p.id], DEFAULT_STORYBOARD.prompt[p.id])])),
    updatedAt: Number(src.updatedAt) || 0,
  };
}

/** 项目画幅（16:9 / 9:16）；宫格板 aspect='inherit' 时以它为准 */
export function projectAspect(project) {
  return String(project?.settings?.aspect || '') === '9:16' ? '9:16' : '16:9';
}

/**
 * 运行时解析点：管理态设置 + 项目画幅 → 可直接消费的设置。
 * resolvedAspect 永远是一个具体画幅（不会是 'inherit'），grid-art 只认它。
 */
export function resolveStoryboardSettings(project) {
  const s = normalizeStoryboardSettings(project?.management?.storyboard || {});
  return { ...s, resolvedAspect: s.aspect === 'inherit' ? projectAspect(project) : s.aspect };
}

/** 版式元数据（缺设置时回落九宫格） */
export function layoutOf(settings) {
  return LAYOUT_BY_ID[settings?.layout] || DEFAULT_LAYOUT;
}

const FRAME_RATIO = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3 };

/**
 * 版面几何：单格画幅 = 成片画幅 → 版心大小由格子数推导。
 * 竖屏格子给更窄的基准宽度，否则九宫格会变成一张两千像素高的巨型长图；
 * 5 列总览板给更小的基准宽度，保证信息密度而不是尺寸。
 */
export function sheetSpec(settings) {
  const layout = layoutOf(settings);
  const rawAspect = String(settings?.resolvedAspect || settings?.aspect || '16:9');
  const aspect = FRAME_RATIO[rawAspect] ? rawAspect : '16:9';
  const ratio = FRAME_RATIO[aspect] || 16 / 9;
  const { cols, rows } = layout;
  const portrait = ratio < 1;
  const base = layout.id === 'single' ? (portrait ? 540 : 760)
    : cols >= 5 ? 300
      : cols === 4 ? (portrait ? 280 : 380)
        : cols === 3 ? (portrait ? 320 : 420)
          : 460;
  const pad = 28;
  const gap = 14;
  const head = 96;
  const foot = 38;
  // 画幅越竖，单格越窄：避免九宫格竖屏板高度失控
  const cellW = Math.round(base);
  const cellH = Math.round(cellW / ratio);
  const width = Math.round(pad * 2 + cols * cellW + gap * (cols - 1));
  const height = Math.round(head + rows * cellH + gap * (rows - 1) + foot);
  return { width, height, cellW, cellH, cols, rows, pad, gap, head, foot, aspect, portrait };
}

/** 镜头在全片里的格位：1..cells 循环（宫格板按格循环使用） */
export function panelIndexOf(settings, sequence) {
  const cells = layoutOf(settings).cells;
  const n = Number(sequence);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return ((Math.floor(n) - 1) % cells + cells) % cells + 1;
}

/** 一段/一集在版式里的格子数（等价于 layout.cells，读设置里的落盘值更直观） */
export function cellsOf(settings) {
  return Number(settings?.cells) > 0 ? Number(settings.cells) : layoutOf(settings).cells;
}

/** 画幅中文名（横屏 / 竖屏 / 方形），说明文案与提示词共用 */
export function aspectLabel(aspect) {
  const a = String(aspect || '16:9');
  if (a === '9:16') return '竖屏 9:16';
  if (a === '1:1') return '方形 1:1';
  if (a === '4:3') return '横屏 4:3';
  return '横屏 16:9';
}

/** 设置的一句话描述：面板、步骤 note、日志共用同一口径 */
export function describeStoryboardSettings(settings) {
  const layout = layoutOf(settings);
  const sourceText = (STORYBOARD_SOURCES.find((s) => s.id === settings?.source) || STORYBOARD_SOURCES[0]).label;
  return `${layout.label} ${layout.cols}×${layout.rows} · ${layout.cells} 格/段 · ${aspectLabel(settings?.resolvedAspect || settings?.aspect)} · ${sourceText}`;
}

/** 给关键帧智能体的画面设置提示：格位 + 画幅 + 构图，作为提示词的最后一段 */
export function framePromptNote(settings, shot = {}) {
  const layout = layoutOf(settings);
  const seq = Number(shot.sequence ?? shot.shotNo) || 1;
  const panel = panelIndexOf(settings, seq);
  return `分镜画面：${layout.label}第 ${panel}/${layout.cells} 格 · ${aspectLabel(settings?.resolvedAspect)} 画幅 · 单格即一个成片镜头`;
}
