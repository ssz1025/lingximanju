// 导演 Agent 域：技能清单 / 项目选择 / 一键跑完最终产物全流程
//
// 与「六步执行」端点的区别：/step 是单步或全量步骤调度，/director/run 是流程型智能体，
// 额外负责原著前置保障、技能能力（设定 / 阐述 / 角色 / 音色）、导演包补齐与最终产物验收。
import { json, readBody } from '../http.mjs';
import { MATCH } from './match.mjs';
import { loadProject, saveProject } from '../../core/store.mjs';
import { emit } from '../../core/events.mjs';
import { isRunning } from '../../core/orchestrator.mjs';
import { ensureManagement, applyManageAction, stepProgress } from '../../core/project-steps.mjs';
import { listDirectorSkills, getDirectorSkill, normalizeDirectorSkillId, SKILL_BY_ID,
  DIRECTOR_CAPABILITIES, planDirectorRun, verifyDirectorDeliverables,
  ensureDirectorState } from '../../core/director-skills.mjs';
import { normalizeStyleId, resolveProjectAesthetic } from '../../core/director-styles.mjs';
import { broadcastMeta } from '../../core/step-runner.mjs';
import { runDirector } from '../../agents/director-agent.mjs';

/** 技能面板 / 验收报告共用的快照，前端不需要再拼一遍状态 */
function snapshot(project) {
  const m = ensureManagement(project);
  const d = ensureDirectorState(m);
  const planned = planDirectorRun({ project, m, skillId: d.skillId });
  // 当前生效的画面风格：styleId 可能由技能推导也可能来自历史数据，统一在这里收敛，
  // 前端据此显示「风格 · 大风国色」与可切换的主色调色板。
  const aesthetic = resolveProjectAesthetic(project);
  return {
    ok: true,
    skills: listDirectorSkills(),
    capabilities: DIRECTOR_CAPABILITIES,
    skillId: d.skillId,
    skill: planned.skill,
    // styleId / paletteKey 落库，刷新后仍能还原风格与主色
    director: {
      skillId: d.skillId, styleId: d.styleId || null, paletteKey: d.paletteKey || null,
      treatment: d.treatment, lastRun: d.lastRun,
    },
    aesthetic,
    plan: planned.plan,
    verification: verifyDirectorDeliverables(project, d.skillId),
    deliverables: { ...(m.deliverables || { video: true, pack: true }) },
    progress: stepProgress(m),
  };
}

export async function handleDirector(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';
  const skillsMatch = pathname.match(MATCH.directorSkills);
  const runMatch = pathname.match(MATCH.directorRun);
  if (!skillsMatch && !runMatch) return false;

  const id = decodeURIComponent((skillsMatch || runMatch)[1]);
  const project = loadProject(id);
  if (!project) return json(res, { error: '项目不存在' }, 404), true;
  const m = ensureManagement(project);
  if (m.kind !== 'novel') {
    return json(res, { error: '导演智能体只作用于小说创作项目' }, 400), true;
  }

  // ---------- 技能清单 + 当前选择 + 运行计划 + 验收快照 ----------
  if (skillsMatch && method === 'GET') {
    return json(res, snapshot(project)), true;
  }

  // ---------- 保存项目级技能选择（不触发制作，只是改策略） ----------
  if (skillsMatch && method === 'POST') {
    const body = await readBody(req);
    // 主色调切换：只改 paletteKey，不动选了哪位导演。
    // 张艺谋 / 王家卫等档案都有一组主色，换色不换风格是独立的一步操作。
    if (body.paletteKey !== undefined) {
      const out = applyManageAction(project, 'director-palette', { paletteKey: body.paletteKey });
      if (!out.ok) return json(res, out, 400), true;
      ensureDirectorState(project.management);
      saveProject(project);
      broadcastMeta(project);
      emit('state', { projectId: id, project, reason: 'director-palette' });
      return json(res, { ...snapshot(project), message: out.message }), true;
    }
    const requested = String(body.skillId || '').trim().toLowerCase();
    // 中文名 / 片名 / 英文写法都先归一（「张艺谋」→ zhangyimou），
    // 但归一后仍要核对用户原本想选的就是这一项，不能把拼错的 id 悄悄换成默认技能。
    const normalized = normalizeDirectorSkillId(requested);
    const skill = getDirectorSkill(normalized);
    const looksKnown = SKILL_BY_ID[requested] || normalizeStyleId(requested);
    if (!looksKnown) return json(res, { error: `未知导演技能：${requested}` }, 400), true;
    // 换导演时主色回到该档案的默认色，避免把上一位导演的主色带过去
    const out = applyManageAction(project, 'director-skill', { skillId: skill.id });
    if (!out.ok) return json(res, out, 400), true;
    ensureDirectorState(project.management);
    saveProject(project);
    broadcastMeta(project);
    emit('state', { projectId: id, project, reason: 'director-skill' });
    return json(res, { ...snapshot(project), message: `已选择「${skill.label}」导演技能` }), true;
  }

  // ---------- 一键跑完最终产物全流程 ----------
  if (runMatch && method === 'POST') {
    if (isRunning(id)) return json(res, { error: '该项目已有运行中的任务，请稍后再启动导演智能体' }, 409), true;
    const body = await readBody(req);
    const skillId = body.skillId ? normalizeDirectorSkillId(body.skillId) : ensureDirectorState(m).skillId;
    try {
      const result = await runDirector({
        project,
        skillId,
        modelId: String(body.modelId || ''),
        idea: String(body.idea || '').slice(0, 600),
        force: body.force === true,
        log: (level, msg) => emit('log', { projectId: id, level, message: msg }),
      });
      if (!result.ok && result.blocked) return json(res, result, 400), true;
      if (result.error && !result.plan) return json(res, { error: result.error }, 502), true;
      return json(res, result, 200), true;
    } catch (err) {
      emit('log', { projectId: id, level: 'error', message: `导演智能体异常：${err.message}` });
      return json(res, { error: `导演智能体执行失败：${err.message}` }, 502), true;
    }
  }

  return json(res, { error: `不支持的请求 ${method} ${pathname}` }, 405), true;
}
