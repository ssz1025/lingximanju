import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_CANVAS_PROJECT, groupScopeOptions, scopeOptionsSignature, scopeHint, isScopeReadOnly,
} from '../public/canvas-scope.js';

const OPTIONS = [
  { key: 'overall', label: '全部 · 组合画布', group: '总览' },
  { key: 'main', label: '项目主画布', group: '总览' },
  { divider: true, label: '第 1 季' },
  { key: 'ep:1', label: '第 1 集 · 段落 1' },
  { key: 'ep:2', label: '第 2 集 · 段落 2' },
  { divider: true, label: '第 2 季' },
  { key: 'ep:3', label: '第 3 集 · 段落 3' },
];

test('groupScopeOptions：按 divider 切分季，首组为总览', () => {
  const g = groupScopeOptions(OPTIONS);
  assert.deepEqual(g.map((x) => x.label), ['总览', '第 1 季', '第 2 季']);
  assert.deepEqual(g[0].items.map((x) => x.key), ['overall', 'main']);
  assert.deepEqual(g[1].items.map((x) => x.key), ['ep:1', 'ep:2']);
  assert.deepEqual(g[2].items.map((x) => x.key), ['ep:3']);
});

test('groupScopeOptions：空组不输出、无 label 的 divider 回退「分集」、rootLabel 可自定义', () => {
  assert.deepEqual(groupScopeOptions([]), []);
  assert.deepEqual(groupScopeOptions([{ divider: true }, { key: 'ep:1' }]).map((g) => g.label), ['分集']);
  assert.deepEqual(groupScopeOptions([{ divider: true }]), [], '只有 divider 没有条目时不产生空组');
  assert.equal(groupScopeOptions([{ key: 'overall' }], '根')[0].label, '根');
  assert.equal(groupScopeOptions(null).length, 0);
  assert.deepEqual(groupScopeOptions([{ key: 'a' }, null, { divider: true }, { key: 'b' }])
    .map((g) => g.items.length), [1, 1]);
});

test('groupScopeOptions：不修改入参，返回全新分组对象', () => {
  const before = JSON.stringify(OPTIONS);
  const g = groupScopeOptions(OPTIONS);
  assert.equal(JSON.stringify(OPTIONS), before, '纯函数不可变');
  assert.equal(g[0].items[0], OPTIONS[0], '条目只读共享，分组容器是新建的');
  g[0].items.push({ key: 'x' });
  assert.equal(JSON.stringify(OPTIONS), before, '改动返回的分组容器不影响入参数组');
});

test('scopeOptionsSignature：稳定、含项目 id、选项变化即变化', () => {
  const g = groupScopeOptions(OPTIONS);
  const sig = scopeOptionsSignature('prj_1', g);
  assert.equal(sig, scopeOptionsSignature('prj_1', groupScopeOptions(OPTIONS)), '同输入签名稳定');
  assert.notEqual(sig, scopeOptionsSignature('prj_2', g), '切换项目必须重建');
  assert.ok(sig.startsWith('prj_1|'));
  assert.ok(sig.includes('第 2 季:ep:3'));
  assert.notEqual(sig, scopeOptionsSignature('prj_1', g.slice(0, 2)), '少一季即不同');
  assert.equal(scopeOptionsSignature(null, []), '|', '空项目也返回确定性字符串');
});

test('scopeHint：三种范围文案与集数', () => {
  assert.equal(scopeHint('overall', 8), '组合 8 集 · 双击节点进入该集');
  assert.equal(scopeHint('overall'), '组合 0 集 · 双击节点进入该集');
  assert.equal(scopeHint('main'), '项目主画布 · 可编辑 / 可运行');
  assert.equal(scopeHint('episode'), '本集独立画布 · 可编辑');
  assert.equal(scopeHint('unknown'), '本集独立画布 · 可编辑');
});

test('isScopeReadOnly：只有「有项目 + 画布视图 + 组合范围」三者同时成立才只读', () => {
  const p = { id: 'prj_1' };
  assert.equal(isScopeReadOnly(p, 'canvas', 'overall'), true);
  assert.equal(isScopeReadOnly(p, 'workshop', 'overall'), false, '工作台不受限');
  assert.equal(isScopeReadOnly(null, 'canvas', 'overall'), false, '未打开项目不受限');
  assert.equal(isScopeReadOnly(p, 'canvas', 'main'), false);
  assert.equal(isScopeReadOnly(p, 'canvas', 'ep:1'), false);
  assert.equal(isScopeReadOnly(p, 'episode', 'ep:1'), false);
});

test('EMPTY_CANVAS_PROJECT：空壳结构完整，不含任何上一个项目的内容', () => {
  assert.deepEqual(Object.keys(EMPTY_CANVAS_PROJECT).sort(),
    ['edges', 'id', 'management', 'name', 'nodes', 'settings'].sort());
  assert.equal(EMPTY_CANVAS_PROJECT.id, '');
  assert.deepEqual(EMPTY_CANVAS_PROJECT.nodes, []);
  assert.deepEqual(EMPTY_CANVAS_PROJECT.edges, []);
});
