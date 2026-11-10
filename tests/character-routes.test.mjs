/* 角色管理路由层单元测试：式(6) 召回接入 / 三视图参考正面图 / 手改保护
 * 运行：node --test tests/character-routes.test.mjs
 * 必须先把数据目录指到临时目录再动态导入（ESM import 会提升），避免污染真实 data/
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-char-routes-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const { handleManagement } = await import('../src/api/routes/management.mjs');
const { saveProject } = await import('../src/core/store.mjs');
const { createManagement } = await import('../src/core/project-steps.mjs');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** 驱动 handleManagement：返回 { status, body } */
function run(method, pathname, body) {
  const res = {
    setHeader() {}, statusCode: 0,
    writeHead(s) { this.statusCode = s; },
    end(b) { this.body = b; },
  };
  const req = new EventEmitter();
  req.method = method;
  req.headers = {};
  const p = handleManagement(req, res, { pathname });
  if (body !== undefined) { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); }
  return p.then(() => ({ status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }));
}

/** 造一个带原著的项目（角色描写只出现在长文中后段） */
function makeProject(id) {
  const filler = '雨下了一整夜，青石街上空无一人。'.repeat(120);
  const project = {
    id,
    name: '路由烟测',
    kind: 'novel',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    settings: { style: 'cinematic' },
    management: createManagement({
      kind: 'novel',
      title: '雨夜来信',
      source: { title: '雨夜来信', text: `${filler}林晚推门而入，鹅蛋脸、剑眉深目，月白广袖长裙。${filler}` },
      episodes: [{ no: 1, title: '第一章', summary: '雨夜来信' }],
    }),
  };
  saveProject(project);
  return project;
}

test('POST /characters/extract → 召回原著片段并写回角色（带 staticFeatures / dynamicFeatures）', async () => {
  const id = 'prj_char_extract';
  makeProject(id);
  const { status, body } = await run('POST', `/api/projects/${id}/characters/extract`, {});
  assert.equal(status, 200);
  assert.ok(body.ok);
  assert.equal(body.fellBack, false, 'Mock 模式不算回退');
  assert.ok(body.characters.length > 0, '应提取到角色');
  const c = body.characters[0];
  assert.ok(c.name, '角色应有名字');
  assert.ok(c.staticFeatures, '应有固定特征');
  assert.ok(c.dynamicFeatures, '应有可变特征');
  assert.ok(c.source === 'llm' || c.source === 'heuristic');
});

test('POST /characters/extract 无原著 → 400', async () => {
  const id = 'prj_char_empty';
  const project = makeProject(id);
  project.management.source = { title: 'x', text: '' };
  saveProject(project);
  const { status } = await run('POST', `/api/projects/${id}/characters/extract`, {});
  assert.equal(status, 400);
});

test('POST /characters/views → 三视图依次生成，侧面/背面提示词以正面定妆图为依据', async () => {
  const id = 'prj_char_views';
  makeProject(id);
  const ex = await run('POST', `/api/projects/${id}/characters/extract`, {});
  const cid = ex.body.characters[0].id;

  const front = await run('POST', `/api/projects/${id}/characters/views`, { characterId: cid, view: 'front' });
  assert.equal(front.status, 200);
  assert.ok(front.body.url, '正面应产出图片');

  const side = await run('POST', `/api/projects/${id}/characters/views`, { characterId: cid, view: 'side' });
  assert.equal(side.status, 200);
  const back = await run('POST', `/api/projects/${id}/characters/views`, { characterId: cid, view: 'back' });
  assert.equal(back.status, 200);

  const m = await run('GET', `/api/projects/${id}/manage`);
  const c = m.body.management.characters.find((x) => x.id === cid);
  assert.ok(c.views.front?.url);
  assert.ok(c.views.side?.url);
  assert.ok(c.views.back?.url);
  assert.ok(c.views.front.prompt.includes('正面'), '正面提示词应声明朝向');
  assert.ok(c.views.side.prompt.includes('参考图（正面）'), '侧面应声明以正面图为唯一外观依据');
  assert.ok(c.views.back.prompt.includes('背面不可见五官'));
  assert.ok(!c.views.side.prompt.includes('固定特征'), '侧面不重复特征描述，避免与正面图漂移');
});

test('POST /characters/views 角色不存在 → 404', async () => {
  const id = 'prj_char_404';
  makeProject(id);
  const { status } = await run('POST', `/api/projects/${id}/characters/views`, { characterId: 'nope', view: 'front' });
  assert.equal(status, 404);
});

test('POST /characters/views 非法视图 → 502（生成失败）', async () => {
  const id = 'prj_char_badview';
  makeProject(id);
  const ex = await run('POST', `/api/projects/${id}/characters/extract`, {});
  const cid = ex.body.characters[0].id;
  const { status } = await run('POST', `/api/projects/${id}/characters/views`, { characterId: cid, view: 'left' });
  assert.equal(status, 502);
});

test('POST /characters/views/all 默认异步：立即返回 jobId，任务进度可查询', async () => {
  const id = 'prj_char_job';
  makeProject(id);
  // 先有一个角色（Mock 提取即可）
  const ex = await run('POST', `/api/projects/${id}/characters/extract`, { mode: 'heuristic' });
  assert.equal(ex.status, 200);
  assert.ok(ex.body.characters.length > 0);
  const { status, body } = await run('POST', `/api/projects/${id}/characters/views/all`, {
    scope: 'core', includeSheet: false,
  });
  assert.equal(status, 202, '长批量必须异步返回，不能挂住请求');
  assert.ok(body.async);
  assert.ok(body.jobId);
  // 轮询到结束（Mock 出图很快）
  let job = null;
  for (let i = 0; i < 60; i += 1) {
    const r = await run('GET', `/api/projects/${id}/characters/jobs/${body.jobId}`);
    if (r.status === 200 && r.body.job) {
      job = r.body.job;
      if (job.status !== 'running') break;
    }
    await new Promise((res) => setTimeout(res, 80));
  }
  assert.ok(job, '任务必须可以查询到');
  assert.notEqual(job.status, 'running', '任务应在超时前结束');
  assert.ok(job.total > 0);
  assert.equal(job.done, job.total);
  // 项目级任务查询同样可恢复页面状态
  const list = await run('GET', `/api/projects/${id}/characters/jobs`);
  assert.equal(list.status, 200);
  assert.equal(list.body.job.id, body.jobId);
});

/* ---------------- 角色定妆任务：内存任务表丢失后回落到项目里落盘的快照 ----------------
 * 第⑤步「角色与上下文」的任务进度条依赖 GET /characters/jobs；
 * 服务重启后内存任务表为空，必须从项目 meta 的 portraitJob 恢复，
 * 否则页面就是「任务进度和任务状态都没有」。
 */
function jobSnapshot(id, status) {
  return {
    id, projectId: 'prj_job_fallback', status, ok: status === 'done',
    total: 10, done: status === 'done' ? 10 : 4, generated: 4, skipped: 0, sheets: 1,
    failed: [], failedCount: 0, characters: 2, scope: 'core', sheet: true,
    current: status === 'running' ? { characterId: 'c1', name: '林晚', view: 'side', label: '侧面' } : null,
    byChar: {
      c1: {
        id: 'c1', name: '林晚', status: status === 'running' ? 'running' : 'done', total: 5,
        views: { front: { status: 'done', provider: 'comfyui', url: '/assets/f.png', error: '' },
          side: { status: status === 'running' ? 'running' : 'done', provider: '', url: '', error: '' } },
      },
    },
    message: status === 'done' ? '全部完成' : '任务已开始', error: '',
    startedAt: 1000, finishedAt: status === 'done' ? 2000 : null,
  };
}

function makeProjectWithJob(id, status) {
  const project = makeProject(id);
  project.management.portraitJob = jobSnapshot(`pj_${id}`, status);
  saveProject(project);
  return project;
}

test('GET /characters/jobs：内存里没有任务时回落落盘快照，running 识别为中断', async () => {
  const id = 'prj_job_fallback';
  makeProjectWithJob(id, 'running');
  const { status, body } = await run('GET', `/api/projects/${id}/characters/jobs`);
  assert.equal(status, 200);
  assert.equal(body.persisted, true, '来源标记为落盘快照');
  assert.equal(body.job.status, 'interrupted', '重启后不能永远显示 running');
  assert.match(body.job.message, /4\/10/, '已完成张数要保留，用户才知道跑到哪了');
  assert.equal(body.job.byChar.c1.views.side.status, 'pending');
});

test('GET /characters/jobs/:jobId：按 id 也能取回落盘快照；不匹配的 id 仍是 404', async () => {
  const id = 'prj_job_fallback';
  const { status, body } = await run('GET', `/api/projects/${id}/characters/jobs/pj_${id}`);
  assert.equal(status, 200);
  assert.equal(body.job.id, `pj_${id}`);
  const miss = await run('GET', `/api/projects/${id}/characters/jobs/pj_other`);
  assert.equal(miss.status, 404);
});

test('GET /characters/jobs：终态快照原样返回（完成的任务不会被改写成中断）', async () => {
  const id2 = 'prj_job_done_snap';
  makeProjectWithJob(id2, 'done');
  const { status, body } = await run('GET', `/api/projects/${id2}/characters/jobs`);
  assert.equal(status, 200);
  assert.equal(body.job.status, 'done');
  assert.equal(body.job.done, 10);
});
