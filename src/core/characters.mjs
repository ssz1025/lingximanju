/* ============================================================================
 * 角色域模型：角色属性归一、造型/多视图提示词拼装、LLM 提取输入组装、提取结果合并。
 * 纯逻辑无 I/O（只依赖纯函数 novel.mjs / bm25.mjs），供管理路由、角色智能体与测试复用。
 *
 * 论文对齐（ViMax）：
 *   - CharacterInScene 的 static_features / dynamic_features 二分 → staticFeatures / dynamicFeatures
 *   - character_extractor.py 的抽取方法论 → 见 EXTRACT_GUIDELINES
 *   - 式(6) 检索增强 → buildCharacterPassages 用 BM25 从全书记忆里召回原文片段
 * ==========================================================================*/
import { extractCharacters } from './novel.mjs';
import { chunkNovel, KnowledgeBase, retrieveRelevantChunks } from './bm25.mjs';

/** 角色多视图定义：key 稳定用于 views 字段，angle 注入多视图提示词 */
export const CHARACTER_VIEWS = [
  { key: 'front', label: '正面', angle: '正面平视全身站立' },
  { key: 'side', label: '侧面', angle: '90度侧面全身站立' },
  { key: 'back', label: '背面', angle: '背面全身站立' },
];

/** 列表上限与字段长度上限（防 JSON 注入垃圾数据） */
export const MAX_CHARACTERS = 12;
const LIMITS = {
  name: 20, role: 60, gender: 8, age: 24, personality: 300,
  appearance: 600, hair: 120, costume: 300, props: 200, style: 120, viewPrompt: 600,
  staticFeatures: 400, dynamicFeatures: 400,
};
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[a-zA-Z0-9_-]+$/;

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

function normalizeViews(views) {
  const out = { front: null, side: null, back: null };
  for (const { key } of CHARACTER_VIEWS) {
    const v = views?.[key];
    if (v && typeof v === 'object' && v.url) {
      out[key] = {
        file: String(v.file || '').split('/').pop() || '',
        url: String(v.url).slice(0, 300),
        prompt: String(v.prompt || '').slice(0, 2000),
        provider: String(v.provider || ''),
        at: Number(v.at) || 0,
      };
    }
  }
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
    relations: (Array.isArray(raw.relations) ? raw.relations : [])
      .map((r) => ({ target: cut(r?.target, LIMITS.name), label: cut(r?.label, 30) }))
      .filter((r) => r.target || r.label).slice(0, 8),
    palette: (Array.isArray(raw.palette) ? raw.palette : [])
      .map((c) => String(c).trim()).filter((c) => HEX_RE.test(c)).slice(0, 5),
    viewPrompt: cut(raw.viewPrompt, LIMITS.viewPrompt),
    evidence: normalizeEvidence(raw.evidence),
    views: normalizeViews(raw.views),
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
 * 角色 + 视图 → 多视图提示词。
 * 论文对齐（ViMax CharacterPortraitsGenerator）：
 *   - 正面视图：写明 static/dynamic 特征
 *   - 侧面/背面：以「正面定妆图」为参考，只描述朝向，不重复特征描述，
 *     避免重述文字导致与正面图不一致
 */
export function buildViewPrompt(c = {}, viewKey = 'front', opts = {}) {
  const v = CHARACTER_VIEWS.find((x) => x.key === viewKey) || CHARACTER_VIEWS[0];
  const style = String(opts.style || '').trim();
  const negative = String(opts.negative || '').trim();
  const isFront = v.key === 'front';

  if (!isFront) {
    // 侧面/背面：参考正面图生成，只说朝向与画面要求
    return [
      `角色多视图定妆，${v.angle}，以提供的正面定妆图为唯一外观依据，保持同一人物的脸型/发型/服装/配饰完全一致`,
      v.key === 'back' ? '背面不可见五官' : '',
      '全身入画，纯色背景',
      style && `画面风格：${style}`,
      negative && `避免：${negative}`,
    ].filter(Boolean).join('，') + '。';
  }

  const base = String(c.viewPrompt || '').trim() || buildCharacterPrompt(c) || `${c.name || '角色'}角色设定`;
  // 论文正面模板：Features = "(static) X; (dynamic) Y"，特征二分显式写进提示词
  const staticF = String(c.staticFeatures || '').trim();
  const dynamicF = String(c.dynamicFeatures || '').trim();
  const features = staticF || dynamicF
    ? `固定特征：${staticF || '待补充'}；可变特征：${dynamicF || '待补充'}`
    : '';
  return [
    `角色多视图定妆，${v.angle}，全身入画，纯色背景`,
    base,
    features,
    style && `画面风格：${style}`,
    negative && `避免：${negative}`,
  ].filter(Boolean).join('。') + '。';
}

/** LLM 提取输入组装：启发式候选 + 开头正文 + 候选上下文窗口 + 分集梗概，总量 cap 12000 字 */
export const EXTRACT_CAP = 12000;

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

  const recalled = retrieveRelevantChunks(kb, queries, { topK: 6, threshold: 0.55 });
  for (const r of recalled) fragments.push({ text: r.text, score: r.score, kind: 'recall' });

  // 候选名直接定位的原文窗口：保证每个候选至少有一段「他出现时的原文」，
  // BM25 对短名字召回不稳定，用字面定位补齐（对应论文「原文片段」直给）
  for (const cand of candidates) {
    if (!cand?.name) continue;
    let count = 0;
    let from = 0;
    while (count < 2) {
      const at = src.indexOf(cand.name, from);
      if (at < 0) break;
      const win = src.slice(Math.max(0, at - 250), at + cand.name.length + 250);
      if (!fragments.some((f) => f.text.includes(win))) {
        fragments.push({ text: win, score: 1, kind: 'window', name: cand.name });
      }
      from = at + cand.name.length;
      count += 1;
    }
  }

  return { fragments, text: fragments.map((f) => f.text).join('\n\n') };
}

/** LLM 提取输入组装：论文式(6) 检索召回的原文证据 + 分集梗概，总量 cap 12000 字 */
export function buildExtractVars(project, m, limit = 8) {
  const text = String(m?.source?.text || '');
  const candidates = extractCharacters(text, limit).map((c) => ({ name: c.name, hits: c.hits }));
  const { fragments } = buildCharacterPassages(text, candidates, m?.episodes || []);

  const parts = [];
  for (const f of fragments) {
    parts.push(f.kind === 'window'
      ? `【「${f.name}」原文片段】\n${f.text}`
      : `【原著相关片段】\n${f.text}`);
  }
  const summaries = (m?.episodes || [])
    .map((e) => `第${e.no}集《${e.title}》：${e.summary}`).join('\n');
  if (summaries) parts.push(`【分集梗概】\n${summaries}`);

  return {
    title: m?.source?.title || project?.name || '',
    candidates,
    fragments,
    novelText: parts.join('\n\n').slice(0, EXTRACT_CAP),
  };
}

/** 提取结果按名合并进现有列表：命中同名/别名只补空字段，不覆盖手改；返回新增/合并计数 */
export function mergeExtracted(existing = [], extracted = [], opts = {}) {
  const source = opts.source || 'llm';
  const list = existing.map((c) => normalizeCharacter(c));
  let added = 0;
  let merged = 0;
  for (const raw of extracted) {
    const inc = normalizeCharacter({ ...raw, source });
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
  return { characters: list, added, merged };
}
