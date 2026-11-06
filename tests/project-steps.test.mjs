/* 创作项目管理层（六步状态机 + 管理动作 + 统计）· 单元测试
 * 运行：node --test tests/project-steps.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STEP_STATUS, STEPS, STEP_BY_ID,
  createManagement, ensureManagement, stepProgress,
  startStep, finishStep, resetStep, resetAllSteps,
  applyManageAction, projectStats, projectIndex,
} from '../src/core/project-steps.mjs';

const EPISODES = [
  { no: 1, title: '第 1 集 · 第一章', chars: 400, summary: '雨夜来信', hook: '来老地方', sourceTitles: ['第一章'] },
  { no: 2, title: '第 2 集 · 第二章', chars: 380, summary: '咖啡馆', hook: '沈默', sourceTitles: ['第二章'] },
];

function makeProject() {
  const m = createManagement({
    kind: 'novel', title: '测试小说',
    split: { strategy: 'chapter', targetChars: 400, maxEpisodes: 4 },
    deliverables: { video: true, pack: true },
    source: { filename: 'a.txt', title: '测试小说', totalChars: 800, chapterCount: 2, text: '正文'.repeat(400) },
    episodes: EPISODES,
  });
  return {
    id: 'p1', name: '测试小说', mode: 'novel',
    nodes: [
      { id: 'n1', type: 'script', status: 'done' },
      { id: 'n2', type: 'shot', status: 'done' },
      { id: 'n3', type: 'video', status: 'done' },
      { id: 'n4', type: 'final', status: 'idle' },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2', kind: 'anchor' },
      { id: 'e2', from: 'n2', to: 'n3', kind: 'ref' },
    ],
    settings: {},
    management: m,
  };
}

test('STEPS 定义六步，编号 1-6 且有理论映射', () => {
  assert.equal(STEPS.length, 6);
  assert.deepEqual(STEPS.map((s) => s.no), [1, 2, 3, 4, 5, 6]);
  for (const s of STEPS) {
    assert.ok(s.id && s.title && s.desc, `${s.id} 应有 id/title/desc`);
    assert.ok(Array.isArray(s.checklist) && s.checklist.length, `${s.id} 应有检查清单`);
    assert.ok(s.theory?.ref && s.theory?.text, `${s.id} 应有论文依据`);
    assert.ok(Array.isArray(s.theory.map) && s.theory.map.length, `${s.id} 应有落点映射`);
  }
  assert.deepEqual(STEPS.map((s) => s.id), ['upload', 'episodes', 'script', 'context', 'storyboard', 'deliver']);
});

test('STEP_BY_ID 索引与 STEPS 一致', () => {
  assert.equal(Object.keys(STEP_BY_ID).length, STEPS.length);
  for (const s of STEPS) assert.equal(STEP_BY_ID[s.id], s);
});

test('STEP_STATUS 四种状态齐备', () => {
  for (const k of ['pending', 'running', 'done', 'error']) {
    assert.ok(STEP_STATUS[k]?.label, `${k} 应有中文标签`);
  }
});

test('createManagement 小说项目：前两步自动完成，停在第 3 步', () => {
  const m = createManagement({ kind: 'novel', title: 'T', episodes: EPISODES });
  assert.equal(m.kind, 'novel');
  assert.equal(m.steps.length, 6);
  assert.equal(m.steps[0].status, 'done', '①上传 应自动完成');
  assert.equal(m.steps[1].status, 'done', '②分集 应自动完成');
  assert.equal(m.steps[2].status, 'pending', '③剧本 应待执行');
  assert.equal(m.currentStep, 3);
  assert.equal(m.episodes.length, 2);
  assert.equal(m.theory.defaults.k, 2);
  assert.equal(m.theory.defaults.anchorRequired, true);
  assert.ok(m.history.length >= 1);
});

test('createManagement 标准项目不带六步', () => {
  const m = createManagement({ kind: 'standard', title: 'S' });
  assert.equal(m.kind, 'standard');
  assert.deepEqual(m.steps, []);
  assert.equal(m.status, 'standard');
});

test('stepProgress 统计进度与百分比', () => {
  const m = createManagement({ kind: 'novel', title: 'T' });
  let p = stepProgress(m);
  assert.equal(p.total, 6);
  assert.equal(p.done, 2);
  assert.equal(p.percent, 33);
  assert.equal(p.allDone, false);
  assert.equal(p.currentId, 'script');

  startStep(m, 'script');
  p = stepProgress(m);
  assert.equal(p.running, 1);
  assert.equal(p.status, 'running');
  assert.equal(p.currentId, 'script');

  finishStep(m, 'script');
  p = stepProgress(m);
  assert.equal(p.done, 3);
  assert.equal(p.currentId, 'context');
});

test('stepProgress 全部完成时 percent 为 100', () => {
  const m = createManagement({ kind: 'novel', title: 'T' });
  for (const s of STEPS) { startStep(m, s.id); finishStep(m, s.id); }
  const p = stepProgress(m);
  assert.equal(p.allDone, true);
  assert.equal(p.percent, 100);
  assert.equal(p.status, 'done');
});

test('startStep / finishStep 记录耗时与历史', () => {
  const m = createManagement({ kind: 'novel', title: 'T' });
  startStep(m, 'script');
  const s = finishStep(m, 'script', { ok: true, note: '完成', durationMs: 1234 });
  assert.equal(s.status, 'done');
  assert.equal(s.durationMs, 1234);
  assert.equal(s.note, '完成');
  assert.equal(s.runs, 1);
  assert.ok(m.history[0].action === 'step:done');
});

test('finishStep 失败标记 error 且进度反映失败', () => {
  const m = createManagement({ kind: 'novel', title: 'T' });
  startStep(m, 'script');
  finishStep(m, 'script', { ok: false });
  const p = stepProgress(m);
  assert.equal(p.failed, 1);
  assert.equal(p.status, 'error');
  assert.equal(m.steps[2].status, 'error');
});

test('resetStep 可重置非自动步骤，不能重置自动步骤', () => {
  const m = createManagement({ kind: 'novel', title: 'T' });
  startStep(m, 'script'); finishStep(m, 'script');
  assert.ok(resetStep(m, 'script'));
  assert.equal(m.steps[2].status, 'pending');
  assert.equal(resetStep(m, 'upload'), null, '自动步骤不应可重置');
});

test('resetAllSteps 回到初始状态（已上传小说的项目）', () => {
  const m = createManagement({
    kind: 'novel', title: 'T',
    source: { text: '正文'.repeat(50), chapterCount: 1, totalChars: 200 },
  });
  startStep(m, 'script'); finishStep(m, 'script');
  resetAllSteps(m);
  assert.equal(m.steps.filter((s) => s.status === 'done').length, 2, '仅有原著时仅自动两步保持完成');
  assert.equal(m.currentStep, 3);
});

test('resetAllSteps 骨架项目：六步回到全部待执行', () => {
  const m = createManagement({ kind: 'novel', title: '骨架', skeleton: true });
  startStep(m, 'script'); finishStep(m, 'script');
  resetAllSteps(m);
  assert.equal(m.steps.filter((s) => s.status === 'done').length, 0, '无原著时 ①② 必须回到待执行，否则出现假完成');
  assert.equal(m.currentStep, 1, '当前停在第 ① 步');
});

test('createManagement 骨架模式：六步全 pending 且停在第 ① 步', () => {
  const m = createManagement({ kind: 'novel', title: '极简', skeleton: true, deliverables: { video: true, pack: true } });
  assert.equal(m.steps.length, STEPS.length);
  assert.equal(m.steps.every((s) => s.status === 'pending'), true, '骨架六步全待执行');
  assert.equal(m.currentStep, 1);
  assert.equal(m.source.text, '', '尚无原著');
  assert.equal(m.history[0].detail.includes('骨架'), true, '历史应记录骨架创建');
});

test('applyManageAction 重命名', () => {
  const p = makeProject();
  const r = applyManageAction(p, 'rename', '新名字');
  assert.equal(r.ok, true);
  assert.equal(p.name, '新名字');
  assert.equal(p.management.title, '新名字');
  assert.equal(applyManageAction(p, 'rename', '   ').ok, false, '空名应被拒绝');
});

test('applyManageAction 收藏与归档可切换', () => {
  const p = makeProject();
  applyManageAction(p, 'favorite');
  assert.equal(p.management.favorite, true);
  applyManageAction(p, 'favorite');
  assert.equal(p.management.favorite, false);
  applyManageAction(p, 'archive', true);
  assert.equal(p.management.archived, true);
  applyManageAction(p, 'archive');
  assert.equal(p.management.archived, false);
});

test('applyManageAction 标签去重、去空、限长', () => {
  const p = makeProject();
  applyManageAction(p, 'tags', ['科幻', '科幻', '  ', '长篇']);
  assert.deepEqual(p.management.tags, ['科幻', '长篇']);
  applyManageAction(p, 'tags', '甲,乙 丙');
  assert.deepEqual(p.management.tags, ['甲', '乙', '丙']);
});

test('applyManageAction 交付物同步到 outputMode', () => {
  const p = makeProject();
  let r = applyManageAction(p, 'deliverables', { video: true, pack: false });
  assert.equal(p.settings.comfy.outputMode, 'video');
  r = applyManageAction(p, 'deliverables', { video: false, pack: true });
  assert.equal(p.settings.comfy.outputMode, 'director-pack');
  r = applyManageAction(p, 'deliverables', { video: true, pack: true });
  assert.equal(p.settings.comfy.outputMode, 'both');
  r = applyManageAction(p, 'deliverables', { video: false, pack: false });
  assert.equal(r.ok, false, '至少要一种交付物');
});

test('applyManageAction 分集参数仅小说项目可改', () => {
  const p = makeProject();
  const r = applyManageAction(p, 'split', { strategy: 'scene', targetChars: 800, maxEpisodes: 6 });
  assert.equal(r.ok, true);
  assert.equal(p.management.split.strategy, 'scene');
  assert.equal(p.management.split.targetChars, 800);
  const std = { id: 'x', name: 's', nodes: [], edges: [], management: createManagement({ kind: 'standard' }) };
  assert.equal(applyManageAction(std, 'split', { strategy: 'scene' }).ok, false);
});

test('applyManageAction 备注与未知动作', () => {
  const p = makeProject();
  applyManageAction(p, 'note', '这是一条备注');
  assert.equal(p.management.note, '这是一条备注');
  const r = applyManageAction(p, '不存在的动作');
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('未知'));
});

test('applyManageAction 重置六步', () => {
  const p = makeProject();
  startStep(p.management, 'script'); finishStep(p.management, 'script');
  const r = applyManageAction(p, 'reset-steps');
  assert.equal(r.ok, true);
  assert.equal(p.management.steps[2].status, 'pending');
});

test('projectStats 统计节点、连线与集数', () => {
  const p = makeProject();
  const s = projectStats(p);
  assert.equal(s.nodeCount, 4);
  assert.equal(s.edgeCount, 2);
  assert.equal(s.doneNodes, 3);
  assert.equal(s.shotCount, 1);
  assert.equal(s.videoCount, 1);
  assert.equal(s.anchorCount, 1);
  assert.equal(s.refCount, 1);
  assert.equal(s.episodeCount, 2);
  assert.equal(s.pack, null, '未产出时无导演包');
  assert.equal(s.film, null);
});

test('projectStats 读取已产出的成片与导演包', () => {
  const p = makeProject();
  p.nodes.find((n) => n.type === 'final').data = {
    film: { file: 'a.mp4', bytes: 1024 },
    directorPack: { file: 'a.mmxpack.zip', filename: 'a.mmxpack.zip', bytes: 2048, fileCount: 12 },
  };
  const s = projectStats(p);
  assert.equal(s.film.file, 'a.mp4');
  assert.equal(s.pack.fileCount, 12);
});

test('projectIndex 输出侧栏索引字段', () => {
  const p = makeProject();
  const idx = projectIndex(p);
  assert.equal(idx.id, 'p1');
  assert.equal(idx.kind, 'novel');
  assert.equal(idx.episodeCount, 2);
  assert.equal(idx.stepDone, 2);
  assert.equal(idx.stepTotal, 6);
  assert.equal(idx.favorite, false);
  assert.equal(idx.archived, false);
  assert.deepEqual(idx.deliverables, { video: true, pack: true });
  assert.equal(idx.hasPack, false);
});

test('ensureManagement 为老项目惰性补齐元数据', () => {
  const p = { id: 'old', name: '老项目', nodes: [], edges: [] };
  const m = ensureManagement(p);
  assert.equal(m.schema, 1);
  assert.equal(m.kind, 'standard');
  assert.equal(p.management, m);
});

test('管理历史有上限，不会无限膨胀', () => {
  const p = makeProject();
  for (let i = 0; i < 200; i++) applyManageAction(p, 'note', `备注 ${i}`);
  assert.ok(p.management.history.length <= 60, `历史长度 ${p.management.history.length} 应被限制在 60 内`);
});

/* ---------------------------------------------------------------- 项目封面管理动作 */
test('createManagement 初始化名称封面，ensureManagement 兼容老项目', () => {
  const p = makeProject();
  assert.deepEqual(p.management.cover.source, 'name');
  assert.equal(p.management.cover.url, '');
  const old = { id: 'old', name: '老项目', nodes: [], edges: [], management: createManagement({}) };
  delete old.management.cover;
  const m = ensureManagement(old);
  assert.equal(m.cover.source, 'name');
  assert.equal(m.cover.url, '');
});

test('applyManageAction cover：上传 / ComfyUI 生成 / 恢复名称封面', () => {
  const p = makeProject();
  let out = applyManageAction(p, 'cover', { url: '/assets/a.png', source: 'upload', prompt: '' });
  assert.equal(out.ok, true);
  assert.equal(p.management.cover.source, 'upload');
  assert.equal(p.management.cover.url, '/assets/a.png');
  assert.ok(out.cover.updatedAt > 0);

  out = applyManageAction(p, 'cover', { url: '/assets/b.png', source: 'comfyui', prompt: '雨夜霓虹' });
  assert.equal(out.ok, true);
  assert.equal(p.management.cover.source, 'comfyui');
  assert.equal(p.management.cover.prompt, '雨夜霓虹');

  out = applyManageAction(p, 'cover', { source: 'name' });
  assert.equal(out.ok, true);
  assert.equal(p.management.cover.source, 'name');
  assert.equal(p.management.cover.url, '', '恢复名称封面必须清空 url');

  // 非法来源按名称封面兜底；非名称来源缺 url 被拒绝
  out = applyManageAction(p, 'cover', { url: '/assets/c.png', source: 'unknown' });
  assert.equal(out.ok, true);
  assert.equal(p.management.cover.source, 'name');
  out = applyManageAction(p, 'cover', { source: 'upload' });
  assert.equal(out.ok, false);
  assert.match(out.message, /不能为空/);

  assert.ok(p.management.history.filter((h) => h.action === 'cover').length >= 3);
});

test('applyManageAction cover：url 钳制 300，提示词完整保存不截断', () => {
  const p = makeProject();
  applyManageAction(p, 'cover', { url: '/assets/' + 'x'.repeat(500), source: 'upload', prompt: 'p'.repeat(800) });
  assert.equal(p.management.cover.url.length, 300);
  // 提示词即完整提示词：生成时用什么就存什么（>500 字不得截断，否则无法复现生成结果）
  assert.equal(p.management.cover.prompt.length, 800);
});

test('projectIndex 下发 cover 字段（供侧栏卡片渲染）', () => {
  const p = makeProject();
  const idx = projectIndex(p);
  assert.ok('cover' in idx);
  assert.equal(idx.cover.source, 'name');
  applyManageAction(p, 'cover', { url: '/assets/x.png', source: 'comfyui', prompt: '海报' });
  const idx2 = projectIndex(p);
  assert.equal(idx2.cover.source, 'comfyui');
  assert.equal(idx2.cover.url, '/assets/x.png');
  assert.equal(idx2.cover.prompt, '海报');
});

test('projectIndex 下发项目级 tokens 累积（按 runs 汇总）', () => {
  const p = makeProject();
  p.runs = [
    { id: 'r1', status: 'done', tokens: { prompt: 100, completion: 30, total: 130, calls: 1 } },
    { id: 'r2', status: 'done', tokens: { prompt: 220, completion: 70, total: 290, calls: 2 } },
    { id: 'r3', status: 'error' },                     // 旧运行无 tokens 字段也应兼容
  ];
  const idx = projectIndex(p);
  assert.deepEqual(idx.tokens, { prompt: 320, completion: 100, total: 420, calls: 3 });
  const idxEmpty = projectIndex({ ...p, runs: [] });
  assert.deepEqual(idxEmpty.tokens, { prompt: 0, completion: 0, total: 0, calls: 0 });
});

/* ---------------------------------------------------------------- Token 用量统计 */
test('finishStep 记录本次运行 tokens 并按运行累加，startStep 清空上次明细', () => {
  const m = createManagement({ kind: 'novel', title: 'T' });
  startStep(m, 'script');
  const s1 = finishStep(m, 'script', { ok: true, tokens: { prompt: 100, completion: 40, total: 140, calls: 1 } });
  assert.equal(s1.tokens.total, 140);
  assert.equal(s1.tokens.calls, 1);
  assert.deepEqual(s1.lastTokens, { prompt: 100, completion: 40, total: 140, calls: 1 });

  startStep(m, 'script');
  assert.equal(m.steps[2].lastTokens, null, '重跑开始时上次运行明细应清空');
  finishStep(m, 'script', { ok: true, tokens: { prompt: 50, completion: 10, total: 60, calls: 2 } });
  assert.equal(m.steps[2].tokens.total, 200, 'tokens 按运行累加，重跑不丢历史');
  assert.equal(m.steps[2].tokens.calls, 3);
  assert.equal(m.steps[2].lastTokens.total, 60, 'lastTokens 只保留最近一次');
  assert.ok(m.history[0].detail.includes('200'), '历史应记录 token 汇总');
});

test('finishStep 未传 tokens 时保持零值，resetStep 清零 tokens', () => {
  const m = createManagement({ kind: 'novel', title: 'T' });
  startStep(m, 'script');
  const s = finishStep(m, 'script');
  assert.equal(s.tokens.total, 0, 'Mock/auto 步骤无 LLM 调用，tokens 为 0');
  assert.equal(s.lastTokens, null);

  finishStep(m, 'context', { ok: true, tokens: { prompt: 10, completion: 5, total: 15, calls: 1 } });
  resetStep(m, 'context');
  assert.deepEqual(m.steps[3].tokens, { prompt: 0, completion: 0, total: 0, calls: 0 });
  assert.equal(m.steps[3].lastTokens, null);
});

test('resetAllSteps 与 projectStats 的 tokens 汇总', () => {
  const m = createManagement({
    kind: 'novel', title: 'T',
    source: { text: '正文'.repeat(50), chapterCount: 1, totalChars: 200 },
  });
  finishStep(m, 'script', { ok: true, tokens: { prompt: 100, completion: 30, total: 130, calls: 1 } });
  finishStep(m, 'context', { ok: true, tokens: { prompt: 220, completion: 70, total: 290, calls: 2 } });
  const stats = projectStats({ id: 'p', name: 'T', nodes: [], edges: [], management: m });
  assert.deepEqual(stats.tokens, { prompt: 320, completion: 100, total: 420, calls: 3 });

  resetAllSteps(m);
  assert.equal(m.steps.every((s) => s.tokens.total === 0 && s.lastTokens === null), true, '全部重置后 tokens 清零');
});

/* ---------------------------------------------------------------- 角色库管理动作 */
test('createManagement 初始化角色库，ensureManagement 为老项目补齐并归一', () => {
  const p = makeProject();
  assert.deepEqual(p.management.characters, []);

  const old = { id: 'old', name: '老项目', nodes: [], edges: [], management: createManagement({}) };
  delete old.management.characters;
  assert.deepEqual(ensureManagement(old).characters, []);

  // 旧数据逐项归一：补 id、过滤非法 palette、补 views 结构
  old.management.characters = [{ name: '林晚', palette: ['#112233', 'red'], source: 'llm' }];
  const m = ensureManagement(old);
  assert.equal(m.characters.length, 1);
  assert.ok(m.characters[0].id);
  assert.deepEqual(m.characters[0].palette, ['#112233']);
  assert.deepEqual(m.characters[0].views, { front: null, side: null, back: null });
});

test('applyManageAction char-upsert：新增 / 更新 / 校验', () => {
  const p = makeProject();
  let r = applyManageAction(p, 'char-upsert', { name: '林晚', role: '女主角', palette: ['#112233'] });
  assert.equal(r.ok, true);
  assert.equal(r.character.name, '林晚');
  assert.equal(r.character.source, 'manual');
  assert.equal(p.management.characters.length, 1);
  const id = r.character.id;

  // 更新：保留 source 与 views，只改属性
  p.management.characters[0].source = 'llm';
  p.management.characters[0].views.front = { file: 'a.png', url: '/assets/a.png', prompt: '', provider: '', at: 1 };
  r = applyManageAction(p, 'char-upsert', { id, name: '林晚', role: '女一号', gender: '女' });
  assert.equal(r.ok, true);
  assert.equal(p.management.characters.length, 1, '按 id 更新不应新增');
  assert.equal(p.management.characters[0].role, '女一号');
  assert.equal(p.management.characters[0].source, 'llm', '更新保留原来源');
  assert.equal(p.management.characters[0].views.front.url, '/assets/a.png', '更新不碰 views 产物');

  assert.equal(applyManageAction(p, 'char-upsert', { name: '   ' }).ok, false, '空名应被拒绝');
  assert.ok(p.management.history.filter((h) => h.action === 'characters').length >= 2);
});

test('applyManageAction char-upsert：上限 12 个角色', () => {
  const p = makeProject();
  for (let i = 0; i < 12; i++) {
    assert.equal(applyManageAction(p, 'char-upsert', { name: `角色${i}` }).ok, true);
  }
  const r = applyManageAction(p, 'char-upsert', { name: '第13个' });
  assert.equal(r.ok, false);
  assert.match(r.message, /最多/);
  assert.equal(p.management.characters.length, 12);
});

test('applyManageAction char-del：按 id 删除，不存在则拒绝', () => {
  const p = makeProject();
  const { character } = applyManageAction(p, 'char-upsert', { name: '沈默' });
  assert.equal(applyManageAction(p, 'char-del', character.id).ok, true);
  assert.deepEqual(p.management.characters, []);
  assert.equal(applyManageAction(p, 'char-del', 'chr_none').ok, false);
});

test('applyManageAction characters：整体替换并归一（滤空名、限上限）', () => {
  const p = makeProject();
  const list = Array.from({ length: 15 }, (_, i) => ({ name: i < 14 ? `角色${i}` : '', palette: ['bad', '#aabbcc'] }));
  const r = applyManageAction(p, 'characters', list);
  assert.equal(r.ok, true);
  assert.equal(p.management.characters.length, 12, '滤掉空名后仍受 12 上限约束');
  assert.deepEqual(p.management.characters[0].palette, ['#aabbcc'], '非法配色被过滤');
  assert.ok(p.management.characters[0].id);
});
