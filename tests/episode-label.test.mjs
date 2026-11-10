/* 中文剧集标签 · 界面不再出现 EP / S01 / S01E02 这类英文缩略
 * 运行：node --test tests/episode-label.test.mjs
 *
 * 锁定：季和集都用「第 N 季 / 第 N 集」写全；集号沿用全局唯一编号；
 * 所有选集控件、制作队列、状态提示都走 project-model.js 的同一组标签函数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
};

const PM = await import('../public/project-model.js');
const {
  activeEpisodeBarHTML, episodeFlowHTML, episodeFlowIntroHTML, scriptConsoleHTML,
  stepSectionHTML, WORKSHOP_STEPS, flowChainLineHTML, setActiveEpisode,
} = await import('../public/project-view.js');

const eps = [
  { no: 1, season: 1, title: '雨夜',
    script: { source: 'llm', stats: { sceneCount: 2 }, scenes: [{}, {}] }, characterIds: ['c1'],
    segments: [{ no: 1, gridUrl: '/assets/a.svg', cells: [] }],
    steps: { context: { status: 'done' }, storyboard: { status: 'done' }, deliver: { status: 'done' } },
    film: { file: 'a.mp4', duration: 30 } },
  { no: 2, season: 1, title: '门铃', script: null, characterIds: [], segments: [], steps: {} },
  // 第二季首集用全局集号 4：验证「集号全局唯一、季只是分组」的口径
  { no: 4, season: 2, title: '信', script: null, characterIds: [], segments: [], steps: {} },
];

const project = () => ({
  id: 'prj_label', name: '剧集标签测试', nodes: [],
  management: {
    kind: 'novel', episodes: eps, seasons: [{ no: 1 }, { no: 2 }],
    characters: [{ id: 'c1', name: '沈砚' }],
  },
});

/** 用户可见文案里的英文缩略（不含 data-ep-* 这类内部属性名、场景 id） */
const EN_SHORTHAND = /\bEP\s*\d|>S\d{1,2}<|\bS\d{2}E\d{2}\b|·\s*S\d{2}\b/;

test('标签纯函数：季、集、完整剧集都是中文，异常值不产出 undefined / NaN', () => {
  assert.equal(PM.seasonLabel(1), '第 1 季');
  assert.equal(PM.seasonLabel(12), '第 12 季');
  assert.equal(PM.episodeNoLabel(4), '第 4 集');
  assert.equal(PM.episodeLabelFull(2, 4), '第 2 季 第 4 集');
  assert.equal(PM.queueItemLabel({ season: 2, no: 4 }), '第 2 季 第 4 集');
  for (const out of [PM.seasonLabel(0), PM.episodeNoLabel(NaN), PM.episodeLabelFull(null, undefined)]) {
    assert.ok(!/undefined|NaN/.test(out), `标签出现脏值：${out}`);
    assert.match(out, /第 \? (季|集)/);
  }
});

test('集号口径：第二季首集仍写全局第 4 集，不悄悄改成季内第 1 集', () => {
  const q = PM.episodeQueue(project());
  assert.deepEqual(q.map((x) => PM.queueItemLabel(x)), [
    '第 1 季 第 1 集', '第 1 季 第 2 集', '第 2 季 第 4 集',
  ]);
  assert.equal(q[2].indexInSeason, 1, '季内序号仍单独记录，但不替代全局集号');
});

test('选集控件给出明确的「第 1 季 第 2 集」，不再用 EP / S01', () => {
  const p = project();
  setActiveEpisode(p, 2);
  const bar = activeEpisodeBarHTML(p, p.management);
  assert.match(bar, /<span class="epb-no">第 1 季 第 2 集<\/span>/);
  assert.match(bar, /<option value="1"[^>]*>第 1 季/);
  assert.match(bar, /<option value="2" selected>第 1 季 第 2 集 · 门铃/);
  assert.match(bar, /data-act="ep-prev" data-no="1"/);
  assert.match(bar, /data-act="ep-next" data-no="4"/, '下一集跨季仍连续');
});

test('渲染结果不含英文剧集缩略（顶部条 / 说明条 / 流水线 / 剧本台 / 区头 / 任务链）', () => {
  const p = project();
  setActiveEpisode(p, 2);
  const m = p.management;
  const parts = {
    顶部条: activeEpisodeBarHTML(p, m),
    说明条: episodeFlowIntroHTML(p, m),
    流水线: episodeFlowHTML(p, m, 'storyboard'),
    剧本台: scriptConsoleHTML(p, m, {}),
    区头: stepSectionHTML(WORKSHOP_STEPS.find((s) => s.id === 'storyboard'), 6, m, '', false),
    任务链: flowChainLineHTML('script'),
  };
  for (const [name, html] of Object.entries(parts)) {
    assert.ok(!EN_SHORTHAND.test(html), `${name} 仍出现英文剧集缩略：${html.match(EN_SHORTHAND)?.[0]}`);
    assert.ok(!/undefined|NaN/.test(html), `${name} 出现脏值`);
    // 任务链是四段任务的静态链条，本身不带集号；其余部件都必须写明是哪一集
    if (name !== '任务链') assert.match(html, /第 \d+ 季 第 \d+ 集/, `${name} 缺少完整中文剧集标签`);
  }
  assert.match(parts.任务链, /本集任务链/);
  assert.match(parts.说明条, /第 1 季 第 1 集 → 第 1 季 第 2 集 → 第 2 季 第 4 集/);
  assert.match(parts.说明条, /从 第 1 季 第 1 集 开始制作/);
  assert.match(parts.区头, /剧集级 · 第 1 季 第 2 集 · 第 3\/4 段/);
});

test('剧集详情页主标签同样中文（headerHTML 未导出，静态核对渲染模板）', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(root, 'public', 'episode-view.js'), 'utf8');
  const line = src.split('\n').find((l) => l.includes('class="ev-no"'));
  assert.ok(line, '找不到详情页剧集标签');
  assert.match(line, /episodeLabelFull\(PMODEL\.seasonOf\(ep\), ep\.no\)/);
  assert.ok(!/EP \$\{|S\d\dE/.test(line), '详情页标签仍用英文缩略');
});
