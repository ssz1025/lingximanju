/* 「本次使用的 ComfyUI 接口」选择器 + 启动引导就绪判定回归
 * 运行：node --test tests/interface-picker.test.mjs
 * 纯逻辑测试：用极简 localStorage / document / fetch 替身，不依赖浏览器与真实后端。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  interfaceScopeKey, interfacesForScope, scopeList, SCOPE_LABELS, SCOPE_ORDER,
  pickedInterfaceId, withInterfaceId, setInterfaceProjectScope,
  ensureInterfacePicker, refreshInterfaces, invalidateInterfaces, repaintInterfacePickers,
} from '../public/interface-picker.js';
import { comfyKindReady, configNeedsAttention, configDetail } from '../public/startup-check.js';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const DATA = {
  interfaces: [
    { id: 'wf_a', name: '文生图A', kind: 'image', capability: '文生图', active: true },
    { id: 'wf_b', name: '图生图B', kind: 'image', capability: '图生图', active: false },
    { id: 'wf_v', name: '视频C', kind: 'video', capability: '图生视频', active: true },
  ],
  scopeBindings: { cover: 'wf_b' },
  scopes: [
    ...SCOPE_ORDER.map((id) => ({ id, kind: id === 'video' ? 'video' : id === 'voice' ? 'audio' : 'image' })),
  ],
};

test('interfaceScopeKey：项目 + 板块两级隔离，关闭项目回退应用级', () => {
  assert.equal(interfaceScopeKey('cover'), 'lm.iface.cover');
  assert.equal(interfaceScopeKey('cover', ''), 'lm.iface.cover');
  assert.equal(interfaceScopeKey('cover', 'prj_1'), 'lm.iface.cover.p_prj_1');
  assert.notEqual(interfaceScopeKey('cover', 'prj_1'), interfaceScopeKey('keyframe', 'prj_1'));
  assert.notEqual(interfaceScopeKey('cover', 'prj_1'), interfaceScopeKey('cover', 'prj_2'));
});

test('interfacesForScope：按类别过滤，缺 scopes 元数据也能兜底', () => {
  assert.deepEqual(interfacesForScope(DATA, 'cover').map((e) => e.id), ['wf_a', 'wf_b']);
  assert.deepEqual(interfacesForScope(DATA, 'video').map((e) => e.id), ['wf_v']);
  assert.deepEqual(interfacesForScope(DATA, 'voice'), [], '没有音频档案的板块返回空列表');
  assert.deepEqual(interfacesForScope(null, 'cover'), []);
  assert.deepEqual(interfacesForScope({ interfaces: DATA.interfaces }, 'video').map((e) => e.id), ['wf_v']);
});

test('scopeList：11 个板块与后端 MEDIA_SCOPES 同序，标签齐全', () => {
  const list = scopeList(DATA);
  assert.equal(list.length, 11);
  assert.deepEqual(list.map((s) => s.id), SCOPE_ORDER);
  assert.equal(list.find((s) => s.id === 'character-sheet').label, '角色定妆板');
  assert.equal(list.find((s) => s.id === 'voice').kind, 'audio');
  assert.equal(list.find((s) => s.id === 'video').kindLabel, '视频');
  assert.equal(SCOPE_LABELS.cover, '封面');
});

test('withInterfaceId：选中才注入 interfaceId，并按项目分别记忆', () => {
  store.clear();
  setInterfaceProjectScope('');
  assert.deepEqual(withInterfaceId('cover', { prompt: '雨夜' }), { prompt: '雨夜' });
  store.set('lm.iface.cover', 'wf_b');
  assert.deepEqual(withInterfaceId('cover', { prompt: '雨夜' }), { prompt: '雨夜', interfaceId: 'wf_b' });
  assert.equal(withInterfaceId('keyframe', { prompt: '雨夜' }).interfaceId, undefined, '板块之间不串');

  setInterfaceProjectScope('prj_1', '雨夜侦探');
  assert.equal(pickedInterfaceId('cover'), '', '换项目后回到该项目自己的记忆');
  store.set('lm.iface.cover.p_prj_1', 'wf_a');
  assert.equal(withInterfaceId('cover', {}).interfaceId, 'wf_a');
  setInterfaceProjectScope('');
  assert.equal(withInterfaceId('cover', {}).interfaceId, 'wf_b', '切回应用级恢复默认记忆');
  assert.doesNotThrow(() => setInterfaceProjectScope(''));
});

test('启动引导：板块绑定但镜像为空时不误报「未导入工作流」', () => {
  const settings = { llm: { configured: true, provider: 'openai', model: 'm', maskedKey: 'sk-1' } };
  const comfy = {
    baseUrl: 'http://127.0.0.1:8188',
    imageWorkflow: null, videoWorkflow: null,
    interfaces: [{ id: 'wf_a', kind: 'image' }, { id: 'wf_v', kind: 'video' }],
    scopeBindings: { cover: 'wf_a' },
  };
  assert.equal(comfyKindReady(comfy, 'image'), true);
  assert.equal(comfyKindReady(comfy, 'video'), true);
  assert.equal(comfyKindReady(comfy, 'audio'), false);
  assert.equal(configNeedsAttention(settings, comfy), false, '有接口档案就不再弹首次配置引导');
  const d = configDetail(settings, comfy);
  assert.equal(d.comfyReady, true);
  assert.match(d.comfyText, /2 份接口档案/);

  assert.equal(configNeedsAttention(settings, { interfaces: [] }), true, '一份接口都没有仍需引导');
  assert.equal(comfyKindReady({ imageWorkflow: { '1': {} }, interfaces: [] }, 'image'), true, '旧后端回退镜像字段');
});

test('选择器：档案少于 2 份不插入；可选时按板块插入并记忆本次选择', async () => {
  store.clear();
  setInterfaceProjectScope('');
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { json: async () => ({ ...DATA, scopeBindings: {} }) };
  };
  const first = await invalidateInterfaces();
  assert.equal(first.interfaces.length, 3);
  assert.equal(calls, 1);
  const cached = await refreshInterfaces();
  assert.equal(cached, first, '未强制刷新时复用缓存');
  assert.equal(calls, 1);

  const host = {
    children: [],
    querySelector: () => null,
    appendChild(el) { this.children.push(el); },
    insertBefore(el) { this.children.push(el); },
  };
  const fakeSelects = [];
  globalThis.document = {
    createElement: () => ({
      dataset: {}, className: '', innerHTML: '', value: '', title: '', hidden: false,
      options: [], addEventListener(ev, fn) { this.onChange = fn; },
    }),
    querySelectorAll: () => fakeSelects,
  };
  assert.equal(await ensureInterfacePicker('video', host), null, '视频只有 1 份档案，不插入下拉');
  assert.equal(host.children.length, 0);
  assert.equal(await ensureInterfacePicker('voice', host), null, '没有音频档案，不插入下拉');

  const sel = await ensureInterfacePicker('cover', host);
  assert.ok(sel, '封面有 2 份出图档案，插入下拉');
  assert.equal(sel.dataset.ifacePick, 'cover');
  assert.equal(sel.className, 'interface-picker');
  assert.equal(host.children.length, 1);
  sel.value = 'wf_b';
  sel.onChange?.();
  assert.equal(pickedInterfaceId('cover'), 'wf_b', '选择写入 localStorage');
  assert.equal(withInterfaceId('cover', {}).interfaceId, 'wf_b');

  // 重绘：默认项显示板块当前绑定的档案名，失效的选择回落到默认
  fakeSelects.push(sel);
  globalThis.fetch = async () => ({ json: async () => DATA });
  const fresh = await invalidateInterfaces();
  assert.equal(fresh.scopeBindings.cover, 'wf_b');
  assert.match(sel.innerHTML, /跟随默认（图生图B）/, '默认项标注当前绑定档案');
  assert.match(sel.innerHTML, /文生图A/);
  sel.options = [{ value: '' }, { value: 'wf_a' }, { value: 'wf_b' }]; // 真实 <select> 会解析 option
  repaintInterfacePickers(fresh);
  assert.equal(sel.value, 'wf_b', '仍存在的档案保留本次选择');
  delete globalThis.document;
});
