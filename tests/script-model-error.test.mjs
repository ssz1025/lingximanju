/* ============================================================================
 * ④ 剧本创作：可选模型 + 生成失败弹窗
 *
 * 覆盖：
 *   1. 静态契约：模型选择条、弹窗按钮用 data-se（不新增 data-act，63 个入口基线不变）、
 *      请求报错才弹窗、所有剧本请求仍带 withModelId('episode')、批量部分成功仍走 toast；
 *   2. 后端：真实模型失败带出原因、剧本不写盘、单集 / 批量 502 带明细、失效档案 400、
 *      零 Key 仍可用内置模板；
 *   3. 前端工具：失效模型记忆可清理，不再把已删除的档案 id 反复发给后端。
 * 运行：node --test tests/script-model-error.test.mjs
 * 注意：必须先把数据目录指到临时目录再动态导入路由（ESM import 会提升），避免污染真实 data/。
 * ==========================================================================*/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-script-model-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const { handleEpisodes, scriptLlmConfigured } = await import('../src/api/routes/episodes.mjs');
const { saveProject, loadProject } = await import('../src/core/store.mjs');
const { createManagement } = await import('../src/core/project-steps.mjs');
const { createProviders } = await import('../src/core/providers.mjs');
const { modelScopeKey, pickedModelId, setPickedModelId, setModelProjectScope, clearStaleModelId, modelRoster } = await import('../public/model-picker.js');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/* ------------------------------ 静态契约 ------------------------------ */
const projectView = read('public/project-view.js');
const episodeView = read('public/episode-view.js');
const dialog = read('public/script-error-dialog.js');
const bar = read('public/script-model-bar.js');
const picker = read('public/model-picker.js');
const route = read('src/api/routes/episodes.mjs');
const service = read('src/core/episode-service.mjs');
const providers = read('src/core/providers.mjs');

test('工作台功能入口仍是 63 个，弹窗不新增 data-act', () => {
  const acts = [...new Set([...projectView.matchAll(/data-act="([a-z0-9-]+)"/g)].map((m) => m[1]))];
  assert.equal(acts.length, 63);
  assert.doesNotMatch(dialog, /data-act=/, '剧本失败弹窗按钮一律 data-se');
  assert.match(dialog, /data-se="close"/);
  assert.match(dialog, /data-se="retry"/);
  assert.match(dialog, /data-se="settings"/);
  assert.match(dialog, /data-se="model"/, '报错弹窗里要能直接换模型');
  assert.match(dialog, /setPickedModelId/, '换模型要写入与选择条共用的记忆');
  assert.match(dialog, /modal-root/);
  assert.match(projectView, /data-smb="switch"/, '流水线「重写本集剧本」旁要有切换入口');
});

test('工作台与剧集详情页都挂固定「本次剧本模型」条，所有剧本请求仍带上所选模型', () => {
  assert.match(projectView, /data-script-model-slot/, '剧本台要有固定槽位');
  assert.ok((episodeView.match(/data-script-model-slot/g) || []).length >= 2, '详情页空态与已生成两处都要有槽位');
  assert.match(projectView, /mountScriptModelBar\('episode'/);
  assert.match(episodeView, /mountScriptModelBar\('episode'/);
  assert.match(bar, /modelRoster\(/, '模型库为空时也要渲染可见状态');
  assert.match(bar, /未配置文本模型/);
  assert.match(bar, /dataset\.smb = 'refresh'/, '库为空 / 读取失败也要能刷新');
  assert.match(bar, /内置模板 · 未配置模型/, '空库时下拉仍常驻');
  assert.match(picker, /export async function modelRoster/);
  assert.match(picker, /export function setPickedModelId/);
  assert.match(picker, /rosterPromise = null/, '一次读取失败不能永久缓存成空模型库');
  assert.ok((projectView.match(/withModelId\('episode'/g) || []).length >= 2, '单集与批量都要传 modelId');
  assert.ok((episodeView.match(/withModelId\('episode'/g) || []).length >= 2, '详情页单集与补齐缺失都要传 modelId');
});

test('失败弹窗只挂在请求报错的 catch，批量部分成功仍用 toast 汇总', () => {
  assert.match(projectView, /showScriptError\(\{/, '工作台要调用统一弹窗');
  assert.match(episodeView, /showScriptError\(\{/, '详情页要调用统一弹窗');
  assert.match(episodeView, /opts\.scriptError/, '详情页只对剧本动作弹窗');
  assert.ok((projectView.match(/models,/g) || []).length >= 2, '工作台单集 / 批量弹窗都要带模型档案');
  assert.match(episodeView, /models,/, '详情页弹窗也要带模型档案');
  assert.match(projectView, /toast\(d\.message \|\| `已生成 \$\{d\.generated\} 集剧本`/, '部分成功保持原 toast');
  assert.match(projectView, /err\.results = Array\.isArray\(data\.results\)/);
  assert.match(episodeView, /err\.results = Array\.isArray\(d\.results\)/);
});

test('后端契约：回退原因透传 / 不写盘 / 批量 502 明细 / 失效档案校验', () => {
  assert.match(providers, /__fallbackError: fallbackError/);
  assert.match(service, /providers\.mode === 'openai' && out\?\.__fallbackError/);
  assert.match(service, /剧本未写入/);
  assert.ok((route.match(/invalidScriptModel\(body\)/g) || []).length >= 2, '单集与批量都校验模型档案');
  assert.match(route, /全部 \$\{failed\.length\} 集剧本生成失败\$\{first\}/);
  assert.match(route, /results: failed/, '502 仍返回逐集明细');
  assert.match(route, /scriptLlmConfigured\(/, '配置判定改看模型库');
  assert.match(route, /本次剧本模型.*后点重写/, '模板成功提示要给出切换指引');
});

/* ------------------------------ 后端行为 ------------------------------ */
// 不可达的假端点：保证测试走「真实模型调用失败」分支且不发任何外部请求
const FAKE_LLM = {
  provider: 'openai', model: 'fake-model', baseUrl: 'http://127.0.0.1:9/v1',
  apiKey: 'sk-unit-fake', llmTimeoutMs: 300,
};

function makeProject(id, settings = FAKE_LLM) {
  const ep = {
    no: 1, title: '第一章', summary: '沈砚雨夜收到一封没有署名的信', hook: '照片背面写着他的名字',
    text: '雨水落下。沈砚推开门。「谁在那里？」他问。',
  };
  const project = {
    id, name: '剧本失败链路', kind: 'novel', createdAt: Date.now(), updatedAt: Date.now(),
    settings,
    management: createManagement({
      kind: 'novel', title: '雨夜来信',
      source: { title: '雨夜来信', text: '雨水落下。沈砚推开门。「谁在那里？」他问。' },
      episodes: [ep],
    }),
  };
  project.management.episodes[0] = { ...project.management.episodes[0], ...ep };
  saveProject(project);
  return project;
}

function run(method, pathname, body) {
  const res = {
    setHeader() {}, statusCode: 0,
    writeHead(s) { this.statusCode = s; },
    end(b) { this.body = b; },
  };
  const req = new EventEmitter();
  req.method = method;
  req.headers = {};
  const p = handleEpisodes(req, res, { pathname });
  if (body !== undefined) { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); }
  return p.then(() => ({ status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }));
}

test('真实模型调用失败会把原因随回退结果带出，供上层判失败', async () => {
  const p = createProviders({ ...FAKE_LLM }, () => {});
  assert.equal(p.mode, 'openai');
  const out = await p.generate('screenplay', {
    episodeNo: 1, episodeCode: 'EP001', title: '测试', logline: '雨夜来信',
    originalText: '雨水落下。沈砚推开门。', characters: [{ name: '沈砚' }], targetScenes: 2,
  });
  assert.equal(out.__fallback, true);
  assert.ok(String(out.__fallbackError || '').length > 0, '必须带出原始失败原因');
});

test('所选模型档案已失效：单集 / 批量都返回 400 并说明要重新选择', async () => {
  const id = 'prj_stale_model';
  makeProject(id);
  const single = await run('POST', `/api/projects/${id}/episodes/1/script`, { modelId: 'ghost-model' });
  assert.equal(single.status, 400);
  assert.match(single.body.error, /已不存在.*重新选择/);
  const batch = await run('POST', `/api/projects/${id}/episodes/scripts`, { modelId: 'ghost-model', onlyMissing: true });
  assert.equal(batch.status, 400);
  assert.match(batch.body.error, /已不存在/);
});

test('模型调用失败：单集返回 502，原有剧本不被模板覆盖', async () => {
  const id = 'prj_script_fail_one';
  makeProject(id);
  const { status, body } = await run('POST', `/api/projects/${id}/episodes/1/script`, {});
  assert.equal(status, 502, `实际：${status} ${JSON.stringify(body)}`);
  assert.match(body.error, /模型「fake-model」调用失败/);
  assert.match(body.error, /剧本未写入/);
  const fresh = loadProject(id);
  assert.ok(!fresh.management.episodes[0].script, '失败不能写回模板剧本');
});

test('批量全部失败：502 带首条原因与逐集明细，供弹窗展示', async () => {
  const id = 'prj_script_fail_batch';
  makeProject(id);
  const { status, body } = await run('POST', `/api/projects/${id}/episodes/scripts`, { force: true });
  assert.equal(status, 502, `实际：${status} ${JSON.stringify(body)}`);
  assert.match(body.error, /全部 1 集剧本生成失败/);
  assert.match(body.error, /调用失败/);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].no, 1);
  assert.ok(body.results[0].error);
});

test('零 Key / 未配置模型仍可用内置模板，不算失败', async () => {
  const id = 'prj_script_mock_ok';
  makeProject(id, { style: 'cinematic' });
  const { status, body } = await run('POST', `/api/projects/${id}/episodes/1/script`, {});
  assert.equal(status, 200, `实际：${status} ${JSON.stringify(body)}`);
  assert.equal(body.script.source, 'mock');
  assert.match(body.message, /内置模板/);
  assert.match(body.message, /本次剧本模型/, '不再说「未配置大模型」，而是指向选择条');
  assert.doesNotMatch(body.message, /未配置大模型/);
});

/* ------------------------------ 前端工具 ------------------------------ */
test('失效的模型选择记忆会被清掉，不再反复请求后端 400', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  setModelProjectScope('prj_1', '雨夜来信');
  const key = modelScopeKey('episode', 'prj_1');
  store.set(key, 'ghost-model');
  assert.equal(pickedModelId('episode'), 'ghost-model');
  assert.equal(clearStaleModelId('episode', [{ id: 'm1' }]), '');
  assert.equal(store.has(key), false);
  store.set(key, 'm1');
  assert.equal(clearStaleModelId('episode', [{ id: 'm1' }]), 'm1', '有效档案要保留');
  assert.equal(store.get(key), 'm1');
  setModelProjectScope('');
  delete globalThis.localStorage;
});

test('失败弹窗渲染模型错误原因与逐集明细，并转义后端文案', async () => {
  const { showScriptError } = await import('../public/script-error-dialog.js');
  const backdrop = {
    className: '', innerHTML: '', dataset: {},
    addEventListener() {}, removeEventListener() {}, remove() {},
    querySelectorAll: () => [], querySelector: () => null, focus() {},
  };
  const rootNode = { appendChild(el) { this.child = el; } };
  globalThis.document = {
    getElementById: (id) => (id === 'modal-root' ? rootNode : null),
    createElement: () => backdrop,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };
  try {
    const box = showScriptError({
      message: '模型「fake <script>」调用失败',
      results: [{ no: 2, error: 'LLM 401 <b>' }],
      onRetry: () => {}, onSettings: () => {},
    });
    assert.ok(box, '有 #modal-root 时应创建弹窗');
    assert.equal(rootNode.child, backdrop);
    assert.match(backdrop.innerHTML, /剧本生成失败/);
    assert.match(backdrop.innerHTML, /fake &lt;script&gt;/);
    assert.match(backdrop.innerHTML, /第 2 集/);
    assert.match(backdrop.innerHTML, /LLM 401 &lt;b&gt;/);
    assert.doesNotMatch(backdrop.innerHTML, /<script>/);
    assert.match(backdrop.innerHTML, /data-se="retry"/);
    assert.match(backdrop.innerHTML, /data-se="settings"/);
    assert.doesNotMatch(backdrop.innerHTML, /data-act=/);
  } finally {
    delete globalThis.document;
  }
});

/* ------------------------------ 本轮：提示口径与就地切换 ------------------------------ */
test('是否配置了文本模型按模型库判定，旧全局 llm=mock 不再误报「未配置」', () => {
  assert.equal(scriptLlmConfigured({ llm: { configured: false }, models: [{ configured: true }] }, {}), true);
  assert.equal(scriptLlmConfigured({ llm: { configured: true }, models: [] }, {}), true);
  assert.equal(scriptLlmConfigured({ llm: { configured: false }, models: [] }, { settings: { provider: 'openai', apiKey: 'k' } }), true);
  assert.equal(scriptLlmConfigured({ llm: { configured: false }, models: [{ configured: false }] }, {}), false);
  assert.equal(scriptLlmConfigured({ llm: { configured: false }, models: [] }, {}), false);
});

/** 轻量级 DOM 替身：只实现选择条 / 弹窗用到的成员 */
function fakeEl(extra = {}) {
  return {
    className: '', innerHTML: '', textContent: '', value: '', disabled: false, dataset: {},
    children: [], handlers: {}, removed: false,
    classList: { add() {}, remove() {} },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    removeEventListener() {},
    remove() { this.removed = true; },
    focus() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    ...extra,
  };
}

function fakeStorage(store) {
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

test('失败弹窗里的「改用模型」下拉可切换，并把选择写入共用记忆后重试', async () => {
  const store = new Map();
  globalThis.localStorage = fakeStorage(store);
  setModelProjectScope('prj_dialog', '雨夜来信');
  setPickedModelId('episode', 'm1');

  const selectEl = fakeEl({ value: 'm2' });
  const retryBtn = fakeEl();
  const backdrop = fakeEl({
    querySelector: (sel) => (sel === '[data-se="model"]' ? selectEl : sel === '[data-se="retry"]' ? retryBtn : null),
  });
  const rootNode = { appendChild(el) { this.child = el; } };
  globalThis.document = {
    getElementById: (id) => (id === 'modal-root' ? rootNode : null),
    createElement: () => backdrop,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };
  let retried = 0;
  try {
    const { showScriptError } = await import('../public/script-error-dialog.js');
    const box = showScriptError({
      message: '模型调用失败',
      models: [{ id: 'm1', name: '模型 A' }, { id: 'm2', name: '模型 <B>' }],
      onRetry: () => { retried += 1; },
    });
    assert.ok(box);
    assert.match(backdrop.innerHTML, /<option value="m1" selected>模型 A<\/option>/);
    assert.match(backdrop.innerHTML, /data-se="model"/);
    assert.match(backdrop.innerHTML, /模型 &lt;B&gt;/, '档案名要转义');
    assert.doesNotMatch(backdrop.innerHTML, /<B>/);
    retryBtn.handlers.click();
    assert.equal(retried, 1, '点「用此模型重试」要触发重试');
    assert.equal(pickedModelId('episode'), 'm2');
    assert.equal(store.get(modelScopeKey('episode', 'prj_dialog')), 'm2');
    assert.equal(backdrop.removed, true, '重试前先关弹窗');
  } finally {
    delete globalThis.document;
    setModelProjectScope('');
    delete globalThis.localStorage;
  }
});

test('模型库为空时选择条仍常驻下拉，刷新后能切换到新档案', async () => {
  const store = new Map();
  globalThis.localStorage = fakeStorage(store);
  setModelProjectScope('prj_bar', '雨夜来信');
  const hadFetch = 'fetch' in globalThis;
  const originalFetch = globalThis.fetch;
  let payload = { models: [], activeModelId: '' };
  globalThis.fetch = async () => ({ ok: true, json: async () => payload });

  const made = [];
  const host = fakeEl();
  globalThis.document = {
    getElementById: () => null,
    createElement: () => { const el = fakeEl(); made.push(el); return el; },
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };
  try {
    const { mountScriptModelBar } = await import('../public/script-model-bar.js');
    const out = await mountScriptModelBar('episode', host, { onSettings: () => {} });
    assert.ok(out?.select, '空库也要返回可操作的下拉');
    const [, sel, state, refreshBtn] = made;
    assert.equal(refreshBtn.dataset.smb, 'refresh');
    assert.equal(sel.disabled, false, '空库也不能禁用下拉');
    assert.match(sel.innerHTML, /内置模板 · 未配置模型/);
    assert.match(state.innerHTML, /未配置文本模型/);

    payload = { models: [{ id: 'm1', name: '模型 A' }, { id: 'm2', name: '模型 B' }], activeModelId: 'm1' };
    refreshBtn.handlers.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.match(sel.innerHTML, /<option value="m1">模型 A · 默认<\/option>/);
    assert.match(sel.innerHTML, /<option value="m2">模型 B<\/option>/);
    assert.match(state.textContent, /跟随默认 · 模型 A/);

    sel.value = 'm2';
    sel.handlers.change();
    assert.equal(pickedModelId('episode'), 'm2', '选择要写入共用记忆');
    assert.equal(host.dataset.modelId, 'm2');
  } finally {
    if (hadFetch) globalThis.fetch = originalFetch; else delete globalThis.fetch;
    delete globalThis.document;
    setModelProjectScope('');
    delete globalThis.localStorage;
  }
});

test('模型列表接口失败会标记 error，恢复后能重新读到档案', async () => {
  const hadFetch = 'fetch' in globalThis;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let offline = true;
  globalThis.fetch = async () => {
    calls += 1;
    if (offline) throw new Error('offline');
    return { ok: true, json: async () => ({ models: [{ id: 'm1', name: '模型 A' }], activeModelId: 'm1' }) };
  };
  try {
    const first = await modelRoster(true);
    assert.equal(first.error, true, '接口失败要与「库里真的没有档案」区分');
    assert.deepEqual(first.models, []);
    offline = false;
    const recovered = await modelRoster(false);
    assert.equal(recovered.error, false, '一次失败不能把空库缓存到整个会话');
    assert.ok(recovered.models.length > 0);
    assert.ok(calls >= 1);
  } finally {
    if (hadFetch) globalThis.fetch = originalFetch; else delete globalThis.fetch;
  }
});
