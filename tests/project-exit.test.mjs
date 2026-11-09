/* ============================================================================
 * 项目退出出口契约（2026-11-08）
 *
 * 需求：从项目列表进入项目工作台后，只有两处能退出项目会话——
 *   1) 顶栏右上角「⇦ 退出项目」（#btn-close-project）
 *   2) 左侧「项目设置 → 退出项目」（[data-act="exit-project"]）
 * 曾经的侧栏项目卡 ✕ / ⌂ 项目列表 / 剧集面包屑「✕ 关闭项目」/ H 快捷键
 * 一律不再是用户出口；项目被删除或外部移除时的自动收尾属于内部清理，
 * 仍直接走 closeProject({ silent: true })。
 *
 * 这是一份结构契约测试：直接读源码，防止日后重构时又把退出入口散落各处。
 * ==========================================================================*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const count = (src, re) => (src.match(re) || []).length;

const html = read('public/index.html');
const app = read('public/app.js');
const sidebar = read('public/project-sidebar.js');
const panels = read('public/panels.js');
const css = read('public/styles.css');

test('顶栏右上角有且只有一个明确标注的「退出项目」按钮', () => {
  const buttons = html.match(/<button[^>]*id="btn-close-project"[^>]*>[\s\S]*?<\/button>/g) || [];
  assert.equal(buttons.length, 1, '页面骨架里只保留一个顶栏退出按钮');
  const btn = buttons[0];
  assert.match(btn, /⇦\s*退出项目/, '按钮文字明确，不再是一个含义模糊的 ✕');
  assert.match(btn, /\bhidden\b/, '默认隐藏，由 updateHeader / updateChrome / setView 控制显隐');
  assert.ok(html.indexOf(btn) > html.indexOf('class="tb-right"'), '按钮位于顶栏右侧 tb-right');
  assert.ok(html.indexOf(btn) > html.indexOf('id="btn-more"'), '按钮在「更多」菜单之后，即最右侧');
});

test('页面骨架不再提供其它退出项目的入口', () => {
  assert.doesNotMatch(html, /id="btn-home"/, '移除 ⌂ 项目列表按钮');
  assert.doesNotMatch(html, /ps-home-btn/, '侧栏项目卡不再生成 ✕');
  assert.doesNotMatch(html, /✕ 关闭项目/, '不再有面包屑式关闭按钮');
  assert.doesNotMatch(html, /data-crumb="home"/, '面包屑不再指向 home');
  assert.doesNotMatch(html, /\(H\)/, '按钮标题不再宣传 H 快捷键');
});

test('「项目设置」提供唯一的设置侧退出项，且事件只走 onExitProject', () => {
  assert.equal(count(sidebar, /data-act="exit-project"/g), 1, '设置区恰好一个退出按钮');
  assert.ok(
    sidebar.indexOf('data-act="exit-project"') > sidebar.indexOf('<span>项目设置</span>'),
    '退出项位于「项目设置」区块内',
  );
  assert.match(sidebar, /case 'exit-project': c\.onExitProject\?\.\(\)/, 'onClick 委托到统一回调');
  assert.doesNotMatch(sidebar, /data-act="home"/, '旧的 home 出口已移除');
  assert.doesNotMatch(sidebar, /ps-home-btn/, '项目卡 ✕ 样式与结构已移除');
  assert.doesNotMatch(sidebar, /onHome/, 'ctx 不再暴露 onHome');
});

test('app.js 只有 requestExitProject 一个用户出口，两处 UI 都调它', () => {
  assert.equal(count(app, /function requestExitProject\(\)/g), 1, '统一出口函数唯一');
  assert.match(app, /if \(!state\.project \|\| state\.view === 'home'\)/, '无项目 / 已在列表页时直接忽略');
  assert.match(app, /onExitProject: requestExitProject/, '侧栏回调指向统一出口');
  assert.match(app, /\$\('btn-close-project'\)\.addEventListener\('click', requestExitProject\)/, '顶栏按钮指向统一出口');
  assert.equal(count(app, /closeProject\(\)/g), 1, '无参 closeProject() 只在统一函数里出现一次');
  assert.equal(
    count(app, /^\s*await closeProject\(\{ silent: true \}\);/gm), 2,
    '删除 / 外部移除两处内部清理保留（注释里的说明不计入）',
  );

  assert.doesNotMatch(app, /\$\('btn-home'\)/, '不再操作 ⌂ 项目列表按钮');
  assert.doesNotMatch(app, /data-crumb="home"/, '面包屑不再提供关闭项目');
  assert.doesNotMatch(app, /k === 'h'/, 'H 不再是退出快捷键');
  assert.doesNotMatch(app, /onHome:/, '不再给侧栏传 onHome');
});

test('帮助与样式同步：不再宣传旧出口，两处新出口都有专门样式', () => {
  assert.doesNotMatch(panels, /\['H 或 ✕'/, '帮助里删掉 H / ✕ 退出说明');
  assert.match(panels, /项目设置 → 退出项目/, '帮助说明设置侧出口');
  assert.match(panels, /右上角「⇦ 退出项目」/, '帮助说明右上角出口');

  assert.doesNotMatch(css, /\.ps-home-btn/, '删掉项目卡 ✕ 的样式');
  assert.doesNotMatch(css, /\.close-project\b/, '删掉旧的小 ✕ 按钮样式');
  assert.match(css, /\.exit-project\b/, '右上角退出按钮样式存在');
  assert.match(css, /\.ps-settings \.ps-exit\b/, '设置区退出项样式存在');
});
