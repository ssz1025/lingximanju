/* 剧集流水线（④之后的按集任务台）· 渲染口径单元测试
 * 运行：node --test tests/episode-flow.test.mjs
 *
 * 这组断言锁定「分集之后任务挂在集上」的四件事：
 *   ① 每集一行，四段任务（剧本 / 角色·上下文 / 分镜 / 视频·成片）都要出现；
 *   ② 「下一步」必须是四段里第一个没完成的，不能让用户从中间跳；
 *   ③ 只有选中的那一集展开任务面板，其余行保持折叠；
 *   ④ 步骤区头不再提供含糊的「执行本步」，而是只跑当前剧集。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 模块顶层会读 localStorage 偏好，Node 下给个最小实现
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const {
  episodeFlowHTML, episodeFlowIntroHTML, flowChainLineHTML, stepSectionHTML, WORKSHOP_STEPS, setActiveEpisode,
} = await import('../public/project-view.js');

const seg = (n, grid) => Array.from({ length: n }, (_, i) => ({
  no: i + 1, title: `第 ${i + 1} 段`, gridUrl: grid ? `/assets/x${i}.svg` : '', cells: [],
}));
const script = (scenes) => ({ source: 'llm', stats: { sceneCount: scenes, chars: 1200 }, scenes: Array.from({ length: scenes }, () => ({})) });

function project(episodes) {
  const management = { kind: 'novel', episodes };
  return { id: 'prj_test', name: '测试项目', nodes: [], management };
}

const eps = [
  { no: 1, title: '第一章 · 雨夜', chars: 1400, script: script(6), characterIds: ['c1', 'c2'], segments: seg(4, true),
    steps: { context: { status: 'done' }, storyboard: { status: 'done' }, deliver: { status: 'done' } }, film: { file: 'ep1.mp4', duration: 38 } },
  { no: 2, title: '第二章 · 门铃', chars: 1200, script: script(5), characterIds: ['c1'], segments: seg(5, false),
    steps: { context: { status: 'done' }, storyboard: { status: 'running' } } },
  { no: 3, title: '第三章 · 信', chars: 900, script: null, characterIds: [], segments: [], steps: {} },
];

// 需求变更：当前剧集默认「第 1 季 第 1 集」，测试里显式选中第 2 集再渲染
const flowProject = project(eps);
setActiveEpisode(flowProject, 2);
const html = episodeFlowHTML(flowProject, { episodes: eps }, 'storyboard');

test('每集一行，四段任务标签齐全', () => {
  for (const ep of eps) assert.match(html, new RegExp(`第 1 季 第 ${ep.no} 集`));
  for (const label of ['剧本', '上下文', '分镜', '成片']) assert.ok(html.includes(label), `缺少阶段 ${label}`);
  assert.equal((html.match(/data-ep-row=/g) || []).length, eps.length);
});

test('「下一步」取四段里第一个未完成的阶段', () => {
  // EP01 四段全完成 → 不再给「下一步」
  assert.match(html, /四段已完成/);
  // EP02 剧本 / 上下文已完成，分镜在跑 → 下一步按钮应指向分镜且因运行中而禁用
  assert.match(html, /进行中 · 分镜/);
  // EP03 没剧本 → 下一步必须是剧本，而不是跳过剧本去跑上下文
  assert.match(html, /data-act="gen-ep-script" data-force="0"[^>]*>下一步 · 剧本/);
});

test('只展开选中剧集的任务面板，且四段都能单独执行', () => {
  assert.equal((html.match(/class="fl-panel"/g) || []).length, 1);
  assert.match(html, /当前剧集 · 第 1 季 第 2 集/);
  assert.ok(!/当前剧集 · 第 1 季 第 1 集/.test(html));
  // 面板内四段各有执行入口：剧本走 gen-ep-script，其余走 run-ep-step
  assert.match(html, /data-act="gen-ep-script" data-force="1" data-no="2"/);
  for (const step of ['context', 'storyboard', 'deliver']) {
    assert.match(html, new RegExp(`data-act="run-ep-step" data-step="${step}" data-force="[01]" data-no="2"`));
  }
});

test('项目级 / 剧集级的边界写在卡片里，不留想象空间', () => {
  assert.match(html, /项目级/);
  assert.match(html, /剧集级/);
  assert.match(html, /选中哪一集，下面四段就作用在哪一集/);
  // 批量补齐只针对当前步骤
  assert.match(html, /data-act="run-ep-steps" data-step="storyboard"/);
});

test('分集说明条：层级 + 按季按集的顺序制作位与定稿入口', () => {
  const intro = episodeFlowIntroHTML(project(eps), { episodes: eps });
  assert.match(intro, /分集之后怎么走/);
  assert.match(intro, /① 基础信息 · ② 准备故事 · ③ 分集拆解/);
  assert.match(intro, /④ 剧本 → ⑤ 角色·上下文 → ⑥ 分镜 → ⑦ 视频·成片/);
  // 顺序口径：没有任何集定稿 → 制作位固定第 1 季 第 1 集（即使第 1 集四段已完成）
  assert.match(intro, /默认第一季第一集/);
  assert.match(intro, /制作队列/);
  assert.match(intro, /当前制作位 第 1 季 第 1 集/);
  assert.match(intro, /从 第 1 季 第 1 集 开始制作（下一步：定稿本集）/);
  assert.match(intro, /data-act="start-ep-flow" data-no="1"/);
  // 第 1 集四段已完成但还未定稿 → 直接给定稿按钮
  assert.match(intro, /data-act="finalize-ep" data-no="1" data-on="1"/);
});

test('剧本台的任务链条目当前段高亮', () => {
  const line = flowChainLineHTML('script');
  assert.match(line, /本集任务链/);
  assert.match(line, /class="fl-chainstep on">剧本/);
  assert.match(line, /换集 = 换一套任务/);
});

test('剧集级步骤的区头动作只跑当前剧集', () => {
  const m = { episodes: eps };
  const step = WORKSHOP_STEPS.find((s) => s.id === 'storyboard');
  const head = stepSectionHTML(step, 6, m, '', false);
  // 当前剧集由流水线选中状态决定（模块内按项目记忆），区头必须与它一致
  const picked = head.match(/剧集级 · 第 1 季 第 (\d+) 集/)?.[1];
  assert.ok(picked, '区头缺少「剧集级 · 第 x 季 第 y 集」层级标签');
  assert.match(head, new RegExp(`data-act="run-ep-step" data-step="storyboard" data-no="${Number(picked)}"`));
  assert.ok(!/data-act="run-step"/.test(head), '不应再出现项目级整跑按钮');
  assert.match(head, new RegExp(`执行本集（第 ${Number(picked)} 集）`));
  // 剧本步走生成接口：该集已有剧本时带 force=1（会二次确认，不静默覆盖）
  const scriptStep = WORKSHOP_STEPS.find((s) => s.id === 'script');
  const scriptHead = stepSectionHTML(scriptStep, 4, m, '', false);
  assert.match(scriptHead, /data-act="gen-ep-script"/);
  assert.match(scriptHead, /data-force="[01]"/);
  assert.match(scriptHead, /(生成|重写)本集剧本/);
});

test('空分集不崩，给出明确的前置提示', () => {
  const out = episodeFlowHTML(project([]), { episodes: [] }, 'context');
  assert.match(out, /先在第 ③ 步完成「分集拆解」/);
  assert.equal(episodeFlowIntroHTML(project([]), { episodes: [] }), '');
});

test('渲染结果不出现 undefined / NaN', () => {
  assert.ok(!/undefined|NaN/.test(html), '流水线卡片里出现了 undefined / NaN');
  assert.ok(!/undefined|NaN/.test(episodeFlowIntroHTML(project(eps), { episodes: eps })));
});
