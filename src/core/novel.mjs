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

/**
 * 从原著抽取候选角色（式(1) 输入归一 / 角色一致性前置）。
 * 零依赖的频次启发式：取「XX说/道/问/看向…」与「XX：『…』」前的 2–3 字中文名，
 * 过滤常见叙述词。抽不到时返回空数组，由 Provider 用主题角色兜底。
 */
export function extractCharacters(text, limit = 4) {
  const s = String(text ?? '').slice(0, 60000);
  const STOP = new Set([
    '他们', '我们', '自己', '忽然', '这时', '没有', '一个', '什么', '只是', '已经', '因为', '于是',
    '然后', '如果', '虽然', '但是', '还是', '这个', '那个', '似乎', '仿佛', '声音', '窗外', '雨水',
    '片刻', '终于', '其实', '当时', '随后', '接着', '突然', '所有', '一切', '对方', '两人', '众人',
    '有人', '不知', '不觉', '缓缓', '轻轻', '慢慢', '微微', '依旧', '仍然', '立刻', '马上', '出来',
    '进来', '过去', '现在', '以后', '之前', '这里', '那里', '心里', '眼中', '手里', '脸上', '身后',
    '一阵', '一声', '一次', '一句', '一直', '一边', '一起', '这些', '那些', '如此', '这样', '那样',
  ]);
  const freq = new Map();
  const patterns = [
    /([\u4e00-\u9fa5]{2,3})(?=(?:说道|说|道|问|答|低声|轻声|抬眼|看向|转身|把|将|拿出|递给|皱眉|笑了|沉默|点头|摇头|听见|想起|站在|坐下|走进|走出))/g,
    /([\u4e00-\u9fa5]{2,3})\s*[：:]\s*[「“"']/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(s))) {
      const name = m[1];
      if (STOP.has(name) || /[第这那每某]/.test(name[0])) continue;
      freq.set(name, (freq.get(name) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, hits]) => ({
      name, role: '原著角色', hits,
      appearance: `原著中出现的「${name}」· 服装 / 发型 / 随身物件跨镜头保持一致`,
    }));
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
