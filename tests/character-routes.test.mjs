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
  assert.ok(c.views.side.prompt.includes('正面定妆图'), '侧面应声明以正面定妆图为外观依据');
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
