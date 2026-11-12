/* ② 故事来源二选一 + 上传卡精简 / 拖拽投放 + ① 无故事引导弹窗 —— 回归测试
 * 运行：node --test tests/story-source.test.mjs
 *
 * 锁定四件事：
 *   1. 「上传小说 / AI 生成小说」是互斥的二选一，同一时刻只展开一张表单；
 *   2. 精简界面不删功能：选择文件 / 示例 / 清空 / 粘贴 / 拆分规则 / 提交全部还在；
 *   3. 拖拽投放复用既有 readFiles（排序、上限、chips、提交链路不变）；
 *   4. data-act 基线仍是 63 个，弹窗与切换项不新增 / 删除任何功能入口。
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
  removeItem: (k) => store.delete(k),
};

const { sourceCardHTML, uploadConsoleHTML } = await import('../public/project-view.js');

const mEmpty = {
  kind: 'novel', episodes: [], bible: {},
  split: { strategy: 'chapter', targetChars: 1200, maxEpisodes: 4, seasonSize: 12 },
};
const mStory = {
  ...mEmpty,
  source: { text: '第一章 没有署名的信……', title: '雨夜来信', chapterCount: 2, totalChars: 120 },
  episodes: [{ no: 1 }],
};

test('故事来源卡：两个入口是互斥的二选一，选中态唯一', () => {
  const upload = sourceCardHTML(mEmpty, { source: 'upload' });
  assert.match(upload, /二选一/);
  assert.match(upload, /data-act="goto-upload"/);
  assert.match(upload, /data-act="goto-ai"/);
  assert.match(upload, /data-story-source="upload"/);
  assert.match(upload, /data-story-source="ai"/);
  assert.equal((upload.match(/pv-story-opt selected/g) || []).length, 1, '只能有一个选中态');
  const ai = sourceCardHTML(mEmpty, { source: 'ai' });
  assert.equal((ai.match(/pv-story-opt selected/g) || []).length, 1);
  assert.match(ai, /data-story-source="ai"[^>]*aria-pressed="true"/);
  assert.doesNotMatch(ai, /data-story-source="upload"[^>]*aria-pressed="true"/);
});

test('同一时刻只展开一种来源表单；已有故事时默认收起', () => {
  const up = uploadConsoleHTML(mEmpty, { source: 'upload', open: true });
  assert.match(up, /id="pv-upload-card"/);
  assert.doesNotMatch(up, /id="pv-ai-card"/, '选上传时不得同时铺开 AI 表单');
  const ai = uploadConsoleHTML(mEmpty, { source: 'ai', open: true });
  assert.match(ai, /id="pv-ai-card"/);
  assert.doesNotMatch(ai, /id="pv-upload-card"/, '选 AI 时不得同时铺开上传表单');
  const ready = uploadConsoleHTML(mStory, { source: 'upload', open: false });
  assert.match(ready, /故事已就绪/);
  assert.match(ready, /data-act="toggle-upload"/);
  assert.match(ready, /data-act="toggle-ai"/);
  assert.doesNotMatch(ready, /id="pv-upload-card"|id="pv-ai-card"/, '已有故事且未点重新上传时两张表单都收起');
});

test('上传卡精简但功能入口零删减，拆分规则收进折叠区', () => {
  const up = uploadConsoleHTML(mEmpty, { source: 'upload', open: true });
  for (const act of ['file', 'sample', 'clear', 'submit']) {
    assert.match(up, new RegExp(`data-up="${act}"`), `data-up="${act}" 不能丢`);
  }
  for (const id of ['pv-up-files', 'pv-up-text', 'pv-up-target', 'pv-up-max', 'pv-up-season']) {
    assert.match(up, new RegExp(`id="${id}"`), `${id} 不能丢`);
  }
  assert.match(up, /data-up-split="chapter"/, '折叠区内的规则控件仍在 DOM，readSplit 读得到');
  assert.match(up, /<details class="pv-up-rules">/, '拆分规则改为可折叠');
  assert.match(up, /data-drop-zone="upload"/);
  assert.match(up, /把小说文件拖到这里/);
  assert.doesNotMatch(up, /可一次选上百个分卷文件/, '冗长说明已精简');
});

test('拖拽投放复用 readFiles，样式走设计令牌', () => {
  assert.match(viewSrc, /addEventListener\('drop', \(e\) => \{[\s\S]{0,220}readFiles\(e\.dataTransfer\?\.files\)/);
  assert.match(viewSrc, /addEventListener\('dragover'/);
  assert.match(viewSrc, /classList\.add\('is-dragover'\)/);
  assert.match(viewSrc, /host\.dataset\.dropGuard/, '防止拖到别处时浏览器直接打开文件');
  const block = css.slice(css.indexOf('/* ---- ② 故事来源二选一'), css.indexOf('/* ---- 剧集详情页 ---- */'));
  assert.ok(block.length > 100, '新增样式段存在');
  assert.match(block, /\.pv-drop-zone\s*\{/);
  assert.match(block, /\.pv-upload-card\.is-dragover/);
  assert.match(block, /\.pv-story-opt\.selected/);
  assert.match(block, /\.pv-nostory-modal/);
  assert.match(block, /var\(--/, '全部走设计令牌，深浅主题自适应');
  assert.doesNotMatch(block, /#[0-9a-fA-F]{6}/, '新增样式不得硬编码颜色');
});

test('二选一状态默认上传小说，切项目重置；切换时关掉另一来源', () => {
  assert.match(viewSrc, /storySource: 'upload'/);
  assert.match(viewSrc, /ui\.storySource = 'upload';\s*\n\s*ui\.upload =/, 'resetUi 里重置来源');
  assert.match(viewSrc, /const selectStorySource = \(which\) => \{[\s\S]{0,240}ui\.upload\.open = which === 'upload';[\s\S]{0,120}ui\.ai\.open = which === 'ai';/);
});

test('功能入口基线仍是 63 个，弹窗与切换项不新增 data-act', () => {
  const acts = [...new Set([...viewSrc.matchAll(/data-act="([a-z0-9-]+)"/g)].map((m) => m[1]))].sort();
  assert.equal(acts.length, 63, 'data-act 集合数量不变');
  for (const a of ['goto-upload', 'goto-ai', 'toggle-upload', 'toggle-ai', 'ai-fill', 'view-source']) {
    assert.ok(acts.includes(a), `${a} 入口不能删`);
  }
  const dlg = viewSrc.slice(viewSrc.indexOf('function openNoStoryDialog'), viewSrc.indexOf('export function infoCardHTML'));
  assert.doesNotMatch(dlg, /data-act=/, '弹窗按钮一律用 data-ns');
});
