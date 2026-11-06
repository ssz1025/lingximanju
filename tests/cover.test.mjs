/* 封面功能测试：AI 生成封面提示词（coverPrompt intent + /cover/prompt）+ 多参考图生成封面
 * 运行：node --test tests/cover.test.mjs
 *
 * 两条能力线：
 * 1. 提示词：调用已配置的 LLM，按项目名 / 简介 / 小说摘要产出可编辑的文生图提示词；
 *    零 Key / LLM 失败时回退确定性模板，响应里明示来源。
 * 2. 参考图：可从资源库 / 本地选多张参考图，按顺序对应工作流的多个 LoadImage 插槽；
 *    单张参考图沿用旧行为（应用到全部插槽，兼容首尾帧同图的视频工作流）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-cover-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const { saveProject, writeAssetBinary } = await import('../src/core/store.mjs');
const { createProviders } = await import('../src/core/providers.mjs');
const { parseWorkflow, runWorkflow } = await import('../src/core/comfyui.mjs');
const { saveComfyConfig } = await import('../src/core/comfy-config.mjs');
const { handleApi } = await import('../src/api/routes.mjs');

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
  'hex');

/** 双 LoadImage 插槽的最小出图工作流（经典双 CLIP 文本，方便断言注入结果） */
const multiSlotWF = () => ({
  '3': { class_type: 'KSampler', inputs: { seed: 5, steps: 20, positive: ['6', 0], negative: ['7', 0], latent_image: ['12', 0] } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'fixed positive', clip: ['9', 0] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'fixed negative', clip: ['9', 0] } },
  '9': { class_type: 'CLIPLoader', inputs: { clip_name: 'clip.safetensors' } },
  '10': { class_type: 'LoadImage', inputs: { image: 'a.png' } },
  '11': { class_type: 'LoadImage', inputs: { image: 'b.png' } },
  '12': { class_type: 'LatentFromImage', inputs: { image: ['10', 0] } },
  '29': { class_type: 'SaveImage', inputs: { filename_prefix: 'cover' } },
});

/* ---------------- 假 ComfyUI 服务：记录上传与每次提交的 prompt 图 ---------------- */
const submitted = [];
const uploads = [];   // 上传文件名（按 /upload/image 到达顺序）
let promptSeq = 0;
const comfy = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/upload/image') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const m = /filename="([^"]+)"/.exec(raw.toString('latin1'));
      const name = m ? m[1] : 'unknown.png';
      uploads.push(name);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name, subfolder: '', type: 'input' }));
    });
    return;
  }
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
  negativePrompt: 'low quality', width: 64, height: 64,
  baseUrl: `http://127.0.0.1:${comfy.address().port}`,
  pollIntervalMs: 5, timeoutMs: 5000,
};

after(() => {
  comfy.closeAllConnections?.();
  comfy.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

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

/* ---------------- 封面提示词：coverPrompt intent ---------------- */
test('coverPrompt intent（Mock）：按项目资料产出可直接使用的封面提示词', async () => {
  const providers = createProviders({});
  const out = await providers.generate('coverPrompt', {
    title: '雨夜来信', logline: '一封没有署名的信把侦探引到案发地',
    episodes: ['第1集：雨夜旧城区'], idea: '悬疑短片', custom: '',
  });
  assert.match(out.prompt, /片名《雨夜来信》/, '提示词包含片名');
  assert.match(out.prompt, /一封没有署名的信/, '提示词包含剧情梗概');
  assert.match(out.prompt, /cinematic movie poster/, '提示词带电影海报风格后缀');
  assert.ok(out.negative.length > 0, '带负向提示词');
  assert.equal(out.__fallback, undefined, 'Mock 模式不算回退');
});

test('coverPrompt intent（Mock）：custom 画面要求覆盖梗概并保持片名', async () => {
  const providers = createProviders({});
  const out = await providers.generate('coverPrompt', {
    title: '坐标之外', logline: '飞船迫降', custom: '水墨风、暖色调、少年背影',
  });
  assert.match(out.prompt, /片名《坐标之外》/);
  assert.match(out.prompt, /水墨风、暖色调、少年背影/);
});

test('coverPrompt intent：LLM 不可用 → 回退模板并打 __fallback', async () => {
  const providers = createProviders({ provider: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', llmTimeoutMs: 3000 }, () => {});
  const out = await providers.generate('coverPrompt', { title: '夏末纸条' });
  assert.equal(out.__fallback, true);
  assert.match(out.prompt, /片名《夏末纸条》/, '回退产物仍是可用提示词');
});

test('coverPrompt intent：LLM 把 JSON 包进任务命名键 → 递归解包出真实提示词（不被模板覆盖）', async () => {
  // 复现真实模型（如 mimo）的行为：{"cover文生图提示词": "{\"prompt\":...}"} —— 单键包裹 + 值是 JSON 字符串
  const llm = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const inner = JSON.stringify({ prompt: '水墨侦探立于雨夜巷口，泼墨笔触', negative: '模糊', style: 'noir' });
      const content = JSON.stringify({ '封面文生图提示词': inner });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise((resolve) => llm.listen(0, '127.0.0.1', resolve));
  try {
    const providers = createProviders({
      provider: 'openai', baseUrl: `http://127.0.0.1:${llm.address().port}`, apiKey: 'k', llmTimeoutMs: 5000,
    }, () => {});
    const out = await providers.generate('coverPrompt', { title: '雨夜侦探' });
    assert.equal(out.prompt, '水墨侦探立于雨夜巷口，泼墨笔触', '解包后模型真实提示词生效');
    assert.equal(out.__fallback, undefined, '不算回退');
    assert.ok(!out.__mockKeys || !out.__mockKeys.includes('prompt'), 'prompt 不是 Mock 补位');
  } finally {
    llm.closeAllConnections?.();
    llm.close();
  }
});

test('coverPrompt intent：LLM 缺 prompt 字段 → Mock 补位但打 __mockKeys（不冒充 AI）', async () => {
  const llm = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"style":"anime"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }));
    });
  });
  await new Promise((resolve) => llm.listen(0, '127.0.0.1', resolve));
  try {
    const providers = createProviders({
      provider: 'openai', baseUrl: `http://127.0.0.1:${llm.address().port}`, apiKey: 'k', llmTimeoutMs: 5000,
    }, () => {});
    const out = await providers.generate('coverPrompt', { title: '坐标之外' });
    assert.ok(out.__mockKeys.includes('prompt'), 'prompt 由 Mock 补位被显式标记');
    assert.equal(out.style, 'anime', '模型给出的字段仍然生效');
    assert.match(out.prompt, /片名《坐标之外》/, '补位产物仍是可用提示词');
  } finally {
    llm.closeAllConnections?.();
    llm.close();
  }
});

/* ---------------- REST：/cover/prompt ---------------- */
test('POST /api/projects/:id/cover/prompt：未配置大模型 → 内置模板生成，明示来源', async () => {
  saveProject({ id: 'prj_cp', name: '雾都孤影', mode: 'idea2video', nodes: [
    { id: 'n1', type: 'idea', data: { text: '侦探与记者在雾都追查一桩旧案' } },
  ], edges: [], createdAt: Date.now(), updatedAt: Date.now() });
  const r = await api('POST', '/api/projects/prj_cp/cover/prompt', { custom: '霓虹夜景' });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.source, 'template');
  assert.equal(r.data.fellBack, false);
  assert.match(r.data.prompt, /片名《雾都孤影》/);
  assert.match(r.data.prompt, /霓虹夜景/, '用户补充要求进入提示词');
  assert.ok(r.data.negative.length > 0);
  assert.ok(r.data.message.includes('内置模板'), '响应明示模板来源，不冒充 AI');
});

/* ---------------- 多参考图：逐 LoadImage 插槽上传映射 ---------------- */
test('runWorkflow 多参考图：按插槽顺序一一对应，多余参考图告警', async () => {
  const wf = parseWorkflow(multiSlotWF());
  const logs = [];
  const r = await runWorkflow(comfyCfg, wf, {
    prompt: '封面正向提示词', seed: 'cover-1', cfg: comfyCfg,
    imageRefs: [
      { buffer: PNG, name: 'refA.png' },
      { buffer: PNG, name: 'refB.png' },
      { buffer: PNG, name: 'refC.png' },
    ],
  }, { log: (lv, msg) => logs.push(`${lv}:${msg}`) });

  assert.equal(submitted.at(-1)['10'].inputs.image, 'refA.png', '插槽 1 ← 参考图 1');
  assert.equal(submitted.at(-1)['11'].inputs.image, 'refB.png', '插槽 2 ← 参考图 2');
  assert.ok(logs.some((l) => l.includes('多余的参考图未被使用')), '第 3 张无插槽可对应 → 明示忽略');
  assert.equal(r.primary.url.startsWith('/assets/'), true);
});

test('runWorkflow 单参考图：应用到全部插槽（视频首尾帧同图兼容）', async () => {
  const wf = parseWorkflow(multiSlotWF());
  await runWorkflow(comfyCfg, wf, {
    prompt: '封面正向提示词', seed: 'cover-2', cfg: comfyCfg,
    imageRefs: [{ buffer: PNG, name: 'single.png' }],
  }, {});
  assert.equal(submitted.at(-1)['10'].inputs.image, 'single.png');
  assert.equal(submitted.at(-1)['11'].inputs.image, 'single.png', '单图沿用旧语义，两个插槽同图');
});

test('runWorkflow 参考图少于插槽：剩余插槽占位填充并告警', async () => {
  const wf = parseWorkflow(multiSlotWF());
  const logs = [];
  await runWorkflow(comfyCfg, wf, {
    prompt: '封面正向提示词', seed: 'cover-3', cfg: comfyCfg,
    imageRefs: [{ buffer: PNG, name: 'onlyOne.png' }, { buffer: PNG, name: 'onlyTwo.png' }],
  }, { log: (lv, msg) => logs.push(`${lv}:${msg}`) });
  // 2 张图 3 个 LoadImage？此工作流只有 2 个插槽 —— 换成 2 图 3 槽校验
  assert.equal(submitted.at(-1)['10'].inputs.image, 'onlyOne.png');
  assert.equal(submitted.at(-1)['11'].inputs.image, 'onlyTwo.png');
});

test('runWorkflow 参考图多于插槽告警 / 提供图但工作流无 LoadImage 插槽告警', async () => {
  const bare = {
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['9', 0] } },
    '9': { class_type: 'CLIPLoader', inputs: { clip_name: 'clip.safetensors' } },
    '29': { class_type: 'SaveImage', inputs: { filename_prefix: 'cover' } },
  };
  const logs = [];
  await runWorkflow(comfyCfg, parseWorkflow(bare), {
    prompt: '封面正向提示词', seed: 'cover-4', cfg: comfyCfg,
    imageRefs: [{ buffer: PNG, name: 'r1.png' }],
  }, { log: (lv, msg) => logs.push(`${lv}:${msg}`) });
  assert.ok(logs.some((l) => l.includes('没有 LoadImage 参考图插槽')), '无插槽时参考图被忽略并明示');
});

/* ---------------- REST：/cover/generate 带多参考图 ---------------- */
test('POST /cover/generate：提示词文本框内容原样直用（不套模板） + refs 逐槽位 + 自定义负向', async () => {
  saveProject({ id: 'prj_cg', name: '深巷灯火', mode: 'idea2video', nodes: [], edges: [],
    createdAt: Date.now(), updatedAt: Date.now() });
  writeAssetBinary('coverref1.png', PNG);
  writeAssetBinary('coverref2.png', PNG);
  saveComfyConfig({
    enabled: true, imageWorkflow: parseWorkflow(multiSlotWF()),
    videoWorkflow: null, baseUrl: comfyCfg.baseUrl,
    pollIntervalMs: 5, timeoutMs: 5000, negativePrompt: '默认负向',
  });

  const before = submitted.length;
  const r = await api('POST', '/api/projects/prj_cg/cover/generate', {
    prompt: '完整提示词X，直用不应被再包裹', negative: '自定义负向词',
    refs: ['coverref1.png', 'coverref2.png'],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  const wf = submitted[before];
  assert.equal(wf['10'].inputs.image, 'coverref1.png', '参考图 1 ← 插槽 1');
  assert.equal(wf['11'].inputs.image, 'coverref2.png', '参考图 2 ← 插槽 2');
  assert.equal(wf['6'].inputs.text, '完整提示词X，直用不应被再包裹', '文本框内容即完整提示词，原样注入不套模板');
  assert.equal(wf['7'].inputs.text, '自定义负向词', '自定义负向提示词生效');
  assert.equal(r.data.cover.source, 'comfyui');
  assert.ok(r.data.url.startsWith('/assets/'));
});

test('POST /cover/generate：提示词留空才套项目资料模板；非法参考图被拒绝', async () => {
  saveProject({ id: 'prj_cg2', name: '界上花', mode: 'idea2video', nodes: [], edges: [],
    createdAt: Date.now(), updatedAt: Date.now() });
  const before = submitted.length;
  const r = await api('POST', '/api/projects/prj_cg2/cover/generate', { prompt: '' });
  assert.equal(r.status, 200);
  assert.match(submitted[before]['6'].inputs.text, /片名《界上花》/, '留空时按项目资料套片名模板');

  const direct = await api('POST', '/api/projects/prj_cg2/cover/generate', { prompt: '雨夜霓虹' });
  assert.equal(direct.status, 200);
  assert.equal(submitted[before + 1]['6'].inputs.text, '雨夜霓虹', '非空提示词原样直用，不套片名模板');

  const bad = await api('POST', '/api/projects/prj_cg2/cover/generate', {
    prompt: 'x', refs: ['evil.exe'],
  });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /不是可用的图片资源/);

  const missing = await api('POST', '/api/projects/prj_cg2/cover/generate', {
    prompt: 'x', refs: [{ dataUrl: 'data:image/png;base64,AAAA' }],
  });
  assert.equal(missing.status, 400, '损坏的 dataUrl 参考图被拒绝');
});
