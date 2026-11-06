/* ============================================================================
 * 角色域模型：角色属性归一、造型/多视图提示词拼装、LLM 提取输入组装、提取结果合并。
 * 纯逻辑无 I/O（只依赖纯函数 novel.mjs），供管理路由、角色智能体与测试复用。
 * ==========================================================================*/
import { extractCharacters } from './novel.mjs';

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
  appearance: 600, hair: 120, costume: 300, props: 200, viewPrompt: 600,
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

/** 归一角色对象：补齐缺字段、截断超长文本、过滤非法 palette；保留已有 id/source/views */
export function normalizeCharacter(raw = {}) {
  const aliases = Array.isArray(raw.aliases) ? raw.aliases : String(raw.aliases || '').split(/[,，、]/);
  return {
    id: ID_RE.test(String(raw.id || '')) ? String(raw.id) : genId(),
    name: cut(raw.name, LIMITS.name),
    aliases: aliases.map((a) => cut(a, LIMITS.name)).filter(Boolean).slice(0, 6),
    role: cut(raw.role, LIMITS.role),
    gender: cut(raw.gender, LIMITS.gender),
    age: cut(raw.age, LIMITS.age),
    personality: cut(raw.personality, LIMITS.personality),
    appearance: cut(raw.appearance, LIMITS.appearance),
    hair: cut(raw.hair, LIMITS.hair),
    costume: cut(raw.costume, LIMITS.costume),
    props: cut(raw.props, LIMITS.props),
    relations: (Array.isArray(raw.relations) ? raw.relations : [])
      .map((r) => ({ target: cut(r?.target, LIMITS.name), label: cut(r?.label, 30) }))
      .filter((r) => r.target || r.label).slice(0, 8),
    palette: (Array.isArray(raw.palette) ? raw.palette : [])
      .map((c) => String(c).trim()).filter((c) => HEX_RE.test(c)).slice(0, 5),
    viewPrompt: cut(raw.viewPrompt, LIMITS.viewPrompt),
    views: normalizeViews(raw.views),
    source: ['llm', 'heuristic', 'manual'].includes(raw.source) ? raw.source : 'manual',
    hits: Number(raw.hits) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

/** 角色属性 → 造型描述串（供角色造型智能体 / 图像提示词复用） */
export function buildCharacterPrompt(c = {}) {
  const parts = [];
  if (c.name) parts.push(`角色「${c.name}」`);
  if (c.role) parts.push(`身份定位：${c.role}`);
  if (c.gender || c.age) parts.push(`性别年龄：${[c.gender, c.age].filter(Boolean).join('，')}`);
  if (c.appearance) parts.push(`外貌：${c.appearance}`);
  if (c.hair) parts.push(`发型：${c.hair}`);
  if (c.costume) parts.push(`服装：${c.costume}`);
  if (c.props) parts.push(`随身物件：${c.props}`);
  if (c.personality) parts.push(`性格：${c.personality}`);
  if (c.palette?.length) parts.push(`配色：${c.palette.join(' / ')}`);
  return parts.join('；');
}

/** 角色 + 视图 → 多视图提示词：viewPrompt 优先，其次按属性自动拼装，再拼画面风格/负面串 */
export function buildViewPrompt(c = {}, viewKey = 'front', opts = {}) {
  const v = CHARACTER_VIEWS.find((x) => x.key === viewKey) || CHARACTER_VIEWS[0];
  const base = String(c.viewPrompt || '').trim() || buildCharacterPrompt(c) || `${c.name || '角色'}角色设定`;
  const style = String(opts.style || '').trim();
  const negative = String(opts.negative || '').trim();
  return [
    `角色多视图定妆，${v.angle}，全身入画，纯色背景`,
    base,
    style && `画面风格：${style}`,
    negative && `避免：${negative}`,
  ].filter(Boolean).join('。') + '。';
}

/** LLM 提取输入组装：启发式候选 + 开头正文 + 候选上下文窗口 + 分集梗概，总量 cap 12000 字 */
export const EXTRACT_CAP = 12000;
export function buildExtractVars(project, m, limit = 8) {
  const text = String(m?.source?.text || '');
  const candidates = extractCharacters(text, limit).map((c) => ({ name: c.name, hits: c.hits }));
  const parts = [`【小说开头】\n${text.slice(0, 6000)}`];
  for (const cand of candidates) {
    let count = 0;
    let from = 0;
    while (count < 2) {
      const at = text.indexOf(cand.name, from);
      if (at < 0) break;
      parts.push(`【「${cand.name}」出现的片段】\n${text.slice(Math.max(0, at - 250), at + cand.name.length + 250)}`);
      from = at + cand.name.length;
      count += 1;
    }
  }
  const summaries = (m?.episodes || [])
    .map((e) => `第${e.no}集《${e.title}》：${e.summary}`).join('\n');
  if (summaries) parts.push(`【分集梗概】\n${summaries}`);
  return {
    title: m?.source?.title || project?.name || '',
    candidates,
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
      for (const f of ['role', 'gender', 'age', 'personality', 'appearance', 'hair', 'costume', 'props', 'viewPrompt']) {
        if (!hit[f] && inc[f]) hit[f] = inc[f];
      }
      if (!hit.aliases.length && inc.aliases.length) hit.aliases = inc.aliases;
      if (!hit.palette.length && inc.palette.length) hit.palette = inc.palette;
      if (!hit.relations.length && inc.relations.length) hit.relations = inc.relations;
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
