/* 导入原著的数据统计与原文读取 · buildSourceView 单元测试
 * 运行：node --test tests/source-view.test.mjs
 * 夹具全部自建，不读真实 data/、不写磁盘。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSourceView } from '../src/core/source-view.mjs';

/* ---------------------------------------------------------------------------
 * 夹具
 * -------------------------------------------------------------------------*/
const NOVEL = [
  '第一章 初遇',
  '甲在雨里第一次见到乙，两人隔着一把伞谁都没说话。',
  '乙把伞往甲那边挪了挪，自己半边肩膀淋得湿透。',
  '第二章 重逢',
  '三年后的车站，甲又看见那个背影，手里还是那把旧伞。',
  '他们终于说上了第一句话，关于那场一直没停过的雨。',
  '第三章 告别',
  '伞骨断在风里，甲把最后一截伞柄收进了口袋。',
  '乙没有回头，只在站台尽头轻轻挥了挥手。',
].join('\n');

const OLD_NOVEL = [
  '第一章 山门',
  '少年推开山门时雪正落着，石阶上没有一个脚印。',
  '他回头望了一眼来路，把灯笼提得更低了些。',
  '第二章 夜行',
  '山路走到半夜，风里忽然有了铃声，很轻，像是挂在谁腰间。',
  '他停下脚步，铃声也停了，四下只剩雪压断枯枝的声响。',
  '第三章 归途',
  '天亮时他回到山门，灯笼早已灭了，雪地上多了一行向外的脚印。',
  '他没有再进去，只把那串铃铛放在了门槛上。',
].join('\n');

const CH_TITLES = ['第一章 初遇', '第二章 重逢', '第三章 告别'];
const OLD_TITLES = ['第一章 山门', '第二章 夜行', '第三章 归途'];

/** 完整新数据：chapters / sources / episodes / characters 齐全 */
function fullProject() {
  return {
    id: 'prj_full', name: '雨伞',
    management: {
      source: {
        filename: '雨伞.txt', title: '雨伞',
        totalChars: NOVEL.length, chapterCount: 3,
        uploadedAt: 1700000000000, text: NOVEL,
      },
      chapters: [
        { no: 1, title: CH_TITLES[0], chars: 40, sourceName: '雨伞.txt', episodeNo: 1 },
        { no: 2, title: CH_TITLES[1], chars: 44, sourceName: '雨伞.txt', episodeNo: 1 },
        { no: 3, title: CH_TITLES[2], chars: 38, sourceName: '雨伞.txt', episodeNo: 2 },
      ],
      sources: [{ name: '雨伞.txt', chars: NOVEL.length, chapterTitles: CH_TITLES.slice() }],
      episodes: [
        { no: 1, title: '第 1 集', chars: 300, chapters: [{}, {}], sourceTitles: CH_TITLES.slice(0, 2), season: 1, text: '' },
        { no: 2, title: '第 2 集', chars: 200, chapters: [{}], sourceTitles: [CH_TITLES[2]], season: 1, text: '' },
      ],
      characters: [{ name: '甲' }, { name: '乙' }],
    },
  };
}

/** 老数据：chapters=[] / sources=[] / episodes[].text=''，只有 source.text */
function oldProject() {
  return {
    id: 'prj_old', name: '雪夜',
    management: {
      source: {
        filename: '雪夜.txt', title: '雪夜',
        totalChars: OLD_NOVEL.length, chapterCount: 3,
        uploadedAt: 1700000000001, text: OLD_NOVEL,
      },
      chapters: [],
      sources: [],
      episodes: [
        { no: 1, title: '第 1 集', chars: 500, sourceTitles: OLD_TITLES.slice(0, 2), text: '' },
        { no: 2, title: '第 2 集', chars: 400, sourceTitles: [OLD_TITLES[2]], text: '' },
      ],
      characters: [],
    },
  };
}

/** 递归断言：视图里不出现 NaN / Infinity 等非法数字 */
function assertNoNaN(node, path = 'view') {
  if (typeof node === 'number') {
    assert.ok(Number.isFinite(node), `${path} 不是有限数：${node}`);
  } else if (Array.isArray(node)) {
    node.forEach((v, i) => assertNoNaN(v, `${path}[${i}]`));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) assertNoNaN(v, `${path}.${k}`);
  }
}

function assertEmpty(view) {
  assert.equal(view.ok, false);
  assert.equal(view.text, '');
  assert.deepEqual(view.chapters, []);
  assert.deepEqual(view.sources, []);
  assert.deepEqual(view.episodes, []);
  for (const [k, v] of Object.entries(view.stats)) {
    if (k === 'title' || k === 'filename') assert.equal(v, '', `stats.${k} 应为空字符串`);
    else assert.equal(v, 0, `stats.${k} 应为 0`);
  }
}

/* ---------------------------------------------------------------------------
 * 1. 完整新数据：统计正确、章节正文与关联字段正确、纯函数不可变
 * -------------------------------------------------------------------------*/
test('1. 完整新数据：统计 / 章节切片 / 关联字段 / 纯函数不可变', () => {
  const project = fullProject();
  const before = JSON.stringify(project);
  const view = buildSourceView(project);

  assert.equal(view.ok, true);
  assert.equal(view.text, NOVEL, '原文全文原样返回，不截断');
  assert.equal(JSON.stringify(project), before, 'buildSourceView 不得修改入参');
  assert.notEqual(view, project);

  const s = view.stats;
  assert.equal(s.title, '雨伞');
  assert.equal(s.filename, '雨伞.txt');
  assert.equal(s.uploadedAt, 1700000000000);
  assert.equal(s.totalChars, NOVEL.length);
  assert.equal(s.chapterCount, 3);
  assert.equal(s.paragraphCount, 9);
  assert.equal(s.sourceCount, 1);
  assert.equal(s.episodeCount, 2);
  assert.equal(s.seasonCount, 1);
  assert.equal(s.characterCount, 2);
  assert.equal(s.avgCharsPerEpisode, 250);
  assert.equal(s.minEpisodeChars, 200);
  assert.equal(s.maxEpisodeChars, 300);
  assert.equal(s.linkedChapterCount, 3);

  assert.equal(view.chapters.length, 3);
  assert.deepEqual(view.chapters.map((c) => c.no), [1, 2, 3]);
  assert.deepEqual(view.chapters.map((c) => c.chars), [40, 44, 38]);
  assert.deepEqual(view.chapters.map((c) => c.sourceName), ['雨伞.txt', '雨伞.txt', '雨伞.txt']);
  assert.deepEqual(view.chapters.map((c) => c.episodeNo), [1, 1, 2]);
  // 按标题切片：正文不含本章标题行，且含该章首句
  assert.ok(view.chapters[0].text.includes('甲在雨里'), '第一章正文应由原文切片得到');
  assert.ok(!view.chapters[0].text.includes('第一章'), '章节正文不含标题行');
  assert.ok(view.chapters[1].text.includes('三年后的车站'));
  assert.ok(view.chapters[2].text.includes('伞骨断在风里'));
  for (const c of view.chapters) assert.ok(c.text.length > 0);

  assert.equal(view.sources.length, 1);
  assert.equal(view.sources[0].name, '雨伞.txt');
  assert.deepEqual(view.sources[0].chapterTitles, CH_TITLES);

  assert.deepEqual(view.episodes, [
    { no: 1, title: '第 1 集', chars: 300, chapterCount: 2, season: 1 },
    { no: 2, title: '第 2 集', chars: 200, chapterCount: 1, season: 1 },
  ]);
});

/* ---------------------------------------------------------------------------
 * 2. 老数据：惰性重建章节、每章 text 非空、episodeNo 关联、sources 合成 1 条
 * -------------------------------------------------------------------------*/
test('2. 老数据：chapters/sources 为空时从原文惰性重建', () => {
  const view = buildSourceView(oldProject());

  assert.equal(view.ok, true);
  assert.equal(view.text, OLD_NOVEL);
  assert.equal(view.chapters.length, 3, '应从原文重建出 3 章');
  assert.deepEqual(view.chapters.map((c) => c.title), OLD_TITLES);
  for (const c of view.chapters) assert.ok(c.text.length > 0, `第 ${c.no} 章正文应非空`);

  // episodeNo 由 episodes[].sourceTitles 推断
  assert.deepEqual(view.chapters.map((c) => c.episodeNo), [1, 1, 2]);
  assert.equal(view.stats.linkedChapterCount, 3);
  assert.equal(view.stats.chapterCount, 3);

  // sources 为空时合成 1 条，chapterTitles 取重建出的章节标题
  assert.equal(view.sources.length, 1);
  assert.equal(view.sources[0].name, '雪夜.txt');
  assert.deepEqual(view.sources[0].chapterTitles, OLD_TITLES);
  assert.equal(view.sources[0].chars, OLD_NOVEL.length);
  for (const c of view.chapters) assert.equal(c.sourceName, '雪夜.txt');
});

/* ---------------------------------------------------------------------------
 * 3. 无 source / 空项目：ok=false、全 0、空数组、不抛异常
 * -------------------------------------------------------------------------*/
test('3. 无 source / 空项目：安全返回空视图', () => {
  const cases = [
    undefined,
    null,
    {},
    { management: {} },
    { management: { source: {} } },
    { management: { source: { text: '' } } },
    { management: { source: { text: null } } },
  ];
  for (const p of cases) {
    assert.doesNotThrow(() => buildSourceView(p));
    assertEmpty(buildSourceView(p));
  }
});

/* ---------------------------------------------------------------------------
 * 4. seasonCount：按 season 分组去重、缺省归第一季、兼容 management.seasons[]
 * -------------------------------------------------------------------------*/
test('4. seasonCount：episodes[].season 去重、缺省归第一季', () => {
  const project = {
    management: {
      source: { filename: '季.txt', title: '季', totalChars: NOVEL.length, chapterCount: 3, text: NOVEL },
      chapters: [], sources: [],
      episodes: [
        { no: 1, season: 1 }, { no: 2, season: 1 },
        { no: 3, season: 2 }, { no: 4, season: 2 },
        { no: 5 }, // 缺省 → 第一季
      ],
    },
  };
  const view = buildSourceView(project);
  assert.equal(view.stats.seasonCount, 2);
  assert.deepEqual(view.episodes.map((e) => e.season), [1, 1, 2, 2, 1]);
});

test('4b. seasonCount：management.seasons[] 去重（数字 / {no} / {season} 混用）', () => {
  const project = {
    management: {
      source: { filename: '季.txt', title: '季', totalChars: NOVEL.length, chapterCount: 3, text: NOVEL },
      chapters: [], sources: [],
      seasons: [1, { no: 2 }, { season: 3 }, { no: 2 }],
      episodes: [{ no: 1, season: 9 }],
    },
  };
  assert.equal(buildSourceView(project).stats.seasonCount, 3);
});

/* ---------------------------------------------------------------------------
 * 5. 数值兜底：totalChars / chars 为 undefined 或字符串时不产生 NaN
 * -------------------------------------------------------------------------*/
test('5. 数值兜底：异常值不产生 NaN，统计一律有限 number', () => {
  // 5a：totalChars 缺失 → 用 parseNovel 同口径兜底；episodes[].chars 为 undefined / 字符串
  const p1 = {
    management: {
      source: { filename: 'x.txt', title: 'x', text: NOVEL }, // totalChars / chapterCount / uploadedAt 全缺
      chapters: [], sources: [],
      episodes: [{ no: 1, title: 'E1', chars: undefined }, { no: 2, title: 'E2', chars: '250' }],
      characters: [],
    },
  };
  const v1 = buildSourceView(p1);
  assert.equal(v1.stats.totalChars, NOVEL.length, 'totalChars 缺失时用同口径兜底');
  assert.equal(v1.stats.chapterCount, 3, 'chapterCount 缺失时取重建章节数');
  assert.equal(v1.stats.uploadedAt, 0);
  assert.equal(v1.stats.paragraphCount, 9);
  assert.deepEqual(v1.episodes.map((e) => e.chars), [0, 250]);
  assert.equal(v1.stats.minEpisodeChars, 0);
  assert.equal(v1.stats.maxEpisodeChars, 250);
  assert.equal(v1.stats.avgCharsPerEpisode, 125);
  assertNoNaN(v1);

  // 5b：totalChars 为字符串；chapters[].chars 为 undefined / 非数字串 / 数字串
  const p2 = {
    management: {
      source: {
        filename: 'y.txt', title: 'y', totalChars: '9999', chapterCount: '3',
        uploadedAt: 'bad', text: NOVEL,
      },
      chapters: [
        { no: 1, title: CH_TITLES[0], chars: undefined, sourceName: '', episodeNo: undefined },
        { no: 2, title: CH_TITLES[1], chars: 'oops', sourceName: '', episodeNo: null },
        { no: 3, title: CH_TITLES[2], chars: '120', sourceName: '', episodeNo: '2' },
      ],
      sources: [], episodes: [], characters: [],
    },
  };
  const v2 = buildSourceView(p2);
  assert.equal(v2.stats.totalChars, 9999, '字符串数字应转成有限 number');
  assert.equal(v2.stats.chapterCount, 3);
  assert.equal(v2.stats.uploadedAt, 0, '非数字 uploadedAt 兜底为 0');
  assert.equal(v2.chapters[2].chars, 120);
  assert.equal(v2.chapters[2].episodeNo, 2);
  assert.ok(v2.chapters[0].chars > 0, 'chars 为 undefined 时用切片正文长度兜底');
  assert.ok(v2.chapters[1].chars > 0, 'chars 为非数字串时用切片正文长度兜底');
  assertNoNaN(v2);

  // 所有 stats 数字字段都是有限 number，字符串字段做空值兜底
  for (const v of [v1, v2]) {
    for (const [k, val] of Object.entries(v.stats)) {
      if (k === 'title' || k === 'filename') assert.equal(typeof val, 'string', `stats.${k} 应为字符串`);
      else assert.ok(Number.isFinite(val), `stats.${k} 应为有限 number，实际 ${val}`);
    }
  }
});
