/* 覆盖：季 / 集分组、季增删改、画布范围键、外壳文案的季统计与纯函数不可变。
 * 运行：node --test tests/project-model.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seasonOf, seasonTitle, seasonGroups, seasonSummary, episodeLabel, episodeTitleHTML,
  assignEpisodeSeason, setSeasonTitle, addSeason, removeSeason, scopeKeyOf, parseScopeKey,
  localSourceView,
} from '../public/project-model.js';
import { projectChrome } from '../public/project-sidebar.js';
import { sourceStatCards } from '../public/source-view.js';

const project = () => ({
  id: 'prj_1', name: '雨夜侦探', nodes: [{ id: 'n1' }, { id: 'n2' }], edges: [{ id: 'e1' }],
  management: {
    kind: 'novel',
    seasons: [{ no: 2, title: '第二季 · 追凶' }],
    episodes: [
      { no: 1, title: '第 1 集 · 雨夜', chars: 1200, season: 1 },
      { no: 2, title: '第 2 集 · 来信', chars: 1800 },              // 缺省归第一季
      { no: 3, title: '第 3 集 · 追踪', chars: 900, season: 2 },
      { no: 4, title: '第 4 集 · 真相', chars: 1500, season: 2 },
    ],
  },
});

test('seasonOf：缺省 / 非法值都归第一季，字符串季号可用', () => {
  assert.equal(seasonOf(null), 1);
  assert.equal(seasonOf({}), 1);
  assert.equal(seasonOf({ season: 0 }), 1);
  assert.equal(seasonOf({ season: '3' }), 3);
  assert.equal(seasonOf({ season: 2.8 }), 2);
});

test('seasonGroups：按季号排序、集号排序、汇总字数', () => {
  const g = seasonGroups(project());
  assert.deepEqual(g.map((x) => x.no), [1, 2]);
  assert.equal(g[0].title, '第 1 季');
  assert.equal(g[1].title, '第二季 · 追凶');
  assert.deepEqual(g[0].episodes.map((e) => e.no), [1, 2]);
  assert.equal(g[0].chars, 3000);
  assert.equal(g[1].chars, 2400);
  assert.deepEqual(seasonGroups({ management: {} }), []);
  assert.equal(seasonSummary(project()).seasonCount, 2);
  assert.equal(seasonSummary(project()).chars, 5400);
});

test('seasonTitle / episodeLabel：自定义标题与转义', () => {
  assert.equal(seasonTitle(project(), 2), '第二季 · 追凶');
  assert.equal(seasonTitle(project(), 9), '第 9 季');
  assert.equal(episodeLabel(project().management.episodes[2]), '第 3 集 · 第 3 集 · 追踪');
  assert.equal(episodeTitleHTML(project(), { no: 1, title: '<script>' }), '第 1 集 · &lt;script&gt;');
});

test('assignEpisodeSeason：只改目标集且不可变', () => {
  const eps = project().management.episodes;
  const before = JSON.stringify(eps);
  const next = assignEpisodeSeason(eps, 3, 1);
  assert.equal(seasonOf(next.find((e) => e.no === 3)), 1);
  assert.equal(seasonOf(eps.find((e) => e.no === 3)), 2, '不能修改入参');
  assert.equal(JSON.stringify(eps), before);
  assert.equal(seasonOf(next.find((e) => e.no === 4)), 2);
});

test('setSeasonTitle / addSeason / removeSeason：无重复季号、删除后集回第一季', () => {
  const p = project();
  const renamed = setSeasonTitle(p.management.seasons, 2, '  最终季  ');
  assert.deepEqual(renamed, [{ no: 2, title: '最终季' }]);
  assert.deepEqual(p.management.seasons, [{ no: 2, title: '第二季 · 追凶' }]);
  assert.equal(setSeasonTitle(renamed, 2, '').length, 1);
  assert.equal(setSeasonTitle(renamed, 2, '').find((s) => s.no === 2).title, undefined);

  const added = addSeason(renamed, seasonGroups(p));
  assert.equal(added.no, 3);
  assert.equal(added.seasons.length, 2, '在 renamed 的一份季配置后追加，共 2 份');

  const removed = removeSeason(renamed, p.management.episodes, 2);
  assert.equal(removed.moved, 2);
  assert.ok(removed.episodes.every((e) => seasonOf(e) === 1));
  assert.deepEqual(removed.seasons, []);
  const first = removeSeason(renamed, p.management.episodes, 1);
  assert.equal(first.moved, 0, '第一季是兜底季，不允许删除');
});

test('画布范围键：overall / main / ep:<no> 往返解析', () => {
  assert.equal(scopeKeyOf('overall'), 'overall');
  assert.equal(scopeKeyOf('main'), 'main');
  assert.equal(scopeKeyOf('episode', 7), 'ep:7');
  assert.deepEqual(parseScopeKey('ep:7'), { kind: 'episode', no: 7 });
  assert.deepEqual(parseScopeKey('main'), { kind: 'main', no: 0 });
  assert.deepEqual(parseScopeKey('unknown'), { kind: 'overall', no: 0 });
  assert.deepEqual(parseScopeKey(null), { kind: 'overall', no: 0 });
});

test('projectChrome 页脚带上季数，且纯函数不改入参', () => {
  const p = project();
  const before = JSON.stringify(p);
  const c = projectChrome(p, { view: 'workshop', projectCount: 3 });
  assert.match(c.foot, /2 季 4 集/);
  assert.equal(c.brandTitle, '项目工作台');
  assert.equal(c.inProject, true);
  assert.equal(JSON.stringify(p), before);
});

test('localSourceView：后端 /source 不可达时的前端等价统计与章节重建', () => {
  const text = '雨夜侦探\n第一章 没有署名的信\n夜色很沉，刘左撑着伞。\n第二章 第二封信\n她又来了。\n';
  const p = {
    id: 'prj_2', name: '雨夜侦探',
    management: {
      kind: 'novel', seasons: [{ no: 2 }],
      source: { filename: 'a.txt', title: '雨夜侦探', totalChars: text.length, chapterCount: 2, uploadedAt: 1, text },
      chapters: [], sources: [],
      characters: [{ id: 'c1' }],
      episodes: [
        { no: 1, title: '第 1 集', chars: 1200, season: 1, sourceTitles: ['第一章 没有署名的信'] },
        { no: 2, title: '第 2 集', chars: 800, season: 2, sourceTitles: ['第二章 第二封信'] },
      ],
    },
  };
  const before = JSON.stringify(p);
  const v = localSourceView(p);
  assert.equal(v.ok, true);
  assert.equal(v.text.length, text.length);
  assert.equal(v.text, text, '原文完整返回，不截断');
  assert.equal(v.chapters.length, 2);
  assert.equal(v.chapters[0].title, '第一章 没有署名的信');
  assert.equal(v.chapters[0].episodeNo, 1, '章节按 sourceTitles 关联到集');
  assert.equal(v.chapters[1].episodeNo, 2);
  assert.ok(v.chapters[0].text.includes('刘左'));
  assert.equal(v.sources.length, 1, 'sources 为空时合成一条');
  assert.equal(v.stats.seasonCount, 2);
  assert.equal(v.stats.avgCharsPerEpisode, 1000);
  assert.equal(v.stats.characterCount, 1);
  assert.equal(JSON.stringify(p), before, '纯函数不可变');
  const empty = localSourceView({ management: {} });
  assert.equal(empty.ok, false);
  assert.equal(empty.text, '');
  assert.deepEqual(empty.chapters, []);
  assert.equal(empty.stats.totalChars, 0);
});

test('sourceStatCards：六项统计、数值兜底与不可变', () => {
  const stats = {
    totalChars: 13210, chapterCount: 4, paragraphCount: 189, episodeCount: 8,
    seasonCount: 2, characterCount: 7,
  };
  const before = JSON.stringify(stats);
  const cards = sourceStatCards(stats);
  assert.equal(cards.length, 6);
  assert.ok(cards.every((c) => ['label', 'value', 'sub'].every((k) => k in c)));
  assert.equal(cards[0].value, 13210);
  assert.equal(JSON.stringify(stats), before);
  assert.doesNotThrow(() => sourceStatCards({}));
  assert.ok(sourceStatCards({}).every((c) => Number.isFinite(Number(c.value)) || typeof c.value === 'string'));
});
