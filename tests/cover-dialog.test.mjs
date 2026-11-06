/* 封面弹窗「AI 生成提示词」busy 状态隔离的行为级单元测试（无 DOM 依赖，手写桩）
 * 背景修复：提示词生成是 LLM 秒级调用，曾误用出图 busy 状态导致左侧图片区
 * 显示「ComfyUI 正在生成封面 / 约 1–2 分钟」遮罩。现拆分为独立 promptBusy。
 * 运行：node --test tests/cover-dialog.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/* ---- 手写轻量 DOM 桩：足够让 openCoverDialog 跑通渲染与事件绑定 ---- */

/** 可记录 innerHTML、按 selector 缓存子桩（以便取出注册的点击处理器）的元素桩 */
function makeEl() {
  const store = { listeners: {}, style: {}, dataset: {}, innerHTML: '', value: '', children: [] };
  const el = new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      switch (k) {
        case 'addEventListener': return (ev, fn) => { (t.listeners[ev] ||= []).push(fn); };
        case 'querySelector': return (sel) => { t.q ||= new Map(); if (!t.q.has(sel)) t.q.set(sel, makeEl()); return t.q.get(sel); };
        case 'querySelectorAll': return () => [];
        case 'getElementById': return () => makeEl();
        case 'remove': case 'focus': case 'select': case 'click': case 'append': case 'appendChild':
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

/** 打开弹窗后从 backdrop 桩里取某 selector 最近一次注册的 click 处理器 */
function lastClickHandler(backdrop, selector) {
  const sub = backdrop.querySelector(selector);
  const fns = sub.listeners.click || [];
  assert.ok(fns.length, `应已注册 ${selector} 的 click 处理器`);
  return fns[fns.length - 1]; // 每次渲染重新绑定，最后注册的才是当前闭包
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/* ---- 环境桩与模块导入（必须先于动态 import 设好全局） ---- */

let backdrop;
const created = [];
before(() => {
  const cachedEls = new Map();
  globalThis.document = {
    createElement: () => { const e = makeEl(); created.push(e); return e; },
    getElementById: (id) => { if (!cachedEls.has(id)) cachedEls.set(id, makeEl()); return cachedEls.get(id); },
    body: makeEl(),
    execCommand: () => true,
  };
  globalThis.window = globalThis;
  try { globalThis.navigator.clipboard.writeText = async () => {}; } catch { /* 只读 getter 时不强求 */ }
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

  const mod = fs.realpathSync(path.join(import.meta.dirname, '../public/project-manager.js'));
  return import(mod).then((m) => {
    m.openCoverDialog({
      project: { id: 'prj_test', name: '测试项目', cover: { source: 'name' }, management: {} },
      toast: () => {},
      comfy: { imageWorkflow: true },
      onChanged: async () => {},
    });
    // openCoverDialog 返回 { close }；从创建过的元素里按弹窗特征找 backdrop 桩
    backdrop = created.find((e) => String(e.innerHTML).includes('cover-modal'));
    assert.ok(backdrop, '封面弹窗 backdrop 已渲染');
  });
});

/* ---- fetch 桩：用可手动续接的 deferred 观察「生成中」的中间态渲染 ---- */

let resolveFetch;
let fetchCalls = 0;
before(() => {
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Promise((res) => { resolveFetch = res; });
  };
});

const reply = (body) => ({ ok: true, status: 200, json: async () => body });

test('AI 生成提示词进行中：按钮显示生成中，左侧不出现 ComfyUI 1–2 分钟遮罩', async () => {
  const handler = lastClickHandler(backdrop, '[data-act="ai-prompt"]');
  const p = handler(); // 触发点击（异步）
  await flush();       // 让 promptBusy=true 后的 render 跑完

  const html = backdrop.innerHTML;
  assert.match(html, /提示词生成中/, '按钮上反馈生成中状态');
  assert.ok(!html.includes('cover-busy'), '不得出现左侧图片区遮罩');
  assert.ok(!html.includes('1–2 分钟'), '不得出现 1–2 分钟文案（那是出图耗时提示）');

  // 续接 fetch，等待收尾
  resolveFetch(reply({ prompt: '生成的提示词内容', negative: '负向', message: '提示词已生成', fellBack: false }));
  await p; await flush();
  assert.match(backdrop.innerHTML, /✦ AI 生成提示词/, '完成后按钮恢复');
  assert.ok(!backdrop.innerHTML.includes('cover-busy'), '完成后仍无遮罩');
});

test('ComfyUI 生成封面进行中：左侧遮罩与 1–2 分钟提示保留（行为不回退）', async () => {
  const handler = lastClickHandler(backdrop, '[data-act="generate"]');
  const p = handler();
  await flush();

  const html = backdrop.innerHTML;
  assert.match(html, /cover-busy/, '出图时应显示左侧遮罩');
  assert.match(html, /1–2 分钟/, '出图时保留耗时提示');

  resolveFetch(reply({ ok: true, cover: { url: '/assets/x.png', source: 'comfyui', prompt: '', updatedAt: 1 }, message: '已生成', secs: 3 }));
  await p; await flush();
  assert.ok(!backdrop.innerHTML.includes('cover-busy'), '完成后遮罩消失');
});

test('提示词生成期间再次点击 AI 生成按钮不会重复发请求', async () => {
  const handler = lastClickHandler(backdrop, '[data-act="ai-prompt"]');
  const p1 = handler();
  await flush();
  const callsAfterFirst = fetchCalls;
  const p2 = handler(); // promptBusy=true，应直接 return
  await flush();
  assert.equal(fetchCalls, callsAfterFirst, '重复点击不触发第二次请求');
  resolveFetch(reply({ prompt: 'x', negative: '', message: 'ok', fellBack: false }));
  await Promise.allSettled([p1, p2]);
});
