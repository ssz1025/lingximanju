/* ============================================================================
 * 角色定妆「全片风格锁」（Style Lock）· 纯逻辑层，无任何 IO
 *
 * 问题：过去每个视图的提示词只把 `project.settings.style`（cinematic / anime 这类
 * 内部枚举）拼在最末，没有把创作设定里的全局风格串、画风、调性、角色配色
 * 真正写进图像提示词。结果同一个项目里各角色的定妆图来自不同画风，
 * 连同一个角色的正面与侧面都可能漂移，导进视频模型后身份与画风双丢。
 *
 * 这里把「整体风格」收敛成一份可复用、可解释的风格锁对象：
 *   1. 全局风格串（bible.stylePrompt）优先，它是用户/AI 写好的完整画风描述
 *   2. 其次 bible.artStyle + bible.tone（画风 + 调性）
 *   3. 兜底 project.settings.style 的内部枚举 → 中文化画风说明
 *   4. 角色自身 style / palette 作为「本角色专属」追加，不覆盖全片画风
 *
 * 生成图、导演包、验收清单共用同一份口径，保证「说的风格」和「出的图」一致。
 * ==========================================================================*/

/** 内部风格枚举 → 可读画风描述（给图像模型看的中文短语，不是内部标签） */
export const STYLE_DESCRIPTIONS = {
  cinematic: '写实电影质感，低饱和电影调色，胶片颗粒，柔和体积光',
  noir: '黑色电影质感，高对比低调光，冷灰主色配暖橙点缀，硬阴影，湿滑反光',
  anime: '日式动画赛璐璐上色，干净线稿，明快高饱和配色，柔光氛围',
  watercolor: '水彩手绘质感，纸纹与湿画法晕染边界，淡雅低饱和通透配色',
};

/** 角色定妆统一的画面规约（每个视图都遵守，避免逐张拼凑出现风格裂缝） */
export const PORTRAIT_RULES = {
  background: '纯色中性背景（浅灰或米白），无场景道具、无文字水印',
  framing: '全身入画，头顶留少量空间，脚底不出画',
  lighting: '柔和均匀的正面影视补光，主光偏左上，保留轻微轮廓光',
  quality: '角色设定图 / character reference sheet 质感，五官与服装细节清晰可辨',
};

/**
 * 完整肢体规约（所有全身视图共用）。
 *
 * 为什么必须显式写：旧提示词只有「全身入画，脚底不出画」，对 SDXL / 常见角色工作流
 * 来说约束力太弱，正面经常出成半身像、缺手缺脚、膝盖以下被裁，侧面与背面更是
 * 各画各的肢体。这里把「完整四肢 / 双手双脚 / 不裁切 / 不遮挡」写成硬约束，
 * 并在负向词里逐项列出失败模式。
 */
export const FULL_BODY_RULES = [
  '完整四肢可见：双手、十指、双臂、双腿、双脚全部入画且完整，不得缺失或被画面边缘裁切',
  '从头顶到脚底完整全身站姿，脚底不出画，人物直立居中，头顶与左右留白固定',
  '禁止半身像、胸像、头像、坐姿、蹲姿、躺姿，禁止用局部特写替代全身视图',
  '禁止肢体被道具 / 衣摆 / 阴影 / 画框遮挡，禁止透视畸变或比例失衡',
  '画面里只有这一个人物，禁止第二个人物、镜像、分身或重复肢体',
].join('；');

/** 正面基准图额外规约：正面平视、双脚同基线，是其余所有视图的身份锚点 */
export const FRONT_BODY_RULES = [
  FULL_BODY_RULES,
  '正面平视镜头，双肩水平、双手自然垂放、双脚落在同一水平基线',
  '本图是身份基准图（front reference）：脸型、五官、发型发色、身高体型、服装配色在此定型',
].join('；');

/** 非正面视图与正面基准图的对齐规约：背景 / 光照 / 比例 / 站姿全部同源 */
export const VIEW_CONSISTENCY_RULES = [
  '与正面基准图保持同一背景颜色、同一光照方向与同一补光强度',
  '与正面基准图保持同一身高比例、同一体型、同一站姿与脚底基线',
  '五官、发型发色、服装款式与配色、配饰与随身物件全部沿用正面基准图，只改变拍摄朝向',
].join('；');

/** 默认负向串：与「多视图定妆」目标冲突的常见失败项 */
export const DEFAULT_NEGATIVE = [
  '多个人物同框', '复杂背景', '文字水印', 'logo',
  // 完整肢体失败模式：这些词是「残肢 / 半身 / 出画」的直接来源
  '多余四肢', '断肢', '缺手', '缺脚', '手指缺失', '畸形手指', '手臂被截断', '腿部被裁切',
  '下半身出画', '膝盖以下缺失', '半身像', '胸像', '头像特写', '坐姿', '蹲姿',
  '肢体被遮挡', '人物贴画面边缘', '透视畸变', '身体比例失衡', '镜像分身',
  // 身份 / 画风失败模式
  '面部崩坏', '五官与正面不一致', '发型改变', '服装换款', '背景与正面不一致',
  '光照方向改变', '画面裁切到半身', '局部特写替代全身', '画风不一致', '重复人物', '过曝高光',
].join('，');

const cut = (v, n) => { const t = String(v ?? '').trim(); return t.length > n ? t.slice(0, n) : t; };

/**
 * 构建全片风格锁。
 * @param {object} opts { project, management }
 * @returns {{text:string, source:string, artStyle:string, tone:string, negative:string,
 *            label:string, fixed:string[]}}
 */
export function buildStyleLock({ project = null, management = null } = {}) {
  const m = management || project?.management || {};
  const bible = m.bible || {};
  const palette = project?.settings || {};
  const stylePrompt = cut(bible.stylePrompt, 600);
  const artStyle = cut(bible.artStyle, 24);
  const tone = cut(bible.tone, 24);
  const enumStyle = cut(palette.style, 40);

  const parts = [];
  let source = 'default';
  if (stylePrompt) {
    parts.push(stylePrompt);
    source = 'stylePrompt';
  } else if (artStyle || tone) {
    parts.push([artStyle, tone ? `${tone}调性` : ''].filter(Boolean).join('，'));
    source = 'bible';
  } else if (STYLE_DESCRIPTIONS[enumStyle]) {
    parts.push(STYLE_DESCRIPTIONS[enumStyle]);
    source = 'settings';
  } else {
    parts.push(STYLE_DESCRIPTIONS.cinematic);
    source = enumStyle ? `settings:${enumStyle}` : 'default';
  }

  // 全局风格串往往只写了「画风」，这里补齐定妆图必需的统一规约，避免每张图各自发挥
  parts.push(`统一画面规约：${PORTRAIT_RULES.background}；${PORTRAIT_RULES.lighting}；${PORTRAIT_RULES.quality}`);

  const negative = [cut(bible.negativePrompt, 600), DEFAULT_NEGATIVE].filter(Boolean).join('，');

  return {
    text: parts.filter(Boolean).join('；'),
    source,
    artStyle,
    tone,
    style: enumStyle || 'cinematic',
    negative,
    label: [artStyle, tone, enumStyle].filter(Boolean).join(' · ') || '未设定',
    fixed: [
      '同一角色在全部视图中脸型、五官、发型发色、身高体型完全一致',
      '服装款式、配饰、配色在全部视图中完全一致',
      '全部角色共用同一画风、同一光照方向与同一背景基调',
      '正面基准图必须是完整全身站姿：双手双脚可见、不裁切、脚底同一基线',
      '其余视图以正面基准图为唯一外观依据，只改变拍摄朝向',
      '定妆图用于后续关键帧与视频生成，须为可辨识的全身/面部参考图',
    ],
  };
}

/**
 * 角色专属风格片段：在全局风格锁之上追加本角色的风格与配色。
 * 只追加不覆盖——全片画风必须由风格锁统一。
 */
export function characterStyleBits(character = {}) {
  const bits = [];
  const style = cut(character.style, 120);
  if (style) bits.push(`本角色造型风格：${style}`);
  const palette = Array.isArray(character.palette) ? character.palette.slice(0, 5) : [];
  if (palette.length) bits.push(`本角色主配色：${palette.join(' / ')}（服装与配饰须体现这些颜色）`);
  return bits;
}
