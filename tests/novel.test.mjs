/* 小说解析与分集 · 单元测试
 * 运行：node --test tests/novel.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAPTER_RE, SPLIT_STRATEGIES, parseNovel, splitEpisodes,
  validateNovelInput, extractCharacters, novelPreview,
} from '../src/core/novel.mjs';

/** 结构样本：短，用于校验书名 / 章节识别 */
const SAMPLE = `雨夜来信

第一章 雨夜

林晚收到一封没有署名的信。信上只有一句话：明天雨停之前，来老地方。

她盯着信纸看了很久。窗外的雨敲在玻璃上，像有人用指节轻轻叩门。

第二章 老地方

咖啡馆还亮着灯。角落的位子上坐着一个背对着门的男人，肩膀上落着水。

林晚走过去，在他对面坐下。男人推过来一杯还冒着热气的拿铁。

第三章 回信

他叫沈默。二十年前，他们在这条街上长大，一起在河堤上摔过跤。

那天之后，他再也没有回来过。直到这封信出现在她的门缝下面。

第四章 雨停

雨停了。林晚站起身，走出咖啡馆，回头看了一眼角落那个已经空掉的位子。

街对面的邮筒还开着口。她走过去，把那封信塞了进去，然后松开了手。`;

/**
 * 分集体量样本：4 章 × 4 段 × 每段约 100 字，总量约 1600 字。
 * targetChars 的合法区间是 [300, 8000]，样本必须足够大才能验证真实分组行为。
 */
const LONG = (() => {
  const FILLER = '她把伞收起来，靠在门边，雨水顺着伞尖滴在地板上，一滴，又一滴，久久没有停。';
  const out = ['长夜书简'];
  for (let c = 1; c <= 4; c++) {
    out.push('', `第${['一', '二', '三', '四'][c - 1]}章 第${c}段`, '');
    for (let p = 0; p < 4; p++) {
      out.push(FILLER.repeat(1) + `（第${c}章第${p + 1}段）`);
      out.push('');
    }
  }
  return out.join('\n');
})();

test('CHAPTER_RE 识别中英文与数字章节', () => {
  for (const t of ['第一章', '第 12 集', '第三章 雨夜', 'Chapter 3', 'CHAPTER 7', '1. 开篇']) {
    assert.ok(CHAPTER_RE.test(t), `应识别为章节：${t}`);
  }
  for (const t of ['他走进房间', '第 3 天', '雨夜来信']) {
    assert.ok(!CHAPTER_RE.test(t), `不应识别为章节：${t}`);
  }
});

test('parseNovel 识别书名并抽出章节', () => {
  const n = parseNovel(SAMPLE, 'rain.txt');
  assert.equal(n.title, '雨夜来信', '首行短句应作为书名');
  assert.equal(n.chapterCount, 4);
  assert.equal(n.chapters[0].title, '第一章 雨夜');
  assert.ok(n.totalChars > 200);
  assert.ok(!n.chapters[0].text.includes('第一章'), '章节正文不应含章节标记行');
  assert.ok(n.chapters[0].text.includes('林晚收到一封没有署名的信'), '章节正文应保留原文');
  assert.ok(n.text.includes('第一章'), 'text 保留全文原文（含章节标记），供 RAG 索引');
});

test('parseNovel 无章节标记时归为单块正文', () => {
  const n = parseNovel('一段没有任何章节标记的文字。第二段也是。', 'x.txt');
  assert.equal(n.chapterCount, 1);
  assert.ok(['正文', '开篇'].includes(n.chapters[0].title));
  assert.equal(n.title, 'x', '首行以句号结尾，不应被当成书名');
});

test('parseNovel 空输入不崩溃', () => {
  const n = parseNovel('', '');
  assert.equal(n.chapterCount, 1);
  assert.equal(n.totalChars, 0);
});

test('parseNovel 章节编号连续', () => {
  const n = parseNovel(LONG, 'long.txt');
  assert.equal(n.chapterCount, 4);
  assert.deepEqual(n.chapters.map((c) => c.no), [1, 2, 3, 4]);
  assert.ok(n.totalChars > 700, '长样本应超过 700 字');
});

test('splitEpisodes 按章节聚合且不超过上限', () => {
  const n = parseNovel(LONG, 'long.txt');
  const eps = splitEpisodes(n, { strategy: 'chapter', targetChars: 300, maxEpisodes: 2 });
  assert.equal(eps.length, 2, '不得超过 maxEpisodes');
  assert.ok(eps.every((e) => e.chars > 0));
  assert.ok(eps[0].hook.length > 0, '每集应带结尾钩子');
  assert.equal(eps[0].no, 1);
  assert.equal(eps[1].no, 2);
});

test('splitEpisodes 摘要/钩子/摘录加厚：完整句 + 中部摘录', () => {
  const n = parseNovel(LONG, 'long.txt');
  const eps = splitEpisodes(n, { strategy: 'chapter', targetChars: 300, maxEpisodes: 2 });
  for (const e of eps) {
    assert.ok(e.summary.length > 0 && e.summary.length <= 120, '摘要 ≤120 字（开头完整前两句）');
    assert.ok(e.hook.length > 0 && e.hook.length <= 60, '钩子 ≤60 字（末段完整句）');
    assert.ok(e.excerpt.length > 0 && e.excerpt.length <= 300, '摘录 ≤300 字');
    if (e.chars > 300) {
      assert.notEqual(e.excerpt, e.text.slice(0, 300), '摘录取中部原文而非开头');
    }
  }
});

test('splitEpisodes 尾集吸收溢出内容不丢原文', () => {
  const n = parseNovel(LONG, 'long.txt');
  const eps = splitEpisodes(n, { strategy: 'chapter', targetChars: 300, maxEpisodes: 2 });
  const body = eps.map((e) => e.text).join('\n');
  assert.ok(body.includes('第1章第1段'), '开头应保留');
  assert.ok(body.includes('第4章第4段'), '结尾应保留');
  assert.ok(eps[1].chars >= eps[0].chars - 1, '尾集吸收溢出内容');
});

test('splitEpisodes 按字数均分覆盖全文', () => {
  const n = parseNovel(LONG, 'long.txt');
  const eps = splitEpisodes(n, { strategy: 'fixed', targetChars: 400, maxEpisodes: 12 });
  assert.ok(eps.length >= 2);
  const joined = eps.map((e) => e.text).join('');
  assert.ok(joined.includes('第1章第1段'));
  assert.ok(joined.includes('第4章第4段'));
});

test('splitEpisodes 按场景段落保留边界', () => {
  const n = parseNovel(LONG, 'long.txt');
  const eps = splitEpisodes(n, { strategy: 'scene', targetChars: 300, maxEpisodes: 12 });
  assert.ok(eps.length >= 2, '段落应能聚成多集');
  assert.ok(eps.every((e) => e.title.includes('第')));
  assert.ok(eps.every((e) => e.summary && e.hook));
});

test('splitEpisodes 无效策略回落到 chapter', () => {
  const n = parseNovel(LONG, 'long.txt');
  const eps = splitEpisodes(n, { strategy: '不存在的策略' });
  assert.equal(eps[0].strategy, 'chapter');
});

test('splitEpisodes targetChars 下限被钳到 300', () => {
  const n = parseNovel(LONG, 'long.txt');
  const eps = splitEpisodes(n, { strategy: 'fixed', targetChars: 10, maxEpisodes: 12 });
  assert.ok(eps.length <= 8, `目标字数过小会被钳到 300，实际集数 ${eps.length} 应保持克制`);
});

test('validateNovelInput 拒绝过短正文', () => {
  const r = validateNovelInput('太短了');
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('40'));
});

test('validateNovelInput 通过时返回小说与分集', () => {
  const r = validateNovelInput(LONG, { filename: 'long.txt', split: { strategy: 'chapter', maxEpisodes: 3 } });
  assert.equal(r.ok, true);
  assert.equal(r.novel.chapterCount, 4);
  assert.ok(r.episodes.length >= 1);
  assert.ok(r.message.includes('章'));
});

test('extractCharacters 抽取候选角色', () => {
  const chars = extractCharacters(SAMPLE, 4);
  assert.ok(Array.isArray(chars));
  assert.ok(chars.length <= 4);
  if (chars.length) assert.ok(chars[0].name);
});

test('novelPreview 输出轻量结构且不含全文', () => {
  const n = parseNovel(LONG, 'long.txt');
  const eps = splitEpisodes(n, { strategy: 'chapter', targetChars: 300, maxEpisodes: 3 });
  const p = novelPreview(n, eps);
  assert.equal(p.chapterCount, 4);
  assert.ok(p.episodes.length >= 1);
  assert.ok(!('text' in p), '预览不应包含全文字段');
  const dumped = JSON.stringify(p);
  assert.ok(dumped.length < n.text.length, `预览体量(${dumped.length})应小于原文(${n.text.length})`);
});

test('SPLIT_STRATEGIES 三种策略均有 id/name/hint', () => {
  assert.equal(SPLIT_STRATEGIES.length, 3);
  assert.deepEqual(SPLIT_STRATEGIES.map((s) => s.id), ['chapter', 'fixed', 'scene']);
  assert.ok(SPLIT_STRATEGIES.every((s) => s.name && s.hint));
});
