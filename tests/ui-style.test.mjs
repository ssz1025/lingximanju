/* 全局样式统一 / 分季分集卡同构 / 简化操作界面 —— 回归测试
 * 运行：node --test tests/ui-style.test.mjs
 *
 * 锁定三件事：
 *   1. 功能零删减：project-view.js 的 data-act 入口集合与改造前完全一致（63 个）；
 *   2. 样式有单一真源：设计令牌存在、.btn.sm 已定义、六大组件族不再散写圆角/字号；
 *   3. 界面更简但不藏功能：分季分集卡是标准 .pv-card，次要动作进「更多操作」但仍在 DOM 里。
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

const {
  seasonsHTML, episodeFlowIntroHTML, activeEpisodeBarHTML,
  scriptConsoleHTML, episodeFlowHTML, setActiveEpisode,
} = await import('../public/project-view.js');

const ep = (no, season, done) => ({
  no, season, title: `第 ${no} 集 · 雨夜`, summary: '旧案重开，雨夜里有人敲门。',
  chars: 1200, chapters: [{ title: '第一章' }],
  script: done ? { source: 'llm', stats: { sceneCount: 3 }, scenes: [{}, {}, {}] } : null,
  characterIds: done ? ['c1'] : [],
  segments: done ? [{ no: 1, gridUrl: '/assets/a.svg', cells: [] }] : [],
  steps: done ? { context: { status: 'done' }, storyboard: { status: 'done' }, deliver: { status: 'done' } } : {},
  film: done ? { file: `ep${no}.mp4`, duration: 30 } : null,
});
const project = (episodes) => ({
  id: 'prj_style', name: '样式统一测试', nodes: [],
  management: {
    kind: 'novel', episodes, seasons: [{ no: 1 }, { no: 2 }],
    characters: [{ id: 'c1', name: '沈砚' }],
    sources: [{ name: '原著.txt', chars: 12000, chapterTitles: ['第一章'] }],
    chapters: [{ title: '第一章', episodeNo: 1, sourceName: '原著.txt' }],
  },
});

/* --------------------------- 1. 功能入口零删减 --------------------------- */
const BASELINE_ACTS = [
  'add-season', 'ai-cover', 'ai-fill', 'assets', 'cancel-script', 'char-detail', 'char-extract',
  'char-gen-all', 'char-gen-one', 'char-job-cancel', 'char-regen-all', 'char-regen-view', 'chars',
  'chat-step', 'cover', 'dl-film', 'dl-pack', 'edit-script', 'ep-next', 'ep-prev', 'export-scripts',
  'finalize-ep', 'gen-ep-script', 'gen-scripts', 'gen-season-scripts', 'goto-ai', 'goto-storyboard',
  'goto-upload', 'manage', 'open-assets', 'open-canvas', 'open-ep-canvas', 'open-episode',
  'open-overall', 'open-season-canvas', 'pick-ep', 're-split', 'read-script', 'refresh-assets',
  'remove-season', 'run-all', 'run-ep-step', 'run-ep-steps', 'run-next', 'run-step', 'save-info',
  'save-script', 'sb-apply', 'sb-save', 'sheet-open', 'shot-open', 'shot-regen', 'start-ep-flow',
  'sx-clear-filter', 'sx-toggle-season', 'task-reconcile', 'task-refresh', 'toggle-ai', 'toggle-nav',
  'toggle-script', 'toggle-source', 'toggle-upload', 'view-source',
];

test('改造后所有功能入口仍在：data-act 集合与基线完全一致（63 个）', () => {
  const acts = [...new Set([...viewSrc.matchAll(/data-act="([a-z0-9-]+)"/g)].map((m) => m[1]))].sort();
  assert.deepEqual(acts, BASELINE_ACTS, '不能因为「简化界面」删掉任何一个动作');
});

/* --------------------------- 2. 样式单一真源 --------------------------- */
test('设计令牌齐备，.btn.sm 已正式定义（此前 78 处使用全部失效）', () => {
  for (const tok of ['--radius-xs', '--radius-sm', '--radius-md', '--radius-lg', '--radius-pill',
    '--sp-1', '--sp-3', '--sp-5', '--fs-2xs', '--fs-xs', '--fs-sm', '--fs-md', '--fs-lg',
    '--fs-xl', '--btn-h']) {
    assert.match(css, new RegExp(`${tok}\\s*:`), `缺少令牌 ${tok}`);
  }
  assert.match(css, /\.btn\.sm\s*\{[^}]*font-size:\s*var\(--fs-xs\)/, '.btn.sm 必须定义且走字号令牌');
  assert.match(css, /\.btn\.xs\s*\{/, '.btn.xs 必须定义');
});

test('分季分集卡不再自带页面级容器（消除卡中卡的双重内距）', () => {
  const rule = css.match(/\.sx-wrap,\s*\.ax-wrap\s*\{[^}]*\}/)?.[0] || '';
  assert.ok(rule, '.sx-wrap 规则存在');
  assert.ok(!/max-width:\s*1460px/.test(rule), '不应再限制 1460px 居中容器');
  assert.ok(!/padding:\s*14px/.test(rule), '不应再叠加一层 14px 内距');
  assert.match(viewSrc, /class="pv-card sx-wrap"/, '外层应使用标准 .pv-card');
});

test('六大组件族的工作台区段不再散写圆角与字号', () => {
  const sections = [
    ['sx', '/* ---------------- 分季 / 分集 ---------------- */', '/* ---------------- 资源归纳 ---------------- */'],
    ['sw', '* 分季分集 · 剧本工作台', '/* ---------- 剧集详情 · 剧本 tab ---------- */'],
    ['fl', '* 第 27 节 · 剧集流水线', '/* 第⑤步任务进度条补充'],
    ['epb', '* 第 28 节 · 当前剧集', '__EOF__'],
  ];
  for (const [name, a, b] of sections) {
    const i = css.indexOf(a);
    assert.ok(i >= 0, `找不到 ${name} 区段`);
    const j = b === '__EOF__' ? css.length : css.indexOf(b, i);
    const seg = css.slice(i, j);
    const fsHard = [...seg.matchAll(/font-size:\s*([\d.]+)px(?=\s*;)/g)]
      .map((m) => Number(m[1])).filter((n) => n <= 17);
    const rdHard = [...seg.matchAll(/border-radius:\s*(\d+)px(?=\s*;)/g)]
      .map((m) => Number(m[1])).filter((n) => n >= 5);
    assert.deepEqual(fsHard, [], `${name} 区段仍有硬编码字号`);
    assert.deepEqual(rdHard, [], `${name} 区段仍有硬编码圆角`);
  }
});

/* --------------------------- 3. 界面更简但功能可见 --------------------------- */
const P = project([ep(1, 1, true), ep(2, 1, false), ep(3, 2, false)]);

test('分季分集卡：标准卡头 + 季分组 + 每集主行动可见，次要动作收进「更多操作」但仍在 DOM', () => {
  const html = seasonsHTML(P, {});
  assert.match(html, /class="pv-card sx-wrap"/);
  assert.match(html, /class="pv-card-head sx-head"/);
  assert.match(html, /class="sx-head-tit"/);
  assert.match(html, /<details class="sx-more">/, '次要动作应有折叠菜单');
  for (const act of ['add-season', 'open-overall', 'export-scripts', 'gen-scripts',
    'gen-season-scripts', 'open-season-canvas', 'remove-season', 'pick-ep',
    'read-script', 'gen-ep-script', 'open-episode', 'open-ep-canvas', 'sx-toggle-season']) {
    assert.match(html, new RegExp(`data-act="${act}"`), `${act} 不能因收拢而丢失`);
  }
  assert.match(html, /<details class="sx-foot">/, '底部长说明应可折叠');
  assert.ok(!/undefined|NaN/.test(html), '渲染结果不应出现脏值');
});

test('③ 顺序说明条：默认只显示制作队列，层级说明折叠但文案与动作全保留', () => {
  const intro = episodeFlowIntroHTML(P, P.management);
  assert.match(intro, /<details class="fl-intro-more">/);
  assert.match(intro, /① 基础信息 · ② 准备故事 · ③ 分集拆解/);
  assert.match(intro, /④ 剧本 → ⑤ 角色·上下文 → ⑥ 分镜 → ⑦ 视频·成片/);
  assert.match(intro, /当前制作位 第 1 季 第 1 集/, '四段做完但未定稿时仍停在第一季第一集等定稿');
  assert.match(intro, /data-act="start-ep-flow"/);
  assert.ok(!/undefined|NaN/.test(intro));
});

/* ------------- 4. 设置弹窗「媒体生成接口档案」的窄容器布局 ------------- */
const panelsSrc = fs.readFileSync(path.join(ROOT, 'public/panels.js'), 'utf8');

test('接口档案参数表按弹窗内容区自适应，窄容器不再两列乱排 / 表头不再消失', () => {
  assert.match(css, /\.settings-main\s*\{[^}]*container:\s*settings\s*\/\s*inline-size/,
    '右侧内容区需声明为尺寸查询容器');
  const block = css.match(/@container\s+settings\s*\(max-width:\s*760px\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
  assert.ok(block, '主断点必须是容器查询而不是视口媒体查询');
  assert.match(block, /\.mi-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)\s+44px/,
    '窄容器应是三列两行，不是 1fr 1fr 两列');
  for (const rule of [
    '.mi-row > .mi-slot { grid-column: 1; grid-row: 1; }',
    '.mi-row > .mi-cur { grid-column: 2; grid-row: 1; }',
    '.mi-row > select[data-cell="source"] { grid-column: 1; grid-row: 2; }',
    '.mi-row > .mi-cfg { grid-column: 2; grid-row: 2; }',
    '.mi-row > .mi-order { grid-column: 3; grid-row: 1 / 3;',
    '.mi-row > .mi-detail { grid-column: 1 / -1; grid-row: 3; }',
    '.mi-th > :nth-child(5) { grid-column: 3; grid-row: 1 / 3;',
  ]) assert.ok(block.includes(rule), `缺少显式格位规则：${rule}`);
  assert.ok(!/\.mi-th\s*\{[^}]*display:\s*none/.test(css), '表头不能按视口整块隐藏');
  assert.match(css, /@container\s+settings\s*\(max-width:\s*620px\)\s*\{[^}]*#iface-bindings\s+\.modal-grid/,
    '板块绑定表在更窄时才转单列');
  assert.match(css, /@supports\s+not\s*\(container-type:\s*inline-size\)/, '不支持容器查询的内核需有兜底');
  assert.match(css, /\.mi-nodes\s*>\s*\.mi-node\s*\{\s*flex:\s*none;\s*\}/,
    'flex 列容器里的节点卡片不可被压缩，否则第二行的取值来源下拉会被裁掉');
  assert.match(panelsSrc, /class="iface-meta"/, '档案卡信息区需成组');
  assert.match(panelsSrc, /class="iface-actions"/, '档案卡操作区需成组，按钮不逐颗散落');
});

test('统一后其它渲染部件仍能正常出 HTML，且无脏值', () => {
  setActiveEpisode(P, 2);
  const parts = {
    bar: activeEpisodeBarHTML(P, P.management),
    script: scriptConsoleHTML(P, P.management, { status: 'pending' }),
    flow: episodeFlowHTML(P, P.management, 'storyboard'),
  };
  for (const [name, html] of Object.entries(parts)) {
    assert.ok(html.length > 100, `${name} 渲染为空`);
    assert.ok(!/undefined|NaN/.test(html), `${name} 出现脏值`);
    assert.match(html, /第 \d+ 季 第 \d+ 集/, `${name} 缺少完整中文剧集标签`);
  }
});
