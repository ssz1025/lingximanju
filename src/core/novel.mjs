/* ============================================================================
 * 小说解析与分集 · 纯逻辑层（无 DOM、无第三方依赖、无副作用）
 *
 * 对应 ViMax 论文（arXiv:2606.07649v2）式(1) 输入归一与式(5) 层次化分解的
 * 「前置扩展层」：论文以 8–16 镜头短片为尺度，长篇小说需要先压成「集」这一
 * 中间粒度，事件→场景→镜头每层才能只处理合适规模的上下文。
 * 理论映射见 docs/THEORY.md §4。
 * ==========================================================================*/
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
  const max = opts.maxEpisodes ? clamp(opts.maxEpisodes, 1, 12) : 4;
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
  if (body.length > 2_000_000) return { ok: false, message: '正文超过 2,000,000 字，请先拆分成多个项目' };
  const novel = parseNovel(body, opts.filename || '');
  const episodes = splitEpisodes(novel, opts.split || {});
  return {
    ok: true, novel, episodes,
    message: `已识别 ${novel.chapterCount} 章 / ${novel.totalChars} 字，按策略拆为 ${episodes.length} 集`,
  };
}

/* ---- 候选角色名启发式：说话/动作动词前的中文名 + 对话冒号前的中文名 ---- */
// 说话动词 + 高频动作动词：只有对话的小说能靠「XX说」抽人，纯描写段（「林晚推门而入」）
// 需要靠动作动词才能把首位角色抓出来。长动词排前面，配合惰性量词取到正确边界。
const SPEECH_VERBS = '说道|笑道|喊道|叫道|低声|轻声|抬眼|看向|转身|拿出|递给|皱眉|笑了|沉默|点头|摇头|听见|想起|站在|坐下|走进|走出|握住|放下|接过|推开|推门|迈步|跨进|掀开|拂袖|抬手|低头|抬头|回身|起身|止步|驻足|打量|端详|说|道|问|答|望|盯|瞥|叹|把|将|回|应|推|拉|迈|跨|掀|抽|举|扬|俯|仰|退|蹲|倚|靠|抿|蹙|拂|瞧|瞅|扫|走|跑|看|站|坐';
// 常见叙述词 / 非人名词（旧表扩充：方位、时间、指代、量词、动作补语）
const NAME_STOP = new Set([
  '他们', '我们', '自己', '忽然', '这时', '没有', '一个', '什么', '只是', '已经', '因为', '于是',
  '然后', '如果', '虽然', '但是', '还是', '这个', '那个', '似乎', '仿佛', '声音', '窗外', '雨水',
  '片刻', '终于', '其实', '当时', '随后', '接着', '突然', '所有', '一切', '对方', '两人', '众人',
  '有人', '不知', '不觉', '缓缓', '轻轻', '慢慢', '微微', '依旧', '仍然', '立刻', '马上', '出来',
  '进来', '过去', '现在', '以后', '之前', '这里', '那里', '心里', '眼中', '手里', '脸上', '身后',
  '一阵', '一声', '一次', '一句', '一直', '一边', '一起', '这些', '那些', '如此', '这样', '那样',
  '因为', '所以', '可是', '不过', '而且', '并且', '于是', '随即', '顿时', '忽地', '猛地', '只得',
  '却见', '只见', '但见', '听得', '说罢', '话音', '半晌', '良久', '此时', '此刻', '当下', '次日',
  '第二天', '门外', '门内', '屋外', '屋内', '桌上', '地上', '天上', '远处', '近处', '四周',
]);
// 名字前的身份/修饰前缀：剥掉后才是真正的人名（「少年阿杰说」→「阿杰」）
const NAME_PREFIX = /^(?:少年|少女|年轻|年迈|年老|老|小|那位|那|这位|这|一位|一个|身穿|穿着|白衣|黑衣|年|忽然|这时|随后|接着|突然|于是|然后|片刻|终于|其实|当时|依旧|仍然|立刻|马上|缓缓|轻轻|慢慢|微微|只见|却见|但见)+/;
// 常见姓氏：命中则更像真人名，加权排序；非姓氏的孤例需要更多证据才入选
const SURNAMES = '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤';
// 虚词 / 指代 / 地点组织后缀：含这些的「名字」基本是句子碎片，不是人名
const BAD_NAME_RE = /[的地得了着过们是很最这那每某所有\s\dA-Za-z]/;
const PLACE_SUFFIX = /(?:城|镇|村|府|局|校|店|宫|寺|山|河|街|路|院|楼|站|国|军|队|帮|客栈|酒楼|茶馆|花园|广场|码头|车站|大街|小巷)$/;
// 说话/动作动词的尾字：对话冒号前的「林晚笑道」「阿杰说」不是人名，必须剔除
const VERB_TAIL_RE = /(?:说|道|问|答|笑|喊|叫|望|盯|瞥|叹|把|将|回|应|摇|看|听|想|站|坐|走|握|放|接|推|点|转|拿|递|进|出|声|低|轻|抬|忽|然|后|着)$/;
const IN_NAME_VERB_RE = /[说问答喊叫]/;

function cleanCandidateName(raw) {
  let name = String(raw || '').trim();
  // 反复剥前缀（可能叠加，如「那位少年阿杰」）
  for (let i = 0; i < 3; i += 1) {
    const stripped = name.replace(NAME_PREFIX, '');
    if (!stripped || stripped === name || stripped.length < 2) break;
    name = stripped;
  }
  if (name.length < 2 || name.length > 4) return '';
  return name;
}

function firstSentenceOf(src, name) {
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
 *
 * 抽不到时返回空数组，由 Provider 用主题角色兜底。返回字段向后兼容：
 * name / role / hits / appearance 不变，新增 evidence / firstAt / strict。
 */
export function extractCharacters(text, limit = 4) {
  const s = String(text ?? '');
  if (!s) return [];
  const freq = new Map();      // name → { hits, strict }
  const add = (raw, strict) => {
    const name = cleanCandidateName(raw);
    if (!name || NAME_STOP.has(name) || BAD_NAME_RE.test(name) || PLACE_SUFFIX.test(name)) return;
    if (VERB_TAIL_RE.test(name) || IN_NAME_VERB_RE.test(name)) return;
    if (/^[第这那每某所有]/.test(name)) return;
    const cur = freq.get(name) || { hits: 0, strict: 0 };
    cur.hits += 1;
    if (strict) cur.strict += 1;
    freq.set(name, cur);
  };

  const HAN = '[\\u4e00-\\u9fa5]';
  // 量词用惰性 {2,4}?：先按最短人名匹配，避免「林晚笑道」被贪婪截成「林晚笑」+「道」
  // ① 边界模式用 lookbehind（不消耗前一个字符），避免匹配跳跃把后面真正的人名吞掉
  const boundaryRe = new RegExp(`(?<![\\u4e00-\\u9fa5])(${HAN}{2,4}?)(?=(?:${SPEECH_VERBS}))`, 'g');
  // ② 对话冒号：「林晚：“……”」，冒号天然是边界
  const dialogueRe = new RegExp(`(${HAN}{2,4}?)\\s*[：:]\\s*[「“"']`, 'g');
  // ③ 姓氏锚定：长文本连写（名字前无标点）时从常见姓氏起匹配，补回「顾长风说」这类
  // 总长限 2–3 字（姓 + 1~2 字），避免「老王把钥匙递给…」被截成「王把钥匙」
  const surnameRe = new RegExp(`([${SURNAMES}]${HAN}{1,2}?)(?=(?:${SPEECH_VERBS}))`, 'g');

  for (const [re, strict] of [[boundaryRe, true], [dialogueRe, true], [surnameRe, false]]) {
    let m;
    while ((m = re.exec(s))) add(m[1], strict);
  }
  if (!freq.size) return [];

  const ranked = [...freq.entries()]
    .map(([name, v]) => {
      const surname = SURNAMES.includes(name[0]);
      const score = v.hits + v.strict * 2 + (surname ? 2 : 0);
      return { name, ...v, surname, score };
    })
    // 非姓氏、只出现一次且无严格边界命中的孤例视为噪声（但保证至少留下得分最高者）
    .filter((v) => v.hits >= 2 || v.strict > 0 || v.surname)
    .sort((a, b) => b.score - a.score || b.hits - a.hits || a.name.localeCompare(b.name, 'zh'))
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
  if (list.length > 12) return { ok: false, message: '一次最多导入 12 个文件，请分批上传', text: '', filename: '', sources: [], chapterSources: [] };

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
