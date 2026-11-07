// 六步任务执行器（业务层，从 API 路由下沉）+ 管理状态广播
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
  if (isRunning(id)) return { ok: false, error: '该项目已有运行中的任务' };

  // `all` = 所有未完成的步骤：骨架项目会从第 ① 步（上传小说）开始，
  // 已完成的 auto 步骤（①② 在上传后已 done）自动跳过
  const ids = body.all
    ? STEPS.filter((s) => m.steps?.find((x) => x.id === s.id)?.status !== 'done').map((s) => s.id)
    : [body.stepId || stepProgress(m).currentId];
  const executed = [];

  for (const stepId of ids) {
    const def = STEP_BY_ID[stepId];
    if (!def) return { ok: false, error: `未知步骤：${stepId}` };
    const state = () => m.steps.find((s) => s.id === stepId);
    if (!body.force && state()?.status === 'done') continue;

    startStep(m, stepId);
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
        if (stepId === 'deliver' && ok && m.deliverables?.pack) {
          const finalNode = project.nodes.find((n) => n.type === 'final');
          if (finalNode && !finalNode.data?.directorPack?.file) {
            const cfg = resolveComfyConfig(project);
            const info = exportDirectorPack(project, cfg);
            const pack = {
              url: info.url, file: info.file, filename: info.filename, bytes: info.bytes,
              shotCount: info.shotCount, fileCount: info.fileCount, target: info.format,
              groups: info.groups, note: info.note,
            };
            finalNode.data = { ...(finalNode.data || {}), directorPack: pack };
            emit('node:data', { projectId: id, nodeId: finalNode.id, patch: { directorPack: pack } });
          }
        }
        const finalData = project.nodes.find((n) => n.type === 'final')?.data || {};
        const extra = stepId === 'deliver'
          ? (finalData.film?.file ? ' · 成片 MP4 已生成' : ' · Mock 为帧序列预览，接入 ComfyUI 视频工作流后产出真实 MP4')
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
