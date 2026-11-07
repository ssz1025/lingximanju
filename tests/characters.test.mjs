/* 角色域模型（归一 / 提示词拼装 / 提取输入组装 / 合并）· 单元测试
 * 运行：node --test tests/characters.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHARACTER_VIEWS, MAX_CHARACTERS, EXTRACT_CAP,
  charNameKey, normalizeCharacter, buildCharacterPrompt,
  buildViewPrompt, buildExtractVars, mergeExtracted,
} from '../src/core/characters.mjs';

test('CHARACTER_VIEWS 定义正面/侧面/背面三视图', () => {
  assert.deepEqual(CHARACTER_VIEWS.map((v) => v.key), ['front', 'side', 'back']);
  for (const v of CHARACTER_VIEWS) {
    assert.ok(v.label && v.angle, `${v.key} 应有 label 与 angle`);
  }
  assert.equal(MAX_CHARACTERS, 12);
  assert.equal(EXTRACT_CAP, 12000);
});

test('charNameKey 归一：去空格/书名号/引号，大小写不敏感', () => {
  assert.equal(charNameKey('沈 默'), charNameKey('沈默'));
  assert.equal(charNameKey('《林晚》'), charNameKey('林晚'));
  assert.equal(charNameKey('Alice'), charNameKey('alice'));
  assert.equal(charNameKey(''), '');
});

test('normalizeCharacter 补齐缺字段并给出稳定默认值', () => {
  const c = normalizeCharacter({ name: '林晚' });
  assert.equal(c.name, '林晚');
  assert.ok(c.id, '应生成 id');
  assert.deepEqual(c.aliases, []);
  assert.equal(c.source, 'manual');
  assert.deepEqual(c.palette, []);
  assert.deepEqual(c.relations, []);
  assert.deepEqual(c.views, { front: null, side: null, back: null });
  assert.equal(c.hits, 0);
});

test('normalizeCharacter 截断超长文本与列表', () => {
  const c = normalizeCharacter({
    name: 'n'.repeat(50),
    appearance: 'a'.repeat(1000),
    style: 's'.repeat(300),
    aliases: ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'],
    relations: Array.from({ length: 12 }, (_, i) => ({ target: `t${i}`, label: 'l' })),
    palette: ['#112233', '#445566', '#778899', '#aabbcc', '#ddeeff', '#000000'],
  });
  assert.equal(c.name.length, 20);
  assert.equal(c.appearance.length, 600);
  assert.equal(c.style.length, 120);
  assert.equal(c.aliases.length, 6);
  assert.equal(c.relations.length, 8);
  assert.equal(c.palette.length, 5);
});

test('normalizeCharacter 过滤非法 palette，保留合法 id/source/views', () => {
  const c = normalizeCharacter({
    id: 'chr_abc-1', name: '沈默', source: 'llm',
    palette: ['#112233', 'red', '#xyz123', ' #445566 '],
    views: {
      front: { file: 'a.png', url: '/assets/a.png', prompt: 'p', provider: 'mock', at: 123 },
      side: { url: '' },
    },
  });
  assert.equal(c.id, 'chr_abc-1');
  assert.equal(c.source, 'llm');
  assert.deepEqual(c.palette, ['#112233', '#445566'], '非法颜色被过滤，合法颜色 trim 后保留');
  assert.equal(c.views.front.url, '/assets/a.png');
  assert.equal(c.views.front.file, 'a.png');
  assert.equal(c.views.side, null, '缺 url 的视图视为未生成');
  assert.equal(c.views.back, null);
});

test('buildCharacterPrompt 按属性拼造型串', () => {
  const p = buildCharacterPrompt({
    name: '林晚', role: '女主角', gender: '女', age: '25岁',
    appearance: '清冷气质', hair: '黑色长发', costume: '月白长裙',
    props: '油纸伞', personality: '外冷内热', style: '古风清冷', palette: ['#112233', '#445566'],
  });
  for (const seg of ['林晚', '女主角', '25岁', '清冷气质', '黑色长发', '月白长裙', '油纸伞', '外冷内热', '设定风格：古风清冷', '#112233']) {
    assert.ok(p.includes(seg), `造型串应包含「${seg}」`);
  }
  assert.equal(buildCharacterPrompt({}), '');
});

test('buildViewPrompt 含视图角度，viewPrompt 优先于属性拼装', () => {
  const c = { name: '林晚', appearance: '清冷气质', viewPrompt: '水墨风格少女' };
  const front = buildViewPrompt(c, 'front', { style: '电影感', negative: '模糊' });
  assert.ok(front.includes('正面'), '正面视图提示词应含角度');
  assert.ok(front.includes('水墨风格少女'), 'viewPrompt 优先');
  assert.ok(!front.includes('清冷气质'), '有 viewPrompt 时不用属性拼装');
  assert.ok(front.includes('电影感'), '应拼风格串');
  assert.ok(front.includes('模糊'), '应拼负面串');

  const side = buildViewPrompt({ name: '沈默', appearance: '冷峻' }, 'side');
  assert.ok(side.includes('90度侧面'), '侧面视图应含角度');
  assert.ok(side.includes('冷峻'), '无 viewPrompt 时用属性拼装');
  const back = buildViewPrompt({ name: '沈默' }, 'back');
  assert.ok(back.includes('背面'));
  assert.ok(back.includes('沈默'));
});

test('buildExtractVars 组装候选/正文/梗概且截断 ≤ EXTRACT_CAP', () => {
  const text = `林晚说：“下雨了。”沈默问：“要伞吗？”${'正文'.repeat(6000)}林晚说：“走吧。”沈默答：“好。”`;
  const project = { name: '测试项目' };
  const m = {
    source: { title: '雨夜来信', text },
    episodes: [{ no: 1, title: '第一章', summary: '雨夜来信' }],
  };
  const vars = buildExtractVars(project, m, 4);
  assert.equal(vars.title, '雨夜来信');
  assert.ok(vars.candidates.length > 0, '应有启发式候选');
  assert.ok(vars.candidates.every((c) => c.name && c.hits > 0));
  assert.ok(vars.novelText.includes('【小说开头】'));
  assert.ok(vars.novelText.includes('【分集梗概】'));
  assert.ok(vars.novelText.includes('雨夜来信'));
  assert.ok(vars.novelText.length <= EXTRACT_CAP, `novelText ${vars.novelText.length} 应 ≤ ${EXTRACT_CAP}`);
});

test('buildExtractVars 无原著时仍可返回（空候选/空正文）', () => {
  const vars = buildExtractVars({ name: 'x' }, { source: { text: '' } });
  assert.deepEqual(vars.candidates, []);
  assert.ok(vars.novelText.length <= EXTRACT_CAP);
});

test('mergeExtracted 新增角色并按名合并，只补空字段不覆盖手改', () => {
  const existing = [
    normalizeCharacter({ id: 'chr_1', name: '林晚', role: '女主角', appearance: '手改外貌', style: '手改风格', source: 'manual' }),
  ];
  const out = mergeExtracted(existing, [
    { name: '林晚', role: '原著女主', appearance: 'LLM外貌', style: 'LLM风格', hair: '黑色长发', palette: ['#112233'] },
    { name: '沈默', role: '男主角', personality: '沉默寡言', style: '冷峻水墨' },
    { name: '林晚', role: '重复条目' },
    { name: '' },
  ], { source: 'llm' });

  assert.equal(out.added, 1, '只新增「沈默」');
  assert.equal(out.merged, 2, '「林晚」命中两次均合并');
  assert.equal(out.characters.length, 2);

  const lin = out.characters.find((c) => c.name === '林晚');
  assert.equal(lin.role, '女主角', '手改 role 不被覆盖');
  assert.equal(lin.appearance, '手改外貌', '手改 appearance 不被覆盖');
  assert.equal(lin.hair, '黑色长发', '空字段被 LLM 结果补齐');
  assert.equal(lin.style, '手改风格', '手改 style 不被覆盖');
  assert.deepEqual(lin.palette, ['#112233']);
  assert.equal(lin.source, 'manual', '合并不改变原来源');

  const shen = out.characters.find((c) => c.name === '沈默');
  assert.equal(shen.source, 'llm');
  assert.equal(shen.personality, '沉默寡言');
  assert.equal(shen.style, '冷峻水墨', '空 style 被 LLM 总结的设定风格补齐');
});

test('mergeExtracted 别名命中同名角色也合并', () => {
  const existing = [normalizeCharacter({ name: '林晚', aliases: ['阿晚'] })];
  const out = mergeExtracted(existing, [{ name: '阿晚', age: '25岁' }], { source: 'llm' });
  assert.equal(out.characters.length, 1);
  assert.equal(out.added, 0);
  assert.equal(out.merged, 1);
  assert.equal(out.characters[0].age, '25岁');
});

test('mergeExtracted 尊重 MAX_CHARACTERS 上限', () => {
  const extracted = Array.from({ length: 20 }, (_, i) => ({ name: `角色${i}` }));
  const out = mergeExtracted([], extracted, { source: 'llm' });
  assert.equal(out.characters.length, MAX_CHARACTERS);
});
