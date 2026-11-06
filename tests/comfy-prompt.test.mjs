/* ComfyUI 提示词注入回归测试
 * 运行：node --test tests/comfy-prompt.test.mjs
 *
 * 背景：Krea2 / Qwen-Image 这类现代工作流的提示词不在 CLIPTextEncode.text 上，
 * 而是放在 PrimitiveStringMultiline → TextGenerate / Switch → CLIPTextEncode 的
 * 连线链路里。旧实现只认「CLIPTextEncode.text 是字符串」，导致每个镜头都沿用
 * 工作流里写死的提示词，画面高度雷同。本测试锁定「沿图回溯注入」的行为。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-comfy-prompt-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const ROOT = new URL('../', import.meta.url);
const KREA2 = JSON.parse(fs.readFileSync(new URL('examples/workflows/krea2_turbo_t2i_api.json', ROOT), 'utf8'));
const {
  parseWorkflow, injectWorkflow, analyzeWorkflow, describeWorkflow, runWorkflow,
} = await import('../src/core/comfyui.mjs');
const { saveComfyConfig } = await import('../src/core/comfy-config.mjs');
const { handleApi } = await import('../src/api/routes.mjs');

const CFG = { negativePrompt: 'low quality, blurry', width: 864, height: 480 };
const P1 = '雨夜霓虹街头，少女撑伞回望｜中景｜平视｜固定｜cinematic';
const P2 = '清晨竹林，少年持剑而立｜远景｜仰拍｜推镜｜水墨风格';

const classicWF = (pos = 'a cat', neg = 'ugly') => ({
  '3': { class_type: 'KSampler', inputs: { seed: 5, steps: 20, positive: ['6', 0], negative: ['7', 0] } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: pos, clip: ['9', 0] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: neg, clip: ['9', 0] } },
  '9': { class_type: 'CLIPLoader', inputs: { clip_name: 'clip.safetensors' } },
  '8': { class_type: 'SaveImage', inputs: { filename_prefix: 'test' } },
});

/* ---------------- 假 ComfyUI 服务：记录每次提交的 prompt 图 ---------------- */
const submitted = [];
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
  'hex');
let promptSeq = 0;
const comfy = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/prompt') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      submitted.push(JSON.parse(body).prompt);
      const id = `p${++promptSeq}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ prompt_id: id }));
    });
    return;
  }
  if (req.url.startsWith('/history/')) {
    const id = req.url.split('/').pop();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      [id]: {
        status: { status_str: 'success', completed: true },
        outputs: { '29': { images: [{ filename: `${id}.png`, subfolder: '', type: 'output' }] } },
      },
    }));
    return;
  }
  if (req.url.startsWith('/view')) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(PNG);
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((resolve) => comfy.listen(0, '127.0.0.1', resolve));
const comfyCfg = {
  ...CFG,
  baseUrl: `http://127.0.0.1:${comfy.address().port}`,
  pollIntervalMs: 5, timeoutMs: 5000,
};

after(() => {
  comfy.closeAllConnections?.();
  comfy.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/* ---------------- 核心：连线型工作流 ---------------- */
test('Krea2 连线型工作流：提示词写入 User Prompt 源节点，系统提示词 / 触发词不动', () => {
  const wf = parseWorkflow(KREA2);
  const out = injectWorkflow(wf, { prompt: P1, negative: CFG.negativePrompt, seed: 'shot-1', cfg: CFG });

  assert.equal(out.promptInjection.ok, true);
  assert.equal(out.promptInjection.positive.node, '30:19');
  assert.equal(out.promptInjection.positive.input, 'value');
  assert.equal(out.promptInjection.positive.strategy, 'primitive');
  assert.equal(out.prompt['30:19'].inputs.value, P1, '用户提示词源节点被替换');
  assert.equal(out.prompt['30:18'].inputs.value, wf['30:18'].inputs.value, '系统提示词绝不能被覆盖');
  assert.equal(out.prompt['30:27'].inputs.string_b, wf['30:27'].inputs.string_b, 'LoRA 触发词保持不变');
  assert.deepEqual(out.prompt['30:6'].inputs.text, ['30:28', 0], 'CLIPTextEncode 连线保持原样，润色链路仍生效');
  assert.equal(wf['30:19'].inputs.value, KREA2['30:19'].inputs.value, '不修改传入的 workflow');

  assert.notEqual(out.prompt['30:3'].inputs.seed, wf['30:3'].inputs.seed, '采样种子每次随机');
  assert.notEqual(out.prompt['30:16'].inputs['sampling_mode.seed'], 0, '命名空间种子也被打散，避免 ComfyUI 缓存复用');
  assert.match(out.prompt['29'].inputs.filename_prefix, /_\d+$/, '输出前缀带唯一后缀');
});

test('不同镜头提示词 → 提交给 ComfyUI 的 /prompt 载荷逐次不同，固定提示词不再残留', async () => {
  const wf = parseWorkflow(KREA2);
  const logs = [];
  const r1 = await runWorkflow(comfyCfg, wf, { prompt: P1, seed: 'shot-1', cfg: comfyCfg }, {
    log: (lv, msg) => logs.push(`${lv}:${msg}`),
  });
  const r2 = await runWorkflow(comfyCfg, wf, { prompt: P2, seed: 'shot-2', cfg: comfyCfg }, {});

  assert.equal(submitted.length, 2);
  assert.equal(submitted[0]['30:19'].inputs.value, P1);
  assert.equal(submitted[1]['30:19'].inputs.value, P2);
  assert.notDeepEqual(submitted[0], submitted[1], '两次提交的工作流内容不同');
  for (const body of submitted) {
    assert.ok(!JSON.stringify(body).includes('甜酷 Y2K 千禧年风格'), '工作流写死的提示词不得残留');
  }
  assert.ok(r1.primary.url.startsWith('/assets/'), '产物下载到资产目录');
  assert.ok(r2.primary.url.startsWith('/assets/'));
  assert.equal(r1.promptInjection.positive.node, '30:19');
  assert.equal(r2.promptInjection.positive.node, '30:19');
  assert.ok(logs.some((l) => l.includes('提示词 → 30:19.value')), '运行日志回显注入位置');
});

test('describeWorkflow / analyzeWorkflow 能暴露连线型工作流的注入点', () => {
  const wf = parseWorkflow(KREA2);
  const plan = describeWorkflow(wf, { cfg: CFG });
  assert.equal(plan.ok, true);
  assert.equal(plan.positive.node, '30:19');
  assert.ok(plan.samplePrompt.includes('雨夜霓虹'));

  const detected = analyzeWorkflow(wf);
  assert.ok(detected.some((d) => d.node === '30:19' && d.input === 'value' && d.role === 'positive'));
  assert.ok(detected.some((d) => d.node === '30:18' && d.role.startsWith('systemPrompt')));
  assert.ok(detected.some((d) => d.node === '30:16' && d.input === 'sampling_mode.seed'));
});

/* ---------------- 兼容：经典 / 占位符 / 绑定 / 兜底 ---------------- */
test('经典双 CLIPTextEncode：正负提示词分别写入', () => {
  const out = injectWorkflow(classicWF(), { prompt: P1, negative: '模糊', cfg: CFG });
  assert.equal(out.prompt['6'].inputs.text, P1);
  assert.equal(out.prompt['7'].inputs.text, '模糊');
  assert.equal(out.promptInjection.positive.strategy, 'clipText');
  assert.equal(out.promptInjection.negative.strategy, 'clipText');
});

test('{{占位符}} 与显式绑定优先，且不会重复注入到别的节点', () => {
  const ph = injectWorkflow(classicWF('{{prompt}}', '{{negative_prompt}}'), { prompt: P1, negative: '模糊', cfg: CFG });
  assert.equal(ph.prompt['6'].inputs.text, P1);
  assert.equal(ph.prompt['7'].inputs.text, '模糊');
  assert.equal(ph.promptInjection.positive.strategy, 'placeholder');
  assert.equal(ph.applied.filter((a) => /auto:positive/.test(a.by)).length, 0, '占位符已处理，不再自动注入');

  const bd = injectWorkflow(classicWF(), { prompt: P2, negative: '模糊', cfg: CFG },
    [{ node: '6', input: 'text', value: '固定角色设定, {{prompt}}' }]);
  assert.equal(bd.prompt['6'].inputs.text, `固定角色设定, ${P2}`);
  assert.equal(bd.promptInjection.positive.strategy, 'binding');
  assert.equal(bd.applied.filter((a) => /auto:positive/.test(a.by)).length, 0);
});

test('连线但上游没有可写文本 → 兜底把提示词写进 CLIPTextEncode.text', () => {
  const linked = {
    '3': { class_type: 'KSampler', inputs: { seed: 1, positive: ['6', 0], negative: ['7', 0] } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: ['20', 0], clip: ['9', 0] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: ['21', 0], clip: ['9', 0] } },
    '20': { class_type: 'RemoteText', inputs: { url: 'http://127.0.0.1/a' } },
    '21': { class_type: 'RemoteText', inputs: { url: 'http://127.0.0.1/b' } },
    '9': { class_type: 'CLIPLoader', inputs: { clip_name: 'clip.safetensors' } },
  };
  const out = injectWorkflow(linked, { prompt: P1, negative: '模糊', cfg: CFG });
  assert.equal(out.prompt['6'].inputs.text, P1);
  assert.equal(out.prompt['7'].inputs.text, '模糊');
  assert.equal(out.promptInjection.positive.strategy, 'overrideLink');
  assert.ok(out.promptInjection.warnings.some((w) => w.includes('绕过')));
});

test('完全没有文本节点 → 明确告警，不再静默沿用固定提示词', () => {
  const bare = { '1': { class_type: 'SaveImage', inputs: { filename_prefix: 'z' } } };
  const out = injectWorkflow(bare, { prompt: P1, cfg: CFG });
  assert.equal(out.promptInjection.ok, false);
  assert.ok(out.promptInjection.warnings.some((w) => w.includes('同一画面')));
  assert.equal(describeWorkflow(bare, { cfg: CFG }).ok, false);
});

/* ---------------- REST：设置页自检 ---------------- */
async function api(method, pathname, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  const out = { status: 200, data: null };
  const res = {
    setHeader() {}, writeHead(status) { out.status = status; },
    end(chunk) { if (chunk) out.data = JSON.parse(String(chunk)); }, on() {},
  };
  await handleApi(req, res, new URL(pathname, 'http://localhost'));
  return out;
}

test('POST /api/comfyui/inject-check：返回当前生效工作流的提示词注入计划', async () => {
  saveComfyConfig({ imageWorkflow: parseWorkflow(KREA2), videoWorkflow: null, imageWorkflowName: 'Krea2 Turbo' });
  const r = await api('POST', '/api/comfyui/inject-check', {});
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.image.ok, true);
  assert.equal(r.data.image.positive.node, '30:19');
  assert.equal(r.data.image.name, 'Krea2 Turbo');
  assert.equal(r.data.video, null, '未配置视频工作流返回 null');

  const a = await api('POST', '/api/comfyui/analyze', { kind: 'image' });
  assert.equal(a.status, 200);
  assert.equal(a.data.promptInjection.ok, true);
  assert.ok(a.data.detected.some((d) => d.node === '30:19' && d.role === 'positive'));
});
