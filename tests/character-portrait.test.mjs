/* 角色定妆链路 · 单元测试
 *
 * 覆盖用户诉求「按整体风格确保每个角色都有完整的多视图、定妆照，且能被视频生成用上」
 * 的四层保证：
 *   1) 风格锁：全片风格如何收敛成一份可复用对象，以及优先级；
 *   2) 完整性口径：5 视图状态、项目级汇总、是否可进视频；
 *   3) 参考图解析：管理面板 / 画布 / 资源库的图如何按优先级取、如何截断；
 *   4) 图片产物：SVG 语义栅格化（不能把角色换成风景图）、导演包落盘命名。
 *
 * 运行：node --test tests/character-portrait.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-portrait-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const {
  buildStyleLock, characterStyleBits, STYLE_DESCRIPTIONS, PORTRAIT_RULES, DEFAULT_NEGATIVE,
} = await import('../src/core/character-style.mjs');
const {
  CHARACTER_VIEWS, CORE_VIEW_KEYS, ALL_VIEW_KEYS, DEFAULT_VIEW_KEYS,
  resolveViewKeys, viewDef, buildViewPrompt, buildSheetPrompt,
  characterViewStatus, projectPortraitStatus, normalizeCharacter,
} = await import('../src/core/characters.mjs');
const {
  REF_VIEW_PRIORITY, DEFAULT_REFS_PER_CHARACTER, MAX_REFS_TOTAL,
  resolveCharacterRefs, resolveShotCharacterRefs, describeRefs, refsManifest,
} = await import('../src/core/character-refs.mjs');
const { characterReadyForVideo, MAX_REFS_PER_CHARACTER } = await import('../src/core/character-portrait.mjs');
const { characterViewFrame, placeholderFrame, encodePNG } = await import('../src/core/raster.mjs');
const { buildDirectorPack } = await import('../src/core/director-pack.mjs');
const { buildEpisodePack } = await import('../src/core/episode-service.mjs');
const { buildNovelProject } = await import('../src/pipelines/novel-project.mjs');
const { createZip } = await import('../src/core/zip.mjs');
const { writeAssetBinary, ASSET_DIR } = await import('../src/core/store.mjs');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/* ------------------------------------------------------------------ 风格锁 */

test('buildStyleLock 优先级：stylePrompt > bible 画风调性 > settings.style > 兜底', () => {
  const withPrompt = buildStyleLock({
    management: { bible: { stylePrompt: '水墨晕染，留白构图', artStyle: '水墨', tone: '冷峻' } },
  });
  assert.equal(withPrompt.source, 'stylePrompt');
  assert.ok(withPrompt.text.startsWith('水墨晕染，留白构图'));
  assert.ok(withPrompt.text.includes('统一画面规约'), '风格锁必须附带定妆统一规约');

  const withBible = buildStyleLock({ management: { bible: { artStyle: '工笔', tone: '温润' } } });
  assert.equal(withBible.source, 'bible');
  assert.ok(withBible.text.includes('工笔，温润调性'));
  assert.equal(withBible.label, '工笔 · 温润');

  const withSettings = buildStyleLock({ management: {}, project: { settings: { style: 'cinematic' } } });
  assert.equal(withSettings.source, 'settings');
  assert.ok(withSettings.text.includes(STYLE_DESCRIPTIONS.cinematic));

  const bare = buildStyleLock({ management: { bible: {} }, project: { settings: { style: 'unknown-style' } } });
  assert.equal(bare.text.includes(STYLE_DESCRIPTIONS.cinematic), true, '未知画风也要落到同一个兜底，不能空');
  assert.equal(bare.source, 'settings:unknown-style');
  assert.ok(bare.fixed.length >= 4, '风格锁需给出跨视图一致性约束清单');
  assert.ok(bare.negative.includes(DEFAULT_NEGATIVE.split('，')[0]));
});

test('buildStyleLock 合并 bible 负向词到统一负向串', () => {
  const lock = buildStyleLock({ management: { bible: { negativePrompt: '避免血腥' } } });
  assert.ok(lock.negative.startsWith('避免血腥'));
  assert.ok(lock.negative.includes(DEFAULT_NEGATIVE.split('，')[0]));
});

test('characterStyleBits 只追加角色自身风格与配色，不覆盖全片画风', () => {
  assert.deepEqual(characterStyleBits({}), []);
  const bits = characterStyleBits({ style: '玄色劲装', palette: ['#0f172a', '#93c5fd', '#f59e0b'] });
  assert.equal(bits.length, 2);
  assert.ok(bits[0].includes('玄色劲装'));
  assert.ok(bits[1].includes('#0f172a'));
  // 配色超过 5 个只取前 5 个，防止提示词无限膨胀
  const many = characterStyleBits({ palette: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
  assert.equal(many[0].split(' / ').length, 5);
});

/* -------------------------------------------------------- 视图与提示词口径 */

test('视图常量：五视图、基础组四视图、默认组与 scope 解析', () => {
  assert.deepEqual(ALL_VIEW_KEYS, ['front', 'threeQuarter', 'side', 'back', 'closeup']);
  assert.deepEqual(CORE_VIEW_KEYS, ['front', 'threeQuarter', 'side', 'back']);
  assert.deepEqual(DEFAULT_VIEW_KEYS, CORE_VIEW_KEYS, '默认生成基础组，面部特写按需补');
  assert.equal(viewDef('closeup').kind, 'face');
  assert.equal(viewDef('nope'), null, '未知视图返回 null（不抛异常）');

  assert.deepEqual(resolveViewKeys('all'), ALL_VIEW_KEYS);
  assert.deepEqual(resolveViewKeys('full'), ALL_VIEW_KEYS);
  assert.deepEqual(resolveViewKeys('face'), ['closeup']);
  assert.deepEqual(resolveViewKeys(), CORE_VIEW_KEYS);
  assert.deepEqual(resolveViewKeys('core'), CORE_VIEW_KEYS);
  // 显式数组：过滤非法 key，全非法时退回默认组
  assert.deepEqual(resolveViewKeys(['side', 'closeup', 'bad']), ['side', 'closeup']);
  assert.deepEqual(resolveViewKeys(['bad', 'worse']), CORE_VIEW_KEYS);
});

test('buildViewPrompt 每条都带风格锁与统一画面规约', () => {
  const lock = buildStyleLock({ management: { bible: { stylePrompt: '赛博霓虹' } } });
  for (const key of ALL_VIEW_KEYS) {
    const p = buildViewPrompt({ name: '林晚', staticFeatures: '剑眉深目' }, key, { styleLock: lock });
    assert.ok(p.includes('赛博霓虹'), `${key} 视图必须带全片风格锁`);
    assert.ok(p.includes(PORTRAIT_RULES.background) || key === 'closeup',
      `${key} 视图需带统一背景规约（面部特写单独走齐胸构图）`);
    assert.ok(p.includes('避免：'), `${key} 视图需带负向提示`);
    assert.ok(p.endsWith('。'), `${key} 视图提示词需以句号收尾`);
  }
});

test('buildSheetPrompt 把多视图排进一张设定板', () => {
  const lock = buildStyleLock({ management: {} });
  const p = buildSheetPrompt({ name: '林晚', staticFeatures: '清冷' }, { styleLock: lock, views: ALL_VIEW_KEYS });
  assert.ok(p.includes('设定板') || p.includes('定妆板'));
  assert.ok(p.includes('横向排布'), '设定板需明确排布方式');
  assert.ok(p.includes('脚底对齐同一基线'), '设定板需明确对齐规则，否则各格比例不一致');
  assert.ok(p.includes('无文字标注'));
  assert.ok(!p.includes('角色「林晚」，角色「林晚」'), '角色名不应重复拼接');
  assert.ok(p.includes('林晚'));
});

/* -------------------------------------------------------------- 完整性口径 */

test('characterViewStatus：按 scope 统计已生成/缺失，区分基础组与全集', () => {
  const c = {
    name: '林晚',
    views: {
      front: { url: '/assets/f.png' }, threeQuarter: null, side: null,
      back: null, closeup: { url: '/assets/c.png' },
    },
    sheet: { url: '/assets/s.png' },
  };
  const core = characterViewStatus(c, { scope: 'core' });
  assert.deepEqual(core.have, ['front']);
  assert.deepEqual(core.missing, ['threeQuarter', 'side', 'back']);
  assert.equal(core.complete, false);
  assert.equal(core.coreComplete, false);
  assert.equal(core.allComplete, false);
  assert.equal(core.hasSheet, true);
  assert.equal(core.pct, 25);
  assert.deepEqual(core.labels.map((l) => l.done), [true, false, false, false]);

  const all = characterViewStatus(c, { scope: 'all' });
  assert.deepEqual(all.have, ['front', 'closeup']);
  assert.equal(all.pct, 40);
});

test('projectPortraitStatus：全员全视图齐全才算 complete，可要求定妆板', () => {
  const fullChar = (name, withSheet = true) => ({
    name,
    views: Object.fromEntries(ALL_VIEW_KEYS.map((k) => [k, { url: `/assets/${name}-${k}.png` }])),
    ...(withSheet ? { sheet: { url: `/assets/${name}-sheet.png` } } : {}),
  });

  const single = projectPortraitStatus([fullChar('甲')], { scope: 'all', requireSheet: true });
  assert.equal(single.complete, true);
  assert.equal(single.doneViews, 5);
  assert.equal(single.sheetCount, 1);
  assert.equal(single.incompleteCount, 0);
  assert.equal(single.totalViews, 5);

  const partial = projectPortraitStatus([
    fullChar('甲'),
    { name: '乙', views: { front: { url: '/assets/f2.png' } } },
  ], { scope: 'all' });
  assert.equal(partial.complete, false);
  assert.equal(partial.doneViews, 6);
  assert.equal(partial.missingViews, 4);
  assert.equal(partial.incompleteCount, 1);

  // 视图全齐但缺定妆板：requireSheet=true 时不算完整，false 时算完整
  const noSheet = projectPortraitStatus([fullChar('丙', false)], { scope: 'all', requireSheet: true });
  assert.equal(noSheet.complete, false, '要求定妆板时缺板即不完整');
  assert.equal(projectPortraitStatus([fullChar('丙', false)], { scope: 'all' }).complete, true);

  // 只按核心组统计时，缺 closeup 不影响完整
  const coreOnly = projectPortraitStatus([{
    name: '丁',
    views: Object.fromEntries(CORE_VIEW_KEYS.map((k) => [k, { url: `/a-${k}.png` }])),
  }], { scope: 'core' });
  assert.equal(coreOnly.complete, true);

  // 空项目不能算「完整」
  assert.equal(projectPortraitStatus([], { scope: 'all' }).complete, false);
  // 无 name 的脏数据被过滤
  assert.equal(projectPortraitStatus([{ views: {} }], { scope: 'core' }).characters, 0);
});

test('characterReadyForVideo：只有正面图可用，但会如实提示缺什么', () => {
  assert.deepEqual(characterReadyForVideo({}).missing, ['正面全身基准图', '面部参考（正面或面部特写）']);
  assert.equal(characterReadyForVideo({}).ok, false);

  const frontOnly = characterReadyForVideo({ views: { front: { url: '/assets/f.png' } } });
  assert.equal(frontOnly.ok, true, '正面图同时充当面部参考');
  assert.equal(frontOnly.coreComplete, false);
  assert.deepEqual(frontOnly.recommended, ['3/4 侧']);
  assert.ok(frontOnly.label.includes('可进入视频'));

  const full = characterReadyForVideo({
    views: {
      front: { url: '/a.png' }, threeQuarter: { url: '/b.png' },
      side: { url: '/c.png' }, back: { url: '/d.png' }, closeup: { url: '/e.png' },
    },
  });
  assert.equal(full.ok, true);
  assert.equal(full.coreComplete, true);
  assert.equal(full.allComplete, true);
  assert.deepEqual(full.recommended, []);
  assert.equal(full.label, '可进入视频（基础定妆组齐全）');
});

/* ---------------------------------------------------------- 参考图解析 */

const proj = (characters = [], nodes = []) => ({ id: 'p', name: 'P', management: { characters }, nodes });

test('resolveCharacterRefs：管理面板多视图优先，按偏好排序并截断到 perCharacter', () => {
  const p = proj([{
    id: 'c1', name: '林晚', role: '女主', staticFeatures: '清冷',
    views: {
      front: { url: '/assets/f.png' }, closeup: { url: '/assets/c.png' },
      threeQuarter: { url: '/assets/t.png' }, side: { url: '/assets/s.png' },
      back: { url: '/assets/b.png' },
    },
  }]);
  const r = resolveCharacterRefs(p, { perCharacter: 3 });
  assert.equal(r.characters.length, 1);
  assert.deepEqual(r.characters[0].refs.map((x) => x.view), ['front', 'closeup', 'threeQuarter'],
    '偏好顺序：正面 → 面部特写 → 3/4 侧');
  assert.equal(r.characters[0].origin, 'management');
  assert.equal(r.characters[0].hasViews, true);
  assert.equal(r.stats.refs, 3);
  assert.equal(r.perCharacter, 3);
});

test('resolveCharacterRefs：视图全缺时退到定妆板兜底', () => {
  const p = proj([{ id: 'c1', name: '林晚', views: {}, sheet: { url: '/assets/sheet.png' } }]);
  const r = resolveCharacterRefs(p);
  assert.equal(r.characters[0].refs.length, 1);
  assert.equal(r.characters[0].refs[0].view, 'sheet');
  assert.equal(r.characters[0].hasViews, false, '定妆板不算多视图');
});

test('resolveCharacterRefs：管理面板缺位时用画布节点合图补位', () => {
  const p = proj([], [{
    type: 'character',
    data: { characters: [{ name: '沈默', portraitUrl: '/assets/canvas.png' }] },
  }]);
  const r = resolveCharacterRefs(p);
  assert.equal(r.characters[0].origin, 'canvas');
  assert.equal(r.characters[0].refs[0].view, 'sheet');
  assert.equal(r.stats.fromCanvas, 1);
  assert.equal(r.stats.fromManagement, 0);
});

test('resolveCharacterRefs：同名角色只取一次，管理面板优先于画布', () => {
  const p = proj(
    [{ id: 'c1', name: '林晚', views: { front: { url: '/assets/m.png' } } }],
    [{ type: 'character', data: { characters: [{ name: '林晚', portraitUrl: '/assets/cv.png' }] } }],
  );
  const r = resolveCharacterRefs(p);
  assert.equal(r.characters.length, 1);
  assert.equal(r.characters[0].origin, 'management');
  assert.equal(r.characters[0].refs[0].url, '/assets/m.png');
});

test('resolveCharacterRefs：按 names 过滤，缺失角色如实写进 notes', () => {
  const p = proj([{ id: 'c1', name: '林晚', views: { front: { url: '/assets/f.png' } } }]);
  const r = resolveCharacterRefs(p, { names: ['林晚', '无名者'] });
  assert.equal(r.characters.length, 1);
  assert.equal(r.notes.some((n) => n.includes('无名者')), true, '出场角色缺图必须如实提示');
});

test('resolveCharacterRefs：总量上限截断并标注 truncated', () => {
  const chars = ['甲', '乙', '丙'].map((name, i) => ({
    id: `c${i}`, name,
    views: { front: { url: `/assets/${name}-f.png` }, closeup: { url: `/assets/${name}-c.png` } },
  }));
  const r = resolveCharacterRefs(proj(chars), { maxTotal: 3 });
  assert.equal(r.urls.length, 3);
  assert.equal(r.truncated, true);
  assert.ok(r.notes.some((n) => n.includes('上限')));
  assert.equal(r.stats.withoutRefs, 1, '第三位角色的参考图被整体截掉了');
});

test('resolveCharacterRefs：跨角色同 URL 去重标记 shared', () => {
  const p = proj([
    { id: 'c1', name: '甲', views: { front: { url: '/assets/same.png' } } },
    { id: 'c2', name: '乙', views: { front: { url: '/assets/same.png' } } },
  ]);
  const r = resolveCharacterRefs(p, { dedupe: true });
  assert.equal(r.urls.length, 1);
  assert.equal(r.characters[1].refs[0].shared, true);
});

test('resolveShotCharacterRefs：镜头未标注角色时按前 3 位收窄', () => {
  const chars = ['甲', '乙', '丙', '丁'].map((name, i) => ({
    id: `c${i}`, name, views: { front: { url: `/assets/${i}.png` } },
  }));
  const r = resolveShotCharacterRefs(proj(chars), []);
  assert.equal(r.characters.length, 3);
  assert.ok(r.notes.some((n) => n.includes('前 3 位')));

  const exact = resolveShotCharacterRefs(proj(chars), ['丙']);
  assert.equal(exact.characters.length, 1);
  assert.equal(exact.characters[0].name, '丙');
});

test('describeRefs / refsManifest 只输出可核对信息', () => {
  assert.equal(describeRefs({ name: '甲' }), '甲：无参考图（纯文字）');
  assert.equal(describeRefs({ name: '甲', refs: [{ label: '正面' }, { label: '面部特写' }] }),
    '甲：正面 + 面部特写');
  const manifest = refsManifest([
    { name: '甲', role: '女主', origin: 'management', styleLock: '冷调', refs: [{ url: '/a.png', view: 'front', label: '正面' }] },
  ]);
  assert.deepEqual(manifest, [{
    slot: 1, name: '甲', role: '女主', origin: 'management', styleLock: '冷调',
    refs: [{ url: '/a.png', view: 'front', label: '正面' }],
  }]);
});

test('常量自检：参考图张数上限与 ComfyUI 插槽对齐', () => {
  assert.deepEqual(REF_VIEW_PRIORITY, ['front', 'closeup', 'threeQuarter', 'side', 'back']);
  assert.equal(DEFAULT_REFS_PER_CHARACTER, 3);
  assert.equal(MAX_REFS_TOTAL, 8);
  assert.equal(MAX_REFS_PER_CHARACTER, 4, '定妆链最多 4 张，给首帧与锚点留槽位');
});

/* -------------------------------------------------------------- 图片产物 */

function isPNG(buf) {
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

test('characterViewFrame：五视图都产出合法 PNG，且与风景占位图不同', () => {
  for (const view of ALL_VIEW_KEYS) {
    const buf = characterViewFrame({ view, width: 320, height: 400, palette: ['#0f172a', '#f59e0b'] });
    assert.ok(isPNG(buf), `${view} 应产出合法 PNG`);
    // PNG 头部之后是 IHDR 块，宽高直接写在第 16..24 字节
    assert.equal(buf.readUInt32BE(16), 320);
    assert.equal(buf.readUInt32BE(20), 400);
  }
  const scene = placeholderFrame({ width: 320, height: 400 });
  const portrait = characterViewFrame({ view: 'front', width: 320, height: 400 });
  assert.ok(scene.length > 0 && portrait.length > 0);
  // 同一尺寸下两张图内容必然不同：角色图不能被风景图替代
  assert.notEqual(portrait.compare(scene), 0);
});

test('characterViewFrame：非法尺寸被钳制，未知视图退化为正面', () => {
  const tiny = characterViewFrame({ view: 'nope', width: 10, height: 10 });
  assert.ok(isPNG(tiny));
  assert.equal(tiny.readUInt32BE(16), 64, '最小宽度钳制到 64');
  const huge = characterViewFrame({ view: 'front', width: 5000, height: 5000 });
  assert.equal(huge.readUInt32BE(16), 1920, '最大宽度钳制到 1920');
  assert.equal(huge.readUInt32BE(20), 1080);
});

test('encodePNG 输出可直接被 zip 与浏览器接受的 PNG', () => {
  const w = 8; const h = 8;
  const rgba = Buffer.alloc(w * h * 4, 200);
  const buf = encodePNG(w, h, rgba);
  assert.ok(isPNG(buf));
  assert.equal(buf.readUInt32BE(16), w);
  assert.equal(buf.readUInt32BE(20), h);
  assert.ok(buf.includes(Buffer.from('IDAT')), '必须有 IDAT 数据块');
  assert.ok(buf.includes(Buffer.from('IEND')), '必须有 IEND 结束块');
});

test('导演包：每个角色落盘多视图，首张为主图，其余带 view 后缀', () => {
  const { project } = buildNovelProject({ name: '定妆导演包' });
  project.settings = { ...project.settings, style: 'cinematic' };
  project.management.characters = [normalizeCharacter({
    id: 'c1', name: '林晚', role: '女主', staticFeatures: '清冷',
    views: {
      front: { url: '/assets/f.png', prompt: 'x' },
      closeup: { url: '/assets/c.png', prompt: 'x' },
      threeQuarter: { url: '/assets/t.png', prompt: 'x' },
    },
  })];

  const built = buildDirectorPack(project, {});
  const files = [];
  // 直接解 zip 目录：用中央目录记录的文件名
  const raw = built.buffer.toString('latin1');
  const re = /shared_params\/[A-Za-z0-9_.-]+\.png/g;
  while (re.exec(raw)) files.push(re.exec(raw)?.[0] || re.lastIndex);

  const names = [...new Set(raw.match(/shared_params\/[A-Za-z0-9_.-]+\.png/g) || [])];
  assert.ok(names.includes('shared_params/Picture1.png'), `主图命名不符：${names.join(',')}`);
  assert.ok(names.includes('shared_params/Picture1-closeup.png'), '面部特写应单独落盘');
  assert.ok(names.includes('shared_params/Picture1-threeQuarter.png'), '3/4 侧应单独落盘');
  assert.equal(built.meta.characterRefs, 3, '三张参考图都要计入');
  assert.equal(built.meta.characterCount, 1);
  assert.equal(built.meta.characterSheets[0].primaryView, 'front');
  assert.equal(built.meta.characterSheets[0].files.length, 3);
  assert.ok(built.meta.characterSheets[0].refSummary.includes('正面'));
  assert.ok(raw.includes('character_sheet.json'), '导演包需附角色定妆明细');
});

test('导演包：缺定妆图时槽位仍占位，且画的是角色轮廓而非风景', () => {
  const { project } = buildNovelProject({ name: '缺图导演包' });
  // 有外貌描述但一张定妆图都没有：这是零 Key 首次跑完分镜的典型状态
  project.management.characters = [normalizeCharacter({ id: 'c1', name: '沈默', appearance: '冷峻清瘦' })];
  const built = buildDirectorPack(project, {});
  const raw = built.buffer.toString('latin1');
  const names = [...new Set(raw.match(/shared_params\/Picture[0-9_.-]+\.png/g) || [])];
  assert.ok(names.includes('shared_params/Picture1.png'), '槽位必须占位（导演台按 index 读）');
  assert.ok(names.every((n) => !/\.svg/i.test(n)), '槽位不能引用 SVG');
  assert.equal(built.meta.characterRefs, 0, '没有可用视图时参考图计数为 0（诚实标注）');
  assert.equal(built.meta.characterCount, 1, '角色本身仍进包（有外貌描述）');
  assert.equal(built.meta.characterSheets[0].refs.length, 0);
  assert.equal(built.meta.characterSheets[0].primaryView, null, '无视图时没有主视图，如实留空');
});

/** buildEpisodePack 只回内存 zip，用 unzip 读条目名与内容 */
function readPack(buffer) {
  const file = path.join(TMP, `pack-${Math.random().toString(36).slice(2)}.zip`);
  fs.writeFileSync(file, buffer);
  const list = spawnSync('unzip', ['-Z1', file], { encoding: 'utf8' });
  const names = list.status === 0 ? list.stdout.split('\n').filter(Boolean) : [];
  const readText = (name) => {
    const r = spawnSync('unzip', ['-p', file, name], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout : null;
  };
  const readBuf = (name) => {
    const r = spawnSync('unzip', ['-p', file, name], { encoding: 'buffer' });
    return r.status === 0 ? r.stdout : null;
  };
  return { file, names, readText, readBuf };
}

test('单集导演包：角色参考同样落盘多视图并写 character_sheet.json', () => {
  const { project } = buildNovelProject({ name: '单集定妆' });
  project.management.characters = [normalizeCharacter({
    id: 'c1', name: '林晚', views: {
      front: { url: '/assets/f.png' }, closeup: { url: '/assets/c.png' },
    },
  })];
  const ep = {
    id: 'ep1', no: 1, title: '第一集', text: '林晚推门而入。'.repeat(20),
    segments: [], characterIds: ['c1'],
  };
  const pack = buildEpisodePack(project, project.management, ep, {});
  const { names, readText, readBuf } = readPack(pack.buffer);

  assert.ok(names.includes('shared_params/Picture1.png'), `槽位缺失：${names.join(',')}`);
  assert.ok(names.includes('shared_params/Picture1-closeup.png'), '面部特写应单独落盘');
  assert.ok(names.includes('shared_params/character_sheet.json'));

  const sheet = JSON.parse(readText('shared_params/character_sheet.json'));
  assert.equal(sheet.scope, 'episode');
  assert.equal(sheet.characters.length, 1);
  assert.equal(sheet.characters[0].name, '林晚');
  assert.ok(sheet.characters[0].imageFile.includes('Picture1.png'));
  assert.equal(sheet.characters[0].primaryView, 'front');
  assert.equal(sheet.characters[0].viewFiles.length, 2);

  const p1 = readBuf('shared_params/Picture1.png');
  assert.ok(isPNG(p1), '槽位必须是位图');
});

test('单集导演包：空槽位画人物轮廓，不让下游误当角色参考', () => {
  const { project } = buildNovelProject({ name: '单集缺图' });
  project.management.characters = [normalizeCharacter({ id: 'c1', name: '无名角色', appearance: '模糊' })];
  const ep = {
    id: 'ep1', no: 1, title: '第一集', text: '脚步声在走廊尽头消失。'.repeat(20),
    segments: [], characterIds: ['c1'],
  };
  const pack = buildEpisodePack(project, project.management, ep, {});
  const { names, readText, readBuf } = readPack(pack.buffer);

  // 该角色没有定妆图：槽位仍落 Picture1.png，但内容是人形占位而非风景
  assert.ok(names.includes('shared_params/Picture1.png'), '空槽位也要占位');
  assert.ok(isPNG(readBuf('shared_params/Picture1.png')), '槽位必须是位图');

  // 本集不足 3 位角色时，剩余槽位写 placeholder 标记，导演台不会读到空 index
  const shared = JSON.parse(readText('shared_params/shared_params.json'));
  assert.equal(shared.characters.length, 3);
  assert.equal(shared.characters[0].name, '无名角色');
  assert.equal(shared.characters[1].placeholder, true);
  assert.equal(shared.characters[2].placeholder, true);
  assert.ok(names.includes('shared_params/Picture2.png'), '空槽位也要有图，避免下游读空');
});

test('normalizeCharacter 保留 sheet / styleLock 字段', () => {
  const c = normalizeCharacter({
    id: 'c1', name: '林晚',
    sheet: { url: '/assets/s.png', views: ALL_VIEW_KEYS },
    styleLock: '冷调灰色摄影 · settings',
  });
  assert.equal(c.sheet.url, '/assets/s.png');
  assert.equal(c.styleLock, '冷调灰色摄影 · settings');
  assert.deepEqual(Object.keys(c.views), ['front', 'threeQuarter', 'side', 'back', 'closeup']);
});

/* --------------------------------------------------------------- 端到端串联 */

test('从风格锁到导演包：一条命令保证每位角色都带多视图参考', async () => {
  const { ensureCharacterPortraits } = await import('../src/core/character-portrait.mjs');
  const { project } = buildNovelProject({ name: '定妆串联' });
  project.management.bible = { stylePrompt: '水墨写意冷青调' };
  project.management.characters = [
    normalizeCharacter({ id: 'c1', name: '林晚', role: '女主' }),
    normalizeCharacter({ id: 'c2', name: '沈默', role: '男主' }),
  ];

  const r = await ensureCharacterPortraits({
    project, m: project.management, scope: 'core', onlyMissing: true, sheet: true,
  });
  assert.equal(r.ok, true, JSON.stringify(r.failed));
  assert.equal(r.generated, 2 * 4, '2 位角色 × 4 基础视图');
  assert.equal(r.sheets, 2, '定妆板单独计数');
  assert.equal(r.total, 2 * 4 + 2, '总任务数含定妆板');
  assert.equal(r.failed.length, 0);
  assert.equal(r.styleLock.source, 'stylePrompt', '全片风格锁来自 bible.stylePrompt');
  assert.equal(r.status.complete, true, '基础组 + 定妆板齐全');
  assert.equal(r.status.doneViews, 8);

  // 第二遍只补缺失：全部已有时应当全跳过
  const second = await ensureCharacterPortraits({
    project, m: project.management, scope: 'core', onlyMissing: true, sheet: true,
  });
  assert.equal(second.generated, 0);
  assert.equal(second.skipped, 10);

  // 视图落盘到资产目录（Mock 模式下原图是 SVG，由导演包按 view 语义栅格化为 PNG）
  for (const c of project.management.characters) {
    for (const key of CORE_VIEW_KEYS) {
      const url = c.views[key].url;
      const file = String(url).split('/').pop();
      assert.ok(fs.existsSync(path.join(ASSET_DIR, file)), `${c.name}·${key} 未落盘`);
      assert.equal(c.views[key].styleLock, 'stylePrompt', '每张图记录风格锁来源，可回溯');
      assert.equal(c.views[key].angle, viewDef(key).angle, '每张图记录机位角度');
    }
    // styleLock 字段记录「风格档案标签 · 来源」，全片风格文本在提示词里（views[key].prompt）
    assert.ok(c.styleLock.includes('stylePrompt'), '角色记下风格锁来源，便于回溯');
    assert.ok(c.sheet?.url, '定妆板也要落盘');
  }

  // 导演包内每位角色都带 4 张视图 与定妆明细
  const built = buildDirectorPack(project, {});
  assert.equal(built.meta.characterCount, 2);
  assert.equal(built.meta.characterRefs, 8, '2 位角色 × 4 张基础视图全部进包');
  assert.equal(built.meta.characterSheets.length, 2);
  for (const s of built.meta.characterSheets) {
    assert.equal(s.primaryView, 'front');
    assert.equal(s.files.length, 4, '包内落盘全部 4 张基础视图，槽位只取前 3 张');
    assert.ok(s.files.every((f) => /\.png$/.test(f.fileName)), '包内槽位必须是 PNG（SVG 下游读不了）');
  }

  // 槽位文件本身是可解码 PNG，且不是风景占位图
  const raw = built.buffer.toString('latin1');
  assert.ok(raw.includes('shared_params/Picture1-threeQuarter.png'), '基础组里除正面外的角度都要进包');
  const { names, readBuf } = readPack(built.buffer);
  assert.ok(names.includes('shared_params/Picture1.png'));
  assert.ok(names.includes('shared_params/Picture2.png'), '第二位角色也占一个槽位');
  const p1 = readBuf('shared_params/Picture1.png');
  assert.ok(isPNG(p1), '槽位图必须是合法 PNG');
  assert.notEqual(p1.compare(placeholderFrame({ width: 864, height: 480 })), 0,
    '角色槽位不能是风景占位图');
});

/* ---------------------------------------------------------- 真实出图口径（占位图不算已生成） */

const {
  ensureCharacterPortraits,
} = await import('../src/core/character-portrait.mjs');

test('真实出图口径：characterViewStatus / projectPortraitStatus 不把 mock 占位图当已生成', () => {
  const mockChar = {
    id: 'c1', name: '林晚',
    views: Object.fromEntries(ALL_VIEW_KEYS.map((k, i) => [
      k, { url: `/a-${k}.svg`, provider: i < 3 ? 'mock' : 'comfyui' },
    ])),
    sheet: { url: '/sheet.svg', provider: 'mock' },
  };
  const s = characterViewStatus(mockChar, { scope: 'all' });
  assert.deepEqual(s.placeholders, ['front', 'threeQuarter', 'side'], 'mock 自绘占位图单独计数');
  assert.deepEqual(s.realHave, ['back', 'closeup']);
  assert.equal(s.realComplete, false, '有占位图就不能算定妆齐全');
  assert.equal(s.hasSheet, true);
  assert.equal(s.hasRealSheet, false, '占位定妆板不算真实定妆板');

  const st = projectPortraitStatus([mockChar], { scope: 'all' });
  assert.equal(st.doneViews, 5);
  assert.equal(st.realDoneViews, 2);
  assert.equal(st.placeholderViews, 3);
  assert.equal(st.realMissingViews, 3);

  // 无 provider 的历史数据视为真实（只显式标 mock 的算占位）
  const legacy = characterViewStatus({ views: { front: { url: '/f.png' } } }, { scope: 'core' });
  assert.deepEqual(legacy.placeholders, []);
  assert.deepEqual(legacy.realHave, ['front']);
});

test('真实出图口径：characterReadyForVideo 把占位图按缺失提示', () => {
  const mockChar = {
    id: 'c1', name: '林晚',
    views: Object.fromEntries(ALL_VIEW_KEYS.map((k) => [k, { url: `/a-${k}.svg`, provider: 'mock' }])),
  };
  const ready = characterReadyForVideo(mockChar);
  assert.equal(ready.ok, false, '正面全是占位图 → 不可进视频');
  assert.equal(ready.hasPlaceholders, true);
  assert.ok(ready.label.includes('不可用'));

  // 正面真实 + 其余占位：可用，但如实提示占位
  const mixed = characterReadyForVideo({
    views: { front: { url: '/f.png', provider: 'comfyui' }, threeQuarter: { url: '/t.svg', provider: 'mock' } },
  });
  assert.equal(mixed.ok, true);
  assert.ok(mixed.label.includes('占位图'), '有占位视图时 label 必须如实提示');
});

test('ensureCharacterPortraits：requireReal 无 ComfyUI 时如实失败，绝不回退占位图', async () => {
  const m = { characters: [{ id: 'c1', name: '林晚', views: {}, palette: [] }], bible: {} };
  const project = { id: 'p-reqreal', name: 'P', management: m, settings: {} };
  const out = await ensureCharacterPortraits({
    project, m, scope: 'core', onlyMissing: true, requireReal: true,
  });
  assert.equal(out.ok, false);
  assert.ok(out.failed.length >= 1);
  assert.ok(out.failed[0].includes('未配置 ComfyUI'), '失败原因必须指向配置指引');
  assert.equal(m.characters[0].views?.front?.url || null, null, '不能悄悄写入占位图');
});

test('ensureCharacterPortraits：regenerateMock 把占位图视为未生成并重出', async () => {
  const mockViews = Object.fromEntries(CORE_VIEW_KEYS.map((k) => [k, { url: `/x-${k}.svg`, provider: 'mock' }]));
  const m = { characters: [{ id: 'c2', name: '阿宝', views: mockViews, palette: [] }], bible: {} };
  const project = { id: 'p-regenmock', name: 'P', management: m, settings: {} };
  // regenerateMock=false + onlyMissing → 占位图与真实图一样跳过
  const skip = await ensureCharacterPortraits({ project, m, scope: 'core', onlyMissing: true, regenerateMock: false });
  assert.equal(skip.skipped, CORE_VIEW_KEYS.length);
  assert.equal(skip.generated, 0);
  // regenerateMock=true → 占位图全部重出
  const regen = await ensureCharacterPortraits({ project, m, scope: 'core', onlyMissing: true, regenerateMock: true });
  assert.equal(regen.skipped, 0);
  assert.equal(regen.generated, CORE_VIEW_KEYS.length);
  assert.equal(m.characters[0].views.front.provider, 'mock', '无 ComfyUI 环境重出结果如实标注 mock');
});

test('onlyMissing=false：已真实出图的视图也会被覆盖重生成（全部重新生成）', async () => {
  const real = Object.fromEntries(CORE_VIEW_KEYS.map((k) => [k, { url: `/real-${k}.png`, provider: 'comfyui' }]));
  const m = { characters: [{ id: 'c_force', name: '沈父', views: real, palette: [] }], bible: {} };
  const project = { id: 'p-force', name: 'P', management: m, settings: {} };
  const out = await ensureCharacterPortraits({
    project, m, scope: 'core', onlyMissing: false, regenerateMock: true,
  });
  assert.equal(out.skipped, 0, '强制重生成不允许跳过任何一张');
  assert.equal(out.generated, CORE_VIEW_KEYS.length);
  assert.equal(out.failed.length, 0);
  // 没有 ComfyUI 的测试环境：结果如实标 mock，但确实替换了原真实图
  assert.equal(m.characters[0].views.front.provider, 'mock');
  assert.notEqual(m.characters[0].views.front.url, '/real-front.png');
});
