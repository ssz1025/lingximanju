/* ============================================================================
 * 工作台第 ⑦ 步「视频与交付」· 成片播放 / 分镜对应 / 步骤统计
 *
 * 三块内容，数据全部来自画布节点与 management.steps（不另建台账）：
 *   ① 成片在线播放：<video> 直接播 /assets 下的成片 MP4，可下载；
 *   ② 成片时间线：40 个片段一格一镜，与第⑥步的分镜一一对应，
 *      每格显示该镜视频任务的实时状态（复用 task-panel 的状态语义），
 *      点任意一格把主播放器切换到该片段，逐镜检查；
 *   ③ 步骤统计：每一步最近一次执行的耗时、运行次数、执行 / 对话 Token 消耗与合计。
 *
 * filmTimelineHTML / stepStatsTableHTML 都是纯函数，可在 node 里单测。
 * ==========================================================================*/
import { esc, cut } from './utils.js';
import { collectShotTasks, fmtDur } from './task-panel.js';

const CLIP_STATUS = {
  done: { label: '已入片', cls: 'done', title: '该镜头的 AI 片段已生成并拼入成片' },
  running: { label: '生成中', cls: 'running', title: '该镜头片段正在 ComfyUI 生成，成片还没有它' },
  queued: { label: '已发送', cls: 'queued', title: '该镜头任务已提交 ComfyUI 排队' },
  planned: { label: '等待发送', cls: 'pending', title: '已排进运行计划，还没提交 ComfyUI（等并发空出来）' },
  pending: { label: '待生成', cls: 'pending', title: '该镜头还没有片段任务' },
  error: { label: '失败', cls: 'error', title: '该镜头片段生成失败，需重出' },
  skipped: { label: '已跳过', cls: 'skipped', title: '该镜头被跳过' },
};

/** 片段条目：把视频节点整理成「成片时间线」的一格 */
export function collectFilmClips(project) {
  const statusByNode = new Map(
    collectShotTasks(project, { kinds: ['video'] }).map((t) => [t.nodeId, t]),
  );
  const nodes = (project?.nodes || []).filter((n) => n.type === 'video');
  return nodes
    .map((n) => {
      const t = statusByNode.get(n.id) || null;
      const clip = n.data?.clip || null;
      // 状态统一走第⑥步任务看板的口径（queued 无提交证据 → planned 等待发送）；
      // 没有对应任务时才退回节点自身的 status。
      const stt = t ? t.status : (CLIP_STATUS[n.status] ? n.status : 'pending');
      return {
        nodeId: n.id,
        shotNo: n.data?.shot?.shotNo ?? t?.shotNo ?? null,
        sequence: Number(n.data?.sequence) || Number(n.data?.shot?.shotNo) || 0,
        size: n.data?.shot?.size || t?.size || '',
        poster: clip?.poster || n.data?.poster || '',
        clipUrl: clip?.url || (clip?.file ? `/assets/${clip.file}` : ''),
        seconds: Number(clip?.duration) || Number(n.data?.duration) || 0,
        status: stt,
        statusLabel: CLIP_STATUS[stt].label,
        statusCls: CLIP_STATUS[stt].cls,
        statusTitle: CLIP_STATUS[stt].title,
        promptId: clip?.promptId || t?.promptId || '',
        error: n.error || t?.error || '',
      };
    })
    .sort((a, b) => (a.sequence - b.sequence) || ((a.shotNo ?? 0) - (b.shotNo ?? 0)));
}

/**
 * 成片时间线：一格一镜，与第⑥步分镜一一对应。
 * @param {object} project
 * @returns {{html:string, counts:object}}
 */
export function filmTimelineHTML(project) {
  const clips = collectFilmClips(project);
  const counts = clips.reduce((acc, c) => {
    acc[c.status] = (acc[c.status] || 0) + 1;
    return acc;
  }, {});
  if (!clips.length) {
    return { html: '', counts };
  }
  const totalSec = clips.reduce((a, c) => a + (c.seconds || 0), 0);
  const inFilm = counts.done || 0;
  const legend = [
    ['done', '已入片'],
    ['running', '生成中'],
    ['queued', '已发送'],
    ['planned', '等待发送'],
    ['error', '失败'],
  ].filter(([k]) => counts[k]).map(([k, label]) => `<span class="pvf-lg st-${CLIP_STATUS[k].cls}"><i></i>${label} ${counts[k]}</span>`).join('');
  const cells = clips.map((c) => {
    // 封面默认取视频第一帧：<video preload="metadata"> + #t=0.1 让浏览器只拉
    // 头部元数据就渲染 0.1s 处的画面；没有片段 URL 时才退回生成海报图。
    const thumb = c.clipUrl
      ? `<video class="pvf-thumb" src="${esc(c.clipUrl)}#t=0.1" preload="metadata" muted playsinline tabindex="-1"></video>`
      : c.poster
        ? `<img src="${esc(c.poster)}" alt="" loading="lazy">`
        : '<span class="pvf-ph">▶</span>';
    return `<button class="pvf-cell st-${c.statusCls}" data-clip="${esc(c.clipUrl)}"
      data-shot="${esc(String(c.shotNo ?? ''))}" title="${esc(c.statusTitle)}${c.error ? ` · ${esc(cut(c.error, 60))}` : ''}">
      ${thumb}<span class="pvf-play" title="播放这一镜">▶</span>
      <span class="pvf-no">#${esc(String(c.shotNo ?? '—'))}</span>
      ${c.size ? `<span class="pvf-size">${esc(cut(c.size, 6))}</span>` : ''}
      <span class="pvf-pill ${c.statusCls}">${esc(c.statusLabel)}</span>
      ${c.seconds ? `<span class="pvf-sec">${c.seconds.toFixed ? c.seconds.toFixed(1) : c.seconds}s</span>` : ''}
    </button>`;
  }).join('');
  const html = `<div class="pv-card pvf-timeline">
    <div class="pv-card-head">
      <span>🎞 成片时间线 · 与第⑥步分镜一一对应</span>
      <span class="pv-hint-inline">${clips.length} 格 · 已入片 ${inFilm}/${clips.length} · 合计 ${totalSec.toFixed(1)}s
        <button class="btn sm" data-act="goto-storyboard" title="回到第⑥步查看分镜与画面任务">⟶ 第⑥步</button></span>
    </div>
    <div class="pvf-legend">${legend || '<span>还没有片段任务</span>'}</div>
    <div class="pvf-grid">${cells}</div>
    <div class="pvf-foot">点任意一格 → 主播放器切换到该镜头片段，逐镜核对；<b class="st-done">已入片</b>表示该镜头的 AI 片段已拼进成片，其余状态与第⑥步任务看板一致。</div>
  </div>`;
  return { html, counts };
}

/** 一行步骤的 token 汇总文本：执行 + 对话合并展示 */
function tokensOf(s) {
  const t = s.tokens || {};
  const c = s.chatTokens || {};
  return {
    exec: `${t.total || 0}（调用 ${t.calls || 0} 次）`,
    chat: c.total ? `${c.total}（调用 ${c.calls || 0} 次）` : '—',
    total: (t.total || 0) + (c.total || 0),
    calls: (t.calls || 0) + (c.calls || 0),
  };
}

const STEP_LABELS = {
  upload: '① 原著', episodes: '② 分集', script: '③ 剧本',
  context: '④ 角色', storyboard: '⑤ 分镜与画面', deliver: '⑥ 视频与交付',
};
const STEP_STT = {
  done: { label: '已完成', cls: 'done' }, running: { label: '执行中', cls: 'running' },
  error: { label: '失败', cls: 'error' }, pending: { label: '待执行', cls: 'pending' },
};

/**
 * 每步耗时 / Token 统计表。
 * @param {object} m management 元数据（m.steps[] 带 tokens / chatTokens / durationMs / runs）
 */
export function stepStatsTableHTML(m) {
  const steps = (m?.steps || []).filter((s) => STEP_LABELS[s.id]);
  if (!steps.length) return '';
  const rows = steps.map((s) => {
    const tk = tokensOf(s);
    const stt = STEP_STT[s.status] || STEP_STT.pending;
    const dur = s.durationMs ? fmtDur(s.durationMs) : (s.runs ? '—' : '未执行');
    return `<tr class="pvf-row st-${stt.cls}" data-step-row="${esc(s.id)}">
      <td>${esc(STEP_LABELS[s.id] || s.id)}</td>
      <td><span class="pvf-pill ${stt.cls}">${esc(stt.label)}</span></td>
      <td title="最近一次执行的耗时">${dur}</td>
      <td class="num" title="累计执行次数">${s.runs || 0}</td>
      <td class="num" title="智能体执行消耗：合计（调用次数）">${esc(tk.exec)}</td>
      <td class="num" title="步骤对话消耗：合计（调用次数）">${esc(tk.chat)}</td>
      <td class="num strong">${tk.total.toLocaleString()}</td>
    </tr>`;
  }).join('');
  const sum = steps.reduce((a, s) => {
    const tk = tokensOf(s);
    a.total += tk.total; a.calls += tk.calls;
    a.dur += Number(s.durationMs) || 0;
    return a;
  }, { total: 0, calls: 0, dur: 0 });
  return `<div class="pv-card pvf-stats">
    <div class="pv-card-head"><span>📊 步骤耗时与 Token 统计</span>
      <span class="pv-hint-inline">耗时为最近一次执行 · Token 为累计消耗</span></div>
    <table class="pvf-table">
      <thead><tr><th>步骤</th><th>状态</th><th>最近耗时</th><th>执行次数</th><th>执行 Token</th><th>对话 Token</th><th>Token 合计</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr>
        <td>合计</td><td></td><td>—</td><td class="num">—</td>
        <td class="num" colspan="2">调用 ${sum.calls} 次</td>
        <td class="num strong">${sum.total.toLocaleString()}</td>
      </tr></tfoot>
    </table>
    <div class="pvf-foot">GPU 生成（关键帧 / 视频片段）不走大模型 Token，消耗体现在「最近耗时」里；Token 只统计剧本、分镜提示词、导演验收等文本智能体调用。</div>
  </div>`;
}
