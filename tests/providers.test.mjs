/* providers 单元测试：LLM 端点挂起的超时兜底
 * 运行：node --test tests/providers.test.mjs
 * 起一个「接受连接但永不响应」的本地 HTTP 服务模拟挂起端点，
 * 通过 llmTimeoutMs 缩短超时验证：调用按失败回退 Mock，不永久悬挂。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-prov-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const { createProviders } = await import('../src/core/providers.mjs');

const server = http.createServer(() => { /* 挂起：收到请求永不响应 */ });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;

after(() => {
  server.closeAllConnections?.();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('LLM 挂起 → 超时中断并回退 Mock，不永久卡死', async () => {
  const logs = [];
  const providers = createProviders({
    provider: 'openai',
    baseUrl: `http://127.0.0.1:${PORT}/v1/chat/completions`,
    apiKey: 'test-key',
    llmTimeoutMs: 150,               // 生产默认 120s，测试缩短
  }, (level, message) => logs.push(`${level}:${message}`));
  assert.equal(providers.mode, 'openai');

  const t0 = Date.now();
  const out = await providers.generate('scene', { index: 1, note: '挂起测试' });
  const cost = Date.now() - t0;
  assert.ok(cost < 5_000, `应在超时后迅速返回（实际 ${cost}ms）`);
  assert.ok(logs.some((l) => l.startsWith('warn:') && l.includes('回退 Mock')), `应有回退告警，实际：${logs}`);
  assert.ok(out && typeof out === 'object', 'Mock 结果照常返回');
});

test('超时信号可被调用方取消信号合并：caller 已取消时立即失败', async () => {
  const providers = createProviders({
    provider: 'openai',
    baseUrl: `http://127.0.0.1:${PORT}/v1/chat/completions`,
    apiKey: 'test-key',
    llmTimeoutMs: 60_000,
  }, () => {});
  const ctrl = new AbortController();
  ctrl.abort();                                  // 模拟用户在调用前已取消
  const t0 = Date.now();
  await providers.generate('scene', { index: 2 }, ctrl.signal);
  assert.ok(Date.now() - t0 < 3_000, '已取消的调用不等待完整超时，直接回退 Mock');
});

/* ---------------------------------------------------------------- Token 用量采集 */
const okServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const withUsage = req.url.includes('with-usage');
    const json = {
      model: 'test-model',
      choices: [{ message: { content: '```json\n{"text":"场景输出"}\n```' } }],
      ...(withUsage ? { usage: { prompt_tokens: 110, completion_tokens: 37, total_tokens: 147 } } : {}),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(json));
  });
});
await new Promise((resolve) => okServer.listen(0, '127.0.0.1', resolve));

after(() => {
  okServer.closeAllConnections?.();
  okServer.close();
});

function openaiProviders(url, records) {
  return createProviders({ provider: 'openai', baseUrl: url, apiKey: 'k' },
    () => {}, (r) => records.push(r));
}

test('端点返回 usage → onUsage 收到真实 token 用量', async () => {
  const records = [];
  const providers = openaiProviders(`http://127.0.0.1:${okServer.address().port}/with-usage/v1/chat/completions`, records);
  await providers.generate('screenplay', { idea: '雨夜来信' });
  assert.equal(records.length, 1);
  assert.equal(records[0].intent, 'screenplay');
  assert.equal(records[0].promptTokens, 110);
  assert.equal(records[0].completionTokens, 37);
  assert.equal(records[0].totalTokens, 147);
  assert.equal(records[0].calls, 1);
  assert.equal(records[0].estimated, false);
  assert.equal(records[0].fallback, undefined);
});

test('端点无 usage → 按字符估算并标记 estimated', async () => {
  const records = [];
  const providers = openaiProviders(`http://127.0.0.1:${okServer.address().port}/no-usage/v1/chat/completions`, records);
  await providers.generate('review', { index: 1 });
  assert.equal(records.length, 1);
  assert.equal(records[0].estimated, true);
  assert.ok(records[0].promptTokens > 0, 'prompt 按系统提示词字符数估算');
  assert.ok(records[0].completionTokens > 0, 'completion 按响应字符数估算');
  assert.equal(records[0].totalTokens, records[0].promptTokens + records[0].completionTokens);
});

test('LLM 失败回退 Mock → 记录 fallback 调用（tokens 为 0）', async () => {
  const records = [];
  const providers = createProviders({
    provider: 'openai',
    baseUrl: `http://127.0.0.1:${PORT}/v1/chat/completions`,   // 挂起端点 → 超时回退
    apiKey: 'k', llmTimeoutMs: 120,
  }, () => {}, (r) => records.push(r));
  await providers.generate('shots', { count: 2 });
  assert.equal(records.length, 1);
  assert.equal(records[0].fallback, true);
  assert.equal(records[0].totalTokens, 0);
  assert.equal(records[0].calls, 1);
});

/* ------------------------------------------------------- 回退显式化：__fallback 打标 */
test('openai 失败回退 Mock → 结果打 __fallback: true（消灭假成功）', async () => {
  const providers = createProviders({
    provider: 'openai',
    baseUrl: `http://127.0.0.1:${PORT}/v1/chat/completions`,   // 挂起端点 → 超时回退
    apiKey: 'k', llmTimeoutMs: 120,
  }, () => {});
  const out = await providers.generate('shots', { count: 2 });
  assert.equal(out.__fallback, true, '真实模型失败后的 Mock 结果必须显式标注');
});

test('openai 成功调用 → 结果无 __fallback 标记', async () => {
  const providers = openaiProviders(`http://127.0.0.1:${okServer.address().port}/with-usage/v1/chat/completions`, []);
  const out = await providers.generate('screenplay', { idea: '雨夜来信' });
  assert.equal(out.__fallback, undefined, '真实模型产出不应打回退标');
});

test('Mock 模式产出 → 不算回退，无 __fallback 标记', async () => {
  const providers = createProviders({ provider: 'mock' }, () => {});
  const out = await providers.generate('shots', { count: 2 });
  assert.equal(out.__fallback, undefined, 'Mock 模式本身就是 Mock，不算回退');
});

/* ------------------------------------------------- 式(4) VLM 真实看图择优 */
const judgeRequests = [];
const judgeServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const parsed = JSON.parse(body);
    judgeRequests.push(parsed);
    const json = {
      model: 'vlm-model',
      choices: [{ message: { content: JSON.stringify({ index: 1, scores: [0.62, 0.91], criteria: ['视觉保真度'], reason: '候选 2 角色一致、光照方向正确' }) } }],
      usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(json));
  });
});
await new Promise((resolve) => judgeServer.listen(0, '127.0.0.1', resolve));

after(() => {
  judgeServer.closeAllConnections?.();
  judgeServer.close();
});

test('judge 式(4)：openai 多模态真实看图择优 → judgeMode: vlm', async () => {
  // 先用 Mock 生成两张真实资产图作为候选
  const mock = createProviders({ provider: 'mock' }, () => {});
  const img = await mock.image({ kind: 'keyframe', prompt: '测试关键帧', shotNo: 1, seed: 'vlm-test' });
  const providers = createProviders({
    provider: 'openai', apiKey: 'k',
    baseUrl: `http://127.0.0.1:${judgeServer.address().port}/v1/chat/completions`,
  }, () => {});
  const verdict = await providers.judge({
    candidates: [{ url: img.url, prompt: '严格遵循机位' }, { url: img.url, prompt: '轻微变体' }],
    criteria: ['视觉保真度', '叙事一致性'], shotTitle: '中景 1',
  });
  assert.equal(verdict.judgeMode, 'vlm', '真实 VLM 评审');
  assert.equal(verdict.index, 1, '按 VLM 返回的 index 择优');
  assert.deepEqual(verdict.scores, [0.62, 0.91]);
  assert.equal(verdict.fallback, undefined);
  const userMsg = judgeRequests.at(-1)?.messages?.[1]?.content;
  assert.ok(Array.isArray(userMsg), '请求应为多模态 content 数组');
  assert.ok(userMsg.filter((p) => p.type === 'image_url').length === 2, '两张候选图都以 image_url 下发');
  assert.ok(userMsg.find((p) => p.type === 'image_url').image_url.url.startsWith('data:image/'), '图片为 base64 data URL');
});

test('judge：VLM 调用失败 → 回退启发式并显式标注 fallback', async () => {
  const providers = createProviders({
    provider: 'openai', apiKey: 'k',
    baseUrl: `http://127.0.0.1:${PORT}/v1/chat/completions`, llmTimeoutMs: 150,
  }, () => {});
  const verdict = await providers.judge({
    candidates: [{ url: '/assets/missing-a.png', prompt: 'a' }, { url: '/assets/missing-b.png', prompt: 'b' }],
    shotTitle: '特写 2',
  });
  assert.equal(verdict.judgeMode, 'heuristic', '回退启发式');
  assert.equal(verdict.fallback, true, '回退必须显式标注');
  assert.equal(verdict.scores.length, 2);
});

test('judge：Mock 模式 → 启发式打分（不算回退）', async () => {
  const providers = createProviders({ provider: 'mock' }, () => {});
  const verdict = await providers.judge({ candidates: [{ prompt: 'a' }, { prompt: 'b' }] });
  assert.equal(verdict.judgeMode, 'heuristic');
  assert.equal(verdict.fallback, undefined, 'Mock 模式本身就是启发式，不算回退');
});
