// 六步任务执行器（业务层，从 API 路由下沉）+ 管理状态广播
// 节点型 Agent 靠「导入即注册」生效。正常 HTTP 链路由 routes → agents/index 完成注册，
// 但脚本 / 单元测试 / 导演智能体可能直接调用 executeSteps：这里显式导入，
// 否则 getAgent() 全为空，节点会被静默标成 skipped，出现「六步全 done 但画布没长节点」的假成功。
import '../agents/narrative.mjs';
import '../agents/visual.mjs';
import { saveProject } from './store.mjs';
import { emit } from './events.mjs';
import { isRunning, runProject } from './orchestrator.mjs';
import { ensureManagement, stepProgress, startStep, finishStep,
  resetStep, resetAllSteps, STEPS, STEP_BY_ID, projectStats } from './project-steps.mjs';
import { refreshEpisodes } from '../pipelines/novel-project.mjs';
import { resolveComfyConfig } from './comfy-config.mjs';
import { exportDirectorPack } from './director-pack.mjs';
import { isRealClip } from './film-policy.mjs';
import { regenerateProjectGrids } from './episode-service.mjs';
import { describeStoryboardSettings, resolveStoryboardSettings } from './storyboard-settings.mjs';
import { isRealKeyframe, keyframeTally, allowMockArtifacts } from './keyframe-status.mjs';
import { verifyDirectorDeliverables } from './director-skills.mjs';

/** 项目管理状态广播：步骤面板、侧栏进度、顶栏状态胶囊都靠这个事件对齐 */
export function broadcastMeta(project) {
  emit('project:meta', {
    projectId: project.id,
    management: ensureManagement(project),
    stats: projectStats(project),
    progress: stepProgress(project.management),
    // 实时最终产物验收（纯函数、不落盘）：第⑦步面板据此显示「当前状态」，
    // 而不是 management.director.lastRun 里上次导演全流程跑完时的历史快照。
    verification: verifyDirectorDeliverables(project),
  });
}

/**
 * 保证最终节点上有导演包：第 ⑥ 步与「导演 Agent 一键全流程」共用同一口径。
 * force=true 时按当前画布重新打包（视觉类技能改动画面后重出交接包）。
 * @returns {object|null} 打包信息；已存在且未强制时返回既有信息
 */
export function ensureDirectorPack(project, { force = false } = {}) {
  const finalNode = (project.nodes || []).find((n) => n.type === 'final');
  if (!finalNode) return null;
  const existing = finalNode.data?.directorPack;
  if (existing?.file && !force) return existing;
  const cfg = resolveComfyConfig(project);
  const info = exportDirectorPack(project, cfg);
  const pack = {
    url: info.url, file: info.file, filename: info.filename, bytes: info.bytes,
    shotCount: info.shotCount, fileCount: info.fileCount, target: info.format,
    groups: info.groups, note: info.note,
  };
  finalNode.data = { ...(finalNode.data || {}), directorPack: pack };
  emit('node:data', { projectId: project.id, nodeId: finalNode.id, patch: { directorPack: pack } });
  return pack;
}

/* ------------------------------------------------------------------ 产物校验
 * 编排「跑完了」≠ 这一步真的做出了东西。上游节点残留 running 时 computeTargets
 * 找不到可调度节点，runProject 会返回 0 节点 0 波的成功摘要，步骤被标绿，
 * 但画布上既没有剧本也没有镜头/关键帧——用户看到的就是「生成失败」。
 * 因此每一步结束前按该步的**真实产物**硬校验，缺产物就按失败收尾并给出可操作提示。
 */
const nodesOf = (project, type) => (project.nodes || []).filter((n) => n.type === type);

/** 分镜板数量：每段一张（格数由分镜画面设置决定），直接读剧集管理数据，不额外维护计数 */
function gridCount(m) {
  return (m?.episodes || []).reduce((a, ep) => a + (ep.segments || []).filter((s) => s.gridUrl).length, 0);
}

function stepArtifacts(project, stepId) {
  if (stepId === 'script') {
    const node = nodesOf(project, 'script')[0];
    const scenes = Number(node?.data?.script?.scenes?.length) || 0;
    if (!scenes) {
      return { ok: false, note: '剧本没有产出：编剧智能体未写入结构化场景（节点状态已自动复位，请重跑本步；若反复失败请检查模型配置 / 日志）' };
    }
    return { ok: true, note: `${scenes} 个场景` };
  }
  if (stepId === 'context') {
    const shots = nodesOf(project, 'shot').length;
    if (!shots) return { ok: false, note: '没有展开出镜头：事件 / 场景分解为空，请先确认第③步剧本已生成，再重跑本步' };
    return { ok: true, note: `${shots} 个镜头` };
  }
  if (stepId === 'storyboard') {
    // 真实口径：mock 自绘 SVG / .svg 占位不算已出图。
    // 否则「40 张占位示意图」会被当成全部完成，步骤标绿，用户点开却一张真图都没有。
    const tally = keyframeTally(project);
    const m = ensureManagement(project);
    const grids = gridCount(m);
    // 分镜板是按版式每段一张：把「应有几张」一并报出来，换版式后缺板能立刻看见
    const wantGrids = (m.episodes || []).reduce((a, ep) => a + (ep.segments || []).length, 0);
    const sb = resolveStoryboardSettings(project);
    const gridText = grids
      ? ` · ${grids}/${wantGrids} 张分镜板（${describeStoryboardSettings(sb)}）`
      : '';
    if (tally.real) {
      const tail = tally.placeholder || tally.missing
        ? `（另有占位 ${tally.placeholder} 张 / 待出 ${tally.missing} 张）`
        : '';
      return { ok: true, note: `真实分镜图 ${tally.real}/${tally.total} 张${tail}${gridText}` };
    }
    if (!tally.total) {
      return { ok: false, note: '没有可生成的分镜：画布上缺少镜头 / 关键帧节点，请先执行第④步' };
    }
    if (tally.placeholder) {
      return { ok: false, note: `只生成了 ${tally.placeholder} 张占位示意图（provider=mock），没有任何真实出图：请检查 ComfyUI 连接与出图工作流后重跑本步` };
    }
    return { ok: false, note: `分镜图全部生成失败：${tally.total} 个关键帧都没有拿到图片，请查看运行日志中的出图错误后重跑本步` };
  }
  if (stepId === 'deliver') {
    const m = ensureManagement(project);
    const finalData = nodesOf(project, 'final')[0]?.data || {};
    const wantVideo = m.deliverables?.video !== false;
    const wantPack = m.deliverables?.pack !== false;
    const problems = [];
    if (wantVideo) {
      const expected = Number(m.runtime?.clipCount) || 0;
      const clips = nodesOf(project, 'video').filter((n) => n.data?.clip).length;
      if (expected && clips < expected) problems.push(`视频片段 ${clips}/${expected} 未齐`);
      if (!finalData.film?.file) {
        problems.push(`成片未产出：${String(finalData.filmNote || '真实 AI 片段未齐，未拼接 MP4').slice(0, 120)}`);
      }
    }
    if (wantPack && !finalData.directorPack?.file) problems.push('导演包未生成');
    if (problems.length) return { ok: false, note: `交付未完成：${problems.join('；')}` };
    const bits = [];
    if (finalData.film?.file) bits.push(finalData.film.isRealVideo ? '真实 AI 成片' : '预览成片');
    if (finalData.directorPack?.file) bits.push('导演包');
    return { ok: true, note: bits.join(' + ') || '交付完成' };
  }
  return { ok: true, note: '' };
}

/**
 * 「已完成」状态自愈：步骤状态是持久化的，但产物可能在重跑 / 清理 / 降级后消失。
 * 典型场景：第⑤步曾按「有图就算出图」标绿，实际全是 mock 占位示意图；
 * 或关键帧被重新执行后清空。刷新页面时若不校正，用户看到的就是
 * 「分镜与画面 已完成」+ 一张真图都没有。
 * 只做降级（done → error + stale），不擅自把步骤改回 pending，原因写进 note。
 * @returns {{id:string, note:string}[]} 被降级的步骤
 */
export function reconcileSteps(project) {
  const m = ensureManagement(project);
  const fixed = [];
  const runningNow = isRunning(project.id);
  for (const s of m.steps || []) {
    if (s.status !== 'done' && s.status !== 'running') continue;
    const def = STEP_BY_ID[s.id];
    if (!def || def.auto) continue;          // ①② 是自动确认步，没有可校验产物
    // 「进行中」但本进程没有活动运行 = 上次被中断的死状态（服务重启 / 请求断开）。
    // 浏览器刷新后它会一直显示「进行中」，用户以为还在出图，其实什么都没跑。
    if (s.status === 'running') {
      if (runningNow) continue;
      s.status = 'error';
      s.stale = true;
      s.note = '上次执行被中断（服务重启或请求中断），已自动复位，可重新执行';
      fixed.push({ id: s.id, note: s.note });
      continue;
    }
    const artifacts = stepArtifacts(project, s.id);
    if (artifacts.ok) { delete s.stale; continue; }
    s.status = 'error';
    s.stale = true;
    s.note = `已完成状态失效：${artifacts.note}`;
    fixed.push({ id: s.id, note: artifacts.note });
  }
  return fixed;
}

/** 执行前的上游依赖预检：缺关键上游时直接给出「先做哪一步」，而不是空跑一趟再失败 */
function stepPreflight(project, stepId) {
  if (stepId === 'script') {
    const scriptNode = nodesOf(project, 'script')[0];
    if (!String(scriptNode?.data?.text || '').trim()) {
      return { ok: false, note: '剧本节点没有收到原著 / 分集梗概：请先完成第①②步（上传小说、分集拆解）' };
    }
  }
  if (stepId === 'storyboard') {
    const shots = nodesOf(project, 'shot').length;
    if (!shots) return { ok: false, note: '画布上没有镜头：请先执行第④步（RAG · 角色 · 层次分解）展开事件 → 场景 → 镜头' };
  }
  if (stepId === 'deliver') {
    const shots = nodesOf(project, 'shot').length;
    if (!shots) return { ok: false, note: '画布上没有镜头：请先完成第④步展开镜头链，再执行第⑤步出分镜图' };
    if (!keyframeTally(project).real) {
      return { ok: false, note: '还没有真实分镜图（占位示意图不算）：请先执行第⑤步生成分镜提示词与关键帧，画面定版后再统一出视频' };
    }
    if (deliverableVideoWanted(project)) {
      const videos = nodesOf(project, 'video').length;
      if (videos < shots) {
        return { ok: false, note: `有 ${shots} 个镜头但只有 ${videos} 个视频节点：请先重跑第④步展开完整的镜头链，再回到本步出视频` };
      }
    }
  }
  return { ok: true, note: '' };
}

function deliverableVideoWanted(project) {
  return (ensureManagement(project).deliverables || {}).video !== false;
}

/**
 * 第⑥步只出视频：把「有端点帧但没有转场视频」的转场节点标成 videoOnly 后重跑，
 * 这样不会为了补 2 秒转场视频把两侧的端点视图重新出图（每张都是真金白银的 GPU 时间）。
 */
function markTransitionVideoOnly(project, { regen = false } = {}) {
  const marked = [];
  for (const node of nodesOf(project, 'transition')) {
    if (!regen && node.data?.transition?.video) continue;
    if (!node.data?.transition?.frames?.length) continue;
    node.data = { ...(node.data || {}), videoOnly: true };
    marked.push(node);
  }
  return marked;
}

/**
 * 每一步真正「产出产物」的节点。重新执行某步时必须把这些节点复位成 idle，
 * 否则 computeTargets 只认 idle/error，已 done 的节点会被当成「无事可做」，
 * 于是重跑只是 0 节点空跑一遍——用户点了「重新生成」却什么都没发生。
 *
 * 第⑤/⑥步按「缺什么补什么」增量复位：
 *   已出图的关键帧、已出片段的视频不再重算（40 镜头全量重出要几十分钟 GPU），
 *   只把缺图 / 缺片段的节点拉回 idle；传 regen=true 才是全量重出。
 */
const STEP_PRODUCERS = {
  script: ['script'],
  context: ['plan'],
  storyboard: ['keyframe', 'review', 'transition', 'camera'],
  deliver: ['video', 'transition', 'final'],
};

/**
 * 已经提交给 ComfyUI、还在跑（或还在它队列里）的任务。
 * 这类节点**不能**复位成 idle：复位之后调度器会重新发一遍，等于把正在算的同一条图再烧一次。
 * 正确做法是留给 runProject 的对账逻辑用 prompt_id 把结果认回来。
 */
function inFlightInComfy(node) {
  return (node.status === 'running' || node.status === 'queued') && Boolean(node.meta?.promptId);
}

function resetNode(node) {
  if (inFlightInComfy(node)) return null;
  node.status = 'idle'; node.progress = 0; node.error = '';
  return node;
}

const parentOf = (project, id, kind = 'flow') => (project.edges || [])
  .find((e) => e.to === id && (!kind || e.kind === kind))?.from || null;

function resetStepProducers(project, stepId, { regen = false } = {}) {
  const types = STEP_PRODUCERS[stepId] || [];
  if (!types.length) return [];
  const reset = [];
  // 统一入口：正在 ComfyUI 里跑的任务不入 reset 列表（resetNode 返回 null），
  // 否则「重跑本步」会把它们当缺失产物重新发一遍
  const stage = (node) => { const r = resetNode(node); if (r) reset.push(r); };
  const wantedVideo = deliverableVideoWanted(project);
  const policy = ensureManagement(project).runtime?.filmPolicy || 'real';

  /* 第⑤步：补缺失的分镜图（重跑时不再全量重出已完成的真实图；占位图算缺失，会被重出） */
  if (stepId === 'storyboard') {
    const realOpts = { allowMock: allowMockArtifacts(project) };
    const droppedKeyframes = new Set();
    for (const node of nodesOf(project, 'keyframe')) {
      if (regen || !isRealKeyframe(node, realOpts)) {
        droppedKeyframes.add(node.id);
        stage(node);
      }
    }
    const droppedReviews = new Set();
    for (const node of nodesOf(project, 'review')) {
      const src = parentOf(project, node.id);
      if (regen || !node.data?.keyframeUrl || droppedKeyframes.has(src)) {
        droppedReviews.add(node.id);
        stage(node);
      }
    }
    for (const node of nodesOf(project, 'transition')) {
      const src = parentOf(project, node.id, 'anchor') || parentOf(project, node.id);
      // 第⑤步只产端点帧；顺带清掉上一轮的 videoOnly 标记，恢复完整执行
      const dirty = node.data?.videoOnly === true;
      if (dirty) node.data = { ...(node.data || {}), videoOnly: false };
      if (regen || dirty || !node.data?.transition?.url || droppedReviews.has(src)) {
        stage(node);
      }
    }
    // 机位图只是一份汇总报告，重跑时总是刷新
    for (const node of nodesOf(project, 'camera')) stage(node);
    return reset;
  }

  /* 第⑥步：只补缺失片段 + 重拼成片 */
  if (stepId === 'deliver') {
    if (wantedVideo) {
      for (const node of nodesOf(project, 'video')) {
        const clip = node.data?.clip;
        const ready = policy === 'real' ? isRealClip(clip) : Boolean(clip);
        if (regen || !ready) stage(node);
      }
      reset.push(...markTransitionVideoOnly(project, { regen }));
    }
    for (const node of nodesOf(project, 'final')) stage(node);
    return reset;
  }

  for (const node of project.nodes || []) {
    if (!types.includes(node.type) || node.status === 'idle') continue;
    stage(node);
  }
  return reset;
}

/**
 * 每一步实际下发的节点白名单。
 * 第⑥步默认含视频节点，但「只出导演包」（deliverables.video=false）时不该烧 GPU 出片段，
 * 此时只跑 final，交接包由 composer 直接打包。
 */
function stepScope(project, def) {
  if (def.id !== 'deliver') return def.scope;
  return deliverableVideoWanted(project) ? def.scope : ['final'];
}

/** 第⑤步收尾：把刚出的关键帧按当前画面设置重排每段分镜板（纯 SVG 合成，失败不阻断本步） */
async function syncEpisodeGrids(project, m) {
  const episodes = m.episodes || [];
  if (!episodes.length) return '';
  try {
    const out = await regenerateProjectGrids(project, m, {
      log: (level, message) => emit('log', { projectId: project.id, level, message }),
    });
    if (!out.grids) return '';
    return `${out.grids} 张分镜板（${out.description}）`;
  } catch (err) {
    emit('log', { projectId: project.id, level: 'warn', message: `分镜板生成失败：${err.message}` });
    return '';
  }
}

/**
 * 六步任务执行器：把「步骤」翻译成 orchestrator 的节点类型白名单（scope），
 * 逐阶段调度真实的智能体流水线；每步开始 / 结束都广播状态供前端做视觉提示。
 */
export async function executeSteps(project, body = {}) {
  const m = ensureManagement(project);
  const id = project.id;
  if (body.action === 'reset') {
    if (body.stepId) resetStep(m, body.stepId); else resetAllSteps(m);
    saveProject(project);
    broadcastMeta(project);
    return { ok: true, message: '任务状态已重置', management: m, progress: stepProgress(m) };
  }
  if (m.kind !== 'novel') return { ok: false, error: '这是标准流水线项目，请使用顶栏「运行完整流水线」' };

  /**
   * 残留 running 自愈：步骤状态是持久化的，但「正在跑」这个事实只存在于本进程内存里。
   * 服务重启、进程被杀、客户端中断请求都会留下「status=running 但根本没人跑」的死状态，
   * 之后每一次全流程都会被 isRunning 挡住，用户只看到「已有运行中的任务」却找不到那个任务。
   * 这里判定「状态是 running 但本进程没有活动运行」即为残留，按失败收尾（保留 note 说明原因），
   * 让它回到可重试状态，而不是要求用户去点一个不存在的停止按钮。
   */
  const stale = (m.steps || []).filter((s) => s.status === 'running');
  if (stale.length && !isRunning(id)) {
    for (const s of stale) {
      finishStep(m, s.id, { ok: false, note: '上次执行被中断（服务重启或请求中断），已自动复位，可重新执行', durationMs: 0 });
    }
    saveProject(project);
    broadcastMeta(project);
    emit('log', { projectId: id, level: 'warn', message: `检测到 ${stale.length} 个残留的执行中步骤，已自动复位` });
  }

  if (isRunning(id)) return { ok: false, error: '该项目已有运行中的任务，请等它结束或先点「停止」' };

  // 已标绿但产物不达标的步骤先降级：避免「已完成」把真正的缺口藏起来
  const staleDone = reconcileSteps(project);
  if (staleDone.length) {
    saveProject(project);
    broadcastMeta(project);
    emit('log', { projectId: id, level: 'warn', message: `检测到 ${staleDone.length} 个步骤的产物已失效，已标记为未完成：${staleDone.map((s) => STEP_BY_ID[s.id]?.title || s.id).join('、')}` });
  }

  // `all` = 所有未完成的步骤：骨架项目会从第 ① 步（上传小说）开始，
  // 已完成的 auto 步骤（①② 在上传后已 done）自动跳过。
  // `steps` = 导演 Agent 按技能声明的显式步骤链（如只跑智能体四步），顺序统一按 STEPS 校正。
  const explicit = Array.isArray(body.steps)
    ? body.steps.map(String).filter((sid) => STEP_BY_ID[sid])
    : null;
  const rawIds = explicit !== null ? explicit : (body.all
    ? STEPS.filter((s) => m.steps?.find((x) => x.id === s.id)?.status !== 'done').map((s) => s.id)
    : [body.stepId || stepProgress(m).currentId]);
  const ids = [...new Set(rawIds)].sort((a, b) => (STEP_BY_ID[a]?.no || 0) - (STEP_BY_ID[b]?.no || 0));
  const executed = [];

  for (const stepId of ids) {
    const def = STEP_BY_ID[stepId];
    if (!def) return { ok: false, error: `未知步骤：${stepId}` };
    const state = () => m.steps.find((s) => s.id === stepId);
    if (!body.force && state()?.status === 'done') continue;

    // 缺关键上游时不做「空跑一趟再标绿」：直接失败并告诉用户先做哪一步
    const pre = stepPreflight(project, stepId);
    if (!pre.ok) {
      finishStep(m, stepId, { ok: false, note: pre.note, durationMs: 0 });
      emit('log', { projectId: id, level: 'error', message: `第 ${def.no} 步无法执行：${pre.note}` });
      saveProject(project);
      broadcastMeta(project);
      executed.push({ id: stepId, status: 'error', note: pre.note });
      break;
    }

    // 本步的直接产出节点复位为待执行：重跑必须真的重算，而不是 0 节点空跑
    const resetNodes = resetStepProducers(project, stepId, { regen: body.regen === true });
    if (resetNodes.length) {
      emit('log', { projectId: id, level: 'info', message: `第 ${def.no} 步重新生成：已复位 ${resetNodes.length} 个产出节点（${resetNodes.map((n) => n.title).slice(0, 6).join('、')}）` });
    }
    // 第⑤步只出图，第⑥步才出视频：把这个阶段意图下发给智能体，
    // 让转场节点在本步只建端点帧、不偷偷调用图生视频。
    const scope = stepScope(project, def);
    const videoStage = stepId === 'deliver';

    startStep(m, stepId, { action: body.action || 'manual', trigger: body.trigger || '' });
    saveProject(project);
    broadcastMeta(project);
    emit('log', { projectId: id, level: 'info', message: `▶ 第 ${def.no} 步「${def.title}」开始 · 理论依据 ${def.theory.ref}` });
    const t0 = Date.now();
    try {
      if (def.auto) {
        if (stepId === 'upload') {
          // 极简创建的骨架项目：这一步是「上传小说」的真实入口，没原著就明确失败提示
          if (!m.source?.text) throw new Error('尚未上传小说 · 请在本步骤点「上传小说」选择文件或粘贴正文');
          finishStep(m, stepId, { ok: true, note: `原著已确认 · ${m.source.chapterCount} 章 ${m.source.totalChars} 字`, durationMs: Date.now() - t0 });
        } else if (stepId === 'episodes') {
          const r = refreshEpisodes(project);
          emit('state', { projectId: id, project, reason: 'episodes' });
          finishStep(m, stepId, { ok: true, note: r.message, durationMs: Date.now() - t0 });
        } else {
          finishStep(m, stepId, { ok: true, note: '原著与交付设置已确认', durationMs: Date.now() - t0 });
        }
      } else {
        const summary = await runProject(id, { project, scope, videoStage });
        const ranOk = summary.status === 'done' && summary.failed === 0;
        // 第⑤步的最终产物不只是画布关键帧：每个剧集段落的分镜板也在这一步落盘
        // （纯 SVG 合成，用第⑤步刚出的真实关键帧填格，不额外调用 GPU）。
        const gridNote = (stepId === 'storyboard' && ranOk) ? await syncEpisodeGrids(project, m) : '';
        // 交付步：按项目交付设置保证导演包存在（composer 在「只生成视频」模式下不打包）
        if (stepId === 'deliver' && ranOk && m.deliverables?.pack) ensureDirectorPack(project);
        // 编排成功但没产物 → 仍然按失败收尾（「六步全绿、画布全空」是最误导人的状态）
        const artifacts = ranOk ? stepArtifacts(project, stepId) : null;
        const ok = ranOk && (!artifacts || artifacts.ok);
        const finalData = project.nodes.find((n) => n.type === 'final')?.data || {};
        const extra = stepId === 'deliver'
          ? (finalData.film?.isRealVideo ? ' · ComfyUI 真实成片 MP4 已生成'
            : finalData.film?.source === 'preview-frames' ? ' · 关键帧预览成片（非 AI 视频，验收降级）'
              : ` · 未产出成片：${String(finalData.filmNote || '真实 AI 片段未齐').slice(0, 90)}`)
          : '';
        const tk = summary.tokens;
        const tokNote = tk?.total ? ` · ${(tk.total >= 1000 ? (tk.total / 1000).toFixed(1) + 'k' : tk.total)} tokens` : '';
        const fbNote = summary.fallbacks ? ` · LLM 回退 Mock ${summary.fallbacks} 次` : '';
        const artifactNote = artifacts?.ok && artifacts.note ? ` · ${artifacts.note}` : '';
        finishStep(m, stepId, {
          ok,
          note: ok
            ? `${summary.nodeCount} 节点 · ${summary.waves} 波 · ${(summary.durationMs / 1000).toFixed(1)}s${tokNote}${fbNote}${artifactNote}${gridNote ? ` · ${gridNote}` : ''}${extra}`
            : !ranOk
              ? `编排${summary.status === 'cancelled' ? '已取消' : '失败'}，失败节点 ${summary.failed} 个${tokNote}${fbNote}`
              : artifacts?.note || '执行完成但没有产出产物',
          durationMs: Date.now() - t0,
          tokens: tk || null,
        });
      }
    } catch (err) {
      finishStep(m, stepId, { ok: false, note: err.message, durationMs: Date.now() - t0 });
      emit('log', { projectId: id, level: 'error', message: `第 ${def.no} 步失败：${err.message}` });
    }
    saveProject(project);
    broadcastMeta(project);
    executed.push({ id: stepId, status: state().status, note: state().note });
    if (state().status === 'error') break;
  }
  emit('state', { projectId: id, project, reason: 'step' });
  return {
    ok: true, management: m, progress: stepProgress(m),
    stats: projectStats(project), executed,
  };
}
