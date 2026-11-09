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

/** 项目管理状态广播：步骤面板、侧栏进度、顶栏状态胶囊都靠这个事件对齐 */
export function broadcastMeta(project) {
  emit('project:meta', {
    projectId: project.id,
    management: ensureManagement(project),
    stats: projectStats(project),
    progress: stepProgress(project.management),
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
        const summary = await runProject(id, { project, scope: def.scope });
        const ok = summary.status === 'done' && summary.failed === 0;
        // 交付步：按项目交付设置保证导演包存在（composer 在「只生成视频」模式下不打包）
        if (stepId === 'deliver' && ok && m.deliverables?.pack) ensureDirectorPack(project);
        const finalData = project.nodes.find((n) => n.type === 'final')?.data || {};
        const extra = stepId === 'deliver'
          ? (finalData.film?.isRealVideo ? ' · ComfyUI 真实成片 MP4 已生成'
            : finalData.film?.source === 'preview-frames' ? ' · 关键帧预览成片（非 AI 视频，验收降级）'
              : ` · 未产出成片：${String(finalData.filmNote || '真实 AI 片段未齐').slice(0, 90)}`)
          : '';
        const tk = summary.tokens;
        const tokNote = tk?.total ? ` · ${(tk.total >= 1000 ? (tk.total / 1000).toFixed(1) + 'k' : tk.total)} tokens` : '';
        const fbNote = summary.fallbacks ? ` · LLM 回退 Mock ${summary.fallbacks} 次` : '';
        finishStep(m, stepId, {
          ok,
          note: ok
            ? `${summary.nodeCount} 节点 · ${summary.waves} 波 · ${(summary.durationMs / 1000).toFixed(1)}s${tokNote}${fbNote}${extra}`
            : `编排${summary.status === 'cancelled' ? '已取消' : '失败'}，失败节点 ${summary.failed} 个${tokNote}${fbNote}`,
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
