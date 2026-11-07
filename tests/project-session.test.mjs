/* 项目会话外壳：进入项目后整页项目化 / 关闭后回列表的纯逻辑回归
 * 覆盖：项目列表页中性文案、工作台 / 画布 / 剧集详情的项目文案、
 *      创作项目与标准流水线项目的页脚统计、资源库入口文案、输入不可变。
 * 运行：node --test tests/project-session.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectChrome } from '../public/project-sidebar.js';

const novel = {
  id: 'prj_1',
  name: '雨夜侦探',
  management: {
    kind: 'novel',
    episodes: [{ no: 1 }, { no: 2 }, { no: 3 }],
  },
  nodes: [{ id: 'n_1' }, { id: 'n_2' }],
  edges: [{ id: 'e_1' }],
};
const standard = {
  id: 'prj_2', name: '示例流水线',
  management: { kind: 'standard' },
  nodes: [{ id: 'n_1' }], edges: [{ id: 'e_1' }, { id: 'e_2' }],
};

test('projectChrome：项目列表页恢复中性文案，不残留项目信息', () => {
  const c = projectChrome(null, { view: 'home', projectCount: 4 });
  assert.equal(c.inProject, false);
  assert.equal(c.brandTitle, 'lingximanju');
  assert.equal(c.brandSub, '无限画布 · 智能体制片');
  assert.equal(c.homeStatus, '共 4 个项目');
  assert.ok(c.foot.includes('data/'));
  assert.equal(c.assetLibTitle.includes('本项目'), false);
  // 即便 state 里还误留着项目对象，只要回到列表页也按中性文案渲染
  assert.deepEqual(projectChrome(novel, { view: 'home', projectCount: 4 }), c);
});

test('projectChrome：工作台只讲当前项目（品牌 / 页脚 / 资源库入口）', () => {
  const c = projectChrome(novel, { view: 'workshop', projectCount: 9 });
  assert.equal(c.inProject, true);
  assert.equal(c.brandTitle, '项目工作台');
  assert.equal(c.brandSub, '雨夜侦探');
  assert.ok(c.foot.includes('本项目'));
  assert.ok(c.foot.includes('3 集'));
  assert.ok(c.foot.includes('2 节点'));
  assert.equal(c.homeStatus, '');
  assert.ok(c.assetLibTitle.includes('雨夜侦探'));
});

test('projectChrome：剧集详情带集号，画布视图切换品牌标题', () => {
  const ep = projectChrome(novel, { view: 'episode', episodeNo: 2, projectCount: 1 });
  assert.equal(ep.brandTitle, '剧集详情');
  assert.equal(ep.brandSub, '雨夜侦探 · 第 2 集');
  assert.equal(projectChrome(novel, { view: 'episode' }).brandSub, '雨夜侦探 · 第 1 集');
  assert.equal(projectChrome(novel, { view: 'canvas' }).brandTitle, '画布编辑');
  assert.equal(projectChrome(novel, { view: 'unknown' }).brandTitle, '项目工作台', '未知视图回退到工作台');
});

test('projectChrome：标准流水线项目页脚用节点 / 连线而不是集数', () => {
  const c = projectChrome(standard, { view: 'canvas' });
  assert.ok(c.foot.includes('1 节点'));
  assert.ok(c.foot.includes('2 连线'));
  assert.equal(c.foot.includes('集'), false);
});

test('projectChrome：容错与纯函数（不修改项目对象）', () => {
  const c = projectChrome({}, { view: 'workshop' });
  assert.equal(c.inProject, true);
  assert.equal(c.brandSub, '未命名项目');
  assert.ok(c.foot.includes('0 节点'));
  const snapshot = JSON.stringify(novel);
  projectChrome(novel, { view: 'episode', episodeNo: 3 });
  assert.equal(JSON.stringify(novel), snapshot);
  assert.deepEqual(projectChrome(undefined), projectChrome(null));
});
