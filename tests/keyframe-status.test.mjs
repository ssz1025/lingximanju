/* 分镜出图口径：mock 占位图不算「已生成」，已完成步骤按真实产物自愈 */
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = new URL('..', import.meta.url).pathname;
const { isRealImage, isRealKeyframe, keyframeTally, allowMockArtifacts } =
  await import(`${ROOT}src/core/keyframe-status.mjs`);
const { reconcileSteps } = await import(`${ROOT}src/core/step-runner.mjs`);

const kf = (candidates, extra = {}) => ({ id: 'kf', type: 'keyframe', data: { candidates, ...extra } });

test('mock 自绘 SVG 不算真实出图，comfyui PNG 才算', () => {
  assert.equal(isRealImage({ url: '/assets/a.svg', provider: 'mock' }), false);
  assert.equal(isRealImage({ url: '/assets/a.svg' }), false, '没有 provider 的 svg 也不能算真实图');
  assert.equal(isRealImage({ url: '/assets/a.png', provider: 'comfyui' }), true);
  assert.equal(isRealImage({ url: '' }), false);
});

test('关键帧节点只要有一张真实候选就算已出图', () => {
  assert.equal(isRealKeyframe(kf([
    { url: '/assets/a.svg', provider: 'mock' },
    { url: '/assets/b.png', provider: 'comfyui' },
  ])), true);
  assert.equal(isRealKeyframe(kf([{ url: '/assets/a.svg', provider: 'mock' }])), false);
  assert.equal(isRealKeyframe(kf([])), false);
});

test('统计把真实图 / 占位图 / 待出图分成三份，占位不混入已出图', () => {
  const project = {
    nodes: [
      kf([{ url: '/assets/a.png', provider: 'comfyui' }]),
      kf([{ url: '/assets/b.png', provider: 'comfyui' }]),
      kf([{ url: '/assets/c.svg', provider: 'mock' }]),
      kf([]),
    ],
  };
  const t = keyframeTally(project);
  assert.deepEqual(t, { total: 4, real: 2, placeholder: 1, missing: 1 });
});

test('测试夹具开关只对显式标记的项目生效', () => {
  const project = { nodes: [kf([{ url: '/assets/c.svg', provider: 'mock' }])] };
  assert.equal(allowMockArtifacts(project), false);
  assert.equal(keyframeTally(project).real, 0);
  project.testFlags = { allowMockArtifacts: true };
  assert.equal(allowMockArtifacts(project), true);
  assert.equal(keyframeTally(project).real, 1);
});

test('「已完成」但只有占位图：reconcileSteps 降级为失败并写明原因', () => {
  const project = {
    id: 'prj_reconcile',
    nodes: [kf([{ url: '/assets/a.svg', provider: 'mock' }])],
    edges: [],
    management: { schema: 1, kind: 'novel', episodes: [], steps: [{ id: 'storyboard', status: 'done', note: '0 节点 · 0 波 · 0.0s' }] },
  };
  const fixed = reconcileSteps(project);
  assert.equal(fixed.length, 1);
  const step = project.management.steps.find((s) => s.id === 'storyboard');
  assert.equal(step.status, 'error');
  assert.equal(step.stale, true);
  assert.match(step.note, /已完成状态失效/);
  assert.match(step.note, /占位/);
});

test('真有图时不降级，并清掉上一次的 stale 标记', () => {
  const project = {
    id: 'prj_reconcile_ok',
    nodes: [kf([{ url: '/assets/a.png', provider: 'comfyui' }])],
    edges: [],
    management: { schema: 1, kind: 'novel', episodes: [], steps: [{ id: 'storyboard', status: 'done', note: '真实分镜图 1/1 张', stale: true }] },
  };
  const fixed = reconcileSteps(project);
  assert.equal(fixed.length, 0);
  const step = project.management.steps.find((s) => s.id === 'storyboard');
  assert.equal(step.status, 'done');
  assert.equal(step.stale, undefined);
});
