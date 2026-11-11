/* ============================================================================
 * 统一 AI 对话面板（chat-panel.js）· 行为级单元测试
 *
 * 用手写 DOM 桩验证面板的核心契约（不依赖真实浏览器）：
 *   1) 档位切换条按服务端目录渲染，每档带计数徽标；
 *   2) 切档位会换掉提示条、功能按钮与占位文案（这是「统一但每步不同」的关键）；
 *   3) 消息按来源档位带标签，混排渲染；
 *   4) 「全部 / 仅当前档」筛选；
 *   5) 向上滚到顶部自动加载更早一页（游标分页）。
 *
 * 运行：node --test tests/chat-panel.test.mjs
 * ==========================================================================*/
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/* ---------------- 手写 DOM 桩：够用即可（选择器 → 元素注册表） ---------------- */
const registry = new Map();
/** 按选择器登记的桩元素：测试据此拿到面板内部容器（如消息列表） */
const bySelector = new Map();
function makeEl(tag = 'div') {
  const store = {
    tag, parent: null, listeners: {}, dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    innerHTML: '', textContent: '', value: '', className: '', src: '', title: '',
    disabled: false, removed: false, scrollTop: 0, scrollHeight: 0, children: [], firstChild: null,
    hidden: false,
  };
  const el = new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      switch (k) {
        case 'addEventListener': return (ev, fn) => { (t.listeners[ev] ||= []).push(fn); };
        case 'removeEventListener': return () => {};
        case 'dispatchEvent': return () => true;
        case 'appendChild': return (c) => { c.parent = el; t.children.push(c); t.firstChild = t.firstChild || c; return c; };
        case 'insertBefore': return (c) => { c.parent = el; t.children.unshift(c); return c; };
        case 'replaceChildren': return () => { t.children = []; t.firstChild = null; };
        case 'remove': return () => { t.removed = true; };
        case 'querySelector': return (sel) => {
          t.q ||= new Map();
          if (!t.q.has(sel)) {
            const c = makeEl();
            c.parent = el;
            t.q.set(sel, c);
            // 面板容器按选择器登记，测试可直接拿到并触发事件
            if (!bySelector.has(sel)) bySelector.set(sel, []);
            bySelector.get(sel).push(c);
          }
          return t.q.get(sel);
        };
        case 'querySelectorAll': return (sel) => {
          const found = [...(registry.get(sel) || [])].filter((e) => {
            for (let p = e; p; p = p.parent) if (p === el) return true;
            return false;
          });
          if (found.length) return found;
          const c = makeEl(); c.parent = el;
          if (!registry.has(sel)) registry.set(sel, new Set());
          registry.get(sel).add(c);
          return [c];
        };
        case 'firstElementChild': return t.children[0] || null;
        case 'nextElementSibling': return null;
        case 'click': case 'focus': case 'select': return () => {};
        case 'getBoundingClientRect': return () => ({ top: 0, height: 0 });
        default: return undefined;
      }
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return el;
}
function register(scope, sel, el) {
  el.parent = scope;
  if (!registry.has(sel)) registry.set(sel, new Set());
  registry.get(sel).add(el);
  return el;
}
async function click(el, ev = 'click') {
  const fns = el.listeners[ev] || [];
  assert.ok(fns.length, `目标元素应已注册 ${ev} 处理器`);
  await Promise.allSettled(fns.map((fn) => fn({ currentTarget: el })));
}

/* ---------------- 环境桩与模块导入 ---------------- */
let openChatPanel;
const pageRoot = makeEl();
const createdPages = [];

before(async () => {
  registry.clear();
  globalThis.document = {
    createElement: () => makeEl(),
    getElementById: () => pageRoot,
    body: makeEl(),
    querySelectorAll: () => [],
  };
  globalThis.window = globalThis;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

  // 页面宿主桩：openPage 记下每次调用，便于断言「只开一个面板」
  const pageMod = path.join(import.meta.dirname, '../public/page.js');
  const real = fs.readFileSync(pageMod, 'utf8');
  assert.match(real, /export function openPage/);

  const mod = path.join(import.meta.dirname, '../public/chat-panel.js');
  // chat-panel 依赖 page.js / ai-chat.js / utils.js / model-picker.js / interface-picker.js，
  // 这里用真实模块，只把 openPage 的 DOM 行为换成桩
  await import(path.join(import.meta.dirname, '../public/page.js')).then(async (p) => {
    // 直接给 page.js 的宿主塞一个可用的 root
    p.__setHost?.(pageRoot);
  }).catch(() => {});
  const m = await import(mod);
  openChatPanel = m.openChatPanel;
});

/* ---------------- 桩数据 ---------------- */
const SCOPES = [
  { id: 'project', label: '项目总览 · 制片助手', short: '总览', icon: '◈', group: '总览', available: true,
    placeholder: '一句话推进整条流水线…', hint: '我是 AI 制片助手。', context: ['项目「X」'],
    suggestions: [{ text: '跑完六步', label: '跑完六步' }], actions: [{ id: 'project.steps', label: '⏩ 跑完六步', say: '依次跑完全部六个步骤' }] },
  { id: 'script', label: '第 3 步 · 剧本生成', short: '第3步', icon: '▤', group: '六步', available: true,
    placeholder: '说一句要改什么，例如「重新生成第 2 集剧本」…', hint: '我是「剧本生成」的协作助手。',
    context: ['已生成剧本 1/4 集'], suggestions: [{ text: '重新生成第 2 集剧本', label: '重写某集' }],
    actions: [{ id: 'script.rerun', label: '↻ 重跑本步', say: '重新生成剧本' }] },
  { id: 'cover', label: '项目封面', short: '封面', icon: '🖼', group: '资产', available: true,
    placeholder: '描述你想要的封面…', hint: '我是封面创作助手。', context: ['当前封面：名称封面'],
    suggestions: [{ text: '水墨风', label: '水墨留白' }],
    actions: [{ id: 'cover.one-click', label: '✦ 一键生成封面', act: 'cover.one-click', primary: true }] },
];

const MESSAGES = [
  { uid: 'a', scope: 'script', scopeLabel: '第 3 步 · 剧本生成', scopeShort: '第3步', scopeIcon: '▤',
    role: 'user', text: '把基调改成更冷峻', at: 1000, suggestions: [], artifacts: [], links: [], images: [] },
  { uid: 'b', scope: 'script', scopeLabel: '第 3 步 · 剧本生成', scopeShort: '第3步', scopeIcon: '▤',
    role: 'assistant', text: '✓ 基调已更新', at: 2000, suggestions: [], artifacts: [], links: [], images: [] },
  { uid: 'c', scope: 'cover', scopeLabel: '项目封面', scopeShort: '封面', scopeIcon: '🖼',
    role: 'assistant', text: '已写好封面提示词', at: 3000, suggestions: [], artifacts: [], links: [], images: [] },
];

/* ---------------- 用例 ---------------- */

test('面板：档位切换条按服务端目录渲染，消息计数带徽标', async () => {
  const fetchCalls = [];
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    const u = String(url);
    if (u.includes('/ai/scopes')) {
      return { ok: true, status: 200, json: async () => ({ scopes: SCOPES, counts: { script: 2, cover: 1, project: 0 } }) };
    }
    return { ok: true, status: 200, json: async () => ({ messages: MESSAGES, nextCursor: null, hasMore: false, counts: {} }) };
  };
  const api = openChatPanel({ projectId: 'p1a', projectName: '测试项目', scope: 'script' });
  assert.ok(api, '应返回面板句柄');
  await new Promise((r) => setTimeout(r, 60));

  assert.ok(fetchCalls.some((u) => u.includes('/ai/scopes')), '应拉取档位目录');
  assert.ok(fetchCalls.some((u) => u.includes('/ai/thread')), '应拉取合并时间线');
  assert.equal(api.scope, 'script');
});

test('面板：切档位会换掉占位文案与功能按钮（同一对话框、不同步骤不同提示）', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/ai/scopes')) {
      return { ok: true, status: 200, json: async () => ({ scopes: SCOPES, counts: {} }) };
    }
    return { ok: true, status: 200, json: async () => ({ messages: MESSAGES, nextCursor: null, hasMore: false, counts: {} }) };
  };
  const api = openChatPanel({ projectId: 'p1b1', scope: 'script' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(api.scopeDef()?.id, 'script');
  assert.match(api.scopeDef().placeholder, /重新生成第 2 集剧本/);

  await api.setScope('cover');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(api.scopeDef()?.id, 'cover');
  assert.match(api.scopeDef().placeholder, /封面/);
  assert.ok(api.scopeDef().actions.some((a) => a.act === 'cover.one-click'), '封面档有「一键生成封面」按钮');
});

test('面板：同项目重复打开只切档位，不叠新页面', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/ai/scopes')) return { ok: true, status: 200, json: async () => ({ scopes: SCOPES, counts: {} }) };
    return { ok: true, status: 200, json: async () => ({ messages: MESSAGES, nextCursor: null, hasMore: false, counts: {} }) };
  };
  const a = openChatPanel({ projectId: 'p1c', scope: 'script' });
  await new Promise((r) => setTimeout(r, 40));
  const b = openChatPanel({ projectId: 'p1c', scope: 'cover' });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(a, b, '同项目应复用同一个面板实例');
  assert.equal(b.scope, 'cover', '重复打开只是切档位');
});

test('面板：消息按来源档位带标签，混排渲染', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/ai/scopes')) return { ok: true, status: 200, json: async () => ({ scopes: SCOPES, counts: {} }) };
    return { ok: true, status: 200, json: async () => ({ messages: MESSAGES, nextCursor: null, hasMore: false, counts: {} }) };
  };
  const api = openChatPanel({ projectId: 'p1b2', scope: 'script' });
  await new Promise((r) => setTimeout(r, 60));
  // 三条消息分属两个档位，都应在统一列表里
  assert.equal(api.state.messages.length, 3);
  assert.deepEqual([...new Set(api.state.messages.map((m) => m.scope))].sort(), ['cover', 'script']);
  assert.equal(api.state.messages[0].scopeLabel, '第 3 步 · 剧本生成');
});

test('面板：「仅当前档」筛选只留当前档消息', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/ai/scopes')) return { ok: true, status: 200, json: async () => ({ scopes: SCOPES, counts: {} }) };
    return { ok: true, status: 200, json: async () => ({ messages: MESSAGES, nextCursor: null, hasMore: false, counts: {} }) };
  };
  const api = openChatPanel({ projectId: 'p1b3', scope: 'script' });
  await new Promise((r) => setTimeout(r, 60));
  api.state.filter = 'scope';
  assert.equal(api.state.messages.filter((m) => m.scope === 'script').length, 2);
  api.state.filter = 'all';
  assert.equal(api.state.messages.length, 3);
});

test('面板：滚到顶部自动加载更早一页（游标分页）', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes('/ai/scopes')) return { ok: true, status: 200, json: async () => ({ scopes: SCOPES, counts: {} }) };
    if (u.includes('before=')) {
      return { ok: true, status: 200, json: async () => ({
        messages: [{ uid: 'old', scope: 'script', scopeLabel: '第 3 步 · 剧本生成', scopeShort: '第3步',
          scopeIcon: '▤', role: 'user', text: '更早的一条', at: 500,
          suggestions: [], artifacts: [], links: [], images: [] }],
        nextCursor: null, hasMore: false, counts: {},
      }) };
    }
    return { ok: true, status: 200, json: async () => ({
      messages: MESSAGES, nextCursor: '1000|2|1', hasMore: true, counts: {},
    }) };
  };
  const api = openChatPanel({ projectId: 'p1b4', scope: 'script' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(api.state.hasMore, true);
  assert.equal(api.state.messages.length, 3);

  // 滚到顶部 → 触发「载入更早一页」
  // 取最近注册的那个列表容器（前面的用例也开过面板，面板是单例但 DOM 各不相同）
  const list = (bySelector.get('[data-acp="list"]') || []).at(-1);
  assert.ok(list, '应能拿到消息列表容器');
  assert.ok((list.listeners.scroll || []).length, '列表容器应注册了 scroll 处理器');
  list.scrollTop = 0;
  await click(list, 'scroll');
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(urls.some((u) => u.includes('before=')), '应带游标请求更早一页');
  assert.equal(api.state.messages.length, 4, '更早的一条被插到最前');
  assert.equal(api.state.messages[0].text, '更早的一条');
});
