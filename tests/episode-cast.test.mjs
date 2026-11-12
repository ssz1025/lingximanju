/* 每集出场角色对账 · 单元测试
 *
 * 覆盖用户诉求「每一集应该有独立的角色管理即出场角色；检查角色是否存在，
 * 如果不存在则直接提取或者生成角色，并存入当前项目的全局角色」：
 *   1) 本集原文 + 剧本（场景角色 / 说话人）都能成为出场证据；
 *   2) 与全局角色库按 name / aliases 对账，缺失的才补；
 *   3) 零 Key 生成带本集原文证据的占位角色卡，绝不编造人设；
 *   4) 只写全项目共享角色库、只回写本集名单；手改名单不被自动匹配覆盖；
 *   5) 角色库满 12 位时只提示不挤人，REST 端点正则不与既有路径冲突。
 *
 * 运行：node --test tests/episode-cast.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  episodeCastSources, explicitScriptNames, collectEpisodeCastCandidates,
  diffEpisodeCast, episodeCastVars, buildCastCards, applyEpisodeCast,
  CAST_MIN_HITS,
} from '../src/core/episode-cast.mjs';
import { MAX_CHARACTERS } from '../src/core/characters.mjs';
import { ensureProjectCharactersForEpisode } from '../src/agents/character-agent.mjs';
import { MATCH } from '../src/api/routes/match.mjs';

/** 第 3 集新登场「林晚」，全局库只有「沈砚」 */
const ep = (extra = {}) => ({
  no: 3, title: '新人物', summary: '', hook: '',
  text: '沈砚抬头，看见林晚站在门口。林晚说：「你终于来了。」林晚把伞收起来。沈砚没有回答。',
  characterIds: [],
  ...extra,
});
const chars = () => [{ id: 'c1', name: '沈砚', role: '侦探', aliases: ['沈探长'] }];
const project = () => ({ id: 'p_cast', name: '雨夜侦探', settings: {}, management: {} });

/* ------------------------------------------------------------ 本集证据 */

test('episodeCastSources：原文 / 剧本场景 / 对白行 / 点名清单都进证据文本', () => {
  const src = episodeCastSources(ep({ script: {
    characters: [{ name: '林晚', role: '来访者' }],
    scenes: [{
      location: '门口', time: '夜', summary: '两人对峙', characters: ['沈砚', '林晚'],
      script: ['林晚：你终于来了。', '沈砚：进来吧。', '旁白：雨还在下。'],
    }],
  } }));
  assert.ok(src.hasBody);
  assert.ok(src.text.includes('林晚站在门口'));
  assert.ok(src.text.includes('林晚：你终于来了。'));
  assert.ok(src.text.includes('【本集剧本点名】'));
  assert.ok(src.explicit.includes('林晚') && src.explicit.includes('沈砚'));
  assert.ok(!src.explicit.includes('旁白'), '舞台指示 / 旁白不是角色');
  assert.ok(src.novelText.length <= 12000);
});

test('explicitScriptNames：script.characters / scenes.characters / 说话人三路归并，挡住非人物词', () => {
  const names = explicitScriptNames(ep({ script: {
    characters: ['林晚', '回头', '刀光'],
    scenes: [{ characters: ['沈砚'], script: ['林晚：来了。', '旁白：雨声。'] }],
  } }));
  assert.ok(names.has('林晚') && names.has('沈砚'));
  assert.ok(!names.has('回头') && !names.has('刀光') && !names.has('旁白'));
});

test('collectEpisodeCastCandidates：低频动作词不建角色，高频人名按出场次数排序', () => {
  const list = collectEpisodeCastCandidates(ep({
    text: '沈砚回头，刀光一闪。林晚站在门口。林晚说：「你终于来了。」林晚把伞收起来。沈砚没有回答。',
  }));
  const names = list.map((c) => c.name);
  assert.ok(names.includes('林晚') && names.includes('沈砚'), '两位出场人物都要进候选');
  assert.ok(!names.includes('回头') && !names.includes('刀光'), '动作 / 物件不能当人物');
  assert.ok(list.find((c) => c.name === '林晚').hits >= CAST_MIN_HITS);
  assert.ok(list[0].hits >= list[list.length - 1].hits, '按出场频次降序');
});

test('diffEpisodeCast：按 name / aliases 对账，别名命中不重复建角色', () => {
  const candidates = [
    { name: '沈探长', hits: 3 }, { name: '林晚', hits: 4 },
  ];
  const { matched, missing } = diffEpisodeCast(candidates, chars());
  assert.deepEqual(matched.map((x) => x.id), ['c1']);
  assert.deepEqual(missing.map((x) => x.name), ['林晚']);
});

test('episodeCastVars：候选只含缺失者，片段是能定位到本集原文的窗口', () => {
  const e = ep();
  const vars = episodeCastVars(e, [{ name: '林晚', hits: 3 }], { title: '雨夜侦探' });
  assert.equal(vars.candidates.length, 1);
  assert.equal(vars.candidates[0].name, '林晚');
  assert.ok(vars.candidates[0].hint.includes('林晚'));
  assert.ok(vars.fragments[0].text.includes('林晚'));
  assert.ok(vars.novelText.includes('沈砚'));
  assert.ok(vars.title.includes('第 3 集'));
});

/* ------------------------------------------------------------ 角色卡与回写 */

test('buildCastCards：零 Key 只写本集原文证据，不编造人设', () => {
  const src = episodeCastSources(ep());
  const [card] = buildCastCards([{ name: '林晚', hits: 3 }], src.text, { cap: 2 });
  assert.equal(card.name, '林晚');
  assert.equal(card.source, 'heuristic');
  assert.equal(card.auto, true);
  assert.ok(card.appearance.includes('本集原文依据'));
  assert.ok(card.evidence[0].quote.length > 0);
  assert.ok(src.text.includes(card.evidence[0].quote), '引用必须能在本集证据里逐字定位');
  assert.equal(card.role.includes('古风少女'), false, '不得凭空写人设');
});

test('applyEpisodeCast：写入全局角色库并回写本集名单；已有名单原样保留', () => {
  const m = { characters: chars() };
  const e = ep();
  const r = applyEpisodeCast({
    m, ep: e,
    cards: buildCastCards([{ name: '林晚', hits: 3 }], e.text),
    matchedIds: ['c1'], source: 'heuristic',
  });
  assert.equal(r.added, 1);
  assert.deepEqual(r.addedNames, ['林晚']);
  assert.equal(m.characters.length, 2, '只补进全项目共享角色库，不为每集建库');
  assert.equal(e.characterIds.length, 2);
  assert.ok(e.characterIds.includes('c1'));

  // 用户手动关联过的名单不被自动匹配覆盖：只追加新入库角色
  const e2 = ep({ characterIds: ['manual-x'] });
  const again = applyEpisodeCast({
    m: { characters: m.characters }, ep: e2,
    cards: [], matchedIds: ['c1'], source: 'heuristic',
  });
  assert.deepEqual(again.cast, ['manual-x'], '手动关联结果不被自动匹配改写');
});

test('applyEpisodeCast：角色库满 12 位时不挤人，未入库名单如实返回', () => {
  const full = Array.from({ length: MAX_CHARACTERS }, (_, i) => ({ id: `c${i}`, name: `角色${i}` }));
  const m = { characters: full };
  const e = ep();
  const r = applyEpisodeCast({
    m, ep: e, cards: buildCastCards([{ name: '林晚', hits: 3 }], e.text),
  });
  assert.equal(r.added, 0);
  assert.equal(m.characters.length, MAX_CHARACTERS);
  assert.deepEqual(r.skipped, ['林晚']);
});

/* ------------------------------------------------------------ Agent / 路由 */

test('ensureProjectCharactersForEpisode：零 Key 也把本集新人物补进全局角色库', async () => {
  const p = project();
  const m = { source: { title: '雨夜侦探' }, characters: chars() };
  const e = ep();
  const r = await ensureProjectCharactersForEpisode({ project: p, m, ep: e, mode: 'heuristic', log: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.added, 1);
  assert.deepEqual(r.addedNames, ['林晚']);
  assert.equal(r.matched, 1);
  assert.equal(e.characterIds.length, 2);
  const added = m.characters.find((c) => c.name === '林晚');
  assert.ok(added?.evidence?.length, '新角色带本集原文证据');
  assert.equal(added.source, 'heuristic', '零 Key 不冒充 LLM 成果');

  // 再跑一次：不重复建角色，名单稳定
  const again = await ensureProjectCharactersForEpisode({ project: p, m, ep: e, mode: 'heuristic', log: () => {} });
  assert.equal(again.added, 0);
  assert.equal(m.characters.length, 2);
  assert.equal(e.characterIds.length, 2);
});

test('ensureProjectCharactersForEpisode：本集无原文 / 角色库已满都不硬写', async () => {
  const p = project();
  const empty = await ensureProjectCharactersForEpisode({
    project: p, m: { characters: [] }, ep: ep({ text: '', script: null }), log: () => {},
  });
  assert.equal(empty.ok, true);
  assert.equal(empty.added, 0);
  assert.match(empty.message, /没有原文/);

  const full = Array.from({ length: MAX_CHARACTERS }, (_, i) => ({ id: `c${i}`, name: `角色${i}` }));
  const m = { source: { title: '雨夜侦探' }, characters: full };
  const e = ep();
  const r = await ensureProjectCharactersForEpisode({ project: p, m, ep: e, mode: 'heuristic', log: () => {} });
  assert.equal(r.added, 0);
  assert.equal(m.characters.length, MAX_CHARACTERS);
  assert.ok(r.skipped.includes('林晚'));
  assert.match(r.message, /未自动入库|已满/);
});

test('路由正则：/characters/ensure 单集端点不与既有 characters 动作冲突', () => {
  const path = '/api/projects/p1/episodes/3/characters/ensure';
  const hit = path.match(MATCH.episodeCastEnsure);
  assert.ok(hit);
  assert.equal(hit[1], 'p1');
  assert.equal(hit[2], '3');
  assert.equal(path.match(MATCH.episodeAction), null, '多一层路径不能被通用动作正则误吞');
  assert.ok('/api/projects/p1/episodes/3/characters'.match(MATCH.episodeAction));
});
