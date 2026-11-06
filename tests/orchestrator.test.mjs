/* 编排器集成测试：波次调度 / scope 白名单 / 失败与跳过传播 / 取消 / 并发保护
 * 运行：node --test tests/orchestrator.test.mjs
 * 通过 defineAgent 注册可控的测试智能体（同步成功 / 抛错 / 可中断延时），
 * 全程 mock 模式，不产生任何网络请求。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-orch-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const { saveProject, loadProject, deleteProject, PROJECT_DIR } = await import('../src/core/store.mjs');
const { defineAgent } = await import('../src/core/agent.mjs');
const { runProject, stopProject, isRunning } = await import('../src/core/orchestrator.mjs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(() => {
  defineAgent({ id: 't-ok', label: '成功桩', group: '测试', run: async (ctx) => ctx.patch({ ok: true }) });
  defineAgent({ id: 't-fail', label: '失败桩', group: '测试', run: async () => { throw new Error('炸了'); } });
  defineAgent({
    id: 't-slow', label: '慢桩', group: '测试',
    run: (ctx) => new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 500);
      ctx.signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new DOMException('已取消', 'AbortError'));
      }, { once: true });
    }),
  });
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
const mkProject = (chain) => {
  const id = `prj_orch_${(seq += 1)}`;
  const nodes = chain.map((spec, i) => ({
    id: `${id}_n${i}`, type: `t${i}`, agent: spec.agent, title: `节点${i}`,
    x: 0, y: 0, w: 268, status: 'idle', progress: 0, error: '', data: {}, meta: {},
  }));
  const edges = nodes.slice(1).map((n, i) => ({ id: `${id}_e${i}`, from: nodes[i].id, to: n.id, kind: 'flow' }));
  const project = { id, name: id, mode: 'custom', nodes, edges, createdAt: Date.now(), updatedAt: Date.now(), runs: [] };
  saveProject(project);
  return project;
};

test('链式三节点：分波执行全部完成并持久化', async () => {
  const p = mkProject([{ agent: 't-ok' }, { agent: 't-ok' }, { agent: 't-ok' }]);
  const summary = await runProject(p.id);
  assert.equal(summary.status, 'done');
  assert.equal(summary.nodeCount, 3, '3 个节点各执行一次');
  assert.equal(summary.failed, 0);
  assert.ok(summary.waves >= 3, `串行依赖必须分波（实际 ${summary.waves} 波）`);
  assert.equal(isRunning(p.id), false, '结束后从活跃表移除');

  const saved = loadProject(p.id);
  assert.ok(saved.nodes.every((n) => n.status === 'done' && n.data.ok), '结果已落盘');
  assert.equal(saved.runs[0].status, 'done', '运行摘要写入 runs');
  deleteProject(p.id);
});

test('失败传播：上游 error → 下游 skipped；无智能体节点跳过', async () => {
  const p = mkProject([{ agent: 't-fail' }, { agent: 't-ok' }, { agent: 't-ok' }, { agent: null }]);
  const summary = await runProject(p.id);
  assert.equal(summary.failed, 1);
  assert.equal(summary.nodeCount, 0, '失败链上没有成功节点');
  const [a, b, c, d] = loadProject(p.id).nodes;
  assert.equal(a.status, 'error');
  assert.equal(a.error, '炸了');
  assert.equal(b.status, 'skipped');
  assert.equal(c.status, 'skipped', '跳过逐级向下游传播');
  assert.equal(d.status, 'skipped', '无智能体直接跳过');
  deleteProject(p.id);
});

test('scope 白名单：只调度指定类型的节点，其余保持 idle', async () => {
  const p = mkProject([{ agent: 't-ok' }, { agent: 't-ok' }]);
  const summary = await runProject(p.id, { scope: ['t1'] });
  assert.equal(summary.nodeCount, 1);
  const [first, second] = loadProject(p.id).nodes;
  assert.equal(first.status, 'idle', 't0 不在白名单内，保持 idle');
  assert.equal(second.status, 'done');
  deleteProject(p.id);
});

test('取消：stopProject 立即中断，节点回退 idle，状态 cancelled', async () => {
  const p = mkProject([{ agent: 't-slow' }, { agent: 't-slow' }, { agent: 't-slow' }]);
  const running = runProject(p.id);
  assert.equal(isRunning(p.id), true, '运行中登记');
  await assert.rejects(runProject(p.id), /已有运行中的任务/, '同一项目禁止并发运行');

  assert.equal(stopProject(p.id), true);
  assert.equal(stopProject('prj_not_exist'), false, '未运行项目返回 false');
  const summary = await running;
  assert.equal(summary.status, 'cancelled');
  assert.equal(summary.nodeCount, 0);
  assert.equal(isRunning(p.id), false);
  await wait(200); // 等 flush 定时器落地后核对
  assert.equal(loadProject(p.id).nodes[0].status, 'idle', '被中断节点回退 idle');
  deleteProject(p.id);
});
