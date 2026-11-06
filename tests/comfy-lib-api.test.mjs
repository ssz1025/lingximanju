/* 工作流库 REST API 集成测试（导入 / 切换 / 重命名 / 删除）
 * 运行：node --test tests/comfy-lib-api.test.mjs
 * 用假 req/res 直接驱动 handleApi，不占端口、不依赖真实服务
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
