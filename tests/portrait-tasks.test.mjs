/* ⑤ 角色与上下文 · 生成任务明细折叠 / 一键重试失败任务 · 全链路单元测试
 *
 * 覆盖用户诉求「任务进度可以展开展示所有的生成任务，默认是收缩起来的，
 * 展开后可以一键重试失败的任务」：
 *   1) 后端 viewsByChar 精确重试：只重出指定失败视图，旧图不被误覆盖已成功的图；
 *   2) 后台任务 total / byChar.total 与业务层同一份计划；
 *   3) 路由接受 viewsByChar（同步 / 异步两条路都透传）；
 *   4) 前端默认收起、展开后列出全部任务（含失败原因）、重试按钮与收集口径；
 *   5) 新入口不新增 data-act（63 基线不动）。
 *
 * 运行：node --test tests/portrait-tasks.test.mjs
 * 注意：必须先把数据目录指到临时目录再动态导入，否则会读到本机真实 ComfyUI
 * 配置并真的出图、写进正式资源库（这是上一轮实测踩过的坑）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-portrait-tasks-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
};

const {
  normalizeViewsByChar, portraitPlanFor, ensureCharacterPortraits,
} = await import('../src/core/character-portrait.mjs');
const {
  startPortraitJob, getPortraitJob, _resetPortraitJobs,
} = await import('../src/core/portrait-jobs.mjs');
const { handleManagement } = await import('../src/api/routes/management.mjs');
const { saveProject } = await import('../src/core/store.mjs');
const V = await import('../public/project-view.js');

after(() => { _resetPortraitJobs(); fs.rmSync(TMP, { recursive: true, force: true }); });

const waitFor = async (fn, timeoutMs = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
  return null;
};

/* ------------------------------------------------ 1. 归一化与生成计划 */

test('normalizeViewsByChar：只认已知视图 + sheet，去重、挡非法字段，空表返回 null', () => {
  assert.equal(normalizeViewsByChar(null), null);
  assert.equal(normalizeViewsByChar([]), null);
  assert.equal(normalizeViewsByChar({ c1: ['bogus'] }), null);
  assert.deepEqual(
    normalizeViewsByChar({ c1: ['sheet', 'side', 'side', 'front', 'bogus'], c2: 'not-array', __proto__: ['front'] }),
    { c1: ['front', 'side', 'sheet'] },
    'front 永远排第一（身份基准），sheet 单独成项',
  );
});

test('portraitPlanFor：缺正面自动前置；显式列表只含指定视图且不受 onlyMissing 跳过', () => {
  const noFront = { id: 'c1', views: {} };
  const legacy = portraitPlanFor(noFront, null, { views: ['side'], sheet: false, onlyMissing: true });
  assert.deepEqual(legacy.keys, ['front', 'side'], '老项目只补侧面时先补正面');
  assert.equal(legacy.explicit, false);

  const hasFront = { id: 'c1', views: { front: { url: '/f.png' } } };
  const retry = portraitPlanFor(hasFront, { c1: ['side', 'sheet'] }, {
    views: ['front', 'side'], sheet: true, onlyMissing: true,
  });
  assert.deepEqual(retry, { keys: ['side'], sheet: true, explicit: true });

  const noFrontRetry = portraitPlanFor(noFront, { c1: ['side'] }, { views: ['front', 'side'] });
  assert.deepEqual(noFrontRetry.keys, ['front', 'side'], '显式重试也不破「无正面不出其余视图」');
});

/* ------------------------------------------------ 2. 业务层精确重试 */

test('ensureCharacterPortraits + viewsByChar：只重出失败那张，成功的正面原样保留', async () => {
  const m = {
    bible: {},
    characters: [{
      id: 'c1', name: '林晚', palette: [],
      views: {
        front: { url: '/assets/old-front.png', provider: 'comfyui' },
        side: { url: '/assets/old-side.png', provider: 'comfyui' },
      },
    }],
  };
  const p = { id: 'prj_retry_core', name: 'P', settings: {}, management: m };
  const r = await ensureCharacterPortraits({
    project: p, m, scope: 'core', onlyMissing: true,
    viewsByChar: { c1: ['side'] }, log: () => {},
  });
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
  assert.equal(r.total, 1, '显式计划只算 1 项任务');
  assert.equal(r.generated, 1);
  assert.equal(r.skipped, 0, '显式重试不受 onlyMissing 跳过：失败那张留着旧图也强制重出');
  assert.equal(m.characters[0].views.front.url, '/assets/old-front.png', '正面基准图不被覆盖');
  assert.notEqual(m.characters[0].views.side.url, '/assets/old-side.png', '侧面已重新出图');
});

/* ------------------------------------------------ 3. 后台任务 total */

test('startPortraitJob + viewsByChar：任务总数 / byChar.total 与精确计划一致', async () => {
  _resetPortraitJobs();
  const project = {
    id: 'prj_retry_job', name: '任务重试', settings: {},
    management: {
      bible: {},
      characters: [{
        id: 'c1', name: '林晚', palette: [],
        views: { front: { url: '/assets/front.png', provider: 'comfyui' } },
      }],
    },
  };
  const job = startPortraitJob({
    project, m: project.management,
    opts: { scope: 'all', sheet: true, viewsByChar: { c1: ['side'] } },
    hooks: { save: () => {} },
  });
  assert.equal(job.total, 1, '显式视图表下不是 5 视图 + 定妆板，而是精确 1 张');
  assert.equal(job.byChar.c1.total, 1);
  assert.equal(job.viewsByChar.c1.length, 1, '任务快照带上精确重试清单，刷新后可回溯');
  const final = await waitFor(() => {
    const j = getPortraitJob(job.id);
    return j && j.status !== 'running' ? j : null;
  });
  assert.ok(final, '任务应在超时前结束');
  assert.equal(final.done, final.total, 'done 不能超过 total');
  assert.equal(final.status, 'done');
});

/* ------------------------------------------------ 4. 路由透传 */

/** 驱动 handleManagement：返回 { status, body } */
function run(method, pathname, body) {
  const res = { setHeader() {}, statusCode: 0, writeHead(s) { this.statusCode = s; }, end(b) { this.body = b; } };
  const req = new EventEmitter();
  req.method = method; req.headers = {};
  const p = handleManagement(req, res, { pathname });
  if (body !== undefined) { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); }
  return p.then(() => ({ status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }));
}

test('POST /characters/views/all 接受 viewsByChar：同步路径按精确列表只出 1 张', async () => {
  const id = 'prj_retry_route';
  saveProject({
    id, name: '重试路由', kind: 'novel', createdAt: Date.now(), updatedAt: Date.now(), settings: {},
    management: {
      schema: 1,
      characters: [{
        id: 'c1', name: '林晚', palette: [],
        views: {
          front: { url: '/assets/front.png', provider: 'comfyui' },
          side: { url: '/assets/side.png', provider: 'comfyui' },
        },
      }],
    },
  });
  const { status, body } = await run('POST', `/api/projects/${id}/characters/views/all`, {
    scope: 'core', includeSheet: false, sync: true,
    viewsByChar: { c1: ['side', 'bogus'] },
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.total, 1, '非法 key 被过滤后只剩侧面 1 张');
  assert.equal(body.generated, 1);
});

/* ------------------------------------------------ 5. 前端折叠面板与重试 */

const chars = () => [
  { id: 'c1', name: '林晚', role: '主角', views: { front: { url: '/assets/f.png', provider: 'comfyui' } } },
  { id: 'c2', name: '沈砚', role: '侦探', views: {} },
];
const project = () => ({ id: 'prj_panel', name: '面板', management: { characters: chars() } });

/** 一次完整任务：c1 只有侧面失败；c2 正面失败导致其余视图没跑 */
const failedJob = () => ({
  id: 'pj_panel_failed', projectId: 'prj_panel', status: 'partial', ok: false,
  done: 9, total: 12, sheet: true, failedCount: 2, failed: ['林晚·侧面：超时', '沈砚·正面：超时'],
  byChar: {
    c1: { id: 'c1', name: '林晚', total: 6, views: {
      front: { status: 'done', provider: 'comfyui', url: '/f.png', error: '' },
      threeQuarter: { status: 'done', provider: 'comfyui', url: '/t.png', error: '' },
      side: { status: 'error', provider: '', url: '', error: 'ComfyUI 超时' },
      back: { status: 'skip', provider: '', url: '', error: '' },
      closeup: { status: 'done', provider: 'comfyui', url: '/c.png', error: '' },
      sheet: { status: 'done', provider: 'comfyui', url: '/s.png', error: '' },
    } },
    c2: { id: 'c2', name: '沈砚', total: 6, views: {
      front: { status: 'error', provider: '', url: '', error: 'ComfyUI 队列拒绝' },
    } },
  },
  message: '部分完成', error: '', startedAt: 1000, finishedAt: 2000,
});

test('portraitAreaHTML：默认收起（汇总 + 主行动可见，明细与角色卡在 hidden 区）', () => {
  V.setComfySummary({ imageWorkflow: { id: 'wf' } });
  V.setApiInfo({ capabilities: ['char-portrait-jobs'] });
  V.setPortraitTasksOpen(false);
  const html = V.portraitAreaHTML(project(), project().management);
  assert.match(html, /data-portrait-body hidden/, '默认必须收缩');
  assert.match(html, /角色定妆 · 生成任务/);
  assert.match(html, /data-se="portrait-tasks-toggle"/);
  assert.match(html, /data-act="char-gen-all"/, '收起态仍可直接开工');
  assert.match(html, /aria-expanded="false"/);
  assert.ok(!html.includes('aria-expanded="true"'));
  assert.ok(!html.match(/data-act="portrait-/), '新入口不得占用 data-act 基线');
});

test('portraitAreaHTML：展开后列出全部生成任务与失败原因，失败时出现一键重试', () => {
  const p = project();
  V.applyPortraitJob(failedJob());
  V.setPortraitTasksOpen(true);
  const html = V.portraitAreaHTML(p, p.management);
  assert.ok(!html.includes('data-portrait-body hidden'), '展开后明细区不再隐藏');
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /pvt-tasks/);
  assert.equal((html.match(/pvt-task-row/g) || []).length, 12, '2 位角色 × (5 视图 + 定妆板)');
  assert.match(html, /✗ 失败/);
  assert.match(html, /ComfyUI 超时/, '失败原因要如实显示');
  assert.match(html, /data-se="portrait-retry-failed"/);
  assert.match(html, /重试失败任务/);
  assert.match(html, /失败 2/);
  // 收起 / 展开是模块态：反复局部重绘不会把用户展开的状态丢掉
  assert.match(V.portraitAreaHTML(p, p.management), /pvt-tasks/);
  V.setPortraitTasksOpen(false);
  assert.match(V.portraitAreaHTML(p, p.management), /data-portrait-body hidden/);
});

test('collectFailedViewsForRetry：只重出失败视图 + 被正面失败中断的空洞，不带成功图', () => {
  const job = failedJob();
  const got = V.collectFailedViewsForRetry(job, chars());
  assert.deepEqual(got.c1, ['side'], 'c1 只重试侧面，不覆盖已成功的 4 张 + 定妆板');
  assert.equal(got.c2[0], 'front', 'c2 正面失败排最前');
  assert.ok(got.c2.includes('threeQuarter'), '正面失败导致没跑的视图一并恢复');
  assert.ok(got.c2.includes('sheet'), '原任务含定妆板时把没跑的定妆板补上');
  assert.ok(got.c2.includes('closeup'), '正面失败后没跑的特写也纳入恢复');
  assert.equal(got.c2.length, 6, 'c2 = 5 视图 + 定妆板（整组恢复）');
  // 原任务没有定妆板时不凭空加 sheet
  job.sheet = false;
  const noSheet = V.collectFailedViewsForRetry(job, chars());
  assert.ok(!noSheet.c2.includes('sheet'));
  assert.deepEqual(V.collectFailedViewsForRetry(null, chars()), {}, '没有任务时无可重试项');
});
