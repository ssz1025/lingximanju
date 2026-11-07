/* 每个工作流「独立测试」API 集成测试
 * 运行：node --test tests/comfy-test-one.test.mjs
 * 用假 req/res 直接驱动 handleApi + 本地假 ComfyUI，不占固定端口、不依赖真实服务
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-comfy-one-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;
const { handleApi } = await import('../src/api/routes.mjs');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const FILE = path.join(TMP, 'comfyui.json');
const WF_OK = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
  '2': { class_type: 'SaveImage', inputs: { filename_prefix: 'one' } },
};
const WF_OTHER = { '3': { class_type: 'SaveImage', inputs: { filename_prefix: 'other' } } };
const WF_FAIL = { '9': { class_type: 'MockFail', inputs: {} } };

const reset = () => fs.rmSync(FILE, { force: true });
const readCfg = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const writeCfg = (obj) => fs.writeFileSync(FILE, JSON.stringify(obj), 'utf8');
const entry = (id, name, workflow) => ({ id, name, workflow, createdAt: 1, lastTest: null });
const closeServer = (server) => new Promise((res) => server.close(res));

/** 直接驱动 handleApi：可读流当请求体，普通对象捕获响应 */
async function api(method, pathname, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  const out = { status: 200, data: null };
  const res = {
    setHeader() {},
    writeHead(status) { out.status = status; },
    end(chunk) { if (chunk) out.data = JSON.parse(String(chunk)); },
    on() {},   // 试跑会挂 res.on('close')，假对象给个空实现
  };
  const handled = await handleApi(req, res, new URL(pathname, 'http://localhost'));
  assert.equal(handled, true, `${method} ${pathname} 应被 handleApi 处理`);
  return out;
}

/** 假 ComfyUI：记录每次 /prompt 提交的节点与文本，返回一张 PNG 产物 */
function startMockComfy() {
  const state = { prompts: 0, inFlight: 0, violations: 0, types: [], texts: [] };
  const server = http.createServer((req, res) => {
    const send = (obj, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/system_stats') {
      return send({ system: { comfyui_version: 'mock' }, devices: [{ name: 'mock-gpu' }] });
    }
    if (url.pathname === '/prompt') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        const nodes = Object.values(body.prompt || {});
        state.types.push(nodes.map((n) => n.class_type).join(','));
        state.texts.push(nodes.map((n) => JSON.stringify(n.inputs || {})).join(' '));
        if (state.inFlight > 0) state.violations += 1;
        state.inFlight += 1;
        state.prompts += 1;
        if (state.types.at(-1).includes('MockFail')) { state.inFlight -= 1; return send({ error: '模拟失败' }, 400); }
        send({ prompt_id: `p${state.prompts}` });
      });
      return;
    }
    const m = url.pathname.match(/^\/history\/(\w+)$/);
    if (m) {
      state.inFlight -= 1;
      return send({
        [m[1]]: {
          outputs: { out: { images: [{ filename: 't.png', subfolder: '', type: 'output' }] } },
          status: { status_str: 'success' },
        },
      });
    }
    if (url.pathname === '/view') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64)]));
    }
    send({ error: 'not found' }, 404);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('POST /api/comfyui/test-one：只跑指定库项，写回该行 lastTest，返回产物与注入详情', async () => {
  reset();
  const { server, state, baseUrl } = await startMockComfy();
  try {
    writeCfg({ baseUrl, imageWorkflowLib: [entry('one', '单独测', WF_OK), entry('two', '不参与', WF_OTHER)] });
    const r = await api('POST', '/api/comfyui/test-one', { kind: 'image', id: 'one' });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.results.length, 1);
    assert.equal(state.prompts, 1, '只提交一次，不碰其它库项');
    assert.match(state.types[0], /CLIPTextEncode/, '跑的是指定工作流');

    const result = r.data.result;
    assert.equal(result.id, 'one');
    assert.equal(result.name, '单独测');
    assert.equal(result.ok, true);
    assert.ok(result.promptId, '返回 prompt_id 供面板展示');
    assert.equal(result.assets.length, 1);
    assert.match(result.assets[0].url, /^\/assets\//, '产物 URL 可直接预览');
    assert.equal(result.assets[0].kind, 'image');
    assert.equal(result.promptInjection.ok, true);
    assert.equal(result.promptInjection.positive.node, '1');
    assert.equal(result.promptInjection.positive.input, 'text');
    assert.ok(result.promptInjection.positive.strategy);
    assert.ok(result.applied >= 1);

    const saved = readCfg();
    assert.equal(saved.imageWorkflowLib[0].lastTest.ok, true, '只写该行徽标');
    assert.equal(saved.imageWorkflowLib[1].lastTest, null, '其它库项状态不受影响');
    assert.equal(r.data.summary.imageWorkflowLib[0].lastTest.ok, true, '响应概览同步');
    assert.equal(r.data.config.imageWorkflowLib[0].lastTest.ok, true);
  } finally {
    await closeServer(server);
  }
});

test('POST /api/comfyui/test-one：失败项返回可读错误并只写该行；支持自定义测试提示词', async () => {
  reset();
  const { server, state, baseUrl } = await startMockComfy();
  try {
    writeCfg({ baseUrl, imageWorkflowLib: [entry('bad', '失败流', WF_FAIL), entry('one', '正常流', WF_OK)] });

    const bad = await api('POST', '/api/comfyui/test-one', { kind: 'image', id: 'bad' });
    assert.equal(bad.status, 200);
    assert.equal(bad.data.result.ok, false);
    assert.match(bad.data.result.error, /模拟失败/);
    assert.equal(bad.data.result.assets, undefined, '失败项没有产物详情');
    assert.equal(readCfg().imageWorkflowLib[0].lastTest.ok, false);
    assert.equal(readCfg().imageWorkflowLib[1].lastTest, null);

    const custom = await api('POST', '/api/comfyui/test-one', {
      kind: 'image', id: 'one', prompt: '独一无二的测试提示词 ABC',
    });
    assert.equal(custom.data.result.ok, true);
    assert.match(state.texts.at(-1), /独一无二的测试提示词 ABC/, '自定义提示词确实写进工作流');
    assert.equal(state.prompts, 2, '两次单测互不干扰');
  } finally {
    await closeServer(server);
  }
});

test('POST /api/comfyui/test-one：库项不存在 404；缺 id 400 级错误不落盘', async () => {
  reset();
  const { server, state, baseUrl } = await startMockComfy();
  try {
    writeCfg({ baseUrl, imageWorkflowLib: [entry('one', '正常流', WF_OK)] });
    const ghost = await api('POST', '/api/comfyui/test-one', { kind: 'image', id: 'ghost' });
    assert.equal(ghost.status, 404);
    assert.match(ghost.data.error, /库项不存在/);
    const noId = await api('POST', '/api/comfyui/test-one', { kind: 'image' });
    assert.equal(noId.status, 404);
    const wrongKind = await api('POST', '/api/comfyui/test-one', { kind: 'video', id: 'one' });
    assert.equal(wrongKind.status, 404, '图片库项不能用 video 去测');
    assert.equal(state.prompts, 0, '非法请求不触发 ComfyUI');
    assert.equal(readCfg().imageWorkflowLib[0].lastTest, null);
  } finally {
    await closeServer(server);
  }
});

test('POST /api/comfyui/test-one：ComfyUI 连不上返回 connectionError，不写 lastTest', async () => {
  reset();
  const closed = http.createServer();
  await new Promise((res) => closed.listen(0, '127.0.0.1', res));
  const deadPort = closed.address().port;
  await closeServer(closed);
  writeCfg({
    baseUrl: `http://127.0.0.1:${deadPort}`,
    imageWorkflowLib: [entry('one', '正常流', WF_OK)],
  });
  const r = await api('POST', '/api/comfyui/test-one', { kind: 'image', id: 'one' });
  assert.equal(r.data.ok, false);
  assert.match(r.data.connectionError, /无法连接/);
  assert.deepEqual(r.data.results, []);
  assert.equal(readCfg().imageWorkflowLib[0].lastTest, null, '没试跑不改徽标');
});

test('POST /api/comfyui/test-batch：回归——仍串行试跑全部，结果带详情字段', async () => {
  reset();
  const { server, state, baseUrl } = await startMockComfy();
  try {
    writeCfg({ baseUrl, imageWorkflowLib: [entry('one', '正常流', WF_OK), entry('two', '另一条', WF_OTHER)] });
    const r = await api('POST', '/api/comfyui/test-batch', { kind: 'image', ids: ['one', 'two'] });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.results.length, 2);
    assert.equal(r.data.result, undefined, '批量接口不返回单项 result');
    assert.equal(state.violations, 0, '必须串行');
    assert.equal(state.prompts, 2);
    assert.ok(r.data.results[0].promptId, '批量结果也带详情');
    assert.ok(r.data.results[0].promptInjection);
    assert.equal(readCfg().imageWorkflowLib[0].lastTest.ok, true);
    assert.equal(readCfg().imageWorkflowLib[1].lastTest.ok, true);

    const none = await api('POST', '/api/comfyui/test-batch', { kind: 'image', ids: ['ghost'] });
    assert.equal(none.status, 400);
  } finally {
    await closeServer(server);
  }
});
