/* readBody 边界行为 · 单元测试
 * 背景：多文件上传小说时请求体可能超过 8MB 上限。旧实现超限即 req.destroy()，
 * 掐断 socket 导致 413 响应送不到客户端，浏览器只看到 "Failed to fetch"；
 * 现实现应正确 reject（带 413 状态码）且继续消费流，让响应可达。
 * 运行：node --test tests/http-body.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readBody } from '../src/api/http.mjs';

/** 模拟一个依次吐 chunk 的请求；全吐完后触发 end */
function mockReq(chunks) {
  const req = new EventEmitter();
  queueMicrotask(() => {
    for (const c of chunks) req.emit('data', Buffer.isBuffer(c) ? c : Buffer.from(c));
    req.emit('end');
  });
  return req;
}

test('正常 JSON 请求体解析为对象', async () => {
  const body = await readBody(mockReq(['{"a":', '1}']));
  assert.deepEqual(body, { a: 1 });
});

test('空请求体解析为空对象', async () => {
  const body = await readBody(mockReq([]));
  assert.deepEqual(body, {});
});

test('超限请求体 reject 413，且消息可读、流能走完不报错', async () => {
  const limit = 1024; // 用小 limit 模拟 8MB 超限，测试不必真塞 8MB 数据
  const big = Buffer.alloc(2048, 120); // 2KB > 1KB 上限
  const req = mockReq([big, big, big]); // 超限后还要继续吐数据（流不中断）
  await assert.rejects(
    () => readBody(req, limit),
    (err) => {
      assert.equal(err.statusCode, 413);
      assert.ok(/请求体过大/.test(err.message), '错误信息要说明原因');
      assert.ok(/MB/.test(err.message), '错误信息要带上限数值，便于用户理解');
      return true;
    },
  );
});

test('超限后到达的数据被丢弃，不会解析成残缺 JSON', async () => {
  const limit = 4;
  // 第一块 6 字节超限；后续块（合法 JSON）必须被丢弃
  const req = mockReq([Buffer.from('123456'), Buffer.from('{"a":1}')]);
  await assert.rejects(() => readBody(req, limit), (err) => err.statusCode === 413);
});

test('非 JSON 请求体 reject 400', async () => {
  await assert.rejects(
    () => readBody(mockReq(['不是JSON'])),
    (err) => err.statusCode === 400 && /JSON/.test(err.message),
  );
});
