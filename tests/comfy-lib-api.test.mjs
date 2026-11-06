/* 工作流库 REST API 集成测试（导入 / 切换 / 重命名 / 删除）
 * 运行：node --test tests/comfy-lib-api.test.mjs
 * 用假 req/res 直接驱动 handleApi，不占端口、不依赖真实服务
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-comfy-api-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const { handleApi } = await import('../src/api/routes.mjs');

const FILE = path.join(TMP, 'comfyui.json');
const WF_A = { '1': { class_type: 'SaveImage', inputs: { filename_prefix: 'a' } } };
const WF_B = { '2': { class_type: 'KSampler', inputs: { seed: 7, steps: 20 } } };
const reset = () => fs.rmSync(FILE, { force: true });
const readCfg = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const writeCfgSafe = (obj) => fs.writeFileSync(FILE, JSON.stringify(obj), 'utf8');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** 直接驱动 handleApi：可读流当请求体，普通对象捕获响应 */
async function api(method, pathname, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  const out = { status: 200, data: null };
  const res = {
    setHeader() {},
    writeHead(status) { out.status = status; },
    end(chunk) { if (chunk) out.data = JSON.parse(String(chunk)); },
    on() {},   // test-batch 会挂 res.on('close')，假对象给个空实现
  };
  const handled = await handleApi(req, res, new URL(pathname, 'http://localhost'));
  assert.equal(handled, true, `${method} ${pathname} 应被 handleApi 处理`);
  return out;
}

test('POST /api/comfyui/library 批量导入：合法入库、非法进 failed、去重后缀、即刻落盘', async () => {
  reset();
  const r = await api('POST', '/api/comfyui/library', {
    kind: 'image',
    items: [
      { name: '出图A', workflow: WF_A },
      { name: '界面格式', workflow: { nodes: [], links: [] } },
      { name: '出图B', workflow: WF_B },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.added.length, 2, '合法项入库');
  assert.equal(r.data.failed.length, 1, '非法项不阻断');
  assert.match(r.data.failed[0].error, /导出\(API\)/);
  assert.equal(r.data.summary.imageWorkflowLib.length, 2);
  assert.equal(r.data.summary.imageWorkflowLib[0].workflow, undefined, '概览不回传本体');
  assert.equal(r.data.config.imageWorkflowLib.length, 2);
  assert.equal(readCfg().imageWorkflowLib.length, 2, '导入即落盘');
  assert.equal(readCfg().imageWorkflow, null, '导入不自动选中');

  const dup = await api('POST', '/api/comfyui/library', { kind: 'image', items: [{ name: '出图A', workflow: WF_A }] });
  assert.equal(dup.data.added.length, 0);
  assert.match(dup.data.failed[0].error, /已存在/, '同名同内容跳过');

  const suffix = await api('POST', '/api/comfyui/library', { kind: 'image', items: [{ name: '出图A', workflow: WF_B }] });
  assert.equal(suffix.data.added[0].name, '出图A (2)', '同名不同内容加后缀');

  const empty = await api('POST', '/api/comfyui/library', { kind: 'image', items: [] });
  assert.equal(empty.status, 400, '空导入 400');
});

test('PUT /api/comfyui/library：切换选中回填镜像；带 name 重命名且不改变选中', async () => {
  reset();
  const post = await api('POST', '/api/comfyui/library', {
    kind: 'video', items: [{ name: 'V1', workflow: WF_A }, { name: 'V2', workflow: WF_B }],
  });
  const [one, two] = post.data.added;

  // 切换选中
  const pick = await api('PUT', '/api/comfyui/library', { kind: 'video', id: two.id });
  assert.equal(pick.status, 200);
  assert.equal(pick.data.ok, true);
  assert.deepEqual(pick.data.config.videoWorkflow, WF_B, '镜像回填');
  assert.equal(pick.data.config.videoWorkflowName, 'V2');
  assert.deepEqual(readCfg().videoWorkflow, WF_B, '镜像落盘');
  assert.equal(readCfg().videoActiveId, two.id);

  // 重命名非选中项：名字变、选中与镜像都不变
  const rn = await api('PUT', '/api/comfyui/library', { kind: 'video', id: one.id, name: 'V1 改名' });
  const rnEntry = rn.data.config.videoWorkflowLib.find((e) => e.id === one.id);
  assert.equal(rnEntry.name, 'V1 改名');
  assert.equal(rn.data.config.videoActiveId, two.id, '重命名不改变选中');
  assert.equal(rn.data.config.videoWorkflowName, 'V2', '镜像名不受影响');

  // 重命名选中项：镜像名同步
  const rnActive = await api('PUT', '/api/comfyui/library', { kind: 'video', id: two.id, name: 'V2 改' });
  assert.equal(rnActive.data.config.videoWorkflowName, 'V2 改');
  assert.deepEqual(rnActive.data.config.videoWorkflow, WF_B, '选中与镜像内容不变');
  assert.equal(rnActive.data.config.videoActiveId, two.id);

  // 重命名不存在的项 → 404
  const ghost = await api('PUT', '/api/comfyui/library', { kind: 'video', id: 'ghost', name: 'x' });
  assert.equal(ghost.status, 404);

  // 切回第一个
  const back = await api('PUT', '/api/comfyui/library', { kind: 'video', id: one.id });
  assert.deepEqual(back.data.config.videoWorkflow, WF_A);
  assert.equal(back.data.config.videoWorkflowName, 'V1 改名');
});

test('DELETE /api/comfyui/library/:kind/:id：删选中项清镜像、删非选中项保留、不存在 404', async () => {
  reset();
  const post = await api('POST', '/api/comfyui/library', {
    kind: 'image', items: [{ name: 'A', workflow: WF_A }, { name: 'B', workflow: WF_B }],
  });
  const [a, b] = post.data.added;
  await api('PUT', '/api/comfyui/library', { kind: 'image', id: a.id });

  const delOther = await api('DELETE', `/api/comfyui/library/image/${b.id}`);
  assert.equal(delOther.status, 200);
  assert.deepEqual(delOther.data.config.imageWorkflow, WF_A, '非选中项删除镜像不动');
  assert.equal(delOther.data.config.imageWorkflowLib.length, 1);

  const missing = await api('DELETE', '/api/comfyui/library/image/ghost');
  assert.equal(missing.status, 404);

  const delActive = await api('DELETE', `/api/comfyui/library/image/${a.id}`);
  assert.equal(delActive.status, 200);
  assert.equal(delActive.data.config.imageWorkflow, null, '删选中项 → 镜像清空回退 Mock');
  assert.equal(delActive.data.config.imageActiveId, null);
  const disk = readCfg();
  assert.equal(disk.imageWorkflow, null);
  assert.equal(disk.imageWorkflowLib.length, 0, '已落盘');
});

/** 假 ComfyUI：/system_stats、/prompt（工作流含 MockFail 节点即 400）、/history、/view */
function startMockComfy() {
  const state = { prompts: 0, inFlight: 0, violations: 0, order: [] };
  const server = http.createServer((req, res) => {
    const send = (obj, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/system_stats') {
      return send({ system: { comfyui_version: 'mock' }, devices: [{ name: 'mock-gpu', vram_total: 1 }] });
    }
    if (url.pathname === '/prompt') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        const types = Object.values(body.prompt || {}).map((n) => n.class_type);
        state.order.push(types.join(','));
        if (state.inFlight > 0) state.violations += 1;   // 上一条没完成又提交 → 违反串行
        state.inFlight += 1;
        state.prompts += 1;
        if (types.includes('MockFail')) { state.inFlight -= 1; return send({ error: '模拟失败' }, 400); }
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

test('POST /api/comfyui/test-batch：先探测连接、串行试跑、逐项 lastTest 落盘', async () => {
  reset();
  const { server, state, baseUrl } = await startMockComfy();
  try {
    writeCfgSafe({
      baseUrl,
      imageWorkflowLib: [
        { id: 'ok1', name: '成功流', workflow: WF_A, createdAt: 1, lastTest: null },
        { id: 'bad1', name: '失败流', workflow: { '9': { class_type: 'MockFail', inputs: {} } }, createdAt: 1, lastTest: null },
      ],
    });
    const r = await api('POST', '/api/comfyui/test-batch', { kind: 'image', ids: ['ok1', 'bad1'] });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.results.length, 2);
    assert.equal(r.data.results[0].ok, true);
    assert.equal(r.data.results[0].error, null);
    assert.ok(r.data.results[0].durationMs >= 0);
    assert.equal(r.data.results[1].ok, false);
    assert.match(r.data.results[1].error, /模拟失败/);
    assert.equal(state.violations, 0, '必须串行，不并发抢 ComfyUI 队列');
    assert.match(state.order[0], /SaveImage/, '按 ids 顺序先跑第一项');
    assert.match(state.order[1], /MockFail/);
    const saved = readCfg();
    assert.equal(saved.imageWorkflowLib[0].lastTest.ok, true, '成功项徽标落盘');
    assert.ok(saved.imageWorkflowLib[0].lastTest.durationMs >= 0);
    assert.equal(saved.imageWorkflowLib[1].lastTest.ok, false);
    assert.match(saved.imageWorkflowLib[1].lastTest.error, /模拟失败/);
    assert.equal(r.data.summary.imageWorkflowLib[0].lastTest.ok, true, '响应概览同步');
  } finally {
    await new Promise((res) => server.close(res));
  }
});

test('POST /api/comfyui/test-batch：无匹配 id → 400；ComfyUI 连不上 → 整批 connectionError', async () => {
  reset();
  const none = await api('POST', '/api/comfyui/test-batch', { kind: 'image', ids: ['ghost'] });
  assert.equal(none.status, 400);

  // 先占一个端口再关掉，得到一个必然拒绝连接的地址
  const closed = http.createServer();
  await new Promise((res) => closed.listen(0, '127.0.0.1', res));
  const deadPort = closed.address().port;
  await new Promise((res) => closed.close(res));
  writeCfgSafe({
    baseUrl: `http://127.0.0.1:${deadPort}`,
    imageWorkflowLib: [{ id: 'x', name: 'X', workflow: WF_A, createdAt: 1, lastTest: null }],
  });
  const r = await api('POST', '/api/comfyui/test-batch', { kind: 'image', ids: ['x'] });
  assert.equal(r.data.ok, false);
  assert.match(r.data.connectionError, /无法连接/, '连不上整批返回，不逐项空等超时');
  assert.deepEqual(r.data.results, []);
  assert.equal(readCfg().imageWorkflowLib[0].lastTest, null, '没试跑不写 lastTest');
});
