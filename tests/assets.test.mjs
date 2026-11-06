/* 资源索引单元测试：自动收录 / 打标改名 / 重扫 / 角色优先匹配
 * 运行：node --test tests/assets.test.mjs
 * 必须先把数据目录指到临时目录再动态导入（ESM import 会提升），避免污染真实 data/
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-assets-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const {
  listAssets, getAsset, registerAsset, updateAsset, forgetAsset,
  reindex, matchCharacters, normalizeCharName, assetStats, inferKind, ASSET_KINDS,
} = await import('../src/core/assets.mjs');
const { writeAsset, writeAssetBinary, ASSET_DIR } = await import('../src/core/store.mjs');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('inferKind：按文件名推断资源类型', () => {
  assert.equal(inferKind('cover_prj_x_ab.png'), 'cover');
  assert.equal(inferKind('char_李长歌.svg'), 'character');
  assert.equal(inferKind('portrait_a.png'), 'character');
  assert.equal(inferKind('comfy_x.png'), 'image');
  assert.equal(inferKind('clip_1.mp4'), 'video');
  assert.equal(inferKind('dir_pack.zip'), 'pack');
  assert.equal(inferKind('weird.bin'), 'other');
});

test('listAssets：新文件自动收录，index.json 落盘且不含目录项', () => {
  writeAsset('auto_1.svg', '<svg/>');
  writeAssetBinary('auto_2.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const list = listAssets();
  const files = list.map((a) => a.file);
  assert.ok(files.includes('auto_1.svg'), '新 SVG 自动收录');
  assert.ok(files.includes('auto_2.png'), '新 PNG 自动收录');
  assert.ok(!files.includes('index.json'), '索引文件自身不作为资源');
  const one = getAsset('auto_1.svg');
  assert.equal(one.kind, 'image');
  assert.equal(one.type, 'image');
  assert.ok(one.id.startsWith('ast_'), '分配稳定 id');
  // 索引真实写盘
  const raw = JSON.parse(fs.readFileSync(path.join(ASSET_DIR, 'index.json'), 'utf8'));
  assert.ok(Array.isArray(raw.entries) && raw.entries.length >= 2);
});

test('registerAsset + updateAsset：打标签共享、改名与校验', () => {
  writeAsset('char_test.png', 'x');
  const e = registerAsset({
    file: 'char_test.png', kind: 'character', name: '李长歌',
    tags: ['角色', '古装'], sourceProjectId: 'prj_a', sourceProjectName: '项目甲',
  });
  assert.equal(e.kind, 'character');
  assert.deepEqual(e.tags, ['角色', '古装']);
  assert.equal(e.sourceProjectName, '项目甲');

  // 幂等覆盖：再登记只改允许的字段，id 不变
  const again = registerAsset({ file: 'char_test.png', tags: ['角色', '女主'] });
  assert.equal(again.id, e.id, '同文件 id 稳定');
  assert.deepEqual(again.tags, ['角色', '女主']);
  assert.equal(again.sourceProjectName, '项目甲', '未传字段保留旧值');

  // 改名 + 标签字符串（逗号分隔）+ 改类型
  const up = updateAsset('char_test.png', { name: '李长歌 · 三视图', tags: '角色, 古装, 女主', kind: 'image' });
  assert.equal(up.ok, true);
  assert.equal(up.asset.name, '李长歌 · 三视图');
  assert.deepEqual(up.asset.tags, ['角色', '古装', '女主']);
  assert.equal(up.asset.kind, 'image');

  // 校验：非法类型 / 空名 / 不存在
  assert.equal(updateAsset('char_test.png', { kind: 'banana' }).ok, false);
  assert.equal(updateAsset('char_test.png', { name: '   ' }).ok, false);
  assert.equal(updateAsset('nope.png', { name: 'x' }).ok, false);

  // 超长标签截断到 12 个
  const many = updateAsset('char_test.png', { tags: Array.from({ length: 20 }, (_, i) => `t${i}`) });
  assert.equal(many.asset.tags.length, 12);
});

test('reindex：手动删文件后剔除、未编辑条目按文件名修正类型', () => {
  writeAsset('re_a.png', 'x');
  writeAsset('re_b.mp4', 'x');
  listAssets(); // 触发收录
  assert.ok(getAsset('re_a.png'));

  fs.unlinkSync(path.join(ASSET_DIR, 're_a.png'));
  const r1 = reindex();
  assert.equal(getAsset('re_a.png'), null, '已删除文件从索引剔除');
  assert.ok(r1.removed >= 1);

  // 未编辑的条目：文件被换成别的类型 → kind 跟着文件名走
  fs.renameSync(path.join(ASSET_DIR, 're_b.mp4'), path.join(ASSET_DIR, 're_b.png'));
  reindex();
  assert.equal(getAsset('re_b.png').kind, 'image');
  assert.equal(getAsset('re_b.mp4'), null);

  // 手动打过标的条目：重扫不覆盖用户元数据
  registerAsset({ file: 're_b.png', kind: 'cover', name: '我的封面', tags: ['封面'] });
  reindex();
  const kept = getAsset('re_b.png');
  assert.equal(kept.kind, 'cover', 'userEdited 条目重扫保留类型');
  assert.equal(kept.name, '我的封面');
  assert.deepEqual(kept.tags, ['封面']);
  fs.rmSync(path.join(ASSET_DIR, 're_b.png'), { force: true });
  reindex();
});

test('normalizeCharName：全角/空白/称谓归一，便于跨项目同名匹配', () => {
  assert.equal(normalizeCharName('李 长歌'), '李长歌');
  assert.equal(normalizeCharName('李长歌小姐'), '李长歌', '常见称谓后缀剥离');
  assert.equal(normalizeCharName('Ｗａｎｇ Ｘｉａｏ'), 'wangxiao', '全角字母归一');
  assert.equal(normalizeCharName('王-小明'), '王小明');
  assert.equal(normalizeCharName(''), '');
  assert.equal(normalizeCharName(null), '');
});

test('matchCharacters：按名优先命中、含空格变体命中、未登记角色落空', () => {
  writeAsset('m_char.png', 'x');
  registerAsset({ file: 'm_char.png', kind: 'character', name: '赵云', tags: ['角色', '三国'] });
  writeAsset('m_other.png', 'x');
  registerAsset({ file: 'm_other.png', kind: 'image', name: '风景', tags: ['场景'] });

  const r = matchCharacters([
    { name: '赵云' },
    { name: '赵 云' },        // 空格变体 → 同一资源
    { name: '诸葛亮' },       // 未登记 → 不命中
  ]);
  assert.equal(r.total, 3);
  assert.equal(r.reused, 2, '同名与空格变体各命中一次');
  assert.equal(r.map['赵云'].file, 'm_char.png');
  assert.equal(r.map['赵 云'].file, 'm_char.png');
  assert.ok(!r.map['诸葛亮'], '未生成过的角色不误配');
  assert.ok(r.map['赵云'].score >= 60);

  // 只有 kind=character 或带「角色」标签的资源进候选池
  assert.ok(!Object.values(r.map).some((a) => a.file === 'm_other.png'), '普通图片不进角色池');
});

test('assetStats：按类型聚合与标签计数', () => {
  const s = assetStats();
  assert.ok(s.total >= 4);
  assert.ok(s.bytes > 0);
  assert.equal(Object.keys(s.byKind).length > 0, true);
  assert.ok(s.tagCount >= 2, '统计到已打的标签');
  for (const k of Object.keys(s.byKind)) assert.ok(ASSET_KINDS.includes(k), 'kind 必须在白名单内');
});

test('forgetAsset：清索引条目；文件仍在磁盘时下次列表会自动重收录（磁盘为事实来源）', () => {
  writeAsset('forget_me.png', 'x');
  registerAsset({ file: 'forget_me.png', name: '临时' });
  assert.ok(getAsset('forget_me.png'));
  assert.equal(forgetAsset('forget_me.png'), true);
  // 文件还在 → listAssets 按「磁盘定存在」语义重新收录（未编辑条目按文件名推断类型）
  const back = getAsset('forget_me.png');
  assert.ok(back, '文件未删则自动重收录');
  assert.equal(back.name, 'forget_me', '重收录的是新条目，旧的用户元数据已丢弃');
  assert.equal(forgetAsset('forget_me.png'), true, '重收录后仍可再次移除');
  // 文件删除后彻底消失
  fs.rmSync(path.join(ASSET_DIR, 'forget_me.png'), { force: true });
  reindex();
  assert.equal(getAsset('forget_me.png'), null, '文件删除后索引剔除');
});
