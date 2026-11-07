/* 项目会话「全部和打开的项目相关」：模型按项目记忆、页面标题、画布工具统计
 * 覆盖：modelScopeKey 项目隔离 / 无项目回退、projectChrome 的 title、
 *      collectToolStats 按本项目节点图统计类型与智能体、容错与纯函数不可变。
 * 运行：node --test tests/project-scope.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelScopeKey, pickedModelId, setModelProjectScope } from '../public/model-picker.js';
import { projectChrome, collectToolStats } from '../public/project-sidebar.js';

const novel = {
  id: 'prj_1', name: '雨夜侦探', mode: 'novel',
  management: { kind: 'novel', episodes: [{ no: 1 }, { no: 2 }, { no: 3 }] },
  nodes: [{ id: 'n_1' }, { id: 'n_2' }], edges: [{ id: 'e_1' }],
};

test('modelScopeKey：每个项目的模型选择互相隔离，关闭后回退应用级默认', () => {
  assert.equal(modelScopeKey('run'), 'lm.model.run');
  assert.equal(modelScopeKey('run', ''), 'lm.model.run');
  assert.equal(modelScopeKey('run', 'prj_1'), 'lm.model.run.p_prj_1');
  assert.equal(modelScopeKey('run', 'prj_2'), 'lm.model.run.p_prj_2');
  assert.notEqual(modelScopeKey('bible', 'prj_1'), modelScopeKey('run', 'prj_1'), '同一项目不同入口也要分开');
  assert.notEqual(modelScopeKey('run', 'prj_1'), modelScopeKey('run', 'prj_2'), '不同项目不能串');
});

test('模型作用域在无 DOM / 无 localStorage 环境下安全回退', () => {
  assert.doesNotThrow(() => setModelProjectScope('prj_1', '雨夜侦探'));
  assert.equal(pickedModelId('run'), '');
  assert.doesNotThrow(() => setModelProjectScope(''));
  assert.equal(modelScopeKey('run', null), 'lm.model.run');
});

test('projectChrome：浏览器标签标题只讲当前项目，关闭后恢复中性', () => {
  assert.equal(projectChrome(null, { view: 'home', projectCount: 2 }).title, 'lingximanju · 项目列表');
  assert.equal(projectChrome(novel, { view: 'workshop' }).title, '雨夜侦探 · 项目工作台');
  assert.equal(projectChrome(novel, { view: 'canvas' }).title, '雨夜侦探 · 画布编辑');
  assert.equal(projectChrome(novel, { view: 'episode', episodeNo: 2 }).title, '雨夜侦探 · 剧集详情 · 第 2 集');
  // 即便 state 里还残留项目对象，回到列表页也必须用中性标题
  assert.equal(projectChrome(novel, { view: 'home' }).title, 'lingximanju · 项目列表');
});

test('collectToolStats：模板 / 节点类型 / 智能体都按本项目节点图统计', () => {
  const project = {
    id: 'prj_2', mode: 'novel',
    nodes: [
      { type: 'idea', agent: null }, { type: 'script', agent: null },
      { type: 'idea', agent: 'custom-agent' }, { type: 'note', agent: null },
    ],
  };
  const nodeTypes = { idea: { agent: 'screenwriter' }, script: { agent: 'screenwriter' }, note: { agent: null } };
  const s = collectToolStats(project, nodeTypes);
  assert.equal(s.nodeCount, 4);
  assert.equal(s.typeCount.idea, 2);
  assert.equal(s.typeCount.script, 1);
  assert.equal(s.agentCount.screenwriter, 2, '节点未写 agent 时回退 NODE_TYPES 定义');
  assert.equal(s.agentCount['custom-agent'], 1, '节点自带 agent 优先');
  assert.equal(s.agentCount.note, undefined, '无智能体的节点不计数');
  assert.equal(s.templateId, 'novel', '当前模板用于标「当前」');
});

test('collectToolStats：空项目 / 容错 / 纯函数不可变', () => {
  const empty = collectToolStats(null);
  assert.deepEqual(empty, { typeCount: {}, agentCount: {}, nodeCount: 0, templateId: '' });
  assert.deepEqual(collectToolStats({ nodes: 'bad' }), empty);
  const project = { mode: 'tpl_a', nodes: [{ type: 'idea', agent: 'a' }, {}] };
  const snapshot = JSON.stringify(project);
  const s = collectToolStats(project, {});
  assert.equal(s.nodeCount, 2);
  assert.equal(s.agentCount.a, 1);
  assert.equal(JSON.stringify(project), snapshot, '不得修改项目对象');
});
