/* 分季分集之后的「顺序制作」：季 → 集 → 定稿 → 下一集 / 下一季
 * 运行：node --test tests/episode-queue.test.mjs
 *
 * 锁定：默认第一季第一集；四段完成后才能定稿；定稿自动推进到同季下一集，
 * 本季做完进入下一季；已定稿集锁定（前端禁用 + 后端拒绝）；角色库全书复用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
};

const PM = await import('../public/project-model.js');
const {
  activeEpisodeBarHTML, episodeFlowHTML, episodeFlowIntroHTML, scriptConsoleHTML,
  stepSectionHTML, WORKSHOP_STEPS, setActiveEpisode, activeEpisodeNo, sharedCharactersHTML,
} = await import('../public/project-view.js');

const doneEp = (no, season = 1) => ({
  no, season, title: `第 ${no} 集`,
  script: { source: 'llm', stats: { sceneCount: 3 }, scenes: [{}, {}, {}] },
  characterIds: ['c1'],
  segments: [{ no: 1, gridUrl: '/assets/a.svg', cells: [] }],
  steps: { context: { status: 'done' }, storyboard: { status: 'done' }, deliver: { status: 'done' } },
  film: { file: `ep${no}.mp4`, duration: 30 },
});
const todoEp = (no, season = 1) => ({
  no, season, title: `第 ${no} 集`, script: null, characterIds: [], segments: [], steps: {},
});
const project = (episodes, seasons = [{ no: 1 }, { no: 2 }, { no: 3 }]) => ({
  id: 'prj_queue', name: '顺序制作测试', nodes: [],
  management: { kind: 'novel', episodes, seasons, characters: [{ id: 'c1', name: '沈砚' }] },
});

/* ------------------------------ 纯函数：顺序队列 ------------------------------ */

test('队列按「季升序 → 季内集号升序」展平，手动移季的集跟着季走', () => {
  const p = project([doneEp(4, 2), todoEp(1, 1), todoEp(3, 2), doneEp(9, 1), todoEp(5, 3), todoEp(2, 1)]);
  const q = PM.episodeQueue(p);
  assert.deepEqual(q.map((x) => x.no), [1, 2, 9, 3, 4, 5]);
  assert.deepEqual(q.map((x) => x.season), [1, 1, 1, 2, 2, 3]);
  assert.deepEqual(q.filter((x) => x.season === 1).map((x) => x.indexInSeason), [1, 2, 3]);
  assert.equal(q[0].seasonSize, 3);
});

test('默认第一季第一集；四段已完成但未定稿仍停在原集', () => {
  const p = project([doneEp(1), todoEp(2), todoEp(3, 2)]);
  const d = PM.defaultEpisode(p);
  assert.equal(d.season, 1);
  assert.equal(d.no, 1);
  assert.equal(d.stagesDone, true, '四段已完成，等的是定稿而不是换集');
  assert.equal(PM.defaultEpisode(project([])), null);
});

test('定稿 → 同季下一集 → 本季末集进入下一季第一集', () => {
  let p = project([doneEp(1), doneEp(2), doneEp(3, 2), doneEp(4, 2)]);
  assert.deepEqual([PM.nextPendingEpisode(p, 1).season, PM.nextPendingEpisode(p, 1).no], [1, 2]);
  assert.deepEqual([PM.nextPendingEpisode(p, 2).season, PM.nextPendingEpisode(p, 2).no], [2, 3], '跨季推进');
  assert.deepEqual([PM.nextPendingEpisode(p, 3).season, PM.nextPendingEpisode(p, 3).no], [2, 4]);
  assert.equal(PM.nextPendingEpisode(p, 4), null, '最后一集定稿后没有下一集');
  // 队列里已定稿的集自动跳过：定稿第 1 集后，第 2 集也定稿 → 直接到第 3 集
  p = project([doneEp(1), doneEp(2), doneEp(3, 2)]);
  p.management.episodes = PM.markFinalized(PM.markFinalized(p.management.episodes, 1), 2);
  const d = PM.defaultEpisode(p);
  assert.equal(d.no, 3);
  assert.equal(d.season, 2);
  assert.equal(PM.nextPendingEpisode(p, 1).no, 3);
});

test('全部定稿后不悬空：制作位落在最后一集，next 返回 null', () => {
  const p = project([doneEp(1), doneEp(2), doneEp(3, 2)]);
  for (const no of [1, 2, 3]) p.management.episodes = PM.markFinalized(p.management.episodes, no);
  assert.equal(PM.defaultEpisode(p).no, 3);
  assert.equal(PM.nextPendingEpisode(p, 3), null);
  assert.equal(activeEpisodeNo(p.management), 3);
});

test('撤销定稿后该集回到队列；markFinalized 不修改入参', () => {
  const eps = [doneEp(1), todoEp(2)];
  const p = project(eps);
  const next = PM.markFinalized(eps, 1);
  assert.equal(PM.isFinalized(eps[0]), false, '原数组不被修改');
  assert.equal(PM.isFinalized(next[0]), true);
  assert.equal(next[0].finalized.season, 1);
  const undone = PM.markFinalized(next, 1, false);
  assert.equal(PM.isFinalized(undone[0]), false);
  p.management.episodes = next;
  assert.equal(PM.defaultEpisode(p).no, 2);
  p.management.episodes = undone;
  assert.equal(PM.defaultEpisode(p).no, 1);
});

test('四段完成判定与定稿门槛：缺任一段都不能定稿', () => {
  const full = doneEp(1);
  assert.deepEqual(PM.episodeStagesDone(full).missing, []);
  assert.equal(PM.canFinalizeEpisode(full), true);
  const noFilm = { ...full, film: null, steps: { ...full.steps, deliver: { status: 'pending' } } };
  assert.deepEqual(PM.episodeStagesDone(noFilm).missing, ['deliver']);
  assert.equal(PM.canFinalizeEpisode(noFilm), false);
  assert.equal(PM.canFinalizeEpisode(PM.markFinalized([full], 1)[0]), false, '已定稿不能重复定稿');
  assert.equal(PM.episodeStageDone(todoEp(2), 'script'), false);
  // running / error 不允许靠产物兜底判成完成
  assert.equal(PM.episodeStageDone({ ...full, steps: { ...full.steps, storyboard: { status: 'running' } } }, 'storyboard'), false);
});

test('每季定稿进度与跨季相邻集', () => {
  const p = project([doneEp(1), doneEp(2), doneEp(3, 2)]);
  p.management.episodes = PM.markFinalized(p.management.episodes, 1);
  const progress = PM.seasonFinalProgress(p);
  assert.deepEqual(progress.map((g) => [g.no, g.finalized, g.total]), [[1, 1, 2], [2, 0, 1], [3, 0, 0]]);
  assert.equal(progress[0].allDone, false);
  assert.equal(PM.adjacentEpisode(p, 2, 1).season, 2, '下一集跨季');
  assert.equal(PM.adjacentEpisode(p, 3, -1).no, 2, '上一集回到前一季');
  assert.equal(PM.adjacentEpisode(p, 3, 1), null);
});

/* ------------------------------ 前端：两级选集 / 定稿 / 锁定 ------------------------------ */

test('顶部条：季下拉 + 季内集下拉 + 顺序进度 + 定稿按钮', () => {
  const p = project([doneEp(1), todoEp(2), todoEp(3, 2)]);
  setActiveEpisode(p, 1);
  const bar = activeEpisodeBarHTML(p, p.management);
  assert.match(bar, /data-season-select/);
  assert.match(bar, /value="2">第 2 季/);       // 季选项已是中文
  assert.match(bar, /data-ep-select/);
  assert.match(bar, /顺序制作/);
  assert.match(bar, /本季已定稿 <b>0<\/b>\/2/);
  assert.match(bar, /下一集 第 1 季 第 2 集/);
  assert.match(bar, /data-act="finalize-ep" data-no="1" data-on="1"/);
  assert.match(bar, /定稿本集并进入下一集/);
  assert.match(bar, /默认第一季第一集/);
  // 集下拉只列当前季的集：切到第 2 季只应出现第 3 集
  setActiveEpisode(p, 3);
  const bar2 = activeEpisodeBarHTML(p, p.management);
  const epSelect = bar2.match(/<select data-ep-select[^>]*>([\s\S]*?)<\/select>/)?.[1] || '';
  assert.match(epSelect, /<option value="3" selected/);
  assert.ok(!/<option value="1"/.test(epSelect), '集下拉不应混入其它季');
  assert.match(bar2, /data-act="ep-prev" data-no="2"/, '上一集跨季连续');
  assert.match(bar2, /后面没有待定稿集/);
  assert.ok(!/undefined|NaN/.test(bar + bar2));
});

test('已定稿集：顶部条给撤销入口，流水线锁定且批量跳过', () => {
  const p = project([doneEp(1), todoEp(2), todoEp(3, 2)]);
  p.management.episodes = PM.markFinalized(p.management.episodes, 1);
  setActiveEpisode(p, 2);
  const m = p.management;
  const flow = episodeFlowHTML(p, m, 'script');
  assert.match(flow, /第 1 季/);
  assert.match(flow, /已定稿 <b>1<\/b>\/2/);
  assert.match(flow, /🔒 已定稿/);
  assert.match(flow, /data-act="finalize-ep" data-no="1" data-on="0"/);
  assert.ok(!/data-act="run-ep-step"[^>]*data-no="1"/.test(flow), '定稿集不应有执行按钮');
  assert.match(flow, /补齐未完成「剧本」的集（2）/, '批量只数未定稿集');
  const bar = activeEpisodeBarHTML(p, m);
  assert.match(bar, /data-act="finalize-ep" data-no="2" data-on="1"|四段还差/, '当前集未定稿');
  const head = stepSectionHTML(WORKSHOP_STEPS.find((s) => s.id === 'script'), 4, m, '', false);
  assert.match(head, /剧集级 · 第 1 季 第 2 集 · 第 1\/4 段/);
  const scriptPanel = scriptConsoleHTML(p, m, {});
  assert.match(scriptPanel, /🔒 已定稿/);   // 折叠列表里第 1 集的标记
  assert.match(scriptPanel, /补齐缺失剧本（2）/);
  assert.ok(!/undefined|NaN/.test(flow + bar + head + scriptPanel));
});

test('③ 说明条写明制作顺序、季进度与当前制作位', () => {
  const p = project([doneEp(1), todoEp(2), todoEp(3, 2)]);
  const intro = episodeFlowIntroHTML(p, p.management);
  assert.match(intro, /默认第一季第一集/);
  assert.match(intro, /同季第二集/);
  assert.match(intro, /下一季/);
  assert.match(intro, /制作队列/);
  assert.match(intro, /第 1 季 第 1 集 → 第 1 季 第 2 集 → 第 2 季 第 3 集/);
  assert.match(intro, /当前制作位 第 1 季 第 1 集/);
  assert.match(intro, /data-act="finalize-ep" data-no="1" data-on="1"/);
  assert.ok(!/undefined|NaN/.test(intro));
});

test('角色是唯一例外：换季换集仍沿用同一份角色库', () => {
  const p = project([doneEp(1), todoEp(2), todoEp(3, 2)]);
  const m = p.management;
  const shared = sharedCharactersHTML(m, m.episodes[2]);
  assert.match(shared, /全项目共享（唯一例外）/);
  assert.match(shared, /已沿用 <b>1<\/b> 位角色/);
  assert.match(shared, /不同集出现同一角色时按角色 ID 直接复用/);
  assert.match(shared, /不重复提取、不重复出定妆图/);
  // 定稿不重建角色库：markFinalized 只动 ep.finalized
  const before = JSON.stringify(m.characters);
  m.episodes = PM.markFinalized(m.episodes, 1);
  assert.equal(JSON.stringify(m.characters), before);
});
