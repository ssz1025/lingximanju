/* ============================================================================
 * 每集出场角色对账（Episode Cast Reconciliation）
 *
 * 为什么单独一层：过去「本集出场角色」只是拿已有全局角色库去本集原文里做姓名匹配
 * （episode-model.matchEpisodeCharacters），本集新出现、但全书角色库里没有的人名会被
 * 直接丢掉；而角色提取只在「整个角色库为空」时跑一次，于是中后段登场的人物永远补不进
 * 项目角色库，定妆图、导演包、音色分配都拿不到他们。
 *
 * 本模块只负责纯逻辑（无 I/O、无落盘、无事件）：
 *   1. 汇总本集证据（原文 + 剧本场景/角色/说话人）
 *   2. 抽候选人名并复用全局的角色名清洗口径（isLikelyPersonName / sanitizeCharacterList）
 *   3. 与全局角色库按 name / aliases 对账 → 命中 / 缺失
 *   4. 为缺失者生成「带原文证据的占位角色卡」（零 Key 可用）
 *   5. 合并写入 management.characters（全项目共享），回写 ep.characterIds（本集独立）
 *
 * LLM 生成与落盘编排在 agents/character-agent.mjs，路由只负责 HTTP。
 * 边界：每集独立的只有「出场名单」；角色设定与定妆图仍是全项目共享，不为每集建库。
 * ==========================================================================*/
import { extractCharacters, firstSentenceOf, mineFrequentNames } from './novel.mjs';
import { isLikelyPersonName, sanitizeCharacterList } from './character-names.mjs';
import { MAX_CHARACTERS, charNameKey, mergeExtracted } from './characters.mjs';
import { parseScriptLine } from './screenplay.mjs';

/** 候选人名的最低出场次数：低于此值不自动建角色，避免把一次性动作词当人物 */
export const CAST_MIN_HITS = 2;
/** 单集候选池上限（最终入库仍受 MAX_CHARACTERS 约束） */
export const CAST_CANDIDATE_CAP = 24;
/** LLM 输入语料上限：与全书提取的 EXTRACT_CAP 保持同量级 */
export const CAST_TEXT_CAP = 12000;

/** 舞台指示 / 非人物说话人：剧本里会出现，但不是角色 */
const STAGE_WORDS = new Set([
  '旁白', '画外', '画外音', '字幕', '旁述', '旁白音', '广播', '电话', '系统',
  '未知', '众人', '群众', '观众', '旁白者', '解说', '独白', '内心', '心声',
  '环境', '音效', '声音', '镜头', '特写', '全景', '空镜', '转场',
]);

const str = (v) => String(v ?? '').trim();
const cap = (s, n) => (s.length > n ? s.slice(0, n) : s);

/** 统计一个短名在文本中的出现次数（字面计数，用于证据门槛） */
function countOf(text, name) {
  if (!text || !name) return 0;
  let n = 0;
  let at = 0;
  while ((at = text.indexOf(name, at)) >= 0) { n += 1; at += name.length; }
  return n;
}

/**
 * 从本集剧本里读「显式点名」的角色：最高可信度的出场证据。
 * 覆盖三种写法：script.characters[]（对象或字符串）、scenes[].characters[]、
 * 对白行「角色名：台词」的 speaker。
 * @returns {Map<string,{hits:number,from:string}>}
 */
export function explicitScriptNames(ep = {}) {
  const out = new Map();
  const bump = (raw, from) => {
    const name = str(typeof raw === 'object' ? raw?.name : raw).slice(0, 20);
    if (!name || STAGE_WORDS.has(name) || !isLikelyPersonName(name)) return;
    const cur = out.get(name) || { hits: 0, from };
    cur.hits += 1;
    out.set(name, cur);
  };
  const sc = ep?.script;
  if (!sc || typeof sc !== 'object') return out;
  for (const c of Array.isArray(sc.characters) ? sc.characters : []) bump(c, 'script.characters');
  for (const s of Array.isArray(sc.scenes) ? sc.scenes : []) {
    for (const c of Array.isArray(s?.characters) ? s.characters : []) bump(c, 'scene.characters');
    const lines = Array.isArray(s?.script) ? s.script : str(s?.script).split(/\n+/);
    for (const line of lines) {
      const speaker = str(parseScriptLine(String(line || '')).speaker);
      if (speaker) bump(speaker, 'dialogue');
    }
  }
  return out;
}

/**
 * 汇总本集证据文本。
 *  - text     = 全部证据（原文 + 剧本 + 显式点名清单），用于人名计数与 evidence 逐字校验
 *  - novelText= 喂给 LLM 的语料（不含「点名清单」抬头以外的拼接噪声），已截断
 * @returns {{text:string, novelText:string, sourceText:string, scriptText:string, explicit:string[], hasBody:boolean}}
 */
export function episodeCastSources(ep = {}) {
  const sourceText = str(ep?.text);
  const meta = [ep?.title, ep?.summary, ep?.hook].map(str).filter(Boolean).join('\n');
  const sc = ep?.script;
  const lines = [];
  for (const s of Array.isArray(sc?.scenes) ? sc.scenes : []) {
    const head = [s?.location, s?.time, s?.summary].map(str).filter(Boolean).join(' · ');
    if (head) lines.push(head);
    for (const l of Array.isArray(s?.script) ? s.script : str(s?.script).split(/\n+/)) {
      if (str(l)) lines.push(str(l));
    }
  }
  const scriptText = lines.join('\n');
  const explicit = [...explicitScriptNames(ep).keys()];
  const roster = explicit.length ? `【本集剧本点名】\n${explicit.join('、')}` : '';
  // text 保留全部片段，evidence quote 才可能逐字定位到剧本行
  const text = [sourceText, meta, scriptText, roster].filter(Boolean).join('\n\n');
  const novelText = cap([sourceText, scriptText, roster].filter(Boolean).join('\n\n'), CAST_TEXT_CAP);
  return { text, novelText, sourceText, scriptText, explicit, hasBody: Boolean(sourceText || scriptText) };
}

/**
 * 抽本集候选人名：频次挖掘 + 启发式抽取 + 剧本显式点名，三路合并后统一清洗。
 * 剧本显式点名只需 1 次即可入选（那是编剧/模型写下的确定出场），
 * 纯原文挖掘的名字必须出现 >= minHits 次，避免把一次性动作词建成角色。
 * @returns {Array<{name:string,hits:number,from:string,quote:string}>}
 */
export function collectEpisodeCastCandidates(ep = {}, opts = {}) {
  const minHits = Math.max(1, Number(opts.minHits) || CAST_MIN_HITS);
  const { text } = episodeCastSources(ep);
  if (!text) return [];
  const pool = new Map();
  const bump = (name, hits, from) => {
    if (!name) return;
    const cur = pool.get(name) || { name, hits: 0, from, quote: '' };
    cur.hits = Math.max(cur.hits, Number(hits) || 0);
    // 剧本显式点名优先：它是确定出场信号，优先级高于频次
    if (from.startsWith('script') || from.startsWith('scene') || from === 'dialogue') cur.from = from;
    pool.set(name, cur);
  };
  for (const c of mineFrequentNames(text, { minHits: 1, limit: 40 })) bump(c.name, c.hits, 'frequency');
  for (const c of extractCharacters(text, 40)) bump(c.name, Math.max(Number(c.hits) || 1, minHits), 'heuristic');
  for (const [name, info] of explicitScriptNames(ep)) bump(name, Math.max(info.hits, minHits), info.from);

  const raw = [];
  for (const v of pool.values()) {
    if (STAGE_WORDS.has(v.name) || !isLikelyPersonName(v.name)) continue;
    const hits = countOf(text, v.name);
    const explicit = !['frequency', 'heuristic'].includes(v.from);
    if (hits < (explicit ? 1 : minHits)) continue;
    const quote = firstSentenceOf(text, v.name) || '';
    raw.push({ name: v.name, hits: Math.max(hits, v.hits), from: v.from, quote });
  }
  // 与全书提取共用同一套人名清洗：挡掉非人名词、粘连扩展名、重复称呼
  const cleaned = sanitizeCharacterList(raw, { text, max: CAST_CANDIDATE_CAP });
  return cleaned.characters
    .sort((a, b) => (Number(b.hits) || 0) - (Number(a.hits) || 0))
    .slice(0, CAST_CANDIDATE_CAP);
}

/**
 * 与全局角色库对账（按 name / aliases 归一比较）。
 * @returns {{matched:Array<{id:string,name:string,via:string}>, missing:Array}}
 */
export function diffEpisodeCast(candidates = [], characters = []) {
  const index = new Map();
  for (const c of Array.isArray(characters) ? characters : []) {
    if (!c?.name) continue;
    const keys = [charNameKey(c.name), ...(Array.isArray(c.aliases) ? c.aliases.map(charNameKey) : [])];
    for (const k of keys) if (k && !index.has(k)) index.set(k, c);
  }
  const matched = [];
  const missing = [];
  const seen = new Set();
  for (const cand of Array.isArray(candidates) ? candidates : []) {
    const key = charNameKey(cand?.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const hit = index.get(key);
    if (hit?.id) matched.push({ id: hit.id, name: hit.name, via: cand.name });
    else missing.push(cand);
  }
  return { matched, missing };
}

/** 给 LLM 的本集局部抽取变量：候选 = 只补缺失者，片段 = 每个候选的原文窗口 */
export function episodeCastVars(ep = {}, missing = [], opts = {}) {
  const src = episodeCastSources(ep);
  const list = (Array.isArray(missing) ? missing : []).slice(0, MAX_CHARACTERS);
  const candidates = list.map((c) => ({
    name: c.name, hits: Number(c.hits) || 1,
    hint: cap(str(c.quote) || firstSentenceOf(src.text, c.name), 120),
  }));
  const fragments = [];
  const spans = [];
  for (const c of list) {
    const at = src.text.indexOf(c.name);
    if (at < 0) continue;
    const start = Math.max(0, at - 250);
    const end = Math.min(src.text.length, at + c.name.length + 250);
    if (spans.some((s) => Math.max(s.start, start) < Math.min(s.end, end))) continue;
    spans.push({ start, end });
    fragments.push({ text: src.text.slice(start, end), score: 1, kind: 'window', name: c.name, start });
  }
  if (!fragments.length && src.novelText) fragments.push({ text: src.novelText, score: 1, kind: 'window', start: 0 });
  return {
    title: `${str(opts.title) || '本项目'} · 第 ${Number(ep?.no) || 1} 集 ${str(ep?.title)}`.trim(),
    candidates, fragments, novelText: src.novelText,
  };
}

/**
 * 零 Key / LLM 未覆盖时的启发式角色卡：只写「本集原文依据」，绝不编造人设。
 * 标 source=heuristic 让后续真实 LLM 结果可以覆盖这些占位字段。
 */
export function buildCastCards(missing = [], text = '', opts = {}) {
  const limit = Math.max(0, Number(opts.cap) || MAX_CHARACTERS);
  return (Array.isArray(missing) ? missing : []).slice(0, limit).map((c) => {
    const name = str(c?.name);
    const quote = cap(str(c?.quote) || firstSentenceOf(text, name), 120);
    return {
      name,
      aliases: [],
      role: '本集出场角色（自动补齐，待完善设定）',
      appearance: quote ? `本集原文依据：${quote}` : '',
      evidence: quote ? [{ quote, kind: 'mention' }] : [],
      hits: Number(c?.hits) || 1,
      source: 'heuristic',
      auto: true,
    };
  });
}

/**
 * 把补齐结果写回项目：全局角色库 mergeExtracted + 本集 characterIds。
 * 纯函数（直接改传入的 m / ep 对象，由调用方负责 saveProject）。
 *
 * 容量策略：角色库满 12 位时「不挤人、只提示」——一律不自动删除已有角色，
 * 未入库的名字放进 skipped 由 UI 如实告知用户。
 * 名单策略：本集已有 characterIds（可能是用户手动关联）时只追加新入库角色，
 * 不把用户特意删掉的角色重新加回来；为空时才用自动匹配结果铺满名单。
 */
export function applyEpisodeCast({ m = {}, ep = {}, cards = [], source = 'heuristic', matchedIds = [] } = {}) {
  const existing = Array.isArray(m.characters) ? m.characters : [];
  const beforeIds = new Set(existing.map((c) => c?.id).filter(Boolean));
  const free = Math.max(0, MAX_CHARACTERS - existing.length);
  const take = (Array.isArray(cards) ? cards : []).slice(0, free);
  const skipped = (Array.isArray(cards) ? cards : []).slice(free).map((c) => str(c?.name)).filter(Boolean);
  const merged = mergeExtracted(existing, take, { source });
  m.characters = merged.characters;

  const valid = new Set(m.characters.map((c) => c.id));
  // 已有名单原样保留（包括指向已删除角色的 id）：手动关联过的集不被自动匹配覆盖，
  // 也不擅自「修正」用户的选择；只把本次新入库的角色追加进去。
  const prior = Array.isArray(ep.characterIds)
    ? ep.characterIds.map((id) => String(id)).filter(Boolean) : [];
  const hadCast = prior.length > 0;
  const wanted = new Set(hadCast ? prior : matchedIds.filter((id) => valid.has(String(id))));
  const byName = new Map(m.characters.map((c) => [charNameKey(c.name), c.id]));
  for (const c of take) {
    const id = byName.get(charNameKey(c.name));
    if (id) wanted.add(id);
  }
  ep.characterIds = [...wanted].slice(0, MAX_CHARACTERS);
  ep.updatedAt = Date.now();

  const addedNames = m.characters.filter((c) => !beforeIds.has(c.id)).map((c) => c.name);
  return {
    added: addedNames.length,
    addedNames,
    merged: merged.merged,
    removed: merged.removed || [],
    skipped,
    cast: ep.characterIds.slice(),
    characters: m.characters,
  };
}
