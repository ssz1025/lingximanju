/* 工作台「① 设置基础信息」布局重排 + AI 一键生成必填故事简介 —— 回归测试
 * 运行：node --test tests/basic-info.test.mjs
 *
 * 锁定四件事：
 *   1. 「AI 生成封面 / 上传换封面」在项目封面正下方，不再挤在保存按钮行；
 *   2. 「✦ AI 一键生成」与「保存项目信息」在同一按钮行；
 *   3. 「项目默认模型 / 多媒体模型」独立一整行，各有一处下拉插槽；
 *   4. 故事简介必填（前端拦空 + 后端 400），且与第②步 AI 写小说构想独立存档。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viewSrc = fs.readFileSync(path.join(ROOT, 'public/project-view.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const mgmtSrc = fs.readFileSync(path.join(ROOT, 'src/api/routes/management.mjs'), 'utf8');

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { infoCardHTML } = await import('../public/project-view.js');

const project = {
  id: 'prj_basic', name: '雨夜来信',
  settings: { style: 'cinematic', aspect: '16:9' },
  management: {
    kind: 'novel', createdAt: Date.now(),
    bible: { title: '雨夜来信', logline: '一封匿名信揭开旧案', genre: '悬疑' },
    deliverables: { video: true, pack: true },
  },
};
const html = infoCardHTML(project, project.management);

/** 取两个标记之间的片段，用于断言「按钮到底在哪一块里」 */
const slice = (from, to) => {
  const i = html.indexOf(from);
  assert.ok(i >= 0, `渲染结果找不到 ${from}`);
  const j = html.indexOf(to, i);
  return j < 0 ? html.slice(i) : html.slice(i, j);
};

test('封面按钮在项目封面正下方，不再挤在保存行', () => {
  const col = slice('<div class="pv-cover-col">', '<div class="pv-hero-main">');
  assert.match(col, /class="pv-cover"/, '封面缩略图仍在左列');
  assert.match(col, /class="pv-cover-acts"/, '封面下方有独立操作区');
  assert.match(col, /data-act="ai-cover"/, 'AI 生成封面在封面下面');
  assert.match(col, /data-act="cover"/, '上传 / 换封面在封面下面');
  const acts = slice('<div class="pv-hero-acts">', '</div>');
  assert.doesNotMatch(acts, /data-act="ai-cover"|data-act="cover"/, '保存行不再混入封面操作');
});

test('AI 一键生成与保存项目信息在同一按钮行', () => {
  const acts = slice('<div class="pv-hero-acts">', '</div>');
  assert.match(acts, /data-act="save-info"/);
  assert.match(acts, /data-act="ai-fill"/);
  const syn = slice('<div class="pv-synopsis">', '<div class="pv-info-grid">');
  assert.doesNotMatch(syn, /data-act="ai-fill"/, '故事简介区不再自带一键生成按钮');
});

test('项目默认模型 / 多媒体模型独立一行，各有一处选择插槽', () => {
  const row = slice('<div class="pv-model-row">', '<div class="pv-hero-acts">');
  assert.match(row, /项目默认模型/);
  assert.match(row, /多媒体模型/);
  assert.match(row, /id="pv-model-text"/);
  assert.match(row, /id="pv-model-media"/);
  assert.match(css, /\.pv-model-row\s*\{[^}]*grid-template-columns:\s*1fr 1fr/, '两列并排占独立一行');
  assert.match(css, /\.pv-model-slot\s*\{/, '下拉有专门插槽容器');
  // 三个下拉的宿主改为这一行，entry key 不变 → 记忆与请求透传语义不变；
  // 各占固定子槽，避免两个异步下拉共用容器导致顺序漂移、标签混淆
  for (const id of ['pv-text-model', 'pv-media-iface', 'pv-media-prompt']) {
    assert.match(row, new RegExp(`id="${id}"`), `${id} 固定子槽不能丢`);
  }
  assert.match(row, /data-cap="出图接口"/);
  assert.match(row, /data-cap="提示词模型"/);
  assert.match(css, /\.pv-model-box::before/, '每个子槽要有说明标签');
  assert.match(viewSrc, /ensureModelPicker\('bible', textBox\)/);
  assert.match(viewSrc, /ensureModelPicker\('cover', promptBox\)/);
  assert.match(viewSrc, /ensureInterfacePicker\('cover', ifaceBox\)/);
});

test('故事简介：无小说必填，有小说由 AI 读原著生成概略并回填', () => {
  const syn = slice('<div class="pv-synopsis">', '<div class="pv-info-grid">');
  assert.match(syn, /故事简介/);
  assert.match(syn, /必填/, '无小说的 fixture 仍标必填');
  assert.match(syn, /id="pv-bi-idea"/);
  assert.match(syn, /<textarea/, '故事简介是多行输入');
  assert.match(viewSrc, /if \(!fromNovel && !idea\) \{[\s\S]{0,160}请先填写故事简介/, '无小说时仍拦空');
  assert.match(viewSrc, /fromNovel, regenerate: true/, '有小说时请求带 fromNovel');
  assert.match(viewSrc, /d\.synopsis \|\| idea/, '用响应里的故事概略回填');
  assert.match(viewSrc, /b\.synopsis \|\| b\.logline/, '概略持久化后刷新仍显示');
  assert.match(mgmtSrc, /if \(!fromNovel && !idea\)/, '后端无小说空简介仍 400');
  assert.match(mgmtSrc, /let idea = String\(body\.idea \|\| ''\)/);
  assert.match(mgmtSrc, /patch\.synopsis = synopsis/, '概略写回 bible');
  // 只禁止「一键生成」这条链回退；/novel/ai（AI 写小说）仍可用 logline / 项目名兜底，不在此列
  assert.doesNotMatch(mgmtSrc, /body\.idea \|\| m\.bible\?\.logline \|\| m\.source\?\.title/, '一键生成不得再回退原著标题 / 项目名');
  assert.match(mgmtSrc, /\['title', 'genre', 'audience', 'logline', 'tone', 'artStyle'/, '按概略自动填写基础信息字段');
});

test('故事简介独立存档，不与第②步 AI 写小说构想互相覆盖', () => {
  assert.match(viewSrc, /synopsis: null/);
  assert.match(viewSrc, /if \(q\('#pv-bi-idea'\)\) ui\.synopsis = q\('#pv-bi-idea'\)\.value;/);
  assert.doesNotMatch(viewSrc, /id="pv-bi-idea"[^\n]*ui\.ai\.idea/, '简介框不再复用 ui.ai.idea');
});

test('渲染无脏值，基础信息字段仍可编辑', () => {
  assert.ok(!/undefined|NaN/.test(html), '渲染结果不应出现脏值');
  for (const f of ['logline', 'genre', 'audience', 'tone', 'artStyle']) {
    assert.match(html, new RegExp(`data-bi="${f}"`), `${f} 不能丢`);
  }
  assert.match(html, /data-set="style"/);
  assert.match(html, /data-set="aspect"/);
  assert.match(html, /id="pv-name"/);
});

test('① 一键生成：无故事弹窗引导 ②，有小说则读原著生成概略', () => {
  const start = viewSrc.indexOf('q(\'[data-act="ai-fill"]\')?.addEventListener');
  const end = viewSrc.indexOf('q(\'[data-act="ai-cover"]\')?.addEventListener');
  const bind = start >= 0 && end > start ? viewSrc.slice(start, end) : '';
  assert.ok(bind, '找不到 AI 一键生成的事件绑定');
  assert.match(bind, /novelText\s*=\s*String\(m\.source\?\.text/, '先判断项目有没有小说');
  assert.match(bind, /openNoStoryDialog\(/, '无故事走弹窗而不是直接请求');
  assert.ok(bind.indexOf('openNoStoryDialog(') < bind.indexOf('if (!fromNovel && !idea)'), '无故事拦截必须早于简介校验');
  assert.match(bind, /gotoStep\('upload', \{ rerender: true \}\)/, '弹窗主按钮跳到 ②');
  assert.match(bind, /ui\.storySource = 'upload'/, '跳转后默认选中「上传小说」');
  assert.match(bind, /请先填写故事简介/, '小说过短时仍保留必填兜底');
  assert.match(bind, /const fromNovel = novelText\.length >= 40/, '有小说才走读小说模式');
  const dlg = viewSrc.slice(viewSrc.indexOf('function openNoStoryDialog'), viewSrc.indexOf('export function infoCardHTML'));
  assert.match(dlg, /还没有生成故事/);
  assert.match(dlg, /去第 ② 步 · 上传小说/);
  assert.match(dlg, /推荐用 <b>⇧ 上传小说<\/b>/);
  assert.match(dlg, /data-ns="go"/, '弹窗按钮用 data-ns，不新增 data-act');
  assert.doesNotMatch(dlg, /data-act=/, '弹窗不能改动 63 个功能入口基线');
});
