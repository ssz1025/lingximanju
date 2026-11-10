/* 页面逻辑优化新增领域逻辑 · 单元测试
 * 覆盖：多文件合并、章节↔剧集关联、单集分段/角色/资源图、宫格图 SVG、全局模型配置合并
 * 运行：node --test tests/page-flow.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeNovelFiles, parseNovel } from '../src/core/novel.mjs';
import {
  segmentId, linkChapters, buildEpisodeRecords, reconstructEpisodeText,
  splitSegments, matchEpisodeCharacters, buildEpisodeGraph,
} from '../src/core/episode-model.mjs';
import { storyboardGridSVG, gridShotList } from '../src/core/grid-art.mjs';
import {
  DEFAULT_LLM, normalizeLlm, llmConfigured, maskKey,
  appSettingsSummary, mergeLlmSettings,
} from '../src/core/app-settings.mjs';

const UPPER = `第一章 雨夜来信
沈砚在雨夜推开那扇门，桌上一封信没有署名。他抬眼望向远处，屋里安静得只剩雨声。
林夏低声说了一句话，随后一切又安静下来。`;
const LOWER = `第二章 真相
第二天清晨，沈砚回到老地方，终于读懂了那封信。林夏已经在门口等他，手里拿着同一张纸。
两个人对视了很久，谁都没有先开口。`;

/* ------------------------------------------------------------ 多文件合并 */
test('mergeNovelFiles：空输入 / 超过 200 个文件都给出可读错误', () => {
  assert.equal(mergeNovelFiles([]).ok, false);
  assert.equal(mergeNovelFiles([{ name: 'a.txt', text: '   ' }]).ok, false);
  const many = Array.from({ length: 201 }, (_, i) => ({ name: `f${i}.txt`, text: '内容' }));
  const out = mergeNovelFiles(many);
  assert.equal(out.ok, false);
  assert.match(out.message, /200/);
});

test('mergeNovelFiles：单文件保留原文件名，章节出处与解析结果一一对应', () => {
  const out = mergeNovelFiles([{ name: '上部.txt', text: UPPER }]);
  assert.equal(out.ok, true);
  assert.equal(out.filename, '上部.txt');
  assert.equal(out.text, UPPER);
  assert.equal(out.sources.length, 1);
  assert.equal(out.sources[0].name, '上部.txt');
  assert.equal(out.chapterSources.length, out.sources[0].chapterTitles.length);
  assert.ok(out.chapterSources.every((c) => c.sourceName === '上部.txt'));
});

test('mergeNovelFiles：多文件生成全局唯一章号，并把每章归属到对应文件', () => {
  const out = mergeNovelFiles([
    { name: '上部.txt', text: UPPER },
    { name: '下部.md', text: LOWER },
  ]);
  assert.equal(out.ok, true);
  assert.equal(out.sources.length, 2);
  assert.equal(out.filename, '2 个文件合辑.txt');
  assert.match(out.text, /第1章：《上部》/);
  assert.match(out.text, /第2章：《下部》/);
  const titles = out.sources.flatMap((s) => s.chapterTitles);
  assert.equal(titles.length, out.chapterSources.length);
  assert.equal(new Set(titles).size, titles.length, '章号必须全局唯一');
  assert.ok(out.chapterSources.some((c) => c.sourceName === '下部.md'));
  // 合并后的文本能被重新解析成章节，且标题仍可被 CHAPTER_RE 识别
  const parsed = parseNovel(out.text, out.filename);
  assert.equal(parsed.chapters.length, titles.length);
});

/* ------------------------------------------------------ 章节 ↔ 剧集关联 */
const twoEpisodes = () => [
  { no: 1, title: '第 1 集', chars: UPPER.length, text: UPPER, sourceTitles: ['第一章 雨夜来信'] },
  { no: 2, title: '第 2 集', chars: LOWER.length, text: LOWER, sourceTitles: ['第二章 真相'] },
];

test('linkChapters：精确按集内文本 / sourceTitles 归属，byEpisode 双向索引一致', () => {
  const novel = parseNovel(`${UPPER}\n\n${LOWER}`, '合辑.txt');
  const { chapters, byEpisode } = linkChapters(novel, twoEpisodes(), []);
  assert.equal(chapters.length, 2);
  assert.deepEqual(chapters.map((c) => c.episodeNo), [1, 2]);
  assert.equal(byEpisode[1].length, 1);
  assert.equal(byEpisode[2].length, 1);
});

test('buildEpisodeRecords：同集同文本保留剧本 / 宫格 / 导演包，换文本则清空', () => {
  const novel = parseNovel(`${UPPER}\n\n${LOWER}`, '合辑.txt');
  const eps = twoEpisodes();
  const first = buildEpisodeRecords(eps, novel, [], []);
  first[0].script = { title: '已写好的剧本' };
  first[0].segments = [{ no: 1 }];
  first[0].pack = { file: 'p.zip' };
  const again = buildEpisodeRecords(eps, novel, [], first);
  assert.deepEqual(again[0].script, { title: '已写好的剧本' });
  assert.equal(again[0].segments.length, 1);
  assert.equal(again[0].pack.file, 'p.zip');
  const changed = eps.map((e) => (e.no === 1 ? { ...e, text: '完全不同的新原文' } : e));
  const reset = buildEpisodeRecords(changed, novel, [], first);
  assert.equal(reset[0].script, null);
  assert.deepEqual(reset[0].segments, []);
  assert.equal(reset[0].pack, null);
});

test('reconstructEpisodeText：无持久化原文时按首章标题从原著还原切片', () => {
  const project = { management: { source: { text: `${UPPER}\n\n${LOWER}` } } };
  const out = reconstructEpisodeText(project, { sourceTitles: ['第二章 真相'], chars: 30 });
  assert.match(out, /第二天清晨/);
  assert.ok(out.length >= 30);
});

/* ------------------------------------------------------------ 单集领域逻辑 */
test('splitSegments：每段 9 格、id 稳定、段数受上限约束', () => {
  const segs = splitSegments(`${UPPER}\n\n${LOWER}`, 6, 3);
  assert.ok(segs.length >= 1 && segs.length <= 6);
  assert.ok(segs.every((s) => s.cells.length === 9));
  assert.ok(segs.every((s) => s.cells.every((c) => c.caption && c.prompt)));
  assert.equal(segs[0].id, segmentId(3, 1));
  assert.equal(splitSegments('', 6, 1).length, 0);
});

test('matchEpisodeCharacters：按姓名与别名识别本集出场角色', () => {
  const chars = [
    { id: 'c1', name: '沈砚', aliases: ['砚哥'] },
    { id: 'c2', name: '林夏', aliases: [] },
    { id: 'c3', name: '不会出现的人', aliases: [] },
  ];
  assert.deepEqual(matchEpisodeCharacters({ text: UPPER }, chars), ['c1', 'c2']);
  assert.deepEqual(matchEpisodeCharacters({ text: '砚哥推门而入。' }, chars), ['c1']);
});

test('buildEpisodeGraph：章节 / 段落 / 宫格 / 产物 / 画布节点齐全且连线闭合', () => {
  const segs = splitSegments(UPPER, 6, 1);
  segs[0].gridUrl = '/assets/grid_demo.svg';
  const ep = {
    no: 1, title: '第 1 集', chars: UPPER.length, text: UPPER,
    chapters: [{ no: 1, title: '第一章', chars: 40, episodeNo: 1 }],
    segments: segs, characterIds: ['c1'], script: { scenes: [{}] }, pack: { url: '/assets/p.zip' }, video: null,
  };
  const graph = buildEpisodeGraph({
    nodes: [{ id: 'n_ep', type: 'episode', title: '第 1 集', data: { episode: { no: 1 } } }, { id: 'n_kf', type: 'keyframe', title: '关键帧' }],
    edges: [{ from: 'n_ep', to: 'n_kf', kind: 'flow' }],
  }, { characters: [{ id: 'c1', name: '沈砚' }] }, ep);
  const kinds = new Set(graph.nodes.map((n) => n.kind));
  for (const k of ['episode', 'chapter', 'segment', 'grid', 'character', 'script', 'pack', 'video', 'canvas']) {
    assert.ok(kinds.has(k), `缺少 ${k} 节点`);
  }
  assert.ok(graph.edges.length >= graph.nodes.length - 4);
  assert.ok(graph.edges.every((e) => graph.nodes.some((n) => n.id === e.from) && graph.nodes.some((n) => n.id === e.to)));
  assert.equal(graph.episodeNo, 1);
});

/* ---------------------------------------------------------------- 宫格图 */
test('storyboardGridSVG：恒为 9 格且转义用户输入，传入 URL 时铺真实图', () => {
  const svg = storyboardGridSVG({
    title: '第 1 集 · <危险>', subtitle: '雨夜 & 来信', style: 'cinematic', seed: 'ep1-seg1',
    cells: Array.from({ length: 9 }, (_, i) => ({
      no: i + 1, caption: i === 0 ? '推门 <script>' : `镜头 ${i + 1}`,
      url: i === 0 ? '/assets/kf.svg' : '',
    })),
  });
  assert.match(svg, /^<svg /);
  assert.equal((svg.match(/<image href=/g) || []).length, 1);
  assert.match(svg, /&lt;危险&gt;/);
  assert.doesNotMatch(svg, /<script>/);
  assert.equal((svg.match(/font-weight="700" fill="/g) || []).length >= 9, true);
  assert.equal(storyboardGridSVG({ seed: 'x' }), storyboardGridSVG({ seed: 'x' }), '同种子必须确定性输出');
});

test('gridShotList：把一段的格子映射成带集号 / 段号 / 镜头规格的分镜表', () => {
  const seg = { no: 2, cells: [{ no: 1, shotNo: 7, caption: '推门', spec: '中景 · 平视', action: '推门而入', prompt: 'P', url: '/assets/a.png' }] };
  const [row] = gridShotList(seg, 4);
  assert.equal(row.shotNo, 7);
  assert.equal(row.panelNo, 1);
  assert.equal(row.spec, '中景 · 平视');
  assert.equal(row.action, '推门而入');
  assert.equal(row.caption, '推门');
  assert.equal(row.prompt, 'P');
  assert.equal(row.url, '/assets/a.png');
  assert.equal(row.segmentNo, 2);
  assert.equal(row.episodeNo, 4);
});

/* ------------------------------------------------------------ 全局模型配置 */
test('normalizeLlm / llmConfigured / maskKey：字段收敛与密钥脱敏', () => {
  const llm = normalizeLlm({ provider: 'openai', model: 'gpt-x', baseUrl: 'https://a.example/v1///', apiKey: 'sk-1234567890', temperature: 9, llmTimeoutMs: -1 });
  assert.equal(llm.baseUrl, 'https://a.example/v1');
  assert.equal(llm.temperature, 2);
  assert.ok(llm.llmTimeoutMs > 0);
  assert.equal(llmConfigured(llm), true);
  assert.equal(llmConfigured({ ...llm, apiKey: '' }), false);
  assert.equal(llmConfigured({ ...llm, provider: 'mock' }), false);
  assert.equal(llmConfigured(DEFAULT_LLM), false);
  assert.match(maskKey('sk-1234567890'), /•/);
  assert.equal(maskKey(''), '');
});

test('appSettingsSummary：对外摘要绝不携带明文 API Key', () => {
  const s = appSettingsSummary({ llm: { ...DEFAULT_LLM, provider: 'openai', baseUrl: 'https://a.example/v1', apiKey: 'sk-super-secret', model: 'gpt-x' }, skipConfigCheck: true, updatedAt: 1 });
  assert.equal(s.llm.configured, true);
  assert.equal(s.llm.hasApiKey, true);
  assert.equal(s.skipConfigCheck, true);
  assert.doesNotMatch(JSON.stringify(s), /sk-super-secret/);
});

test('mergeLlmSettings：项目显式配齐时优先项目，否则继承全局配置', () => {
  const global = { ...DEFAULT_LLM, provider: 'openai', model: 'global-model', baseUrl: 'https://global.example/v1', apiKey: 'global-key' };
  const inherited = mergeLlmSettings({ style: 'anime', k: 3 }, global);
  assert.equal(inherited.model, 'global-model');
  assert.equal(inherited.apiKey, 'global-key');
  assert.equal(inherited.style, 'anime');
  assert.equal(inherited.k, 3);
  const overridden = mergeLlmSettings({ provider: 'openai', baseUrl: 'https://mine.example/v1', apiKey: 'mine-key', model: 'mine-model' }, global);
  assert.equal(overridden.model, 'mine-model');
  assert.equal(overridden.baseUrl, 'https://mine.example/v1');
});
