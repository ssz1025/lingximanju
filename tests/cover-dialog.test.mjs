/* 封面生成「放大预览 → 确认才保存」流程的行为级单元测试（无 DOM 依赖，手写桩）
 * 背景：ComfyUI 出图后不再直接落封面，先弹大图确认弹窗；确认才 POST /cover {asset} 保存，
 * 放弃则图片留在资源库。openGeneratedConfirm 已重构为模块级导出（依赖显式注入）。
 * 运行：node --test tests/cover-dialog.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/* ---- 手写轻量 DOM 桩：可记录 innerHTML / removed，按 selector 缓存子桩以便触发点击 ---- */

function makeEl() {
  const store = { listeners: {}, style: {}, dataset: {}, innerHTML: '', value: '', removed: false, children: [] };
  const el = new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      switch (k) {
        case 'addEventListener': return (ev, fn) => { (t.listeners[ev] ||= []).push(fn); };
        case 'querySelector': return (sel) => { t.q ||= new Map(); if (!t.q.has(sel)) t.q.set(sel, makeEl()); return t.q.get(sel); };
        case 'querySelectorAll': return (sel) => { t.ql ||= new Map(); if (!t.ql.has(sel)) t.ql.set(sel, [makeEl()]); return t.ql.get(sel); };
        case 'getElementById': return () => makeEl();
        case 'remove': return () => { t.removed = true; };
        case 'focus': case 'select': case 'click': case 'append': case 'appendChild':
          return (c) => c;
        case 'closest': return () => null;
        case 'classList': return { add() {}, remove() {}, toggle() {}, contains: () => false };
        case 'setAttribute': case 'removeAttribute': case 'toggleAttribute': return () => {};
        default: return undefined;
      }
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return el;
}

/** 触发子桩上注册的全部 click（handler 里会读 e.currentTarget） */
function click(el) {
  const fns = el.listeners.click || [];
  assert.ok(fns.length, '目标元素应已注册 click 处理器');
  return Promise.allSettled(fns.map((fn) => fn({ currentTarget: el })));
}

/* ---- 环境桩与模块导入（必须先于动态 import 设好全局） ---- */

let openGeneratedConfirm;
before(() => {
  const cachedEls = new Map();
  globalThis.document = {
    createElement: () => makeEl(),
    getElementById: (id) => { if (!cachedEls.has(id)) cachedEls.set(id, makeEl()); return cachedEls.get(id); },
    body: makeEl(),
    execCommand: () => true,
  };
  globalThis.window = globalThis;
  try { globalThis.navigator.clipboard.writeText = async () => {}; } catch { /* 只读 getter 时不强求 */ }
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

  const mod = fs.realpathSync(path.join(import.meta.dirname, '../public/project-manager.js'));
  return import(mod).then((m) => { openGeneratedConfirm = m.openGeneratedConfirm; });
});

/* ---- fetch 桩：记录请求并返回固定响应 ---- */

const fetchCalls = [];
before(() => {
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, method: opts?.method || 'GET', body: opts?.body ? JSON.parse(opts.body) : null });
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, cover: { url: `/assets/${fetchCalls.at(-1).body.asset}`, source: 'upload', updatedAt: 1 }, message: '已保存' }),
    };
  };
});

const flush = () => new Promise((r) => setTimeout(r, 0));

/* ---- 用例 ---- */

test('缺少 file/url 的生成结果不弹确认窗（返回 null）', () => {
  assert.equal(openGeneratedConfirm({ project: { id: 'p1' }, generated: null }), null);
  assert.equal(openGeneratedConfirm({ project: { id: 'p1' }, generated: { file: 'a.png' } }), null);
  assert.equal(openGeneratedConfirm({ project: { id: 'p1' }, generated: { url: '/assets/a.png' } }), null);
});

test('打开确认弹窗：大图放大展示 + 保存/放弃按钮，不自动发保存请求', () => {
  fetchCalls.length = 0;
  const r = openGeneratedConfirm({
    project: { id: 'p1' }, generated: { file: 'gen_1.png', url: '/assets/gen_1.png' },
  });
  assert.ok(r, '应返回 { wrap, generated }');
  assert.equal(r.generated.file, 'gen_1.png');
  assert.match(r.wrap.innerHTML, /封面确认/);
  assert.match(r.wrap.innerHTML, /cover-confirm-img/);
  assert.match(r.wrap.innerHTML, /保存为封面/);
  assert.match(r.wrap.innerHTML, /放弃/);
  assert.equal(fetchCalls.length, 0, '打开弹窗本身不应触发任何请求');
});

test('点击「保存为封面」：POST /cover {asset} 保存并应用，弹窗关闭', async () => {
  fetchCalls.length = 0;
  const applied = [];
  const messages = [];
  let changed = 0;
  const r = openGeneratedConfirm({
    project: { id: 'p1' },
    generated: { file: 'gen_2.png', url: '/assets/gen_2.png' },
    applyCover: (c) => applied.push(c),
    onChanged: async () => { changed += 1; },
    ui: { addMessage: (m) => messages.push(m) },
  });
  await click(r.wrap.querySelector('[data-save]'));
  await flush();
  assert.equal(fetchCalls.length, 1, '应恰好发出一次保存请求');
  assert.equal(fetchCalls[0].method, 'POST');
  assert.equal(fetchCalls[0].url, '/api/projects/p1/cover');
  assert.deepEqual(fetchCalls[0].body, { asset: 'gen_2.png' }, '以资源文件名走 cover {asset} 通道');
  assert.deepEqual(applied, [{ url: '/assets/gen_2.png', source: 'upload', updatedAt: 1 }], '后端封面写回 applyCover');
  assert.equal(changed, 1, 'onChanged 已通知列表刷新');
  assert.ok(messages.some((m) => String(m.text).includes('已保存为项目封面')), '对话里追加保存成功消息');
  assert.equal(r.wrap.removed, true, '保存成功后弹窗关闭');
});

test('点击「放弃」：不发任何请求，弹窗关闭并提示图片留在资源库', async () => {
  fetchCalls.length = 0;
  const applied = [];
  const messages = [];
  const r = openGeneratedConfirm({
    project: { id: 'p1' },
    generated: { file: 'gen_3.png', url: '/assets/gen_3.png' },
    applyCover: (c) => applied.push(c),
    ui: { addMessage: (m) => messages.push(m) },
  });
  await click(r.wrap.querySelector('[data-skip]'));
  await flush();
  assert.equal(fetchCalls.length, 0, '放弃不应触发保存请求');
  assert.equal(applied.length, 0, '放弃不改封面');
  assert.ok(messages.some((m) => String(m.text).includes('已放弃本次封面')), '提示图片已存入资源库');
  assert.equal(r.wrap.removed, true, '弹窗关闭');
});

test('保存请求失败：弹窗保留、按钮恢复可点，不误报成功', async () => {
  fetchCalls.length = 0;
  const toasts = [];
  globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: '资源不存在或已被删除' }) });
  const r = openGeneratedConfirm({
    project: { id: 'p1' },
    generated: { file: 'gen_gone.png', url: '/assets/gen_gone.png' },
    ui: { addMessage: () => {} },
    toast: (msg, kind) => toasts.push({ msg, kind }),
  });
  await click(r.wrap.querySelector('[data-save]'));
  await flush();
  assert.equal(r.wrap.removed, false, '失败不关弹窗');
  assert.ok(toasts.some((t) => t.kind === 'err' && t.msg.includes('资源不存在')), '以 toast 报错');
  assert.equal(r.wrap.querySelector('[data-save]').disabled, false, '按钮恢复可点以便重试');
});
