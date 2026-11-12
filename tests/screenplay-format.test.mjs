/* 剧本 v3「可拍摄契约」：行首标记 / 集场编号 / 跨集连续性的端到端校验
 * 运行：node --test tests/screenplay-format.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseScriptLine, parseScriptLineRich, episodeCodeOf, sceneCodeFor,
  continuityOf, screenplayContinuity, SCREENPLAY_FORMAT_GUIDE, SCREENPLAY_GUIDE,
  SCREENPLAY_PROJECT_GUIDE, SCREENPLAY_SCHEMA, SCENE_EXTRA_KEYS,
} from '../src/core/screenplay.mjs';
import { createProviders } from '../src/core/providers.mjs';
import {
  buildScriptVars, normalizeEpisodeScript, mergeScriptEdit,
  scriptStats, scriptTiming, scriptIssues, scriptToMarkdown,
} from '../src/core/episode-script.mjs';

const V3_LINES = [
  '# EP001 【雨夜来信】',
  '## EP001-SC001 内 · 旧城区巷口 · 深夜',
  '（沈砚把信纸翻到背面）',
  '沈砚（把照片推过桌面）：这张照片是十年前拍的。',
  '[OS] 林夏：别开门。',
  '[VO] 沈砚：那是我最后一次见到他。',
  '[SFX] 铁门被撞开，脚步停在门口。',
  '[画面文字] 手机屏幕：明天 23:00，别来。',
  '[连续性] 铜钱在沈砚左手里，门未锁。',
];

const mockProviders = () => createProviders({ apiKey: '' }, () => {});

test('parseScriptLineRich：v3 集首行 / 场次头 / 动作 / 表演策略 / 五类标记', () => {
  const [ep, head, act, dlg, os, vo, sfx, text, cont] = V3_LINES.map(parseScriptLineRich);
  assert.equal(ep.kind, 'heading');
  assert.equal(ep.sceneCode, 'EP001');
  assert.equal(ep.text, '雨夜来信');
  assert.equal(head.kind, 'heading');
  assert.equal(head.sceneCode, 'EP001-SC001');
  assert.equal(head.interior, '内景');
  assert.equal(head.location, '旧城区巷口');
  assert.equal(head.time, '深夜');
  assert.equal(act.kind, 'action');
  assert.equal(act.text, '沈砚把信纸翻到背面');
  assert.equal(dlg.kind, 'dialogue');
  assert.equal(dlg.speaker, '沈砚');
  assert.equal(dlg.cue, '把照片推过桌面', '括号里应读出可执行的表演策略');
  assert.equal(dlg.text, '这张照片是十年前拍的。');
  assert.equal(os.kind, 'dialogue');
  assert.equal(os.tag, 'OS');
  assert.equal(os.speaker, '林夏');
  assert.equal(vo.kind, 'narration');
  assert.equal(vo.tag, 'VO');
  assert.equal(sfx.kind, 'sound');
  assert.equal(sfx.tag, 'SFX');
  assert.equal(text.kind, 'subtitle');
  assert.equal(text.carrier, '手机屏幕');
  assert.equal(text.text, '明天 23:00，别来。');
  assert.equal(cont.kind, 'continuity');
  assert.match(cont.text, /铜钱在沈砚左手里/);
});

test('parseScriptLine：旧格式仍严格返回三字段，新标记行也被投影', () => {
  assert.deepEqual(parseScriptLine('沈砚（低声）：「你迟到了。」'),
    { kind: 'dialogue', speaker: '沈砚', text: '你迟到了。' });
  assert.equal(parseScriptLine('动作：雨落在伞面上。').kind, 'action');
  assert.equal(parseScriptLine('画面：灯管闪了两下。').kind, 'action');
  assert.equal(parseScriptLine('旁白：十年前的那一夜。').kind, 'narration');
  assert.equal(parseScriptLine('音效：门轴一声长响。').kind, 'sound');
  assert.equal(parseScriptLine('【夜 · 旧城区巷口】').kind, 'heading');
  assert.equal(parseScriptLine('雨没停。').kind, 'plain');
  assert.equal(parseScriptLine('   ').kind, 'empty');
  assert.deepEqual(parseScriptLine('[OS] 林夏：别开门。'),
    { kind: 'dialogue', speaker: '林夏', text: '别开门。' });
  assert.deepEqual(parseScriptLine('[连续性] 门未锁。'),
    { kind: 'continuity', speaker: '', text: '门未锁。' });
});

test('编号与连续性工具：EP001 / EP001-SC002 / 去重保序提取', () => {
  assert.equal(episodeCodeOf(1), 'EP001');
  assert.equal(episodeCodeOf(12), 'EP012');
  assert.equal(sceneCodeFor(1, 2), 'EP001-SC002');
  assert.deepEqual(continuityOf(['[连续性] 门未锁。', '（动作）', '[连续性] 门未锁。']), ['门未锁。']);
  const states = screenplayContinuity({
    scenes: [
      { continuity: ['铜钱在沈砚左手里。'], script: ['[连续性] 门未锁。'] },
      { script: ['[连续性] 铜钱在沈砚左手里。', '[连续性] 时间已过三日'] },
    ],
  });
  assert.deepEqual(states, ['铜钱在沈砚左手里。', '门未锁。', '时间已过三日']);
});

test('提示词契约：v3 行规范 + 两套准则 + schema 都要求新格式', () => {
  for (const kw of ['EP001-SC001', '[OS]', '[VO]', '[SFX]', '[画面文字]', '[连续性]',
    '一段只写一个可见变化', '不加引号', '禁止写镜号', '音效', '旁白']) {
    assert.ok(SCREENPLAY_FORMAT_GUIDE.includes(kw), `行规范缺 ${kw}`);
  }
  for (const kw of ['只写本集', 'sceneCodePrefix', 'prevContinuity', '[连续性]', 'targetScenes', '角色只能来自 characters']) {
    assert.ok(SCREENPLAY_GUIDE.includes(kw), `单集准则缺 ${kw}`);
  }
  for (const kw of ['EP<3 位集号>', '[连续性]', 'excerpt', '每集至少 2 场']) {
    assert.ok(SCREENPLAY_PROJECT_GUIDE.includes(kw), `整剧准则缺 ${kw}`);
  }
  for (const kw of ['episodeCode', 'sceneCode', 'continuity', 'objective', 'turn', 'transition']) {
    assert.ok(SCREENPLAY_SCHEMA.includes(kw), `schema 缺 ${kw}`);
  }
  assert.ok(SCENE_EXTRA_KEYS.includes('sceneCode') && SCENE_EXTRA_KEYS.includes('continuity'));
});

test('零 Key 单集生成：正文就是 v3 可拍摄格式（场次头 / 括号动作 / 表演策略 / 连续性）', async () => {
  const out = await mockProviders().generate('screenplay', {
    episodeNo: 2, episodeCode: 'EP002', sceneCodePrefix: 'EP002-SC',
    title: '旧案重开', logline: '沈砚来到废弃仓库', hook: '仓库深处传来脚步声',
    prevRecap: '照片背面写着他的名字', prevContinuity: ['铜钱在沈砚左手里'],
    originalText: '仓库铁门锈死了。他用肩膀撞开。灰尘在光柱里翻滚。地上有一只旧皮箱，锁扣却被人撬开过。「谁先来过？」沈砚低声问。',
    characters: [{ name: '沈砚' }, { name: '林夏' }], targetScenes: 3,
  });
  assert.equal(out.episodeCode, 'EP002');
  assert.equal(out.scenes.length, 3);
  for (const s of out.scenes) {
    assert.match(s.script[0], /^## EP002-SC\d{3}\s+(内|外|内外)\s*·/, `场次头不对：${s.script[0]}`);
    assert.equal(s.sceneCode, s.script[0].match(/^##\s*(EP\d{3}-SC\d{3})/)[1]);
    assert.ok(s.script.some((l) => /^（.+）$/.test(l)), '应有圆括号动作行');
    assert.ok(!s.script.some((l) => /^(动作|画面|旁白|音效)[：:]/.test(l)), '不应再输出旧格式行');
    assert.ok(!s.script.some((l) => /：「/.test(l)), '新对白不应带引号');
  }
  const all = out.scenes.flatMap((s) => s.script);
  assert.ok(all.some((l) => /^[^：:\s]{1,12}（[^）]+）：/.test(l)), '对白应带可执行的表演策略');
  assert.ok(all.some((l) => /^\[连续性\]/.test(l)), '末场应有 [连续性]');
  assert.ok(all.includes('[连续性] 铜钱在沈砚左手里'), '上一集状态应在开场被承接');
  assert.ok(out.scenes[out.scenes.length - 1].continuity.length, '末场 continuity 字段应被填充');
});

test('整剧兜底同样输出 v3 场次头，且每集编号独立', async () => {
  const out = await mockProviders().generate('screenplay', {
    title: '雨夜旧案', idea: '侦探在雨夜收到无名信',
    episodes: [
      { no: 1, title: '雨夜来信', summary: '沈砚收到无名信', hook: '照片背面写着他的名字',
        excerpt: '雨水顺着屋檐落下。沈砚捏着那封信，指节发白。「谁送来的？」他低声问。' },
      { no: 2, title: '旧案重开', summary: '沈砚来到废弃仓库', hook: '仓库深处传来脚步声',
        excerpt: '仓库铁门锈死了。他用肩膀撞开。地上有一只旧皮箱，锁扣被人撬开过。' },
    ],
    characters: [{ name: '沈砚' }],
  });
  assert.ok(out.scenes.length >= 4);
  for (const s of out.scenes) assert.match(s.script[0], /^## EP\d{3}-SC\d{3}\s+/);
  const codes = out.scenes.map((s) => s.sceneCode.slice(0, 5));
  assert.ok(codes.includes('EP001') && codes.includes('EP002'));
});

test('buildScriptVars：把上一集 [连续性] 注入下一集，并下发集 / 场编号', () => {
  const prev = {
    no: 1, title: '雨夜', season: 1, characterIds: ['c1'],
    script: { scenes: [{ script: ['[连续性] 铜钱在沈砚左手里。', '[连续性] 铁门未锁。'] }] },
  };
  const cur = { no: 2, title: '旧案', season: 1, characterIds: ['c1'], text: '仓库铁门锈死了。' };
  const p = { name: '雨夜侦探', management: { kind: 'novel', bible: { title: '雨夜侦探' },
    characters: [{ id: 'c1', name: '沈砚' }], episodes: [prev, cur] } };
  const vars = buildScriptVars(p, p.management, cur);
  assert.equal(vars.episodeCode, 'EP002');
  assert.equal(vars.sceneCodePrefix, 'EP002-SC');
  assert.deepEqual(vars.prevContinuity, ['铜钱在沈砚左手里。', '铁门未锁。']);
});

test('归一 / 人工编辑：sceneCode、episodeCode、continuity 不丢且随正文重算', () => {
  const raw = {
    title: '旧案重开', episodeCode: 'EP002',
    scenes: [{
      location: '仓库', time: '夜', summary: '撞开铁门', objective: '找到物证',
      script: ['## EP002-SC001 内 · 仓库 · 夜', '（铁门被撞开。）',
        '沈砚（蹲下去）：有人先来过。', '[连续性] 皮箱锁扣已被撬开。'],
    }],
  };
  const sc = normalizeEpisodeScript(raw, { ep: { no: 2 }, vars: { episodeNo: 2 } });
  assert.equal(sc.episodeCode, 'EP002');
  assert.equal(sc.scenes[0].sceneCode, 'EP002-SC001');
  assert.deepEqual(sc.scenes[0].continuity, ['皮箱锁扣已被撬开。']);
  // 完整 SCENE_EXTRA_KEYS 归一是 screenplay-detail.test.mjs 的职责；这里只验 v3 新增字段
  for (const key of ['episodeNo', 'no', 'sceneCode', 'continuity']) {
    assert.ok(key in sc.scenes[0], `归一后丢了 ${key}`);
  }

  const edited = mergeScriptEdit(sc, { scenes: [{
    id: sc.scenes[0].id, location: '仓库', time: '夜', summary: '撞开铁门（改）',
    script: ['## EP002-SC001 内 · 仓库 · 夜', '（铁门被撞开。）', '[连续性] 门仍开着。'],
  }] }, { ep: { no: 2 }, m: { characters: [] } });
  assert.equal(edited.scenes[0].sceneCode, 'EP002-SC001');
  assert.deepEqual(edited.scenes[0].continuity, ['门仍开着。'], '编辑后应按最终正文重算状态');
  assert.equal(edited.episodeCode, 'EP002');
});

test('统计口径：[OS] 算对白，VO / SFX / 画面文字 / 连续性不算', () => {
  const sc = { scenes: [{ script: [
    '## EP001-SC001 内 · 仓库 · 夜',
    '（沈砚推开门。）',
    '沈砚（把照片推过桌面）：你看这个。',
    '[OS] 林夏：别回头。',
    '[VO] 沈砚：那是十年前的事。',
    '[SFX] 铁门被撞开。',
    '[画面文字] 纸条：别来。',
    '[连续性] 门未锁。',
  ] }] };
  const stats = scriptStats(sc);
  assert.equal(stats.dialogueCount, 2);
  assert.equal(stats.offscreenCount, 1);
  assert.equal(stats.screenTextCount, 1);
  assert.equal(stats.continuityCount, 1);
  assert.deepEqual(stats.speakers, ['沈砚', '林夏']);
  const timing = scriptTiming(sc);
  assert.equal(timing.dialogueLines, 2);
  assert.equal(timing.narrationLines, 1);
  assert.equal(timing.screenTextLines, 1);
  assert.equal(timing.continuityLines, 1);
});

test('质量告警：新剧本缺末场 [连续性] 会提示，旧格式剧本不被刷屏', () => {
  const v3 = scriptIssues({ scenes: [{ location: '仓库', sceneCode: 'EP001-SC001',
    script: ['## EP001-SC001 内 · 仓库 · 夜', '（沈砚推开门。）'] }] });
  assert.ok(v3.some((x) => x.code === 'no_continuity'));
  const old = scriptIssues({ scenes: [{ location: '仓库',
    script: ['【夜 · 仓库】', '动作：门开了。'] }] });
  assert.ok(!old.some((x) => x.code === 'no_continuity'));
});

test('Markdown 导出：带 EP 编号 / sceneCode / 跨集状态', () => {
  const md = scriptToMarkdown({
    title: '旧案重开', episodeCode: 'EP002',
    scenes: [{ location: '仓库', time: '夜', sceneCode: 'EP002-SC001',
      script: ['## EP002-SC001 内 · 仓库 · 夜', '[连续性] 门未锁。'] }],
  }, { episodeNo: 2 });
  assert.match(md, /^# EP002 · 第 2 集 · 旧案重开/m);
  assert.match(md, /EP002-SC001/);
  assert.match(md, /\*\*跨集状态\*\*：门未锁。/);
  assert.match(md, /\[连续性\] 门未锁。/);
});

test('前端分行：v3 标记能分类，[OS] 算对白、其余标记不算', async () => {
  const { scriptLineClass } = await import('../public/project-view.js');
  assert.equal(scriptLineClass('## EP001-SC001 内 · 仓库 · 夜'), 'head');
  assert.equal(scriptLineClass('（沈砚推开门。）'), 'act');
  assert.equal(scriptLineClass('沈砚（把照片推过桌面）：你看这个。'), 'dlg');
  assert.equal(scriptLineClass('[OS] 林夏：别开门。'), 'dlg os');
  assert.equal(scriptLineClass('[VO] 沈砚：十年前。'), 'vo');
  assert.equal(scriptLineClass('[SFX] 铁门被撞开。'), 'sfx');
  assert.equal(scriptLineClass('[画面文字] 纸条：别来。'), 'screen');
  assert.equal(scriptLineClass('[连续性] 门未锁。'), 'cont');
  assert.equal(scriptLineClass('【夜 · 仓库】'), 'head');
  assert.equal(scriptLineClass('动作：门开了。'), 'act');

  const { isScriptDialogueLine } = await import('../public/episode-view.js');
  assert.equal(isScriptDialogueLine('沈砚：「你来晚了。」'), true);
  assert.equal(isScriptDialogueLine('[OS] 林夏：别开门。'), true);
  assert.equal(isScriptDialogueLine('[VO] 沈砚：十年前。'), false);
  assert.equal(isScriptDialogueLine('[画面文字] 纸条：别来。'), false);
  assert.equal(isScriptDialogueLine('（沈砚推开门。）'), false);
  assert.equal(isScriptDialogueLine('## EP001-SC001 内 · 仓库 · 夜'), false);
});
