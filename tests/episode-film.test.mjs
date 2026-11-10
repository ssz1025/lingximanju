/* 分集制作 · 按集成片模块单元测试
 *
 * 覆盖：collectEpisodeCells 的段序摊平与真实首帧口径、generateEpisodeCellVideos
 * 的前置校验与幂等跳过、stitchEpisodeFilm 的真实片段拼接 / 无片段拒绝、
 * episodeFilmSummary 摘要口径。
 * 运行：node --test tests/episode-film.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-ep-film-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const {
  collectEpisodeCells, shootableCells, generateEpisodeCellVideos,
  stitchEpisodeFilm, episodeFilmSummary,
} = await import('../src/core/episode-film.mjs');
const { hasFfmpeg } = await import('../src/core/film.mjs');
const { writeAssetBinary, assetPath } = await import('../src/core/store.mjs');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** 两段 × 各两格的分镜结构：格 1 是真实 png、格 2 是 svg 占位、格 3 有图已有片段、格 4 无图 */
const ep = () => ({
  no: 1, title: '雨夜', text: '沈砚走在雨里。旧案重开。一封信出现。',
  segments: [
    { no: 1, title: '第 1 段', cells: [
      { no: 1, caption: '雨巷', url: '/assets/frame_a.png' },
      { no: 2, caption: '占位', url: '/assets/placeholder.svg' },
    ] },
    { no: 2, title: '第 2 段', cells: [
      { no: 1, caption: '信', url: '/assets/frame_b.png', video: { provider: 'comfyui', file: 'clip_b.mp4', url: '/assets/clip_b.mp4' } },
      { no: 2, caption: '黑场', url: '' },
    ] },
  ],
});

test('collectEpisodeCells：按段序摊平全部分镜格并标注真实首帧', () => {
  const cells = collectEpisodeCells(ep());
  assert.equal(cells.length, 4);
  assert.deepEqual(cells.map((c) => c.index), [1, 2, 3, 4]);
  assert.deepEqual(cells.map((c) => `${c.segNo}:${c.cellNo}`), ['1:1', '1:2', '2:1', '2:2']);
  assert.equal(cells[0].hasFrame, true, 'png 是真实首帧');
  assert.equal(cells[1].hasFrame, false, '.svg 占位不算');
  assert.equal(cells[2].hasFrame, true);
  assert.equal(cells[3].hasFrame, false, '无图不算');
  assert.equal(shootableCells(ep()).length, 2);
  // 空集 / 空段不抛错
  assert.deepEqual(collectEpisodeCells({}), []);
  assert.deepEqual(collectEpisodeCells(null), []);
});

test('generateEpisodeCellVideos：未启用 / 缺工作流 / 无可出图格子时明确报错', async () => {
  await assert.rejects(
    () => generateEpisodeCellVideos({}, {}, ep(), { enabled: false }, {}),
    /本地 ComfyUI 未启用/,
  );
  await assert.rejects(
    () => generateEpisodeCellVideos({}, {}, ep(), { enabled: true }, {}),
    /视频工作流/,
  );
  const bare = { no: 2, title: '空集', text: '', segments: [{ no: 1, cells: [{ no: 1, url: '' }] }] };
  await assert.rejects(
    () => generateEpisodeCellVideos({}, {}, bare, { enabled: true, videoWorkflow: 'wf' }, {}),
    /带真实画面的分镜格/,
  );
});

test('generateEpisodeCellVideos：已有 ComfyUI 片段的格子幂等跳过，不重复提交', async () => {
  const fixture = ep();
  const r = await generateEpisodeCellVideos(
    { id: 'prj', name: '测试', settings: { style: 'cinematic' }, management: { runtime: {} } },
    {}, fixture,
    { enabled: true, videoWorkflow: 'wf' }, {},
  );
  assert.equal(r.ok, true);
  assert.equal(r.skipped, 1, '格 3 已有片段应跳过');
  assert.equal(r.generated, 0, 'mock provider 不产出 comfyui 片段，真实格全部计为失败');
  assert.equal(r.total, 2);
  assert.ok(r.failed.length >= 1, 'mock 环境下提交会失败并如实计入 failed');
  // 已有片段不被覆盖
  assert.equal(fixture.segments[1].cells[0].video.file, 'clip_b.mp4');
});

test('stitchEpisodeFilm：没有真实片段时拒绝拼接，不用静态图冒充成片', () => {
  const r = stitchEpisodeFilm({ id: 'prj' }, {}, ep(), {});
  assert.equal(r.ok, false);
  assert.match(r.message, /真实视频片段/);
  const empty = { no: 3, title: '无格', segments: [] };
  assert.equal(stitchEpisodeFilm({ id: 'prj' }, {}, empty, {}).ok, false);
});

test('stitchEpisodeFilm：真实片段按段序拼成本集成片并写入 ep.film', () => {
  if (!hasFfmpeg()) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lxm-ep-stitch-'));
  const names = [];
  try {
    for (let i = 0; i < 2; i += 1) {
      const local = path.join(tmp, `c${i}.mp4`);
      const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
        'testsrc=size=320x180:rate=24', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', local],
      { encoding: 'utf8', timeout: 120000 });
      assert.equal(r.status, 0, `造片段失败：${r.stderr || ''}`);
      const name = `ep_film_test_${i}_${Date.now()}.mp4`;
      writeAssetBinary(name, fs.readFileSync(local));
      names.push(name);
    }
    const fixture = ep();
    fixture.segments[0].cells[0].video = { provider: 'comfyui', file: names[0], url: `/assets/${names[0]}` };
    // 格 2:1 已有 clip_b.mp4（磁盘上不存在）→ stitchClips 会过滤掉不存在的文件
    const r = stitchEpisodeFilm({ id: 'prj', settings: { style: 'cinematic' } }, {}, fixture, {});
    assert.equal(r.ok, true, r.message);
    assert.equal(r.film.clips, 1, '只有 1 个片段文件真实存在');
    assert.equal(r.film.duration, 3);
    assert.equal(r.film.isRealVideo, true);
    assert.equal(fixture.film.file, r.film.file);
    assert.ok(fs.existsSync(assetPath(r.film.file)), '成片已落盘');
  } finally {
    for (const name of names) { try { fs.rmSync(assetPath(name), { force: true }); } catch { /* ignore */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('episodeFilmSummary：格 / 片段 / 成片 / 导演包一口径', () => {
  const s = episodeFilmSummary(ep());
  assert.equal(s.cells, 2);
  assert.equal(s.videos, 1);
  assert.equal(s.film, null);
  const withFilm = ep();
  withFilm.film = { file: 'f.mp4', duration: 6, clips: 2 };
  withFilm.pack = { file: 'p.zip' };
  assert.equal(episodeFilmSummary(withFilm).film.file, 'f.mp4');
  assert.equal(episodeFilmSummary(withFilm).pack.file, 'p.zip');
});
