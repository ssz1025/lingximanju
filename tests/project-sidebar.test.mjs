/* 项目侧栏：当前项目资源归属的纯逻辑回归
 * 覆盖：项目 JSON 递归引用提取、去重、资产索引元数据合并、sourceProjectId 补充、
 *      类型/分类推断、排序与输入不可变。
 * 运行：node --test tests/project-sidebar.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectProjectAssets } from '../public/project-sidebar.js';

const project = {
  id: 'prj_1',
  name: '雨夜侦探',
  management: {
    cover: { url: '/assets/cover_a.png?t=2' },
    characters: [{ name: '沈砚', views: { front: { url: '/assets/char_1.png' } } }],
    episodes: [{ no: 1, gridUrl: '/assets/grid_1.svg', pack: '/assets/ep1.mmxpack.zip' }],
    bible: { logline: '一个雨夜的故事' },
  },
  nodes: [{ id: 'n_1', data: { film: { file: '/assets/final.mp4' }, note: '无关注释 /assets/.gitkeep 与 /other/x.png' } }],
};

const index = [
  { file: 'cover_a.png', url: '/assets/cover_a.png', kind: 'cover', type: 'image', name: '雨夜封面', bytes: 2048, createdAt: 300, tags: ['封面'] },
  { file: 'char_1.png', kind: 'character', type: 'image', name: '沈砚·正面', bytes: 1024, createdAt: 200 },
  { file: 'final.mp4', kind: 'video', type: 'video', bytes: 999999, createdAt: 100 },
  { file: 'extra.png', sourceProjectId: 'prj_1', kind: 'image', type: 'image', createdAt: 400 },
  { file: 'other.png', sourceProjectId: 'prj_2', kind: 'image', type: 'image', createdAt: 500 },
  { file: '.gitkeep', sourceProjectId: 'prj_1', kind: 'other', type: 'other', createdAt: 600 },
];

test('collectProjectAssets：递归收集嵌套引用，去重并排除非项目资源', () => {
  const out = collectProjectAssets(project, index);
  const files = out.map((a) => a.file);
  assert.equal(out.length, 6, '5 个引用 + 1 个索引里属于本项目的资源');
  assert.ok(files.includes('cover_a.png'));
  assert.ok(files.includes('char_1.png'));
  assert.ok(files.includes('grid_1.svg'));
  assert.ok(files.includes('ep1.mmxpack.zip'));
  assert.ok(files.includes('final.mp4'));
  assert.ok(files.includes('extra.png'));
  assert.equal(files.includes('other.png'), false, '别的项目资源不能串进来');
  assert.equal(files.includes('.gitkeep'), false, '占位文件不算资源');
  assert.equal(files.includes('x.png'), false, '非 /assets/ 路径不收录');
  assert.equal(new Set(files).size, files.length, '同一文件在多个位置被引用只出现一次');
});

test('collectProjectAssets：元数据合并、类型/分类推断与 referenced 标记', () => {
  const map = Object.fromEntries(collectProjectAssets(project, index).map((a) => [a.file, a]));
  assert.equal(map['cover_a.png'].name, '雨夜封面');
  assert.equal(map['cover_a.png'].kind, 'cover');
  assert.equal(map['cover_a.png'].type, 'image');
  assert.equal(map['cover_a.png'].bytes, 2048);
  assert.deepEqual(map['cover_a.png'].tags, ['封面']);
  assert.equal(map['cover_a.png'].referenced, true);
  assert.equal(map['extra.png'].referenced, false, '仅由索引归属，项目里没有引用');
  assert.equal(map['char_1.png'].kind, 'character');
  assert.equal(map['char_1.png'].type, 'image');
  assert.equal(map['grid_1.svg'].type, 'image', 'SVG 宫格图归为图片');
  assert.equal(map['final.mp4'].type, 'video');
  assert.equal(map['ep1.mmxpack.zip'].type, 'pack', '导演包 zip 单独归类');
  assert.equal(map['ep1.mmxpack.zip'].url, '/assets/ep1.mmxpack.zip');
});

test('collectProjectAssets：按创建时间倒序，无索引时按扩展名兜底', () => {
  const out = collectProjectAssets(project, index);
  assert.deepEqual(out.slice(0, 4).map((a) => a.file), ['extra.png', 'cover_a.png', 'char_1.png', 'final.mp4']);
  const bare = collectProjectAssets({ id: 'p', management: { cover: { url: '/assets/only.webp' } } }, []);
  assert.equal(bare.length, 1);
  assert.equal(bare[0].name, 'only.webp');
  assert.equal(bare[0].type, 'image');
  assert.equal(bare[0].kind, 'image');
  assert.equal(bare[0].url, '/assets/only.webp');
  assert.equal(bare[0].bytes, 0);
});

test('collectProjectAssets：带 query / URL 编码 / 引号边界的引用也能识别', () => {
  const p = { id: 'p2', nodes: [{ data: {
    a: 'url("/assets/a%20b.png")',
    b: "'/assets/clip.mp4#t=1'",
    c: '/assets/a%20b.png?v=9',
    d: '/assets/no-extension',
    e: 'data:image/svg+xml,<svg></svg>',
  } }] };
  const out = collectProjectAssets(p, []);
  assert.deepEqual(new Set(out.map((a) => a.file)), new Set(['a b.png', 'clip.mp4']));
  assert.equal(out.find((a) => a.file === 'clip.mp4').type, 'video');
});

test('collectProjectAssets：空输入与纯函数（不修改 project / index）', () => {
  assert.deepEqual(collectProjectAssets(null, index), []);
  assert.deepEqual(collectProjectAssets({}, []), []);
  const snapshot = JSON.stringify(project);
  const indexSnapshot = JSON.stringify(index);
  collectProjectAssets(project, index);
  assert.equal(JSON.stringify(project), snapshot);
  assert.equal(JSON.stringify(index), indexSnapshot);
});
