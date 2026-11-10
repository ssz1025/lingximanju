/* 创作项目流水线构建（画布骨架 + management）· 单元测试
 * 运行：node --test tests/novel-project.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNovelProject, attachSource, refreshEpisodes, outputModeOf } from '../src/pipelines/novel-project.mjs';
import { STEPS, stepProgress } from '../src/core/project-steps.mjs';

const FILLER = '她把伞收起来，靠在门边，雨水顺着伞尖滴在地板上，一滴，又一滴，久久没有停。';
const NOVEL = (() => {
  const out = ['长夜书简'];
  for (let c = 1; c <= 4; c++) {
    out.push('', `第${['一', '二', '三', '四'][c - 1]}章 第${c}段`, '');
    for (let p = 0; p < 4; p++) { out.push(FILLER + `（第${c}章第${p + 1}段）`); out.push(''); }
  }
  return out.join('\n');
})();

test('outputModeOf 由交付物推导产物模式', () => {
  assert.equal(outputModeOf({ video: true, pack: true }), 'both');
  assert.equal(outputModeOf({ video: true, pack: false }), 'video');
  assert.equal(outputModeOf({ video: false, pack: true }), 'director-pack');
});

test('buildNovelProject 产出合法项目骨架', () => {
  const { project, novel, episodes } = buildNovelProject({
    text: NOVEL, filename: 'long.txt', name: '长夜书简',
    split: { strategy: 'chapter', targetChars: 400, maxEpisodes: 4 },
    deliverables: { video: true, pack: true },
  });

  assert.ok(project.id, '应生成项目 id');
  assert.equal(project.name, '长夜书简');
  assert.ok(Array.isArray(project.nodes) && project.nodes.length > 0, '应有画布节点');
  assert.ok(Array.isArray(project.edges), '应有连线');
  assert.equal(novel.chapterCount, 4);
  assert.equal(episodes.length, project.management.episodes.length);
});

test('buildNovelProject 画布含分集节点且与 management 对齐', () => {
  const { project } = buildNovelProject({
    text: NOVEL, filename: 'long.txt',
    split: { strategy: 'chapter', targetChars: 400, maxEpisodes: 4 },
    deliverables: { video: true, pack: true },
  });
  const epNodes = project.nodes.filter((n) => n.type === 'episode');
  assert.ok(epNodes.length >= 1, '画布上应有分集节点');
  assert.equal(epNodes.length, project.management.episodes.length);
  assert.ok(epNodes.every((n) => n.status === 'done'), '分集节点在新建时已完成');
});

test('buildNovelProject 连线引用存在的节点', () => {
  const { project } = buildNovelProject({
    text: NOVEL, filename: 'long.txt',
    split: { strategy: 'chapter', maxEpisodes: 4 },
    deliverables: { video: true, pack: true },
  });
  const ids = new Set(project.nodes.map((n) => n.id));
  for (const e of project.edges) {
    assert.ok(ids.has(e.from), `连线起点缺失：${e.from}`);
    assert.ok(ids.has(e.to), `连线终点缺失：${e.to}`);
  }
});

test('buildNovelProject management 六步且输出模式正确', () => {
  const { project } = buildNovelProject({
    text: NOVEL, filename: 'long.txt',
    split: { strategy: 'chapter', maxEpisodes: 4 },
    deliverables: { video: false, pack: true },
  });
  const m = project.management;
  assert.equal(m.kind, 'novel');
  assert.equal(m.steps.length, STEPS.length);
  assert.equal(m.deliverables.video, false);
  assert.equal(m.deliverables.pack, true);
  assert.equal(project.settings.comfy.outputMode, 'director-pack');
  assert.equal(m.source.chapterCount, 4);
  assert.ok(m.source.totalChars > 0);
  assert.equal(m.currentStep, 3);
});

test('buildNovelProject 上传节点携带原著全文供 RAG 检索', () => {
  const { project } = buildNovelProject({
    text: NOVEL, filename: 'long.txt',
    split: { strategy: 'chapter', maxEpisodes: 4 },
    deliverables: { video: true, pack: true },
  });
  const idea = project.nodes.find((n) => n.type === 'idea');
  assert.ok(idea, '应有承载原著的 idea 节点');
  assert.ok(idea.data.text.includes('第1章第1段'), 'idea 节点应携带原著全文');
});

test('buildNovelProject 进度初始为前两步完成', () => {
  const { project } = buildNovelProject({
    text: NOVEL, filename: 'long.txt',
    split: { strategy: 'chapter', maxEpisodes: 4 },
    deliverables: { video: true, pack: true },
  });
  const p = stepProgress(project.management);
  assert.equal(p.done, 2);
  assert.equal(p.total, 6);
  assert.equal(p.currentId, 'script');
});

test('refreshEpisodes 重算分集并同步画布节点', () => {
  const { project } = buildNovelProject({
    text: NOVEL, filename: 'long.txt',
    split: { strategy: 'chapter', targetChars: 400, maxEpisodes: 4 },
    deliverables: { video: true, pack: true },
  });
  const before = project.management.episodes.length;
  refreshEpisodes(project, { split: { strategy: 'scene', targetChars: 300, maxEpisodes: 6 } });

  assert.notEqual(project.management.episodes.length, before, '更换策略后分集数应变化');
  assert.equal(project.management.split.strategy, 'scene');
  assert.equal(project.management.split.maxEpisodes, 6);
  const epNodes = project.nodes.filter((n) => n.type === 'episode');
  assert.equal(epNodes.length, project.management.episodes.length, '画布分集节点应与分集数一致');
  const ids = new Set(project.nodes.map((n) => n.id));
  for (const e of project.edges) {
    assert.ok(ids.has(e.from) && ids.has(e.to), '刷新后连线仍应指向存在的节点');
  }
});

test('refreshEpisodes 保留原著全文与源信息', () => {
  const { project } = buildNovelProject({
    text: NOVEL, filename: 'long.txt',
    split: { strategy: 'chapter', maxEpisodes: 4 },
    deliverables: { video: true, pack: true },
  });
  refreshEpisodes(project, { split: { strategy: 'scene', targetChars: 300, maxEpisodes: 6 } });
  assert.equal(project.management.source.text, NOVEL.replace(/\n+/g, '\n').trim().length ? project.management.source.text : '');
  assert.ok(project.management.source.text.includes('第1章第1段'), '重新分集不应丢失原著全文');
  assert.equal(project.management.source.chapterCount, 4);
});

test('buildNovelProject 空文本 → 极简骨架：六步全待执行、不建分集节点', () => {
  const { project, skeleton, episodes } = buildNovelProject({
    text: '', filename: '', name: '空项目', split: { strategy: 'chapter', maxEpisodes: 4 },
    deliverables: { video: true, pack: true },
  });
  assert.equal(skeleton, true, '不传 text 应返回骨架而非抛错');
  assert.equal(episodes.length, 0, '骨架没有分集');
  const m = project.management;
  assert.equal(m.steps.filter((s) => s.status === 'done').length, 0, '骨架六步全待执行');
  assert.equal(m.steps[0].id, 'upload');
  assert.equal(m.currentStep, 1, '当前停在第 ① 步');
  assert.equal(m.source.text, '', '尚无原著');
  assert.equal(project.nodes.filter((n) => n.type === 'episode').length, 0, '骨架不建分集节点');
  assert.ok(project.nodes.length >= 5, '画布 DAG 必须保留');
});

test('attachSource 延迟上传小说 → 注入节点并完成 ①②', () => {
  const { project } = buildNovelProject({
    text: '', name: '骨架上传', split: { strategy: 'chapter', maxEpisodes: 4 },
    deliverables: { video: true, pack: true },
  });
  const r = attachSource(project, {
    text: NOVEL, filename: 'long.txt', split: { strategy: 'chapter', maxEpisodes: 4 },
  });
  assert.ok(r.episodes.length >= 1, '应产出分集');
  const m = project.management;
  assert.equal(m.steps.find((s) => s.id === 'upload').status, 'done', '① 应完成');
  assert.equal(m.steps.find((s) => s.id === 'episodes').status, 'done', '② 应完成');
  assert.ok(m.source.text.includes('第1章'), '原著全文应落盘到 management.source');
  assert.ok(project.nodes.some((n) => n.type === 'episode'), '应生成分集节点');
  const script = project.nodes.find((n) => n.type === 'script');
  assert.ok(script.data.novelEpisodes?.length >= 1, '分集梗概应注入剧本节点');
  assert.ok(script.data.novelEpisodes.every((e) => e.excerpt), '每集梗概应带中部摘录');
  assert.ok(script.data.novelExcerpt?.length > 0 && script.data.novelExcerpt.length <= 2400, 'novelExcerpt 为各集摘录拼接（≤2400 字）');
  assert.equal(stepProgress(m).done, 2, '进度应为 2/6');
});

test('attachSource 过短正文仍被校验拦截', () => {
  const { project } = buildNovelProject({
    text: '', name: '骨架短文', split: { strategy: 'chapter' }, deliverables: { video: true, pack: true },
  });
  assert.throws(() => attachSource(project, { text: '太短' }), /40/, '过短正文应抛出含字数提示的错误');
});

test('buildNovelProject 未选交付物时抛出错误', () => {
  assert.throws(
    () => buildNovelProject({ text: NOVEL, filename: 'long.txt', split: { strategy: 'chapter' }, deliverables: { video: false, pack: false } }),
    /至少/,
  );
});

/* ---------------------------------------------------------------------------
 * 超长小说自动分季：每 12 集一季，手动移季保留；重算分集不清空用户分组。
 * -------------------------------------------------------------------------*/
const LONG_NOVEL = (() => {
  const out = ['百卷长书'];
  for (let c = 1; c <= 30; c++) {
    out.push('', `第${c}章 卷${c}`, '');
    out.push(FILLER.repeat(12) + `（第${c}章结尾）`); // 每章约 340 字 → targetChars=300 时一章一集
    out.push('');
  }
  return out.join('\n');
})();

test('attachSource 超长小说自动分季：每 12 集一季并登记 seasons', () => {
  const built = buildNovelProject({ kind: 'novel', name: '自动分季' });
  const r = attachSource(built.project, {
    text: LONG_NOVEL, filename: 'long-novel.txt',
    split: { strategy: 'chapter', targetChars: 300, maxEpisodes: 30 },
  });
  const records = built.project.management.episodes;
  assert.ok(records.length > 12, `应有超过 12 集（实际 ${records.length}）才能触发分季`);
  const firstSeasonEps = records.filter((e) => e.season === 1);
  const secondSeasonEps = records.filter((e) => e.season === 2);
  assert.ok(firstSeasonEps.length > 0 && secondSeasonEps.length > 0, '至少应有两个非空季');
  assert.ok(records.every((e) => Number(e.season) >= 1), '每集都应有季归属');
  const seasons = built.project.management.seasons || [];
  const maxSeason = Math.max(...records.map((e) => e.season));
  assert.equal(seasons.length >= maxSeason, true, 'seasons[] 应登记所有用到的季号');
  assert.ok(/自动分 \d+ 季/.test(r.message), `上传消息应说明自动分季：${r.message}`);
});

test('手动分季在重算分集后保留', () => {
  const built = buildNovelProject({ kind: 'novel', name: '手动分季保留' });
  attachSource(built.project, {
    text: LONG_NOVEL, filename: 'long-novel.txt',
    split: { strategy: 'chapter', targetChars: 300, maxEpisodes: 30 },
  });
  const m = built.project.management;
  // 用户把第 1 集手动移到第 3 季
  m.episodes[0].season = 3;
  const r = refreshEpisodes(built.project, { split: { strategy: 'chapter', targetChars: 300, maxEpisodes: 30 } });
  assert.ok(r.records.length > 12);
  assert.equal(m.episodes[0].season, 3, '手动移过的季不应被重算冲掉');
  assert.ok(m.seasons.some((s) => Number(s.no) === 3), '第 3 季应保留登记');
});

test('split.seasonSize 自定义每季集数（上传与重算两入口都生效）', () => {
  // 上传入口：每季 10 集 → 30 集应分 3 季
  const built = buildNovelProject({ kind: 'novel', name: '自定义每季集数' });
  attachSource(built.project, {
    text: LONG_NOVEL, filename: 'long-novel.txt',
    split: { strategy: 'chapter', targetChars: 300, maxEpisodes: 30, seasonSize: 10 },
  });
  const m = built.project.management;
  assert.equal(m.split.seasonSize, 10, 'seasonSize 应写进 management.split');
  assert.equal(new Set(m.episodes.map((e) => e.season)).size, 3, '30 集按每季 10 集应分 3 季');
  assert.equal(m.episodes[9].season, 1, '第 9 集（索引 9）应在第 1 季');
  assert.equal(m.episodes[10].season, 2, '第 10 集（索引 10）应在第 2 季');

  // 重算入口：换回每季 15 集 → 未手动移季的集应重新归季
  const r = refreshEpisodes(built.project, {
    split: { strategy: 'chapter', targetChars: 300, maxEpisodes: 30, seasonSize: 15 },
  });
  const fresh = m.episodes.filter((e) => Number(e.season) === Math.floor(m.episodes.indexOf(e) / 15) + 1);
  assert.equal(fresh.length, m.episodes.length, '未手动移季的集应按新 seasonSize 归季');
  assert.equal(new Set(m.episodes.map((e) => e.season)).size, 2, '30 集按每季 15 集应分 2 季');
  assert.equal(m.split.seasonSize, 15, '重算后 seasonSize 应更新为 15');
  assert.ok(/自动分 2 季/.test(r.message), `重算消息应说明分季：${r.message}`);
});

test('split.seasonSize 缺省 / 非法值兜底为 12', () => {
  const built = buildNovelProject({ kind: 'novel', name: 'seasonSize 兜底' });
  attachSource(built.project, {
    text: LONG_NOVEL, filename: 'long-novel.txt',
    split: { strategy: 'chapter', targetChars: 300, maxEpisodes: 30, seasonSize: 0 },
  });
  const m = built.project.management;
  assert.equal(new Set(m.episodes.map((e) => e.season)).size >= 3, true, '非法 seasonSize 应回落默认 12（30 集 → ≥3 季）');
});
