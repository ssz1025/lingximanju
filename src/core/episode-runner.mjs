/* ============================================================================
 * 按集步骤执行器（分集制作）：分季分集之后，每一集都有独立的 ④⑤⑥⑦ 四段任务。
 * 本文件负责 ⑤角色和上下文 / ⑥分镜与画面 / ⑦视频与交付 三段；④ 剧本由
 * episodes 域的 script 接口生成，四段完成状态由 project-model.episodeStagesDone 统一判定。
 *
 * 顺序制作：默认第一季第一集，四段完成后在工作台「定稿」（ep.finalized），
 * 自动进入同季下一集，本季做完进入下一季；已定稿集在这里被拒绝执行，
 * 防止任何调用方绕过界面覆盖定稿产物。
 *
 * 与项目级六步状态机的关系：
 *   - 项目级 m.steps[] 仍是全项目口径（demo / 骨架项目 / 导演全流程）；
 *   - 分集制作的每集进度记在 episode record 自己身上：ep.steps[stepId] =
 *     { status, note, startedAt, durationMs, runs, finishedAt }，
 *     工作台第④⑤⑥⑦步面板与剧集详情页都读这一份，互不覆盖。
 *
 * 每步内容（全部复用既有按集产物链路，不另起炉灶）：
 *   context    本集出场角色对账（缺失者补进全局角色库）+ 本集剧本（上下文骨架）
 *   storyboard 分段确认 + 本集分镜板逐段补齐（可选 ComfyUI 逐格出图）
 *   deliver    逐格视频片段 + 拼接本集成片 MP4 + 单集导演包
 *
 * 「切换剧集后后续步骤完全独立」的边界：剧本 / 出场角色关联 / 分镜 / 视频成片
 * 都记在各自 ep 上，互不覆盖；唯一例外是 management.characters（角色设定与定妆图），
 * 它是全项目共享资源——已存在则沿用，同名角色直接复用，切集 / 定稿都不重抽全书、
 * 不每集建一份；但每集会做一次「出场角色对账」，本集新出现、全局库没有的人物会
 * 增量补进这份共享角色库，避免中后集登场的人物永远缺设定与定妆图。
 * ==========================================================================*/
import { emit } from './events.mjs';
import { saveProject } from './store.mjs';
import { isRunning } from './orchestrator.mjs';
import { ensureManagement } from './project-steps.mjs';
import { resolveComfyConfig, hasWorkflowFor } from './comfy-config.mjs';
import { extractProjectCharacters, ensureProjectCharactersForEpisode } from '../agents/character-agent.mjs';
import { mergeExtracted } from './characters.mjs';
import { matchEpisodeCharacters } from './episode-model.mjs';
import {
  ensureEpisodeBody, generateEpisodeScript, generateEpisodeGrids, exportEpisodePack,
} from './episode-service.mjs';
import { generateEpisodeCellVideos, stitchEpisodeFilm, episodeFilmSummary } from './episode-film.mjs';
import { describeStoryboardSettings } from './storyboard-settings.mjs';

/** 按集步骤定义：no 与工作台第⑤⑥⑦步对齐（④ 剧本走 script 接口，不在此处） */
export const EPISODE_STEPS = [
  { id: 'context', no: 5, title: '角色和上下文' },
  { id: 'storyboard', no: 6, title: '分镜与画面' },
  { id: 'deliver', no: 7, title: '视频与交付' },
];
export const EPISODE_STEP_BY_ID = new Map(EPISODE_STEPS.map((s) => [s.id, s]));

/* ------------------------------ 每集步骤状态 ------------------------------ */

function epStepState(ep, stepId) {
  if (!ep.steps || typeof ep.steps !== 'object') ep.steps = {};
  if (!ep.steps[stepId] || typeof ep.steps[stepId] !== 'object') {
    ep.steps[stepId] = { status: 'pending', runs: 0, note: '' };
  }
  return ep.steps[stepId];
}

function startEpStep(ep, stepId) {
  const s = epStepState(ep, stepId);
  s.status = 'running';
  s.startedAt = Date.now();
  s.runs = (Number(s.runs) || 0) + 1;
  s.note = '';
  return s;
}

function finishEpStep(ep, stepId, ok, note) {
  const s = epStepState(ep, stepId);
  s.status = ok ? 'done' : 'error';
  s.note = String(note || '');
  s.durationMs = Date.now() - (Number(s.startedAt) || Date.now());
  s.finishedAt = Date.now();
  return s;
}

/** 某集某步当前状态（前端徽标用；未跑过返回 pending） */
export function episodeStepStatus(ep, stepId) {
  const s = ep?.steps?.[stepId];
  return s && typeof s === 'object' ? { ...s } : { status: 'pending', runs: 0, note: '' };
}

/* ------------------------------ 各步实现 ------------------------------ */

/**
 * ④ 角色和上下文：出场角色确认 + 本集剧本
 *
 * 角色库是「按集任务」里唯一的例外：它挂在 management.characters 上，属于全项目，
 * 不为每一集各建一份。已有角色不重抽（重提取是项目级手动动作）；只有角色库为空时，
 * 才在首次执行时抽一次全书角色，之后所有剧集共用这一份。
 *
 * 每集独立的只是「本集出场哪几位」(ep.characterIds)。本步每次执行都会做一次
 * 「本集出场角色对账」：本集原文 / 剧本里出现、但全局角色库里没有的人物，
 * 会就地生成角色卡并补进全局库（见 agents/character-agent.ensureProjectCharactersForEpisode），
 * 再回写本集名单。这样中后集新登场的人物不会永远缺设定 / 缺定妆图，
 * 又不破坏「角色设定与定妆图全项目共享」的边界。
 */
async function runEpisodeContext(project, m, ep, opts = {}) {
  const log = opts.log || (() => {});
  ensureEpisodeBody(project, ep);
  let charNote = '';
  if (!Array.isArray(m.characters) || !m.characters.length) {
    const r = await extractProjectCharacters({
      project, m, modelId: opts.modelId || '',
      log: (level, msg) => log(level, msg),
      signal: opts.signal,
    });
    if (!r.ok) throw new Error(r.error || '角色提取失败');
    const merged = mergeExtracted(m.characters || [], r.extracted, { source: r.source });
    m.characters = merged.characters;
    charNote = `首次提取全书角色 ${merged.characters.length} 位（${r.message}）`;
    log('info', `第 ${ep.no} 集 · ${charNote}，之后所有剧集沿用`);
  } else {
    // 已存在 → 沿用，绝不重抽全书（即使 opts.force 要求重做本集上下文）
    charNote = `沿用项目角色库 ${m.characters.length} 位（不重新提取）`;
    log('info', `第 ${ep.no} 集 · ${charNote}`);
  }
  // 本集出场角色对账：只补「本集出现但全局库没有」的人，仍写入全项目角色库；
  // 已有名单（含用户手动关联）只追加新入库角色，不被自动匹配覆盖。
  const ensured = await ensureProjectCharactersForEpisode({
    project, m, ep, modelId: opts.modelId || '',
    log: (level, msg) => log(level, msg),
    signal: opts.signal,
  });
  if (ensured.ok) {
    charNote = [charNote, ensured.message].filter(Boolean).join(' · ');
    log('info', `第 ${ep.no} 集 · ${ensured.message}`);
    for (const note of ensured.notes || []) log('info', `第 ${ep.no} 集 · ${note}`);
  } else {
    // 对账失败不应让整步失败：退回旧的姓名匹配，并在 note 里如实写明
    charNote = `${charNote} · 本集角色对账未完成（${ensured.message || '未知原因'}），已按姓名匹配`;
    log('warn', `第 ${ep.no} 集 · 本集角色对账未完成：${ensured.message || '未知原因'}`);
    if (!Array.isArray(ep.characterIds) || !ep.characterIds.length) {
      ep.characterIds = matchEpisodeCharacters(ep, m.characters || []);
    }
  }
  const scriptExisted = Boolean(ep.script);
  if (!ep.script || opts.force) {
    await generateEpisodeScript(project, m, ep, { log, modelId: opts.modelId || '' });
  }
  const cast = (m.characters || []).filter((c) => (ep.characterIds || []).includes(c.id));
  const sc = ep.script || {};
  return `出场角色 ${cast.length} 位（${cast.slice(0, 3).map((c) => c.name).join('、')}${cast.length > 3 ? '…' : ''}） · ${scriptExisted && !opts.force ? '剧本沿用已有' : '剧本已生成'} · ${(sc.scenes || []).length} 场${sc.source ? `（${sc.source === 'llm' ? '大模型' : sc.source === 'manual' ? '人工编辑' : '内置模板'}）` : ''} · ${charNote}`;
}

/** ⑤ 分镜与画面：本集分镜板逐段补齐（可选 ComfyUI 逐格出图） */
async function runEpisodeStoryboard(project, m, ep, opts = {}) {
  const log = opts.log || (() => {});
  ensureEpisodeBody(project, ep);
  if (!Array.isArray(ep.segments) || !ep.segments.length) {
    throw new Error('本集没有原文分段：请先在项目工作台重新分集');
  }
  const out = await generateEpisodeGrids(project, m, ep, {
    cfg: opts.cfg || {},
    log,
    mode: opts.comfy ? 'comfy' : undefined,
  });
  const realCells = (ep.segments || []).flatMap((s) => s.cells || [])
    .filter((c) => c.url && !/\.svg(\?|$)/i.test(String(c.url))).length;
  return `${out.generated}/${(ep.segments || []).length} 段分镜板（${describeStoryboardSettings(out.settings || {})}） · 真实画面格 ${realCells} 格${opts.comfy ? ' · ComfyUI 逐格补图' : ''}`;
}

/** ⑥ 视频与交付：逐格视频 → 本集成片 → 单集导演包 */
async function runEpisodeDeliver(project, m, ep, opts = {}) {
  const log = opts.log || (() => {});
  const baseCfg = opts.cfg || {};
  // 请求级「本次接口」：路由既可以放在 cfg.requestInterfaceId，也可以单独放 opts.interfaceId
  const cfg = (opts.interfaceId && !baseCfg.requestInterfaceId)
    ? { ...baseCfg, requestInterfaceId: String(opts.interfaceId).slice(0, 60) } : baseCfg;
  let clips = { generated: 0, skipped: 0, total: 0, failed: [] };
  if (opts.stitchOnly !== true) {
    clips = await generateEpisodeCellVideos(project, m, ep, cfg, {
      force: opts.force === true,
      log,
      signal: opts.signal,
      onProgress: (p) => emit('episode:progress', {
        projectId: project.id, episodeNo: ep.no, kind: 'cellvideo', ...p,
      }),
    });
  }
  const stitched = stitchEpisodeFilm(project, m, ep, {});
  if (!stitched.ok) throw new Error(stitched.message);
  let packNote = '导演包未生成';
  if (m.deliverables?.pack !== false) {
    try {
      const info = exportEpisodePack(project, m, ep, cfg);
      ep.pack = {
        url: info.url, file: info.file, filename: info.filename,
        bytes: info.bytes, shotCount: info.shotCount, at: Date.now(),
      };
      packNote = `导演包 ${info.fileCount} 文件`;
    } catch (err) {
      log('warn', `第 ${ep.no} 集导演包生成失败：${err.message}`);
      packNote = `导演包失败（${err.message}）`;
    }
  }
  const f = stitched.film;
  return `片段 ${clips.generated + clips.skipped}/${clips.total}（失败 ${clips.failed.length}） · 成片 ${f.duration}s · ${f.width}×${f.height} · ${packNote}`;
}

const RUNNERS = {
  context: runEpisodeContext,
  storyboard: runEpisodeStoryboard,
  deliver: runEpisodeDeliver,
};

/** 每步执行前预检：缺上游时直接给出「先做哪一步」，不空跑 */
function episodePreflight(project, m, ep, stepId, opts = {}) {
  if (stepId === 'context') {
    if (!String(m?.source?.text || '').trim() && !String(ep?.text || '').trim()
      && !String(ep?.summary || '').trim()) {
      return '本集没有原文：请先完成第①②步（上传小说、分集拆解）';
    }
  }
  if (stepId === 'storyboard') {
    ensureEpisodeBody(project, ep);
    if (!Array.isArray(ep.segments) || !ep.segments.length) {
      return '本集没有原文分段：请先在项目工作台重新分集';
    }
  }
  if (stepId === 'deliver') {
    // stitchOnly（只拼接已有片段）不需要 ComfyUI：ffmpeg 本地拼接即可
    if (opts.stitchOnly !== true) {
      const cfg = resolveComfyConfig(project);
      if (!cfg.enabled) return '本地 ComfyUI 未启用：设置 → 本地 ComfyUI 勾选「启用」后再执行本集交付';
      if (!hasWorkflowFor(cfg, 'video')) return '尚未导入视频工作流：设置 → 本地 ComfyUI → 导入视频工作流 JSON';
    }
    ensureEpisodeBody(project, ep);
    const shootable = (ep.segments || []).flatMap((s) => s.cells || [])
      .filter((c) => c.url && !/\.svg(\?|$)/i.test(String(c.url))).length;
    if (!shootable) {
      return '本集还没有带真实画面的分镜格：请先执行本集「分镜与画面」出图，再执行视频与交付';
    }
  }
  return '';
}

/* ------------------------------ 对外入口 ------------------------------ */

function commit(project, ep, reason) {
  saveProject(project);
  emit('episode:update', { projectId: project.id, episodeNo: ep.no, reason });
  emit('state', { projectId: project.id, project, reason: `episode-step:${reason}` });
}

const activeEpisodeRuns = new Set();

/**
 * 执行某一集的一个制作步骤。
 * @param {object} opts { force?, comfy?, modelId?, log?, signal? }
 * @returns {Promise<{ok:boolean, step:object, message:string}>}
 */
export async function runEpisodeStep(project, no, stepId, opts = {}) {
  const def = EPISODE_STEP_BY_ID.get(String(stepId));
  if (!def) throw new Error(`未知分集步骤：${stepId}（可用：${EPISODE_STEPS.map((s) => s.id).join(' / ')}）`);
  const m = ensureManagement(project);
  const ep = (m.episodes || []).find((e) => Number(e.no) === Number(no));
  if (!ep) throw new Error(`第 ${no} 集不存在`);
  // 定稿 = 本集 ④⑤⑥⑦ 四段产物锁定，任何按集执行都不能绕过工作台偷偷覆盖
  if (ep.finalized?.at) {
    return { ok: false, step: episodeStepStatus(ep, def.id), message: `第 ${ep.no} 集已定稿：请在工作台撤销定稿后再执行本集「${def.title}」` };
  }
  if (isRunning(project.id)) throw new Error('项目正在运行完整流水线，请等它结束或先停止，再执行分集制作');
  if (activeEpisodeRuns.has(project.id)) throw new Error('本集已有执行中的制作任务，请稍候');
  activeEpisodeRuns.add(project.id);
  const log = opts.log || ((level, message) => emit('log', { projectId: project.id, level, message: `分集 · ${message}` }));
  const state = epStepState(ep, def.id);
  try {
    const blocked = episodePreflight(project, m, ep, def.id, opts);
    if (blocked) {
      finishEpStep(ep, def.id, false, blocked);
      commit(project, ep, `${def.id}:blocked`);
      return { ok: false, step: episodeStepStatus(ep, def.id), message: blocked };
    }
    startEpStep(ep, def.id);
    commit(project, ep, `${def.id}:start`);
    log('info', `第 ${ep.no} 集 ·「${def.title}」开始`);
    const t0 = Date.now();
    try {
      const note = await RUNNERS[def.id](project, m, ep, opts);
      finishEpStep(ep, def.id, true, note);
      log('info', `第 ${ep.no} 集 ·「${def.title}」完成 · ${note} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      commit(project, ep, def.id);
      return { ok: true, step: episodeStepStatus(ep, def.id), message: note };
    } catch (err) {
      finishEpStep(ep, def.id, false, err.message);
      log('error', `第 ${ep.no} 集 ·「${def.title}」失败：${err.message}`);
      commit(project, ep, `${def.id}:error`);
      return { ok: false, step: episodeStepStatus(ep, def.id), message: err.message };
    }
  } finally {
    activeEpisodeRuns.delete(project.id);
  }
}

/**
 * 批量按集执行（工作台「按集补齐」）：顺序逐集跑同一步骤，单集失败不阻断后续。
 * @param {object} opts { force?, comfy?, modelId?, log?, signal?, onResult?({no,ok,message}) }
 */
export async function runEpisodeSteps(project, nos, stepId, opts = {}) {
  const def = EPISODE_STEP_BY_ID.get(String(stepId));
  if (!def) throw new Error(`未知分集步骤：${stepId}`);
  const m = ensureManagement(project);
  const wanted = new Set((Array.isArray(nos) ? nos : []).map((n) => Number(n)));
  // 已定稿集不参与批量补齐：前端 nos 已过滤，这里再兜一次，避免其它调用方覆盖定稿产物
  const targets = (m.episodes || []).filter((e) => (!wanted.size || wanted.has(Number(e.no))) && !e.finalized?.at);
  if (!targets.length) return { ok: true, results: [], message: '没有可执行的剧集（可能都已定稿）' };
  if (isRunning(project.id)) throw new Error('项目正在运行完整流水线，请等它结束或先停止，再执行分集制作');
  const results = [];
  const log = opts.log || ((level, message) => emit('log', { projectId: project.id, level, message: `分集 · ${message}` }));
  for (const ep of targets) {
    opts.onResult?.({ no: ep.no, status: 'start' });
    const r = await runEpisodeStep(project, ep.no, stepId, { ...opts, log });
    results.push({ no: ep.no, ok: r.ok, message: r.message });
    emit('episode:progress', {
      projectId: project.id, done: results.length, total: targets.length,
      episodeNo: ep.no, kind: `step:${stepId}`, failed: r.ok ? 0 : 1,
    });
  }
  const done = results.filter((r) => r.ok).length;
  return {
    ok: done > 0, results,
    message: `${def.title}：完成 ${done}/${targets.length} 集${done < targets.length ? `（失败 ${targets.length - done} 集，详见运行日志）` : ''}`,
  };
}

/** 每集制作进度（工作台分集列表 / 剧集详情共用）：三步状态 + 产物摘要 */
export function episodeProductionStatus(ep) {
  return {
    steps: Object.fromEntries(EPISODE_STEPS.map((s) => [s.id, episodeStepStatus(ep, s.id)])),
    ...episodeFilmSummary(ep),
  };
}
