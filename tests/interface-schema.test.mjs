/* 接口输入参数 schema：导入 JSON 后的可视化配置 / 修改接口文件 / 生图 Agent 自动配参
 * 运行：node --test tests/interface-schema.test.mjs
 *
 * 覆盖：全量输入扫描 → 参数表归一化与编译 → 注入器 → REST API →
 *       createProviders 真实链路（fake LLM + fake ComfyUI）里 Agent 参数确实提交进工作流。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-iface-schema-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const CFG = await import('../src/core/comfy-config.mjs');
const {
  describeInterfaceInputs, BUILTIN_INPUT_VARS, parseAgentParamReply, injectWorkflow, parseWorkflow,
} = await import('../src/core/comfyui.mjs');
const { handleApi } = await import('../src/api/routes.mjs');
const { createProviders } = await import('../src/core/providers.mjs');

const FILE = path.join(TMP, 'comfyui.json');
const reset = () => fs.rmSync(FILE, { force: true });
const readCfg = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

const WF = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux-dev.safetensors' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
  '3': { class_type: 'SaveImage', inputs: { filename_prefix: 'out', images: ['4', 0] } },
  '4': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 0] } },
  '5': { class_type: 'KSampler', inputs: { seed: 123, steps: 25, cfg: 1.0, positive: ['2', 0], negative: ['2', 0], model: ['1', 0], latent_image: ['6', 0] } },
  '6': { class_type: 'EmptyLatentImage', inputs: { width: 864, height: 480, batch_size: 1 } },
  '9': { class_type: 'CustomStrength', inputs: { strength: 0.1 } },
  '10': { class_type: 'Note', inputs: { note: '原始备注' }, _meta: { title: '备注节点' } },
};

const SCHEMA = [
  { node: '2', input: 'text', source: 'builtin', varName: 'prompt' },
  { node: '9', input: 'strength', source: 'agent', value: '0.5', hint: '按画面情绪挑强度' },
  { node: '10', input: 'note', source: 'fixed', value: '固定备注' },
  { node: '6', input: 'batch_size', source: 'skip', value: '' },
];

function baseCfg(overrides = {}) {
  return {
    enabled: true, baseUrl: 'http://127.0.0.1:8188', clientId: 'test',
    width: 864, height: 480, fps: 24, frames: 124, steps: 25, cfg: 1.0,
    negativePrompt: '全局负向词', timeoutMs: 20000, pollIntervalMs: 10,
    imageWorkflowLib: [{
      id: 'wf_a', name: '文生图A', workflow: WF, createdAt: 1, lastTest: null,
      params: {}, nodeOverrides: [], bindings: [], inputSchema: SCHEMA, capability: '文生图',
    }],
    videoWorkflowLib: [], audioWorkflowLib: [],
    imageActiveId: 'wf_a', videoActiveId: null, audioActiveId: null,
    imageWorkflow: WF, imageWorkflowName: '文生图A',
    bindings: { image: [], video: [], audio: [] },
    scopeBindings: { cover: 'wf_a' },
    ...overrides,
  };
}

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

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/* --------------------------- 1. 输入清单扫描 --------------------------- */
test('describeInterfaceInputs：全量列出节点输入，识别类型 / 连线 / 建议内置变量', () => {
  const list = describeInterfaceInputs(WF);
  const at = (node, input) => list.find((i) => i.node === node && i.input === input);
  assert.equal(list.length, 18, '所有节点输入都要列出来');
  assert.equal(at('2', 'text').suggestedVar, 'prompt');
  assert.equal(at('2', 'text').hasPlaceholder, true);
  assert.match(at('2', 'text').role, /占位符/);
  assert.equal(at('1', 'ckpt_name').suggestedVar, 'model');
  assert.equal(at('5', 'seed').suggestedVar, 'seed');
  assert.equal(at('5', 'seed').type, 'number');
  assert.equal(at('6', 'width').suggestedVar, 'width');
  assert.equal(at('3', 'images').type, 'link', '连线槽位单独标记');
  assert.equal(at('3', 'images').lockable, false);
  assert.match(at('3', 'images').valueText, /连线/);
  assert.equal(at('3', 'filename_prefix').suggestedVar, 'filename_prefix');
  assert.equal(at('10', 'note').nodeTitle, '备注节点');
  assert.ok(BUILTIN_INPUT_VARS.some((v) => v.key === 'negative_prompt'));
  assert.ok(list.every((i) => !i.node.startsWith('_')));
});

/* --------------------------- 2. 参数表归一化与编译 --------------------------- */
test('normalizeInputSchema：非法来源归 auto、非法变量名清空、幂等', () => {
  const raw = [
    { node: '2', input: 'text', source: 'wat', varName: 'prompt' },
    { node: '9', input: 'strength', source: 'agent', value: 0.5, hint: '要求', label: '强度' },
    { node: '', input: 'text', source: 'fixed' },
    { node: '10', input: 'note', source: 'fixed', value: { bad: 1 }, varName: 'bad key!' },
  ];
  const once = CFG.normalizeInputSchema(raw);
  assert.equal(once.length, 3);
  assert.equal(once[0].source, 'auto');
  assert.equal(once[1].value, 0.5);
  assert.equal(once[2].varName, '');
  assert.deepEqual(CFG.normalizeInputSchema(once), once, '归一化幂等');
  assert.deepEqual(CFG.normalizeInputSchema(null), []);
});

test('compileInputSchema：builtin/fixed/agent/skip/auto 五种来源分别编译，失效槽位给告警', () => {
  const rows = [
    ...SCHEMA,
    { node: '6', input: 'width', source: 'auto' },
    { node: '99', input: 'ghost', source: 'fixed', value: 'x' },
    { node: '3', input: 'images', source: 'fixed', value: 'x' },
  ];
  const out = CFG.compileInputSchema(rows, WF);
  assert.deepEqual(out.overrides.find((o) => o.node === '2'), { node: '2', input: 'text', value: '{{prompt}}' });
  assert.deepEqual(out.overrides.find((o) => o.node === '10'), { node: '10', input: 'note', value: '固定备注' });
  assert.deepEqual(out.overrides.find((o) => o.node === '6' && o.input === 'batch_size'),
    { node: '6', input: 'batch_size', value: 1 }, 'skip 锁定工作流原值');
  assert.equal(out.overrides.some((o) => o.node === '6' && o.input === 'width'), false, 'auto 不生成覆盖');
  assert.equal(out.paramPlan.length, 1);
  assert.equal(out.paramPlan[0].node, '9');
  // 兜底值按原值类型还原：节点里 strength 是数字 0.1，所以 '0.5' 写成真数字（字符串会被 ComfyUI 拒绝）
  assert.equal(out.paramPlan[0].fallback, 0.5);
  assert.equal(out.paramPlan[0].hint, '按画面情绪挑强度');
  assert.ok(out.warnings.some((w) => /99.ghost/.test(w)));
  assert.ok(out.warnings.some((w) => /连线槽位/.test(w)));
  assert.deepEqual(CFG.compileInputSchema([], WF), { overrides: [], paramPlan: [], warnings: [] });
});

/* --------------------------- 3. 解析与真实注入 --------------------------- */
test('resolveInterface：参数表编译进 config，旧档案无新字段时行为不变', () => {
  const withSchema = CFG.resolveInterface(baseCfg(), { kind: 'image', scope: 'cover' });
  assert.equal(withSchema.via, 'scope');
  assert.equal(withSchema.interfaceId, 'wf_a');
  assert.equal(withSchema.paramPlan.length, 1);
  assert.ok(withSchema.config.nodeOverrides.some((o) => o.node === '2' && o.value === '{{prompt}}'));
  assert.ok(withSchema.nodeOverrides.some((o) => o.node === '10' && o.value === '固定备注'));

  const legacy = baseCfg();
  delete legacy.imageWorkflowLib[0].inputSchema;
  const old = CFG.resolveInterface(legacy, { kind: 'image', scope: 'cover' });
  assert.deepEqual(old.nodeOverrides, [], '老配置没有参数表 → 不产生任何节点覆盖');
  assert.deepEqual(old.paramPlan, []);
  assert.deepEqual(old.warnings, []);
});

test('injectWorkflow：可视化配置的 builtin / fixed / skip 真的写进提交的工作流', () => {
  const resolved = CFG.resolveInterface(baseCfg(), { kind: 'image', scope: 'cover' });
  const built = injectWorkflow(parseWorkflow(resolved.workflow), {
    prompt: '雨夜的便利店', negative: '模糊', cfg: resolved.config,
  }, resolved.bindings);
  assert.match(built.prompt['2'].inputs.text, /雨夜的便利店/);
  assert.equal(built.prompt['10'].inputs.note, '固定备注');
  assert.equal(built.prompt['6'].inputs.batch_size, 1, 'skip 保持原值');
  assert.ok(built.applied.some((a) => a.node === '2' && a.by === 'interface:nodeOverride'));
});

/* --------------------------- 4. REST：接口 JSON 与参数表 --------------------------- */
test('GET /interfaces/:id/schema：返回工作流本体 + 自动解析的输入清单 + 内置变量', async () => {
  reset();
  fs.writeFileSync(FILE, JSON.stringify(baseCfg()));
  const { status, data } = await api('GET', '/api/comfyui/interfaces/wf_a/schema');
  assert.equal(status, 200);
  assert.equal(data.id, 'wf_a');
  assert.deepEqual(data.workflow, WF);
  assert.equal(data.inputs.length, 18);
  assert.equal(data.inputSchema.length, SCHEMA.length);
  assert.ok(data.builtinVars.some((v) => v.key === 'prompt'));
  const miss = await api('GET', '/api/comfyui/interfaces/nope/schema');
  assert.equal(miss.status, 404);
});

test('PUT /interfaces/:id/workflow：修改接口 JSON 并同步镜像；非法 JSON 400；失效参数给告警', async () => {
  reset();
  fs.writeFileSync(FILE, JSON.stringify(baseCfg()));
  const changed = JSON.parse(JSON.stringify(WF));
  changed['2'].inputs.text = '{{prompt}} · 电影感';
  delete changed['10'];
  const ok = await api('PUT', '/api/comfyui/interfaces/wf_a/workflow', { workflow: changed });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.config.imageWorkflowLib[0].workflow['2'].inputs.text, '{{prompt}} · 电影感');
  assert.equal(ok.data.config.imageWorkflow['2'].inputs.text, '{{prompt}} · 电影感', '选中项镜像同步');
  assert.equal(ok.data.inputs.some((i) => i.node === '10'), false);
  assert.ok(ok.data.warnings.some((w) => /10.note/.test(w)), '已删除的输入在参数表里给告警');
  assert.equal(readCfg().imageWorkflowLib[0].workflow['10'], undefined, '确实落盘');

  const bad = await api('PUT', '/api/comfyui/interfaces/wf_a/workflow', { workflow: { nodes: [] } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /导出\(API\)/);
  const miss = await api('PUT', '/api/comfyui/interfaces/nope/workflow', { workflow: WF });
  assert.equal(miss.status, 404);
});

test('PUT /interfaces/:id：保存输入参数表并回读，导入的新档案自动补空表', async () => {
  reset();
  fs.writeFileSync(FILE, JSON.stringify(baseCfg()));
  const rows = [{ node: '9', input: 'strength', source: 'agent', value: '0.6', hint: '按光线强度' }];
  const saved = await api('PUT', '/api/comfyui/interfaces/wf_a', { inputSchema: rows });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.summary.interfaces[0].inputSchema.length, 1);
  assert.equal(saved.data.summary.interfaces[0].inputSchema[0].source, 'agent');
  const back = await api('GET', '/api/comfyui/interfaces/wf_a/schema');
  assert.deepEqual(back.data.inputSchema.map((r) => [r.node, r.input, r.source]),
    [['9', 'strength', 'agent']]);

  const added = await api('POST', '/api/comfyui/interfaces', {
    kind: 'image', items: [{ name: '新接口', workflow: WF }],
  });
  assert.equal(added.data.added.length, 1);
  const fresh = added.data.config.imageWorkflowLib.find((e) => e.name === '新接口');
  assert.deepEqual(fresh.inputSchema, [], '导入的接口默认空参数表 = 自动识别，行为不变');
});

/* --------------------------- 5. Agent 参数回复解析 --------------------------- */
test('parseAgentParamReply：四种形态 / 兜底 / 只保留参数表里的槽位', () => {
  const plan = [
    { node: '9', input: 'strength', fallback: '0.5' },
    { node: '10', input: 'note', fallback: '默认备注' },
  ];
  assert.deepEqual(parseAgentParamReply({ params: [{ node: '9', input: 'strength', value: 0.75 }] }, plan),
    [{ node: '9', input: 'strength', value: 0.75 }, { node: '10', input: 'note', value: '默认备注' }]);
  assert.deepEqual(parseAgentParamReply('```json\n[{"node":"9","input":"strength","value":"0.8"}]\n```', plan)[0].value, '0.8');
  assert.deepEqual(parseAgentParamReply({ '9::strength': 0.9, '88::ghost': 'x' }, plan)[0].value, 0.9);
  assert.deepEqual(parseAgentParamReply({ params: [{ node: '9', input: 'strength', value: { bad: 1 } }] }, plan)[0].value, '0.5');
  assert.deepEqual(parseAgentParamReply(null, []), []);
});

/* --------------------------- 6. 生图 Agent 端到端配参 --------------------------- */
/** 用假 LLM + 假 ComfyUI 跑一次真实 image()，返回提交的工作流与调用记录 */
async function runImageWithFakeServices(schema, llmReply = '{"params":[{"node":"9","input":"strength","value":0.75}]}') {
  const originalFetch = globalThis.fetch;
  const state = { submitted: [], llmCalls: 0 };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/chat/completions')) {
      state.llmCalls += 1;
      return new Response(JSON.stringify({
        choices: [{ message: { content: llmReply } }], model: 'fake',
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.endsWith('/prompt')) {
      state.submitted.push(JSON.parse(opts.body).prompt);
      return new Response(JSON.stringify({ prompt_id: 'p1' }), { status: 200 });
    }
    if (u.includes('/history/p1')) {
      return new Response(JSON.stringify({
        p1: { status: { status_str: 'success', completed: true },
          outputs: { '3': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } },
      }), { status: 200 });
    }
    if (u.includes('/view?')) return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 });
    if (u.includes('/upload/image')) {
      return new Response(JSON.stringify({ name: 'ref.png', subfolder: '', type: 'input' }), { status: 200 });
    }
    throw new Error(`意外的请求 ${u}`);
  };
  try {
    const cfg = baseCfg();
    cfg.imageWorkflowLib[0].inputSchema = schema;
    cfg.imageWorkflowLib[0].workflow = WF;
    cfg.imageWorkflow = WF;
    const providers = createProviders({
      provider: 'openai', baseUrl: 'http://fake-llm/v1', apiKey: 'x', model: 'fake', comfy: cfg,
    }, () => {}, null);
    const result = await providers.image({ kind: 'cover', prompt: '雨夜的便利店', shotNo: 1, requireReal: true });
    return { ...state, result, submitted: state.submitted[0] };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('标记「由 Agent 生成」时：LLM 按所选接口产出参数，真的提交进工作流', async () => {
  const { submitted, llmCalls, result } = await runImageWithFakeServices(SCHEMA);
  assert.equal(llmCalls, 1, '仅调用一次 LLM');
  assert.equal(result.interfaceId, 'wf_a');
  assert.equal(submitted['9'].inputs.strength, 0.75, 'Agent 生成的 strength 覆盖了工作流原值 0.1');
  assert.match(submitted['2'].inputs.text, /雨夜的便利店/, 'builtin 提示词照常注入');
  assert.equal(submitted['10'].inputs.note, '固定备注');
  assert.equal(submitted['6'].inputs.batch_size, 1);
});

test('没有 Agent 标记时：零额外 LLM 调用，其余可视化配置仍生效', async () => {
  const rows = SCHEMA.filter((r) => r.source !== 'agent');
  const { submitted, llmCalls } = await runImageWithFakeServices(rows);
  assert.equal(llmCalls, 0, '按标记触发：没标记就不调用 LLM');
  assert.equal(submitted['9'].inputs.strength, 0.1, '保持工作流原值');
  assert.equal(submitted['10'].inputs.note, '固定备注');
});

test('LLM 返回不可解析时：回落到档案兜底值，出图不被阻断', async () => {
  const { submitted, llmCalls, result } = await runImageWithFakeServices(SCHEMA, '模型这次没给 JSON');
  assert.equal(llmCalls, 1);
  // strength 原值是数字 → 兜底值也还原成数字（ComfyUI 对数值槽位做类型校验）
  assert.equal(submitted['9'].inputs.strength, 0.5, '用参数表里填的兜底值');
  assert.equal(result.provider, 'comfyui');
});

/* ---------- 回归：多图 / 多素材数组不能被误判成连线 ---------- */

const multiWf = () => ({
  '1': { class_type: 'LoadImage', _meta: { title: '载入参考图' }, inputs: { image: 'ref1.png' } },
  '2': { class_type: 'ImpactImageBatch', _meta: { title: '批量参考图' }, inputs: { images: ['a.png', 'b.png'] } },
  '3': { class_type: 'CLIPTextEncode', _meta: { title: '正向' }, inputs: { text: 'a cat', clip: ['4', 1] } },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sdxl.safetensors' } },
});

test('describeInterfaceInputs：两元素字符串数组判为 array，不是连线', () => {
  const list = describeInterfaceInputs(multiWf());
  const box = list.find((i) => i.node === '2' && i.input === 'images');
  assert.equal(box.type, 'array', '多图数组应为 array');
  assert.equal(box.lockable, true, '多图参数必须可编辑');
  assert.equal(box.multiple, true);
  assert.match(box.valueText, /a\.png/, '应列出数组内容');
  const clip = list.find((i) => i.node === '3' && i.input === 'clip');
  assert.equal(clip.type, 'link', '真正的连线仍是 link（第二项是数字）');
});

test('compileInputSchema：多图参数用固定值写入 JSON 数组', () => {
  const wf = multiWf();
  const r = CFG.compileInputSchema([
    { node: '2', input: 'images', source: 'fixed', value: '["x.png","y.png"]' },
  ], wf);
  const ov = r.overrides.find((o) => o.node === '2' && o.input === 'images');
  assert.deepEqual(ov.value, ['x.png', 'y.png'], 'JSON 数组文本要还原成真数组');
});

test('compileInputSchema：多图参数可用逗号简写，也可由 Agent 生成', () => {
  const r1 = CFG.compileInputSchema([{ node: '2', input: 'images', source: 'fixed', value: 'x.png, y.png' }], multiWf());
  assert.deepEqual(r1.overrides[0].value, ['x.png', 'y.png'], '逗号分隔按多图处理');
  const r2 = CFG.compileInputSchema([{ node: '2', input: 'images', source: 'agent', hint: '按画面挑参考图' }], multiWf());
  assert.equal(r2.paramPlan[0].multiple, true, 'Agent 待办要标记多值');
  assert.ok(r2.warnings.length === 0, '多图不应产生连线告警');
});

test('normalizeInputOrder：去重 / 丢弃非法键 / 幂等', () => {
  assert.deepEqual(CFG.normalizeInputOrder(undefined), []);
  assert.deepEqual(CFG.normalizeInputOrder(['1::text', '1::text', 'bad', '::x', '2::images']),
    ['1::text', '2::images']);
});

test('applyInputOrder：按用户顺序重排，未知项留在末尾', () => {
  const inputs = [
    { node: '1', input: 'text' }, { node: '2', input: 'steps' },
    { node: '3', input: 'seed' }, { node: '4', input: 'extra' },
  ];
  const out = CFG.applyInputOrder(inputs, ['3::seed', '1::text']);
  assert.deepEqual(out.map((i) => `${i.node}::${i.input}`), ['3::seed', '1::text', '2::steps', '4::extra']);
  // 空顺序 = 原样返回（老配置行为不变）
  assert.deepEqual(CFG.applyInputOrder(inputs, []), inputs);
});

test('inputOrder 落盘后 schema 接口按该顺序返回；旧配置无字段时保持扫描顺序', () => {
  reset();
  const wf = multiWf();
  const id = 'wf_order_test';
  CFG.saveComfyConfig({
    imageWorkflowLib: [{ id, name: 'order', workflow: wf, inputOrder: ['3::text', '1::image'] }],
    imageActiveId: id,
  });
  const entry = CFG.loadComfyConfig().imageWorkflowLib.find((e) => e.id === id);
  assert.deepEqual(entry.inputOrder, ['3::text', '1::image'], 'inputOrder 必须落盘');
  const ordered = CFG.applyInputOrder(describeInterfaceInputs(entry.workflow), entry.inputOrder);
  assert.equal(`${ordered[0].node}::${ordered[0].input}`, '3::text', '第一条应是用户排到最前的');
});

/* ---------- 参数表只展示需要输入的参数 + 按类型匹配控件 ---------- */

const mediaWf = () => ({
  '1': { class_type: 'LoadImage', _meta: { title: '参考图' }, inputs: { image: 'cat.png', upload: 'image' } },
  '2': { class_type: 'VHS_LoadVideo', _meta: { title: '参考视频' }, inputs: { video: 'clip.mp4', force_rate: 24, frame_load_cap: 16 } },
  '3': { class_type: 'LoadAudio', _meta: { title: '参考音频' }, inputs: { audio: 'voice.mp3' } },
  '4': { class_type: 'UNETLoader', _meta: { title: '模型' }, inputs: { unet_name: 'model.safetensors' } },
  '5': { class_type: 'CLIPTextEncode', _meta: { title: '正向' }, inputs: { text: 'a cat', clip: ['7', 1] } },
  '6': { class_type: 'KSampler', inputs: { seed: 42, tiled: true, positive: ['5', 0] } },
  '7': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen.safetensors' } },
  '8': { class_type: 'SaveImage', inputs: { filename_prefix: 'out', images: ['9', 0] } },
  '9': { class_type: 'VAEDecode', inputs: { samples: ['6', 0] } },
});

test('describeInterfaceInputs：连线槽位 editable=false，其余 true（参数表据此过滤）', () => {
  const list = describeInterfaceInputs(mediaWf());
  const at = (n, k) => list.find((i) => i.node === n && i.input === k);
  assert.equal(at('5', 'clip').type, 'link');
  assert.equal(at('5', 'clip').editable, false, '连线不展示也不可配');
  assert.equal(at('8', 'images').editable, false);
  assert.equal(at('6', 'positive').editable, false);
  assert.equal(at('1', 'image').editable, true, '媒体槽位要展示');
  assert.equal(at('5', 'text').editable, true);
  // 参数表只渲染 editable 项
  const shown = list.filter((i) => i.editable);
  const hidden = list.filter((i) => !i.editable);
  assert.equal(shown.length + hidden.length, list.length);
  assert.equal(hidden.length, 4);
});

test('describeInterfaceInputs：图片 / 视频 / 音频槽位按节点类型与输入名判定 media', () => {
  const list = describeInterfaceInputs(mediaWf());
  const at = (n, k) => list.find((i) => i.node === n && i.input === k);
  assert.equal(at('1', 'image').media, 'image', 'LoadImage.image → image');
  assert.equal(at('2', 'video').media, 'video', 'VHS_LoadVideo → video');
  assert.equal(at('3', 'audio').media, 'audio', 'LoadAudio → audio');
  assert.equal(at('4', 'unet_name').media, '', '权重文件不是媒体素材');
  assert.equal(at('7', 'clip_name').media, '', 'CLIP 权重也不是媒体素材');
  assert.equal(at('5', 'text').media, '');
  assert.equal(at('1', 'upload').media, 'image', '输入名兜底也能认出图片槽位');
});

test('describeInterfaceInputs：长文本用多行控件，短文本保持单行', () => {
  const list = describeInterfaceInputs(mediaWf());
  const text = list.find((i) => i.node === '5' && i.input === 'text');
  assert.equal(text.multiline, true, 'CLIPTextEncode.text 是多行提示词');
  const short = list.find((i) => i.node === '8' && i.input === 'filename_prefix');
  assert.equal(short.multiline, false);
  const media = list.find((i) => i.node === '1' && i.input === 'image');
  assert.equal(media.multiline, false, '媒体槽位有自己的上传控件，不再用多行文本');
});

test('compileInputSchema：布尔固定值按真布尔写回（下拉回传的是字符串）', () => {
  const wf = mediaWf();
  const on = CFG.compileInputSchema([{ node: '6', input: 'tiled', source: 'fixed', value: 'true' }], wf);
  assert.equal(on.overrides[0].value, true, '"true" → true');
  const off = CFG.compileInputSchema([{ node: '6', input: 'tiled', source: 'fixed', value: '0' }], wf);
  assert.equal(off.overrides[0].value, false, '"0" → false');
  const bad = CFG.compileInputSchema([{ node: '6', input: 'tiled', source: 'fixed', value: '也许' }], wf);
  assert.equal(bad.overrides[0].value, '也许', '非布尔文本保留原文并给告警');
  assert.ok(bad.warnings.some((w) => /布尔/.test(w)));
});

test('compileInputSchema：数字固定值按真数字写回，非法文本保留原文并告警', () => {
  const wf = mediaWf();
  const ok = CFG.compileInputSchema([{ node: '6', input: 'seed', source: 'fixed', value: '123' }], wf);
  assert.equal(ok.overrides[0].value, 123);
  const bad = CFG.compileInputSchema([{ node: '6', input: 'seed', source: 'fixed', value: 'abc' }], wf);
  assert.equal(bad.overrides[0].value, 'abc');
  assert.ok(bad.warnings.some((w) => /数字/.test(w)));
  // 文本槽位保持字符串，不做类型猜测
  const text = CFG.compileInputSchema([{ node: '5', input: 'text', source: 'fixed', value: '123' }], wf);
  assert.equal(text.overrides[0].value, '123');
});

test('interfaceOverview：inputCount 只数可编辑参数，linkCount 单独给出', () => {
  reset();
  const wf = mediaWf();
  const id = 'wf_media_count';
  CFG.saveComfyConfig({ imageWorkflowLib: [{ id, name: 'media', workflow: wf }], imageActiveId: id });
  const ov = CFG.interfaceOverview(CFG.loadComfyConfig()).find((x) => x.id === id);
  const all = describeInterfaceInputs(wf);
  const editable = all.filter((i) => i.editable).length;
  assert.equal(ov.inputCount, editable, 'inputCount = 需要填写的参数');
  assert.equal(ov.linkCount, all.length - editable, 'linkCount = 被隐藏的连线槽位');
  assert.ok(ov.linkCount > 0);
});

/* ---------- POST /interfaces/:id/media：本地资源库 + ComfyUI 双写 ---------- */
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

async function withFakeComfy(fn) {
  const originalFetch = globalThis.fetch;
  const uploads = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/upload/image')) {
      uploads.push(String(opts.body || ''));
      const name = /filename="([^"]+)"/.exec(String(opts.body))?.[1] || 'x.png';
      return new Response(JSON.stringify({ name, subfolder: '', type: 'input' }), { status: 200 });
    }
    throw new Error(`意外的请求 ${u}`);
  };
  try { return await fn(uploads); } finally { globalThis.fetch = originalFetch; }
}

test('POST /interfaces/:id/media：上传 dataURL → 本地资源库落盘 + 推 ComfyUI，返回 comfyName', async () => {
  reset();
  fs.writeFileSync(FILE, JSON.stringify(baseCfg()));
  const out = await withFakeComfy(async (uploads) => {
    const r = await api('POST', '/api/comfyui/interfaces/wf_a/media', {
      media: 'image', node: '6', input: 'image', name: 'cat.png',
      dataUrl: `data:image/png;base64,${PNG_1PX}`,
    });
    assert.equal(r.status, 200, `上传失败：${r.data.error}`);
    assert.equal(uploads.length, 1, '要真的推到 ComfyUI');
    assert.match(uploads[0], /Content-Type: image\/png/, 'Content-Type 按扩展名给');
    return r.data;
  });
  assert.equal(out.ok, true);
  assert.equal(out.media, 'image');
  assert.equal(out.comfyName, out.asset, 'comfyName 与本地资源同名，写回参数表');
  assert.equal(out.asset.startsWith('iface_wf_a_'), true, '上传落盘到 iface_ 前缀');
  assert.ok(fs.existsSync(path.join(TMP, 'assets', out.asset)), '本地资源库确实有文件');
  assert.equal(out.warning, null);
});

test('POST /interfaces/:id/media：资源库复用只推 ComfyUI，不重复落盘', async () => {
  reset();
  fs.writeFileSync(FILE, JSON.stringify(baseCfg()));
  fs.mkdirSync(path.join(TMP, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'assets', 'picked.png'), Buffer.from(PNG_1PX, 'base64'));
  const out = await withFakeComfy(async () => {
    const r = await api('POST', '/api/comfyui/interfaces/wf_a/media', {
      media: 'image', node: '6', input: 'image', asset: 'picked.png',
    });
    assert.equal(r.status, 200, `复用失败：${r.data.error}`);
    return r.data;
  });
  assert.equal(out.comfyName, 'picked.png');
  assert.equal(out.url, '/assets/picked.png');
});

test('POST /interfaces/:id/media：类型不符 / 非法文件名 / 接口不存在都被拒', async () => {
  reset();
  fs.writeFileSync(FILE, JSON.stringify(baseCfg()));
  const wrong = await api('POST', '/api/comfyui/interfaces/wf_a/media', {
    media: 'image', node: '6', input: 'image',
    dataUrl: `data:video/mp4;base64,${PNG_1PX}`,
  });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /视频|图片/);
  const bad = await api('POST', '/api/comfyui/interfaces/wf_a/media', {
    media: 'image', node: '6', input: 'image', asset: '../escape.png',
  });
  assert.equal(bad.status, 400);
  const miss = await api('POST', '/api/comfyui/interfaces/nope/media', { media: 'image', dataUrl: 'x' });
  assert.equal(miss.status, 404);
  const empty = await api('POST', '/api/comfyui/interfaces/wf_a/media', { media: 'image' });
  assert.equal(empty.status, 400);
});

test('POST /interfaces/:id/media：ComfyUI 不可达时仍保存本地并给 warning，不阻断', async () => {
  reset();
  fs.writeFileSync(FILE, JSON.stringify(baseCfg()));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
  try {
    const r = await api('POST', '/api/comfyui/interfaces/wf_a/media', {
      media: 'image', node: '6', input: 'image', name: 'x.png',
      dataUrl: `data:image/png;base64,${PNG_1PX}`,
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.match(r.data.warning, /ECONNREFUSED/);
    assert.ok(fs.existsSync(path.join(TMP, 'assets', r.data.asset)), '本地仍落下文件');
  } finally { globalThis.fetch = originalFetch; }
});
