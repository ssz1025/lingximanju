/* 媒体生成接口档案 + 板块绑定：配置迁移 / 解析优先级 / 参数注入 / REST API 回归测试
 * 运行：node --test tests/comfy-interfaces.test.mjs
 * 用临时 data 目录 + 假 req/res 驱动 handleApi，不占端口、不依赖真实 ComfyUI。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-interfaces-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const CFG = await import('../src/core/comfy-config.mjs');
const { injectWorkflow } = await import('../src/core/comfyui.mjs');
const { handleApi } = await import('../src/api/routes.mjs');

const FILE = path.join(TMP, 'comfyui.json');
const reset = () => fs.rmSync(FILE, { force: true });
const readCfg = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

const WF_A = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'old.safetensors' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
  '3': { class_type: 'SaveImage', inputs: { filename_prefix: 'a', images: ['2', 0] } },
};
const WF_B = {
  '4': { class_type: 'LoadImage', inputs: { image: 'ref.png' } },
  '5': { class_type: 'SaveImage', inputs: { filename_prefix: 'b', images: ['4', 0] } },
};
const AUDIO_WF = {
  '6': { class_type: 'SaveAudioMP3', inputs: { filename_prefix: 'v', audio: ['7', 0] } },
  '7': { class_type: 'TTS', inputs: { text: '{{audioText}}', voice: 'male-qn-qingse' } },
};

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
    on() {},
  };
  const handled = await handleApi(req, res, new URL(pathname, 'http://localhost'));
  assert.equal(handled, true, `${method} ${pathname} 应被 handleApi 处理`);
  return out;
}

/** 一份含两份出图接口 + 板块绑定的完整配置（纯对象，不落盘） */
function baseCfg(overrides = {}) {
  return {
    enabled: true, baseUrl: 'http://127.0.0.1:8188',
    width: 864, height: 480, fps: 24, frames: 124, steps: 25, cfg: 1.0,
    negativePrompt: '全局负向词',
    imageWorkflowLib: [
      {
        id: 'wf_a', name: '文生图A', workflow: WF_A, createdAt: 1, lastTest: null,
        params: { model: 'flux-dev', width: 1024, steps: 30, extra: { lora: 'filmGrain' } },
        nodeOverrides: [{ node: '1', input: 'ckpt_name', value: '{{model}}' }],
        bindings: [], capability: '文生图',
      },
      {
        id: 'wf_b', name: '图生图B', workflow: WF_B, createdAt: 2, lastTest: null,
        params: { width: 768, negativePrompt: '档案B负向词' },
        nodeOverrides: [], bindings: [], capability: '图生图',
      },
    ],
    videoWorkflowLib: [], audioWorkflowLib: [],
    imageActiveId: 'wf_a', videoActiveId: null, audioActiveId: null,
    imageWorkflow: WF_A, imageWorkflowName: '文生图A',
    bindings: { image: [{ node: '2', input: 'text', value: '{{prompt}}' }], video: [], audio: [] },
    scopeBindings: { cover: 'wf_b' },
    ...overrides,
  };
}

test('老配置迁移：库项补空参数、工作流与镜像不丢，归一化幂等', () => {
  reset();
  fs.writeFileSync(FILE, JSON.stringify({
    baseUrl: 'http://127.0.0.1:8188',
    imageWorkflow: WF_A, imageWorkflowName: '老工作流',
    imageWorkflowLib: [{ id: 'wf_old', name: '老工作流', workflow: WF_A, createdAt: 1, lastTest: null }],
  }));
  const cfg = CFG.loadComfyConfig();
  assert.equal(cfg.imageWorkflowLib.length, 1);
  assert.deepEqual(cfg.imageWorkflowLib[0].params, {}, '老库项补空参数');
  assert.deepEqual(cfg.imageWorkflowLib[0].nodeOverrides, []);
  assert.deepEqual(cfg.imageWorkflowLib[0].workflow, WF_A, '工作流本体不丢');
  assert.deepEqual(cfg.imageWorkflow, WF_A, '镜像不丢');
  assert.deepEqual(cfg.scopeBindings, {});
  const again = CFG.saveComfyConfig({});
  assert.deepEqual(again.imageWorkflowLib, cfg.imageWorkflowLib, '二次归一幂等');
  assert.deepEqual(readCfg().imageWorkflowLib, cfg.imageWorkflowLib, '落盘结果一致');
});

test('resolveInterface 优先级：本次指定 > 板块绑定 > activeId > 镜像，非法 id 回退并告警', () => {
  const cfg = baseCfg();
  const byScope = CFG.resolveInterface(cfg, { kind: 'image', scope: 'cover' });
  assert.equal(byScope.interfaceId, 'wf_b');
  assert.equal(byScope.via, 'scope');
  assert.equal(byScope.config.width, 768, '档案参数覆盖全局');
  assert.equal(byScope.config.negativePrompt, '档案B负向词');

  const byRequest = CFG.resolveInterface(cfg, { kind: 'image', scope: 'cover', interfaceId: 'wf_a' });
  assert.equal(byRequest.interfaceId, 'wf_a');
  assert.equal(byRequest.via, 'request');
  assert.equal(byRequest.config.model, 'flux-dev');

  const byActive = CFG.resolveInterface(cfg, { kind: 'image', scope: 'keyframe' });
  assert.equal(byActive.interfaceId, 'wf_a');
  assert.equal(byActive.via, 'active');

  const bad = CFG.resolveInterface(cfg, { kind: 'image', scope: 'keyframe', interfaceId: 'missing' });
  assert.equal(bad.interfaceId, 'wf_a', '非法 id 回退默认接口');
  assert.match(bad.warnings[0], /不存在/);

  const mirror = CFG.resolveInterface({
    ...cfg, imageWorkflowLib: [], imageActiveId: null, scopeBindings: {},
  }, { kind: 'image', scope: 'keyframe' });
  assert.equal(mirror.via, 'mirror');
  assert.deepEqual(mirror.workflow, WF_A);

  const none = CFG.resolveInterface({ ...cfg, imageWorkflow: null, imageWorkflowLib: [], imageActiveId: null }, { kind: 'image' });
  assert.equal(none.workflow, null);
});

test('档案自带 bindings 优先于全局 bindings；板块绑定按类别校验', () => {
  const cfg = baseCfg({
    imageWorkflowLib: baseCfg().imageWorkflowLib.map((e) => (e.id === 'wf_b'
      ? { ...e, bindings: [{ node: '4', input: 'image', value: 'myref.png' }] } : e)),
  });
  const r = CFG.resolveInterface(cfg, { kind: 'image', scope: 'cover' });
  assert.deepEqual(r.bindings, [{ node: '4', input: 'image', value: 'myref.png' }]);
  assert.equal(CFG.scopeKind('voice'), 'audio');
  assert.equal(CFG.scopeKind('cover'), 'image');
  assert.equal(CFG.scopeKind('unknown'), 'image');
  assert.equal(CFG.hasWorkflowFor(cfg, 'image'), true);
  assert.equal(CFG.hasWorkflowFor(cfg, 'audio'), false);
});

test('resolveComfyConfig：档案参数优先于项目自动规格，留空才按画幅推断', () => {
  const project = { settings: { aspect: '16:9' }, management: { runtime: { width: 1920, height: 1080 } } };
  const cfg = baseCfg();
  const bound = CFG.resolveComfyConfig(project, cfg, { scope: 'cover' });
  assert.equal(bound.width, 768, '封面绑定的档案 B 用自己 768');
  assert.equal(bound.resolvedInterface.id, 'wf_b');

  const active = CFG.resolveComfyConfig(project, { ...cfg, scopeBindings: {} }, { scope: 'cover' });
  assert.equal(active.width, 1024, '未绑定时按 activeId 档案 A');

  const noParams = baseCfg({
    scopeBindings: {},
    imageWorkflowLib: baseCfg().imageWorkflowLib.map((e) => (e.id === 'wf_a' ? { ...e, params: {} } : e)),
  });
  const auto = CFG.resolveComfyConfig(project, noParams, { scope: 'cover' });
  assert.equal(auto.width, 1920, '档案没填宽高时用项目成片规格');
  assert.equal(auto.height, 1080);
  assert.equal(auto.steps, 25);

  const legacy = CFG.resolveComfyConfig(project, cfg);
  assert.equal(legacy.resolvedInterface, undefined, '不传 opts 时旧调用点零变化');
  assert.equal(legacy.width, 1920);
});

test('注入层：档案参数 / 自定义占位符 / 节点覆盖都进入工作流', () => {
  const cfg = baseCfg();
  const r = CFG.resolveInterface(cfg, { kind: 'image', interfaceId: 'wf_a' });
  const out = injectWorkflow(r.workflow, { prompt: '雨夜霓虹街头', cfg: r.config }, r.bindings);
  assert.equal(out.prompt['1'].inputs.ckpt_name, 'flux-dev', '节点覆盖把模型名写进 ckpt_name');
  assert.equal(out.prompt['2'].inputs.text, '雨夜霓虹街头');
  assert.equal(out.values.lora, 'filmGrain', 'extra 里的自定义占位符可用');
  assert.equal(out.values.width, 1024);
  assert.equal(out.values.steps, 30);
  assert.ok(out.applied.some((a) => a.by === 'interface:nodeOverride'));

  // 档案 B 没有节点覆盖，注入结果与 A 完全不同（板块选择确实生效）
  const rb = CFG.resolveInterface(cfg, { kind: 'image', scope: 'cover' });
  const outB = injectWorkflow(rb.workflow, { prompt: '雨夜霓虹街头', cfg: rb.config }, rb.bindings);
  assert.equal(outB.values.width, 768);
  assert.equal(outB.values.negative_prompt, '档案B负向词');
  assert.equal(outB.prompt['4'].inputs.image, 'ref.png');
});

test('REST：导入带参数的接口文件 → 绑定板块 → 概览 → 局部改参数 → 解绑删除', async () => {
  reset();
  const imp = await api('POST', '/api/comfyui/interfaces', {
    kind: 'image', name: '文生图A', workflow: WF_A, capability: '文生图',
    params: { width: 1024, steps: 30, model: 'flux' },
    nodeOverrides: [{ node: '1', input: 'ckpt_name', value: '{{model}}' }],
  });
  assert.equal(imp.status, 200);
  assert.equal(imp.data.added.length, 1);
  const id = imp.data.added[0].id;
  assert.equal(readCfg().imageWorkflowLib[0].params.width, 1024);

  const audio = await api('POST', '/api/comfyui/interfaces', {
    kind: 'audio', name: 'TTS', workflow: AUDIO_WF, capability: 'TTS',
  });
  const audioId = audio.data.added[0].id;

  const bind = await api('PUT', '/api/comfyui/bindings', { bindings: { cover: id, voice: audioId } });
  assert.equal(bind.status, 200);
  assert.deepEqual(bind.data.scopeBindings, { cover: id, voice: audioId });

  const wrongKind = await api('PUT', '/api/comfyui/bindings', { bindings: { voice: id } });
  assert.equal(wrongKind.status, 400);
  const missing = await api('PUT', '/api/comfyui/bindings', { bindings: { cover: 'wf_nope' } });
  assert.equal(missing.status, 404);

  const list = await api('GET', '/api/comfyui/interfaces');
  assert.equal(list.data.interfaces.length, 2);
  assert.equal(list.data.scopes.length, 12, '新增 character-front 正面基准图板块');
  assert.ok(list.data.scopes.some((s) => s.id === 'character-front' && s.kind === 'image'));
  assert.equal(list.data.interfaces[0].workflow, undefined, '概览不回传工作流本体');
  assert.deepEqual(list.data.interfaces.find((i) => i.id === id).boundScopes, ['cover']);

  const update = await api('PUT', `/api/comfyui/interfaces/${id}`, {
    params: { width: 768, extra: { lora: 'filmGrain' } }, capability: '图生图',
  });
  assert.equal(update.status, 200);
  const saved = readCfg().imageWorkflowLib.find((e) => e.id === id);
  assert.equal(saved.params.width, 768);
  assert.equal(saved.params.model, 'flux', '未提交字段保持原值');
  assert.equal(saved.params.steps, 30);
  assert.deepEqual(saved.params.extra, { lora: 'filmGrain' });
  assert.equal(saved.capability, '图生图');

  const clear = await api('PUT', `/api/comfyui/interfaces/${id}`, { params: { model: null } });
  assert.equal(clear.status, 200);
  assert.equal(readCfg().imageWorkflowLib.find((e) => e.id === id).params.model, undefined);

  const single = await api('PUT', '/api/comfyui/bindings', { scope: 'cover', interfaceId: null });
  assert.equal(single.data.scopeBindings.cover, undefined, '单条解绑');

  const del = await api('DELETE', `/api/comfyui/interfaces/${audioId}`);
  assert.equal(del.status, 200);
  assert.equal(del.data.config.scopeBindings.voice, undefined, '删档案自动解绑板块');
  assert.equal(del.data.config.audioWorkflowLib.length, 0);

  const gone = await api('PUT', `/api/comfyui/interfaces/${audioId}`, { name: 'x' });
  assert.equal(gone.status, 404);
});

test('导演包：按板块绑定导出实际接口文件，manifest 记录来源', async () => {
  const { buildDirectorPack } = await import('../src/core/director-pack.mjs');
  const { buildNovelProject } = await import('../src/pipelines/novel-project.mjs');
  const { project } = buildNovelProject({ name: '接口导演包' });
  const cfg = baseCfg({ scopeBindings: { cover: 'wf_b', keyframe: 'wf_a' } });

  const built = buildDirectorPack(project, cfg);
  const raw = built.buffer.toString('latin1');
  assert.ok(raw.includes('extra/comfyui_image_workflow_api.json'), '通用入口文件名保持兼容');
  const coverFile = built.meta.interfaces.find((f) => f.scope === 'cover')?.file;
  assert.equal(coverFile, 'extra/comfyui_scope_cover_workflow_api.json');
  assert.ok(raw.includes(coverFile), '绑定的板块额外导出一份');
  assert.equal(built.meta.interfaces.find((f) => f.scope === 'cover')?.interfaceId, 'wf_b');
  assert.equal(built.meta.interfaces.find((f) => f.file === 'extra/comfyui_image_workflow_api.json')?.interfaceId, 'wf_a');

  const generic = buildDirectorPack(project, { ...cfg, packTarget: 'generic' });
  const rawGeneric = generic.buffer.toString('latin1');
  assert.ok(rawGeneric.includes('workflows/image_api.json'));
  assert.ok(rawGeneric.includes('workflows/scope_cover_api.json'));
});

test('请求级 interfaceId 端到端：本次指定 > 板块绑定，档案参数与节点覆盖一起提交', async () => {
  const http = await import('node:http');
  const { createProviders } = await import('../src/core/providers.mjs');
  const submitted = [];
  let seq = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/upload/image') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const m = /filename="([^"]+)"/.exec(Buffer.concat(chunks).toString('latin1'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: m?.[1] || 'ref.png', subfolder: '', type: 'input' }));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/prompt') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        submitted.push(JSON.parse(body).prompt);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ prompt_id: `p${++seq}` }));
      });
      return;
    }
    if (req.url.startsWith('/history/')) {
      const id = req.url.split('/').pop();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ [id]: {
        status: { status_str: 'success', completed: true },
        outputs: { '3': { images: [{ filename: `${id}.png`, subfolder: '', type: 'output' }] } },
      } }));
      return;
    }
    if (req.url.startsWith('/view')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const cfg = {
      ...baseCfg(),
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      pollIntervalMs: 5, timeoutMs: 5000, strict: true, enabled: true,
      // 封面板块绑定的是 WF_B，这里请求级指定 WF_A：应优先用 A
      requestInterfaceId: 'wf_a',
    };
    const providers = createProviders({ comfy: cfg }, () => {});
    const out = await providers.image({ kind: 'cover', prompt: '雨夜霓虹', requireReal: true });
    assert.equal(out.provider, 'comfyui');
    assert.equal(out.interfaceId, 'wf_a', '请求级覆盖板块绑定');
    assert.equal(out.scope, 'cover');
    assert.equal(out.width, 1024, '档案自带的宽高进入运行结果');
    assert.equal(submitted.length, 1);
    assert.ok(submitted[0]['1'], '提交的是 WF_A 的 CheckpointLoaderSimple 节点');
    assert.equal(submitted[0]['1'].inputs.ckpt_name, 'flux-dev', '节点覆盖把模型名写进工作流');
    assert.equal(submitted[0]['2'].inputs.text.includes('雨夜霓虹'), true, '提示词注入成功');

    // 单次调用显式 interfaceId 又高于 cfg.requestInterfaceId
    const outB = await providers.image({ kind: 'cover', prompt: '雨夜霓虹', requireReal: true, interfaceId: 'wf_b' });
    assert.equal(outB.interfaceId, 'wf_b');
    assert.equal(outB.width, 768);
    assert.ok(submitted[1]['4'], '第二次提交的是 WF_B 的 LoadImage 节点');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('兼容：旧 /library 导入与 /config 概览仍可用，且带出接口档案信息', async () => {
  reset();
  const lib = await api('POST', '/api/comfyui/library', { kind: 'image', items: [{ name: '旧入口', workflow: WF_A }] });
  assert.equal(lib.data.added.length, 1);
  assert.equal(lib.data.summary.imageWorkflowLib.length, 1);
  assert.ok(Array.isArray(lib.data.summary.interfaces), '旧接口概览也带出 interfaces');
  const cfg = await api('GET', '/api/comfyui/config');
  assert.deepEqual(cfg.data.config.scopeBindings, {});
  assert.equal(cfg.data.config.imageWorkflowLib[0].params === undefined, false, '旧入口也补空参数');
});
