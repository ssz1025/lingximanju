/* 成片真实性策略（film-policy）· 纯逻辑单测
 *
 * 背景：此前 composer 在没有 ComfyUI 真实片段时，会用 ffmpeg 把关键帧渲染成
 * 静态片段拼出 MP4，验收只看 film.file 就判「全流程已达成」——ComfyUI 一次都没
 * 被调用却冒充真实短剧。本组测试把「真实 / 预览」的判定口径固化下来。
 *
 * 运行：node --test tests/film-policy.test.mjs（纯逻辑，无需临时数据目录）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  FILM_POLICIES, DEFAULT_FILM_POLICY, POLICY_BY_ID,
  normalizeFilmPolicy, isRealClip, isRealFilm, evaluateFilm, filmPolicyPublic,
} = await import('../src/core/film-policy.mjs');

const projectWith = (clip, film) => ({
  nodes: [
    { type: 'video', data: { clip } },
    { type: 'final', data: { film } },
  ],
});

test('策略清单与默认值：real 是默认策略，清单可投影给前端', () => {
  assert.equal(DEFAULT_FILM_POLICY, 'real');
  assert.deepEqual(FILM_POLICIES.map((p) => p.id), ['real', 'preview']);
  assert.equal(POLICY_BY_ID.real.label, '真实 AI 视频');
  assert.equal(POLICY_BY_ID.preview.label, '关键帧预览');
  const pub = filmPolicyPublic();
  assert.equal(pub.length, 2);
  assert.ok(pub[0].tagline && pub[0].note, '前端清单要带说明文案');
});

test('normalizeFilmPolicy：脏输入回落 real，不静默换成 preview', () => {
  assert.equal(normalizeFilmPolicy('real'), 'real');
  assert.equal(normalizeFilmPolicy('preview'), 'preview');
  assert.equal(normalizeFilmPolicy('PREVIEW'), 'preview');
  assert.equal(normalizeFilmPolicy(''), 'real');
  assert.equal(normalizeFilmPolicy('mock'), 'real');
  assert.equal(normalizeFilmPolicy(null), 'real');
});

test('isRealClip：只有 ComfyUI 产物 + 视频文件 + 未标合成 才算真实', () => {
  assert.equal(isRealClip({ provider: 'comfyui', file: 'clip.mp4', synthetic: false }), true);
  assert.equal(isRealClip({ provider: 'comfyui', file: 'clip.webm' }), true);
  // mock 片段：没有视频文件
  assert.equal(isRealClip({ provider: 'mock', frames: [1, 2] }), false);
  assert.equal(isRealClip({ provider: 'comfyui' }), false, '没有落盘文件不算');
  assert.equal(isRealClip({ provider: 'comfyui', file: 'clip.mp4', synthetic: true }), false, '标了合成的预览不算');
  assert.equal(isRealClip({ provider: 'comfyui', file: 'clip.mp4', isRealVideo: false }), false);
  assert.equal(isRealClip(null), false);
  assert.equal(isRealClip({ provider: 'comfyui', file: 'poster.png' }), false, '图片不是视频片段');
});

test('isRealFilm：成片必须由真实片段拼接，preview-frames 一律不算', () => {
  assert.equal(isRealFilm({ file: 'film.mp4', source: 'comfyui' }), true);
  assert.equal(isRealFilm({ file: 'film.mp4', isRealVideo: true }), true);
  assert.equal(isRealFilm({ file: 'film.mp4', source: 'preview-frames' }), false);
  assert.equal(isRealFilm({ file: 'film.mp4', isRealVideo: false }), false);
  assert.equal(isRealFilm({ file: 'film.mp4' }), false, '无来源标记的成片宁枉勿纵');
  assert.equal(isRealFilm(null), false);
  assert.equal(isRealFilm({ duration: 30 }), false);
});

test('evaluateFilm · real 策略：零真实片段 + 预览成片 = missing，绝不冒充', () => {
  const project = projectWith(
    { provider: 'mock', frames: [1, 2, 3] },
    { file: 'film.mp4', source: 'preview-frames', duration: 30 },
  );
  const r = evaluateFilm({ project, film: { file: 'film.mp4', source: 'preview-frames', duration: 30 }, policy: 'real', clipCount: 10 });
  assert.equal(r.level, 'missing');
  assert.equal(r.isRealVideo, false);
  assert.equal(r.allReal, false);
  assert.equal(r.realClips, 0);
  assert.ok(r.blockers.some((b) => /关键帧预览/.test(b)), `blockers 应指出预览成片：${r.blockers}`);
  assert.ok(r.blockers.some((b) => /真实 AI 片段 0\/10/.test(b)), `blockers 应指出片段缺口：${r.blockers}`);
  assert.match(r.detail, /未达成真实成片/);
});

test('evaluateFilm · real 策略：全部 ComfyUI 片段 + 真实成片 = ok', () => {
  const project = {
    nodes: Array.from({ length: 10 }, () => ({ type: 'video', data: { clip: { provider: 'comfyui', file: 'c.mp4' } } })),
  };
  const film = { file: 'film.mp4', source: 'comfyui', duration: 30, measured: true, clips: 10 };
  const r = evaluateFilm({ project, film, policy: 'real', clipCount: 10 });
  assert.equal(r.level, 'ok');
  assert.equal(r.isRealVideo, true);
  assert.equal(r.allReal, true);
  assert.deepEqual(r.blockers, []);
  assert.match(r.detail, /ffprobe 实测 30s/);
});

test('evaluateFilm · real 策略：少一段就算缺失（8/10）', () => {
  const project = {
    nodes: Array.from({ length: 8 }, () => ({ type: 'video', data: { clip: { provider: 'comfyui', file: 'c.mp4' } } })),
  };
  const r = evaluateFilm({ project, film: { file: 'f.mp4', source: 'comfyui' }, policy: 'real', clipCount: 10 });
  assert.equal(r.level, 'missing');
  assert.ok(r.blockers.some((b) => /8\/10/.test(b)));
});

test('evaluateFilm · preview 策略：预览成片如实降级，不判缺失', () => {
  const project = projectWith({ provider: 'mock', frames: [1] }, null);
  const r = evaluateFilm({
    project,
    film: { file: 'film.mp4', source: 'preview-frames', duration: 30 },
    policy: 'preview', clipCount: 10,
  });
  assert.equal(r.level, 'degraded');
  assert.equal(r.isRealVideo, false);
  assert.match(r.detail, /非 AI 视频/);
});

test('evaluateFilm · 没有成片文件：任何策略都不得通过', () => {
  const project = projectWith({ provider: 'comfyui', file: 'c.mp4' }, null);
  for (const policy of ['real', 'preview']) {
    const r = evaluateFilm({ project, film: null, policy, clipCount: 10 });
    // real 下无成片=缺失；preview 下无成片=降级（如实披露，但绝不算 ok）
    assert.equal(r.level, policy === 'real' ? 'missing' : 'degraded', `${policy} 下无成片不得判 ok`);
    assert.ok(r.blockers.some((b) => /没有成片/.test(b)));
  }
});
