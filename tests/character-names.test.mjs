/* 角色名可信度：把「动作 / 物件 / 方位 / 粘连串」挡在角色之外
 * 运行：node --test tests/character-names.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isLikelyPersonName, sanitizeCharacterList } from '../src/core/character-names.mjs';
import { extractCharacters } from '../src/core/novel.mjs';
import { mergeExtracted } from '../src/core/characters.mjs';

const SAMPLE = `
他从狗洞爬出去，回头看见父亲被一柄弯刀钉在门楣上，血顺着「诗礼传家」的匾额往下淌。
沈青崖没有回头。他咬紧牙关，朝林外跑去，刀光在雨里一闪。
魏残始终站在原地，钝刀刮骨般地笑了一声。冲他喊道：「站住！」
老周从岗亭里探出头，沉声道：「别追了。」
林夏低声说：「他已经走了。」
`;

test('isLikelyPersonName：动作/物件/方位/粘连串都不是人名', () => {
  for (const bad of ['回头', '刀光', '朝林外', '冲他', '开口', '钝刀刮骨', '沈青崖不', '魏残始终', '林夏低声', '夏已经', '林外']) {
    assert.equal(isLikelyPersonName(bad), false, `${bad} 不应被视为人名`);
  }
  for (const good of ['沈砚', '林晚', '林夏', '老周', '阿宝', '沈父', '魏残', '欧阳锋', '顾长风']) {
    assert.equal(isLikelyPersonName(good), true, `${good} 应被视为人名`);
  }
});

test('extractCharacters：用户例句里的「回头」不会被抽成角色', () => {
  const names = extractCharacters(SAMPLE, 12).map((c) => c.name);
  assert.ok(!names.includes('回头'), '回头不是角色');
  assert.ok(!names.includes('刀光'), '刀光不是角色');
  assert.ok(!names.includes('钝刀刮骨'), '钝刀刮骨不是角色');
  assert.ok(!names.includes('冲他'), '冲他不是角色');
  assert.ok(names.includes('林夏'), '说话者林夏应被抽出');
});

test('sanitizeCharacterList：LLM 结果同样要过滤非人物与重复称呼', () => {
  const out = sanitizeCharacterList([
    { name: '沈青崖', role: '主角' },
    { name: '沈青崖不', role: '噪声' },
    { name: '回头', role: '噪声' },
    { name: '青崖', aliases: ['沈青崖'], role: '别名' },
  ], { max: 12 });
  assert.deepEqual(out.characters.map((c) => c.name), ['沈青崖']);
  assert.ok(out.dropped.includes('回头'));
  assert.ok(out.dropped.includes('沈青崖不'));
  assert.ok(out.characters[0].aliases.includes('青崖'), '别名归并到同一角色');
});

test('mergeExtracted：重新提取时清理历史启发式脏角色，但不动手改 / LLM 角色', () => {
  const before = [
    { id: 'c1', name: '沈青崖', source: 'llm', role: '主角' },
    { id: 'c2', name: '回头', source: 'heuristic', role: '原著角色' },
    { id: 'c3', name: '刀光', source: 'heuristic', role: '原著角色' },
    { id: 'c4', name: '沈青崖不', source: 'heuristic', role: '原著角色' },
    { id: 'c5', name: '阿宝', source: 'heuristic', role: '手改过', edited: true },
    { id: 'c6', name: '老周', source: 'manual', role: '手动' },
  ];
  const out = mergeExtracted(before, [], { source: 'heuristic' });
  const names = out.characters.map((c) => c.name);
  assert.deepEqual(names.sort(), ['沈青崖', '老周', '阿宝'].sort());
  assert.ok(out.removed.includes('回头'));
  assert.ok(out.removed.includes('沈青崖不'));
  assert.ok(!names.includes('阿宝') === false, '手改过的启发式角色必须保留');
});

test('主角召回回归：「左」是正常名字用字，方向/碎片词仍被拦住', () => {
  // 曾经 FUNCTION_CHARS 含「左」，把「刘左」这种全书 800 次出场的主角判成碎片整条漏掉
  for (const good of ['刘左', '陈右', '刘左同'.slice(0, 2)]) {
    assert.equal(isLikelyPersonName(good), true, `${good} 应被视为人名`);
  }
  for (const bad of ['废话少', '两个人', '邻居', '龙王装', '淡淡', '同时', '黎明', '大家', '老周曾', '老头']) {
    assert.equal(isLikelyPersonName(bad), false, `${bad} 不应被视为人名`);
  }
});

test('extractCharacters：不把「知道 / 废话少说 / 开口：」切成角色，主角不因缺少台词被漏', () => {
  const src = '但他知道这事没完。废话少说：「走。」沈砚终于开口：「查下去。」'
    + '刘左同志看着窗外。'.repeat(4)
    + '老周曾经说过：「真相不会自己走出来。」'.repeat(3);
  const names = extractCharacters(src, 12).map((c) => c.name);
  for (const bad of ['但他知', '废话少', '开口', '周曾经', '周曾', '老周曾']) {
    assert.ok(!names.includes(bad), `${bad} 不应是角色：${names.join(',')}`);
  }
  assert.ok(names.includes('刘左'), `高频出场的主角必须被抽出：${names.join(',')}`);
  assert.ok(names.includes('老周'), `「老周曾经说过」这类不紧跟说话动词的角色也要抽出：${names.join(',')}`);
});
