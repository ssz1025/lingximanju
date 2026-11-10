import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileProjectComfy, buildHistoryEntries, fuzzyMatchEntry, nodePromptIds,
} from '../src/core/comfy-reconcile.mjs';

/* --------------------------------------------------------------- 夹具 */

const T0 = 1_700_000_000_000;

function node(over = {}) {
  return {
    id: 'n1', type: 'keyframe', title: '关键帧', status: 'queued', progress: 0,
    data: { shot: { shotNo: 3 } },
    meta: { queuedAt: T0 },
    ...over,
  };
}

const project = (...nodes) => ({ id: 'prj_test', nodes, edges: [] });

function historyItem(prefix, ts, files = ['out_00001_.png'], extra = {}) {
  return {
    prompt: [1, `pid-${ts}`, { '29': { inputs: { filename_prefix: prefix } } }],
    outputs: { '29': { images: files.map((filename) => ({ filename, subfolder: '', type: 'output' })) } },
    status: { status_str: 'success', completed: true, messages: [['execution_start', { timestamp: ts }]] },
    ...extra,
  };
}

function snap({ history = {}, running = [], pending = [] } = {}) {
  return { queue: { running: new Set(running), pending: new Set(pending) }, history };
}

const fakeDownload = (assets) => async () => assets;
const imgAsset = (url = '/assets/adopted.png') => ({ url, file: 'adopted.png', kind: 'image' });

/* --------------------------------------------------------------- 用例 */

test('nodePromptIds 汇总 meta / 候选 / 片段上的 prompt_id', () => {
  const n = node({
    meta: { promptId: 'p_meta', promptIds: ['p_a', 'p_b'] },
    data: { candidates: [{ promptId: 'p_cand' }, {}], clip: { promptId: 'p_clip' } },
  });
  assert.deepEqual(nodePromptIds(n).sort(), ['p_a', 'p_b', 'p_cand', 'p_clip', 'p_meta']);
});

test('prompt_id 命中历史：直接取回产物并标记完成，不重新生成', async () => {
  const n = node({ meta: { queuedAt: T0, promptId: 'p_done' } });
  const p = project(n);
  const report = await reconcileProjectComfy(p, {
    snapshot: snap({ history: { p_done: historyItem('lingximanju_keyframe_3_111', T0 + 1000) } }),
    download: fakeDownload([imgAsset()]),
  });
  assert.equal(report.ok, true);
  assert.equal(report.counts.adopted, 1);
  assert.equal(report.counts.lost, 0);
  assert.equal(n.status, 'done');
  assert.equal(n.progress, 1);
  assert.equal(n.data.candidates.length, 1);
  assert.equal(n.data.candidates[0].url, '/assets/adopted.png');
  assert.equal(n.data.candidates[0].provider, 'comfyui');
  assert.equal(n.data.candidates[0].promptId, 'p_done');
  assert.equal(n.meta.adoptedFrom, 'comfyui-history');
});

test('prompt_id 仍在 ComfyUI 队列：保留状态并提供给调用方，不重发', async () => {
  const running = node({ status: 'running', meta: { queuedAt: T0, promptId: 'p_run' } });
  const queued = node({ id: 'n2', meta: { queuedAt: T0, promptId: 'p_wait' } });
  const p = project(running, queued);
  const report = await reconcileProjectComfy(p, {
    snapshot: snap({ running: ['p_run'], pending: ['p_wait'] }),
  });
  assert.equal(report.counts.running, 1);
  assert.equal(report.counts.queued, 1);
  assert.equal(report.counts.reset, 0);
  assert.equal(running.status, 'running');
  assert.equal(queued.status, 'queued');
});

test('ComfyUI 查无结果：复位为待执行并说明原因（never-sent / gone）', async () => {
  const neverSent = node({ id: 'n1', meta: { queuedAt: T0 } });
  const gone = node({ id: 'n2', meta: { queuedAt: T0, promptId: 'p_old' } });
  const p = project(neverSent, gone);
  const report = await reconcileProjectComfy(p, { snapshot: snap() });
  assert.equal(report.counts.lost, 2);
  assert.equal(report.counts.reset, 2);
  assert.equal(neverSent.status, 'idle');
  assert.equal(gone.status, 'idle');
  assert.equal(report.lost[0].reason, 'never-sent');
  assert.equal(report.lost[1].reason, 'gone');
  assert.equal(neverSent.meta.lostReason, 'never-sent');
});

test('resetMissing=false（后台观察模式）只认领不打扰，查无结果保持原状', async () => {
  const n = node({ id: 'n1' });
  const p = project(n);
  const report = await reconcileProjectComfy(p, { snapshot: snap(), resetMissing: false });
  assert.equal(report.counts.lost, 1);
  assert.equal(report.counts.reset, 0);
  assert.equal(n.status, 'queued');
});

test('没有 prompt_id 的老任务：按文件名前缀 + 镜号 + 时间窗兜底认领', async () => {
  const n = node({ data: { shot: { shotNo: 7 } }, meta: { queuedAt: T0 } });
  const p = project(n);
  const report = await reconcileProjectComfy(p, {
    snapshot: snap({ history: { old: historyItem('lingximanju_keyframe_7_999', T0 + 5000) } }),
    download: fakeDownload([imgAsset('/assets/shot7.png')]),
  });
  assert.equal(report.counts.adopted, 1);
  assert.equal(n.data.candidates[0].url, '/assets/shot7.png');
  assert.equal(report.adopted[0].shotNo, 7);
});

test('兜底匹配不认领上一轮的旧图（时间窗之外）', () => {
  const entries = buildHistoryEntries({
    old: historyItem('lingximanju_keyframe_7_999', T0 - 600_000),
  });
  const n = node({ data: { shot: { shotNo: 7 } }, meta: { queuedAt: T0 } });
  assert.equal(fuzzyMatchEntry(entries, n), null);
});

test('队列兜底：没有 prompt_id 但 ComfyUI 队列里有同镜任务 → 认领它，绝不当成丢失重发', async () => {
  const n = node({ data: { shot: { shotNo: 17 } }, meta: { queuedAt: T0 } });
  const p = project(n);
  const report = await reconcileProjectComfy(p, {
    snapshot: {
      queue: {
        running: new Set(['p_q17']), pending: new Set(),
        items: [{ promptId: 'p_q17', state: 'running', prefix: 'lingximanju_keyframe_17_1', tag: { kind: 'keyframe', shotNo: 17 }, claimed: false }],
      },
      history: {},
    },
  });
  assert.equal(report.counts.lost, 0);
  assert.equal(report.counts.reset, 0);
  assert.equal(report.counts.running, 1);
  assert.equal(n.status, 'running');
  assert.equal(n.meta.promptId, 'p_q17', '认领到的 prompt_id 要落盘，下次对账才能精确命中');
});

test('队列兜底：镜号不一致时不乱认（宁可再生一次，也不把别人的任务当成自己的）', async () => {
  const n = node({ data: { shot: { shotNo: 18 } }, meta: { queuedAt: T0 } });
  const p = project(n);
  const report = await reconcileProjectComfy(p, {
    snapshot: {
      queue: {
        running: new Set(['p_q17']), pending: new Set(),
        items: [{ promptId: 'p_q17', state: 'running', prefix: 'lingximanju_keyframe_17_1', tag: { kind: 'keyframe', shotNo: 17 }, claimed: false }],
      },
      history: {},
    },
  });
  assert.equal(report.counts.running, 0);
  assert.equal(report.counts.lost, 1);
  assert.equal(n.status, 'idle');
});

test('历史里的失败任务：标红并带上 ComfyUI 的报错，不算「已完成」', async () => {
  const n = node({ meta: { queuedAt: T0, promptId: 'p_bad' } });
  const p = project(n);
  const item = {
    prompt: [1, 'p_bad', { '29': { inputs: { filename_prefix: 'lingximanju_keyframe_3_1' } } }],
    outputs: {},
    status: {
      status_str: 'error', completed: false,
      messages: [['execution_error', { timestamp: T0, exception_message: 'CUDA out of memory' }]],
    },
  };
  const report = await reconcileProjectComfy(p, { snapshot: snap({ history: { p_bad: item } }) });
  assert.equal(n.status, 'error');
  assert.match(n.error, /ComfyUI 执行失败/);
  assert.equal(report.counts.adopted, 0);
  assert.equal(report.lost.length, 1);
});

test('视频节点：取回 clip 并标记真实产物', async () => {
  const v = node({
    id: 'v1', type: 'video', title: '镜头片段', meta: { queuedAt: T0, promptId: 'p_clip' },
    data: { shot: { shotNo: 3 }, keyframeUrl: '/assets/kf.png' },
  });
  const p = project(v);
  const report = await reconcileProjectComfy(p, {
    snapshot: snap({
      history: {
        p_clip: {
          prompt: [1, 'p_clip', { '9': { inputs: { filename_prefix: 'lingximanju_clip_3_1' } } }],
          outputs: { '9': { gifs: [{ filename: 'clip.mp4', subfolder: '', type: 'output' }] } },
          status: { status_str: 'success', completed: true, messages: [['execution_start', { timestamp: T0 + 2000 }]] },
        },
      },
    }),
    download: fakeDownload([{ url: '/assets/clip.mp4', file: 'clip.mp4', kind: 'video' }]),
  });
  assert.equal(report.counts.adopted, 1);
  assert.equal(v.status, 'done');
  assert.equal(v.data.clip.url, '/assets/clip.mp4');
  assert.equal(v.data.clip.isRealVideo, true);
  assert.equal(v.data.clip.promptId, 'p_clip');
});

test('转场节点：取回转场视频并挂到 transition.video 上', async () => {
  const t = node({
    id: 't1', type: 'transition', title: '转场', meta: { queuedAt: T0, promptId: 'p_tr' },
    data: { transition: { url: '/assets/anchor.png', frames: ['/assets/kf.png', '/assets/anchor.png'] } },
  });
  const p = project(t);
  await reconcileProjectComfy(p, {
    snapshot: snap({
      history: {
        p_tr: {
          prompt: [1, 'p_tr', { '9': { inputs: { filename_prefix: 'lingximanju_transition_1_1' } } }],
          outputs: { '9': { gifs: [{ filename: 'tr.mp4', subfolder: '', type: 'output' }] } },
          status: { status_str: 'success', completed: true, messages: [['execution_start', { timestamp: T0 + 2000 }]] },
        },
      },
    }),
    download: fakeDownload([{ url: '/assets/tr.mp4', file: 'tr.mp4', kind: 'video' }]),
  });
  assert.equal(t.status, 'done');
  assert.equal(t.data.transition.video.url, '/assets/tr.mp4');
  // 原有锚点图不能被覆盖成视频地址
  assert.equal(t.data.transition.url, '/assets/anchor.png');
});

test('择优等非 ComfyUI 节点卡在排队中：复位为待执行，不当作丢失任务', async () => {
  const r = node({ id: 'r1', type: 'review', title: '择优', status: 'queued', data: {} });
  const p = project(r);
  const report = await reconcileProjectComfy(p, { snapshot: snap() });
  assert.equal(r.status, 'idle');
  assert.equal(report.counts.lost, 0);
  assert.equal(report.counts.reset, 1);
});

test('多条转场同时残留且没有 prompt_id：不做猜测式认领，宁可判丢失重发', async () => {
  const a = node({ id: 't1', type: 'transition', title: '转场 1→2', meta: { queuedAt: T0 }, data: {} });
  const b = node({ id: 't2', type: 'transition', title: '转场 2→3', meta: { queuedAt: T0 }, data: {} });
  const p = project(a, b);
  const report = await reconcileProjectComfy(p, {
    snapshot: snap({
      history: {
        h1: historyItem('lingximanju_transition_1_11', T0 + 1000),
        h2: historyItem('lingximanju_transition_1_22', T0 + 2000),
      },
    }),
    download: fakeDownload([imgAsset()]),
  });
  assert.equal(report.counts.adopted, 0);
  assert.equal(report.counts.lost, 2);
  assert.equal(a.status, 'idle');
});

test('只剩一条转场残留：兜底匹配是确定的，可以直接取回', async () => {
  const t = node({ id: 't1', type: 'transition', title: '转场 1→2', meta: { queuedAt: T0 }, data: {} });
  const p = project(t);
  const report = await reconcileProjectComfy(p, {
    snapshot: snap({ history: { h1: historyItem('lingximanju_transition_1_11', T0 + 1000) } }),
    download: fakeDownload([imgAsset('/assets/tr.png')]),
  });
  assert.equal(report.counts.adopted, 1);
  assert.equal(t.data.transition.url, '/assets/tr.png');
});

test('复位后 ComfyUI 才出图：下一轮对账能把「待执行」节点追认回来', async () => {
  const n = node({
    status: 'idle',
    meta: { queuedAt: T0, lostAt: Date.now(), lostReason: 'never-sent' },
    data: { shot: { shotNo: 9 } },
  });
  const p = project(n);
  const report = await reconcileProjectComfy(p, {
    snapshot: snap({ history: { h: historyItem('lingximanju_keyframe_9_1', T0 + 8000) } }),
    download: fakeDownload([imgAsset('/assets/late.png')]),
  });
  assert.equal(report.counts.adopted, 1);
  assert.equal(n.status, 'done');
  assert.equal(n.data.candidates[0].url, '/assets/late.png');
});

test('ComfyUI 连不上：返回 offline，且不改动任何节点状态', async () => {
  const n = node({ id: 'n1' });
  const p = project(n);
  const report = await reconcileProjectComfy(p, {
    snapshot: null,
    config: { baseUrl: '' },
  });
  assert.equal(report.ok, false);
  assert.equal(report.reason, 'offline');
  assert.equal(n.status, 'queued');
});
