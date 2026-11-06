/* 资源管理路由层单元测试：url 自愈 / 列表 / 孤儿扫描 / 批量删除 / 引用保护 / 穿越拦截
 * 运行：node --test tests/asset-routes.test.mjs
 * 必须先把数据目录指到临时目录再动态导入（ESM import 会提升），避免污染真实 data/
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-asset-routes-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const { handleAssets } = await import('../src/api/routes/assets.mjs');
const { listAssets, reindex } = await import('../src/core/assets.mjs');
const { ASSET_DIR, PROJECT_DIR } = await import('../src/core/store.mjs');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/* ---- 测试工具：mock http 对象与资源/项目造数 ---- */

/** 驱动 handleAssets：返回 { status, body }，body 可选（POST 传 JSON 对象） */
function run(method, pathname, body) {
  const res = {
    setHeader() {}, statusCode: 0,
    writeHead(s) { this.statusCode = s; },
    end(b) { this.body = b; },
  };
  const req = new EventEmitter();
  req.method = method;
  req.headers = {};
  const p = handleAssets(req, res, { pathname });
  if (body !== undefined) { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); }
  return p.then(() => ({ status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }));
}

/** 造一个资源文件（PNG 魔数），登记进索引并返回文件名 */
function makeAsset(name, bytes = [0x89, 0x50, 0x4e, 0x47]) {
  fs.writeFileSync(path.join(ASSET_DIR, name), Buffer.from(bytes));
  return name;
}

/** 造一个项目 JSON（内容包含给定文件名，模拟封面/节点引用） */
function makeProject(id, ...referenced) {
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  const payload = JSON.stringify({
    id, name: `项目 ${id}`,
    nodes: referenced.map((file) => ({ id: 'n1', data: { poster: `/assets/${file}` } })),
  });
  fs.writeFileSync(path.join(PROJECT_DIR, `${id}.json`), payload);
}

test('listAssets：新条目带 url 字段；旧版 index.json 缺 url 时自愈补齐并落盘', () => {
  const f = makeAsset('self_heal.png');
  listAssets(); // 首次收录
  let e = listAssets().find((a) => a.file === f);
  assert.equal(e.url, `/assets/${f}`, '新条目自动带 url');

  // 手工把索引降级成「无 url 字段」的旧版格式，再列表应自愈
  const idxPath = path.join(ASSET_DIR, 'index.json');
  const raw = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  const stripped = raw.entries.map(({ url, ...rest }) => rest);
  assert.ok(stripped.some((x) => x.file === f && x.url === undefined), '前置：旧版条目确实缺 url');
  fs.writeFileSync(idxPath, JSON.stringify({ version: 1, entries: stripped }));

  const healed = listAssets().find((a) => a.file === f);
  assert.equal(healed.url, `/assets/${f}`, '旧条目列表时补齐 url');
  // 自愈结果落盘
  const saved = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  assert.ok(saved.entries.find((x) => x.file === f && x.url === `/assets/${f}`), '自愈写回 index.json');
});

test('GET /api/assets：返回列表且每项都有 /assets/ 前缀的 url', async () => {
  makeAsset('rt_a.png');
  const r = await run('GET', '/api/assets');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.assets) && r.body.assets.length >= 1);
  for (const a of r.body.assets) assert.ok(a.url?.startsWith('/assets/'), `url 合法：${a.file}`);
  assert.ok(r.body.assets.some((a) => a.file === 'rt_a.png'));
});

test('DELETE /api/assets/:file：未被引用时删除成功，文件消失', async () => {
  const f = makeAsset('rt_del.png');
  const r = await run('DELETE', `/api/assets/${f}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.deleted, true);
  assert.ok(!fs.existsSync(path.join(ASSET_DIR, f)), '文件已从磁盘删除');
});

test('DELETE /api/assets/:file：被项目引用时 409 并给出引用列表', async () => {
  const f = makeAsset('rt_ref.png');
  makeProject('prj_ref_a', f);
  const r = await run('DELETE', `/api/assets/${f}`);
  assert.equal(r.status, 409);
  assert.equal(r.body.ok, undefined);
  assert.deepEqual(r.body.refs, ['prj_ref_a']);
  assert.ok(fs.existsSync(path.join(ASSET_DIR, f)), '被引用资源不被删除');
});

test('DELETE /api/assets/:file：路径穿越（..）被 400 拦截', async () => {
  const r = await run('DELETE', '/api/assets/..');
  assert.equal(r.status, 400);
  // 正则字符类允许 `.`，必须靠 resolve 前缀校验兜底
  assert.match(r.body.error, /非法/);
});

test('GET /api/assets/orphans：仅列出未被任何项目 JSON 引用的资源', async () => {
  const orphan = makeAsset('rt_orphan.png');
  const used = makeAsset('rt_used.png');
  makeProject('prj_ref_b', used);
  const r = await run('GET', '/api/assets/orphans');
  assert.equal(r.status, 200);
  const files = r.body.orphans.map((o) => o.file);
  assert.ok(files.includes(orphan), '未引用的进孤儿清单');
  assert.ok(!files.includes(used), '被引用的不进孤儿清单');
  assert.equal(r.body.count, r.body.orphans.length);
  assert.equal(r.body.bytes, r.body.orphans.reduce((s, o) => s + o.bytes, 0));
});

test('POST /api/assets/batch-delete：删除未引用项、跳过被引用项、拦截穿越名', async () => {
  const free = makeAsset('rt_bd_free.png');
  const used = makeAsset('rt_bd_used.png');
  makeProject('prj_ref_c', used);
  const r = await run('POST', '/api/assets/batch-delete', {
    files: [free, used, '../evil.png', 'no_such_file.png'],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.deleted, [free], '未引用项被删除');
  const blockedFiles = r.body.blocked.map((b) => b.file);
  assert.ok(blockedFiles.includes(used), '被引用项进 blocked');
  assert.ok(blockedFiles.includes('../evil.png'), '穿越名被拦截');
  assert.ok(blockedFiles.includes('no_such_file.png'), '不存在的文件报告而非中断');
  assert.ok(fs.existsSync(path.join(ASSET_DIR, used)), '被引用文件仍在磁盘');
  assert.ok(!fs.existsSync(path.join(ASSET_DIR, free)), '未引用文件已删除');
  // bytes 只统计真正删除的
  assert.equal(r.body.bytes, r.body.deleted.length * 4, '按删除文件字节合计');
  // 批删后索引同步：reindex 语义下文件已删则条目消失
  reindex();
  assert.equal(listAssets().find((a) => a.file === free), undefined, '索引同步剔除');
});

test('POST /api/assets/batch-delete：空 files 返回 400', async () => {
  const r = await run('POST', '/api/assets/batch-delete', { files: [] });
  assert.equal(r.status, 400);
});
