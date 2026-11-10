/* 导演 Agent 技能 · 纯逻辑单元测试
 * 覆盖：技能清单 / 归一与投影 / 运行计划（步骤范围、交付设置、前置条件）/
 *       最终产物验收（降级与缺失区分） / 项目状态与审计 / Agent 注册 /
 *       Provider 零 Key 导演阐述 / 路由正则。
 * 运行：node --test tests/director-skills.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  DIRECTOR_SKILLS, DIRECTOR_CAPABILITIES, CAP_BY_ID, DIRECTOR_STEP_MODES, DIRECTOR_SKILL_GROUPS,
  DEFAULT_DIRECTOR_SKILL, SKILL_BY_ID, normalizeDirectorSkillId, getDirectorSkill,
  directorSkillPublic, listDirectorSkills, listDirectorSkillsByGroup, skillAesthetic, isStyleSkill,
  defaultDirectorState, ensureDirectorState,
  planDirectorRun, verifyDirectorDeliverables,
} = await import('../src/core/director-skills.mjs');
const { DIRECTOR_STYLES, normalizeStyleId, getDirectorStyle } = await import('../src/core/director-styles.mjs');
const { createManagement, ensureManagement, applyManageAction } = await import('../src/core/project-steps.mjs');
const { buildNovelProject } = await import('../src/pipelines/novel-project.mjs');
const { createProviders } = await import('../src/core/providers.mjs');
const { listAgents, getAgent } = await import('../src/agents/index.mjs');
const { MATCH } = await import('../src/api/routes/match.mjs');

const skeleton = () => buildNovelProject({ name: '导演技能测试' }).project;

test('技能清单：14 项（4 流程 + 10 风格）、id 唯一、能力都能解析、步骤模式有说明', () => {
  assert.equal(DIRECTOR_SKILLS.length, 14, '4 项流程策略 + 10 位导演风格');
  assert.deepEqual(
    DIRECTOR_SKILLS.filter((s) => s.group === 'flow').map((s) => s.id),
    ['full', 'script', 'visual', 'pack'],
    '流程策略顺序固定，前端第一组按此渲染',
  );
  assert.deepEqual(
    DIRECTOR_SKILLS.filter((s) => s.group === 'style').map((s) => s.id),
    DIRECTOR_STYLES.map((s) => s.id),
    '风格技能必须与美学档案逐一对应，不能两处手写漂移',
  );
  assert.deepEqual(Object.keys(DIRECTOR_SKILL_GROUPS), ['flow', 'style']);
  assert.equal(new Set(DIRECTOR_SKILLS.map((s) => s.id)).size, DIRECTOR_SKILLS.length);
  for (const s of DIRECTOR_SKILLS) {
    assert.ok(s.label && s.summary && s.tagline, `${s.id} 缺文案`);
    assert.ok(DIRECTOR_SKILL_GROUPS[s.group], `${s.id} 分组未定义`);
    assert.ok(DIRECTOR_STEP_MODES[s.steps], `${s.id} 步骤模式未定义`);
    for (const cap of s.capabilities) assert.ok(CAP_BY_ID[cap], `${s.id} 引用了未实现的能力 ${cap}`);
    assert.ok(s.highlights.length >= 3);
    // 风格技能必须带 styleId，且能解析出美学档案；流程技能必须不带
    if (s.group === 'style') {
      assert.equal(s.styleId, s.id);
      assert.ok(getDirectorStyle(s.styleId), `${s.id} 缺少美学档案`);
      assert.equal(s.deliverables, null, '风格技能不得改动用户已选的交付组合');
    } else {
      assert.ok(!s.styleId, `${s.id} 是流程策略，不该带 styleId`);
    }
  }
  assert.equal(DIRECTOR_CAPABILITIES.length, 5, 'bible / treatment / characters / portraits / voices');
  assert.deepEqual(Object.keys(CAP_BY_ID), DIRECTOR_CAPABILITIES.map((c) => c.id));
});

test('技能归一：中文名 / 别名 / 脏输入都收敛到同一项，绝不写非法 id', () => {
  assert.equal(DEFAULT_DIRECTOR_SKILL, 'full');
  assert.equal(normalizeDirectorSkillId('visual'), 'visual');
  assert.equal(normalizeDirectorSkillId('  PACK '), 'pack');
  assert.equal(normalizeDirectorSkillId('not-exist'), 'full');
  assert.equal(normalizeDirectorSkillId(''), 'full');
  assert.equal(normalizeDirectorSkillId(null), 'full');
  assert.equal(getDirectorSkill('script').id, SKILL_BY_ID.script.id);
  assert.equal(getDirectorSkill('???').id, 'full');
  // 导演风格：中文名 / 片名 / 英文写法都能落到技能上，用户手输也不会失效
  assert.equal(normalizeDirectorSkillId('张艺谋'), 'zhangyimou');
  assert.equal(normalizeDirectorSkillId('大风国色'), 'zhangyimou');
  assert.equal(normalizeDirectorSkillId('ANG LEE'), 'ang-lee');
  assert.equal(normalizeDirectorSkillId('angLee'), 'ang-lee');
  assert.equal(normalizeDirectorSkillId('北野武'), 'kitano');
  assert.equal(normalizeDirectorSkillId('ting-hsiao'), 'full', '未知风格仍回落默认');
});

test('风格技能能力：skillAesthetic 给出可消费的调色板与节奏，流程技能返回 null', () => {
  const a = skillAesthetic('zhangyimou');
  assert.ok(a, '风格技能必须解析出美学档案');
  assert.equal(a.id, 'zhangyimou');
  assert.equal(a.paletteName, '英雄红', '不传 paletteKey 时用档案默认主色');
  assert.equal(a.paletteHex, '#C81D25');
  assert.ok(a.stylePrompt && a.negativePrompt && a.continuityRules.length);
  const alt = skillAesthetic('zhangyimou', { paletteKey: 'desert-yellow' });
  assert.equal(alt.paletteName, '大漠黄', '主色可切换而风格不变');
  assert.equal(alt.stylePrompt, a.stylePrompt, '换主色不改提示词语干');
  assert.equal(skillAesthetic('full'), null, '流程策略技能不带美学');
  assert.equal(skillAesthetic('not-exist'), null);
  assert.equal(isStyleSkill('kitano'), true);
  assert.equal(isStyleSkill('visual'), false);
});

test('技能投影：带能力元数据与交付设置，风格卡额外带调色板/节奏，不含函数', () => {
  const pub = directorSkillPublic(SKILL_BY_ID.visual);
  assert.equal(pub.id, 'visual');
  assert.equal(pub.capabilities.length, 4, 'treatment / characters / portraits / voices');
  assert.ok(pub.capabilities.every((c) => c.label && c.desc));
  assert.deepEqual(pub.deliverables, { video: true, pack: true });
  assert.equal(pub.stepMode.label, '智能体四步');
  assert.equal(pub.repack, true);
  assert.equal(pub.group, 'flow');
  assert.equal(pub.groupLabel, '制片流程策略');
  assert.equal(pub.styleId, null);
  assert.equal(pub.style, null, '流程策略技能不该带风格卡');

  const style = directorSkillPublic(SKILL_BY_ID.zhangyimou);
  assert.equal(style.group, 'style');
  assert.equal(style.groupLabel, '导演风格');
  assert.equal(style.steps, 'all');
  assert.equal(style.deliverables, null, '风格技能不锁定交付物');
  assert.ok(style.style, '风格卡必须存在');
  assert.equal(style.style.palettes.length, 4);
  assert.ok(style.style.palettes.every((p) => p.name && p.hex));
  assert.match(style.style.paceLabel, /单镜 \d/);
  assert.ok(style.style.medium.length >= 1);

  const walk = (v) => {
    if (typeof v === 'function') return false;
    if (Array.isArray(v)) return v.every(walk);
    if (v && typeof v === 'object') return Object.values(v).every(walk);
    return true;
  };
  for (const s of listDirectorSkills()) assert.ok(walk(s), `${s.id} 投影里混进了函数`);
  assert.equal(listDirectorSkills().length, 14);
  assert.equal(directorSkillPublic(null), null);
});

test('技能分组：两组各取一段，风格卡片按档案顺序排列', () => {
  const groups = listDirectorSkillsByGroup();
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.id), ['flow', 'style']);
  const flow = groups.find((g) => g.id === 'flow');
  const style = groups.find((g) => g.id === 'style');
  assert.equal(flow.skills.length, 4);
  assert.equal(style.skills.length, 10);
  assert.equal(flow.skills.length + style.skills.length, 14, '分组不能漏卡或重复');
  assert.deepEqual(style.skills.map((s) => s.id), DIRECTOR_STYLES.map((s) => s.id));
  assert.ok(style.skills.every((s) => s.style && s.style.palettes.length >= 2));
  assert.ok(flow.desc.includes('交付物'), '分组说明要讲清职责边界');
});

test('项目状态：createManagement 带默认导演状态，老项目惰性补齐', () => {
  const m = createManagement({ kind: 'novel', title: '新项目' });
  assert.deepEqual(m.director, { schema: 1, skillId: 'full', treatment: null, lastRun: null });
  const p = skeleton();
  delete p.management.director;
  assert.ok(ensureManagement(p).director, '老项目应补齐导演状态');
  const legacy = {
    schema: 1, kind: 'novel',
    director: { schema: 1, skillId: 'not-exist', lastRun: { ok: true } },
  };
  const d = ensureDirectorState(legacy);
  assert.equal(d.skillId, 'full', '非法技能 id 应归一');
  assert.equal(d.treatment, null);
  assert.equal(d.lastRun.ok, true, '补齐不能丢掉历史运行报告');
  assert.deepEqual(defaultDirectorState().schema, 1);
});

test('管理动作 director-skill：只保存策略，非法形状明确拒绝', () => {
  const p = skeleton();
  const ok = applyManageAction(p, 'director-skill', { skillId: 'visual' });
  assert.equal(ok.ok, true);
  assert.equal(p.management.director.skillId, 'visual');
  assert.equal(p.management.history[0].action, 'director:skill');
  const bad = applyManageAction(p, 'director-skill', { skillId: 'BAD ID!' });
  assert.equal(bad.ok, false);
  assert.equal(p.management.director.skillId, 'visual', '失败不能改写已选技能');
});

test('管理动作 director-skill：中文名可落盘，未知 id 明确拒绝，换导演清空主色', () => {
  const p = skeleton();
  // 中文名 / 英文写法都要能选上，并把 styleId 一起写进项目
  for (const [input, expect] of [['张艺谋', 'zhangyimou'], ['ANG LEE', 'ang-lee'], ['北野武', 'kitano']]) {
    const out = applyManageAction(p, 'director-skill', { skillId: input });
    assert.equal(out.ok, true, `${input} 应能选上`);
    assert.equal(p.management.director.skillId, expect);
    assert.equal(out.styleId, expect);
    assert.equal(p.management.director.styleId, expect);
  }
  // 未知 id 必须拒绝，不能悄悄写进项目
  const unknown = applyManageAction(p, 'director-skill', { skillId: 'no-such-director' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /未知导演技能/);
  assert.equal(p.management.director.skillId, 'kitano', '拒绝时不能改掉已选技能');

  // 换导演必须清掉上一位的主色，避免「北野武 + 竹林绿」这种跨档案残留
  applyManageAction(p, 'director-skill', { skillId: 'zhangyimou' });
  applyManageAction(p, 'director-palette', { paletteKey: 'bamboo-green' });
  assert.equal(p.management.director.paletteKey, 'bamboo-green');
  applyManageAction(p, 'director-skill', { skillId: 'kitano' });
  assert.equal(p.management.director.paletteKey, null, '换导演后主色必须归零');
  // 流程策略技能不带风格，也要清空 styleId 与主色
  applyManageAction(p, 'director-skill', { skillId: 'pack' });
  assert.equal(p.management.director.styleId, null);
  assert.equal(p.management.director.paletteKey, null);
});

test('管理动作 director-palette：只改主色不换导演，非法色号列举可选值', () => {
  const p = skeleton();
  // 未选风格技能：明确拒绝
  const noStyle = applyManageAction(p, 'director-palette', { paletteKey: 'hero-red' });
  assert.equal(noStyle.ok, false);
  assert.match(noStyle.message, /尚未选择导演风格/);

  applyManageAction(p, 'director-skill', { skillId: 'zhangyimou' });
  const ok = applyManageAction(p, 'director-palette', { paletteKey: 'bamboo-green' });
  assert.equal(ok.ok, true);
  assert.equal(ok.name, '竹林绿');
  assert.equal(ok.hex, '#2F4F3A');
  assert.equal(p.management.director.paletteKey, 'bamboo-green');
  assert.equal(p.management.director.skillId, 'zhangyimou', '换主色不能改导演');
  assert.equal(p.management.history[0].action, 'director:palette');

  // 非法色号：resolvePalette 会回落默认色，这里必须拒绝并把可选值告诉用户
  const bad = applyManageAction(p, 'director-palette', { paletteKey: 'neon-amber' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /没有主色调 neon-amber/);
  assert.match(bad.message, /hero-red/, '错误信息要列出这位导演可选的主色');
  assert.equal(p.management.director.paletteKey, 'bamboo-green', '失败不能改掉已选主色');

  // 空色号回到档案默认色
  const reset = applyManageAction(p, 'director-palette', { paletteKey: '' });
  assert.equal(reset.ok, true);
  assert.equal(p.management.director.paletteKey, 'hero-red');
  assert.equal(skillAesthetic('zhangyimou', { paletteKey: p.management.director.paletteKey }).paletteName, '英雄红');
});

test('运行计划：all 六步 / core 四步，已 done 的步骤标记不重跑', () => {
  const p = skeleton();
  const m = p.management;
  const all = planDirectorRun({ project: p, m, skillId: 'full' });
  assert.equal(all.ok, true);
  assert.equal(all.plan.steps.length, 6);
  assert.deepEqual(all.plan.runStepIds, ['upload', 'episodes', 'script', 'context', 'storyboard', 'deliver']);
  assert.deepEqual(all.plan.deliverables, { video: true, pack: true }, 'full 沿用项目默认交付设置');
  assert.equal(all.plan.preconditions[0].ok, false, '骨架项目尚未准备原著');
  assert.ok(all.plan.warnings.some((w) => w.includes('演示小说')));

  const core = planDirectorRun({ project: p, m, skillId: 'visual' });
  assert.equal(core.plan.steps.length, 4);
  assert.deepEqual(core.plan.steps.map((s) => s.id), ['script', 'context', 'storyboard', 'deliver']);
  assert.ok(core.plan.steps.every((s) => !s.auto), 'core 不该含 auto 步骤');
  assert.deepEqual(core.plan.deliverables, { video: true, pack: true });

  m.steps.find((s) => s.id === 'script').status = 'done';
  const partial = planDirectorRun({ project: p, m, skillId: 'full' });
  assert.ok(!partial.plan.runStepIds.includes('script'), '已完成步骤不必重跑');
  const forced = planDirectorRun({ project: p, m, skillId: 'full', force: true });
  assert.ok(forced.plan.runStepIds.includes('script'), 'force 时重新纳入已完成步骤');
});

test('运行计划：交接包技能锁定交付物并给出警告；标准项目明确拒绝', () => {
  const p = skeleton();
  const r = planDirectorRun({ project: p, m: p.management, skillId: 'pack' });
  assert.deepEqual(r.plan.deliverables, { video: false, pack: true });
  assert.ok(r.plan.warnings.some((w) => w.includes('交付设置')));
  assert.ok(r.plan.warnings.some((w) => w.includes('跳过本地视频渲染')));
  assert.equal(r.plan.capabilities.length, 1, '交接包技能只有导演阐述一项附加能力');

  const std = createManagement({ kind: 'standard', title: '标准项目' });
  const denied = planDirectorRun({ project: { management: std }, m: std, skillId: 'full' });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /小说创作项目/);
});

test('最终产物验收：缺失 / 达成 / 降级分级，成片真实性按策略区分', () => {
  const p = skeleton();
  // 默认策略 real：没有真实 AI 片段就没有成片，判缺失而不是「降级算完成」
  const empty = verifyDirectorDeliverables(p, 'full');
  assert.equal(empty.complete, false);
  assert.ok(empty.missing >= 4);
  assert.equal(empty.items.find((i) => i.id === 'film').level, 'missing');
  assert.equal(empty.items.find((i) => i.id === 'aiVideo').required, true);
  assert.equal(empty.degraded, 0);
  assert.match(empty.summary, /未达成/);

  // 切到 preview：允许关键帧预览成片，但必须如实降级，绝不冒充真实成片
  p.management.runtime = { ...p.management.runtime, filmPolicy: 'preview' };
  const preview = verifyDirectorDeliverables(p, 'full');
  assert.equal(preview.complete, false, '缺其它产物时 preview 也不能判完成');
  assert.equal(preview.items.find((i) => i.id === 'film').level, 'degraded');
  assert.equal(preview.items.find((i) => i.id === 'aiVideo').required, false);
  assert.equal(preview.degraded, 2);
  p.management.runtime = { ...p.management.runtime, filmPolicy: 'real' };

  // 逐项补齐真实产物（不伪造 MP4：片段与成片都标 comfyui 来源）
  const m = p.management;
  m.source = { text: '原著正文', title: '测试小说', chapterCount: 1 };
  m.episodes = [{ no: 1, title: '第一集' }];
  m.steps.forEach((s) => { s.status = 'done'; });
  p.nodes.find((n) => n.type === 'script').data.script = { title: '测试剧本' };
  p.nodes.push({ type: 'shot' }, { type: 'keyframe' });
  // 验收含「成片时长规格」：构造一个真正符合 10 × 3s = 30s 的项目
  for (let i = 0; i < 10; i += 1) {
    p.nodes.push({ type: 'video', data: { duration: 3, sequence: i + 1, clip: { provider: 'comfyui', file: `clip${i}.mp4` } } });
  }
  const final = p.nodes.find((n) => n.type === 'final');
  final.data = final.data || {};
  final.data.timeline = Array.from({ length: 10 }, (_, i) => ({ index: i + 1, duration: 3 }));
  final.data.directorPack = { file: 'pack.zip', fileCount: 35, bytes: 2048, shotCount: 10 };
  final.data.film = { file: 'film.mp4', source: 'comfyui', isRealVideo: true, clips: 10, duration: 30, measured: true, bytes: 1048576 };
  final.data.comfyPromptIds = Array.from({ length: 10 }, (_, i) => `pid-${i}`);
  const done = verifyDirectorDeliverables(p, 'full');
  assert.equal(done.complete, true, done.summary);
  assert.equal(done.missing, 0);
  assert.equal(done.degraded, 0, '真实片段 + 真实成片不该有降级项');
  assert.equal(done.items.find((i) => i.id === 'film').level, 'ok');
  assert.equal(done.items.find((i) => i.id === 'film').isRealVideo, true);
  assert.equal(done.items.find((i) => i.id === 'aiVideo').level, 'ok');
  assert.equal(done.items.find((i) => i.id === 'runtime').level, 'ok', '时长规格应通过验收');
  assert.equal(done.runtime.spec.clipCount, 10);
  assert.match(done.summary, /已就绪/);

  // 时长规格是可核对的硬约束：任何一个片段变成 5s 都必须判未达成
  p.nodes.find((n) => n.type === 'video').data.duration = 5;
  const broken = verifyDirectorDeliverables(p, 'full');
  assert.equal(broken.items.find((i) => i.id === 'runtime').level, 'missing');
  assert.equal(broken.complete, false);
  p.nodes.find((n) => n.type === 'video').data.duration = 3;

  // 关键帧预览成片在 real 策略下必须判缺失，不能因为「有个 MP4」就算达成
  final.data.film = { file: 'preview.mp4', source: 'preview-frames', isRealVideo: false, clips: 10, duration: 30 };
  const fake = verifyDirectorDeliverables(p, 'full');
  assert.equal(fake.complete, false);
  assert.equal(fake.items.find((i) => i.id === 'film').level, 'missing');
  assert.equal(fake.items.find((i) => i.id === 'film').isRealVideo, false);

  // 交接包技能：不要求成片视频
  const onlyPack = verifyDirectorDeliverables(p, 'pack');
  assert.equal(onlyPack.complete, true);
  assert.equal(onlyPack.degraded, 0);
  assert.ok(!onlyPack.items.some((i) => i.id === 'film'));
});

test('风格技能不改交付组合：选了北野武仍沿用项目自己的视频 + 导演包设置', () => {
  const p = skeleton();
  const stylePlan = planDirectorRun({ project: p, m: p.management, skillId: 'kitano' });
  assert.equal(stylePlan.ok, true);
  assert.equal(stylePlan.plan.steps.length, 6, '风格技能跑完整六步');
  assert.deepEqual(stylePlan.plan.deliverables, { video: true, pack: true });
  assert.ok(!stylePlan.plan.warnings.some((w) => w.includes('把项目交付设置同步为')), '风格技能不该改写交付设置');

  // 项目原本关掉视频：风格技能必须尊重该设置，而不是硬拉回 true
  p.management.deliverables = { video: false, pack: true };
  const keep = planDirectorRun({ project: p, m: p.management, skillId: 'wongkarwai' });
  assert.deepEqual(keep.plan.deliverables, { video: false, pack: true });
  assert.ok(keep.plan.warnings.some((w) => w.includes('跳过本地视频渲染')));
});

test('Agent 注册：导演智能体是列表里的一等公民', () => {
  const meta = listAgents().find((a) => a.id === 'director');
  assert.ok(meta, '导演智能体未注册');
  assert.equal(meta.group, '导演');
  assert.equal(meta.label, '导演智能体');
  assert.match(meta.description, /一键跑完整部漫剧/);
  assert.equal(typeof getAgent('director').run, 'function');
});

test('Provider 零 Key 导演阐述：结构完整且只依据输入资料', async () => {
  const providers = createProviders({ provider: 'mock' }, () => {});
  const out = await providers.generate('directorTreatment', {
    title: '雨夜来信', logline: '退役刑警收到十年前的信', style: 'noir',
    idea: '退役刑警收到十年前的信',
    episodes: [{ title: '第一集', summary: '信到达' }],
    characters: [{ name: '沈砚', role: '刑警' }],
  });
  assert.equal(providers.mode, 'mock');
  assert.ok(out.title.includes('雨夜来信'));
  assert.ok(out.logline.includes('十年前'));
  assert.ok(out.tone && out.visualStyle && out.pacing && out.shotStrategy && out.audioStrategy);
  assert.ok(out.continuityRules.length >= 3);
  assert.ok(out.risks.length >= 2);
  assert.ok(out.visualStyle.includes('noir'), '风格应来自输入而不是编造');
});

test('路由正则：导演端点可匹配，且不会误吞其它项目路径', () => {
  assert.match('/api/projects/prj_1/director/skills', MATCH.directorSkills);
  assert.match('/api/projects/prj_1/director/run', MATCH.directorRun);
  assert.equal('/api/projects/prj_1/director/skills'.match(MATCH.directorSkills)[1], 'prj_1');
  assert.doesNotMatch('/api/projects/prj_1/director/run/extra', MATCH.directorRun);
  assert.doesNotMatch('/api/projects/prj_1/step', MATCH.directorRun);
  assert.doesNotMatch('/api/projects/prj_1/director-pack', MATCH.directorSkills);
});

test('验收回归：六步全 done、剧本 / 分镜已产出、仅成片未生成时，缺失项只剩成片相关', () => {
  // 用户报告的场景：第⑦步面板引用导演全流程的历史快照（当时剧本/分镜还没跑），
  // 六步完成后依然显示「统一格式剧本 / 分镜 / 成片时长规格」缺失。
  // 服务端实时验收必须与画布现状对齐：script / storyboard 立即翻绿。
  const p = skeleton();
  const m = p.management;
  m.source = { text: '原著正文', title: '测试小说', chapterCount: 1 };
  m.episodes = [{ no: 1, title: '第一集' }];
  m.steps.forEach((s) => { s.status = 'done'; });
  p.nodes.find((n) => n.type === 'script').data.script = { title: '测试剧本' };
  p.nodes.push({ type: 'shot', status: 'done' }, { type: 'keyframe', status: 'done' });

  const live = verifyDirectorDeliverables(p, 'full');
  assert.equal(live.items.find((i) => i.id === 'script').level, 'ok', '剧本节点已产出即达成');
  assert.equal(live.items.find((i) => i.id === 'storyboard').level, 'ok', '镜头 / 关键帧在画布上即达成');
  assert.equal(live.items.find((i) => i.id === 'steps').level, 'ok');
  assert.equal(live.items.find((i) => i.id === 'runtime').level, 'missing', '成片还没生成时如实判缺失');
  assert.doesNotMatch(live.summary, /统一格式剧本/, '摘要不再把已产出的剧本列为缺失');
  assert.doesNotMatch(live.summary, /分镜/);
  assert.match(live.summary, /成片时长规格/);
});

test('broadcastMeta 随事件附带实时最终产物验收（第⑦步面板的数据源）', async () => {
  const { subscribe } = await import('../src/core/events.mjs');
  const { broadcastMeta } = await import('../src/core/step-runner.mjs');
  const chunks = [];
  let closeCb = null;
  const req = { on: (ev, cb) => { if (ev === 'close') closeCb = cb; } };
  const res = { writeHead() {}, write(line) { chunks.push(line); } };
  subscribe(req, res);
  try {
    const p = skeleton();
    p.nodes.find((n) => n.type === 'script').data.script = { title: '测试剧本' };
    broadcastMeta(p);
    const events = chunks.filter((c) => c.startsWith('data: '))
      .map((c) => JSON.parse(c.slice(6)));
    const meta = events.find((e) => e.type === 'project:meta');
    assert.ok(meta, '应广播 project:meta');
    assert.equal(meta.projectId, p.id);
    assert.ok(meta.verification, '广播应包含实时最终产物验收');
    assert.equal(typeof meta.verification.complete, 'boolean');
    assert.ok(Array.isArray(meta.verification.items) && meta.verification.items.length >= 6);
    assert.equal(meta.verification.items.find((i) => i.id === 'script').level, 'ok');
  } finally {
    closeCb?.();   // 清掉 keepalive 定时器，避免挂住测试进程
  }
});
