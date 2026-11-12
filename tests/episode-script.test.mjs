/* 覆盖：单集剧本构建 / 归一 / 统计 / 编辑合并 / Markdown 导出 / 覆盖率，
 *      编剧 Provider 的「按本集原文与真实角色」兜底，以及分季分集的进度与筛选纯函数。
 * 运行：node --test tests/episode-script.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scriptStats, scriptIssues, normalizeEpisodeScript, buildScriptVars,
  mergeScriptEdit, scriptToMarkdown, scriptsToMarkdown, scriptsCoverage,
} from '../src/core/episode-script.mjs';
import { createProviders, SCREENPLAY_GUIDE } from '../src/core/providers.mjs';
import { episodeProduction, scriptCoverage, filterSeasonGroups, seasonGroups } from '../public/project-model.js';

const script = () => ({
  episodeNo: 2, title: '第 2 集 · 来信', genre: '悬疑',
  logline: '一封迟到十年的信把两人重新拉回旧案。',
  characters: [{ name: '沈砚', role: '侦探' }, { name: '林夏', role: '记者' }],
  scenes: [
    {
      id: 'S1', location: '旧城区巷口', time: '夜', summary: '沈砚在雨里等一个人',
      script: ['【夜 · 旧城区巷口】', '动作：雨落在伞面上。', '沈砚：「你迟到了十年。」', '林夏：「信不是我寄的。」'],
    },
    {
      id: 'S2', location: '警局档案室', time: '深夜', summary: '两人翻出被抽走的卷宗',
      script: ['动作：灯管闪了两下。', '林夏：「这一页是空的。」', '沈砚：「不是空的，是被人撕走了。」'],
    },
  ],
  source: 'llm', generatedAt: 1000,
  continuity: { prevNo: 1, nextNo: 3, prevRecap: '上一集结尾枪声响起', nextHook: '卷宗最后一页写着沈砚的名字' },
});

const project = () => ({
  id: 'prj_1', name: '雨夜侦探',
  management: {
    kind: 'novel',
    bible: { title: '雨夜侦探', genre: '悬疑', tone: '冷峻', logline: '旧案重开' },
    runtime: { totalSeconds: 60, clipSeconds: 3, fps: 24 },
    characters: [
      { id: 'c1', name: '沈砚', role: '侦探' }, { id: 'c2', name: '林夏', role: '记者' },
    ],
    episodes: [
      { no: 1, title: '雨夜', chars: 1200, summary: '旧案开始', hook: '枪声响起', season: 1, characterIds: ['c1'],
        script: { ...script(), episodeNo: 1, title: '第 1 集 · 雨夜' } },
      { no: 2, title: '来信', chars: 3600, summary: '一封信出现', hook: '卷宗被撕', season: 1, characterIds: ['c1', 'c2'],
        script: { ...script(), episodeNo: 2 } },
      { no: 3, title: '追踪', chars: 900, summary: '追到码头', hook: '', season: 2, segments: [{ no: 1, gridUrl: '/a.png' }, { no: 2 }] },
    ],
  },
});

test('scriptStats：场次 / 行数 / 对白 / 字数 / 说话人', () => {
  const st = scriptStats(script());
  assert.equal(st.sceneCount, 2);
  assert.equal(st.lineCount, 7);
  assert.equal(st.dialogueCount, 4);
  assert.ok(st.chars > 40);
  assert.deepEqual(st.speakers.sort(), ['林夏', '沈砚'].sort());
  assert.deepEqual(scriptStats({}), { sceneCount: 0, lineCount: 0, dialogueCount: 0,
    offscreenCount: 0, screenTextCount: 0, continuityCount: 0,
    chars: 0, speakerCount: 0, characterCount: 0, speakers: [] });
});

test('scriptIssues：无对白 / 场次过少 / 未登记角色 / 场次过薄', () => {
  const issues = scriptIssues({ scenes: [{ location: '房间', script: ['动作：门开了。'] }] }, { characterNames: [] });
  assert.ok(issues.some((x) => x.code === 'few_scenes'));
  assert.ok(issues.some((x) => x.code === 'no_dialogue'));
  assert.ok(issues.some((x) => x.code === 'thin_scene'));
  const unknown = scriptIssues({ scenes: [{ location: '房间', script: ['陌生人：「谁？」', '陌生人：「出来。」'] }] }, { characterNames: ['沈砚'] });
  assert.ok(unknown.some((x) => x.code === 'unknown_speaker'));
  assert.deepEqual(scriptIssues({ scenes: [] }).filter((x) => x.level === 'error').map((x) => x.code), ['no_scene', 'no_line']);
});

test('buildScriptVars：带上一集结尾 / 下一集钩子 / 出场角色 / 场次预算', () => {
  const p = project();
  const m = p.management;
  const vars = buildScriptVars(p, m, m.episodes[1]);
  assert.equal(vars.episodeNo, 2);
  assert.equal(vars.episodeIndex, 2);
  assert.equal(vars.episodeCount, 3);
  assert.equal(vars.prevNo, 1);
  assert.equal(vars.nextNo, 3);
  assert.match(vars.prevRecap, /卷宗/);
  assert.equal(vars.nextHook, '');
  assert.equal(vars.nextSummary, '追到码头');
  assert.deepEqual(vars.characters.map((c) => c.name), ['沈砚', '林夏']);
  assert.ok(vars.targetScenes >= 3 && vars.targetScenes <= 10);
  assert.equal(vars.runtime.totalSeconds, 60);
  // 3600 字 → 6 场；60s → 5 场，取较大者
  assert.equal(vars.targetScenes, 6);
});

test('normalizeEpisodeScript：缺场次时按原文补一场，统计与质量告警同步产出', () => {
  const ep = { no: 5, title: '夜谈', summary: '两人对坐', text: '雨停了。\n沈砚把信放在桌上。\n林夏：「你早就知道？」' };
  const out = { title: '夜谈', characters: [{ name: '沈砚' }, { name: '林夏' }], scenes: [] };
  const sc = normalizeEpisodeScript(out, { ep, vars: { episodeNo: 5, characters: out.characters }, source: 'llm', provider: 'openai' });
  assert.equal(sc.scenes.length, 1);
  assert.equal(sc.scenes[0].location, '夜谈');
  assert.ok(sc.scenes[0].script.length >= 3);
  assert.equal(sc.stats.sceneCount, 1);
  assert.equal(sc.episodeNo, 5);
  assert.equal(sc.source, 'llm');
  assert.ok(Array.isArray(sc.issues));
});

test('normalizeEpisodeScript：模型输出字符串行 / 超长行都会被归一', () => {
  const sc = normalizeEpisodeScript({
    scenes: [{ location: '【内景 · 车厢】', time: '夜', summary: '对峙', script: '沈砚：「下车。」\n\n' + '很长'.repeat(200) }],
  }, { ep: { no: 1 }, vars: {}, source: 'mock', provider: 'mock' });
  assert.equal(sc.scenes[0].script.length, 2);
  assert.ok(sc.scenes[0].script[1].length <= 220);
  assert.equal(sc.scenes[0].location, '内景 · 车厢');
});

test('mergeScriptEdit：标为人工编辑、保留生成时间与连续性、空场次拒绝', () => {
  const base = script();
  const next = mergeScriptEdit(base, {
    title: '新片名', logline: '新梗概',
    scenes: [{ location: '天台', time: '黄昏', summary: '摊牌', script: ['沈砚：「结束了。」'] }],
  }, { ep: { no: 2 }, m: { characters: [{ name: '沈砚' }] } });
  assert.equal(next.source, 'manual');
  assert.equal(next.title, '新片名');
  assert.equal(next.scenes.length, 1);
  assert.equal(next.generatedAt, 1000);
  assert.equal(next.continuity.nextNo, 3);
  assert.ok(next.editedAt > 0);
  assert.equal(next.stats.sceneCount, 1);
  assert.throws(() => mergeScriptEdit(base, { scenes: [] }), /至少需要保留一场/);
});

test('scriptToMarkdown / scriptsToMarkdown：抬头、场次、钩子与覆盖率', () => {
  const md = scriptToMarkdown(script(), { episodeNo: 2 });
  assert.match(md, /^# 第 2 集 · 来信/m);
  assert.match(md, /\*\*梗概\*\*/);
  assert.match(md, /## 第 1 场 · 旧城区巷口（夜）/);
  assert.match(md, /沈砚：「你迟到了十年。」/);
  assert.match(md, /\*\*下集钩子\*\*/);
  const all = scriptsToMarkdown({ name: '雨夜侦探' }, { bible: { title: '雨夜侦探' }, episodes: project().management.episodes });
  assert.match(all, /共 3 集，已完成 2 集/);
  assert.equal((all.match(/^# /gm) || []).length, 3); // 项目抬头 + 两集
  assert.match(all, /^# 第 1 集 · 雨夜$/m);            // 片名已带集号时不重复前缀
});

test('scriptsCoverage：总数 / 已写 / 来源分布 / 缺失集号', () => {
  const cov = scriptsCoverage(project().management.episodes);
  assert.equal(cov.total, 3);
  assert.equal(cov.written, 2);
  assert.equal(cov.missing, 1);
  assert.equal(cov.percent, 67);
  assert.deepEqual(cov.missingNos, [3]);
  assert.equal(cov.bySource.llm, 2);
  assert.equal(scriptsCoverage([]).percent, 0);
});

test('编剧 Provider（零 Key）：按本集原文与真实角色写，不再出现主题模板角色', async () => {
  const p = project();
  const m = p.management;
  const vars = buildScriptVars(p, m, m.episodes[2]);
  const providers = createProviders({}, () => {});
  const out = await providers.generate('screenplay', vars);
  assert.ok(out.scenes.length >= 3);
  assert.equal(out.title, '追踪');
  assert.deepEqual(out.characters.map((c) => c.name).sort(), ['林夏', '沈砚'].sort());
  const text = JSON.stringify(out);
  assert.ok(!/顾言|程曦|许知夏|叶舟/.test(text), '不应出现与项目无关的主题模板角色');
  assert.ok(out.scenes.some((s) => s.script.some((l) => /^.+[：:]/.test(l))), '至少有一句对白 / 动作行');
});

test('SCREENPLAY_GUIDE：固定写进 system 提示的硬约束', () => {
  assert.match(SCREENPLAY_GUIDE, /只写本集/);
  assert.match(SCREENPLAY_GUIDE, /prevRecap/);
  assert.match(SCREENPLAY_GUIDE, /targetScenes/);
  assert.match(SCREENPLAY_GUIDE, /角色只能来自 characters/);
});

test('episodeProduction：剧本 / 分镜 / 视频三阶段与百分比', () => {
  const p = project();
  const [e1, e2, e3] = p.management.episodes;
  assert.equal(episodeProduction(e1).percent, 33);
  assert.equal(episodeProduction(e1).script, true);
  assert.equal(episodeProduction(e2).scenes, 2);
  assert.equal(episodeProduction(e3).grids, 1);
  assert.equal(episodeProduction(e3).segments, 2);
  assert.equal(episodeProduction(e3).percent, 0);
  assert.equal(episodeProduction({}).percent, 0);
});

test('scriptCoverage（前端）：与后端同口径', () => {
  const cov = scriptCoverage(project().management.episodes);
  assert.equal(cov.written, 2);
  assert.deepEqual(cov.missingNos, [3]);
});

test('filterSeasonGroups：关键词 + 状态筛选，空季在筛选时隐藏', () => {
  const p = project();
  const groups = seasonGroups(p);
  assert.equal(groups.length, 2);
  const noscript = filterSeasonGroups(groups, { status: 'noscript' });
  assert.equal(noscript.length, 1);
  assert.deepEqual(noscript[0].episodes.map((e) => e.no), [3]);
  const byQuery = filterSeasonGroups(groups, { query: '来信' });
  assert.equal(byQuery.length, 1);
  assert.deepEqual(byQuery[0].episodes.map((e) => e.no), [2]);
  const byNo = filterSeasonGroups(groups, { query: '3' });
  assert.deepEqual(byNo.flatMap((g) => g.episodes.map((e) => e.no)), [3]);
  const grid = filterSeasonGroups(groups, { status: 'grid' });
  assert.deepEqual(grid.flatMap((g) => g.episodes.map((e) => e.no)), [3]);
  // 全量（无筛选）保留空季，方便把集移进去
  const all = filterSeasonGroups([...groups, { no: 9, title: '空季', episodes: [], chars: 0 }], {});
  assert.equal(all.length, 3);
  // 不修改入参
  assert.equal(groups[0].episodes.length, 2);
});
