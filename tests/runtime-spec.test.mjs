/* 短剧成片规格 · 单元测试 + 真实 MP4 时长验证
 *
 * 覆盖：30s / 3s → 10 片段的推导、非整除对齐、镜头预算分配、时长验收、
 *       项目状态与管理动作、路由正则、ffmpeg 拼接成片的 ffprobe 实测时长。
 * 运行：node --test tests/runtime-spec.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-runtime-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const {
  DEFAULT_RUNTIME, normalizeRuntimeSpec, resolveRuntimeSpec, clipTimeline,
  allocateShots, shotSequenceStarts, verifyRuntime,
} = await import('../src/core/runtime-spec.mjs');
const { createManagement, ensureManagement, applyManageAction, projectIndex } = await import('../src/core/project-steps.mjs');
const { buildNovelProject } = await import('../src/pipelines/novel-project.mjs');
const { stitchClips, probeDuration, hasFfmpeg } = await import('../src/core/film.mjs');
const { renderPreviewFilm } = await import('../src/core/preview-film.mjs');
const { writeAssetBinary, assetPath, ASSET_DIR } = await import('../src/core/store.mjs');
const { MATCH } = await import('../src/api/routes/match.mjs');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const round2 = (n) => Math.round(n * 100) / 100;
const skeleton = () => buildNovelProject({ name: '短剧规格测试' }).project;

/** 造一个「clipCount 个片段、每段 clipSeconds」的最小项目，供纯逻辑验收使用 */
function withClips(count, seconds, spec = null) {
  const p = skeleton();
  const s = spec || normalizeRuntimeSpec({ totalSeconds: count * seconds, clipSeconds: seconds });
  p.management.runtime = s;
  for (let i = 0; i < count; i += 1) {
    p.nodes.push({ type: 'video', data: { duration: seconds, sequence: i + 1, clip: { provider: 'mock' } } });
  }
  const final = p.nodes.find((n) => n.type === 'final');
  final.data = final.data || {};
  final.data.timeline = Array.from({ length: count }, (_, i) => ({ index: i + 1, duration: seconds }));
  final.data.directorPack = { file: 'pack.zip', shotCount: count };
  return p;
}

test('默认规格：30s / 每片段 3s → 恰好 10 个片段', () => {
  assert.deepEqual(DEFAULT_RUNTIME, {
    totalSeconds: 30, clipSeconds: 3, fps: 24, filmPolicy: 'real',
  });
  const spec = normalizeRuntimeSpec(DEFAULT_RUNTIME);
  assert.equal(spec.clipCount, 10);
  assert.equal(spec.totalSeconds, 30);
  assert.equal(spec.framesPerClip, 72);
  assert.equal(spec.totalFrames, 720);
  assert.equal(spec.aligned, false);
  assert.equal(spec.requestedTotalSeconds, 30);
  const timeline = clipTimeline(spec);
  assert.equal(timeline.length, 10);
  assert.ok(timeline.every((t) => t.duration === 3));
  assert.deepEqual(timeline.map((t) => t.start), [0, 3, 6, 9, 12, 15, 18, 21, 24, 27]);
  assert.equal(timeline[9].end, 30);
  assert.equal(round2(timeline.reduce((a, t) => a + t.duration, 0)), 30);
});

test('规格归一：不能整除时按片段时长对齐并如实标记；越界值被钳制', () => {
  const odd = normalizeRuntimeSpec({ totalSeconds: 31, clipSeconds: 3 });
  assert.equal(odd.clipCount, 10);
  assert.equal(odd.totalSeconds, 30, '优先保证每片段严格 3s，而不是塞一个 1s 零头');
  assert.equal(odd.aligned, true);
  assert.equal(odd.requestedTotalSeconds, 31);

  const custom = normalizeRuntimeSpec({ totalSeconds: 12, clipSeconds: 2, fps: 25 });
  assert.equal(custom.clipCount, 6);
  assert.equal(custom.totalSeconds, 12);
  assert.equal(custom.framesPerClip, 50);
  assert.equal(custom.totalFrames, 300);

  assert.equal(normalizeRuntimeSpec(null).clipCount, 10, '脏输入回落默认');
  assert.equal(normalizeRuntimeSpec({ clipSeconds: 0.001 }).clipSeconds, 0.5, '过小值被钳到下限');
  assert.equal(normalizeRuntimeSpec({ clipSeconds: -1 }).clipSeconds, 3, '非正数回落默认片段时长');
  assert.equal(normalizeRuntimeSpec({ totalSeconds: 99999 }).clipCount <= 120, true, '片数有上限');
  assert.equal(normalizeRuntimeSpec({ enabled: false }).enabled, false);
});

test('镜头预算：任意场景数下分配总和恒等于片段数，全局序号连续', () => {
  const spec = normalizeRuntimeSpec(DEFAULT_RUNTIME);
  for (const sceneCount of [1, 2, 3, 4, 5, 6, 7, 10, 12, 20]) {
    const budgets = allocateShots(sceneCount, spec);
    assert.equal(budgets.length, sceneCount);
    assert.equal(budgets.reduce((a, b) => a + b, 0), spec.clipCount, `场景数 ${sceneCount} 时镜头总数跑偏`);
    const starts = shotSequenceStarts(sceneCount, spec);
    assert.equal(starts[0], 1);
    assert.equal(starts[starts.length - 1] + budgets[budgets.length - 1] - 1, spec.clipCount);
  }
  assert.deepEqual(allocateShots(4, spec), [3, 3, 2, 2]);
  assert.deepEqual(allocateShots(6, spec), [2, 2, 2, 2, 1, 1]);
});

test('项目状态：默认带 30/3，老项目惰性补齐，索引暴露片段数', () => {
  const m = createManagement({ kind: 'novel', title: '新项目' });
  assert.equal(m.runtime.clipSeconds, 3);
  assert.equal(m.runtime.totalSeconds, 30);
  const p = skeleton();
  delete p.management.runtime;
  assert.equal(resolveRuntimeSpec(p).clipCount, 10, '老项目回落到默认规格');
  ensureManagement(p);
  assert.equal(p.management.runtime.schema, 1);
  assert.equal(p.management.runtime.clipCount, 10);
  assert.equal(projectIndex(p).clipCount, 10);
  assert.equal(projectIndex(p).totalSeconds, 30);
});

test('管理动作 runtime：保存规格、部分提交不丢其它字段、标准项目拒绝', () => {
  const p = skeleton();
  const out = applyManageAction(p, 'runtime', { totalSeconds: 12, clipSeconds: 2, fps: 25 });
  assert.equal(out.ok, true);
  assert.equal(out.runtime.clipCount, 6);
  assert.match(out.message, /6 个片段 × 2s = 12s/);
  assert.equal(p.management.history[0].action, 'runtime');

  const partial = applyManageAction(p, 'runtime', { clipSeconds: 4 });
  assert.equal(partial.ok, true);
  assert.equal(partial.runtime.totalSeconds, 12, '只提交片段时长，总时长不能被 undefined 冲掉');
  assert.equal(partial.runtime.clipCount, 3);
  assert.equal(partial.runtime.fps, 25, 'fps 也应保留');

  const std = { ...skeleton(), management: createManagement({ kind: 'standard', title: '标准' }) };
  assert.equal(applyManageAction(std, 'runtime', { clipSeconds: 2 }).ok, false);
});

test('时长验收：缺项逐条列出，5s 片段 / 60s 时间线不能算通过', () => {
  const empty = verifyRuntime(skeleton());
  assert.equal(empty.ok, false);
  assert.ok(empty.failures.length >= 4);
  assert.ok(empty.failures.some((f) => f.id === 'clipCount'));

  const good = withClips(10, 3);
  const ok = verifyRuntime(good);
  assert.equal(ok.ok, true, ok.summary);
  assert.equal(ok.clipCount, 10);
  assert.equal(ok.totalSeconds, 30);
  assert.match(ok.summary, /10 个片段 × 3s = 30s/);

  // 还原基线里的真实缺陷：12 个片段、4/5/6s 循环、总 60s
  const bad = skeleton();
  for (let i = 0; i < 12; i += 1) bad.nodes.push({ type: 'video', data: { duration: 4 + (i % 3) } });
  const bf = bad.nodes.find((n) => n.type === 'final');
  bf.data = bf.data || {};
  bf.data.timeline = Array.from({ length: 12 }, (_, i) => ({ duration: 4 + (i % 3) }));
  bf.data.directorPack = { file: 'x.zip', shotCount: 12 };
  const broken = verifyRuntime(bad);
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.failures.map((f) => f.id).sort(), ['clipCount', 'clipDuration', 'packShots', 'totalSeconds']);
  assert.equal(broken.totalSeconds, 60);

  // MP4 实测时长也纳入同一份清单
  assert.equal(verifyRuntime(good, null, { filmSeconds: 30 }).ok, true);
  assert.equal(verifyRuntime(good, null, { filmSeconds: 12 }).checks.find((c) => c.id === 'filmSeconds').ok, false);
});

test('路由正则：runtime 端点可匹配，且不误吞其它项目路径', () => {
  assert.match('/api/projects/prj_1/runtime', MATCH.runtime);
  assert.equal('/api/projects/prj_1/runtime'.match(MATCH.runtime)[1], 'prj_1');
  assert.doesNotMatch('/api/projects/prj_1/runtime/extra', MATCH.runtime);
  assert.doesNotMatch('/api/projects/prj_1/director/run', MATCH.runtime);
});

test('真实成片：10 段 × 3s 拼接后 ffprobe 实测 30s（不是元数据求和）', () => {
  if (!hasFfmpeg()) return; // 无 ffmpeg 的环境跳过真实编码，纯逻辑用例仍全跑
  const p = withClips(10, 3);
  const film = renderPreviewFilm(p, resolveRuntimeSpec(p));
  assert.ok(film, '应产出预览成片');
  assert.equal(film.clips, 10);
  assert.equal(film.source, 'preview-frames', '必须标注不是 AI 视频');
  assert.equal(film.measured, true);
  assert.equal(film.duration, 30, `ffprobe 实测 ${film.duration}s，应为 30s`);
  assert.ok(fs.existsSync(path.join(ASSET_DIR, film.file)));
  assert.equal(probeDuration(assetPath(film.file)), 30, '落盘 MP4 再独立探测一次');
  assert.equal(verifyRuntime(p, null, { filmSeconds: film.duration }).checks.find((c) => c.id === 'filmSeconds').ok, true);
});

test('stitchClips：多片段拼接后报告实测时长，且能识别错误的标称时长', () => {
  if (!hasFfmpeg()) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-stitch-'));
  const names = [];
  try {
    for (let i = 0; i < 2; i += 1) {
      const local = path.join(tmp, `c${i}.mp4`);
      const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
        'testsrc=size=320x180:rate=24', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', local],
      { encoding: 'utf8', timeout: 120000 });
      assert.equal(r.status, 0, `造片段失败：${r.stderr || ''}`);
      const name = `stitch_test_${i}_${Date.now()}.mp4`;
      writeAssetBinary(name, fs.readFileSync(local));
      names.push(name);
    }
    const out = stitchClips(names.map((file) => ({ file, duration: 3 })), { clipSeconds: 3 });
    assert.ok(out, '拼接失败');
    assert.equal(out.clips, 2);
    assert.equal(out.declaredDuration, 6);
    assert.equal(out.measured, true);
    assert.equal(out.duration, 6, `实测 ${out.duration}s，应为 6s`);
  } finally {
    for (const name of names) { try { fs.rmSync(assetPath(name), { force: true }); } catch { /* ignore */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
