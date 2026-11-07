/* ai-chat 对话组件「忙等态按钮可见性」行为级测试（无 DOM 依赖，手写层级桩）
 * 背景 bug：忙等只禁用输入框，动作按钮（如「✦ 生成封面」）看似可点，点击却被
 * busy 守卫静默吞掉——用户感知为「第一次点击没反应，第二次才生效」。
 * 修复契约：忙等开始 → 全部动作按钮/chips 置灰；忙等结束 → 原样恢复；
 * 忙等期间新增的消息按钮同样先置灰后恢复；chips 不再因经历忙等而永久禁用。
 * 运行：node --test tests/ai-chat.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/* ---- 手写层级 DOM 桩：appendChild 记录父子关系，querySelectorAll 按
 *      「注册表 + 祖先链」检索，使父作用域能查到子消息里的按钮（贴近真实 DOM） ---- */

const index = new Map();          // selector -> Set<元素桩>：首次查询时登记
function makeEl(tag = 'div') {
  const store = {
    tag, parent: null, listeners: {}, dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    innerHTML: '', textContent: '', value: '', className: '', src: '', title: '',
    disabled: false, removed: false, scrollTop: 0, scrollHeight: 0, children: [],
  };
  const el = new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      switch (k) {
        case 'addEventListener': return (ev, fn) => { (t.listeners[ev] ||= []).push(fn); };
        case 'appendChild': return (c) => { c.parent = el; t.children.push(c); return c; };
        case 'remove': return () => { t.removed = true; };
        case 'click': case 'focus': case 'select': return () => {};
        case 'firstElementChild': {
          if (!t.fe) { t.fe = makeEl(); t.fe.parent = el; }
          return t.fe;
        }
        case 'querySelector': return (sel) => {
          t.q ||= new Map();
          if (!t.q.has(sel)) { const c = makeEl(); c.parent = el; t.q.set(sel, c); }
          return t.q.get(sel);
        };
        case 'querySelectorAll': return (sel) => {
          const found = [...(index.get(sel) || [])].filter((e) => {
            for (let p = e; p; p = p.parent) if (p === el) return true;
            return false;
          });
          if (found.length) return found;
          const c = makeEl();           // 兜底单桩（如 .aichat-imgs img），登记为后代
          c.parent = el;
          if (!index.has(sel)) index.set(sel, new Set());
          index.get(sel).add(c);
          return [c];
        };
        default: return undefined;
      }
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return el;
}
function register(scope, sel, el) {
  el.parent = scope;
  if (!index.has(sel)) index.set(sel, new Set());
  index.get(sel).add(el);
  return el;
}
/** 触发元素上注册的全部 click 处理器 */
async function click(el) {
  const fns = el.listeners.click || [];
  assert.ok(fns.length, '目标元素应已注册 click 处理器');
  await Promise.allSettled(fns.map((fn) => fn({ currentTarget: el })));
}
const flush = () => new Promise((r) => setTimeout(r, 0));

/* ---- 环境桩与模块导入（必须先于动态 import 设好全局） ---- */

let openAIChat;
const modalRoot = makeEl();
before(() => {
  index.clear();
  globalThis.document = {
    createElement: () => makeEl(),
    getElementById: () => modalRoot,
    body: makeEl(),
  };
  globalThis.window = globalThis;
  const mod = fs.realpathSync(path.join(import.meta.dirname, '../public/ai-chat.js'));
  return import(mod).then((m) => { openAIChat = m.openAIChat; });
});

/** 取某条消息元素上的第一个动作按钮桩（并补齐 dataset 索引） */
function firstActBtn(msgEl, i = 0) {
  const btn = msgEl.querySelectorAll('[data-aichat-act]')[i];
  btn.dataset.aichatAct = String(i);
  return btn;
}

/* ---- 用例 ---- */

test('开场消息动作按钮初始可点；忙等开始全体置灰，结束恢复', () => {
  const ui = openAIChat({
    welcome: { text: 'hi', actions: [{ label: '✦ 一键生成封面', act: 'a' }, { label: '⇧ 上传参考图', act: 'b' }] },
    actions: { a: async () => {}, b: async () => {} },
  });
  const list = modalRoot.children.at(-1).querySelector('[data-aichat="list"]');
  const btn = firstActBtn(list.children.at(-1));
  assert.equal(btn.disabled, false, '初始可点');
  ui.setBusy(true);
  assert.equal(btn.disabled, true, '忙等开始：动作按钮置灰（修复前保持可点、点击被静默吞掉）');
  ui.setBusy(false);
  assert.equal(btn.disabled, false, '忙等结束：恢复可点');
});

test('核心回归：忙等中返回的提示词消息按钮置灰，忙等中点击不触发、结束后点击生效', async () => {
  let genCalls = 0;
  const ui = openAIChat({ actions: { gen: async () => { genCalls += 1; await flush(); } } });

  // 模拟：一键生成/对话任务进行中（busy=true），助手此时追加提示词消息
  ui.setBusy(true, 'ComfyUI 正在生成封面（约 1–2 分钟）…');
  const el = ui.addMessage({
    text: '已写好封面提示词',
    actions: [{ label: '✦ 生成封面', act: 'gen', primary: true }],
  });
  const btn = firstActBtn(el);
  assert.equal(btn.disabled, true, '忙等中新增的「生成封面」按钮应立即置灰');

  await click(btn);                       // 用户在生成过程中点击
  assert.equal(genCalls, 0, '忙等中点击不得触发生成（修复前此处被静默吞掉且无任何反馈）');

  ui.setBusy(false);                      // 任务结束，忙等解除
  assert.equal(btn.disabled, false, '忙等结束后按钮恢复可点');

  await click(btn);                       // 再次点击
  await flush();
  assert.equal(genCalls, 1, '恢复正常触发生成');
});

test('动作按钮点击后该消息按钮消费式禁用：处理器恰好一次、忙等结束也不复活', async () => {
  let calls = 0;
  const ui = openAIChat({
    welcome: { text: 'x', actions: [{ label: '✦ 生成封面', act: 'gen' }] },
    actions: { gen: async () => { calls += 1; } },
  });
  const list = modalRoot.children.at(-1).querySelector('[data-aichat="list"]');
  const btn = firstActBtn(list.children.at(-1));
  await click(btn);
  await flush();
  assert.equal(calls, 1, '处理器恰好触发一次');
  assert.equal(btn.disabled, true, '点击后消费式禁用');
  ui.setBusy(true); ui.setBusy(false);   // 再经历一轮忙等
  assert.equal(btn.disabled, true, '消费式禁用不因忙等结束而复活');
});

test('建议 chips：忙等期间置灰、结束后恢复（修复「经历一次忙等即永久禁用」）', () => {
  const ui = openAIChat({ welcome: { text: 'x', suggestions: ['换个风格', '更悬疑一点'] } });
  const list = modalRoot.children.at(-1).querySelector('[data-aichat="list"]');
  const chip = list.children.at(-1).querySelectorAll('[data-aichat-chip]')[0];
  assert.equal(chip.disabled, false, '初始可点');
  ui.setBusy(true);
  assert.equal(chip.disabled, true, '忙等期间置灰');
  ui.setBusy(false);
  assert.equal(chip.disabled, false, '忙等结束恢复（修复前 disabled 被永久保留）');
});

test('发送链路：send → onSend 收到文本与历史，忙等包裹完整任务', async () => {
  const seen = [];
  const ui = openAIChat({
    welcome: { text: 'w' },
    onSend: async ({ text, history }) => { seen.push({ text, historyLen: history.length }); },
  });
  const backdrop = modalRoot.children.at(-1);
  const input = backdrop.querySelector('[data-aichat="input"]');
  const sendBtn = backdrop.querySelector('[data-aichat="send"]');
  input.value = '深蓝夜空下的城市天际线';
  sendBtn.listeners.click[0]();
  await flush();
  assert.deepEqual(seen, [{ text: '深蓝夜空下的城市天际线', historyLen: 2 }],
    '用户消息已入历史并回调 onSend（历史含开场白，供 LLM 上下文）');
  assert.equal(input.disabled, false, '任务完成后输入恢复');
});
