/* ① 已上传小说时「AI 一键生成」读原著出故事概略 → 配置全部项目信息 —— 回归测试
 * 运行：node --test tests/story-synopsis.test.mjs
 *
 * 锁定四件事：
 *   1. 长篇原著采样 ≤4000 字且覆盖书名 / 章节 / 开头 / 中段 / 结尾；
 *   2. 新增 storySynopsis 生成能力，Mock 也只从原著节选取句、不编主题模板；
 *   3. /bible/ai 的 fromNovel 分支：空简介放行、概略写回 bible.synopsis 并持久化；
 *      无小说时仍强制故事简介必填；只有真实模型才整组重写；
 *   4. 前端有小说时简介可留空、用响应概略回填并拿来生成封面。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const viewSrc = read('public/project-view.js');
const css = read('public/styles.css');
const provSrc = read('src/core/providers.mjs');
const mgmtSrc = read('src/api/routes/management.mjs');
const stepsSrc = read('src/core/project-steps.mjs');

// 数据目录指向临时目录（须在动态 import 之前），避免污染真实 data/
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-synopsis-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;
const { handleManagement, buildNovelExcerpt } = await import('../src/api/routes/management.mjs');
const { handleProjects } = await import('../src/api/routes/projects.mjs');
const { createProviders } = await import('../src/core/providers.mjs');
const { loadProject, saveProject } = await import('../src/core/store.mjs');
const { defaultBible } = await import('../src/core/project-steps.mjs');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function run(handler, method, pathname, body) {
  const res = { setHeader() {}, statusCode: 0, writeHead(s) { this.statusCode = s; }, end(b) { this.body = b; } };
  const req = new EventEmitter();
  req.method = method;
  req.headers = {};
  const p = handler(req, res, { pathname });
  if (body !== undefined) { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); }
  return p.then(() => ({ status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }));
}
const createProject = (payload) => run(handleProjects, 'POST', '/api/projects', payload);

const longNovel = () => '第1章 开端\n'
  + '退役刑警在雨夜收到一封来自十年前的信，落款是自己的名字。他沿着旧城区追查，线索一桩桩指向那起被遗忘的旧案。'.repeat(400)
  + '\n第2章 尾声\n天亮时真相浮出水面，写信的人原来一直住在隔壁。';

test('原著采样：长篇控制在 4000 字内，覆盖书名 / 章节 / 开头 / 中段 / 结尾', () => {
  const text = longNovel();
  assert.ok(text.length > 10000, '构造的是长篇原著');
  const ex = buildNovelExcerpt({ source: { title: '雨夜来信', text } });
  assert.ok(ex.length <= 4000, `节选 ${ex.length} 字，不得撑爆上下文`);
  assert.match(ex, /书名：雨夜来信/);
  assert.match(ex, /章节标题（节选）/);
  assert.match(ex, /【原著开头】/);
  assert.match(ex, /【原著中段采样】/);
  assert.match(ex, /【原著结尾】/);
  assert.match(ex, /真相浮出水面/, '结尾必须被采到');
  assert.equal(buildNovelExcerpt({}), '');
  assert.equal(buildNovelExcerpt({ source: { text: '短篇' } }).includes('书名：'), true, '短篇也不报错');
});

test('Mock 故事概略：只从原著节选取句，不编造主题模板', async () => {
  const providers = createProviders({}, () => {});
  assert.equal(providers.mode, 'mock');
  const out = await providers.generate('storySynopsis', {
    novelExcerpt: '第1章 开端。退役刑警在雨夜收到一封来自十年前的信。'
      + '他沿着旧城区追查，线索一桩桩指向那起被遗忘的旧案。'.repeat(10)
      + '第2章 尾声。天亮时真相浮出水面。',
    title: '雨夜来信',
  });
  const syn = String(out.synopsis || '');
  assert.ok(syn.length > 20, '概略不能为空');
  assert.ok(syn.length <= 300, '概略不超过 300 字');
  assert.match(syn, /雨夜收到|真相浮出水面|旧案/, '内容来自原著节选');
  assert.doesNotMatch(syn, /沈砚|顾言|星际飞船/, '不能混入主题模板的人名与题材');
});

test('生成链路与持久化：schema / mock case / 后端分支 / bible 白名单', () => {
  assert.match(provSrc, /storySynopsis:\s*'故事概略/);
  assert.match(provSrc, /case 'storySynopsis'/);
  assert.match(mgmtSrc, /export function buildNovelExcerpt/);
  assert.match(mgmtSrc, /fromNovel = body\.fromNovel === true && novelText\.length >= 40/);
  assert.match(mgmtSrc, /generate\('storySynopsis'/);
  assert.match(mgmtSrc, /idea = synopsis;/, '概略作为项目信息的创作依据');
  assert.match(mgmtSrc, /\(body\.regenerate === true \|\| fromNovel\) && providers\.mode === 'openai'/, '真实模型才整组重写');
  assert.match(mgmtSrc, /patch\.synopsis = synopsis/);
  assert.match(mgmtSrc, /synopsis,/, '响应带概略');
  assert.match(stepsSrc, /synopsis: String\(opts\.synopsis/);
  assert.match(stepsSrc, /b\.synopsis = s\('synopsis', 2000\)/);
  assert.equal(defaultBible().synopsis, '');
});

test('已上传小说：空简介也能按小说生成故事概略，并写入 bible 持久化', async () => {
  const { body: p } = await createProject({ kind: 'novel', name: '读小说测试' });
  const proj = loadProject(p.id);
  const text = longNovel();
  proj.management.source = { title: '雨夜来信', text, chapterCount: 2, totalChars: text.length };
  saveProject(proj);

  const r = await run(handleManagement, 'POST', `/api/projects/${p.id}/bible/ai`, { idea: '', fromNovel: true });
  assert.equal(r.status, 200, '有小说时不再因简介为空返回 400');
  assert.equal(r.body.ok, true);
  const syn = String(r.body.synopsis || '');
  assert.ok(syn.length > 30, `返回故事概略（${syn.length} 字）`);
  assert.equal(r.body.bible.synopsis, syn, '概略写入 bible');
  assert.ok(r.body.filled >= 1, '至少写入概略这一项');
  assert.match(r.body.message, /已读小说生成故事概略/);
  assert.equal(loadProject(p.id).management.bible.synopsis, syn, '重开项目仍在，刷新不丢');
});

test('无小说时仍强制故事简介：普通请求与伪 fromNovel 都返回 400', async () => {
  const { body: p } = await createProject({ kind: 'novel', name: '空简介测试' });
  const r1 = await run(handleManagement, 'POST', `/api/projects/${p.id}/bible/ai`, { idea: '' });
  assert.equal(r1.status, 400);
  assert.match(r1.body.error, /故事简介/);
  const r2 = await run(handleManagement, 'POST', `/api/projects/${p.id}/bible/ai`, { idea: '', fromNovel: true });
  assert.equal(r2.status, 400, '没有原著时 fromNovel 不成立');
});

test('前端：有小说时简介可留空、概略回填、封面用概略', () => {
  assert.match(viewSrc, /const hasNovel = !!String\(m\.source\?\.text/);
  assert.match(viewSrc, /hasNovel \? '可留空 · AI 读小说生成' : '必填'/);
  assert.match(css, /\.pv-req\.optional/);
  assert.match(viewSrc, /b\.synopsis \|\| b\.logline/, '刷新后优先显示持久化的概略');
  assert.match(viewSrc, /const gist = String\(d\.synopsis \|\| idea/);
  assert.match(viewSrc, /ui\.synopsis = gist \|\| null/);
  assert.match(viewSrc, /generateCover\(gist \|\| idea\)/);
});
