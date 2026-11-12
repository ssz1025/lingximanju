/* 当前剧集 · 按集独立 + 角色共享例外 · 渲染口径单元测试
 * 运行：node --test tests/episode-scope.test.mjs
 *
 * 锁定四件事：
 *   ① 全工作台只有一个「当前剧集」，顶部条 / 流水线 / 区头都对齐它；
 *   ② 切换剧集时按集存档界面状态，不把上一集的草稿串过来；
 *   ③ ④ 之后的步骤只看当前剧集，其余集收进折叠列表；
 *   ④ 角色库是唯一例外：已存在就沿用，切集不重抽、不每集另建；
 *   ⑤ 第 ⑤ 步默认只展示正在处理的剧集，点「展示全部剧集」才列出其它集。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
};

const {
  activeEpisodeNo, setActiveEpisode, episodeScopeState, activeEpisodeBarHTML,
  sharedCharactersHTML, scriptConsoleHTML, episodeFlowHTML, episodeFlowIntroHTML,
  stepSectionHTML, WORKSHOP_STEPS, setFlowShowAll, flowScopeState,
} = await import('../public/project-view.js');

const script = (n) => ({ source: 'llm', stats: { sceneCount: n }, scenes: Array.from({ length: n }, () => ({})) });

function project(withChars = true) {
  const episodes = [
    { no: 1, title: '第一章 · 雨夜', script: script(6), characterIds: ['c1'],
      segments: [{ no: 1, gridUrl: '/a.svg', cells: [] }],
      steps: { context: { status: 'done' }, storyboard: { status: 'done' }, deliver: { status: 'done' } },
      film: { file: 'a.mp4', duration: 30 } },
    { no: 2, title: '第二章 · 门铃', script: script(5), characterIds: [], segments: [], steps: {} },
    { no: 3, title: '第三章 · 信', script: null, characterIds: [], segments: [], steps: {} },
  ];
  return {
    id: 'prj_scope', name: '当前剧集测试', nodes: [],
    management: { kind: 'novel', episodes, characters: withChars ? [{ id: 'c1', name: '沈砚' }] : [] },
  };
}

test('当前剧集默认第一季第一集；已定稿才顺序推进，不会悬空', () => {
  const p = project();
  // 顺序口径：没有任何集定稿 → 即使第 1 集四段已完成，制作位仍是第 1 季 第 1 集
  assert.equal(activeEpisodeNo(p.management), 1);
  // 第 1 集定稿后自动落到顺序里的第 2 集
  p.management.episodes[0].finalized = { at: Date.now(), season: 1, no: 1 };
  assert.equal(activeEpisodeNo(p.management), 2);
  assert.equal(activeEpisodeNo({ episodes: [] }), 0);
});

test('顶部当前剧集条：身份、四段进度、换集控件、角色例外一次讲清', () => {
  const p = project();
  setActiveEpisode(p, 2);
  const html = activeEpisodeBarHTML(p, p.management);
  assert.match(html, /当前剧集/);
  assert.match(html, /第 1 季 第 2 集/);
  for (const label of ['剧本', '角色·上下文', '分镜', '视频·成片']) {
    assert.ok(html.includes(label), `顶部条缺少阶段 ${label}`);
  }
  assert.match(html, /data-act="ep-prev" data-no="1"/);
  assert.match(html, /data-act="ep-next" data-no="3"/);
  assert.match(html, /data-ep-select/);
  assert.match(html, /④⑤⑥⑦ 只作用于这一集/);
  assert.match(html, /👤 角色除外/);
  assert.match(html, /已沿用 1 位角色/);
  assert.match(html, /切集不重新提取/);
  assert.ok(!/undefined|NaN/.test(html));
});

test('角色库为空时：说明「首次提取一次，之后所有集沿用」', () => {
  const p = project(false);
  const bar = activeEpisodeBarHTML(p, p.management);
  assert.match(bar, /尚未建立/);
  assert.match(bar, /首次执行/);
  const shared = sharedCharactersHTML(p.management, p.management.episodes[1]);
  assert.match(shared, /全项目共享（唯一例外）/);
  assert.match(shared, /尚未建立/);
  assert.match(shared, /全书角色一次/);
  // 有角色库时给出沿用人数与本集出场人数
  const ok = sharedCharactersHTML(project().management, project().management.episodes[0]);
  assert.match(ok, /已沿用 <b>1<\/b> 位角色（本集出场 1 位）/);
  assert.match(ok, /不会为每集另建一套角色库/);
});

test('切换剧集：按集存档界面状态，同一集不误清空，非法集不生效', () => {
  const p = project();
  assert.equal(setActiveEpisode(p, 1), true);
  assert.equal(episodeScopeState().activeNo, 1);
  assert.equal(store.get('lxmj.workshop.activeEp.prj_scope'), '1', '当前集按项目持久化');
  // 切到第 3 集：第 1 集的状态被存档，新集不继承任何展开 / 草稿
  assert.equal(setActiveEpisode(p, 3), true);
  const s = episodeScopeState();
  assert.equal(s.activeNo, 3);
  assert.ok(s.savedNos.includes(1), '上一集界面状态应存档');
  assert.equal(s.openNo, null);
  assert.equal(s.editNo, null);
  assert.equal(s.hasDraft, false);
  assert.equal(s.skipCapture, true, '切集应跳过下一次 DOM 捕获，避免旧集编辑器值盖回新集');
  // 同一集：返回 false 且不动状态
  assert.equal(setActiveEpisode(p, 3), false);
  assert.equal(episodeScopeState().activeNo, 3);
  // 不存在的集：不生效
  assert.equal(setActiveEpisode(p, 99), false);
  assert.equal(episodeScopeState().activeNo, 3);
  // 切回第 1 集：存档里两集互不覆盖
  assert.equal(setActiveEpisode(p, 1), true);
  assert.ok(episodeScopeState().savedNos.includes(3));
});

test('④ 剧本台只显示当前剧集，其余集收进折叠列表且可一键切换', () => {
  const p = project();
  setActiveEpisode(p, 1);
  const m = p.management;
  const html = scriptConsoleHTML(p, m, {});
  assert.equal((html.match(/class="sw-item/g) || []).length, 1, '主区只应有当前集一张剧本卡');
  assert.match(html, /当前只显示 <b>第 1 季 第 1 集<\/b>/);
  assert.match(html, /class="sw-others"/);
  assert.match(html, /data-act="pick-ep" data-no="2"/);
  assert.match(html, /data-act="pick-ep" data-no="3"/);
  assert.match(html, /全部剧集（3）/);
  assert.match(html, /角色库为全项目共享，已存在则沿用/);
  assert.ok(!/undefined|NaN/.test(html));
  // 换集后主区跟着换，不再展示第 1 集的剧本卡
  setActiveEpisode(p, 3);
  const html3 = scriptConsoleHTML(p, m, {});
  assert.match(html3, /当前只显示 <b>第 1 季 第 3 集<\/b>/);
  assert.match(html3, /尚未生成剧本/);
});

test('流水线 / 说明条 / 区头都对齐同一个当前剧集，角色例外写在明处', () => {
  const p = project();
  setActiveEpisode(p, 2);
  const m = p.management;
  const flow = episodeFlowHTML(p, m, 'context');
  assert.match(flow, /当前剧集 · 第 1 季 第 2 集/);
  assert.match(flow, /角色已存在则沿用，切集不重抽/);
  assert.match(flow, /各集任务与产物完全独立/);
  assert.match(flow, /沿用全书角色库 1 位/, '上下文段应说明角色来自共享库');
  const intro = episodeFlowIntroHTML(p, m);
  assert.match(intro, /<span class="fl-scope-k">例外<\/span>/);
  assert.match(intro, /角色库全项目共享：已存在则沿用/);
  const head = stepSectionHTML(WORKSHOP_STEPS.find((s) => s.id === 'storyboard'), 6, m, '', false);
  assert.match(head, /剧集级 · 第 1 季 第 2 集 · 第 3\/4 段/);
  assert.match(head, /data-no="2"/);
  assert.ok(!/undefined|NaN/.test(flow + intro + head));
});

test('没有分集时不渲染当前剧集条，也不报错', () => {
  const p = project();
  p.management.episodes = [];
  assert.equal(activeEpisodeBarHTML(p, p.management), '');
  assert.equal(activeEpisodeNo(p.management), 0);
});

/* ---- 第 ⑤ 步「角色与上下文」：默认只看正在处理的剧集 ---- */
const rowTags = (html) => html.match(/<div class="fl-row[^>]*>/g) || [];
const visibleRows = (html) => rowTags(html).filter((tag) => !/\shidden/.test(tag));

function twoSeasonProject() {
  const p = project();
  p.management.episodes[2].season = 2; // 第 3 集归入第 2 季，验证其它季整组隐藏
  return p;
}

test('⑤ 默认只显示正在处理的剧集：其它集与其它季组都隐藏', () => {
  const p = twoSeasonProject();
  setActiveEpisode(p, 2);
  setFlowShowAll(false);
  const html = episodeFlowHTML(p, p.management, 'context', { onlyActive: true });
  assert.equal(rowTags(html).length, 3, '所有行仍在 DOM，只是不展示');
  assert.equal(visibleRows(html).length, 1);
  assert.match(visibleRows(html)[0], /data-ep-row="2"/);
  assert.equal((html.match(/class="fl-panel"/g) || []).length, 1, '本集任务面板仍展开');
  assert.match(html, /当前只显示正在处理的 第 1 季 第 2 集/);
  assert.match(html, /▤ 展示全部剧集（另有 2 集）/);
  assert.match(html, /<div class="fl-season-group" data-fl-other hidden>[\s\S]*?第 2 季/);
  assert.equal(flowScopeState().showAll, false);
  assert.ok(!/undefined|NaN/.test(html));
});

test('⑤ 点「展示全部剧集」后全部集可见，文案切到收起态且跨渲染保留', () => {
  const p = twoSeasonProject();
  setActiveEpisode(p, 2);
  setFlowShowAll(true);
  const html = episodeFlowHTML(p, p.management, 'context', { onlyActive: true });
  assert.equal(visibleRows(html).length, 3);
  assert.equal((html.match(/data-fl-other hidden/g) || []).length, 0);
  assert.match(html, /▴ 收起其它剧集/);
  assert.match(html, /已展开全部剧集/);
  assert.match(html, /aria-pressed="true"/);
  assert.equal(flowScopeState().showAll, true);
  // 再渲染一次（等价于 SSE 触发的重绘）仍是展开态
  assert.equal(visibleRows(episodeFlowHTML(p, p.management, 'context', { onlyActive: true })).length, 3);
  setFlowShowAll(false);
});

test('⑥⑦ 不传 onlyActive：整表照旧全量展示，也不出现切换按钮', () => {
  const p = twoSeasonProject();
  setActiveEpisode(p, 1);
  const html = episodeFlowHTML(p, p.management, 'storyboard');
  assert.equal(visibleRows(html).length, 3);
  assert.ok(!/data-fl-other|data-fl="toggle-all"|data-fl-text/.test(html));
});

test('切换按钮不占 data-act 命名空间；只有一集时不出现', () => {
  const p = twoSeasonProject();
  setActiveEpisode(p, 1);
  setFlowShowAll(false);
  const html = episodeFlowHTML(p, p.management, 'context', { onlyActive: true });
  const btn = html.match(/<button[^>]*data-fl="toggle-all"[^>]*>/)?.[0] || '';
  assert.ok(btn);
  assert.ok(!/data-act/.test(btn), '新入口必须用 data-fl，避免改动 63 个 data-act 基线');
  assert.match(btn, /aria-pressed="false"/);
  const one = project();
  one.management.episodes = [one.management.episodes[0]];
  const single = episodeFlowHTML(one, one.management, 'context', { onlyActive: true });
  assert.ok(!/data-fl="toggle-all"/.test(single));
  assert.equal(visibleRows(single).length, 1);
});

test('切到另一集后，可见的仍只有新的当前集', () => {
  const p = twoSeasonProject();
  setFlowShowAll(false);
  setActiveEpisode(p, 3);
  const html = episodeFlowHTML(p, p.management, 'context', { onlyActive: true });
  assert.equal(visibleRows(html).length, 1);
  assert.match(visibleRows(html)[0], /data-ep-row="3"/);
  assert.equal(flowScopeState().activeNo, 3);
});

test('⑤ 装配确实启用 onlyActive；CSS 显式覆盖 flex 行上的 hidden', () => {
  const src = readFileSync(new URL('../public/project-view.js', import.meta.url), 'utf8');
  assert.match(src, /episodeFlowHTML\(p, m, 'context', \{ onlyActive: true \}\)/);
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.fl-row\[hidden\][^{]*\{[^}]*display:\s*none/,
    '.fl-row 是 display:flex，漏掉这条会让 hidden 完全失效');
});
