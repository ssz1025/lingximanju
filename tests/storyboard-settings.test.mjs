/* 分镜画面设置：版式 / 画幅 / 格内信息 / 提示词公式的归一与宫格渲染。
 * 运行：node --test tests/storyboard-settings.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = new URL('..', import.meta.url).pathname;
const {
  STORYBOARD_LAYOUTS, LAYOUT_BY_ID, DEFAULT_STORYBOARD,
  normalizeStoryboardSettings, resolveStoryboardSettings,
  sheetSpec, panelIndexOf, cellsOf, layoutOf, describeStoryboardSettings, framePromptNote,
} = await import(`${ROOT}src/core/storyboard-settings.mjs`);
const { storyboardGridSVG } = await import(`${ROOT}src/core/grid-art.mjs`);
const { storyboardFrameSettingsHTML, storyboardSheetsHTML } = await import(`${ROOT}public/storyboard-panel.js`);
const { STORYBOARD_LAYOUTS: UI_LAYOUTS } = await import(`${ROOT}public/project-options.js`);

test('版式预设：六种版式、格子数由 cols×rows 推导且互不重复', () => {
  assert.equal(STORYBOARD_LAYOUTS.length, 6);
  const ids = new Set(STORYBOARD_LAYOUTS.map((l) => l.id));
  assert.equal(ids.size, 6);
  for (const l of STORYBOARD_LAYOUTS) {
    assert.equal(l.cells, l.cols * l.rows, `${l.id} 的 cells 必须等于 cols×rows`);
    assert.equal(LAYOUT_BY_ID[l.id].label, l.label);
  }
  assert.deepEqual(STORYBOARD_LAYOUTS.map((l) => l.cells), [9, 6, 4, 4, 25, 1]);
  // 前端版式清单必须与服务端同源：只在一边加版式会让面板选完不生效
  assert.deepEqual(UI_LAYOUTS.map((l) => l.id), STORYBOARD_LAYOUTS.map((l) => l.id));
});

test('归一设置：非法版式 / 画幅回落默认，cols / rows / cells 一并落盘', () => {
  const s = normalizeStoryboardSettings({
    layout: 'grid6', aspect: '21:9', source: 'nope', captionMode: 'nope', guides: 'nope',
    showNo: false, prompt: { spec: false, aspect: true },
  });
  assert.equal(s.layout, 'grid6');
  assert.equal(s.cols, 3);
  assert.equal(s.rows, 2);
  assert.equal(s.cells, 6);
  assert.equal(s.aspect, DEFAULT_STORYBOARD.aspect, '非法画幅回落 inherit');
  assert.equal(s.source, 'mixed');
  assert.equal(s.captionMode, 'spec');
  assert.equal(s.guides, 'thirds');
  assert.equal(s.showNo, false);
  assert.equal(s.watermark, true);
  assert.deepEqual(s.prompt, { spec: false, character: true, style: true, continuity: true, aspect: true });
});

test('inherit 画幅跟随项目；显式画幅优先于项目', () => {
  const project = { settings: { aspect: '9:16' }, management: { storyboard: { layout: 'grid6' } } };
  const inherited = resolveStoryboardSettings(project);
  assert.equal(inherited.aspect, 'inherit');
  assert.equal(inherited.resolvedAspect, '9:16');
  const explicit = resolveStoryboardSettings({
    settings: { aspect: '9:16' }, management: { storyboard: { layout: 'grid6', aspect: '1:1' } },
  });
  assert.equal(explicit.resolvedAspect, '1:1');
  // 老项目没有 storyboard：解析成默认九宫格，而不是抛错
  const legacy = resolveStoryboardSettings({ settings: {} });
  assert.equal(legacy.layout, 'grid9');
  assert.equal(legacy.resolvedAspect, '16:9');
});

test('版面几何：格子画幅等于成片画幅，版式变了单格不会被拉成长条', () => {
  const base = normalizeStoryboardSettings({ layout: 'grid9', aspect: '16:9' });
  const spec = sheetSpec(base);
  assert.equal(spec.cols, 3);
  assert.equal(spec.rows, 3);
  assert.ok(Math.abs(spec.cellW / spec.cellH - 16 / 9) < 0.01, `单格应为 16:9，实际 ${spec.cellW}×${spec.cellH}`);
  // 25 格总览必须比九宫格宽（信息密度），但总高不至于把单格压成 1 像素条
  const wide = sheetSpec(normalizeStoryboardSettings({ layout: 'grid25', aspect: '16:9' }));
  assert.ok(wide.width > spec.width);
  assert.ok(wide.cellH > 120);
  // 竖屏单格仍然是 9:16，而不是被版心拉成横的
  const portrait = sheetSpec(normalizeStoryboardSettings({ layout: 'grid4', aspect: '9:16' }));
  assert.ok(Math.abs(portrait.cellW / portrait.cellH - 9 / 16) < 0.01);
});

test('格位循环：镜头 10 在九宫格里回到第 1 格，在六宫格里是第 4 格', () => {
  assert.equal(panelIndexOf({ layout: 'grid9' }, 1), 1);
  assert.equal(panelIndexOf({ layout: 'grid9' }, 9), 9);
  assert.equal(panelIndexOf({ layout: 'grid9' }, 10), 1);
  assert.equal(panelIndexOf({ layout: 'grid6' }, 10), 4);
  assert.equal(panelIndexOf({ layout: 'grid9' }, 0), 1, '非法序号回落第 1 格');
  assert.equal(cellsOf({ layout: 'grid6' }), 6);
  assert.equal(cellsOf({ layout: 'grid6', cells: 4 }), 4, '落盘的 cells 优先');
  assert.equal(layoutOf({ layout: 'unknown' }).id, 'grid9');
});

test('描述与提示词：版式 + 格数 + 画幅 + 来源，档位换成人话', () => {
  const s = resolveStoryboardSettings({ settings: { aspect: '9:16' }, management: { storyboard: { layout: 'grid6' } } });
  assert.equal(describeStoryboardSettings(s), '六宫格 3×2 · 6 格/段 · 竖屏 9:16 · 真实分镜图优先');
  const note = framePromptNote(s, { sequence: 8 });
  assert.match(note, /六宫格第 2\/6 格/);
  assert.match(note, /竖屏 9:16/);
});

test('宫格渲染：按版式出格子数，序号 / 说明条 / 参考线都按设置走', () => {
  const six = normalizeStoryboardSettings({ layout: 'grid6', aspect: '16:9', captionMode: 'spec', guides: 'thirds' });
  const cells = Array.from({ length: 9 }, (_, i) => ({
    no: i + 1, spec: `中景 · 平视 · 第 ${i + 1} 格`, action: '推门而入', url: i === 0 ? '/assets/a.png' : '',
  }));
  const svg = storyboardGridSVG({ title: '第 1 集 · 第 1 段分镜板', cells, style: 'cinematic', seed: 's', settings: six });
  assert.equal((svg.match(/id="cg\d+"/g) || []).length, 6, '六宫格只画 6 格');
  assert.equal((svg.match(/<image href=/g) || []).length, 1, '只有真实图入板');
  assert.match(svg, /六宫格 3×2 · 6 格 · 横屏 16:9/);
  // 「真实分镜图优先」：缺图格子画示意剪影（不是待出图空框），保证板子看起来是满的
  assert.equal((svg.match(/ Q\d+ /g) || []).length, 5, '5 个缺图格子各画一个人物剪影');
  assert.doesNotMatch(svg, /待出图/, '混合模式下不出现「待出图」空框');
  const twentyFive = storyboardGridSVG({
    title: '总览', style: 'noir', seed: 's',
    settings: normalizeStoryboardSettings({ layout: 'grid25', captionMode: 'none', guides: 'center', showNo: false, watermark: false }),
  });
  assert.equal((twentyFive.match(/id="cg\d+"/g) || []).length, 25);
  assert.doesNotMatch(twentyFive, /font-size="14" font-weight="700"/, '关掉序号后不再画序号角标');
  assert.doesNotMatch(twentyFive, /lingximanju ·/, '关掉署名后不再画页脚');
});

test('「只排真实分镜图」：缺图格子标待出图，不画示意剪影', () => {
  const strict = normalizeStoryboardSettings({ layout: 'grid4', source: 'keyframe', captionMode: 'none' });
  const svg = storyboardGridSVG({ title: '严格板', seed: 's', settings: strict });
  assert.equal((svg.match(/待出图/g) || []).length, 4);
  assert.doesNotMatch(svg, /Q\d+ \d+/, '不应出现人物剪影的贝塞尔路径');
});

test('面板 HTML：六个版式卡、选中态与选项值齐全，文本经转义', () => {
  const html = storyboardFrameSettingsHTML(
    { settings: { aspect: '9:16' } },
    { storyboard: { layout: 'grid6', aspect: 'inherit', captionMode: 'action', source: 'keyframe', guides: 'center' } },
  );
  assert.equal((html.match(/data-sb-layout="/g) || []).length, 6);
  assert.equal((html.match(/class="pvs-layout on"/g) || []).length, 1);
  assert.match(html, /data-layout="grid6"/);
  assert.match(html, /data-sb-desc>六宫格 3×2 · 6 格\/段 · 竖屏 9:16/);
  assert.match(html, /<option value="action" selected>只要动作<\/option>/);
  assert.match(html, /<option value="keyframe" selected>只排真实分镜图<\/option>/);
  assert.match(html, /<option value="center" selected>中心十字<\/option>/);
  assert.match(html, /data-act="sb-apply"/);
  assert.match(html, /data-sbp="continuity" checked/);
});

test('分镜板画廊：只列已生成的板，缺板不渲染空卡', () => {
  const html = storyboardSheetsHTML({
    storyboard: { layout: 'grid6' },
    episodes: [
      { no: 1, segments: [{ no: 1, gridUrl: '/assets/g1.svg', gridCells: 6 }, { no: 2, gridUrl: '' }] },
      { no: 2, segments: [] },
    ],
  });
  assert.equal((html.match(/data-act="sheet-open"/g) || []).length, 1);
  assert.match(html, /data-url="\/assets\/g1.svg"/);
  assert.match(html, /6 格/);
  assert.match(html, /分镜板 · 六宫格 3×2/);
  assert.equal(storyboardSheetsHTML({ episodes: [] }), '');
});
