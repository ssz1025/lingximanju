/* AI 生成小说 / AI 补全项目信息 / 名称必填 路由与 Mock 生成测试
 * 运行：node --test tests/novel-ai.test.mjs
 * 数据目录先指向临时目录再动态导入（ESM import 提升），避免污染真实 data/
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-novel-ai-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const { handleManagement } = await import('../src/api/routes/management.mjs');
const { handleProjects } = await import('../src/api/routes/projects.mjs');
const { createProviders } = await import('../src/core/providers.mjs');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** 驱动路由：handler 返回 { status, body }（body 传 JSON 对象） */
function run(handler, method, pathname, body) {
  const res = {
    setHeader() {}, statusCode: 0,
    writeHead(s) { this.statusCode = s; },
    end(b) { this.body = b; },
  };
  const req = new EventEmitter();
  req.method = method;
  req.headers = {};
  const p = handler(req, res, { pathname });
  if (body !== undefined) { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); }
  return p.then(() => ({ status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }));
}

const createProject = async (payload) => run(handleProjects, 'POST', '/api/projects', payload);

test('新建创作项目：名称为必填，缺名返回 400 与中文提示', async () => {
  const r = await createProject({ kind: 'novel' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /项目名称不能为空/);
});

test('新建创作项目：只给名称即可创建骨架，六步全待执行；构想写入 logline', async () => {
  const r = await createProject({ kind: 'novel', name: '星夜航线', idea: '迷失航线的飞船收到旧信号' });
  assert.equal(r.status, 201);
  const p = r.body;
  assert.equal(p.name, '星夜航线');
  assert.equal(p.management.kind, 'novel');
  assert.ok(p.management.steps.every((s) => s.status === 'pending'), '骨架项目六步全 pending');
  assert.equal(p.management.bible.logline, '迷失航线的飞船收到旧信号');
  assert.ok(!p.management.source?.text, '骨架项目无原著全文');
});

test('Mock 生成：storyIdea / novelOutline / novelChapter 结构完整且主题可感知', async () => {
  const providers = createProviders({}, () => {});
  const idea = await providers.generate('storyIdea', { idea: '星际飞船迫降沙漠', title: '坐标之外' });
  assert.ok(idea.genre && idea.logline && idea.worldview, 'storyIdea 关键字段齐全');
  assert.match(idea.genre, /科幻/);

  const outline = await providers.generate('novelOutline', { idea: '星际飞船', title: '坐标之外', chapterCount: 3 });
  assert.equal(outline.chapters.length, 3);
  assert.ok(outline.chapters.every((c) => c.title && c.summary), '每章有标题与梗概');
  const big = await providers.generate('novelOutline', { idea: 'x', chapterCount: 99 });
  assert.ok(big.chapters.length <= 8, '章节数有上限');

  const ch = await providers.generate('novelChapter', {
    idea: '星际飞船', chapterTitle: '第一章 · 沙漠坠毁点', summary: '飞船迫降，沙尘中传来求救信号。',
    chapterChars: 600, index: 0, total: 3,
  });
  assert.ok(ch.text.length >= 300, `正文长度达标（${ch.text.length}）`);
  assert.doesNotMatch(ch.text, /本章完/);
});

test('AI 补全项目信息：只补空字段，不覆盖用户已填内容', async () => {
  const { body: p } = await createProject({ kind: 'novel', name: '补全测试' });
  const r1 = await run(handleManagement, 'POST', `/api/projects/${p.id}/bible/ai`, { idea: '雨夜里的侦探收到匿名信' });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.ok, true);
  assert.ok(r1.body.filled >= 5, `首次补全多项（${r1.body.filled}）`);
  assert.equal(r1.body.source, 'mock', '未配置模型时明示 mock 来源');
  assert.ok(r1.body.bible.genre, '类型已补全');

  const r2 = await run(handleManagement, 'POST', `/api/projects/${p.id}/bible/ai`, { idea: '另一个完全不同的构想' });
  assert.equal(r2.body.filled, 0, '已补全的项目不会被 AI 覆盖');

  const r3 = await run(handleManagement, 'POST', `/api/projects/${p.id}/bible/ai`, { idea: '' });
  // 一键生成必须以故事简介为依据：空简介直接拒绝，不再拿项目名 / 原著标题凑数
  assert.equal(r3.status, 400, '故事简介为空时拒绝生成');
  assert.match(r3.body.error, /故事简介/, '错误文案要指明缺的是故事简介');

  // 显式「一键生成」（regenerate）在无真实模型产出时仍然不得覆盖用户内容 / 改项目名
  const r4 = await run(handleManagement, 'POST', `/api/projects/${p.id}/bible/ai`, { idea: '雨夜里的侦探', regenerate: true });
  assert.equal(r4.status, 200);
  assert.equal(r4.body.name, '补全测试', '模板数据不拿来重命名项目');
  assert.equal(r4.body.filled, 0, '模板数据不覆盖已有字段');
});

test('AI 生成小说：大纲 → 整本注入，①② 步自动完成，来源明示 mock', async () => {
  const { body: p } = await createProject({ kind: 'novel', name: '整本生成测试' });
  const o = await run(handleManagement, 'POST', `/api/projects/${p.id}/novel/ai`, {
    mode: 'outline', idea: '雨夜侦探', chapterCount: 3,
  });
  assert.equal(o.status, 200);
  assert.equal(o.body.source, 'mock');
  assert.equal(o.body.outline.chapters.length, 3);

  // 用户编辑过大纲（自定义第一章标题）再生成全文
  const outline = o.body.outline;
  outline.chapters[0].title = '第一章 · 自定义的标题';
  const f = await run(handleManagement, 'POST', `/api/projects/${p.id}/novel/ai`, {
    mode: 'full', idea: '雨夜侦探', outline, chapterChars: 600,
  });
  assert.equal(f.status, 200);
  assert.equal(f.body.ok, true);
  assert.equal(f.body.source, 'mock');
  assert.ok(f.body.novel.totalChars > 900, `整本字数达标（${f.body.novel.totalChars}）`);
  assert.ok(f.body.episodeCount >= 1, '自动完成分集');

  const m = f.body.management;
  const statusOf = (id) => m.steps.find((s) => s.id === id)?.status;
  assert.equal(statusOf('upload'), 'done', '① 上传自动完成');
  assert.equal(statusOf('episodes'), 'done', '② 分集自动完成');
  assert.equal(statusOf('script'), 'pending', '③ 待执行');
  assert.ok(m.source.text.includes('自定义的标题'), '用户编辑的大纲标题进入正文');
  assert.ok(m.characters.length >= 1, '角色候选已播种');
});

test('AI 生成小说：标准项目与非创作项目被拒绝', async () => {
  const { body: p } = await createProject({ template: 'idea2video', name: '标准项目' });
  const r = await run(handleManagement, 'POST', `/api/projects/${p.id}/novel/ai`, { mode: 'outline', idea: 'x' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /创作项目/);
});

test('按小说一键生成：空简介放行，Mock 只补空字段而故事概略照常写入', async () => {
  const { body: p } = await createProject({ kind: 'novel', name: '小说补全测试' });
  const { loadProject, saveProject } = await import('../src/core/store.mjs');
  const proj = loadProject(p.id);
  const text = '第1章 开端。雨夜里的侦探收到匿名信，追查一桩被遗忘的旧案。'.repeat(20)
    + '第2章 尾声。天亮时真相浮出水面。';
  proj.management.source = { title: '雨夜来信', text, chapterCount: 2, totalChars: text.length };
  saveProject(proj);

  // 先按普通简介补全，让 bible 各字段都有值
  const r1 = await run(handleManagement, 'POST', `/api/projects/${p.id}/bible/ai`, { idea: '雨夜里的侦探收到匿名信' });
  assert.ok(r1.body.filled >= 5);
  const before = { ...loadProject(p.id).management.bible };

  const r2 = await run(handleManagement, 'POST', `/api/projects/${p.id}/bible/ai`, { idea: '', fromNovel: true });
  assert.equal(r2.status, 200, '有小说时不再因空简介拒绝');
  assert.ok(String(r2.body.synopsis || '').length > 30, '按原著生成了故事概略');
  const after = loadProject(p.id).management.bible;
  for (const k of ['genre', 'audience', 'logline', 'tone', 'artStyle', 'worldview']) {
    assert.equal(after[k], before[k], `Mock 模板不得覆盖已有 ${k}`);
  }
  assert.equal(after.synopsis, r2.body.synopsis, '新字段 synopsis 仍写入');
});
