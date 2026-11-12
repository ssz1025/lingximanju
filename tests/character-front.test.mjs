/* 角色正面基准图 / 多视图一致性 · 单元测试
 *
 * 覆盖用户诉求「角色正面形象经常肢体不完整，侧面、侧身、背景与正面不一致，
 * 与镜头特写不一致，定妆照不一致；可配置修改正面形象与角色的本地 ComfyUI 工作流接口」：
 *   1) 正面 / 其它视图 / 特写 / 定妆板的提示词统一完整四肢、同一背景光照与参考链；
 *   2) 缺正面基准图时阻断其余视图，老项目由批量链路自动先补正面；
 *   3) character-front 独立板块 + 按视图接口表，未绑定时回退 character-view；
 *   4) 一致性静态报告能识别混合出图通道 / 混合风格锁 / 未回引正面。
 *
 * 运行：node --test tests/character-front.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-front-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const {
  FULL_BODY_RULES, FRONT_BODY_RULES, VIEW_CONSISTENCY_RULES, DEFAULT_NEGATIVE, buildStyleLock,
} = await import('../src/core/character-style.mjs');
const {
  buildViewPrompt, buildSheetPrompt, characterConsistencyReport, normalizeCharacter,
  ALL_VIEW_KEYS, CORE_VIEW_KEYS,
} = await import('../src/core/characters.mjs');
const {
  refChainFor, interfaceForView, normalizeInterfaceByView,
  generateCharacterView, ensureCharacterPortraits,
} = await import('../src/core/character-portrait.mjs');
const { MEDIA_SCOPES, SCOPE_KIND, resolveInterface } = await import('../src/core/comfy-config.mjs');

const character = () => normalizeCharacter({
  id: 'c1', name: '林晚', staticFeatures: '剑眉深目，黑色长发',
  dynamicFeatures: '月白长裙，油纸伞', style: '古风清冷',
});

/* ---------------------------------------------------------- 提示词硬约束 */

test('完整肢体规约：正面与其余视图都写死「双手双脚 / 不裁切 / 禁止半身」', () => {
  for (const rule of [FULL_BODY_RULES, FRONT_BODY_RULES]) {
    assert.match(rule, /双手|十指/);
    assert.match(rule, /双脚/);
    assert.match(rule, /禁止半身像/);
  }
  assert.match(FRONT_BODY_RULES, /正面平视镜头/);
  assert.match(FRONT_BODY_RULES, /同一水平基线/);
  assert.match(VIEW_CONSISTENCY_RULES, /同一背景颜色/);
  assert.match(VIEW_CONSISTENCY_RULES, /同一光照方向/);
  assert.match(VIEW_CONSISTENCY_RULES, /只改变拍摄朝向/);
});

test('负向词显式列出残肢 / 半身 / 背景光照漂移的失败模式', () => {
  for (const word of ['断肢', '缺手', '缺脚', '下半身出画', '半身像', '肢体被遮挡',
    '背景与正面不一致', '光照方向改变', '五官与正面不一致']) {
    assert.ok(DEFAULT_NEGATIVE.includes(word), `负向词应包含「${word}」`);
  }
  assert.equal(DEFAULT_NEGATIVE.split('，')[0], '多个人物同框', '第一项保持兼容');
  assert.ok(buildStyleLock({ management: {} }).negative.includes('断肢'));
});

test('buildViewPrompt：正面拼身份基准规约，其余视图只对齐朝向不重述人设', () => {
  const c = character();
  const lock = buildStyleLock({ management: { bible: { stylePrompt: '水墨冷青' } } });
  const front = buildViewPrompt(c, 'front', { styleLock: lock });
  assert.match(front, /身份基准图/);
  assert.ok(front.includes(FRONT_BODY_RULES));
  assert.match(front, /柔和均匀的正面影视补光/);

  for (const key of CORE_VIEW_KEYS.filter((k) => k !== 'front')) {
    const p = buildViewPrompt(c, key, { styleLock: lock, refs: [{ view: 'front', url: '/assets/f.png' }] });
    assert.ok(p.includes(FULL_BODY_RULES), `${key} 也要完整四肢`);
    assert.ok(p.includes(VIEW_CONSISTENCY_RULES), `${key} 要声明与正面同背景 / 同光照 / 同比例`);
    assert.ok(!p.includes('剑眉深目，黑色长发'), `${key} 不重述静态特征`);
    assert.ok(p.includes('参考图（正面）'), `${key} 以正面图为唯一外观依据`);
    assert.ok(p.includes('水墨冷青'), `${key} 仍带全片风格锁`);
  }
});

test('buildViewPrompt 面部特写：由正面图放大得到同一张脸，且补齐统一背景 / 光照', () => {
  const c = character();
  const lock = buildStyleLock({ management: {} });
  const p = buildViewPrompt(c, 'closeup', { styleLock: lock, refs: [{ view: 'front', url: '/assets/f.png' }] });
  assert.match(p, /齐胸以上构图/);
  assert.match(p, /由正面基准图裁切放大得到同一张脸/);
  assert.match(p, /不改变五官/);
  assert.ok(p.includes('纯色中性背景'));
  assert.ok(p.includes('柔和均匀的正面影视补光'));
  assert.ok(p.includes('参考图（正面）'));
});

test('buildSheetPrompt 以视图参考图为唯一依据，不再用文字重述人设', () => {
  const c = character();
  const p = buildSheetPrompt(c, { styleLock: buildStyleLock({ management: {} }), views: ALL_VIEW_KEYS });
  assert.match(p, /以提供的各视图参考图（尤其是正面基准图）为唯一外观依据/);
  assert.match(p, /不依据文字重新设计五官/);
  assert.match(p, /横向排布/);
  assert.match(p, /脚底对齐同一基线/);
  assert.match(p, /无文字标注/);
  assert.ok(p.includes('林晚'));
  assert.ok(!p.includes('剑眉深目，黑色长发'), '设定板不重述角色外貌文字');
});

/* ---------------------------------------------------------- 参考链与阻断 */

test('refChainFor：正面必引、最多 3 张补强参考，正面自身不引任何图', () => {
  const c = {
    views: {
      front: { url: '/assets/f.png' }, threeQuarter: { url: '/assets/t.png' },
      side: { url: '/assets/s.png' }, back: { url: '/assets/b.png' },
      closeup: { url: '/assets/c.png' },
    },
  };
  assert.deepEqual(refChainFor(c, 'front'), []);
  const side = refChainFor(c, 'side');
  assert.equal(side[0].view, 'front');
  assert.ok(side.length >= 2 && side.length <= 3);
  assert.ok(!side.some((r) => r.view === 'side'), '不引用自身');
  assert.equal(new Set(side.map((r) => r.url)).size, side.length, '参考图不重复');
  const face = refChainFor(c, 'closeup');
  assert.equal(face[0].view, 'front');
  assert.ok(!face.some((r) => r.view === 'closeup'));
});

test('generateCharacterView：缺正面基准图时阻断其余视图，不再纯文字硬出', async () => {
  const p = { id: 'p_front', name: 'P', settings: {}, management: { bible: {} } };
  await assert.rejects(
    () => generateCharacterView({
      project: p, m: p.management, character: { name: '林晚', views: {} },
      viewKey: 'side', log: () => {},
    }),
    /缺正面基准图|请先生成正面全身图/,
  );
});

test('ensureCharacterPortraits：只补侧面但缺正面时自动先补正面，统计不丢张', async () => {
  const m = { bible: {}, characters: [{ id: 'c1', name: '林晚', views: {}, palette: [] }] };
  const p = { id: 'p_autof', name: 'P', management: m, settings: {} };
  const r = await ensureCharacterPortraits({
    project: p, m, scope: ['side'], onlyMissing: true, log: () => {},
  });
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
  assert.equal(r.total, 2, '1 张侧面 + 自动前置 1 张正面');
  assert.equal(r.generated, 2);
  assert.ok(m.characters[0].views.front?.url, '正面已补');
  assert.ok(m.characters[0].views.side?.url, '侧面已补');
  assert.ok((m.characters[0].views.side.refs || []).includes(m.characters[0].views.front.url),
    '侧面记录回引正面基准图');
});

/* ---------------------------------------------------------- 工作流可配置 */

test('MEDIA_SCOPES 新增 character-front，且仍归 image 类别', () => {
  assert.ok(MEDIA_SCOPES.includes('character-front'));
  assert.equal(SCOPE_KIND['character-front'], 'image');
  assert.equal(MEDIA_SCOPES.indexOf('character-front') < MEDIA_SCOPES.indexOf('character-view'), true);
});

test('interfaceForView / normalizeInterfaceByView：按视图优先，非法 key 被过滤', () => {
  assert.equal(interfaceForView({ front: 'wf_front' }, 'front', 'wf_all'), 'wf_front');
  assert.equal(interfaceForView({ sheet: 'wf_sheet' }, 'sheet', 'wf_all'), 'wf_sheet');
  assert.equal(interfaceForView({ default: 'wf_default' }, 'side', 'wf_all'), 'wf_default');
  assert.equal(interfaceForView(null, 'side', 'wf_all'), 'wf_all', '旧单接口调用零回归');
  const byView = normalizeInterfaceByView({ front: 'wf_f', sheet: 'wf_s', '__proto__': 'evil', bad: 'x' });
  assert.deepEqual(byView, { front: 'wf_f', sheet: 'wf_s' });
  assert.equal(normalizeInterfaceByView(null), null);
});

test('resolveInterface：character-front 未单独绑定时沿用 character-view 的绑定', () => {
  const cfg = {
    imageWorkflowLib: [
      { id: 'wf_view', name: '角色多视图', kind: 'image', workflow: { 1: {} } },
      { id: 'wf_front', name: '正面基准', kind: 'image', workflow: { 2: {} } },
    ],
    scopeBindings: { 'character-view': 'wf_view' },
  };
  const fallback = resolveInterface(cfg, { kind: 'image', scope: 'character-front', fallbackScope: 'character-view' });
  assert.equal(fallback.interfaceId, 'wf_view');
  assert.equal(fallback.via, 'scope-fallback');
  assert.equal(fallback.scope, 'character-front', '回溯信息仍记录真实板块');
  assert.ok(fallback.warnings.some((w) => w.includes('未单独绑定')));

  cfg.scopeBindings['character-front'] = 'wf_front';
  const own = resolveInterface(cfg, { kind: 'image', scope: 'character-front', fallbackScope: 'character-view' });
  assert.equal(own.interfaceId, 'wf_front');
  assert.equal(own.via, 'scope');
});

/* ---------------------------------------------------------- 一致性静态报告 */

test('characterConsistencyReport：同源视图通过，混合通道 / 缺参考链被点名', () => {
  const front = '/assets/f.png';
  const good = {
    views: Object.fromEntries(CORE_VIEW_KEYS.map((k) => [k, {
      url: k === 'front' ? front : `/assets/${k}.png`,
      provider: 'comfyui', styleLock: 'stylePrompt',
      refs: k === 'front' ? [] : [front],
    }])),
    sheet: { url: '/assets/sheet.png', provider: 'comfyui', styleLock: 'stylePrompt' },
  };
  const ok = characterConsistencyReport(good);
  assert.equal(ok.ok, true, JSON.stringify(ok.issues));
  assert.match(ok.label, /同一正面基准/);

  const bad = JSON.parse(JSON.stringify(good));
  bad.views.side.provider = 'mock';
  bad.views.back.refs = [];
  bad.sheet.styleLock = 'other';
  const report = characterConsistencyReport(bad);
  assert.equal(report.ok, false);
  assert.match(report.label, /来源不一致/);
  const codes = report.issues.map((x) => x.code);
  assert.ok(codes.includes('mixed-provider'));
  assert.ok(codes.includes('no-refs'));
  assert.ok(codes.includes('sheet-style-lock'));
});
