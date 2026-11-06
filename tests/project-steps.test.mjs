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

test('resetAllSteps 回到初始状态', () => {
  const m = createManagement({ kind: 'novel', title: 'T' });
  startStep(m, 'script'); finishStep(m, 'script');
  resetAllSteps(m);
  assert.equal(m.steps.filter((s) => s.status === 'done').length, 2, '仅自动两步保持完成');
  assert.equal(m.currentStep, 3);
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

test('applyManageAction cover：url / prompt 长度钳制', () => {
  const p = makeProject();
  applyManageAction(p, 'cover', { url: '/assets/' + 'x'.repeat(500), source: 'upload', prompt: 'p'.repeat(800) });
  assert.equal(p.management.cover.url.length, 300);
  assert.equal(p.management.cover.prompt.length, 500);
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
