/* 导演风格 → Provider 的真实注入验证（零 Key Mock 路径）
 *
 * 这里锁住三个曾经踩过的坑：
 *   ① mockGenerate 的 directorTreatment 必须带 __mockKeys，否则上层判不出「这是模板」，
 *      结果零 Key 下十位导演拿到同一份通用阐述；
 *   ② 模板字段不得覆盖风格基线，只有真实 LLM 输出才能改写视听方案；
 *   ③ 出图与分镜要真的带上主色 / 光线 / 媒介词汇，而不是只换一句提示词。
 *
 * 运行：node --test tests/director-provider.test.mjs
 * 必须先把数据目录指到临时目录再动态导入（ESM import 会提升），避免污染真实 data/
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-dirprov-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const { createProviders } = await import('../src/core/providers.mjs');
const { DIRECTOR_STYLES, resolveAesthetic, aestheticPrompt } = await import('../src/core/director-styles.mjs');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const assetPath = (url) => path.join(TMP, 'assets', String(url).replace(/^\/assets\//, ''));

test('零 Key 导演阐述：模板产物必须自报 __mockKeys，且内容来自项目输入', async () => {
  const pv = createProviders({ provider: 'mock' }, () => {});
  assert.equal(pv.mode, 'mock');
  const out = await pv.generate('directorTreatment', {
    title: '雨夜来信', logline: '退役刑警收到十年前的信',
    episodes: [{ title: '第一集', summary: '信到达' }],
    characters: [{ name: '沈砚', role: '刑警' }],
  });
  // 没有这个标记，director-agent 会误以为拿到了 LLM 输出，从而跳过风格基线
  assert.ok(Array.isArray(out.__mockKeys) && out.__mockKeys.length >= 5,
    '模板产物必须自报 __mockKeys，否则风格基线会被绕过');
  assert.ok(out.title.includes('雨夜来信'));
  assert.ok(out.logline.includes('十年前'));
  assert.ok(out.tone && out.visualStyle && out.pacing && out.shotStrategy && out.audioStrategy);
});

test('三个入口都吃到了风格：主色 / 光线 / 媒介在提示词与分镜里可见', async () => {
  const a = resolveAesthetic('zhangyimou', { paletteKey: 'bamboo-green' });
  const pv = createProviders({ provider: 'mock', aesthetic: a }, () => {});

  // ① 出图：正负提示词与 styleApplied
  assert.equal(pv.mode, 'mock');
  const img = await pv.image({ prompt: '少年立于竹林中', shotNo: 1 });
  assert.equal(img.styleApplied, 'zhangyimou');

  // ② 分镜：主色 / 光线 / 媒介词汇替代了通用「冷调侧光」
  const shots = await pv.generate('shots', { scene: { location: '竹林' }, count: 4, clipSeconds: 3 });
  assert.equal(shots.shots.length, 4);
  const first = shots.shots[0];
  assert.ok(String(first.ffDesc).includes('竹林绿'), '分镜画面描述必须带当前主色');
  assert.ok(!String(first.ffDesc).includes('冷调侧光'), '不该再回落到通用光线词');
  assert.ok(String(first.ffDesc).includes(a.texture.slice(0, 6)), '质感词要进画面描述');

  // ③ 每个镜头都写了风格锚点，后续出图 / 导演包可追溯
  for (const s of shots.shots) {
    assert.ok(s.ffDesc && s.motionDesc && s.audioDesc);
  }
});

test('不同导演的分镜词汇两两不同：不是同一套模板换皮', async () => {
  const banks = new Set();
  for (const s of DIRECTOR_STYLES) {
    const a = resolveAesthetic(s.id);
    const pv = createProviders({ provider: 'mock', aesthetic: a }, () => {});
    const out = await pv.generate('shots', { scene: { location: '客栈' }, count: 4, clipSeconds: 3 });
    const sig = out.shots.map((x) => `${x.movement}|${x.audioDesc}|${x.motionDesc}`).join('||');
    assert.ok(sig.length > 20, `${s.id} 分镜词汇为空`);
    banks.add(sig);
  }
  assert.equal(banks.size, DIRECTOR_STYLES.length, '十位导演的分镜词汇必须两两不同');
});

test('主色影响出图与提示词：同导演换色，画面配色与色号都变', async () => {
  const red = resolveAesthetic('zhangyimou', { paletteKey: 'hero-red' });
  const green = resolveAesthetic('zhangyimou', { paletteKey: 'bamboo-green' });
  assert.equal(red.svg.accent, '#C81D25');
  assert.equal(green.svg.accent, '#2F4F3A');

  const pr = aestheticPrompt('zhangyimou', { base: '少年立于竹林中', paletteKey: 'hero-red' });
  const pg = aestheticPrompt('zhangyimou', { base: '少年立于竹林中', paletteKey: 'bamboo-green' });
  assert.ok(pr.positive.includes('英雄红') && pr.positive.includes('#C81D25'));
  assert.ok(pg.positive.includes('竹林绿') && pg.positive.includes('#2F4F3A'));
  assert.equal(pr.negative, pg.negative, '否定词是风格级约束，不随主色改');
});

test('未选风格时行为与升级前一致：不追加任何风格串，出图也不标 styleApplied', async () => {
  const pv = createProviders({ provider: 'mock' }, () => {});
  const img = await pv.image({ prompt: '普通镜头', shotNo: 1 });
  assert.equal(img.styleApplied, null);
  const shots = await pv.generate('shots', { scene: { location: '街道' }, count: 3, clipSeconds: 3 });
  // 无风格时用内置通用词汇，且不会冒出任何导演主色
  assert.ok(String(shots.shots[0].ffDesc).includes('冷调侧光'), '无风格时才用通用光线词');
  for (const s of DIRECTOR_STYLES) {
    assert.ok(!String(shots.shots[0].ffDesc).includes(resolveAesthetic(s.id).paletteName),
      '未选风格不该出现任何导演的主色名');
  }
});
