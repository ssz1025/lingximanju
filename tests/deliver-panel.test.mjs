/* 第⑦步「视频与交付」· 成片时间线 + 步骤统计 单元测试
 * 运行：node --test tests/deliver-panel.test.mjs
 *
 * 重点验证三个口径：
 *   ① 成片时间线与第⑥步分镜一一对应（镜头号 / 顺序 / 状态语义与任务看板一致）；
 *   ② 无片段 / 部分片段时的计数与占位，不虚构「已入片」；
 *   ③ 步骤统计表把每步耗时 / 执行与对话 Token 累计成表，合计不重复不遗漏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectFilmClips, filmTimelineHTML, stepStatsTableHTML } from '../public/deliver-panel.js';

function videoNode(id, shotNo, status, extra = {}) {
  return {
    id, type: 'video', status, title: `视频片段 · ${shotNo}`,
    data: {
      shot: { shotNo, size: '中景', ffDesc: `镜头 ${shotNo}` },
      sequence: shotNo,
      poster: `/assets/poster_${shotNo}.png`,
      ...(clip(shotNo, extra)),
      ...extra.data,
    },
    error: extra.error || '',
    meta: extra.meta || {},
  };
}
function clip(shotNo, extra = {}) {
  if (extra.noClip) return {};
  return {
    clip: {
      url: `/assets/clip_${shotNo}.mp4`, file: `clip_${shotNo}.mp4`,
      promptId: extra.promptId || `pid_${shotNo}`, provider: 'comfyui',
      duration: extra.duration ?? 3, poster: `/assets/poster_${shotNo}.png`,
    },
  };
}

function makeProject() {
  return {
    nodes: [
      videoNode('v1', 1, 'done'),
      // 排队但没提交：等待发送（与第⑥步看板同口径，不得显示「已发送」）
      videoNode('v2', 2, 'queued', { noClip: true, meta: { queuedAt: 1 } }),
      videoNode('v3', 3, 'queued', { noClip: true, meta: { queuedAt: 2, submittedAt: 3, promptId: 'pid_3' } }),
      videoNode('v4', 4, 'running', { noClip: true }),
      videoNode('v5', 5, 'error', { noClip: true, error: 'ComfyUI 超时' }),
      // 没有片段数据的节点：待生成
      videoNode('v6', 6, 'pending', { noClip: true }),
    ],
    edges: [],
  };
}

test('collectFilmClips：一格一镜，按 sequence 排序，状态与第⑥步任务看板同口径', () => {
  const clips = collectFilmClips(makeProject());
  assert.equal(clips.length, 6);
  assert.deepEqual(clips.map((c) => c.shotNo), [1, 2, 3, 4, 5, 6], '按 sequence 排序');
  assert.deepEqual(clips.map((c) => c.status), ['done', 'planned', 'queued', 'running', 'error', 'pending'],
    'queued 无 prompt_id 是「等待发送」不是「已发送」');
  assert.equal(clips[0].clipUrl, '/assets/clip_1.mp4');
  assert.equal(clips[0].poster, '/assets/poster_1.png');
  assert.equal(clips[4].error, 'ComfyUI 超时');
});

test('filmTimelineHTML：计数正确，无成片时也给出时间线，点格带 data-clip', () => {
  const { html, counts } = filmTimelineHTML(makeProject());
  assert.equal(counts.done, 1);
  assert.equal(counts.planned, 1);
  assert.equal(counts.queued, 1);
  assert.equal(counts.running, 1);
  assert.equal(counts.error, 1);
  assert.equal(counts.pending, 1);
  // 封面默认取视频第一帧：有片段 URL 的格子用 <video #t=0.1>，不直接贴海报图
  assert.match(html, /class="pvf-thumb" src="\/assets\/clip_1\.mp4#t=0\.1" preload="metadata"/);
  assert.match(html, /data-clip="\/assets\/clip_1\.mp4"/);
  assert.match(html, /#1/);
  assert.match(html, /pvf-play/, '有播放角标提示可点击播放');
  assert.match(html, /第⑥步/, '提供回跳第⑥步入口');
  assert.match(html, /已入片 1\/6/, '不把未入片算成已入片');
  // 没有片段 URL 的格子（v2–v6）回退到生成海报图，而非首帧
  assert.match(html, /<img src="\/assets\/poster_2\.png"/);
});

test('filmTimelineHTML：没有视频节点时返回空，不渲染空壳卡片', () => {
  const { html, counts } = filmTimelineHTML({ nodes: [] });
  assert.equal(html, '');
  assert.deepEqual(counts, {});
});

test('filmTimelineHTML：有片段但没有海报的格子仍渲染首帧视频封面', () => {
  const p = { nodes: [videoNode('v1', 1, 'done', { data: { poster: '' } })] };
  const { html } = filmTimelineHTML(p);
  assert.match(html, /pvf-thumb/);
  assert.doesNotMatch(html, /<img/);
});

test('stepStatsTableHTML：每步耗时 / Token 汇总入表，合计含执行 + 对话', () => {
  const m = {
    steps: [
      { id: 'upload', status: 'done', runs: 1, durationMs: 0, tokens: { total: 0, calls: 0 }, chatTokens: { total: 0, calls: 0 } },
      { id: 'script', status: 'done', runs: 2, durationMs: 61_000, tokens: { prompt: 100, completion: 50, total: 150, calls: 3 }, chatTokens: { total: 30, calls: 1 } },
      { id: 'storyboard', status: 'done', runs: 3, durationMs: 3_660_000, tokens: { total: 200, calls: 10 }, chatTokens: { total: 0, calls: 0 } },
      { id: 'deliver', status: 'done', runs: 2, durationMs: 120_000, tokens: { total: 500, calls: 20 }, chatTokens: { total: 70, calls: 2 } },
    ],
  };
  const html = stepStatsTableHTML(m);
  // fmtDur：分钟不补零 → 61s=「1:01」，3660s=「1:01:00」，120s=「2:00」
  assert.match(html, /1:01/, '脚本步最近耗时 61s');
  assert.match(html, /1:01:00/, '分镜步最近耗时 1h1m');
  assert.match(html, /2:00/, '交付步最近耗时 2m');
  assert.match(html, /合计/, '有合计行');
  // 150+30+200+500+70 = 950
  assert.match(html, /950/, 'Token 合计 = 执行 + 对话');
  // basic 等非六步 id 被过滤
  assert.doesNotMatch(html, /basic/);
});

test('stepStatsTableHTML：空 steps 返回空串，渲染不出空表格', () => {
  assert.equal(stepStatsTableHTML({ steps: [] }), '');
  assert.equal(stepStatsTableHTML({}), '');
  assert.equal(stepStatsTableHTML(null), '');
});
