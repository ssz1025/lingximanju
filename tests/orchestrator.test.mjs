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
await import('../src/agents/narrative.mjs');   // 注册 decomposer 等业务智能体
await import('../src/agents/visual.mjs');      // 注册 transition 等生成智能体

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
  assert.equal(summary.fallbacks, 0, 'Mock 流水线无 LLM 回退');
  assert.ok(summary.waves >= 3, `串行依赖必须分波（实际 ${summary.waves} 波）`);
  assert.equal(isRunning(p.id), false, '结束后从活跃表移除');

  const saved = loadProject(p.id);
  assert.ok(saved.nodes.every((n) => n.status === 'done' && n.data.ok), '结果已落盘');
  assert.ok(saved.nodes.every((n) => n.meta.llmFallback === 0), '节点 meta 记录回退次数');
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

test('LLM 回退显式化：summary.fallbacks 与 node.meta.llmFallback 计数', async () => {
  defineAgent({
    id: 't-gen', label: '生成桩', group: '测试',
    run: async (ctx) => {
      const out = await ctx.providers.generate('shots', { count: 2 });
      ctx.patch({ fallback: out.__fallback === true });
    },
  });
  const p = mkProject([{ agent: 't-gen' }]);
  // openai 模式指向不可达端点 → generate 必定回退 Mock 并打 __fallback
  p.settings = { provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1/chat/completions', apiKey: 'k', llmTimeoutMs: 300 };
  saveProject(p);
  const summary = await runProject(p.id);
  assert.equal(summary.status, 'done');
  assert.equal(summary.fallbacks, 1, '运行摘要统计 LLM 回退次数');
  const saved = loadProject(p.id);
  assert.equal(saved.nodes[0].meta.llmFallback, 1, '节点 meta 记录本节点回退次数');
  assert.equal(saved.nodes[0].data.fallback, true, '回退结果已打 __fallback 标');
  deleteProject(p.id);
});

test('decomposer 多场景递归展开：事件下所有场景都生成场景节点（式 5）', async () => {
  const p = mkProject([{ agent: 'decomposer' }]);
  p.nodes[0].type = 'decompose';   // scope 白名单隔离：动态展开的场景节点不继续往下跑
  p.nodes[0].data.script = {
    title: '测试剧本', logline: '一句话创意',
    characters: [{ name: '甲', role: '主角', appearance: '深色外套' }],
    scenes: [
      { id: 'sc_1', location: '巷口', time: '夜', summary: '开场：收到匿名信' },
      { id: 'sc_2', location: '警局', time: '凌晨', summary: '追问：证词出现矛盾' },
    ],
  };
  saveProject(p);
  const summary = await runProject(p.id, { scope: ['decompose'] });
  assert.equal(summary.status, 'done');

  const saved = loadProject(p.id);
  const decomposeNode = saved.nodes.find((n) => n.agent === 'decomposer');
  const eventNodes = saved.nodes.filter((n) => n.type === 'event');
  const sceneNodes = saved.nodes.filter((n) => n.type === 'scene');
  assert.equal(eventNodes.length, 2, '2 个输入场景 → 2 个事件');
  assert.equal(sceneNodes.length, 4, '每个事件的全部场景都展开（不是只取 scenes[0]）');
  assert.equal(decomposeNode.data.sceneCount, 4, 'sceneCount 统计真实场景总数');
  assert.equal(decomposeNode.data.shotPlan.length, 4, 'shotPlan 覆盖到每个场景');
  assert.ok(sceneNodes.every((n) => n.status === 'idle'), 'scope 外的场景节点不被本次调度');
  deleteProject(p.id);
});

test('camera-graph 真实拓扑分层：并行层按机位 parent 依赖图计算（式 7）', async () => {
  const p = mkProject([{ agent: 'camera-graph' }]);
  p.nodes[0].type = 'camgraph';
  p.nodes[0].data.shotPlan = [
    { scene: 1, location: '巷口', shots: Array.from({ length: 3 }, (_, i) => ({ shotNo: i + 1, size: '中景' })) },
    { scene: 2, location: '警局', shots: Array.from({ length: 3 }, (_, i) => ({ shotNo: i + 4, size: '特写' })) },
  ];
  saveProject(p);
  const summary = await runProject(p.id, { scope: ['camgraph'] });
  assert.equal(summary.status, 'done');

  const saved = loadProject(p.id);
  const node = saved.nodes.find((n) => n.agent === 'camera-graph');
  // 6 个镜头 → Mock 机位图 3 组链式依赖（cam1←cam2←cam3）→ 拓扑 3 层
  // 旧算式 ceil(6/并发3)=2 层是估算值，现在是依赖图的真实层数
  assert.equal(node.data.cameras.length, 3);
  assert.equal(node.data.parallelLayers, 3, '并行层 = 机位依赖图的真实拓扑层数');
  assert.equal(node.data.shotCount, 6);
  deleteProject(p.id);
});

test('transition 端点视图空间锚点：fromFrame/toFrame 成对（式 8）', async () => {
  const p = mkProject([{ agent: 'transition' }]);
  p.nodes[0].type = 'trans';
  p.nodes[0].data.fromCam = '机位 A';
  saveProject(p);
  const summary = await runProject(p.id, { scope: ['trans'] });
  assert.equal(summary.status, 'done');

  const saved = loadProject(p.id);
  const t = saved.nodes[0].data.transition;
  assert.ok(t.toFrame, '终点机位视图已生成');
  assert.ok(Array.isArray(t.frames) && t.frames.includes(t.toFrame), '端点视图成对进入 frames');
  assert.ok(t.axisRule, '轴线规则保留');
  assert.ok(t.video === undefined, 'Mock 下不产假转场视频（ComfyUI 可用才产）');
  deleteProject(p.id);
});
