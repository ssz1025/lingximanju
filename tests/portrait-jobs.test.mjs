/* 角色定妆后台任务：立即返回 jobId、可查询逐张进度、完成后落盘并给出可进视频判定
 * 运行：node --test tests/portrait-jobs.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-portrait-jobs-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const {
  startPortraitJob, getPortraitJob, getProjectPortraitJob, cancelPortraitJob, _resetPortraitJobs,
  stalePortraitJob,
} = await import('../src/core/portrait-jobs.mjs');

after(() => { _resetPortraitJobs(); fs.rmSync(TMP, { recursive: true, force: true }); });

const waitFor = async (fn, timeoutMs = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
  return null;
};

function makeProject(id, count = 1) {
  const characters = Array.from({ length: count }, (_, i) => ({
    id: `c${i + 1}`, name: ['林晚', '沈砚', '老周'][i] || `角色${i}`, views: {}, palette: ['#334455'],
  }));
  return { id, name: '任务测试', settings: {}, management: { characters, bible: {} } };
}

test('startPortraitJob：立即返回 running 任务，逐张进度可查，完成后写回并统计真实出图', async () => {
  const project = makeProject('prj_job_1', 2);
  let saves = 0;
  let finished = 0;
  const job = startPortraitJob({
    project, m: project.management,
    opts: { scope: 'core', sheet: true },
    hooks: { save: () => { saves += 1; }, onFinish: () => { finished += 1; } },
  });
  assert.ok(job.id, '必须返回 jobId');
  assert.equal(job.total, 2 * 4 + 2, '2 位角色 × 4 视图 + 2 张定妆板');
  assert.ok(['running', 'done'].includes(job.status));

  const final = await waitFor(() => {
    const j = getPortraitJob(job.id);
    return j && j.status !== 'running' ? j : null;
  });
  assert.ok(final, '任务应在超时前结束');
  assert.equal(final.status, 'done');
  assert.equal(final.generated, 8, '2 位角色 × 4 视图');
  assert.equal(final.sheets, 2, '2 张定妆板单独计数');
  assert.equal(final.failedCount, 0);
  assert.ok(saves >= 10, '每张都应落盘，刷新页面不丢进度');
  assert.equal(finished, 1, '完成回调只触发一次');
  for (const one of Object.values(final.byChar)) {
    assert.equal(one.status, 'done', `${one.name} 应为完成态`);
    assert.equal(Object.keys(one.views).length, 5, '4 视图 + 定妆板都要有状态');
  }
  // 图已写回项目对象（provider=mock 是零 Key 演示，不算真实出图但确实是产物）
  assert.ok(project.management.characters[0].views.front.url);
  assert.equal(getProjectPortraitJob('prj_job_1').id, job.id);
  assert.equal(cancelPortraitJob('nope'), null, '不存在的任务返回 null');
});

test('startPortraitJob：同一项目并发启动返回同一个运行中任务，不重复排队', async () => {
  _resetPortraitJobs();
  const project = makeProject('prj_job_2', 3);
  const first = startPortraitJob({ project, m: project.management, opts: { scope: 'all' } });
  const second = startPortraitJob({ project, m: project.management, opts: { scope: 'all' } });
  assert.equal(second.id, first.id, '运行中的任务必须复用，避免双倍 ComfyUI 队列');
  await waitFor(() => {
    const j = getPortraitJob(first.id);
    return j && j.status !== 'running';
  }, 15000);
});

/* ---------------- 任务快照落盘：内存任务表丢失后仍要能查回进度 ---------------- */

test('startPortraitJob：起点与终态都通过 hooks.persist 落盘快照（重启后可恢复）', async () => {
  _resetPortraitJobs();
  const project = makeProject('prj_job_persist', 1);
  const snaps = [];
  const job = startPortraitJob({
    project, m: project.management,
    opts: { scope: 'core' },
    hooks: {
      save: () => {},
      persist: (snap) => { snaps.push(JSON.parse(JSON.stringify(snap))); project.management.portraitJob = snap; },
    },
  });
  assert.ok(snaps.length >= 1, '启动即落盘：中途进程退出也能看到「跑到第几张」');
  assert.equal(snaps[0].id, job.id);
  assert.equal(snaps[0].projectId, 'prj_job_persist');

  await waitFor(() => {
    const j = getPortraitJob(job.id);
    return j && j.status !== 'running';
  });
  const last = snaps[snaps.length - 1];
  assert.equal(last.status, 'done', '终态必须落盘，刷新页面才能看到「最近一次：完成」');
  assert.ok(last.finishedAt, '终态快照要带完成时间');
  assert.ok(project.management.portraitJob, '快照写进项目 meta，跟着项目一起持久化');
});

test('stalePortraitJob：running 快照识别为「被中断」，已完成张数与图片保留', () => {
  const snap = {
    id: 'pj_stale', projectId: 'prj_stale', status: 'running', ok: false,
    total: 10, done: 4, generated: 4, skipped: 0, sheets: 1,
    failed: [], failedCount: 0, characters: 2, scope: 'core', sheet: true,
    current: { characterId: 'c1', name: '沈砚', view: 'side', label: '侧面' },
    byChar: {
      c1: {
        id: 'c1', name: '沈砚', status: 'running', total: 5,
        views: {
          front: { status: 'done', provider: 'comfyui', url: '/a.png', error: '' },
          side: { status: 'running', provider: '', url: '', error: '' },
        },
      },
      c2: { id: 'c2', name: '林夏', status: 'pending', total: 5, views: {} },
    },
    message: '任务已开始', error: '', startedAt: 1000, finishedAt: null,
  };
  const job = stalePortraitJob(snap);
  assert.equal(job.status, 'interrupted');
  assert.match(job.message, /中断/);
  assert.match(job.message, /4\/10/);
  assert.equal(job.done, 4, '已完成的张数不能归零');
  assert.equal(job.current, null, '中断任务不应留下「正在生成」的项');
  assert.equal(job.byChar.c1.views.side.status, 'pending', '卡住的那张退回待生成，避免永久转圈');
  assert.equal(job.byChar.c1.status, 'partial');
  assert.equal(job.byChar.c1.views.front.url, '/a.png', '已生成的图地址要保留');
  assert.equal(snap.status, 'running', '不得就地改写落盘对象');
});

test('stalePortraitJob：终态快照原样返回；空快照返回 null', () => {
  const done = {
    id: 'pj_done', projectId: 'prj_d', status: 'partial', ok: false, done: 9, total: 10,
    failed: ['林夏 · 侧面'], failedCount: 1, byChar: {}, finishedAt: 2000, current: null,
  };
  const job = stalePortraitJob(done);
  assert.equal(job.status, 'partial');
  assert.equal(job.done, 9);
  assert.deepEqual(job.failed, ['林夏 · 侧面']);
  assert.equal(stalePortraitJob(null), null);
  assert.equal(stalePortraitJob(undefined), null);
});
