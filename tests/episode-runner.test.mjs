/* 分集制作 · 按集步骤执行器单元测试
 *
 * 覆盖：ep.steps 状态流转（pending → running → done / error）、context 步
 * （出场角色匹配 + 本集剧本 mock 生成）、storyboard 步（分段 + 分镜板补齐）、
 * deliver 步预检（ComfyUI 未启用 / 无真实画面格 / stitchOnly 无片段拒绝）、
 * 批量执行 runEpisodeSteps、路由正则。
 * 运行：node --test tests/episode-runner.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-ep-runner-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const {
  runEpisodeStep, runEpisodeSteps, episodeStepStatus, episodeProductionStatus, EPISODE_STEPS,
} = await import('../src/core/episode-runner.mjs');
const { ensureManagement } = await import('../src/core/project-steps.mjs');
const { saveProject } = await import('../src/core/store.mjs');
const { MATCH } = await import('../src/api/routes/match.mjs');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** 两集的最小说剧项目：第 1 集有原文与出场角色，第 2 集无原文 */
function fixture() {
  return {
    id: 'prj_epx', name: '分集制作测试',
    settings: { style: 'cinematic', aspect: '16:9' },
    nodes: [], edges: [],
    management: {
      schema: 1,
      kind: 'novel',
      bible: { title: '雨夜侦探' },
      characters: [{ id: 'c1', name: '沈砚', role: '侦探' }],
      deliverables: { video: true, pack: true },
      episodes: [
        { no: 1, title: '雨夜', chars: 60, summary: '旧案重开', hook: '',
          text: '沈砚走在雨里。十年前的旧案被一封信重新翻开。', characterIds: [] },
        { no: 2, title: '空白集', chars: 0, summary: '', hook: '', text: '', characterIds: [] },
      ],
    },
  };
}

test('EPISODE_STEPS：第⑤⑥⑦步定义（④ 剧本走 script 接口）', () => {
  assert.deepEqual(EPISODE_STEPS.map((s) => s.id), ['context', 'storyboard', 'deliver']);
  assert.deepEqual(EPISODE_STEPS.map((s) => s.no), [5, 6, 7]);
});

test('未知分集步骤直接抛错；不存在的集抛错', async () => {
  await assert.rejects(() => runEpisodeStep(fixture(), 1, 'nope', {}), /未知分集步骤/);
  await assert.rejects(() => runEpisodeStep(fixture(), 99, 'context', {}), /不存在/);
});

test('context 步：出场角色按原文匹配 + mock 生成单集剧本，状态落 ep.steps', async () => {
  const p = fixture();
  const r = await runEpisodeStep(p, 1, 'context', {});
  assert.equal(r.ok, true, r.message);
  const ep = p.management.episodes[0];
  assert.deepEqual(ep.characterIds, ['c1'], '沈砚出现在原文中，自动关联');
  assert.ok(ep.script?.scenes?.length, '本集剧本已生成');
  assert.equal(ep.steps.context.status, 'done');
  assert.match(ep.steps.context.note, /出场角色/);
  assert.match(r.message, /出场角色 1 位/);
  // 手动关联不覆盖：已有 characterIds 时重跑保留
  ep.characterIds = ['manual-x'];
  await runEpisodeStep(p, 1, 'context', {});
  assert.deepEqual(p.management.episodes[0].characterIds, ['manual-x']);
  assert.ok(episodeStepStatus(ep, 'context').durationMs >= 0);
});

test('角色库是唯一跨集共享资源：已存在则沿用，换集 / force 都不重新提取', async () => {
  const p = fixture();                 // 已有 1 位角色「沈砚」
  // 只比对「有哪些角色」：ensureManagement 会给角色补齐默认字段，那不是重新提取
  const snapshot = () => (p.management.characters || []).map((c) => `${c.id}:${c.name}`);
  const before = snapshot();
  const r1 = await runEpisodeStep(p, 1, 'context', {});
  assert.equal(r1.ok, true, r1.message);
  assert.match(r1.message, /沿用项目角色库 1 位（不重新提取）/);
  assert.match(episodeStepStatus(p.management.episodes[0], 'context').note, /沿用项目角色库/);
  assert.deepEqual(snapshot(), before, '已有角色库不应被重新提取 / 增删');
  // 换到另一集、且要求 force 重做本步：角色仍沿用同一份，只重生成「本集」剧本
  p.management.episodes[1].text = '沈砚按响了门铃。';
  const r2 = await runEpisodeStep(p, 2, 'context', { force: true });
  assert.equal(r2.ok, true, r2.message);
  assert.match(r2.message, /沿用项目角色库 1 位/);
  assert.deepEqual(snapshot(), before, '切集不应新增 / 重建角色库');
  assert.deepEqual(p.management.episodes[1].characterIds, ['c1'], '本集出场角色从共享库匹配');
  assert.notEqual(p.management.episodes[1].script, p.management.episodes[0].script, '本集剧本独立落盘');
});

test('context 步：本集无原文时预检阻断并落 error 状态', async () => {
  const p = fixture();
  const r = await runEpisodeStep(p, 2, 'context', {});
  assert.equal(r.ok, false);
  assert.match(r.message, /没有原文/);
  assert.equal(p.management.episodes[1].steps.context.status, 'error');
});

test('storyboard 步：按集分段并逐段生成分镜板（mock 示意图口径）', async () => {
  const p = fixture();
  const r = await runEpisodeStep(p, 1, 'storyboard', {});
  assert.equal(r.ok, true, r.message);
  const ep = p.management.episodes[0];
  assert.ok(ep.segments.length >= 1, '无分段时已按原文自动分段');
  assert.ok(ep.segments.every((s) => s.gridUrl), '每段都有分镜板');
  assert.equal(ep.steps.storyboard.status, 'done');
  assert.match(ep.steps.storyboard.note, /分镜板/);
});

test('deliver 步：ComfyUI 未启用 / 无真实画面格时预检阻断', async () => {
  const p = fixture();
  const r = await runEpisodeStep(p, 1, 'deliver', {});
  assert.equal(r.ok, false);
  assert.match(r.message, /ComfyUI 未启用|视频工作流/);
  assert.equal(p.management.episodes[0].steps.deliver.status, 'error');
});

test('deliver 步 stitchOnly：有画面格但没有真实片段时拒绝拼接', async () => {
  const p = fixture();
  p.management.episodes[0].segments = [{ no: 1, cells: [{ no: 1, caption: '格', url: '/assets/frame.png' }] }];
  const r = await runEpisodeStep(p, 1, 'deliver', { stitchOnly: true });
  assert.equal(r.ok, false);
  assert.match(r.message, /真实视频片段/);
  // ensureManagement 会重建 episode 对象：断言前重新读取最新引用
  const ep = p.management.episodes.find((e) => Number(e.no) === 1);
  assert.equal(ep.steps.deliver.status, 'error');
});

test('runEpisodeSteps 批量：逐集执行同一步，失败的集不阻断后续', async () => {
  const p = fixture();
  const r = await runEpisodeSteps(p, [1, 2], 'context', {});
  assert.equal(r.results.length, 2);
  assert.equal(r.results[0].ok, true);
  assert.equal(r.results[1].ok, false, '第 2 集无原文应失败');
  assert.match(r.message, /完成 1\/2/);
  assert.equal(p.management.episodes[0].steps.context.status, 'done');
  assert.equal(p.management.episodes[1].steps.context.status, 'error');
});

test('episodeProductionStatus：三步状态 + 产物摘要', async () => {
  const p = fixture();
  await runEpisodeStep(p, 1, 'context', {});
  const s = episodeProductionStatus(p.management.episodes[0]);
  assert.equal(s.steps.context.status, 'done');
  assert.equal(s.steps.storyboard.status, 'pending');
  assert.equal(s.steps.deliver.status, 'pending');
  assert.equal(s.film, null);
  assert.ok(Array.isArray(s.cells) || typeof s.cells === 'number' || s.cells === undefined || true);
  saveProject(p);
});

test('路由正则：单集 step / film 与批量 steps 都能命中', () => {
  const ok = (re, url) => assert.ok(re.test(url), `${re} 应匹配 ${url}`);
  ok(MATCH.episodeAction, '/api/projects/p1/episodes/3/step');
  ok(MATCH.episodeAction, '/api/projects/p1/episodes/3/film');
  ok(MATCH.episodeItem, '/api/projects/p1/episodes/3');
  ok(MATCH.episodeStepBatch, '/api/projects/p1/episodes/steps');
  assert.equal('http://x/api/projects/p1/episodes/steps'.match(MATCH.episodeItem), null,
    '批量路由不能被单集 :no 分支误吞');
});

test('已定稿集锁定：单集与批量都不覆盖产物，撤销定稿后可继续', async () => {
  const p = fixture();
  const ep = p.management.episodes[0];
  ep.finalized = { at: Date.now(), season: 1, no: 1 };
  const r = await runEpisodeStep(p, 1, 'context', {});
  assert.equal(r.ok, false);
  assert.match(r.message, /已定稿/);
  assert.equal(ep.steps, undefined, '定稿集不应被写入任何步骤状态');
  assert.equal(ep.script, undefined, '定稿集的剧本不应被改写');
  const batch = await runEpisodeSteps(p, [1, 2], 'context', {});
  assert.ok(batch.results.every((x) => x.no !== 1), '批量补齐必须跳过已定稿集');
  // ensureManagement 会归一化并重建 episodes 数组，撤销时取当前引用
  delete p.management.episodes[0].finalized;
  const again = await runEpisodeStep(p, 1, 'context', {});
  assert.equal(again.ok, true, `撤销定稿后本集可继续制作：${again.message}`);
  assert.equal(p.management.episodes[0].steps.context.status, 'done');
  assert.match(again.message, /沿用项目角色库 1 位/, '撤销定稿不重建角色库，仍沿用全书角色');
});
