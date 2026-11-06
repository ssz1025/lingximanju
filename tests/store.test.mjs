/* store 持久层单元测试：uid / 资产路径清洗 / 项目存取与列表缓存 / 快照封顶
 * 运行：node --test tests/store.test.mjs
 * 必须先把数据目录指到临时目录再动态导入（ESM import 会提升），避免污染真实 data/
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-store-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const {
  uid, listProjects, loadProject, saveProject, deleteProject,
  writeAsset, writeAssetBinary, readAsset, assetPath, ASSET_DIR, PROJECT_DIR,
  writeSnapshot, listSnapshots, readSnapshot,
} = await import('../src/core/store.mjs');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const mkProject = (id, name) => ({
  id, name, mode: 'idea2video', nodes: [], edges: [],
  createdAt: Date.now(), updatedAt: Date.now(),
});

test('uid：高频生成不重复', () => {
  const set = new Set();
  for (let i = 0; i < 5000; i += 1) set.add(uid('prj'));
  assert.equal(set.size, 5000);
});

test('资产路径清洗：../ 与非法字符被剥离，文件始终落在 ASSET_DIR 内', () => {
  const url = writeAsset('../evil.txt', 'x');
  assert.equal(url, '/assets/..evil.txt', '斜杠等分隔符全部剥离，只剩文件名 → 不可能逃出 ASSET_DIR');
  assert.ok(fs.existsSync(path.join(ASSET_DIR, '..evil.txt')));
  assert.equal(fs.existsSync(path.join(PROJECT_DIR, '..', 'evil.txt')), false, '不得写出资产目录');
  assert.equal(readAsset('../../etc/passwd'), null, '穿越读取清洗后不存在 → null');
  assert.ok(assetPath('a/b\\c:d.png').startsWith(ASSET_DIR), 'assetPath 始终在 ASSET_DIR 下');
  writeAssetBinary('bin.dat', Buffer.from([1, 2, 3]));
  assert.deepEqual(readAsset('bin.dat'), Buffer.from([1, 2, 3]));
});

test('save/load/delete + 列表缓存失效：同毫秒连改也能读到最新索引', () => {
  const p = mkProject('prj_c1', '缓存甲');
  saveProject(p);
  assert.equal(loadProject('prj_c1').name, '缓存甲');
  assert.ok(listProjects().find((x) => x.id === 'prj_c1' && x.name === '缓存甲'));

  // 同毫秒内改名再存：必须绕过缓存（saveProject 主动失效，不依赖 mtime 变化）
  const again = loadProject('prj_c1');
  again.name = '缓存乙';
  saveProject(again);
  const hit = listProjects().find((x) => x.id === 'prj_c1');
  assert.equal(hit.name, '缓存乙', '列表索引已失效重建');

  // 损坏的 JSON 不阻断列表，也不进缓存
  fs.writeFileSync(path.join(PROJECT_DIR, 'broken.json'), '{oops', 'utf8');
  assert.equal(loadProject('broken'), null);
  assert.ok(!listProjects().some((x) => x.id === 'broken'));
  fs.rmSync(path.join(PROJECT_DIR, 'broken.json'));

  deleteProject('prj_c1');
  assert.equal(loadProject('prj_c1'), null);
  assert.ok(!listProjects().some((x) => x.id === 'prj_c1'), '删除后立即从列表消失');
});

test('快照封顶：连拍 25 份只留最新 20 份，同毫秒不互相覆盖', () => {
  const p = mkProject('prj_s1', '快照项目');
  saveProject(p);
  const seen = new Set();
  for (let i = 0; i < 25; i += 1) {
    p.name = `快照项目-${i}`;
    const s = writeSnapshot(p);
    assert.ok(!seen.has(s.at), '时间戳必须唯一');
    seen.add(s.at);
  }
  const dir = path.join(TMP, 'snapshots', 'prj_s1');
  const onDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(onDisk.length, 20, '磁盘硬封顶');

  const list = listSnapshots('prj_s1');
  assert.equal(list.length, 20);
  assert.ok(list[0].at > list[1].at, '按时间倒序');
  assert.equal(list[0].name, '快照项目-24', '最新一份在最前');

  const latest = readSnapshot('prj_s1', list[0].at);
  assert.equal(latest.name, '快照项目-24');
  const prunedAt = Math.min(...seen);
  assert.equal(readSnapshot('prj_s1', prunedAt), null, '最旧快照已被修剪');
});
