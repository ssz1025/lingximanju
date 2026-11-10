/* 服务端 API 能力声明：前端靠它识别「改了代码但没重启」的旧进程
 * 运行：node --test tests/api-version.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSystem } from '../src/api/routes/system.mjs';

function call(method, pathname) {
  const res = {
    headersSent: false, statusCode: 0,
    setHeader() {}, writeHead(s) { this.statusCode = s; },
    end(b) { this.body = b; },
  };
  const req = { method, headers: {}, on() {} };
  return handleSystem(req, res, { pathname, searchParams: new URLSearchParams() })
    .then((handled) => ({ handled, status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }));
}

test('GET /api/health 声明角色定妆任务能力（旧进程缺这一项 → 前端禁用生成并提示重启）', async () => {
  const { handled, status, body } = await call('GET', '/api/health');
  assert.equal(handled, true);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.revision, '必须带 revision，便于排查线上跑的是哪版');
  assert.ok(Array.isArray(body.capabilities));
  assert.ok(body.capabilities.includes('char-portrait-jobs'), '后台任务能力');
  assert.ok(body.capabilities.includes('char-portrait-require-real'), 'requireReal 能力');
  assert.ok(body.capabilities.includes('char-portrait-regen'), '重新生成能力');
});
