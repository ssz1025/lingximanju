/* 第⑥步「任务状态」看板 · 单元测试
 * 运行：node --test tests/task-panel.test.mjs
 *
 * 看板是对画布节点的一次摊平：节点是唯一事实来源，所以这里重点验证
 * 「排队 / 进行中 / 已完成 / 失败」如何归类、时间戳怎么算、prompt_id 从哪取，
 * 避免出现「提示已完成但看板说进行中」这类口径不一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectShotTasks, groupTasks, taskPanelHTML, fmtDur } from '../public/task-panel.js';

const T0 = 1_760_000_000_000;

function makeProject() {
  return {
    nodes: [
      { id: 'shot1', type: 'shot', status: 'done', title: '镜头 1', data: { shot: { shotNo: 1, size: '中景', ffDesc: '雨夜巷口，侦探回头' } } },
      { id: 'kf1', type: 'keyframe', status: 'running', progress: 0.42, title: '关键帧 1',
        meta: { queuedAt: T0 - 30_000, startedAt: T0 - 20_000 },
        data: { candidates: [{ url: '/a.png', provider: 'comfyui', promptId: 'p_abc123', prompt: '雨夜巷口｜中景' }] } },
      { id: 'shot2', type: 'shot', status: 'done', title: '镜头 2', data: { shot: { shotNo: 2, size: '近景', ffDesc: '信封特写' } } },
      // 只排进了本次运行的计划、还没提交到 ComfyUI：必须显示为「等待发送」而不是「已发送」
      { id: 'kf2', type: 'keyframe', status: 'queued', title: '关键帧 2',
        meta: { queuedAt: T0 - 5_000 }, data: { shot: { shotNo: 2, size: '近景' } } },
      // 真正交给 ComfyUI 在等的：有 prompt_id 才算「已发送 · 排队中」
      { id: 'kf5', type: 'keyframe', status: 'queued', title: '关键帧 5',
        meta: { queuedAt: T0 - 8_000, submittedAt: T0 - 7_000, promptId: 'p_wait' },
        data: { shot: { shotNo: 5, size: '远景' }, candidates: [{ url: '', provider: 'comfyui', promptId: 'p_wait' }] } },
      { id: 'shot3', type: 'shot', status: 'done', title: '镜头 3', data: { shot: { shotNo: 3, size: '全景', ffDesc: '码头仓库' } } },
      { id: 'kf3', type: 'keyframe', status: 'done', title: '关键帧 3',
        meta: { queuedAt: T0 - 90_000, startedAt: T0 - 80_000, finishedAt: T0 - 60_000, durationMs: 20_000 },
        data: { shot: { shotNo: 3 }, candidates: [{ url: '/c.png', provider: 'comfyui', promptId: 'p_done', prompt: '码头仓库' }] } },
      { id: 'kf4', type: 'keyframe', status: 'error', error: 'ComfyUI 执行失败：OOM', title: '关键帧 4',
        meta: { startedAt: T0 - 40_000, finishedAt: T0 - 35_000 },
        data: { shot: { shotNo: 4, size: '特写' } } },
      { id: 'rv3', type: 'review', status: 'done', title: 'VLM 择优 3', meta: { durationMs: 800 } },
      { id: 'vid3', type: 'video', status: 'idle', title: '视频片段 3' },
      { id: 'event1', type: 'event', status: 'done', title: '事件' },
    ],
    edges: [
      { from: 'shot1', to: 'kf1' }, { from: 'shot2', to: 'kf2' },
      { from: 'shot3', to: 'kf3' }, { from: 'kf3', to: 'rv3' }, { from: 'rv3', to: 'vid3' },
    ],
  };
}

test('fmtDur：秒 / 分 / 小时三档', () => {
  assert.equal(fmtDur(0), '0:00');
  assert.equal(fmtDur(9_000), '0:09');
  assert.equal(fmtDur(83_000), '1:23');
  assert.equal(fmtDur(3_725_000), '1:02:05');
});

test('collectShotTasks：只收生成类节点，镜头号与提示词按上游镜头补齐', () => {
  const tasks = collectShotTasks(makeProject());
  assert.deepEqual(tasks.map((t) => t.kind), ['keyframe', 'keyframe', 'keyframe', 'review', 'video', 'keyframe', 'keyframe']);
  // 排序：镜头号优先，同镜按 关键帧 → 择优 → 视频
  assert.deepEqual(tasks.map((t) => t.shotNo), [1, 2, 3, 3, 3, 4, 5]);
  const kf2 = tasks.find((t) => t.nodeId === 'kf2');
  assert.equal(kf2.shotNo, 2);
  assert.equal(kf2.size, '近景');
  // review / video 自己没带 shot，必须沿入边回溯到镜头 3
  assert.equal(tasks.find((t) => t.nodeId === 'rv3').shotNo, 3);
  assert.equal(tasks.find((t) => t.nodeId === 'vid3').shotNo, 3);
});

test('collectShotTasks：prompt_id 与时间戳、状态如实映射', () => {
  const tasks = collectShotTasks(makeProject());
  const running = tasks.find((t) => t.nodeId === 'kf1');
  assert.equal(running.status, 'running');
  assert.equal(running.promptId, 'p_abc123');
  assert.equal(running.startedAt, T0 - 20_000);
  assert.equal(running.progress, 0.42);
  const planned = tasks.find((t) => t.nodeId === 'kf2');
  assert.equal(planned.status, 'planned', 'queued 但没有 prompt_id = 只是本地排期，不算已发送');
  assert.equal(planned.statusLabel, '等待发送');
  assert.equal(planned.promptId, '', '还没提交，不能凭空编一个 prompt_id');
  const sent = tasks.find((t) => t.nodeId === 'kf5');
  assert.equal(sent.status, 'queued', '有 prompt_id 才是真在 ComfyUI 队列里');
  assert.equal(sent.statusLabel, '已发送 · 排队中');
  assert.equal(sent.promptId, 'p_wait');
  assert.equal(sent.submittedAt, T0 - 7_000);
  const failed = tasks.find((t) => t.nodeId === 'kf4');
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /OOM/);
});

test('groupTasks：进行中 / 已发送排队 / 等待发送 / 已完成与失败 / 待发送 各自归位', () => {
  const g = groupTasks(collectShotTasks(makeProject()));
  assert.deepEqual(g.running.map((t) => t.nodeId), ['kf1']);
  assert.deepEqual(g.queued.map((t) => t.nodeId), ['kf5']);
  assert.deepEqual(g.planned.map((t) => t.nodeId), ['kf2']);
  assert.deepEqual(g.pending.map((t) => t.nodeId), ['vid3']);
  assert.deepEqual(g.settled.map((t) => t.nodeId).sort(), ['kf3', 'kf4', 'rv3']);
  assert.deepEqual(g.counts, { total: 7, running: 1, queued: 1, planned: 1, done: 2, error: 1, pending: 1 });
});

test('collectShotTasks：kinds 过滤让第⑥步只看画面类任务', () => {
  const visualOnly = collectShotTasks(makeProject(), { kinds: ['keyframe', 'review'] });
  assert.deepEqual([...new Set(visualOnly.map((t) => t.kind))], ['keyframe', 'review']);
  assert.equal(visualOnly.some((t) => t.kind === 'video'), false, '视频任务不混进分镜步');
  assert.equal(visualOnly.length, 6);
});

test('taskPanelHTML：三档发送态分开显示，且空项目给出引导而不是空白', () => {
  const html = taskPanelHTML(makeProject());
  assert.match(html, /任务状态/);
  assert.match(html, /进行中/);
  assert.match(html, /已发送 · ComfyUI 排队中/);
  assert.match(html, /等待发送/);
  assert.match(html, /已发送 · 最近完成/);
  assert.match(html, /p_abc123/);
  assert.match(html, /生成中/);
  assert.match(html, /失败/);
  // 只有 ComfyUI 真收到的才算排队，页头统计不能把本地排期算进去
  assert.match(html, /ComfyUI 排队 1/);
  assert.match(html, /等待发送 1/);
  const empty = taskPanelHTML({ nodes: [], edges: [] });
  assert.match(empty, /还没有可调度任务/);
});
