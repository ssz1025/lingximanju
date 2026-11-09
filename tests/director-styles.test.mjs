/* 导演美学档案 · 纯逻辑单元测试
 * 覆盖：十位导演档案完整性 / 别名归一 / 调色板收敛 / 正负提示词拼接 /
 *       分镜后缀 / 零 Key 导演阐述基线 / 技能卡投影 / 项目级美学解析。
 * 运行：node --test tests/director-styles.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  DIRECTOR_STYLES, STYLE_BY_ID, normalizeStyleId, getDirectorStyle, isDirectorStyle,
  resolvePalette, resolveAesthetic, aestheticPrompt, aestheticShotSuffix,
  aestheticTreatment, styleCard, paceLabel, listStyleCards, resolveProjectAesthetic,
} = await import('../src/core/director-styles.mjs');
const { DIRECTOR_SKILLS, getDirectorSkill, skillAesthetic } = await import('../src/core/director-skills.mjs');
const { buildNovelProject } = await import('../src/pipelines/novel-project.mjs');

const EXPECTED_IDS = [
  'zhangyimou', 'wongkarwai', 'ang-lee', 'hou-hsiao-hsien', 'tsui-hark',
  'king-hu', 'chen-kaige', 'kurosawa', 'miyazaki', 'kitano',
];

test('十位导演档案：id 固定有序、字段完整、调色板与连戏约束够用', () => {
  assert.equal(DIRECTOR_STYLES.length, 10);
  assert.deepEqual(DIRECTOR_STYLES.map((s) => s.id), EXPECTED_IDS);
  for (const s of DIRECTOR_STYLES) {
    assert.ok(s.label && s.workTitle && s.director && s.tagline, `${s.id} 缺基础文案`);
    assert.ok(s.summary.length >= 40, `${s.id} 摘要过短，技能卡会没有信息量`);
    for (const key of ['colorRule', 'light', 'composition', 'camera', 'texture', 'tone',
      'visualStyle', 'pacing', 'shotStrategy', 'audioStrategy', 'stylePrompt', 'negativePrompt']) {
      assert.ok(String(s[key] || '').trim(), `${s.id} 缺 ${key}`);
    }
    // 每位导演都要有可切换的主色调，否则「换色不换风格」这条能力是假的
    assert.ok(s.palettes.length >= 3, `${s.id} 主色少于 3 个`);
    assert.ok(s.palettes.every((p) => p.key && p.name && /^#[0-9A-Fa-f]{6}$/.test(p.hex)), `${s.id} 主色缺 key/name/hex`);
    assert.ok(s.palettes.some((p) => p.key === s.defaultPalette), `${s.id} 默认主色不在调色板里`);
    assert.ok(s.taboos.length >= 3, `${s.id} 否定项太少`);
    assert.ok(s.medium.length >= 3, `${s.id} 自然媒介太少`);
    assert.ok(s.continuityRules.length >= 3, `${s.id} 连戏约束太少，分镜会散`);
    assert.ok(s.risks.length >= 2, `${s.id} 风险提示太少`);
    assert.ok(s.highlights.length >= 4, `${s.id} 亮点不足以撑起技能卡`);
    // 节奏必须是可执行数字，不能是形容词
    assert.ok(Number(s.pace.minShotSec) > 0 && Number(s.pace.maxShotSec) >= Number(s.pace.minShotSec), `${s.id} 单镜时长非法`);
    assert.ok((Number(s.pace.fixedShotRatio) || 0) > 0, `${s.id} 固定机位占比缺失`);
    // Mock 出图调色板：三个天空色 + 地面色，缺一个就会画成黑图
    assert.ok(Array.isArray(s.svg?.sky) && s.svg.sky.length === 3, `${s.id} svg.sky 必须是 3 段`);
    assert.ok(s.svg.ground && s.svg.accent && s.svg.text, `${s.id} svg 配色不全`);
  }
});

test('别名归一：中文名 / 片名 / 英文写法都能落到同一份档案', () => {
  assert.equal(normalizeStyleId('zhangyimou'), 'zhangyimou');
  assert.equal(normalizeStyleId('张艺谋'), 'zhangyimou');
  assert.equal(normalizeStyleId('大风国色'), 'zhangyimou');
  assert.equal(normalizeStyleId('ANG LEE'), 'ang-lee');
  assert.equal(normalizeStyleId('angLee'), 'ang-lee');
  assert.equal(normalizeStyleId('ang_lee'), 'ang-lee');
  assert.equal(normalizeStyleId(' 侯孝贤 '), 'hou-hsiao-hsien');
  assert.equal(normalizeStyleId('静默暴烈'), 'kitano');
  assert.equal(normalizeStyleId('黑泽明'), 'kurosawa');
  assert.equal(normalizeStyleId('宫崎骏'), 'miyazaki');
  assert.equal(normalizeStyleId('not-a-director'), '');
  assert.equal(normalizeStyleId(''), '');
  assert.equal(normalizeStyleId(null), '');
  assert.equal(isDirectorStyle('kitano'), true);
  assert.equal(isDirectorStyle('full'), false);
  assert.equal(getDirectorStyle('x'), null);
  assert.equal(getDirectorStyle('王家卫').id, 'wongkarwai');
});

test('调色板收敛：默认主色 / 指定主色 / 非法 key 都有确定结果', () => {
  const z = STYLE_BY_ID.zhangyimou;
  assert.equal(resolvePalette(z).key, 'hero-red');
  assert.equal(resolvePalette(z, 'desert-yellow').key, 'desert-yellow');
  assert.equal(resolvePalette(z, 'nope').key, 'hero-red', '非法主色回落默认，不能返回 null');
  assert.equal(resolvePalette(null), null);
  const a = resolveAesthetic('zhangyimou', { paletteKey: 'inlinebogus' });
  assert.equal(a.paletteKey, 'hero-red');
  assert.equal(a.paletteHex, '#C81D25');
  assert.equal(resolveAesthetic(''), null);
});

test('美学对象：下游消费的字段齐全且是深拷贝，改它不影响档案', () => {
  const a = resolveAesthetic('kurosawa');
  for (const key of ['id', 'label', 'workTitle', 'director', 'paletteKey', 'paletteName',
    'paletteHex', 'colorRule', 'light', 'composition', 'camera', 'texture', 'tone',
    'visualStyle', 'pacing', 'shotStrategy', 'audioStrategy', 'stylePrompt', 'negativePrompt']) {
    assert.ok(a[key] !== undefined && a[key] !== null, `美学对象缺 ${key}`);
  }
  assert.deepEqual(Object.keys(a.pace).sort(), ['fixedShotRatio', 'maxShotSec', 'minShotSec', 'mode']);
  a.taboos.push('污染项');
  a.continuityRules.length = 0;
  a.pace.minShotSec = 99;
  assert.ok(!STYLE_BY_ID.kurosawa.taboos.includes('污染项'), '美学对象必须是拷贝');
  assert.ok(STYLE_BY_ID.kurosawa.continuityRules.length > 0);
  assert.notEqual(STYLE_BY_ID.kurosawa.pace.minShotSec, 99);
});

test('正负提示词：内容在前、主色与风格在后，负向词合并去重', () => {
  const base = '雨夜街头，男人撑伞独行';
  const out = aestheticPrompt('wongkarwai', { base });
  assert.equal(out.applied, true);
  assert.ok(out.positive.startsWith(base), '用户内容必须排在最前，不能被风格淹没');
  assert.ok(out.positive.includes('霓虹琥珀'), '主色名要进正向提示词');
  assert.ok(out.positive.includes('#D99A3C'), '色号要进正向提示词');
  assert.ok(out.positive.includes(STYLE_BY_ID.wongkarwai.stylePrompt));
  assert.ok(out.positive.split('｜').length >= 3);
  assert.ok(out.negative.includes('flat studio lighting'));

  // 换主色：语干不变，主色词变
  const alt = aestheticPrompt('wongkarwai', { base, paletteKey: 'rain-teal' });
  assert.ok(!alt.positive.includes('霓虹琥珀'));
  assert.ok(alt.positive.includes('夜雨青'));
  assert.equal(alt.style.paletteHex, '#1B2A38');

  // 用户自带否定词要拼在后面，不能丢
  const withNeg = aestheticPrompt('kitano', { base, extraNegative: 'logo, subtitles' });
  assert.ok(withNeg.negative.includes('logo, subtitles'));
  assert.ok(withNeg.negative.includes('slow motion violence'));

  // 空 base 也要产出可用提示词；无风格时原样返回，不制造噪音
  const noBase = aestheticPrompt('zhangyimou', {});
  assert.ok(noBase.positive.includes('英雄红'));
  const none = aestheticPrompt('', { base, extraNegative: 'blur' });
  assert.deepEqual({ p: none.positive, n: none.negative, applied: none.applied }, { p: base, n: 'blur', applied: false });
  assert.equal(none.style, null);
});

test('分镜后缀：主色 / 光线 / 构图 / 媒介按 seed 轮换，不重复主体描述', () => {
  const seg0 = aestheticShotSuffix('zhangyimou', { seed: 0 });
  const seg1 = aestheticShotSuffix('zhangyimou', { seed: 1 });
  assert.ok(seg0.includes('主色 英雄红'));
  assert.ok(seg0.includes(STYLE_BY_ID.zhangyimou.light));
  assert.ok(seg0.includes(STYLE_BY_ID.zhangyimou.composition));
  assert.ok(seg0.includes(STYLE_BY_ID.zhangyimou.medium[0]));
  assert.ok(seg1.includes(STYLE_BY_ID.zhangyimou.medium[1 % 3]), 'seed 变化要换媒介，避免十镜同天气');
  assert.equal(aestheticShotSuffix(''), '');
  assert.equal(aestheticShotSuffix('not-a-director'), '');
});

test('零 Key 导演阐述基线：标题署名导演、视听方案来自档案、不是通用模板', () => {
  const vars = { title: '雨夜来信', logline: '退役刑警收到十年前的信' };
  const t = aestheticTreatment('kitano', vars);
  assert.ok(t.title.includes('雨夜来信'));
  assert.ok(t.title.includes(STYLE_BY_ID.kitano.workTitle), '阐述要署名参考导演，用户才知道画面基准');
  assert.equal(t.logline, vars.logline);
  assert.equal(t.styleId, 'kitano');
  assert.equal(t.tone, STYLE_BY_ID.kitano.tone);
  assert.ok(t.visualStyle.includes(STYLE_BY_ID.kitano.visualStyle));
  assert.ok(t.visualStyle.includes(STYLE_BY_ID.kitano.palettes.find((p) => p.key === STYLE_BY_ID.kitano.defaultPalette).name));
  assert.equal(t.pacing, STYLE_BY_ID.kitano.pacing);
  assert.ok(t.shotStrategy.includes('【光线】') && t.shotStrategy.includes('【运镜】'));
  assert.equal(t.audioStrategy, STYLE_BY_ID.kitano.audioStrategy);
  assert.ok(t.continuityRules.length >= 3 && t.continuityRules.length <= 5);
  assert.ok(t.risks.length >= 2 && t.risks.length <= 3);

  // 不同导演的基线必须真的不同，否则「风格」就只是标签
  const a = aestheticTreatment('zhangyimou', vars);
  const b = aestheticTreatment('wongkarwai', vars);
  assert.notEqual(a.tone, b.tone);
  assert.notEqual(a.pacing, b.pacing);
  assert.notEqual(a.shotStrategy, b.shotStrategy);
  assert.notEqual(a.paletteKey, b.paletteKey);

  // 无标题给兜底，无风格返回 null
  assert.ok(aestheticTreatment('ang-lee', {}).title.includes('未命名影片'));
  assert.equal(aestheticTreatment(''), null);
});

test('十位导演的基线两两不同：不是同一份通用方案换了标题', () => {
  const vars = { title: '测试片', logline: '一句话故事' };
  const all = DIRECTOR_STYLES.map((s) => ({
    id: s.id,
    t: aestheticTreatment(s.id, vars),
  }));
  const key = (t) => [t.tone, t.visualStyle, t.pacing, t.shotStrategy, t.audioStrategy, t.paletteKey].join('|');
  const signatures = all.map((x) => key(x.t));
  assert.equal(new Set(signatures).size, 10, '十位导演的阐述签名必须两两不同');
  // 每份连戏约束也要有区别（不然只是配色不同）
  const rules = all.map((x) => x.t.continuityRules.join('|'));
  assert.equal(new Set(rules).size, 10, '连戏约束不能十位导演共用一套');
});

test('主色切换会改变阐述里的主色与色号，风格语干保持不变', () => {
  const vars = { title: '测试片', logline: '一句话故事' };
  const red = aestheticTreatment('zhangyimou', vars, { paletteKey: 'hero-red' });
  const green = aestheticTreatment('zhangyimou', vars, { paletteKey: 'bamboo-green' });
  assert.ok(red.visualStyle.includes('英雄红') && red.visualStyle.includes('#C81D25'));
  assert.ok(green.visualStyle.includes('竹林绿') && green.visualStyle.includes('#2F4F3A'));
  assert.notEqual(red.paletteKey, green.paletteKey);
  // 主色变了但导演语法没变
  assert.equal(red.tone, green.tone);
  assert.equal(red.pacing, green.pacing);
  assert.equal(red.shotStrategy, green.shotStrategy);
  assert.equal(red.audioStrategy, green.audioStrategy);
});

test('美学对象带上 Mock 自绘配色，且主色联动 accent', () => {
  const a = resolveAesthetic('zhangyimou');
  assert.ok(a.svg && Array.isArray(a.svg.sky) && a.svg.sky.length === 3, '必须带 svg 调色板，否则 Mock 出图退回默认配色');
  assert.equal(a.svg.accent, a.paletteHex, 'accent 必须跟随当前主色');
  const ink = resolveAesthetic('zhangyimou', { paletteKey: 'ink-black' });
  assert.equal(ink.svg.accent, '#12100F', '换主色后自绘配色要跟着变');
  assert.equal(ink.svg.sky.length, 3, '天空三段不能因换色丢失');
  for (const s of DIRECTOR_STYLES) {
    const x = resolveAesthetic(s.id);
    assert.ok(x.svg?.ground && x.svg?.fog && x.svg?.text, `${s.id} 的 svg 配色不全`);
  }
});

test('节奏标签：把数字档案说成人话，固定长镜占比够高才提', () => {
  assert.equal(paceLabel({ minShotSec: 6, maxShotSec: 12, fixedShotRatio: 0.7 }), '单镜 6–12s · 固定长镜 70%');
  assert.equal(paceLabel({ minShotSec: 3, maxShotSec: 3, fixedShotRatio: 0.2 }), '单镜 3s');
  assert.equal(paceLabel({ minShotSec: 3, maxShotSec: 6, fixedShotRatio: 0.2 }), '单镜 3–6s', '固定机位占比不到 30% 就不吹长镜');
  assert.equal(paceLabel({ minShotSec: 3, maxShotSec: 6, fixedShotRatio: 0.3 }), '单镜 3–6s · 固定长镜 30%', '30% 是阈值下沿，如实标注');
  assert.equal(paceLabel({}), '');
  assert.equal(paceLabel({ minShotSec: 0, maxShotSec: 5 }), '');
  for (const s of DIRECTOR_STYLES) assert.ok(paceLabel(s.pace), `${s.id} 节奏标签为空`);
});

test('技能卡投影：色块 / 节奏 / 媒介齐全，不含长文本与函数', () => {
  const card = styleCard('zhangyimou');
  assert.deepEqual(Object.keys(card).sort(), ['defaultPalette', 'director', 'icon', 'id', 'label', 'medium', 'paceLabel', 'palettes', 'tagline', 'workTitle'].sort());
  assert.equal(card.palettes.length, 4);
  assert.deepEqual(card.medium.length, 2, '卡片只带两个媒介，太长会挤爆网格');
  assert.ok(card.paceLabel.includes('单镜'));
  assert.equal(styleCard('nope'), null);
  assert.equal(listStyleCards().length, 10);
  assert.deepEqual(listStyleCards().map((c) => c.id), EXPECTED_IDS);
});

test('项目级美学解析：技能 > styleId > skillId，流程技能不产生风格', () => {
  const p = buildNovelProject({ name: '风格解析' }).project;
  assert.equal(resolveProjectAesthetic(p), null, '默认项目未选风格技能');

  p.management.director.skillId = 'zhangyimou';
  assert.equal(resolveProjectAesthetic(p).id, 'zhangyimou', '中文技能 id 也要能解析');

  // 只选技能、还没跑全流程时，styleId 由 director-skill 管理动作写入
  p.management.director.styleId = 'wongkarwai';
  assert.equal(resolveProjectAesthetic(p).id, 'wongkarwai', 'styleId 优先于 skillId');

  p.management.director.paletteKey = 'rain-teal';
  const a = resolveProjectAesthetic(p);
  assert.equal(a.paletteKey, 'rain-teal', '项目主色偏好要生效');
  assert.equal(a.paletteHex, '#1B2A38');

  assert.equal(resolveProjectAesthetic(p, 'kurosawa').id, 'kurosawa', '显式入参最高优先');
  assert.equal(resolveProjectAesthetic(p, 'full'), null, '流程策略技能不产生风格');
  assert.equal(resolveProjectAesthetic({}), null);
  assert.equal(resolveProjectAesthetic(null), null);
});

test('技能与风格对账：十份风格技能都能解析出同一份档案，说明不是两套数据', () => {
  const styleSkills = DIRECTOR_SKILLS.filter((s) => s.group === 'style');
  assert.equal(styleSkills.length, 10);
  for (const s of styleSkills) {
    assert.equal(getDirectorSkill(s.id).styleId, s.id);
    const a = skillAesthetic(s.id);
    assert.equal(a.id, s.id);
    assert.equal(a.label, STYLE_BY_ID[s.id].label);
    assert.equal(a.icon, STYLE_BY_ID[s.id].icon);
  }
  assert.equal(skillAesthetic('full'), null);
});
