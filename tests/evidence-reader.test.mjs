/* 角色详情「原文出处」定位逻辑的行为级测试（无 DOM 依赖，手写桩）
 * 覆盖 locateQuoteContext 三级匹配口径：直查 → 压缩空白回映 → 前缀兜底，
 * 以及章节优先、全文兜底与定位失败返回 null。
 * 运行：node --test tests/evidence-reader.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/* ---- 手写轻量 DOM 桩（project-manager 顶层导入需要 document/window） ---- */

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

let locateQuoteContext;
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
  return import(mod).then((m) => { locateQuoteContext = m.locateQuoteContext; });
});

/* ---- 测试数据：两章正文，含换行与全角空白 ---- */

const chapters = [
  { no: 1, title: '初入山门', text: '林晚推开山门，雨刚停。\n她抬头看了看天，云缝里漏下一线光。' },
  { no: 2, title: '旧剑', text: '剑匣里的旧剑嗡了一声。\n「谁在唤你？」林晚问。旧剑不再作声，她便收了匣子。' },
];
const fullText = `${chapters[0].title}\n${chapters[0].text}\n${chapters[1].title}\n${chapters[1].text}`;

test('直查命中：引用与原文完全一致时返回章节出处与精确区间', () => {
  const hit = locateQuoteContext(chapters, fullText, '云缝里漏下一线光');
  assert.ok(hit, '应能定位');
  assert.equal(hit.label, '第 1 章 · 初入山门');
  assert.equal(hit.text.slice(hit.start, hit.end), '云缝里漏下一线光');
});

test('压缩空白匹配：引用空格被折叠过时仍能命中并回映到原始区间', () => {
  // 原文含换行，引用是空格折叠后的连续串
  const quote = '剑匣里的旧剑嗡了一声。 「谁在唤你？」';
  const hit = locateQuoteContext(chapters, fullText, quote);
  assert.ok(hit, '应能定位');
  assert.equal(hit.label, '第 2 章 · 旧剑');
  const sliced = hit.text.slice(hit.start, hit.end).replace(/\s+/g, '');
  assert.equal(sliced, quote.replace(/\s+/g, ''), '回映区间的压缩文本应与引用一致');
});

test('前缀兜底：引用被截断改写时，用前 10 字前缀仍能定位', () => {
  const hit = locateQuoteContext(chapters, fullText, '雨刚停。之后天色彻底暗了下来，谁也没有再说话，这是一段被改写的引用');
  assert.ok(hit, '前缀「雨刚停。」应能定位');
  assert.ok(hit.text.slice(hit.start, hit.end).startsWith('雨刚停'));
});

test('章节优先：同一片段在章节与全文中都存在时，出处落在章节正文', () => {
  const hit = locateQuoteContext(chapters, fullText, '旧剑不再作声');
  assert.ok(hit);
  assert.equal(hit.label, '第 2 章 · 旧剑');
  assert.notEqual(hit.text, fullText, '应使用章节正文而非全文兜底');
});

test('章节缺失时回退全文：chapters 为空也能在全文定位', () => {
  const hit = locateQuoteContext([], fullText, '她抬头看了看天');
  assert.ok(hit);
  assert.equal(hit.label, '');
  assert.equal(hit.text, fullText);
});

test('定位失败：引用完全不存在时返回 null，空引用也返回 null', () => {
  assert.equal(locateQuoteContext(chapters, fullText, '这段话原文里根本没有'), null);
  assert.equal(locateQuoteContext(chapters, fullText, ''), null);
  assert.equal(locateQuoteContext(chapters, fullText, '   '), null);
});
