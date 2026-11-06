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
