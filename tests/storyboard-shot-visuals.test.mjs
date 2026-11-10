/* 分镜画面视觉物料：每格多图（角色多视图 / 妆照 / 宫格视图 / 站位图）与精确提示词。
 * 运行：node --test tests/storyboard-shot-visuals.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = new URL('..', import.meta.url).pathname;
const {
  resolveFrameVisualPack, blockingSVG, buildFramePrompts, describeFrameVisuals,
} = await import(`${ROOT}src/core/shot-visuals.mjs`);
const { generateSegmentGrid, generateEpisodeGrids } = await import(`${ROOT}src/core/episode-service.mjs`);
const { gridShotList } = await import(`${ROOT}src/core/grid-art.mjs`);
const { storyboardSheetsHTML } = await import(`${ROOT}public/storyboard-panel.js`);
const { normalizeStoryboardSettings } = await import(`${ROOT}src/core/storyboard-settings.mjs`);

function makeProject() {
  return {
    id: 'p-test', name: '视觉物料测试',
    settings: { aspect: '9:16', style: 'cinematic' },
    management: {
      storyboard: { layout: 'grid6' },
      characters: [
        {
          id: 'c1', name: '林晚', role: '女主', palette: ['#f4b268'],
          sheet: { url: '/assets/sheet-lw.png' },
          views: {
            front: { url: '/assets/lw-front.png' },
            threeQuarter: { url: '/assets/lw-tq.png' },
            closeup: { url: '/assets/lw-closeup.png' },
          },
        },
        { id: 'c2', name: '沈舟', role: '男主', views: { front: { url: '/assets/sz-front.png' } } },
        { id: 'c3', name: '白裳', role: '配角', views: {} },
        { id: 'c4', name: '陈妈', role: '配角', views: {} },
      ],
      episodes: [{
        no: 1, title: '第一集', summary: 's', text: '原文一段',
        segments: [{ no: 1, title: '开场', chars: 8, text: '原文一段' }],
      }],
    },
    nodes: [
      {
        type: 'review',
        data: {
          keyframeUrl: '/assets/kf-real-1.png',
          candidates: [{ url: '/assets/kf-real-1.png', provider: 'comfyui', prompt: 'p' }],
          shot: {
            shotNo: 1, sequence: 1, size: '近景', angle: '平视', movement: '缓慢推进',
            ffDesc: '林晚在窗前转身', motionDesc: '林晚转身回眸', characters: ['林晚'], duration: 3,
          },
        },
      },
      {
        type: 'review',
        data: {
          keyframeUrl: '/assets/kf-real-2.png',
          candidates: [{ url: '/assets/kf-real-2.png', provider: 'comfyui', prompt: 'p' }],
          shot: { shotNo: 2, sequence: 2, size: '全景', angle: '俯拍', movement: '固定', ffDesc: '街市全景', characters: [], duration: 3 },
        },
      },
    ],
  };
}

test('视觉物料包：多视图 + 妆照逐槽位列出，每张写明用途', () => {
  const shot = { characters: ['林晚', '沈舟'], size: '近景', angle: '平视', movement: '推进' };
  const v = resolveFrameVisualPack(makeProject(), shot);
  assert.equal(v.stats.characters, 2);
  assert.equal(v.stats.viewRefs, 4, '林晚 3 张多视图 + 沈舟 1 张');
  assert.equal(v.stats.sheetRefs, 1, '林晚妆照单独入槽');
  assert.equal(v.urls.length, v.stats.total);
  // 槽位语义：按视图优先级排序（正面 → 特写 → 3/4 侧），妆照排在该角色视图之后
  const labels = v.slots.map((s) => `${s.slot}:${s.label}`);
  assert.deepEqual(labels.slice(0, 4), [
    '1:林晚·正面', '2:林晚·面部特写', '3:林晚·3/4 侧', '4:林晚·妆照',
  ]);
  assert.ok(v.slots.every((s) => s.usage && s.usage.length > 3), '每个槽位都有用途说明');
  // 沈舟没有妆照：sheet 为空但不报缺图
  const sz = v.characters.find((c) => c.name === '沈舟');
  assert.equal(sz.sheet, null);
  assert.equal(sz.missing, false);
});

test('视觉物料包：未标注出场角色退回全项目并记录告警，缺图角色如实标注', () => {
  const v = resolveFrameVisualPack(makeProject(), { characters: [] });
  assert.ok(v.stats.characters >= 1, '未标注角色时按全项目兜底');
  assert.ok(v.notes.some((n) => n.includes('未标注出场角色')), '兜底行为要有告警说明');
  const v2 = resolveFrameVisualPack(makeProject(), { characters: ['路人甲'] });
  assert.ok(v2.notes.some((n) => n.includes('路人甲') && n.includes('定妆')), '不存在的角色在告警里如实说明');
  assert.ok(!v2.characters.some((c) => c.name === '路人甲'), '不存在的角色不会伪造一个空物料条目');
});

test('站位图：确定性 SVG，含机位 / 出场角色 / 景别图例，同种子输出一致', () => {
  const shot = { size: '近景', angle: '平视', movement: '缓慢推进', characters: ['林晚', '沈舟'] };
  const v = resolveFrameVisualPack(makeProject(), shot);
  const args = { label: '第 1/6 格', shot, characters: v.characters, aspect: '9:16', style: 'cinematic', seed: 's1' };
  const svg1 = blockingSVG(args);
  const svg2 = blockingSVG(args);
  assert.equal(svg1, svg2, '同一镜头重排站位不跳变');
  assert.match(svg1, /站位图/);
  assert.match(svg1, /机位 · 平视 · 推进/);
  assert.match(svg1, /林晚/);
  assert.match(svg1, /沈舟/);
  assert.match(svg1, /竖屏 9:16/);
  // 运动关键词映射箭头方向：拉镜头向后
  const pull = blockingSVG({ ...args, shot: { ...shot, movement: '缓慢后拉' } });
  assert.match(pull, /后拉/);
  // 无角色信息时画「主体」占位，保证每格都有站位图
  const empty = blockingSVG({ shot: { size: '全景' }, aspect: '16:9', seed: 's2' });
  assert.match(empty, /主体/);
});

test('精确提示词：首帧提示词逐槽位写用途，图生视频提示词独立成段', () => {
  const shot = {
    shotNo: 7, sequence: 7, size: '近景', angle: '平视', movement: '缓慢推进',
    characters: ['林晚'], ffDesc: '林晚在窗前转身', motionDesc: '林晚转身回眸',
    audioDesc: '窗外的雨声', duration: 3,
  };
  const settings = normalizeStoryboardSettings({ layout: 'grid6', aspect: '9:16' });
  const visual = resolveFrameVisualPack(makeProject(), shot);
  const p = buildFramePrompts({ shot, visual, settings, styleLabel: '赛博国风', duration: 3, fps: 24 });
  // 首帧提示词：画面 + 规格 + 参考图槽位 + 角色 + 站位图约束 + 风格 + 连续性 + 格位画幅
  assert.match(p.imagePrompt, /^画面：林晚在窗前转身/);
  assert.match(p.imagePrompt, /镜头规格：近景 · 平视 · 缓慢推进/);
  assert.match(p.imagePrompt, /参考图槽位1＝林晚·正面（锁定身份与服装基准）/);
  assert.match(p.imagePrompt, /妆照（整板定妆对照/);
  assert.match(p.imagePrompt, /构图按站位图安排/);
  assert.match(p.imagePrompt, /六宫格第 1\/6 格 · 竖屏 9:16/);
  // 图生视频提示词：首帧锚定 + 运动 + 运镜 + 一致性 + 时长画幅 + 禁止项
  assert.match(p.videoPrompt, /^以首帧画面为起点/);
  assert.match(p.videoPrompt, /林晚转身回眸/);
  assert.match(p.videoPrompt, /运镜：缓慢推进/);
  assert.match(p.videoPrompt, /声音设计：窗外的雨声/);
  assert.match(p.videoPrompt, /时长 3s（24fps）/);
  assert.match(p.videoPrompt, /画幅 竖屏 9:16/);
  assert.match(p.videoPrompt, /无闪烁跳帧、无文字水印、无新增人物/);
  // 参考图计划：角色槽位 + 首帧 + 宫格视图 + 站位图
  assert.deepEqual(p.refPlan.map((r) => r.kind), ['view', 'view', 'view', 'sheet', 'keyframe', 'grid', 'blocking']);
  assert.match(p.refNote, /多参考图 4 张（多视图 3 张 \+ 妆照 1 张）\+ 首帧 \+ 宫格视图 \+ 站位图/);
  assert.ok(describeFrameVisuals(visual, p).includes('站位图'));
});

test('提示词公式开关：关掉规格 / 连续性后对应段落不再出现', () => {
  const settings = normalizeStoryboardSettings({
    layout: 'grid4', aspect: '16:9',
    prompt: { spec: false, continuity: false, aspect: false },
  });
  const shot = { shotNo: 1, size: '近景', angle: '平视', movement: '推进', characters: ['林晚'], ffDesc: '动作', motionDesc: '动作' };
  const visual = resolveFrameVisualPack(makeProject(), shot);
  const p = buildFramePrompts({ shot, visual, settings });
  assert.doesNotMatch(p.imagePrompt, /镜头规格：/);
  assert.doesNotMatch(p.imagePrompt, /空间连续性/);
  assert.doesNotMatch(p.imagePrompt, /画幅/);
  assert.doesNotMatch(p.videoPrompt, /画幅 /);
});

test('分镜板生成链路：每格落站位图 / 宫格视图 / 双提示词与参考清单', async () => {
  const project = makeProject();
  const m = project.management;
  // 走整集链路：generateEpisodeGrids 负责从画布收集真实分镜帧再逐段填格
  const out = await generateEpisodeGrids(project, m, m.episodes[0], {});
  assert.equal(out.generated, 1);
  assert.equal(out.visuals.blockings, 6, '六宫格每格一张站位图');
  assert.equal(out.visuals.promptsReady, 6);
  const seg = m.episodes[0].segments[0];
  const c1 = seg.cells[0];
  assert.ok(c1.url, '真实分镜帧已入格');
  assert.equal(c1.shotNo, 1);
  assert.ok(c1.blockingUrl && c1.blockingFile, '站位图已落盘');
  assert.equal(c1.gridUrl, seg.gridUrl, '宫格视图回填到每格');
  assert.match(c1.imagePrompt, /参考图槽位/);
  assert.match(c1.imagePrompt, /林晚在窗前转身/);
  assert.match(c1.videoPrompt, /以首帧画面为起点/);
  assert.equal(c1.visual.slots.length, 4, '林晚 3 视图 + 1 妆照');
  // 未标注角色的格子退回全项目参考，且有告警记录
  const c2 = seg.cells[1];
  assert.ok(c2.visual.notes.some((n) => n.includes('未标注出场角色')));
  // 分镜表带新字段，导演包 / 视频链路直接消费
  const shots = gridShotList(seg, 1);
  for (const s of shots) {
    assert.ok(s.blockingUrl, '每格分镜表都带站位图');
    assert.ok(s.videoPrompt, '每格分镜表都带图生视频提示词');
    assert.ok(s.visual, '每格分镜表都带参考清单');
  }
});

test('分镜板画廊：每段卡片带站位图 / 提示词 / 参考图物料徽标', () => {
  const html = storyboardSheetsHTML({
    storyboard: { layout: 'grid6' },
    episodes: [{
      no: 1,
      segments: [{
        no: 1, gridUrl: '/assets/g1.svg', gridCells: 6,
        cells: [
          { no: 1, blockingUrl: '/assets/b1.svg', videoPrompt: 'v', visual: { slots: [{}, {}, {}] } },
          { no: 2, blockingUrl: '/assets/b2.svg', videoPrompt: 'v', visual: { slots: [{}, {}] } },
        ],
      }],
    }],
  });
  assert.match(html, /站位 2/);
  assert.match(html, /提示词 2/);
  assert.match(html, /参考图 5/);
  assert.match(html, /6 格/);
  // 老项目没有物料字段时不渲染空徽标
  const legacy = storyboardSheetsHTML({
    storyboard: { layout: 'grid6' },
    episodes: [{ no: 1, segments: [{ no: 1, gridUrl: '/assets/g.svg', gridCells: 6, cells: [{ no: 1 }] }] }],
  });
  assert.doesNotMatch(legacy, /站位 /);
  assert.doesNotMatch(legacy, /提示词 /);
});
