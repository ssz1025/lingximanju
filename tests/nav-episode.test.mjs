/* 当前剧集：身份进中间导航条、控制区移入第③步分集卡、不再悬浮 —— 回归测试
 * 运行：node --test tests/nav-episode.test.mjs
 *
 * 锁定四件事：
 *   1. 短标签 第1季-1 只在导航条使用，集号沿用全局唯一 ep.no；
 *   2. 展开态 190px 窄栏与收起态 40px 状态轨都能看到当前剧集；
 *   3. 原控制区完整保留，但已移进「分季 · 分集」卡片内，不再是 sticky 悬浮条；
 *   4. 功能入口零删减（63 个 data-act）、无脏值、样式令牌化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viewSrc = fs.readFileSync(path.join(ROOT, 'public/project-view.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
};

const PM = await import('../public/project-model.js');
const {
  navHTML, seasonsHTML, activeEpisodeBarHTML, setActiveEpisode, episodeScopeState,
} = await import('../public/project-view.js');

const ep = (no, season, finalized = false, done = false) => ({
  no, season, title: `第 ${no} 集 · 雨夜`, summary: '旧案重开，雨夜里有人敲门。',
  chars: 1200, chapters: [{ title: '第一章' }], script: { source: 'llm', stats: { sceneCount: 3 }, scenes: [{}] },
  characterIds: done ? ['c1'] : [],
  segments: done ? [{ no: 1, gridUrl: '/assets/a.svg', cells: [] }] : [],
  steps: done ? { context: { status: 'done' }, storyboard: { status: 'done' }, deliver: { status: 'done' } } : {},
  film: done ? { file: `ep${no}.mp4`, duration: 30 } : null,
  ...(finalized ? { finalized: { at: '2026-11-10', season, no } } : {}),
});
const project = (episodes) => ({
  id: 'prj_nav_ep', name: '导航条当前剧集测试', nodes: [],
  management: {
    kind: 'novel', episodes, seasons: [{ no: 1 }, { no: 2 }],
    characters: [{ id: 'c1', name: '沈砚' }],
    sources: [{ name: '原著.txt', chars: 12000, chapterTitles: ['第一章'] }],
    chapters: [{ title: '第一章', episodeNo: 1, sourceName: '原著.txt' }],
  },
});

/* --------------------------- 1. 短标签单一真源 --------------------------- */
test('episodeLabelShort：第1季-1 格式、全局唯一集号、异常值兜底', () => {
  assert.equal(PM.episodeLabelShort(1, 1), '第1季-1');
  assert.equal(PM.episodeLabelShort(2, 4), '第2季-4', '第二季首集仍用全局集号，不重置为 1');
  assert.equal(PM.episodeLabelShort(3, 12), '第3季-12');
  for (const bad of [PM.episodeLabelShort(0, 0), PM.episodeLabelShort(NaN, undefined), PM.episodeLabelShort(null, -1)]) {
    assert.equal(bad, '第?季-?');
    assert.ok(!/undefined|NaN/.test(bad));
  }
  // 现有完整中文标签不受影响：短标签是新增函数，不推翻上一轮口径
  assert.equal(PM.episodeLabelFull(2, 4), '第 2 季 第 4 集');
  assert.equal(PM.seasonLabel(1), '第 1 季');
});

/* --------------------------- 2. 中间导航条两态都显示 --------------------------- */
const P = project([ep(1, 1), ep(2, 1), ep(3, 2)]);

test('展开态窄栏：当前剧集直接写在导航条里，格式为 第1季-1', () => {
  const html = navHTML(P.management, false);
  assert.match(html, /class="pv-nav-ep"/);
  assert.match(html, /<b class="pv-nav-ep-no">第1季-1<\/b>/);
  assert.match(html, /当前剧集/);
  assert.match(html, /切换剧集在第③步分集卡内/);
  assert.ok(!/undefined|NaN/.test(html), '导航条不应出现脏值');
});

test('收起态 40px 状态轨：同一串短标签拆两行显示，title 带完整说明', () => {
  const html = navHTML(P.management, false);
  assert.match(html, /class="pv-rail-ep"/);
  assert.match(html, /<span>第1季<\/span><b>-1<\/b>/);
  assert.match(html, /title="当前剧集 第1季-1/);
  assert.match(html, /aria-label="当前剧集 第1季-1"/);
});

test('切换剧集后导航条同步更新，跨季仍用全局集号 第2季-3', () => {
  assert.equal(setActiveEpisode(P, 3), true);
  assert.equal(episodeScopeState().activeNo, 3);
  const html = navHTML(P.management, false);
  assert.match(html, /<b class="pv-nav-ep-no">第2季-3<\/b>/);
  assert.match(html, /<span>第2季<\/span><b>-3<\/b>/);
  assert.ok(!/第1季-1/.test(html), '导航条只能显示一个当前剧集');
  setActiveEpisode(P, 1);
});

test('没有分集时导航条给「未分集」兜底，不产出脏值', () => {
  const html = navHTML(project([]).management, false);
  assert.match(html, /未分集/);
  assert.ok(!/class="pv-rail-ep"/.test(html));
  assert.ok(!/undefined|NaN/.test(html));
});

/* --------------------------- 3. 控制区搬进第③步卡片 --------------------------- */
test('分季分集卡内嵌完整「当前剧集」控制区：切集 / 定稿 / 四段 / 角色例外都在', () => {
  const html = seasonsHTML(P, {});
  assert.match(html, /class="pv-card sx-wrap"/);
  assert.ok(html.indexOf('class="epb"') > html.indexOf('class="pv-card-head sx-head"'), '控制区应在卡头之后');
  assert.ok(html.indexOf('class="epb"') < html.indexOf('class="sx-overview"'), '控制区应在统计条之前（卡片顶部）');
  for (const act of ['ep-prev', 'ep-next']) {
    assert.match(html, new RegExp(`data-act="${act}"`), `${act} 不能因搬家而丢失`);
  }
  assert.match(html, /data-season-select/);
  assert.match(html, /data-ep-select/);
  assert.match(html, /角色除外/);
  assert.match(html, /顺序制作/);
  assert.match(html, /四段还差 \d+ 段/, '四段未完成时给出定稿门槛提示');
  // 四段全绿时定稿按钮仍在控制区内（门槛判定沿用 PMODEL.canFinalizeEpisode）
  const done = seasonsHTML(project([ep(1, 1, false, true), ep(2, 1), ep(3, 2)]), {});
  assert.match(done, /data-act="finalize-ep"/, '定稿入口不能因搬家而丢失');
  assert.ok(!/undefined|NaN/.test(html));
});

test('工作台主内容不再渲染顶部悬浮条；身份只由导航条承载', () => {
  const ssteps = viewSrc.slice(viewSrc.indexOf('host.innerHTML = `<div class="pv-shell pv-shell-steps"'), viewSrc.indexOf('</div>`;', viewSrc.indexOf('host.innerHTML = `<div class="pv-shell pv-shell-steps"')));
  assert.ok(!/activeEpisodeBarHTML\(p, m\)/.test(ssteps), 'pv-ssteps 顶部不应再渲染当前剧集条');
  assert.match(viewSrc, /\$\{activeEpisodeBarHTML\(p, p\.management \|\| \{\}\)\}/, '控制区应在 seasonsHTML 内渲染');
  assert.equal(activeEpisodeBarHTML(P, P.management).length > 100, true, '控制区本身仍能独立渲染');
});

/* --------------------------- 4. 样式与功能零删减 --------------------------- */
test('.epb 不再 sticky / 不再盖住内容；导航条与状态轨样式已定义', () => {
  const rule = css.match(/\.epb\s*\{[^}]*\}/)?.[0] || '';
  assert.ok(rule, '.epb 规则存在');
  assert.ok(!/position:\s*sticky/.test(rule), '不能再是 sticky 悬浮条');
  assert.ok(!/position:\s*fixed/.test(rule));
  assert.ok(!/z-index:\s*9/.test(rule));
  assert.ok(!/box-shadow:\s*var\(--shadow\)/.test(rule));
  assert.match(css, /\.pv-nav-ep\s*\{/);
  assert.match(css, /\.pv-rail-ep\s*\{/);
  assert.match(css, /@media \(max-width: 1080px\)[\s\S]*?\.pv-nav-ep\s*\{/, '窄屏横向步骤条应适配');
});

test('功能入口零删减：data-act 仍是 63 个，切集与定稿动作都在', () => {
  const acts = [...new Set([...viewSrc.matchAll(/data-act="([a-z0-9-]+)"/g)].map((m) => m[1]))];
  assert.equal(acts.length, 63);
  for (const a of ['ep-prev', 'ep-next', 'finalize-ep', 'toggle-nav', 'add-season', 'pick-ep', 'open-episode']) {
    assert.ok(acts.includes(a), `${a} 不应被删`);
  }
});

test('第 28 节之后仍不散写硬编码字号 / 圆角（令牌化不被破坏）', () => {
  const i = css.indexOf('* 第 28 节 · 当前剧集');
  assert.ok(i >= 0);
  const seg = css.slice(i);
  assert.deepEqual([...seg.matchAll(/font-size:\s*([\d.]+)px(?=\s*;)/g)].map((m) => m[1]), []);
  assert.deepEqual([...seg.matchAll(/border-radius:\s*(\d+)px(?=\s*;)/g)].map((m) => m[1]), []);
});
