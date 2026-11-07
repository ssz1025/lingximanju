/* 「全局模型库」测试：惰性种子迁移（旧全局 llm + 项目显式配置收编）、
 * CRUD + 设默认、llm-test 的 ref:{profileId} 模式、resolveModelSettings 解析优先级。
 * 运行：node --test tests/llm-models.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-llm-models-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const { saveProject } = await import('../src/core/store.mjs');
const { saveAppSettings, resolveModelSettings } = await import('../src/core/app-settings.mjs');
const { handleApi } = await import('../src/api/routes.mjs');

/* 假 OpenAI 兼容端点：记录每次请求的 Authorization 与 model，返回最小 pong 响应 */
const seen = [];
const llm = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    seen.push({ auth: req.headers.authorization, model: json.model });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: json.model,
      choices: [{ message: { content: '{"pong":"pong"}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});
await new Promise((resolve) => llm.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${llm.address().port}`;

after(() => {
  llm.closeAllConnections?.();
  llm.close();
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

/* 环境数据：旧全局 openai 配置 + 项目A（完整独立配置，应被收编）+ 项目B（未配置）+ 项目C（无 Key） */
saveAppSettings({ llm: { provider: 'openai', model: 'global-model', baseUrl: BASE, apiKey: 'sk-global-key' } });
saveProject({ id: 'prj_a', name: '项目A·独立模型', management: { kind: 'standard', title: 'A' }, nodes: [],
  settings: { provider: 'openai', model: 'proj-model', baseUrl: BASE, apiKey: 'sk-proj-key', style: 'noir' } });
saveProject({ id: 'prj_b', name: '项目B·未配置', management: { kind: 'standard', title: 'B' }, nodes: [], settings: {} });
saveProject({ id: 'prj_c', name: '项目C·无Key', management: { kind: 'standard', title: 'C' }, nodes: [],
  settings: { provider: 'openai', model: 'proj-c', baseUrl: BASE } });

test('惰性种子迁移：旧全局 llm + 显式配置的项目收编进模型库，未配置项目排除，绝不泄漏明文 Key', async () => {
  const out = await api('GET', '/api/system/llm-models');
  assert.equal(out.status, 200);
  const models = out.data.models;
  assert.equal(models.length, 2, '全局 + 项目A（项目B/C 未配齐被排除）');
  const g = models.find((m) => m.model === 'global-model');
  const pa = models.find((m) => m.model === 'proj-model');
  assert.ok(g && pa, '两个档案都在清单里');
  assert.equal(g.id, 'mdl_global');
  assert.equal(pa.hasApiKey, true);
  assert.equal(pa.configured, true);
  const raw = JSON.stringify(out.data);
  assert.ok(!raw.includes('sk-global-key') && !raw.includes('sk-proj-key'), '响应绝不包含完整明文 Key');
  assert.equal(out.data.activeModelId, g.id, '首个档案自动成为默认');
  assert.ok(g.maskedKey && !g.maskedKey.includes('global'), 'Key 已脱敏');
});

test('CRUD：新增档案 → 编辑时 Key 留空沿用旧 Key → 设默认 → 删除', async () => {
  // 新增
  let out = await api('POST', '/api/system/llm-models', {
    name: '测试模型', provider: 'openai', model: 'test-model', baseUrl: BASE, apiKey: 'sk-new-key',
  });
  assert.equal(out.status, 200);
  const id = out.data.profile.id;
  assert.equal(out.data.profile.model, 'test-model');
  assert.ok(!JSON.stringify(out.data).includes('sk-new-key'), '新增响应不回显明文 Key');

  // 编辑：Key 留空沿用
  out = await api('POST', '/api/system/llm-models', {
    id, name: '测试模型·改名', provider: 'openai', model: 'test-model-2', baseUrl: BASE, apiKey: '',
  });
  assert.equal(out.data.profile.name, '测试模型·改名');
  assert.equal(out.data.profile.model, 'test-model-2');
  assert.equal(out.data.profile.hasApiKey, true, 'Key 留空沿用旧 Key');

  // 编辑档案不存在：404
  out = await api('POST', '/api/system/llm-models', { id: 'mdl_none', model: 'x' });
  assert.equal(out.status, 404);

  // 设默认
  out = await api('POST', '/api/system/llm-models/activate', { id });
  assert.equal(out.data.activeModelId, id);

  // 删除：默认回落到清单第一个
  out = await api('DELETE', '/api/system/llm-models', { id });
  assert.equal(out.status, 200);
  assert.ok(!out.data.models.some((m) => m.id === id));
  assert.notEqual(out.data.activeModelId, id);
  assert.ok(out.data.models.length >= 1);
});

test('ref 测试 · 全局档案：使用档案的完整配置（含明文 Key）真实调用', async () => {
  seen.length = 0;
  const list = (await api('GET', '/api/system/llm-models')).data;
  const g = list.models.find((m) => m.model === 'global-model');
  const out = await api('POST', '/api/system/llm-test', { ref: { profileId: g.id } });
  assert.equal(out.data.ok, true, `测试应成功：${JSON.stringify(out.data)}`);
  assert.equal(out.data.mode, 'openai');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].auth, 'Bearer sk-global-key');
  assert.equal(seen[0].model, 'global-model');
});

test('ref 测试 · 项目档案：项目自带 Key 与模型名生效；不存在的档案 404', async () => {
  const list = (await api('GET', '/api/system/llm-models')).data;
  const pa = list.models.find((m) => m.model === 'proj-model');
  seen.length = 0;
  const out = await api('POST', '/api/system/llm-test', { ref: { profileId: pa.id } });
  assert.equal(out.data.ok, true, `测试应成功：${JSON.stringify(out.data)}`);
  assert.equal(seen[0].auth, 'Bearer sk-proj-key', '项目自己的 Key');
  assert.equal(seen[0].model, 'proj-model', '项目自己的模型名');

  const miss = await api('POST', '/api/system/llm-test', { ref: { profileId: 'mdl_none' } });
  assert.equal(miss.status, 404);
  assert.equal(miss.data.ok, false);
  assert.match(miss.data.error, /不存在/);
});

test('回归：表单值测试（无 ref）仍可用，Key 留空时回退已保存全局 Key', async () => {
  seen.length = 0;
  const out = await api('POST', '/api/system/llm-test', {
    provider: 'openai', model: 'form-model', baseUrl: BASE, apiKey: '',
  });
  assert.equal(out.data.ok, true, `测试应成功：${JSON.stringify(out.data)}`);
  assert.equal(seen[0].auth, 'Bearer sk-global-key', 'Key 留空回退全局');
  assert.equal(seen[0].model, 'form-model', '表单模型名原样生效');
});

test('resolveModelSettings：对话框 modelId > 默认档案 > 项目旧配置 > 旧全局 llm；档案只覆盖 LLM 字段', async () => {
  const projA = { settings: { provider: 'openai', model: 'proj-model', baseUrl: BASE, apiKey: 'sk-proj-key', style: 'noir', concurrency: 2 } };
  const list = (await api('GET', '/api/system/llm-models')).data;
  const g = list.models.find((m) => m.model === 'global-model');
  const pa = list.models.find((m) => m.model === 'proj-model');

  // ① 显式 modelId 命中档案：LLM 字段被覆盖，style / concurrency 保留
  let s = resolveModelSettings(projA, pa.id);
  assert.equal(s.model, 'proj-model');
  assert.equal(s.apiKey, 'sk-proj-key');
  assert.equal(s.style, 'noir', '创作开关不被档案覆盖');
  assert.equal(s.concurrency, 2);

  // 默认档案指向全局：显式选择全局档案时用全局 Key
  s = resolveModelSettings(projA, g.id);
  assert.equal(s.apiKey, 'sk-global-key', '显式选择的全局档案覆盖项目配置');
  assert.equal(s.model, 'global-model');
  assert.equal(s.style, 'noir');

  // ② 无 modelId：走默认档案（上一步 CRUD 测试后回落到第一个）
  s = resolveModelSettings(projA, '');
  assert.ok([g.id, pa.id].includes(list.activeModelId));
  assert.ok(s.provider === 'openai');

  // ③ 项目 B（未配置）+ 清空默认档案 → 回退旧全局 llm 合并链
  saveAppSettings({ activeModelId: '' });
  const projB = { settings: {} };
  s = resolveModelSettings(projB, 'mdl_unknown_id');
  assert.equal(s.model, 'global-model', 'id 失效回退旧合并链');
  assert.equal(s.apiKey, 'sk-global-key');
});
