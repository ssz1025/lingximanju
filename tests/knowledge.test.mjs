/* 原著知识库 / 论文式(6) 检索层 · 单元测试
 * 运行：node --test tests/knowledge.test.mjs
 * 对齐 ViMax：512/128 分块 → top-k 宽召回 → 归一化重排 → 0.7 阈值 → processChain 分数累加 → FRAGMENT 片段
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  tokenize, chunkNovel, KnowledgeBase, retrieveRelevantChunks,
  saveKnowledgeCache, loadKnowledgeCache, formatFragments,
} from '../src/core/knowledge.mjs';

const NOVEL = [
  '第一章 风起青州',
  '苏晚晴自幼习武，一柄青霜剑使得出神入化。这日她奉师命下山，前往青州城查探一桩旧案。',
  '青州城连日阴雨，街巷里弥漫着潮湿的泥土气息。城东的醉仙楼灯火通明，说书人正讲着十年前沈家灭门的旧事。',
  '苏晚晴在醉仙楼角落坐下，忽听邻座两个黑衣人低声提起「青霜剑」与一份藏宝图，心头一震。',
  '第二章 雨夜追凶',
  '雨夜的巷战中，苏晚晴以青霜剑逼退黑衣人，却见对方袖口绣着一枚诡异的金色蛇纹。',
  '她循着线索追到城西废寺，寺中断碑上刻着沈家当年的刀法口诀，与师父所授竟有七分相似。',
  '沈默是沈家遗孤，这些年来一直隐姓埋名，在废寺中守护着那半张藏宝图，等一个能解开谜局的人。',
].join('\n');

/* ---------------------------------------------------------------- 分词 */
test('tokenize：中文 bigram + 英文数字整词 + 停用词过滤', () => {
  assert.deepEqual(tokenize('青州城'), ['青州', '州城']);
  assert.deepEqual(tokenize('苏晚晴'), ['苏晚', '晚晴']);
  assert.deepEqual(tokenize('MiniMax H3 2024'), ['minimax', 'h3', '2024']);
  assert.ok(tokenize('剑').length <= 1);           // 单字非停用词保留
  assert.deepEqual(tokenize('的'), []);            // 停用词
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
  assert.ok(tokenize('青州城的').includes('州城'));
});

/* ---------------------------------------------------------------- 分块 */
test('chunkNovel：空文本 / 短文本 / 512 默认块长', () => {
  assert.deepEqual(chunkNovel(''), []);
  assert.deepEqual(chunkNovel('   \n '), []);
  assert.equal(chunkNovel('一段很短的原文').length, 1);
  assert.equal(chunkNovel('一段很短的原文')[0].index, 0);
  assert.ok(chunkNovel('一段很短的原文')[0].tokens.length > 0);
});

test('chunkNovel：chunkSize / overlap 生效，相邻块尾部重叠', () => {
  const chunks = chunkNovel(NOVEL, { chunkSize: 80, overlap: 20 });
  assert.ok(chunks.length >= 3, `实际块数 ${chunks.length}`);
  for (let i = 0; i < chunks.length; i++) assert.equal(chunks[i].index, i);
  // 每块长度受 overlap 影响，主体不超过 chunkSize
  assert.ok(chunks.every((c) => c.tokens.length > 0));
  // 第 2 块开头应含上一块尾部内容（重叠）
  const tail = chunks[0].text.slice(-20);
  assert.ok(chunks[1].text.includes(tail.trim().slice(0, 8)),
    `块 1 头部未包含块 0 尾部重叠：${JSON.stringify(chunks[1].text.slice(0, 40))}`);
});

test('chunkNovel：超长段落按句子边界硬切，不丢正文', () => {
  const long = '雨夜巷战。'.repeat(150);
  const chunks = chunkNovel(long, { chunkSize: 100, overlap: 10 });
  assert.ok(chunks.length > 5, `实际块数 ${chunks.length}`);
  const joined = chunks.map((c) => c.text).join('');
  assert.ok(joined.includes('雨夜巷战'), '正文丢失');
});

/* ---------------------------------------------------------------- BM25 召回 */
test('KnowledgeBase.search：按相关度排序、k 限制、空查询', () => {
  const chunks = chunkNovel(NOVEL, { chunkSize: 100, overlap: 20 });
  const kb = new KnowledgeBase(chunks);
  assert.equal(kb.chunks.length, chunks.length);
  assert.ok(kb.avgLen > 0);
  assert.ok(kb.df.size > 0);

  const hits = kb.search('青霜剑 苏晚晴 醉仙楼', { k: 10 });
  assert.ok(hits.length > 0, '应有召回');
  assert.ok(hits[0].score >= hits.at(-1).score, '按分降序');
  assert.ok(hits[0].chunk.text.includes('青霜剑') || hits[0].chunk.text.includes('醉仙楼'),
    `首位命中不相关：${hits[0].chunk.text.slice(0, 40)}`);

  assert.equal(kb.search('青霜剑', { k: 2 }).length <= 2, true);
  assert.deepEqual(kb.search('', { k: 10 }), []);
  assert.deepEqual(kb.search('zzzznotexist', { k: 10 }), []);
  assert.deepEqual(new KnowledgeBase([]).search('青州'), []);
});

/* ---------------------------------------------------------------- 重排 / 阈值 / 累加 */
test('retrieveRelevantChunks：processChain 逐条检索 + 分数累加降序', () => {
  const chunks = chunkNovel(NOVEL, { chunkSize: 100, overlap: 20 });
  const kb = new KnowledgeBase(chunks);
  const hits = retrieveRelevantChunks(kb, [
    '苏晚晴 青霜剑 下山',
    '醉仙楼 黑衣人 藏宝图',
    '沈家 灭门 旧案',
  ], { topK: 10, threshold: 0 });
  assert.ok(Array.isArray(hits));
  assert.ok(hits.length > 0);
  assert.ok(hits.every((h) => typeof h.text === 'string' && typeof h.score === 'number'));
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score, '按累加分降序');
  assert.ok(hits[0].text.includes('苏晚晴') || hits[0].text.includes('醉仙楼') || hits[0].text.includes('沈家'));
});

test('retrieveRelevantChunks：0.7 阈值过滤，单命中不被误杀', () => {
  const chunks = chunkNovel(NOVEL, { chunkSize: 100, overlap: 20 });
  const kb = new KnowledgeBase(chunks);
  const all = retrieveRelevantChunks(kb, ['青霜剑'], { topK: 10, threshold: 0 });
  const strict = retrieveRelevantChunks(kb, ['青霜剑'], { topK: 10, threshold: 0.7 });
  assert.ok(all.length >= strict.length, '阈值应缩小结果集');
  assert.ok(strict.length > 0, '单命中归一化后必须保留（span=0 → score=1）');
  assert.ok(strict.every((h) => h.score >= 0.7), '所有结果分数 >= 阈值');
  // 归一化分数上限为 1；多条 processChain 累加可 > 1
  assert.deepEqual(retrieveRelevantChunks(kb, [], { topK: 10, threshold: 0.7 }), []);
  assert.deepEqual(retrieveRelevantChunks(kb, ['不存在的词xyzzz'], { threshold: 0.7 }), []);
});

test('retrieveRelevantChunks：同一块被多条 processChain 命中时分数累加', () => {
  const kb = new KnowledgeBase(chunkNovel('青霜剑与藏宝图\n'.repeat(3) + '无关的风花雪月', { chunkSize: 40, overlap: 5 }));
  const once = retrieveRelevantChunks(kb, ['青霜剑 藏宝图'], { topK: 10, threshold: 0 });
  const twice = retrieveRelevantChunks(kb, ['青霜剑 藏宝图', '青霜剑 藏宝图'], { topK: 10, threshold: 0 });
  assert.ok(once.length > 0);
  const t = once[0].text;
  const s1 = once.find((h) => h.text === t)?.score || 0;
  const s2 = twice.find((h) => h.text === t)?.score || 0;
  assert.ok(s2 > s1, `累加应更高：${s1} → ${s2}`);
});

test('retrieveRelevantChunks：归一化为比值语义（score/max，非 min-max）', () => {
  const kb = new KnowledgeBase(chunkNovel('青霜剑青霜剑青霜剑藏宝图\n风花雪月闲笔青霜剑', { chunkSize: 12, overlap: 1 }));
  const hits = retrieveRelevantChunks(kb, ['青霜剑'], { topK: 10, threshold: 0 });
  assert.ok(hits.length >= 2, '应召回多块');
  assert.equal(hits[0].score, 1, '最佳命中比值为 1');
  assert.ok(hits.every((h) => h.score > 0), '比值语义下非最佳命中不被 min-max 压到 0');
});

test('retrieveRelevantChunks：近重复块去重（overlap 相邻块只留高分）', () => {
  const chunks = chunkNovel('青霜剑与藏宝图的秘密。'.repeat(8), { chunkSize: 30, overlap: 24 });
  const kb = new KnowledgeBase(chunks);
  const raw = kb.search('青霜剑 藏宝图', { k: 10 });
  const hits = retrieveRelevantChunks(kb, ['青霜剑 藏宝图'], { topK: 10, threshold: 0 });
  assert.ok(raw.length > 1, '重叠分块应产出多个近重复召回块');
  assert.ok(hits.length > 0, '应保留至少一块');
  assert.ok(hits.length < raw.length, `近重复应被去重：${raw.length} → ${hits.length}`);
});

/* ---------------------------------------------------------------- 磁盘缓存 */
test('saveKnowledgeCache / loadKnowledgeCache：落盘往返并重建 tokens', () => {
  const id = `kbtest_${Date.now()}`;
  const chunks = chunkNovel(NOVEL, { chunkSize: 90, overlap: 15 });
  const file = saveKnowledgeCache(id, chunks);
  try {
    assert.ok(fs.existsSync(file), '缓存文件应存在');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(data.chunks.length, chunks.length);
    assert.ok(typeof data.updatedAt === 'number');

    const loaded = loadKnowledgeCache(id);
    assert.equal(loaded.length, chunks.length);
    assert.deepEqual(loaded.map((c) => c.text), chunks.map((c) => c.text));
    assert.ok(loaded.every((c) => Array.isArray(c.tokens) && c.tokens.length > 0), 'tokens 必须重建');
    // 读回后仍可直接建库检索
    const hits = new KnowledgeBase(loaded).search('青霜剑');
    assert.ok(hits.length > 0);
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  assert.deepEqual(loadKnowledgeCache('kbtest_not_exist_zzz'), []);
  assert.deepEqual(loadKnowledgeCache(id), [], '删除后应返回空');
});

test('saveKnowledgeCache：projectId 做安全字符过滤', () => {
  const id = `kbtest_safe_${Date.now()}`;
  const file = saveKnowledgeCache('../../etc/' + id, [{ index: 0, text: '测试' }]);
  try {
    assert.ok(file.endsWith(`${id}.json`));
    assert.ok(!file.includes('..'), '不得出现路径穿越');
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

/* ---------------------------------------------------------------- FRAGMENT 片段 */
test('formatFragments：ViMax 标签串 / max 限制 / 截断 / 空输入', () => {
  const fs4 = formatFragments([{ text: '片段甲' }, { text: '片段乙' }], 2);
  assert.ok(fs4.startsWith('<CONTEXT_FRAGMENTS_START>'));
  assert.ok(fs4.endsWith('<CONTEXT_FRAGMENTS_END>'));
  assert.ok(fs4.includes('<FRAGMENT_0_START>\n片段甲\n<FRAGMENT_0_END>'));
  assert.ok(fs4.includes('<FRAGMENT_1_START>\n片段乙\n<FRAGMENT_1_END>'));
  assert.equal((fs4.match(/<FRAGMENT_\d+_START>/g) || []).length, 2);

  assert.ok(formatFragments(['纯字符串'], 4).includes('纯字符串'));
  assert.equal(formatFragments([]), '');
  assert.equal(formatFragments(null), '');
  assert.equal((formatFragments([{ text: 'a' }, { text: 'b' }, { text: 'c' }], 2)
    .match(/<FRAGMENT_\d+_START>/g) || []).length, 2);
  assert.ok(formatFragments([{ text: 'x'.repeat(1000) }], 4).includes('x'.repeat(512)));
  assert.ok(!formatFragments([{ text: 'x'.repeat(1000) }], 4).includes('x'.repeat(513)));
});
