/* 覆盖「统一格式剧本不够详细」的修复：
 *   1. 整剧剧本必须逐集展开成多场，而不是 3 段分集概述；
 *   2. 每场必须带人物 / 内外景 / 时长 / 目标 / 冲突 / 转折 / 节拍 / 转场 + 可拍摄正文；
 *   3. 提示词契约（schema + 两套写作准则 + 行规范）确实要求这些字段；
 *   4. 归一 / 人工编辑 / Markdown 导出不会把 v2 字段弄丢。
 * 运行：node --test tests/screenplay-detail.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviders, SCREENPLAY_GUIDE, SCREENPLAY_PROJECT_GUIDE,
  SCREENPLAY_FORMAT_GUIDE, SCREENPLAY_SCHEMA,
} from '../src/core/providers.mjs';
import {
  enrichScreenplay, parseScriptLine, guessInterior, sceneHeading, SCENE_EXTRA_KEYS,
} from '../src/core/screenplay.mjs';
import {
  normalizeEpisodeScript, mergeScriptEdit, scriptStats, scriptTiming, scriptToMarkdown, scriptIssues,
} from '../src/core/episode-script.mjs';

const EP_SOURCE = [
  {
    no: 1, title: '第1集 雨夜来信', summary: '沈砚在雨夜收到一封没有署名的信', hook: '照片背面写着他的名字',
    excerpt: '雨水顺着屋檐落下。沈砚捏着那封信，指节发白。「这封信是谁送来的？」他低声问。老周站在门口，没有回答。',
    sourceTitles: ['第一章 雨夜'],
  },
  {
    no: 2, title: '第2集 旧案重开', summary: '沈砚来到废弃仓库寻找线索', hook: '仓库深处传来脚步声',
    excerpt: '仓库铁门锈死了。他用肩膀撞开。灰尘在光柱里翻滚。地上有一只旧皮箱，锁扣却被人撬开过。',
    sourceTitles: ['第二章 旧案'],
  },
  {
    no: 3, title: '第3集 对峙', summary: '林夏与沈砚在档案室对峙', hook: '真正的凶手还在外面',
    excerpt: '档案室的灯管闪了两下。林夏把相机放在桌上。「你早就知道。」她说。沈砚没有抬头。',
    sourceTitles: ['第三章 对峙'],
  },
];

const CAST = [
  { name: '沈砚', role: '私家侦探', appearance: '深色风衣、左手旧怀表' },
  { name: '林夏', role: '记者', appearance: '短发、米色风衣、随身相机' },
  { name: '老周', role: '刑警队长', appearance: '灰呢大衣' },
];

/** 造一份「整剧」输入：episodes 数组就是创作项目第③步的真实形态 */
function projectVars(count = 3) {
  return {
    idea: '《雨夜旧案》｜侦探在雨夜收到无名信',
    title: '雨夜旧案',
    episodes: EP_SOURCE.slice(0, count),
    characters: CAST,
    style: 'noir',
  };
}

const mockProviders = () => createProviders({ apiKey: '' }, () => {});

test('整剧兜底：逐集展开成多场，不再只有 3 段分集概述', async () => {
  const out = await mockProviders().generate('screenplay', projectVars(3));
  // 旧实现固定 3 场（episodes.slice(0,3)，每集一场）；新实现每集至少 2 场
  assert.ok(out.scenes.length >= 6, `场次太少：${out.scenes.length}`);
  assert.equal(out.scenes.length, out.sceneCount);
  const eps = new Set(out.scenes.map((s) => s.episodeNo));
  assert.deepEqual([...eps].sort(), [1, 2, 3], '每一集都要落到场次');
  assert.deepEqual(out.coverage.coveredEpisodes, [1, 2, 3]);
  assert.equal(out.coverage.totalEpisodes, 3);
  for (const no of [1, 2, 3]) assert.ok(out.coverage.scenesPerEpisode[no] >= 2);
});

test('整剧兜底：每场都写满可拍摄结构（人物 / 内外景 / 时长 / 目标 / 冲突 / 转折 / 转场 / 正文）', async () => {
  const out = await mockProviders().generate('screenplay', projectVars(3));
  for (const s of out.scenes) {
    assert.ok(/^(内景|外景|内外景)$/.test(s.interior), `内外景不合法：${s.interior}`);
    assert.ok(s.location && s.location !== '段落 1', `地点不可用：${s.location}`);
    assert.ok(s.time, '缺时间');
    assert.ok(s.durationSec >= 8, '缺时长');
    assert.ok(s.objective && s.conflict && s.turn, `缺戏剧结构：${s.id}`);
    assert.ok(s.beat && s.transition, `缺节拍/转场：${s.id}`);
    assert.ok(Array.isArray(s.characters) && s.characters.length, `缺出场人物：${s.id}`);
    assert.ok(s.script.length >= 3, `正文太薄：${s.id}`);
    assert.match(s.script[0], /^【.+】$/, '首行应是场次头');
    const kinds = s.script.slice(1).map((l) => parseScriptLine(l).kind);
    assert.ok(kinds.some((k) => k === 'action' || k === 'narration'), '正文至少要有动作或旁白');
  }
  assert.ok(out.durationSec > 0);
  assert.ok(out.scenes.some((s) => s.script.some((l) => parseScriptLine(l).kind === 'dialogue')), '至少要有一句对白');
});

test('整剧兜底：12 集以上只转写前 12 集并如实标注覆盖范围', async () => {
  const many = Array.from({ length: 15 }, (_, i) => ({
    no: i + 1, title: `第${i + 1}集`, summary: `第 ${i + 1} 集梗概：沈砚继续追查`,
    hook: '门外有人', excerpt: '沈砚推开办公室的门。桌上放着一张照片。',
  }));
  const out = await mockProviders().generate('screenplay', { ...projectVars(0), episodes: many });
  assert.equal(new Set(out.scenes.map((s) => s.episodeNo)).size, 12);
  assert.equal(out.coverage.totalEpisodes, 15);
  assert.match(out.coverage.coveredEpisodes.join(','), /^1,2,/, '应从第 1 集开始覆盖');
});

test('整剧兜底：同一集内地点 / 时间不跳场，台词归属不串人，道具写成 props', async () => {
  const src = '清晨，沈砚在破庙里翻出一枚铜钱，低声说：「刘左，你欠我的还没还。」刘左皱眉：「你还记着那件事？」两人对坐良久，庙外传来马蹄声。夜里，沈砚把铜钱埋进土里，转身离开。';
  const out = await mockProviders().generate('screenplay', {
    title: '铜钱', idea: '旧账与铜钱',
    novelExcerpt: src, sourceText: src,
    episodes: [
      { no: 1, title: '破庙铜钱', summary: '沈砚在破庙发现铜钱', hook: '马蹄声逼近，来者是谁？' },
      { no: 2, title: '夜埋', summary: '沈砚埋钱离开', hook: '埋下的铜钱被人挖走' },
    ],
    characters: [{ name: '沈砚' }, { name: '刘左' }],
  });
  for (const s of out.scenes) {
    assert.ok(!/段落\s*\d+|第\s*\d+\s*集/.test(s.location), `地点写成了拆分标签：${s.location}`);
    assert.ok(Array.isArray(s.props), `props 应是数组：${s.id}`);
    assert.equal(s.props.join('、'), s.keyProp, `props 与 keyProp 应一致：${s.id}`);
  }
  // 同集内场景的地点要一致（同一集通常在同一处空间来回）；时间可以随场次推进（日 → 夜）
  const byEp = new Map();
  for (const s of out.scenes) {
    const cur = byEp.get(s.episodeNo) || new Set();
    cur.add(s.location);
    byEp.set(s.episodeNo, cur);
  }
  for (const [no, places] of byEp) {
    assert.equal(places.size, 1, `第 ${no} 集地点跳场：${[...places].join('/')}`);
  }
  for (const s of out.scenes) assert.ok(s.time, `${s.id} 缺时间`);
  // 「沈砚…低声说：「…」刘左皱眉：「…」」里的第二句台词属于刘左
  const dialogue = out.scenes.flatMap((s) => s.script.map((l) => parseScriptLine(l)))
    .filter((x) => x.kind === 'dialogue');
  const lin = dialogue.find((x) => x.text.includes('你还记着'));
  assert.equal(lin?.speaker, '刘左');
  assert.ok(out.scenes.some((s) => s.props.includes('铜钱')), '铜钱应被识别为关键道具');
});

test('单集兜底：场次数贴近 targetScenes，首场承接上集，不引入主题模板角色', async () => {
  const out = await mockProviders().generate('screenplay', {
    episodeNo: 2, episodeTitle: '旧案重开', title: '雨夜旧案 · 第 2 集',
    logline: '沈砚来到废弃仓库', hook: '仓库深处传来脚步声',
    prevRecap: '第 1 集结尾：照片背面写着他的名字',
    originalText: EP_SOURCE[1].excerpt,
    characters: CAST, targetScenes: 4, runtime: { totalSeconds: 30, clipSeconds: 3 },
  });
  assert.equal(out.scenes.length, 4);
  assert.equal(out.title, '旧案重开');
  assert.ok(out.scenes[0].script.some((l) => /承接上集/.test(l)));
  const text = JSON.stringify(out);
  assert.ok(!/顾言|程曦|许知夏|叶舟/.test(text), '不应出现与项目无关的模板角色');
  assert.deepEqual(out.characters.map((c) => c.name).sort(), ['林夏', '沈砚', '老周'].sort());
});

test('parseScriptLine：对白（含情绪提示）/ 动作 / 旁白 / 音效 / 场次头 分得清', () => {
  assert.deepEqual(parseScriptLine('沈砚（低声）：「你迟到了。」'), { kind: 'dialogue', speaker: '沈砚', text: '你迟到了。' });
  assert.equal(parseScriptLine('林夏：「信不是我寄的。」').speaker, '林夏');
  assert.equal(parseScriptLine('动作：雨落在伞面上。').kind, 'action');
  assert.equal(parseScriptLine('画面：灯管闪了两下。').kind, 'action');
  assert.equal(parseScriptLine('旁白：十年前的那一夜。').kind, 'narration');
  assert.equal(parseScriptLine('音效：门轴一声长响。').kind, 'sound');
  assert.equal(parseScriptLine('【夜 · 旧城区巷口】').kind, 'heading');
  assert.equal(parseScriptLine('雨没停。').kind, 'plain');
  assert.equal(parseScriptLine('   ').kind, 'empty');
});

test('enrichScreenplay：补场号 / 内外景 / 时长 / 分集归属，并且幂等', () => {
  const raw = {
    title: '雨夜旧案', scenes: [
      { location: '内景 · 档案室', script: ['动作：灯管闪了两下。', '沈砚：「这一页是空的。」'] },
      { location: '码头', script: ['动作：雾从水面升起来。'] },
    ],
  };
  const once = enrichScreenplay(raw, { episodes: EP_SOURCE, characters: CAST });
  assert.equal(once.scenes[0].no, 1);
  assert.equal(once.scenes[0].interior, '内景');
  assert.equal(once.scenes[0].location, '档案室');
  assert.ok(once.scenes[0].durationSec > 0);
  assert.equal(once.scenes[1].interior, '外景');
  assert.ok(once.scenes.every((s) => s.episodeNo >= 1 && s.episodeNo <= 3));
  assert.equal(once.schema, 2);
  const twice = enrichScreenplay(once, { episodes: EP_SOURCE, characters: CAST });
  assert.deepEqual(twice, once, '重复归一不应改变结果');
});

test('guessInterior / sceneHeading：由地点判内外景，场次标题可直接展示', () => {
  assert.equal(guessInterior('仓库'), '内景');
  assert.equal(guessInterior('码头'), '外景');
  assert.equal(guessInterior('城门内外'), '内外景');
  assert.equal(guessInterior('城门外'), '外景');
  assert.equal(guessInterior('未知的地方'), '内外景');
  assert.equal(sceneHeading({ interior: '内景', location: '仓库', time: '夜' }), '内景 · 仓库 · 夜');
});

test('归一与人工编辑：v2 场景字段不会因为「点一次保存」而丢失', () => {
  const v2Scene = {
    id: 'SC1', no: 1, episodeNo: 1, act: '第一幕 · 建置', interior: '内景', location: '仓库',
    time: '夜', durationSec: 40, characters: ['沈砚'], summary: '沈砚撞开铁门',
    objective: '找到十年前失踪案的物证', conflict: '铁门锈死', turn: '皮箱锁扣被撬开',
    beat: '试探 → 逼近', mood: '冷', keyProp: '皮箱', transition: '黑场',
    script: ['【夜 · 仓库】', '动作：铁门被撞开。', '沈砚：「有人先来过。」'],
  };
  const normalized = normalizeEpisodeScript(
    { title: '旧案重开', characters: [{ name: '沈砚' }], scenes: [v2Scene] },
    { ep: { no: 2 }, vars: { episodeNo: 2 }, source: 'llm', provider: 'openai' },
  );
  for (const key of SCENE_EXTRA_KEYS) assert.ok(key in normalized.scenes[0], `归一后丢了 ${key}`);
  assert.equal(normalized.scenes[0].objective, '找到十年前失踪案的物证');

  // 编辑器只提交四个字段，结构化字段必须从旧数据继承
  const edited = mergeScriptEdit(normalized, {
    scenes: [{ id: 'SC1', location: '仓库', time: '夜', summary: '沈砚撞开铁门（改）', script: ['沈砚：「有人先来过。」'] }],
  }, { ep: { no: 2 }, m: { characters: [{ name: '沈砚' }] } });
  assert.equal(edited.source, 'manual');
  assert.equal(edited.scenes[0].objective, '找到十年前失踪案的物证');
  assert.equal(edited.scenes[0].transition, '黑场');
  assert.equal(edited.scenes[0].interior, '内景');
  assert.ok(edited.scenes[0].durationSec > 0);
});

test('统计与导出：对白按「说话人」计、Markdown 带目标 / 转场 / 预估时长', () => {
  const script = {
    title: '第 2 集 · 旧案重开', genre: '悬疑', logline: '沈砚来到仓库',
    durationSec: 40,
    characters: [{ name: '沈砚', role: '侦探', motivation: '查明真相' }],
    scenes: [{
      id: 'SC1', interior: '内景', location: '仓库', time: '夜', durationSec: 40,
      characters: ['沈砚'], summary: '撞开铁门', objective: '找到物证', conflict: '铁门锈死',
      turn: '皮箱被撬开', beat: '试探 → 逼近', keyProp: '皮箱', transition: '黑场',
      script: ['【夜 · 仓库】', '动作：铁门被撞开。', '旁白：十年了。', '沈砚（低声）：「有人先来过。」'],
    }],
    continuity: { nextHook: '脚步声近了' },
  };
  const stats = scriptStats(script);
  assert.equal(stats.dialogueCount, 1, '旁白 / 动作不应计入对白');
  assert.deepEqual(stats.speakers, ['沈砚']);
  const timing = scriptTiming(script);
  assert.equal(timing.estimatedSeconds, 40);

  const md = scriptToMarkdown(script, { episodeNo: 2 });
  assert.match(md, /^# 第 2 集 · 旧案重开/m);
  assert.match(md, /## 第 1 场 · 仓库（夜）/);
  assert.match(md, /内景 · 40″/);
  assert.match(md, /\*\*目标\*\*：找到物证/);
  assert.match(md, /转场：黑场/);
  assert.match(md, /沈砚（低声）：「有人先来过。」/);
});

test('scriptIssues：缺场景目标 / 转折会被提示（不阻断保存）', () => {
  const issues = scriptIssues({
    scenes: [
      { location: '仓库', script: ['沈砚：「有人先来过。」', '动作：他蹲下去。'] },
      { location: '码头', script: ['动作：雾起来了。', '动作：船靠岸。'] },
    ],
  });
  assert.ok(issues.some((x) => x.code === 'no_objective'));
  assert.ok(issues.some((x) => x.code === 'no_turn'));
  assert.ok(issues.every((x) => ['info', 'warn'].includes(x.level)));
});

test('提示词契约：schema 与两套准则都要求「写满结构与细节」', () => {
  for (const key of ['objective', 'conflict', 'turn', 'beat', 'transition', 'durationSec', 'interior']) {
    assert.ok(SCREENPLAY_SCHEMA.includes(key), `schema 缺 ${key}`);
  }
  assert.match(SCREENPLAY_PROJECT_GUIDE, /episodeNo/, '整剧准则要求标注分集');
  assert.match(SCREENPLAY_PROJECT_GUIDE, /每集至少 2 场/);
  assert.match(SCREENPLAY_PROJECT_GUIDE, /excerpt/);
  assert.match(SCREENPLAY_GUIDE, /只写本集/);
  assert.match(SCREENPLAY_GUIDE, /每场必须写满戏剧结构/);
  for (const kw of ['对白', '动作', '画面', '旁白', '音效', '禁止写镜号']) {
    assert.ok(SCREENPLAY_FORMAT_GUIDE.includes(kw), `行规范缺 ${kw}`);
  }
});
