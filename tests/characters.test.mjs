/* 角色域模型（归一 / 提示词拼装 / 提取输入组装 / 合并）· 单元测试
 * 运行：node --test tests/characters.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHARACTER_VIEWS, MAX_CHARACTERS, EXTRACT_CAP,
  charNameKey, normalizeCharacter, buildCharacterPrompt,
  buildViewPrompt, buildExtractVars, buildCharacterPassages, mergeExtracted,
  verifyEvidence, supplementMainCharacters,
} from '../src/core/characters.mjs';

test('CHARACTER_VIEWS 定义五视图：4 个全身机位 + 1 个面部特写', () => {
  assert.deepEqual(CHARACTER_VIEWS.map((v) => v.key), ['front', 'threeQuarter', 'side', 'back', 'closeup']);
  for (const v of CHARACTER_VIEWS) {
    assert.ok(v.label && v.angle, `${v.key} 应有 label 与 angle`);
    assert.equal(v.kind, v.key === 'closeup' ? 'face' : 'body', `${v.key} 的 kind 与视图类型一致`);
  }
  // 4 个全身视图是「核心组」，面部特写是可选增强（core: false）
  assert.deepEqual(CHARACTER_VIEWS.filter((v) => v.core).map((v) => v.key), ['front', 'threeQuarter', 'side', 'back']);
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
  assert.deepEqual(c.views, { front: null, threeQuarter: null, side: null, back: null, closeup: null });
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

test('buildViewPrompt 正面含角度并优先用 viewPrompt', () => {
  const c = { name: '林晚', appearance: '清冷气质', viewPrompt: '水墨风格少女' };
  const front = buildViewPrompt(c, 'front', { style: '电影感', negative: '模糊' });
  assert.ok(front.includes('正面'), '正面视图提示词应含角度');
  assert.ok(front.includes('水墨风格少女'), 'viewPrompt 优先');
  assert.ok(!front.includes('清冷气质'), '有 viewPrompt 时不用属性拼装');
  assert.ok(front.includes('电影感'), '应拼风格串');
  assert.ok(front.includes('模糊'), '应拼负面串');
});

test('buildViewPrompt 无 viewPrompt 时正面用属性拼装', () => {
  const front = buildViewPrompt({ name: '沈默', appearance: '冷峻', staticFeatures: '眉骨高而轮廓分明' }, 'front');
  assert.ok(front.includes('沈默'));
  assert.ok(front.includes('冷峻'));
  assert.ok(front.includes('眉骨高而轮廓分明'));
});

test('buildViewPrompt 正面显式写出静态/动态特征二分', () => {
  const front = buildViewPrompt({
    name: '沈默', viewPrompt: '水墨风格冷峻青年',
    staticFeatures: '眉骨高而轮廓分明', dynamicFeatures: '月白广袖袍配青玉佩',
  }, 'front');
  assert.ok(front.includes('固定特征：眉骨高而轮廓分明'));
  assert.ok(front.includes('可变特征：月白广袖袍配青玉佩'));
});

test('buildViewPrompt 侧面/背面以正面图为唯一外观依据，不重复特征描述', () => {
  const c = { name: '沈默', appearance: '冷峻', staticFeatures: '眉骨高而轮廓分明' };
  const frontRef = [{ view: 'front', url: '/assets/p/f.svg' }];

  const side = buildViewPrompt(c, 'side', { refs: frontRef });
  assert.ok(side.includes('90 度侧面'), '侧面视图应含角度');
  assert.ok(side.includes('参考图（正面）'), '侧面应声明以正面图为唯一外观依据');
  assert.ok(!side.includes('眉骨高而轮廓分明'), '侧面不重复特征描述，避免与正面图不一致');
  assert.ok(!side.includes('冷峻'));

  const back = buildViewPrompt(c, 'back', { refs: frontRef });
  assert.ok(back.includes('背面'));
  assert.ok(back.includes('参考图（正面）'));
  assert.ok(back.includes('背面不可见五官'));

  const tq = buildViewPrompt(c, 'threeQuarter', { refs: frontRef });
  assert.ok(tq.includes('45 度的 3/4 侧身'), '3/4 侧应写明转身幅度');
  assert.ok(tq.includes('参考图（正面）'));
  assert.ok(!tq.includes('眉骨高而轮廓分明'));
});

test('buildViewPrompt 面部特写走齐胸构图，仍锚定正面参考图', () => {
  const c = { name: '沈默', staticFeatures: '眉骨高而轮廓分明' };
  const face = buildViewPrompt(c, 'closeup', { refs: [{ view: 'front', url: '/assets/p/f.svg' }] });
  assert.ok(face.includes('面部特写'));
  assert.ok(face.includes('齐胸以上构图'), '面部特写不走全身构图');
  assert.ok(face.includes('参考图（正面）'));
  assert.ok(face.includes('沈默'));
});

test('buildViewPrompt 无 refs 时退化为「以文字描述为准」', () => {
  const p = buildViewPrompt({ name: '林晚' }, 'side');
  assert.ok(p.includes('以文字描述为准'));
});

test('normalizeCharacter 缺静态/动态特征时按语义派生', () => {
  const c = normalizeCharacter({ name: '林晚', appearance: '清冷', hair: '黑色长发', costume: '月白长裙' });
  assert.ok(c.staticFeatures.includes('清冷'));
  assert.ok(c.staticFeatures.includes('黑色长发'));
  assert.ok(c.dynamicFeatures.includes('月白长裙'));

  const given = normalizeCharacter({ name: '林晚', staticFeatures: '剑眉深目', dynamicFeatures: '月白广袖袍' });
  assert.equal(given.staticFeatures, '剑眉深目', '模型给出的固定特征不被派生覆盖');
  assert.equal(given.dynamicFeatures, '月白广袖袍');
});

test('buildCharacterPrompt 区分固定特征与可变特征', () => {
  const p = buildCharacterPrompt({ name: '林晚', staticFeatures: '剑眉深目', dynamicFeatures: '月白广袖袍' });
  assert.ok(p.includes('固定特征：剑眉深目'));
  assert.ok(p.includes('可变特征：月白广袖袍'));
});

test('buildExtractVars 以召回片段组装证据且截断 ≤ EXTRACT_CAP', () => {
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
  assert.ok(Array.isArray(vars.fragments) && vars.fragments.length > 0, '应召回原著片段');
  assert.ok(vars.fragments.every((f) => f.text && ['recall', 'window'].includes(f.kind)));
  assert.ok(vars.novelText.includes('【分集梗概】'));
  assert.ok(vars.novelText.includes('雨夜来信'));
  assert.ok(vars.novelText.length <= EXTRACT_CAP, `novelText ${vars.novelText.length} 应 ≤ ${EXTRACT_CAP}`);
});

test('buildCharacterPassages 召回长篇中后段角色的原文描述', () => {
  // 角色描写只出现在全文靠后位置，旧实现（取开头 + 有限窗口）必然取不到
  const filler = '雨下了一整夜，青石街上空无一人。'.repeat(200);
  const text = `${filler}林晚推门而入，鹅蛋脸、剑眉深目，月白广袖长裙，腰间悬一枚青玉佩。${filler}`;
  const { fragments } = buildCharacterPassages(text, [{ name: '林晚' }], []);
  assert.ok(fragments.length > 0, '应有召回片段');
  assert.ok(fragments.some((f) => f.text.includes('青玉佩')), '应召回含角色外貌描写的原文');
  assert.ok(fragments.some((f) => f.kind === 'window'), '候选名应产生原文定位窗口');
});

test('buildExtractVars 无原著时仍可返回（空候选/空正文）', () => {
  const vars = buildExtractVars({ name: 'x' }, { source: { text: '' } });
  assert.deepEqual(vars.candidates, []);
  assert.deepEqual(vars.fragments, []);
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

test('mergeExtracted 别名取并集，不丢已有别称', () => {
  const existing = [normalizeCharacter({ name: '林晚', aliases: ['阿晚'] })];
  const out = mergeExtracted(existing, [{ name: '林晚', aliases: ['晚晚', '阿晚'] }], { source: 'llm' });
  assert.deepEqual(out.characters[0].aliases, ['阿晚', '晚晚']);
});

test('mergeExtracted 启发式占位特征可被 LLM 结果覆盖，来源升级为 llm', () => {
  // 启发式角色的固定特征只是「外观串」派生出来的占位值，不是真实特征
  const heuristic = normalizeCharacter({
    id: 'chr_h', name: '沈默', source: 'heuristic',
    appearance: '原著中出现的「沈默」· 服装 / 发型 / 随身物件跨镜头保持一致',
  });
  const out = mergeExtracted([heuristic], [{
    name: '沈默', source: 'llm',
    appearance: '剑眉深目，风衣猎猎',
    staticFeatures: '剑眉深目、轮廓分明、墨色短发',
    dynamicFeatures: '深色风衣、左手旧怀表',
    role: '男主角',
  }], { source: 'llm' });
  const c = out.characters[0];
  assert.equal(c.staticFeatures, '剑眉深目、轮廓分明、墨色短发', '派生占位特征应被真实特征替换');
  assert.equal(c.dynamicFeatures, '深色风衣、左手旧怀表');
  assert.equal(c.appearance, '剑眉深目，风衣猎猎');
  assert.equal(c.role, '男主角');
  assert.equal(c.source, 'llm', '覆盖后来源升级为 llm');
});

test('mergeExtracted 手动角色的特征不被 LLM 覆盖', () => {
  const manual = normalizeCharacter({ name: '林晚', source: 'manual', staticFeatures: '我手改的固定特征' });
  const out = mergeExtracted([manual], [{ name: '林晚', staticFeatures: 'LLM 的固定特征' }], { source: 'llm' });
  assert.equal(out.characters[0].staticFeatures, '我手改的固定特征');
});

test('mergeExtracted 用户手改过的启发式角色不被 LLM 覆盖', () => {
  const edited = normalizeCharacter({
    name: '沈默', source: 'heuristic', edited: true,
    appearance: '我手改的外貌',
    staticFeatures: '我手改的固定特征',
  });
  const out = mergeExtracted([edited], [{
    name: '沈默', appearance: 'LLM 外貌', staticFeatures: 'LLM 固定特征', role: '主角',
  }], { source: 'llm' });
  assert.equal(out.characters[0].staticFeatures, '我手改的固定特征');
  assert.equal(out.characters[0].appearance, '我手改的外貌');
  assert.equal(out.characters[0].source, 'heuristic', '手改过的角色来源不应被改写');
});

test('mergeExtracted 尊重 MAX_CHARACTERS 上限', () => {
  const extracted = Array.from({ length: 20 }, (_, i) => ({ name: `角色${i}` }));
  const out = mergeExtracted([], extracted, { source: 'llm' });
  assert.equal(out.characters.length, MAX_CHARACTERS);
});

test('normalizeCharacter 归一 evidence：去空去重、quote 截断、未知 kind 降级', () => {
  const c = normalizeCharacter({
    name: '林晚',
    evidence: [
      { quote: '林晚推门而入', kind: 'mention' },
      { quote: '林晚推门而入', kind: 'dialogue' },      // 重复 → 丢
      { kind: 'mention' },                              // 无 quote → 丢
      { quote: 'x'.repeat(300), kind: 'internal' },     // 截断 + kind 降级
    ],
  });
  assert.equal(c.evidence.length, 2);
  assert.equal(c.evidence[0].quote, '林晚推门而入');
  assert.equal(c.evidence[1].quote.length, 120);
  assert.equal(c.evidence[1].kind, 'mention');
});

test('verifyEvidence 只保留能在原著中逐字定位的引用，角色本身不丢', () => {
  const src = '林晚推门而入，鹅蛋脸、剑眉深目。\n老王把钥匙递给小丽，说你先走。';
  const { characters, verified, dropped } = verifyEvidence([
    {
      name: '林晚',
      evidence: [
        { quote: '林晚推门而入，鹅蛋脸、剑眉深目。', kind: 'mention' }, // 逐字命中
        { quote: '她昨夜根本没来过这里', kind: 'dialogue' },             // 原著没有 → 幻觉
      ],
    },
    { name: '老王', evidence: [] },
  ], src);

  assert.equal(verified, 1, '真实存在的引用应计入 verified');
  assert.equal(dropped, 1, '定位不到的引用必须丢弃');
  assert.deepEqual(characters[0].evidence.map((e) => e.quote), ['林晚推门而入，鹅蛋脸、剑眉深目。']);
  assert.equal(characters.length, 2, '只丢引用，不丢角色');
  assert.deepEqual(characters[1].evidence, [], '无证据角色原样保留');
});

test('verifyEvidence 忽略空白匹配：原文换行/缩进被模型抄丢也算命中', () => {
  const src = '第一章\n\n  老王把钥匙\n\t递给小丽。';
  const out = verifyEvidence(
    [{ name: '老王', evidence: [{ quote: '老王把钥匙 递给小丽。', kind: 'dialogue' }] }],
    src,
  );
  assert.equal(out.verified, 1, '空白差异不应误杀有效引用');
  assert.equal(out.dropped, 0);
});

test('buildExtractVars 候选池比最终角色上限更宽：长篇第 13 位之后的主角也能进提示词', () => {
  // 20 位只有一句台词的配角把候选池挤满，主角「刘左」出场最多但从不紧跟说话动词
  const crowd = '青崖白霜雪夜雨风灯船山海江河川林木石土火金水'
    .split('').map((ch) => `沈${ch}说：“走。”`).join('');
  const text = `${crowd}${'刘左同志看着窗外，一言不发。'.repeat(6)}`;
  const vars = buildExtractVars({ name: 'x' }, { source: { text }, episodes: [] }, 12);
  assert.ok(vars.candidates.length > 12, `候选池应大于输出上限，实际 ${vars.candidates.length}`);
  assert.ok(vars.candidates.some((c) => c.name === '刘左'), '出场最多但不带说话动词的主角应在候选池内');
});

test('supplementMainCharacters：模型漏掉的主角按出场频次补回，已有称呼不重复', () => {
  const text = `${'刘左同志看着窗外，一言不发。'.repeat(6)}${'林夏说：“走吧。”'.repeat(4)}`;
  // 模型只给了配角「林夏」，主角整条漏掉
  const out = supplementMainCharacters([{ name: '林夏', role: '配角' }], text, { max: 12, minHits: 3 });
  assert.deepEqual(out.added, ['刘左'], '应补回高频出场的主角');
  assert.equal(out.characters.length, 2);
  const added = out.characters.find((c) => c.name === '刘左');
  assert.equal(added.source, 'heuristic', '兜底角色不能冒充 LLM 人设');
  assert.equal(added.auto, true);
  assert.ok(added.evidence[0].quote.includes('刘左'), '补回的角色必须带可溯源原文');
  assert.ok(text.includes(added.evidence[0].quote));

  // 已经是别名的情况不重复补
  const alias = supplementMainCharacters([{ name: '小林', aliases: ['刘左'] }], text, { max: 12, minHits: 3 });
  assert.ok(!alias.added.includes('刘左'), '别名已覆盖同一实体时不应再补一条');
});

test('supplementMainCharacters：名额被配角占满时，强主线角色仍能挤进来并如实记录被挤掉的人', () => {
  const text = `${'刘左同志看着窗外，一言不发。'.repeat(25)}${'林夏说：“走吧。”'.repeat(4)}`;
  // 模型给了 3 个名额全是配角，主角没在里面
  const full = [{ name: '林夏' }, { name: '老周' }, { name: '沈砚' }];
  const out = supplementMainCharacters(full, text, { max: 3 });
  assert.deepEqual(out.added, ['刘左'], '出场 25 次的主角应强制入列');
  assert.deepEqual(out.displaced, ['沈砚'], '被挤掉的是列表末尾的角色，且要能如实上报');
  assert.equal(out.characters.length, 3);
  assert.ok(out.characters.some((c) => c.name === '刘左'));

  // 只是普通高频（未达 forceHits）时不挤人
  const weak = supplementMainCharacters(full, `${'刘左同志站着。'.repeat(9)}`, { max: 3, minHits: 3, forceHits: 20 });
  assert.deepEqual(weak.added, [], '未达强主线阈值时不抢名额');
  assert.deepEqual(weak.displaced, []);
});
