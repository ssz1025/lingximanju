/* ============================================================================
 * 角色域模型：角色属性归一、造型/多视图提示词拼装、LLM 提取输入组装、提取结果合并。
 * 纯逻辑无 I/O（只依赖纯函数 novel.mjs / bm25.mjs），供管理路由、角色智能体与测试复用。
 *
 * 论文对齐（ViMax）：
 *   - CharacterInScene 的 static_features / dynamic_features 二分 → staticFeatures / dynamicFeatures
 *   - character_extractor.py 的抽取方法论 → 见 EXTRACT_GUIDELINES
 *   - 式(6) 检索增强 → buildCharacterPassages 用 BM25 从全书记忆里召回原文片段
 * ==========================================================================*/
import { extractCharacters, firstSentenceOf, mineFrequentNames } from './novel.mjs';
import { chunkNovel, KnowledgeBase, retrieveRelevantChunks } from './bm25.mjs';
import {
  characterStyleBits, DEFAULT_NEGATIVE, PORTRAIT_RULES,
  FULL_BODY_RULES, FRONT_BODY_RULES, VIEW_CONSISTENCY_RULES,
} from './character-style.mjs';
import { isLikelyPersonName } from './character-names.mjs';

/**
 * 角色多视图定义：key 稳定用于 views 字段，angle 注入多视图提示词。
 *
 * 从 3 视图扩展为 5 视图：过去只有正面 / 侧面 / 背面，侧面只有 90 度一个角度，
 * 视频模型拿不到「转身中间态」与「面部近景」，生成中近景镜头时只能靠文字猜脸，
 * 身份漂移几乎必然发生。现在补齐：
 *   - front          正面全身（身份基准图，其余视图都以它为参考）
 *   - threeQuarter   3/4 侧身（最常用的叙事机位，也是最难靠文字描述稳定的角度）
 *   - side           90 度侧面
 *   - back           背面
 *   - closeup        面部特写（近景/特写镜头的身份锚点）
 * core=true 的四个视图构成「基础定妆组」，兼容历史上的三视图语义（front/side/back）。
 */
export const CHARACTER_VIEWS = [
  { key: 'front', label: '正面', angle: '正面平视全身站立，双手自然垂放', core: true, kind: 'body' },
  { key: 'threeQuarter', label: '3/4 侧', angle: '身体转 45 度的 3/4 侧身全身站立', core: true, kind: 'body' },
  { key: 'side', label: '侧面', angle: '90 度侧面全身站立', core: true, kind: 'body' },
  { key: 'back', label: '背面', angle: '背面全身站立（不可见五官）', core: true, kind: 'body' },
  { key: 'closeup', label: '面部特写', angle: '正面齐胸以上的面部特写，正对镜头', core: false, kind: 'face' },
];

/** 基础定妆组：不含面部特写，等同历史「三视图」语义的最小可用集合 */
export const CORE_VIEW_KEYS = CHARACTER_VIEWS.filter((v) => v.core).map((v) => v.key);
/** 全部视图 key */
export const ALL_VIEW_KEYS = CHARACTER_VIEWS.map((v) => v.key);
/** 默认生成范围：基础定妆组（含 3/4 侧），比旧三视图多一张但仍是可用最小集 */
export const DEFAULT_VIEW_KEYS = CORE_VIEW_KEYS;

export const viewDef = (key) => CHARACTER_VIEWS.find((v) => v.key === key) || null;

/**
 * 把外部传入的 scope 归一成视图 key 列表。
 * 兼容旧调用（allViews:true → 旧三视图）与新语义（scope:'core' | 'all' | 显式 key 数组）。
 */
export function resolveViewKeys(scope = 'core') {
  if (Array.isArray(scope)) {
    const keys = scope.map(String).filter((k) => ALL_VIEW_KEYS.includes(k));
    return keys.length ? [...new Set(keys)] : DEFAULT_VIEW_KEYS;
  }
  const s = String(scope || 'core').toLowerCase();
  if (s === 'all' || s === 'full') return ALL_VIEW_KEYS;
  if (s === 'face' || s === 'closeup') return ['closeup'];
  return DEFAULT_VIEW_KEYS;
}

/** 列表上限与字段长度上限（防 JSON 注入垃圾数据） */
export const MAX_CHARACTERS = 12;
const LIMITS = {
  name: 20, role: 60, gender: 8, age: 24, personality: 300,
  appearance: 600, hair: 120, costume: 300, props: 200, style: 120, viewPrompt: 600,
  staticFeatures: 400, dynamicFeatures: 400,
  voiceName: 40, voiceReason: 200,
};
const ID_RE = /^[a-zA-Z0-9_-]+$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function genId() {
  return `chr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 角色名归一键：与资源库 matchCharacters 同规则（去空格/书名号/引号，大小写不敏感） */
export function charNameKey(name) {
  return String(name || '').replace(/[\s《》「」『』"'·]/g, '').toLowerCase();
}

function cut(v, max) {
  return String(v ?? '').trim().slice(0, max);
}

/** 视图对象归一：保留 file/url/prompt/provider/at，并记录该图用了哪些参考图 */
function normalizeViewShot(v) {
  if (!v || typeof v !== 'object' || !v.url) return null;
  return {
    file: String(v.file || '').split('/').pop() || '',
    url: String(v.url).slice(0, 300),
    prompt: String(v.prompt || '').slice(0, 2000),
    provider: String(v.provider || ''),
    angle: String(v.angle || '').slice(0, 80),
    refs: (Array.isArray(v.refs) ? v.refs : []).map((r) => String(r).slice(0, 300)).slice(0, 4),
    styleLock: String(v.styleLock || '').slice(0, 120),
    // 参考图链是否真的进了工作流：ComfyUI 分支回传 refsUsed；0 表示工作流没接收参考图，
    // 此时一致性不保证，角色卡应给出「来源不一致/未参考」告警。
    refsUsed: v.refsUsed === null || v.refsUsed === undefined ? null : (Number(v.refsUsed) || 0),
    refsWarning: String(v.refsWarning || '').slice(0, 200),
    // 本次出图用的接口档案（用于按视图配置工作流的回溯）
    interfaceId: String(v.interfaceId || '').slice(0, 60),
    scope: String(v.scope || '').slice(0, 60),
    at: Number(v.at) || 0,
  };
}

/** 全部视图（含历史三视图与新增 3/4 侧、面部特写）逐项归一，缺失保持 null */
function normalizeViews(views) {
  const out = Object.fromEntries(ALL_VIEW_KEYS.map((k) => [k, null]));
  for (const { key } of CHARACTER_VIEWS) out[key] = normalizeViewShot(views?.[key]);
  return out;
}

const EVIDENCE_KINDS = ['mention', 'dialogue', 'description'];

/** 证据引用归一：去空、去重、quote 截断，最多保留 5 条 */
function normalizeEvidence(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const quote = cut(raw?.quote, 120);
    if (!quote || seen.has(quote)) continue;
    seen.add(quote);
    out.push({ quote, kind: EVIDENCE_KINDS.includes(raw?.kind) ? raw.kind : 'mention' });
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * 证据校验：把每条 evidence.quote 拿回原著原文定位，定位不到的引用丢弃。
 *
 * 引用是模型自述的「原文依据」，只有能在原著里找到才可回溯；找不到即视为幻觉。
 * 与 dramaclaw 的 verify_evidence 同策略：只丢失效引用，不丢角色本身
 * （角色是否成立由推理决定，引用只承担可溯源与幻觉过滤职责）。
 *
 * @param {Array} characters 提取结果
 * @param {string} sourceText 原著全文（校验语料）
 * @returns {{characters:Array, verified:number, dropped:number}} 校验后的角色与统计
 */
export function verifyEvidence(characters = [], sourceText = '') {
  const src = String(sourceText || '');
  const compact = src.replace(/\s+/g, '');
  let verified = 0;
  let dropped = 0;
  const list = (Array.isArray(characters) ? characters : []).map((c) => {
    const evidence = (Array.isArray(c?.evidence) ? c.evidence : []).filter((e) => {
      const quote = String(e?.quote || '');
      if (!quote) { dropped += 1; return false; }
      // 先逐字匹配，再退到忽略空白的匹配（原文换行/缩进被模型抄丢属正常）
      const hit = src.includes(quote) || compact.includes(quote.replace(/\s+/g, ''));
      if (!hit) { dropped += 1; return false; }
      verified += 1;
      return true;
    });
    return { ...c, evidence };
  });
  return { characters: list, verified, dropped };
}

/**
 * 特征二分兜底：模型漏给 static/dynamic 时，用已有属性推导。
 * static 取外貌/发型（跨镜头恒定），dynamic 取服装/随身物（随场景变化）。
 * 论文对齐：CharacterInScene 要求两类特征分开，缺失时按语义补位而不是留空。
 */
function deriveFeatures(c) {
  const staticFeatures = c.staticFeatures || [c.appearance, c.hair].filter(Boolean).join('，');
  const dynamicFeatures = c.dynamicFeatures || [c.costume, c.props].filter(Boolean).join('，');
  return { staticFeatures, dynamicFeatures };
}

/** 该特征是否只是「由其它属性派生的兜底值」（而非模型/用户真正给出的特征） */
function isDerivedFeature(c, field) {
  const derived = field === 'staticFeatures'
    ? [c.appearance, c.hair].filter(Boolean).join('，')
    : [c.costume, c.props].filter(Boolean).join('，');
  return Boolean(derived) && c[field] === derived;
}

/** 归一角色对象：补齐缺字段、截断超长文本、过滤非法 palette；保留已有 id/source/views */
export function normalizeCharacter(raw = {}) {
  const aliases = Array.isArray(raw.aliases) ? raw.aliases : String(raw.aliases || '').split(/[,，、]/);
  const base = {
    id: ID_RE.test(String(raw.id || '')) ? String(raw.id) : genId(),
    name: cut(raw.name, LIMITS.name),
    aliases: aliases.map((a) => cut(a, LIMITS.name)).filter(Boolean).slice(0, 6),
    role: cut(raw.role, LIMITS.role),
    gender: cut(raw.gender, LIMITS.gender),
    age: cut(raw.age, LIMITS.age),
    personality: cut(raw.personality, LIMITS.personality),
    appearance: cut(raw.appearance, LIMITS.appearance),
    staticFeatures: cut(raw.staticFeatures, LIMITS.staticFeatures),
    dynamicFeatures: cut(raw.dynamicFeatures, LIMITS.dynamicFeatures),
    hair: cut(raw.hair, LIMITS.hair),
    costume: cut(raw.costume, LIMITS.costume),
    props: cut(raw.props, LIMITS.props),
    style: cut(raw.style, LIMITS.style),
    // 音色分配结果（由音色分配 Agent / 手动指定写回，见 voices.mjs）
    voiceId: ID_RE.test(String(raw.voiceId || '')) ? String(raw.voiceId) : '',
    voiceName: cut(raw.voiceName, LIMITS.voiceName),
    voiceReason: cut(raw.voiceReason, LIMITS.voiceReason),
    voiceScore: Number(raw.voiceScore) || 0,
    relations: (Array.isArray(raw.relations) ? raw.relations : [])
      .map((r) => ({ target: cut(r?.target, LIMITS.name), label: cut(r?.label, 30) }))
      .filter((r) => r.target || r.label).slice(0, 8),
    palette: (Array.isArray(raw.palette) ? raw.palette : [])
      .map((c) => String(c).trim()).filter((c) => HEX_RE.test(c)).slice(0, 5),
    viewPrompt: cut(raw.viewPrompt, LIMITS.viewPrompt),
    evidence: normalizeEvidence(raw.evidence),
    views: normalizeViews(raw.views),
    // 定妆板：多视图拼在一张图上的总览参考（视频模型作为「角色设定板」输入最稳）
    sheet: normalizeViewShot(raw.sheet),
    // 生成该角色定妆时使用的风格锁摘要，便于回溯「为什么这批图是这个画风」
    styleLock: cut(raw.styleLock, 120),
    source: ['llm', 'heuristic', 'manual'].includes(raw.source) ? raw.source : 'manual',
    // 用户手改过的角色：后续重新提取不应覆盖其字段（论文要求「不引入片段外设定」，
    // 但更根本的是尊重人工修改）
    edited: Boolean(raw.edited),
    hits: Number(raw.hits) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
  };
  return { ...base, ...deriveFeatures(base) };
}

/**
 * 角色属性 → 造型描述串（供角色造型智能体 / 图像提示词复用）。
 * 论文对齐：ViMax 把角色特征拆成 static（不随场景变化的外貌/体型）与 dynamic（服饰/配饰/道具），
 * 分开描述才能让同一角色跨镜头保持身份一致；本函数保留旧字段兼容，同时优先用二分特征。
 */
export function buildCharacterPrompt(c = {}) {
  const parts = [];
  if (c.name) parts.push(`角色「${c.name}」`);
  if (c.role) parts.push(`身份定位：${c.role}`);
  if (c.gender || c.age) parts.push(`性别年龄：${[c.gender, c.age].filter(Boolean).join('，')}`);
  if (c.staticFeatures) parts.push(`固定特征：${c.staticFeatures}`);
  if (c.dynamicFeatures) parts.push(`可变特征：${c.dynamicFeatures}`);
  if (c.appearance) parts.push(`外貌：${c.appearance}`);
  if (c.hair) parts.push(`发型：${c.hair}`);
  if (c.costume) parts.push(`服装：${c.costume}`);
  if (c.props) parts.push(`随身物件：${c.props}`);
  if (c.personality) parts.push(`性格：${c.personality}`);
  if (c.style) parts.push(`设定风格：${c.style}`);
  if (c.palette?.length) parts.push(`配色：${c.palette.join(' / ')}`);
  return parts.join('；');
}

/**
 * 角色 + 视图 → 多视图定妆提示词。
 *
 * 论文对齐（ViMax CharacterPortraitsGenerator）：
 *   - 正面视图写明 static/dynamic 特征，是身份基准图
 *   - 其余视图以「正面定妆图」为参考，只描述朝向，不重述特征，避免重述文字造成不一致
 *
 * 本项目增强（定妆可用性）：
 *   - 每条提示词都带「全片风格锁」，保证同一项目里所有角色、所有视图画风一致
 *   - 带「角色专属风格与主配色」，让同画风下不同角色仍能区分
 *   - 带统一画面规约（纯色背景 / 均匀补光 / 全身入画 / 设定图质感）
 *   - 面部特写单独成组：它不追求全身，而是给近景镜头一个可对齐的脸
 *
 * @param {object} c 角色属性
 * @param {string} viewKey 视图 key（见 CHARACTER_VIEWS）
 * @param {object} opts { styleLock, style, negative, refs:[{view,url}] }
 * @returns {string} 直接可用的图像提示词
 */
export function buildViewPrompt(c = {}, viewKey = 'front', opts = {}) {
  const v = viewDef(viewKey) || CHARACTER_VIEWS[0];
  // 风格锁优先；未传时退化为旧的 style 字符串，保证旧调用（测试 / 路由）行为不破
  const lock = opts.styleLock && typeof opts.styleLock === 'object' ? opts.styleLock : null;
  const styleText = lock?.text || String(opts.style || '').trim();
  const negative = String(opts.negative || lock?.negative || DEFAULT_NEGATIVE).trim();
  const isFront = v.key === 'front';
  const isFace = v.kind === 'face';
  const charStyle = characterStyleBits(c);

  const refViews = Array.isArray(opts.refs)
    ? opts.refs.map((r) => viewDef(r?.view)?.label || '').filter(Boolean)
    : [];
  const refNote = refViews.length
    ? `以提供的参考图（${refViews.join(' / ')}）为唯一外观依据，保持同一人物的脸型/五官/发型/服装/配饰完全一致`
    : '以文字描述为准，保持同一人物的脸型/五官/发型/服装/配饰完全一致';

  if (isFace) {
    // 面部特写：不要求全身，但必须是「正面基准图放大出来的同一张脸」。
    // 旧实现只用文字重述五官，模型会重新画一张脸，与镜头特写完全对不上。
    return [
      `角色定妆面部特写，${v.angle}`,
      `${c.name || '该角色'}的面部近景特写，正面平视镜头，五官与发际线清晰锐利`,
      refNote,
      '齐胸以上构图（由正面基准图裁切放大得到同一张脸，不改变五官、脸型、发际线、发型、服装领口与配饰）',
      PORTRAIT_RULES.background,
      PORTRAIT_RULES.lighting,
      PORTRAIT_RULES.quality,
      '眼神光可见，与正面基准图同一背景色与光照方向',
      ...charStyle,
      styleText && `画面风格：${styleText}`,
      negative && `避免：${negative}`,
    ].filter(Boolean).join('；') + '。';
  }

  if (!isFront) {
    // 侧面 / 背面 / 3-4 侧：以正面图为参考，只描述朝向与画面要求。
    // 完整四肢、同一背景、同一光照、同一身高比例都是硬约束，否则各视图各画各的。
    return [
      `角色多视图定妆，${v.angle}`,
      refNote,
      VIEW_CONSISTENCY_RULES,
      FULL_BODY_RULES,
      PORTRAIT_RULES.framing,
      PORTRAIT_RULES.background,
      PORTRAIT_RULES.lighting,
      PORTRAIT_RULES.quality,
      v.key === 'back' ? '背面不可见五官，仅交代发型后侧轮廓与服装背部结构' : '',
      ...charStyle,
      styleText && `画面风格：${styleText}`,
      negative && `避免：${negative}`,
    ].filter(Boolean).join('；') + '。';
  }

  // 正面用 viewPrompt 时不再叠加属性拼装串：两者都写了外貌，叠在一起会让模型收到
  // 互相重复甚至互相矛盾的描述，反而降低一致性
  const viewPromptText = String(c.viewPrompt || '').trim();
  const base = viewPromptText || buildCharacterPrompt(c) || `${c.name || '角色'}角色设定`;
  // 论文正面模板：Features = "(static) X; (dynamic) Y"，特征二分显式写进提示词
  const staticF = String(c.staticFeatures || '').trim();
  const dynamicF = String(c.dynamicFeatures || '').trim();
  const features = staticF || dynamicF
    ? `固定特征：${staticF || '待补充'}；可变特征：${dynamicF || '待补充'}`
    : '';
  // base 里已经写过特征时不再重复：buildCharacterPrompt 本身就带「固定特征/可变特征」两段，
  // viewPrompt 也常常已经包含外观描述 —— 两处都写会让提示词出现同一句特征两次
  const dupFeatures = features && staticF
    && base.includes(staticF) && (!dynamicF || base.includes(dynamicF));
  return [
    `角色多视图定妆 · 身份基准图（正面全身），${v.angle}`,
    base,
    dupFeatures ? '' : features,
    FRONT_BODY_RULES,
    PORTRAIT_RULES.framing,
    PORTRAIT_RULES.background,
    PORTRAIT_RULES.lighting,
    PORTRAIT_RULES.quality,
    ...charStyle,
    styleText && `画面风格：${styleText}`,
    negative && `避免：${negative}`,
  ].filter(Boolean).join('。') + '。';
}

/**
 * 定妆板提示词：把同一角色的多个视图排进一张图，作为「角色设定板」参考。
 *
 * 为什么需要它：视频 / 图生图模型对「单张设定板」的理解远好于多张散图，
 * 导演包与 ComfyUI 参考图插槽也只有有限个，一块板能把全角度信息压进 1 张图。
 */
export function buildSheetPrompt(c = {}, opts = {}) {
  const lock = opts.styleLock && typeof opts.styleLock === 'object' ? opts.styleLock : null;
  const styleText = lock?.text || String(opts.style || '').trim();
  const negative = String(opts.negative || lock?.negative || DEFAULT_NEGATIVE).trim();
  const views = (Array.isArray(opts.views) && opts.views.length ? opts.views : DEFAULT_VIEW_KEYS)
    .map((k) => viewDef(k)).filter(Boolean);
  const layout = views.map((v) => v.label).join(' / ');
  // 旧实现把 buildCharacterPrompt 的人设文字整段重述一遍，等于让模型「照文字再画一个人」，
  // 与已经生成好的各视图必然对不上。设定板只做排版：唯一外观依据是传进去的视图参考图。
  return [
    `角色设定板 / character reference sheet：角色「${c.name || '角色'}」的 ${views.length} 个视角并排：${layout}`,
    '以提供的各视图参考图（尤其是正面基准图）为唯一外观依据：只做同版排布与清晰化重绘，不依据文字重新设计五官、脸型、发型、服装与配色',
    FULL_BODY_RULES,
    '横向排布，各视角人物身高比例一致、脚底对齐同一基线，视角之间留白色间隔',
    '每一格都是纯色中性背景，与正面基准图同一背景色与光照方向，无场景道具、无文字标注、无水印',
    ...characterStyleBits(c),
    styleText && `画面风格：${styleText}`,
    negative && `避免：${negative}`,
  ].filter(Boolean).join('；') + '。';
}

/** 是否为真实出图（非 mock 自绘占位）：Mock SVG 只是零 Key 演示占位，不算「已生成」 */
export function isRealShot(v) {
  return Boolean(v?.url) && String(v?.provider || '') !== 'mock';
}

/**
 * 角色多视图一致性报告：只做可回溯的静态校验（不调模型、不比对像素）。
 *
 * 检查四件事：① 有没有正面基准图；② 其余视图是否真的引用了正面图；
 * ③ 各视图是否来自同一 provider；④ 各视图是否用同一份风格锁。
 * 任何一项不成立都意味着「正面 / 侧面 / 特写 / 定妆板」可能不是同一个人，
 * 前端角色卡据此显示「⚠ 来源不一致」，用户可只重出正面或整组重出。
 *
 * @param {object} c 角色
 * @param {object} opts { scope }
 * @returns {{ok:boolean, label:string, scope:string[], issues:Array,
 *            providers:string[], styleLocks:string[], frontUrl:string}}
 */
export function characterConsistencyReport(c = {}, opts = {}) {
  const scope = resolveViewKeys(opts.scope || 'core');
  const views = c?.views || {};
  const frontUrl = String(views.front?.url || '');
  const shots = scope.map((key) => ({ key, shot: views[key] })).filter((x) => Boolean(x.shot?.url));
  const issues = [];
  if (!frontUrl) issues.push({ code: 'no-front', view: 'front', message: '缺正面基准图' });
  else if (!isRealShot(views.front)) issues.push({ code: 'front-placeholder', view: 'front', message: '正面基准图是占位图' });

  const providers = [...new Set(shots.map((x) => String(x.shot.provider || '')).filter(Boolean))];
  if (providers.length > 1) issues.push({ code: 'mixed-provider', message: `视图来自不同出图通道：${providers.join(' / ')}` });
  const locks = [...new Set(shots.map((x) => String(x.shot.styleLock || '')).filter(Boolean))];
  if (locks.length > 1) issues.push({ code: 'mixed-style-lock', message: '视图用了不同风格锁' });

  for (const { key, shot } of shots) {
    if (key === 'front') continue;
    const refs = Array.isArray(shot.refs) ? shot.refs.map(String).filter(Boolean) : [];
    if (!refs.length) issues.push({ code: 'no-refs', view: key, message: `${viewDef(key)?.label || key} 未记录参考图链` });
    else if (frontUrl && !refs.includes(frontUrl)) {
      issues.push({ code: 'front-not-referenced', view: key, message: `${viewDef(key)?.label || key} 未回引正面基准图` });
    }
    if (String(shot.refsWarning || '')) issues.push({ code: 'refs-unused', view: key, message: String(shot.refsWarning) });
  }
  if (c?.sheet?.url && c.sheet.styleLock && locks.length && !locks.includes(String(c.sheet.styleLock))) {
    issues.push({ code: 'sheet-style-lock', message: '定妆板与各视图的风格锁不同源' });
  }
  const label = issues.length
    ? `⚠ 来源不一致（${issues.slice(0, 2).map((x) => x.message).join('；')}${issues.length > 2 ? ' 等' : ''}）`
    : (shots.length ? '✓ 同一正面基准 / 同一风格锁 / 同一出图通道' : '尚无定妆图');
  return { ok: issues.length === 0, label, scope, issues, providers, styleLocks: locks, frontUrl };
}

/**
 * 角色定妆完整度：给管理面板、验收清单与批量补全共用同一口径。
 * 真实口径（realHave / realComplete / placeholders）：provider=mock 的占位图不计入「已生成」，
 * 供「没有生成不能标记为已完成」的徽标与验收使用。
 * @returns {{views:object, have:string[], missing:string[], complete:boolean,
 *            coreComplete:boolean, allComplete:boolean, hasSheet:boolean, pct:number,
 *            realHave:string[], placeholders:string[], realComplete:boolean, hasRealSheet:boolean}}
 */
export function characterViewStatus(c = {}, opts = {}) {
  const scope = resolveViewKeys(opts.scope || 'core');
  const views = c.views || {};
  const have = scope.filter((k) => Boolean(views[k]?.url));
  const missing = scope.filter((k) => !views[k]?.url);
  // 占位图：有 url 但 provider=mock —— 界面上要单独标注，不与真实出图混算
  const placeholders = scope.filter((k) => views[k]?.url && !isRealShot(views[k]));
  const realHave = scope.filter((k) => isRealShot(views[k]));
  const coreHave = CORE_VIEW_KEYS.filter((k) => Boolean(views[k]?.url));
  const allHave = ALL_VIEW_KEYS.filter((k) => Boolean(views[k]?.url));
  return {
    views,
    scope,
    have,
    missing,
    placeholders,
    realHave,
    complete: missing.length === 0,
    coreComplete: coreHave.length === CORE_VIEW_KEYS.length,
    allComplete: allHave.length === ALL_VIEW_KEYS.length,
    // 真实口径：全部视图真实出图才算「定妆齐全」
    realComplete: realHave.length === scope.length,
    hasSheet: Boolean(c.sheet?.url),
    hasRealSheet: isRealShot(c.sheet),
    pct: scope.length ? Math.round((have.length / scope.length) * 100) : 0,
    labels: scope.map((k) => ({ key: k, label: viewDef(k)?.label || k, done: Boolean(views[k]?.url) })),
  };
}

/**
 * 整个项目的定妆完整度汇总：角色管理页顶部、导演验收、批量补全都用它。
 * @param {Array} characters
 * @param {object} opts { scope, requireSheet }
 */
export function projectPortraitStatus(characters = [], opts = {}) {
  const list = Array.isArray(characters) ? characters.filter((c) => c?.name) : [];
  const scope = resolveViewKeys(opts.scope || 'core');
  const items = list.map((c) => ({ id: c.id, name: c.name, ...characterViewStatus(c, { scope }) }));
  const totalViews = list.length * scope.length;
  const doneViews = items.reduce((a, it) => a + it.have.length, 0);
  const realDoneViews = items.reduce((a, it) => a + it.realHave.length, 0);
  const placeholderViews = items.reduce((a, it) => a + it.placeholders.length, 0);
  const completeCount = items.filter((it) => it.complete).length;
  const sheetCount = items.filter((it) => it.hasSheet).length;
  return {
    scope,
    characters: items.length,
    totalViews,
    doneViews,
    missingViews: totalViews - doneViews,
    realDoneViews,
    placeholderViews,
    realMissingViews: totalViews - realDoneViews,
    completeCount,
    incompleteCount: items.length - completeCount,
    sheetCount,
    requireSheet: Boolean(opts.requireSheet),
    // 验收口径：全部角色全部视图齐全（+ 需要时定妆板齐全）才算完整
    complete: items.length > 0 && completeCount === items.length
      && (!opts.requireSheet || sheetCount === items.length),
    items,
  };
}

/** LLM 提取输入组装：启发式候选 + 检索召回原文 + 候选上下文窗口 + 分集梗概，总量 cap 12000 字 */
export const EXTRACT_CAP = 12000;
/** 分集梗概预留预算：放在片段之后也不会被 EXTRACT_CAP 截断（覆盖未进候选表的角色） */
export const EXTRACT_SUMMARY_CAP = 1200;

/**
 * 论文式(6) 检索增强：从全书记忆里召回与角色相关的原文片段。
 *
 * 旧实现只取「开头 6000 字 + 每个候选名附近 2 个窗口」——长篇里中后段角色的
 * 外貌/服饰描写几乎必然落空，模型只能靠常识编造（幻觉）。
 * 这里改为：全书 512/128 分块建 BM25 索引 → 以候选角色名 + 分集梗概为线索召回 →
 * 与窗口片段合并去重，让模型看到的是原文证据而非截断片段。
 *
 * @param {string} text 原著全文
 * @param {Array<{name:string}>} candidates 启发式候选角色名
 * @param {Array} episodes 分集梗概
 * @returns {{fragments:Array, text:string}} fragments 为召回片段（含分数），text 为拼好的证据上下文
 */
export function buildCharacterPassages(text, candidates = [], episodes = []) {
  const src = String(text || '');
  const fragments = [];
  if (!src) return { fragments, text: '' };

  const chunks = chunkNovel(src);
  if (!chunks.length) return { fragments, text: '' };
  const kb = new KnowledgeBase(chunks);

  // 检索线索：候选角色名（正）+ 分集标题与梗概（覆盖未进候选表的角色）
  const queries = [];
  for (const c of candidates) {
    if (c?.name) queries.push(String(c.name));
  }
  for (const e of episodes || []) {
    const q = `${e?.title || ''} ${e?.summary || ''}`.trim();
    if (q) queries.push(q);
  }

  // 原文字符区间去重：旧实现用 `f.text.includes(win)` 判定，而召回块是分块后的文本，
  // 与 500 字窗口几乎不可能全串包含，等于没有去重 —— 相邻窗口/召回块会重复占满 token 预算。
  const spans = [];
  const overlapRatio = (a, b) => {
    const lo = Math.max(a.start, b.start);
    const hi = Math.min(a.end, b.end);
    if (hi <= lo) return 0;
    return (hi - lo) / Math.max(1, Math.min(a.end - a.start, b.end - b.start));
  };
  const claim = (start, end) => {
    const span = { start, end };
    if (spans.some((s) => overlapRatio(s, span) > 0.6)) return false;
    spans.push(span);
    return true;
  };

  // 候选名直接定位的原文窗口：保证每个候选至少有一段「他出现时的原文」，
  // BM25 对短名字召回不稳定，用字面定位补齐（对应论文「原文片段」直给）。
  // 两次取样取「首次出现 + 全书最后一次出现」，让长篇中后段的角色描写也能进入证据。
  // 先占区间：窗口是「每个候选必有」的硬证据，优先于可能被同一段文本命中的 BM25 召回块。
  for (const cand of candidates) {
    const name = String(cand?.name || '');
    if (!name) continue;
    const positions = [];
    let from = 0;
    while (positions.length < 64) {
      const at = src.indexOf(name, from);
      if (at < 0) break;
      positions.push(at);
      from = at + name.length;
    }
    if (!positions.length) continue;
    const picks = positions.length > 1 ? [positions[0], positions[positions.length - 1]] : positions;
    for (const at of picks) {
      const start = Math.max(0, at - 250);
      const end = Math.min(src.length, at + name.length + 250);
      if (!claim(start, end)) continue;
      fragments.push({ text: src.slice(start, end), score: 1, kind: 'window', name, start });
    }
  }

  // BM25 召回补位：与窗口重复的块直接跳过，只保留覆盖到别的角色 / 场景的片段
  const recalled = retrieveRelevantChunks(kb, queries, { topK: 6, threshold: 0.55 });
  for (const r of recalled) {
    const at = src.indexOf(r.text);
    if (at >= 0 && !claim(at, at + r.text.length)) continue;
    fragments.push(at >= 0
      ? { text: r.text, score: r.score, kind: 'recall', start: at }
      : { text: r.text, score: r.score, kind: 'recall' });
  }

  return { fragments, text: fragments.map((f) => f.text).join('\n\n') };
}

/** LLM 提取输入组装：论文式(6) 检索召回的原文证据 + 分集梗概，总量 cap 12000 字 */
export function buildExtractVars(project, m, limit = MAX_CHARACTERS) {
  const text = String(m?.source?.text || '');
  // 给模型的候选池要比「最终角色数上限」更宽：过去 candidates 与 limit 同宽（12），
  // 长篇里排第 13 位之后的主角 / 核心配角根本进不了提示词，模型也就无从提取。
  const poolSize = Math.max(24, Math.min(40, (Number(limit) || MAX_CHARACTERS) * 2));
  // hint = 候选名首现原文句，给模型（以及零 Key 兜底）一条可回溯的定位线索
  const candidates = extractCharacters(text, poolSize).map((c) => ({
    name: c.name, hits: c.hits, hint: c.evidence?.[0]?.quote || '',
  }));
  const { fragments } = buildCharacterPassages(text, candidates, m?.episodes || []);

  const summaries = (m?.episodes || [])
    .map((e) => `第${e.no}集《${e.title}》：${e.summary}`).join('\n');
  const summaryBlock = summaries ? `【分集梗概】\n${summaries.slice(0, EXTRACT_SUMMARY_CAP)}` : '';
  // 先给分集梗概预留预算，再按片段顺序填证据。旧实现把梗概放在最后，
  // 长篇原著片段一多就会被 slice(0, EXTRACT_CAP) 整段截掉。
  const budget = EXTRACT_CAP - (summaryBlock ? summaryBlock.length + 2 : 0);
  const parts = [];
  let used = 0;
  for (const f of fragments) {
    const block = f.kind === 'window'
      ? `【「${f.name}」原文片段】\n${f.text}`
      : `【原著相关片段】\n${f.text}`;
    const cost = block.length + 2;   // +2 = join('\n\n')
    if (used + cost > budget) {
      const remain = budget - used;
      if (remain > 160) parts.push(block.slice(0, remain));
      break;
    }
    parts.push(block);
    used += cost;
  }
  if (summaryBlock) parts.push(summaryBlock);

  return {
    title: m?.source?.title || project?.name || '',
    candidates,
    fragments,
    novelText: parts.join('\n\n').slice(0, EXTRACT_CAP),
  };
}

/**
 * 主角兜底：模型（或启发式）漏掉的高频出场角色，用原文频次补回来。
 *
 * 为什么必须在提取之后再做一遍：提示词再怎么写「别漏主角」，模型仍会按自己的
 * 理解删减；而「全书出现 800 次的角色」是客观事实，不该取决于模型心情。
 * 这里只补「完全没被提到」的高频人名（按 name/aliases 任一称呼比对），
 * 补进来的角色只有可溯源原文证据，人设字段留空由用户/后续 LLM 补全，
 * 并标记 source=heuristic + auto=true，便于后续真实 LLM 结果覆盖。
 *
 * 名额满了也要保主角：模型常把 12 个名额全给配角。此时只对「出场 ≥20 次」的
 * 强主线角色强制入列（最多 2 位），挤掉列表末尾的角色并在结果里如实列出，
 * 避免「主角缺席、一堆龙套」这种更糟的结果。
 *
 * @param {Array} extracted 已提取角色
 * @param {string} text 原著全文
 * @param {object} opts { max, minHits, limit, forceHits }
 * @returns {{characters:Array, added:string[], displaced:string[]}}
 */
export function supplementMainCharacters(extracted = [], text = '', opts = {}) {
  const src = String(text || '');
  const max = Math.max(1, Number(opts.max) || MAX_CHARACTERS);
  const minHits = Math.max(3, Number(opts.minHits) || 8);
  const forceHits = Math.max(minHits, Number(opts.forceHits) || 20);
  const list = Array.isArray(extracted) ? extracted.slice() : [];
  const empty = { characters: list, added: [], displaced: [] };
  if (!src) return empty;

  const keyOf = (s) => String(s || '').replace(/[\s《》「」『』"'·]/g, '').toLowerCase();
  const known = new Set();
  for (const c of list) {
    if (c?.name) known.add(keyOf(c.name));
    for (const a of Array.isArray(c?.aliases) ? c.aliases : []) known.add(keyOf(a));
  }

  const added = [];
  const displaced = [];
  const top = mineFrequentNames(src, { minHits, limit: 16 });
  for (const cand of top) {
    if (known.has(keyOf(cand.name))) continue;
    const strong = cand.hits >= forceHits;
    let out = null;
    if (list.length >= max) {
      // 名额已满：只有强主线角色才值得挤掉末尾，且最多挤 2 位
      if (!strong || displaced.length >= 2) break;
      out = list[list.length - 1];
      if (!out?.name) break;
      list.pop();
      displaced.push(out.name);
    }
    const quote = firstSentenceOf(src, cand.name);
    list.push({
      name: cand.name,
      aliases: [],
      role: '主要角色（高频出场，自动补全）',
      appearance: quote ? `原著依据：${quote}` : '',
      evidence: quote ? [{ quote, kind: 'mention' }] : [],
      hits: cand.hits,
      source: 'heuristic',
      auto: true,
    });
    known.add(keyOf(cand.name));
    added.push(cand.name);
  }
  return { characters: list, added, displaced };
}

/** 提取结果按名合并进现有列表：命中同名/别名只补空字段，不覆盖手改；返回新增/合并计数 */
export function mergeExtracted(existing = [], extracted = [], opts = {}) {
  const source = opts.source || 'llm';
  let list = existing.map((c) => normalizeCharacter(c));
  // 自愈：旧版本启发式把「回头 / 刀光 / 冲他」当角色写进项目、或把「沈青崖不」这种
  // 人名+下一句首字的粘连串建成了角色。重新提取时顺手清掉这些「没手改过的启发式脏数据」，
  // 否则修好算法也救不回已经污染的角色表。手改过 / LLM / 手动新增的一律不动。
  const removed = [];
  list = list.filter((c) => {
    if (c.source !== 'heuristic' || c.edited) return true;
    if (!isLikelyPersonName(c.name)) { removed.push(c.name); return false; }
    return true;
  });
  list = list.filter((c) => {
    if (c.source !== 'heuristic' || c.edited) return true;
    for (let len = 2; len < c.name.length; len += 1) {
      const pre = c.name.slice(0, len);
      if (list.some((o) => o !== c && o.name === pre)) { removed.push(c.name); return false; }
    }
    return true;
  });
  let added = 0;
  let merged = 0;
  for (const raw of extracted) {
    // 兜底补进来的角色自带 source=heuristic：即使本次是 LLM 抽取，也不该被标成
    // 「LLM 人设」，否则后续真实 LLM 结果就无法覆盖这些占位字段
    const inc = normalizeCharacter({ ...raw, source: raw?.source || source });
    if (!inc.name) continue;
    const key = charNameKey(inc.name);
    const hit = list.find((c) => charNameKey(c.name) === key
      || c.aliases.some((a) => charNameKey(a) === key)
      || inc.aliases.some((a) => charNameKey(a) === charNameKey(c.name)));
    if (hit) {
      // 启发式来源且用户未手改的角色字段只是占位模板，LLM 结果可覆盖；
      // 手动/已手改/已有 LLM 来源的角色仍遵循「只补空字段不覆盖手改」
      const fromHeuristic = hit.source === 'heuristic' && !hit.edited;
      for (const f of ['role', 'gender', 'age', 'personality', 'appearance', 'staticFeatures', 'dynamicFeatures', 'hair', 'costume', 'props', 'style', 'viewPrompt']) {
        // 派生兜底值（如启发式外观串推导出的固定特征）视为「空」：LLM 给出的真实特征应能替换它
        const isDerived = (f === 'staticFeatures' || f === 'dynamicFeatures')
          && !hit.edited && isDerivedFeature(hit, f);
        if ((!hit[f] || isDerived || fromHeuristic) && inc[f] && inc[f] !== hit[f]) hit[f] = inc[f];
      }
      // 别名取并集：论文要求「同一实体的所有称呼都归并到同一角色」
      const aliasKeys = new Set(hit.aliases.map(charNameKey));
      for (const a of inc.aliases) {
        if (a && !aliasKeys.has(charNameKey(a))) { hit.aliases.push(a); aliasKeys.add(charNameKey(a)); }
      }
      hit.aliases = hit.aliases.slice(0, 6);
      if (!hit.palette.length && inc.palette.length) hit.palette = inc.palette;
      if (!hit.relations.length && inc.relations.length) hit.relations = inc.relations;
      // 证据只补不覆盖：手改角色不应被机器引用覆盖，但空证据要能补上可溯源依据
      if (!hit.evidence.length && inc.evidence.length) hit.evidence = inc.evidence;
      // 启发式占位被真实结果覆盖后，来源应升级为 llm（不再是模板占位）
      if (fromHeuristic && source !== 'heuristic') hit.source = source;
      hit.updatedAt = Date.now();
      merged += 1;
    } else {
      list.push({ ...inc, updatedAt: Date.now() });
      added += 1;
    }
    if (list.length >= MAX_CHARACTERS) break;
  }
  return { characters: list, added, merged, removed };
}
