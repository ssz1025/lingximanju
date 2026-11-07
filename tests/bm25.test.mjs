/* 纯检索层（分块 / BM25 召回 / 重排去重）· 单元测试
 * 对应论文式(6)：novel2movie_pipeline.py 的 FAISS 召回 + reranker 重排
 * 运行：node --test tests/bm25.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize, chunkNovel, KnowledgeBase, retrieveRelevantChunks, formatFragments,
} from '../src/core/bm25.mjs';

test('tokenize 中文按 bigram 切分并过滤停用词', () => {
  const tokens = tokenize('林晚的鹅蛋脸');
  assert.ok(tokens.includes('林晚'), '应保留双字词');
  assert.ok(tokens.includes('鹅蛋'));
  assert.ok(!tokens.includes('的'), '停用词被过滤');
  assert.deepEqual(tokenize(''), []);
});

test('tokenize 英文数字整段成词', () => {
  assert.deepEqual(tokenize('K-7 AI'), ['k', '7', 'ai']);
});

test('chunkNovel 按 512/128 分块并保留重叠', () => {
  const text = Array.from({ length: 60 }, (_, i) => `第${i}段内容，长度适中用于分块测试。`).join('\n');
  const chunks = chunkNovel(text);
  assert.ok(chunks.length > 1, '长文本应切成多块');
  assert.ok(chunks.every((c) => c.index >= 0 && c.text && c.tokens.length));
  assert.ok(chunks[1].text.includes(chunks[0].text.slice(-20)), '相邻块应带 overlap 重叠');
});

test('chunkNovel 空文本返回空数组', () => {
  assert.deepEqual(chunkNovel(''), []);
  assert.deepEqual(chunkNovel('   '), []);
});

test('KnowledgeBase 召回包含查询词的块', () => {
  const chunks = chunkNovel([
    '林晚推门而入，鹅蛋脸、剑眉深目，月白广袖长裙。',
    '沈默站在巷口，风衣猎猎，眼底藏着疲惫。',
    '雨下了整夜，青石街上空无一人。',
  ].join('\n'));
  const kb = new KnowledgeBase(chunks);
  const hits = kb.search('林晚 长裙', { k: 3 });
  assert.ok(hits.length > 0, '应有命中');
  assert.ok(hits[0].chunk.text.includes('林晚'));
});

test('retrieveRelevantChunks 多线索召回并按分数降序', () => {
  // 手工构块：避免短文本被 chunkNovel 合并成同一块，导致多线索召回退化为单块
  const mk = (t) => ({ index: 0, text: t, tokens: tokenize(t) });
  const kb = new KnowledgeBase([
    mk('林晚的定妆特征是鹅蛋脸与墨色长发。'),
    mk('沈默是冷峻的私家侦探，穿深色风衣。'),
    mk('雨夜的老城区空无一人，只有霓虹在积水里晃。'),
  ]);
  const out = retrieveRelevantChunks(kb, ['林晚 鹅蛋脸', '沈默 风衣'], { topK: 5, threshold: 0.3 });
  assert.ok(out.length >= 2, `应召回至少两段，实际 ${out.length}`);
  assert.ok(out[0].score >= out[out.length - 1].score, '应按分数降序');
  assert.ok(out.some((f) => f.text.includes('林晚')));
  assert.ok(out.some((f) => f.text.includes('沈默')));
});

test('retrieveRelevantChunks 阈值过滤掉弱相关块', () => {
  const chunks = chunkNovel([
    '林晚的定妆特征是鹅蛋脸与墨色长发。',
    '沈默是冷峻的私家侦探，穿深色风衣。',
  ].join('\n'));
  const kb = new KnowledgeBase(chunks);
  const loose = retrieveRelevantChunks(kb, ['林晚 鹅蛋脸'], { topK: 5, threshold: 0 });
  const strict = retrieveRelevantChunks(kb, ['林晚 鹅蛋脸'], { topK: 5, threshold: 0.95 });
  assert.ok(loose.length >= strict.length, '高阈值召回不应多于低阈值');
  assert.ok(strict.length <= 1, '高阈值下只应保留最佳命中');
});

test('retrieveRelevantChunks 无命中返回空数组', () => {
  const kb = new KnowledgeBase(chunkNovel('林晚推门而入。'));
  assert.deepEqual(retrieveRelevantChunks(kb, [''], {}), []);
});

test('formatFragments 输出 FRAGMENT 标签串', () => {
  const out = formatFragments([{ text: '林晚推门而入' }, { text: '沈默点了一盏烟' }]);
  assert.ok(out.includes('<CONTEXT_FRAGMENTS_START>'));
  assert.ok(out.includes('<FRAGMENT_0_START>'));
  assert.ok(out.includes('<FRAGMENT_1_END>'));
  assert.ok(out.includes('林晚推门而入'));
  assert.equal(formatFragments([]), '');
});
