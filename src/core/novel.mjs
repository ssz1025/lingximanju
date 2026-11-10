/* ============================================================================
 * 小说解析与分集 · 纯逻辑层（无 DOM、无第三方依赖、无副作用）
 *
 * 对应 ViMax 论文（arXiv:2606.07649v2）式(1) 输入归一与式(5) 层次化分解的
 * 「前置扩展层」：论文以 8–16 镜头短片为尺度，长篇小说需要先压成「集」这一
 * 中间粒度，事件→场景→镜头每层才能只处理合适规模的上下文。
 * 理论映射见 docs/THEORY.md §4。
 * ==========================================================================*/
import { isLikelyPersonName, SURNAMES } from './character-names.mjs';

const clamp = (v, a, b) => Math.max(a, Math.min(b, Number(v) || a));
const clean = (s) => String(s ?? '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
const cut = (s, n) => { const t = clean(s); return t.length > n ? `${t.slice(0, n)}…` : t; };
const uid = (p = 'n') => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** 中英文章节标题：第X章 / Chapter 3 / 1. 标题 */
export const CHAPTER_RE = /^\s*(?:第\s*[一二三四五六七八九十百千零〇两0-9]+\s*[章节回卷集部篇](?:\s*[：:\-—.、]?\s*.{0,40})?|Chapter\s+\d+|CHAPTER\s+\d+|[0-9]{1,3}\s*[、.．]\s*.{1,40})\s*$/;

export const SPLIT_STRATEGIES = [
  { id: 'chapter', name: '按章节', hint: '识别「第X章 / Chapter N」，合并短章节到目标字数' },
  { id: 'fixed', name: '按字数', hint: '按固定字数均分，适合没有章节标记的文本' },
  { id: 'scene', name: '按场景段落', hint: '以空行分段为单元聚合，保留场景边界' },
];

/**
 * 解析小说全文 → { title, text, chapters, paragraphs, totalChars, chapterCount }
 * 首行若是短书名（非章节标记、无句末标点）会被识别为标题且不吞进正文。
 */
export function parseNovel(text, filename = '') {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n');
  const allLines = raw.split('\n');
  let title = clean(filename).replace(/\.(txt|md|markdown|json)$/i, '') || '未命名小说';
  let lines = allLines;
  const firstIdx = allLines.findIndex((l) => clean(l));
  const firstLine = firstIdx >= 0 ? clean(allLines[firstIdx]) : '';
  if (firstLine && firstLine.length <= 24 && !CHAPTER_RE.test(firstLine) && !/[。！？!?，,；;]$/.test(firstLine)) {
    title = firstLine;
    lines = allLines.slice(firstIdx + 1);
  }

  const chapters = [];
  let cur = null;
  for (const line of lines) {
    const t = clean(line);
    if (!t) continue;
    if (CHAPTER_RE.test(t) && t.length <= 46) {
      if (cur && clean(cur.text)) chapters.push(cur);
      cur = { no: chapters.length + 1, title: t, text: '', lines: [] };
    } else {
      if (!cur) cur = { no: 1, title: '开篇', text: '', lines: [] };
      cur.lines.push(t);
      cur.text += (cur.text ? '\n' : '') + t;
    }
  }
  if (cur && clean(cur.text)) chapters.push(cur);
  if (!chapters.length) {
    const body = clean(lines.join('\n'));
    chapters.push({ no: 1, title: '正文', text: body, lines: body.split('\n').filter(Boolean) });
  }
  chapters.forEach((c, i) => { c.no = i + 1; c.chars = clean(c.text).length; });

  const bodyText = clean(lines.join('\n'));
  const paragraphs = bodyText.split(/\n+/).map(clean).filter((p) => p.length > 0);
  return {
    id: uid('novel'), title, filename,
    text: clean(raw), chapters, paragraphs,
    totalChars: clean(raw).length, chapterCount: chapters.length,
    paragraphCount: paragraphs.length, parsedAt: Date.now(),
  };
}

function splitByChars(text, size) {
  const s = clean(text);
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/**
 * 分集：把解析结果按策略聚合成「集」。超过 maxEpisodes 时尾部并入最后一集，
 * 保证不丢失原文。每集带摘要、结尾钩子、字数与来源章节，供画布节点和导演包使用。
 */
export function splitEpisodes(novel, opts = {}) {
  const strategy = SPLIT_STRATEGIES.some((s) => s.id === opts.strategy) ? opts.strategy : 'chapter';
  const target = opts.targetChars ? clamp(opts.targetChars, 300, 8000) : 1200;
  // 超长小说（百万字 ≈ 8000 字/集 → 125 集）需要远大于旧上限 12 的集数预算
  const max = opts.maxEpisodes ? clamp(opts.maxEpisodes, 1, 600) : 4;
  let units;
  if (strategy === 'fixed') {
    units = splitByChars(novel.text, target).map((t, i) => ({ title: `片段 ${i + 1}`, text: t }));
  } else if (strategy === 'scene' || (strategy === 'chapter' && novel.chapters.length < 2)) {
    units = novel.paragraphs.map((p, i) => ({ title: `段落 ${i + 1}`, text: p }));
  } else {
    units = novel.chapters.map((c) => ({ title: c.title, text: c.text }));
  }
  if (!units.length) units = [{ title: '正文', text: novel.text || '（空文本）' }];

  // 「按字数」策略的单元已按目标字数切好，直接成集；
  // 章节 / 段落策略则按目标字数把若干单元聚成一集。
  const groups = [];
  if (strategy === 'fixed') {
    for (const u of units) groups.push([u]);
  } else {
    let buf = [];
    let chars = 0;
    for (const u of units) {
      buf.push(u); chars += clean(u.text).length;
      if (chars >= target && groups.length < max - 1) { groups.push(buf); buf = []; chars = 0; }
    }
    if (buf.length) groups.push(buf);
  }
  if (groups.length > max) {
    const tail = groups.slice(max - 1).flat();
    groups.length = max - 1;
    groups.push(tail);
  }

  return groups.map((g, i) => {
    const text = g.map((u) => clean(u.text)).join('\n\n');
    const head = clean(g[0].text);
    const tail = clean(g[g.length - 1].text);
    // 摘要取开头完整前两句（≤120 字）：给下游 LLM 的场景概括保留因果，不再 78 字硬截
    const headSent = head.split(/(?<=[。！？!?])/).map(clean).filter((s) => s.length > 1);
    const summary = cut(headSent.slice(0, 2).join('') || head, 120);
    // 钩子取末段完整句（≤60 字）：完整悬念句比 42 字截断更可读
    const tailSent = tail.split(/(?<=[。！？!?])/).map(clean).filter((s) => s.length > 4);
    const hook = cut(tailSent[tailSent.length - 1] || tail.slice(-60), 60);
    // 摘录取正文中部 300 字：开头给了摘要、结尾给了钩子，中部原文补足叙事细节
    const body = clean(text);
    const start = Math.max(0, Math.floor((body.length - 300) / 2));
    const excerpt = body.length <= 300 ? body : body.slice(start, start + 300);
    return {
      id: uid('ep'), no: i + 1,
      title: `第 ${i + 1} 集 · ${cut(g[0].title, 16)}`,
      sourceTitles: g.map((u) => u.title),
      text, chars: body.length,
      summary, hook, excerpt,
      strategy,
    };
  });
}

/** 预检：向导与创建接口共用，返回可直接展示的中文校验信息 */
export function validateNovelInput(text, opts = {}) {
  const body = String(text ?? '').trim();
  if (body.length < 40) return { ok: false, message: '正文至少需要 40 字，请上传完整小说或粘贴更多内容' };
  if (body.length > 10_000_000) return { ok: false, message: '正文超过 10,000,000 字，请拆分成多个项目分批制作' };
  const novel = parseNovel(body, opts.filename || '');
  const episodes = splitEpisodes(novel, opts.split || {});
  return {
    ok: true, novel, episodes,
    message: `已识别 ${novel.chapterCount} 章 / ${novel.totalChars} 字，按策略拆为 ${episodes.length} 集`,
  };
}

/* ---- 候选角色名启发式：说话/动作动词前的中文名 + 对话冒号前的中文名 ---- */
// 只保留「无歧义的说话动词」：过去把「回 / 把 / 将 / 转 / 站 / 坐 / 走 / 看」这类
// 单字动作也算作分界，于是「（沈砚没有）回头（。）」被切成「回头」、刀光/冲他/朝林外
// 之类全被当成角色。说话动词本身语义就要求「发出者是人」，是最可靠的分界。
//
// 单字「说 / 道」另外加了约束（这是误提取最大的来源）：
//   ① 后面必须紧跟标点或引号 —— 否则「（他在）说话」「（这条）道理」都会被算成说话句；
//   ② 前面不能是「知 / 难 / 味 / 街 / 通 / 听 / 虽 / 小」—— 「但他知道」「难道」「味道」
//      里的「道」不是「说道」，「听说」「虽说」「小说」里的「说」也不是。
//      不加这两条时会把「但他知道」切成角色名「但他知」。
const SPEECH_VERBS = '(?:说道|笑道|喊道|叫道|问道|答道|喝道|叹道|骂道|嚷道|低声道|沉声道|轻声道|冷声道|柔声道|开口道|回答道|补充道|反问道|解释道|嘟囔道|嘀咕道|喃喃道|冷哼一声|冷笑道|苦笑道|低声|轻声|沉声|冷声|柔声|回答|反问|追问|补充|解释|嘟囔|嘀咕|低语|喃喃|冷哼|冷笑|苦笑|喊|叫|吼|骂|嚷|念'
  + '|(?<![知难味街通干听虽小解说])[说道问答](?=[：:，,。！？!?…」』”"\\s]|过|了))';
// 常见姓氏：命中则更像真人名，加权排序；非姓氏的孤例需要更多证据才入选
// （与 character-names.mjs 共用一份，避免两处姓氏表漂移）
// 动作动词：只对「姓氏开头的 2–3 字候选」启用——「沈青崖走」可信，
// 「回头看见」不可信。这样既保住纯描写段落里的主角，又不把动作当人。
const ACTION_VERBS = '走进|走出|走入|推门|推开|转身|抬头|低头|回头|起身|坐下|站起|伸手|迈步|跨进|掀开|拂袖|打量|端详|望向|看向|抬眼|垂眸|走来|走去|跑来|跑去|冲出|拦住|扶住|握住|放下|接过|递给|拿出|掏出|收进|佩着|穿着|披着|站着|坐着|躺着|靠着|倚着|盯着|瞥了|扫了|笑了|哭了|沉默|开口|点头|摇头|皱眉|叹气|走|站|坐|推|拉|握|拿|递|看|望|盯|瞥|听|笑|哭|抬|低|转|回|冲|靠|倚|退|蹲|扑|抓|扯|劈|砍|挥|踢';
// 名字前的身份/修饰前缀：剥掉后才是真正的人名（「少年阿杰说」→「阿杰」）
const NAME_PREFIX = /^(?:少年|少女|年轻|年迈|年老|老|小|那位|那|这位|这|一位|一个|身穿|穿着|白衣|黑衣|年|忽然|这时|随后|接着|突然|于是|然后|片刻|终于|其实|当时|依旧|仍然|立刻|马上|缓缓|轻轻|慢慢|微微|只见|却见|但见)+/;
/** 名字尾部被粘进来的时间/语气副词（「老周曾经说过」→ 先剥掉「曾经」再当人名） */
const NAME_TRAILING = /(?:曾经|已经|终于|忽然|突然|立刻|马上|随即|依然|仍旧|始终|渐渐|连忙|赶紧|急忙|不由|不禁|似乎|仿佛|好像|一直|从来|向来|顿时|当下)+$/;

function cleanCandidateName(raw) {
  let name = String(raw || '').trim();
  // 先剥尾部副词：「老周曾经」直接当名字剥前缀会变成「周曾经」，真名反而丢了
  for (let i = 0; i < 3; i += 1) {
    const trimmed = name.replace(NAME_TRAILING, '');
    if (!trimmed || trimmed === name || trimmed.length < 2) break;
    name = trimmed;
  }
  // 反复剥前缀（可能叠加，如「那位少年阿杰」）
  for (let i = 0; i < 3; i += 1) {
    const stripped = name.replace(NAME_PREFIX, '');
    if (!stripped || stripped === name || stripped.length < 2) break;
    name = stripped;
  }
  if (name.length < 2 || name.length > 4) return '';
  return name;
}

/** 某个字符串在原文里出现多少次（用于「出场频次」排序，主角永远排在最前） */
function countOccurrences(src, name) {
  if (!name) return 0;
  let n = 0;
  let i = 0;
  while ((i = src.indexOf(name, i)) >= 0) {
    n += 1;
    i += name.length;
  }
  return n;
}

/** 常见称谓后缀：用来判断「刘左同（志）」里的最后一个字是不是被多切进来的一刀 */
const HONORIFICS = ['同志', '先生', '小姐', '大人', '姑娘', '少爷', '公子', '师父', '师傅', '老师',
  '前辈', '长老', '掌门', '陛下', '殿下', '将军', '队长', '老板', '夫人', '太太'];

/**
 * 候选名末尾是不是「称谓被切掉一半」：
 *   「刘左同」+ 原文紧随的「志」→「同志」，说明真正的名字是「刘左」。
 * 只用于「短名与长名出现次数相同」的歧义场景，避免把「刘左」这种真名当词干丢掉。
 */
function looksLikeHonorificTail(src, name) {
  if (!name) return false;
  const at = src.indexOf(name);
  if (at < 0) return false;
  const after = src.slice(at + name.length, at + name.length + 2);
  const last = name.slice(-1);
  return HONORIFICS.some((h) => (last + after).startsWith(h));
}

/**
 * 高频人名挖掘：不依赖「名字后面必须紧跟说话动词」这一条线索。
 *
 * 为什么需要：主角在长篇里大量以「刘左同志」「刘左的」「刘左家」等形式出现，
 * 未必紧跟「说/道」。只靠动词邻接，全书出场 800 次的主角会整条漏掉 ——
 * 这正是「主角被漏掉」最主要的技术原因。
 *
 * 做法：姓氏（或老/小/阿/大这类称呼前缀）锚定在词边界上取 2–3 字 n-gram，
 * 过一遍人名可信度判定，再按全书出现次数排序；最后用「前缀消解」去掉
 * 「刘左同（志）」「沈青（崖）」这类被多切一刀的碎片：
 *   - 短名独立出现次数 > 长名 → 长名是「短名 + 尾字」碎片，丢弃
 *   - 短名与长名同频 → 短名只出现在长名内部，丢弃短名
 *
 * @param {string} text 原著全文
 * @param {object} opts { minHits=3, limit=40 }
 * @returns {Array<{name:string, hits:number}>} 按出场次数降序
 */
export function mineFrequentNames(text, opts = {}) {
  const s = String(text || '');
  const minHits = Math.max(1, Number(opts.minHits) || 3);
  const limit = Math.max(1, Number(opts.limit) || 40);
  if (!s) return [];

  const isHan = (ch) => Boolean(ch) && /[\u4e00-\u9fa5]/.test(ch);
  const seeds = new Set();
  for (let i = 0; i < s.length - 1; i += 1) {
    const ch = s[i];
    // 姓氏/称呼前缀必须落在词边界（前一个字符不是汉字），否则「朝林外」会被切成「林外」
    if (i > 0 && isHan(s[i - 1])) continue;
    const surname = SURNAMES.includes(ch);
    const callPrefix = '老小阿大'.includes(ch);
    if (!surname && !callPrefix) continue;
    for (let len = 2; len <= 3; len += 1) {
      const cand = s.slice(i, i + len);
      if (cand.length < len || !/^[\u4e00-\u9fa5]+$/.test(cand)) break;
      if (!isLikelyPersonName(cand)) continue;
      seeds.add(cand);
    }
  }

  const scored = [...seeds]
    .map((name) => ({ name, hits: countOccurrences(s, name) }))
    .filter((v) => v.hits >= minHits);
  if (!scored.length) return [];

  const hitsOf = new Map(scored.map((v) => [v.name, v.hits]));
  // ① 短名独立出现更多 → 长名只是碎片
  const noFragments = scored.filter((v) => {
    for (let len = 2; len < v.name.length; len += 1) {
      if ((hitsOf.get(v.name.slice(0, len)) || 0) > v.hits) return false;
    }
    return true;
  });
  // ② 短名与长名同频 → 需要分清谁是碎片：
  //    「沈青 / 沈青崖」→ 沈青只是被截断的词干，丢短名；
  //    「刘左 / 刘左同（志）」→ 长名末尾是称谓残字，丢长名。
  const noStems = noFragments.filter((v) => !noFragments.some((k) => (
    k.name.length > v.name.length && k.name.startsWith(v.name) && k.hits === v.hits
    && !looksLikeHonorificTail(s, k.name)
  )));
  const withoutHonorificFragments = noStems.filter((v) => !(
    looksLikeHonorificTail(s, v.name) && noStems.some((k) => v.name.startsWith(k.name) && k.name.length < v.name.length)
  ));

  return withoutHonorificFragments
    .sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name, 'zh'))
    .slice(0, limit);
}


export function firstSentenceOf(src, name) {
  const at = src.indexOf(name);
  if (at < 0) return '';
  let start = at;
  for (let i = at - 1; i >= 0 && at - i <= 160; i -= 1) {
    if (/[。！？!?\n「」“”]/.test(src[i])) { start = i + 1; break; }
  }
  let end = at + name.length;
  for (let i = end; i < src.length && i - at <= 160; i += 1) {
    if (/[。！？!?\n]/.test(src[i])) { end = i + 1; break; }
  }
  return src.slice(start, end).trim().slice(0, 120);
}

/**
 * 从原著抽取候选角色（式(1) 输入归一 / 角色一致性前置）。
 *
 * 零依赖的频次启发式，相较旧实现：
 *  - 全书扫描（旧实现只取前 60000 字，长篇中后段角色必然漏掉）
 *  - 名字放宽到 2–4 字并剥离身份修饰前缀，修正「少年阿杰说」被截成「年阿杰」的边界误捕
 *  - 名字前是标点/行首的「严格边界」命中加权更高；常见姓氏加权；虚词/地点后缀过滤
 *  - 每位候选附首现原文句子作为 evidence（可溯源），供零 Key 兜底与证据校验复用
 *  - 只把「说话动词」当强分界，动作动词只用于姓氏开头的候选；非人名（回头/刀光/冲他）
 *    与「人名+下一句首字」的粘连扩展名（沈青崖不）都会被剔除
 *
 * 抽不到时返回空数组，由 Provider 用主题角色兜底。返回字段向后兼容：
 * name / role / hits / appearance 不变，新增 evidence / firstAt / strict。
 */
export function extractCharacters(text, limit = 4) {
  const s = String(text ?? '');
  if (!s) return [];
  const freq = new Map();      // name → { strict, speech, action, mined }
  const add = (raw, kind) => {
    const name = cleanCandidateName(raw);
    if (!name) return;
    // 统一的人名可信度判定（与 LLM 结果清洗同一套规则）
    if (!isLikelyPersonName(name)) return;
    const cur = freq.get(name) || { strict: 0, speech: 0, action: 0, mined: false };
    if (kind !== 'surname-action') cur.strict += 1;
    if (kind === 'speech' || kind === 'dialogue') cur.speech += 1;
    if (kind === 'surname-action') cur.action += 1;
    if (kind === 'frequency') cur.mined = true;
    freq.set(name, cur);
  };

  const HAN = '[\\u4e00-\\u9fa5]';
  const surnameClass = `[${SURNAMES}]`;
  // ① 说话动词前的名字：叙述里最常见、最可靠的「这个人是说话者」信号
  const boundaryRe = new RegExp(`(?<![\\u4e00-\\u9fa5])(${HAN}{2,4}?)(?=${SPEECH_VERBS})`, 'g');
  // ② 对话冒号：「林晚：“……”」，冒号天然是边界（同样要求名字落在词边界上，
  //    否则「沈砚终于开口：」会把冒号前两个字「开口」当成角色）
  const dialogueRe = new RegExp(`(?<![\\u4e00-\\u9fa5])(${HAN}{2,4}?)\\s*[：:]\\s*[「“"']`, 'g');
  // ③ 姓氏锚定 + 动作动词：补回「沈青崖推门而入」这类没有台词的段落，
  //    总长限 2–3 字（姓 + 1~2 字），且必须位于词边界（前一个字符不是汉字）。
  //    没有边界约束时「朝林外跑去」「林夏已经站在」会被切成「林外」「夏已经」。
  const surnameActionRe = new RegExp(`(?<![\\u4e00-\\u9fa5])(${surnameClass}${HAN}{1,2}?)(?=(?:${ACTION_VERBS}))`, 'g');

  for (const [re, kind] of [[boundaryRe, 'speech'], [dialogueRe, 'dialogue'], [surnameActionRe, 'surname-action']]) {
    let m;
    while ((m = re.exec(s))) add(m[1], kind);
  }
  // ④ 高频人名补扫：主角未必紧跟「说/道」（「刘左同志」「刘左的」），
  //    漏掉动词邻接线索就会整条漏人，这里按全书出场频次兜住。
  //    挖掘结果已经过人名可信度判定，不再走 cleanCandidateName 的前缀剥离——
  //    否则「老周曾」会被剥成「周曾」，反而造出新的碎片。
  for (const m of mineFrequentNames(s, { minHits: 3, limit: 80 })) {
    const cur = freq.get(m.name) || { strict: 0, speech: 0, action: 0, mined: false };
    cur.mined = true;
    freq.set(m.name, cur);
  }
  if (!freq.size) return [];

  const scored = [...freq.entries()]
    .map(([name, v]) => {
      const surname = SURNAMES.includes(name[0]);
      // hits 用「全书出现次数」而不是「匹配到几次」：主角高频出场自然排前面，
      // 也让「沈砚 vs 沈砚终于」这类长短候选的取舍有可比的量化依据
      const hits = countOccurrences(s, name);
      const score = hits + v.speech * 4 + v.strict * 2 + (surname ? 2 : 0);
      return { name, hits, strict: v.strict, speech: v.speech, surname, mined: v.mined, score };
    })
    // 非姓氏候选必须在「说话/对话」语境里出现过，或作为高频称呼被挖掘到
    // （屁哥 / 阿杰 这类绰号靠出场频次自证）；纯动作碎片（刀光/朝林外）不入选
    .filter((v) => v.surname || v.speech > 0 || (v.mined && v.hits >= 3))
    .filter((v) => v.hits > 0)
    .sort((a, b) => b.score - a.score || b.hits - a.hits || a.name.localeCompare(b.name, 'zh'));

  // 长短候选消歧（比旧的 dropExtendedNames 更准：旧规则只要短名存在就丢长名，
  // 会把「沈青崖」这种三字真名错杀成「沈青」）：
  //   短名出现次数 > 长名 → 长名是「短名 + 尾字」碎片（刘左同 → 刘左 + 同）
  //   短名与长名同频   → 短名从不独立出现，丢掉短名（沈青 → 沈青崖）
  const hitsOf = new Map(scored.map((v) => [v.name, v.hits]));
  const noFragments = scored.filter((v) => {
    for (let len = 2; len < v.name.length; len += 1) {
      if ((hitsOf.get(v.name.slice(0, len)) || 0) > v.hits) return false;
    }
    return true;
  });
  const ranked = noFragments
    .filter((v) => !noFragments.some((k) => (
      k.name.length > v.name.length && k.name.startsWith(v.name) && k.hits === v.hits
      && !looksLikeHonorificTail(s, k.name)
    )))
    .filter((v) => !(looksLikeHonorificTail(s, v.name)
      && noFragments.some((k) => v.name.startsWith(k.name) && k.name.length < v.name.length)))
    .filter((v) => isLikelyPersonName(v.name))
    .slice(0, Math.max(1, limit));

  return ranked.map(({ name, hits, strict }) => {
    const quote = firstSentenceOf(s, name);
    return {
      name, role: '原著角色', hits, strict,
      firstAt: s.indexOf(name),
      evidence: quote ? [{ quote, kind: 'mention' }] : [],
      appearance: `原著中出现的「${name}」· 服装 / 发型 / 随身物件跨镜头保持一致`,
    };
  });
}

/* ---------------------------------------------------------------------------
 * 多文件导入：把若干 .txt/.md 合成一份可解析的原著，同时保留「章节 ↔ 文件」出处。
 *
 * 单文件：原文直用（不改写标题），只为每章补 sourceName。
 * 多文件：每章标题重写为「第N章：《文件名》原标题」，保证全局唯一且可被
 *         CHAPTER_RE 识别；这样 splitEpisodes 的 sourceTitles 能精确回溯到文件。
 * 纯函数，不落盘、不读文件（读文件由浏览器 FileReader 完成）。
 * -------------------------------------------------------------------------*/
export function mergeNovelFiles(files = []) {
  const list = (Array.isArray(files) ? files : [])
    .map((f) => ({ name: clean(f?.name) || '未命名文件.txt', text: String(f?.text ?? '') }))
    .filter((f) => f.text.trim());
  if (!list.length) return { ok: false, message: '没有可导入的文件内容', text: '', filename: '', sources: [], chapterSources: [] };
  // 超长小说常按卷 / 章拆成上百个 txt；200 个文件足够覆盖，同时防滥用
  if (list.length > 200) return { ok: false, message: '一次最多导入 200 个文件，请合并小文件后再上传', text: '', filename: '', sources: [], chapterSources: [] };

  const stem = (name) => cut(name.replace(/\.(txt|md|markdown|json)$/i, ''), 12) || '文件';
  const sources = [];
  const chapterSources = [];
  const blocks = [];
  let chapterNo = 0;

  if (list.length === 1) {
    const f = list[0];
    const parsed = parseNovel(f.text, f.name);
    const chapters = parsed.chapters.length ? parsed.chapters : [{ no: 1, title: '正文', text: parsed.text, chars: parsed.text.length }];
    for (const c of chapters) chapterSources.push({ title: c.title, sourceName: f.name, chars: clean(c.text).length });
    sources.push({ name: f.name, chars: clean(f.text).length, chapterTitles: chapters.map((c) => c.title) });
    return {
      ok: true, text: f.text, filename: f.name, sources, chapterSources,
      message: `已载入「${f.name}」· ${chapterSources.length} 章`,
    };
  }

  for (const f of list) {
    const parsed = parseNovel(f.text, f.name);
    const own = parsed.chapters.length ? parsed.chapters : [{ title: '正文', text: parsed.text, lines: [] }];
    const hasRealChapters = own.length > 1 || !/^(正文|开篇)$/.test(own[0].title);
    const units = hasRealChapters
      ? own.map((c) => ({ title: c.title, text: clean(c.text) }))
      : [{ title: '正文', text: clean(own.map((c) => c.text).join('\n')) }];
    const titles = [];
    for (const u of units) {
      if (!clean(u.text)) continue;
      chapterNo += 1;
      // 「：」是 CHAPTER_RE 允许的标题分隔符，长度控制在 46 字内确保可被识别
      const title = `第${chapterNo}章：《${stem(f.name)}》${cut(u.title, 22)}`;
      titles.push(title);
      blocks.push(`${title}\n${clean(u.text)}`);
      chapterSources.push({ title, sourceName: f.name, chars: clean(u.text).length });
    }
    sources.push({ name: f.name, chars: clean(f.text).length, chapterTitles: titles });
  }
  if (!blocks.length) return { ok: false, message: '文件内容为空，无法导入', text: '', filename: '', sources: [], chapterSources: [] };
  return {
    ok: true,
    text: blocks.join('\n\n'),
    filename: `${list.length} 个文件合辑.txt`,
    sources, chapterSources,
    message: `已合并 ${list.length} 个文件 · ${chapterNo} 章 · ${clean(blocks.join('')).length} 字`,
  };
}

/** 只返回轻量预览（不含全文），避免向导预览把整本小说塞进 DOM */
export function novelPreview(novel, episodes) {
  return {
    title: novel.title, filename: novel.filename,
    totalChars: novel.totalChars, chapterCount: novel.chapterCount,
    paragraphCount: novel.paragraphCount,
    chapterTitles: novel.chapters.slice(0, 12).map((c) => c.title),
    episodeCount: episodes.length,
    episodes: episodes.map((e) => ({ no: e.no, title: e.title, chars: e.chars, summary: e.summary, hook: e.hook, sourceTitles: e.sourceTitles })),
  };
}
