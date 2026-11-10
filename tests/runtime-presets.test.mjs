/* 短剧成片规格 · 可选项层单元测试
 *
 * 覆盖：预设清单合法性、预设命中、前端即时推算与服务端 normalizeRuntimeSpec 同口径、
 *       数值下拉的「自定义」兜底，以及导演面板渲染出的可选项结构。
 * 运行：node --test tests/runtime-presets.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  RUNTIME_PRESETS, CLIP_SECONDS_OPTIONS, FPS_OPTIONS, RUNTIME_LIMITS,
  previewRuntimeSpec, matchRuntimePreset, numberOptions, selectOptions,
  RESOLUTION_TIERS, resolutionTiersFor, normalizeAspect,
} = await import('../public/project-options.js');
const { normalizeRuntimeSpec, resolveRuntimeSpec, verifyRuntime, resolutionsFor } = await import('../src/core/runtime-spec.mjs');
const { directorPanelHTML, FILM_POLICY_OPTIONS } = await import('../public/director-panel.js');
const { STEPS } = await import('../src/core/project-steps.mjs');

test('预设清单：每条都能整除、片数在限制内、id 唯一', () => {
  const ids = RUNTIME_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'id 不能重复');
  for (const p of RUNTIME_PRESETS) {
    assert.ok(p.totalSeconds > 0 && p.clipSeconds > 0, `${p.id} 时长必须为正`);
    assert.equal(p.totalSeconds % p.clipSeconds, 0, `${p.id} 必须整除，否则要触发对齐修正`);
    const count = p.totalSeconds / p.clipSeconds;
    assert.ok(count >= 1 && count <= RUNTIME_LIMITS.clipCountMax, `${p.id} 片数 ${count} 超限`);
    assert.ok(p.label && p.hint, `${p.id} 缺展示文案`);
    assert.ok(CLIP_SECONDS_OPTIONS.includes(p.clipSeconds), `${p.id} 的每片段时长应在可选档位里`);
  }
});

test('预设命中：完全一致才命中，差一点都不算', () => {
  assert.equal(matchRuntimePreset(30, 3), 'spot30');
  assert.equal(matchRuntimePreset(120, 5), 'short120');
  assert.equal(matchRuntimePreset(31, 3), '');
  assert.equal(matchRuntimePreset(30, 5), '');
  assert.equal(matchRuntimePreset(undefined, undefined), '');
  assert.equal(matchRuntimePreset('90', '5'), 'short90', '字符串数字也要能命中');
});

test('即时推算与后端 normalizeRuntimeSpec 完全同口径', () => {
  const cases = [
    { totalSeconds: 30, clipSeconds: 3, fps: 24 },
    { totalSeconds: 120, clipSeconds: 5, fps: 30 },
    { totalSeconds: 103, clipSeconds: 5, fps: 25 },   // 非整除 → 对齐
    { totalSeconds: 7.5, clipSeconds: 2.5, fps: 24 }, // 小数
    { totalSeconds: 0, clipSeconds: 0, fps: 0 },      // 非法 → 回默认
    { totalSeconds: 9999, clipSeconds: 1, fps: 240 }, // 超上限 → 钳制
    { totalSeconds: 3, clipSeconds: 999, fps: 24 },   // 每片段超上限
  ];
  for (const raw of cases) {
    const front = previewRuntimeSpec(raw);
    const back = normalizeRuntimeSpec(raw);
    const keys = ['totalSeconds', 'requestedTotalSeconds', 'clipSeconds', 'clipCount', 'fps', 'framesPerClip', 'totalFrames', 'aligned'];
    for (const k of keys) {
      assert.equal(front[k], back[k], `${JSON.stringify(raw)} 的 ${k} 不一致：前端 ${front[k]} / 后端 ${back[k]}`);
    }
  }
});

test('即时推算：片段数由总时长推导，非整除时对齐并标记', () => {
  const s = previewRuntimeSpec({ totalSeconds: 103, clipSeconds: 5, fps: 24 });
  assert.equal(s.clipCount, 21);
  assert.equal(s.totalSeconds, 105, '对齐到整数个片段');
  assert.equal(s.aligned, true);
  const exact = previewRuntimeSpec({ totalSeconds: 30, clipSeconds: 3, fps: 24 });
  assert.equal(exact.clipCount, 10);
  assert.equal(exact.aligned, false);
  assert.equal(exact.totalFrames, 720);
});

test('数值下拉：当前值在档位里就选中，不在则追加「自定义」项', () => {
  const html = numberOptions(3, CLIP_SECONDS_OPTIONS, 's');
  assert.match(html, /<option value="3" selected>3s<\/option>/);
  assert.ok(!html.includes('自定义'), '3 是标准档位，不该出现自定义项');

  const odd = numberOptions(7.5, CLIP_SECONDS_OPTIONS, 's');
  assert.match(odd, /<option value="7.5" selected>7\.5s（自定义）<\/option>/, '历史项目的 7.5s 必须被保留并选中');

  const empty = numberOptions('', CLIP_SECONDS_OPTIONS, 's');
  assert.ok(!empty.includes('selected'), '没有当前值时不应误选第一项');
});

test('帧率档位含 24/25/30，且默认 24 在列', () => {
  assert.deepEqual(FPS_OPTIONS, [24, 25, 30]);
  assert.match(numberOptions(24, FPS_OPTIONS, 'fps'), /value="24" selected/);
});

test('selectOptions 回归：空值占位与自定义旧值仍保留', () => {
  const html = selectOptions('未收录题材', ['悬疑', '科幻']);
  assert.match(html, /<option value=""[^>]*>未设定<\/option>/);
  assert.match(html, /未收录题材（自定义）/);
  assert.match(html, /value="未收录题材" selected/);
});

test('导演面板：命中预设时高亮该卡且每片段下拉选中该档', () => {
  const html = directorPanelHTML({
    skills: [], groups: [], skillId: 'full', busy: false, progress: null,
    idea: '', plan: {}, hasSource: true,
    runtime: { totalSeconds: 90, clipSeconds: 5, clipCount: 18, fps: 24, totalFrames: 2160, filmPolicy: 'real' },
    aspect: '9:16',
  });
  assert.match(html, /<button[^>]*aria-checked="true"[^>]*data-rt-preset="short90"[^>]*>/, '90s 短剧应被标记为选中');
  assert.match(html, /<button[^>]*class="rt-preset selected"[^>]*data-rt-preset="short90"[^>]*>/, '90s 短剧卡片要有高亮 class');
  assert.match(html, /<select id="pv-rt-clip"[^>]*><option value="2">2<\/option><option value="3">3<\/option><option value="4">4<\/option><option value="5" selected>5<\/option>/);
  assert.match(html, /id="pv-rt-clip-any"[^>]*hidden/, '档位命中时自定义数字框应隐藏');
  assert.match(html, /画幅 竖屏 · 分辨率随画幅分档/, '画幅提示应跟随项目设定（竖屏）');
  assert.match(html, /<select id="pv-rt-res"[^>]*>.*<option value="480×864" selected>480×864 竖屏 · 标清<\/option>/s, '9:16 默认档分辨率应被选中');
  assert.match(html, /<option value="720×1280">720×1280 竖屏 · 高清<\/option>/, '分辨率下拉必须含高清档');
  assert.match(html, /<option value="1080×1920">1080×1920 竖屏 · 全高清<\/option>/, '分辨率下拉必须含全高清档');
  assert.match(html, /id="pv-rt-fps"[^>]*>/, '帧率下拉必须渲染');
  assert.match(html, /id="pv-rt-policy"[^>]*>/, '成片模式下拉必须渲染');
  for (const p of FILM_POLICY_OPTIONS) assert.match(html, new RegExp(`value="${p.id}"`), `缺少成片模式 ${p.id}`);
});

test('导演面板：每片段不在档位时落回「自定义…」并露出数字框', () => {
  const html = directorPanelHTML({
    skills: [], groups: [], skillId: 'full', busy: false, progress: null,
    idea: '', plan: {}, hasSource: true,
    runtime: { totalSeconds: 98, clipSeconds: 7, clipCount: 14, fps: 30, totalFrames: 2940, filmPolicy: 'preview' },
    aspect: '16:9',
  });
  assert.match(html, /<option value="custom" selected>自定义…<\/option>/);
  assert.match(html, /id="pv-rt-clip-any"[^>]*value="7"/);
  assert.ok(!/id="pv-rt-clip-any"[^>]*hidden/.test(html), '自定义档位必须显示数字框');
  assert.match(html, /value="30" selected>30fps/, '历史 30fps 要保留选中');
  assert.match(html, /<option value="preview" selected>/);
  assert.match(html, /画幅 横屏 · 分辨率随画幅分档/, '16:9 项目应显示横屏提示');
  assert.match(html, /<option value="864×480" selected>864×480 横屏 · 标清<\/option>/, '16:9 默认档分辨率应被选中');
  assert.ok(!/data-rt-preset="[^"]*"[^>]*aria-checked="true"/.test(html), '98s/7s 不命中任何预设');
  assert.match(html, /data-rt-custom[^>]*>\s*<strong>自定义<\/strong><small data-rt-custom-hint>14 个 7s 片段/, '自定义态显示实际片段数');
});

/* ---------------------------------------------------------------- 分辨率规格
 * 成片时长规格必须显式给出分辨率：同一画幅有标清 / 高清 / 全高三档，
 * 横竖屏各一套宽高；前后端推算必须同口径。 */

test('分辨率档位：16:9 与 9:16 各三档，横竖屏方向互斥且默认档与服务端出图规格同源', () => {
  for (const aspect of ['16:9', '9:16']) {
    const tiers = RESOLUTION_TIERS[aspect];
    assert.equal(tiers.length, 3, `${aspect} 应有标清 / 高清 / 全高清三档`);
    const portrait = aspect === '9:16';
    for (const t of tiers) {
      assert.ok(t.width > 0 && t.height > 0, `${aspect} 档位宽高必须为正`);
      assert.equal(t.width > t.height, !portrait, `${aspect} 档位方向必须与画幅一致`);
      assert.ok(t.label.includes('×'), `${aspect} 档位缺展示文案`);
      assert.ok(t.label.startsWith(`${t.width}×${t.height} ${portrait ? '竖屏' : '横屏'}`), `${t.label} 文案结构`);
      assert.ok(/标清|高清|全高清/.test(t.label), `${t.label} 应标注档位名`);
    }
  }
  assert.equal(normalizeAspect('16:9'), '16:9');
  assert.equal(normalizeAspect('9:16'), '9:16');
  assert.equal(normalizeAspect('4:3'), '16:9', '未知画幅一律回落 16:9');
  assert.deepEqual(resolutionsFor('9:16').map((t) => `${t.width}×${t.height}`), ['480×864', '720×1280', '1080×1920']);
});

test('normalizeRuntimeSpec：分辨率结合画幅归一，非法档位回落默认档', () => {
  // 缺省 → 画幅默认档
  const def = normalizeRuntimeSpec({});
  assert.equal(def.aspect, '16:9');
  assert.equal(def.width, 864);
  assert.equal(def.height, 480);
  assert.equal(def.resolution, '864×480');
  // 竖屏缺省 → 480×864
  const portrait = normalizeRuntimeSpec({ aspect: '9:16' });
  assert.equal(portrait.resolution, '480×864');
  // 显式高清档（字符串 / 宽高两种写法）
  const hd = normalizeRuntimeSpec({ aspect: '16:9', resolution: '1280×720' });
  assert.equal(hd.width, 1280); assert.equal(hd.height, 720);
  const hdNum = normalizeRuntimeSpec({ aspect: '9:16', width: 1080, height: 1920 });
  assert.equal(hdNum.resolution, '1080×1920');
  // 小写 x / 星号写法也能解析
  assert.equal(normalizeRuntimeSpec({ aspect: '9:16', resolution: '720x1280' }).resolution, '720×1280');
  // 跨画幅按档位序号映射（16:9 的全高清塞进竖屏画幅 → 竖屏全高清，不是默认档）
  const rebase = normalizeRuntimeSpec({ aspect: '9:16', resolution: '1920×1080' });
  assert.equal(rebase.resolution, '1080×1920');
  // 同方向但不存在的档 → 回落默认
  const ghost = normalizeRuntimeSpec({ aspect: '16:9', width: 999, height: 999 });
  assert.equal(ghost.resolution, '864×480');
});

test('normalizeRuntimeSpec：换画幅按档位序号映射，分辨率不悄悄丢档', () => {
  // 16:9 的「高清」切到 9:16 仍是高清档
  const rebased = normalizeRuntimeSpec({ aspect: '9:16', width: 1280, height: 720 });
  assert.equal(rebased.resolution, '720×1280');
  // 反向同理
  const back = normalizeRuntimeSpec({ aspect: '16:9', width: 720, height: 1280 });
  assert.equal(back.resolution, '1280×720');
});

test('前后端分辨率推算同口径：显式档位 / 换画幅映射 / 非法回落全部一致', () => {
  const cases = [
    { aspect: '9:16' },
    { aspect: '16:9', resolution: '1920×1080' },
    { aspect: '9:16', resolution: '1280x720' },
    { aspect: '9:16', width: 1920, height: 1080 },
    { aspect: '16:9', resolution: '480×864' },
    {},
  ];
  for (const raw of cases) {
    const front = previewRuntimeSpec(raw);
    const back = normalizeRuntimeSpec(raw);
    for (const k of ['aspect', 'width', 'height', 'resolution', 'resolutionLabel']) {
      assert.equal(front[k], back[k], `${JSON.stringify(raw)} 的 ${k} 不一致：前端 ${front[k]} / 后端 ${back[k]}`);
    }
  }
});

test('verifyRuntime：成片实测宽高与规格档位不符时判失败', () => {
  const project = {
    settings: { aspect: '9:16' },
    management: { runtime: { totalSeconds: 6, clipSeconds: 3 } },
    nodes: [
      { type: 'video', data: { duration: 3 } },
      { type: 'video', data: { duration: 3 } },
      { type: 'final', data: { timeline: [{ duration: 3 }, { duration: 3 }], directorPack: { shotCount: 2 } } },
    ],
  };
  const spec = resolveRuntimeSpec(project);
  assert.equal(spec.resolution, '480×864');
  const ok = verifyRuntime(project, spec, { filmSeconds: 6, filmWidth: 480, filmHeight: 864 });
  assert.equal(ok.ok, true);
  const resCheck = ok.checks.find((c) => c.id === 'filmResolution');
  assert.ok(resCheck, '实测到宽高时必须核对分辨率');
  assert.equal(resCheck.ok, true);
  const bad = verifyRuntime(project, spec, { filmSeconds: 6, filmWidth: 1920, filmHeight: 1080 });
  assert.equal(bad.ok, false);
  assert.ok(bad.failures.some((f) => f.id === 'filmResolution'));
  // 探测不到宽高 → 不凭空判失败
  const noProbe = verifyRuntime(project, spec, { filmSeconds: 6 });
  assert.ok(!noProbe.checks.some((c) => c.id === 'filmResolution'));
});

test('⑦ 成片交付的完成检查必须包含成片时长规格（片段数 / 单段时长 / 总时长 / 分辨率）', () => {
  const deliver = STEPS.find((s) => s.id === 'deliver');
  const hit = deliver.checklist.find((c) => c.includes('成片时长规格'));
  assert.ok(hit, '成片交付步骤缺「成片时长规格」检查项');
  for (const word of ['片段数', '单段时长', '总时长', '分辨率']) {
    assert.ok(hit.includes(word), `检查项应覆盖「${word}」`);
  }
});
