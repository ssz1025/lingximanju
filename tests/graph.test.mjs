/* 图算法单元测试：拓扑分层 / 上下游子图 / 自动布局 / DAG 校验
 * 运行：node --test tests/graph.test.mjs
 * graph.mjs 是纯函数模块，无 I/O，直接静态导入即可
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  indexEdges, descendants, ancestors, topoLayers, subgraph, autoLayout, validate,
} from '../src/core/graph.mjs';

const N = (...ids) => ids.map((id) => ({ id }));
const E = (from, to, kind) => ({ from, to, ...(kind ? { kind } : {}) });

test('indexEdges：出入邻接表成对建立', () => {
  const { out, inc } = indexEdges([E('a', 'b'), E('a', 'c'), E('b', 'c')]);
  assert.deepEqual(out.get('a'), ['b', 'c']);
  assert.deepEqual(inc.get('c'), ['a', 'b']);
});

test('descendants / ancestors：菱形依赖闭包完整，根/叶自含', () => {
  // a → b → d, a → c → d
  const edges = [E('a', 'b'), E('a', 'c'), E('b', 'd'), E('c', 'd')];
  assert.deepEqual([...descendants(edges, 'a')].sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual([...descendants(edges, 'b')].sort(), ['b', 'd']);
  assert.deepEqual([...ancestors(edges, 'd')].sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual([...ancestors(edges, 'a')], ['a']);
  assert.deepEqual([...descendants(edges, 'ghost')], ['ghost'], '未知根返回自身');
});

test('topoLayers：同层可并发、跨层有序；环被识别为 cycles', () => {
  const nodes = N('a', 'b', 'c', 'd');
  const { layers, order, hasCycle } = topoLayers(nodes, [E('a', 'b'), E('a', 'c'), E('b', 'd'), E('c', 'd')]);
  assert.deepEqual(layers, [['a'], ['b', 'c'], ['d']]);
  assert.equal(order.length, 4);
  assert.equal(hasCycle, false);

  const cyc = topoLayers(N('a', 'b', 'c'), [E('a', 'b'), E('b', 'c'), E('c', 'a')]);
  assert.equal(cyc.hasCycle, true);
  assert.deepEqual(cyc.cycles.sort(), ['a', 'b', 'c']);
  assert.deepEqual(cyc.layers, [], '环节点不进任何层');

  // 指向不存在节点的边不参与分层，也不算环
  const dangling = topoLayers(N('a'), [E('a', 'ghost')]);
  assert.equal(dangling.hasCycle, false);
  assert.deepEqual(dangling.layers, [['a']]);
});

test('subgraph：只保留集合内节点及其内部边', () => {
  const g = subgraph(N('a', 'b', 'c'), [E('a', 'b'), E('b', 'c')], new Set(['a', 'b']));
  assert.deepEqual(g.nodes.map((n) => n.id), ['a', 'b']);
  assert.deepEqual(g.edges, [E('a', 'b')]);
});

test('autoLayout：anchor/ref 不参与分层；环节点沉底且全员有坐标', () => {
  const nodes = N('a', 'b', 'c');
  // 若 ref 边参与分层会多出一层；flow 才是执行依赖 → 只有 a→b 影响排布
  const edges = [E('a', 'b'), E('b', 'c', 'ref')];
  const pos = autoLayout(nodes, edges);
  assert.equal(pos.c.x, pos.a.x, 'ref 不算依赖 → c 与 a 同层（第 0 列），b 单独在第 1 列');
  assert.ok(pos.b.x > pos.a.x, 'flow 依赖才拉开列距');
  for (const n of nodes) assert.ok(Number.isFinite(pos[n.id].x) && Number.isFinite(pos[n.id].y));

  const cyc = autoLayout(N('x', 'y'), [E('x', 'y'), E('y', 'x')]);
  assert.ok(Number.isFinite(cyc.x.x) && Number.isFinite(cyc.y.x), '环节点也有兜底坐标');
  assert.ok(cyc.y.y > 60, '环节点排在常规层下方');
});

test('validate：悬空边计数与环同时报告', () => {
  assert.deepEqual(validate(N('a', 'b'), [E('a', 'b')]), { ok: true, dangling: 0, cycles: [] });
  assert.deepEqual(validate(N('a'), [E('a', 'ghost')]), { ok: false, dangling: 1, cycles: [] });
  const r = validate(N('a', 'b'), [E('a', 'b'), E('b', 'a')]);
  assert.equal(r.ok, false);
  assert.equal(r.dangling, 0);
  assert.deepEqual(r.cycles.sort(), ['a', 'b']);
});
