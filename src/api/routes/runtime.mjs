// 短剧成片规格域：读取 / 保存「总时长 + 每片段时长」，并给出片段时间线与验收快照。
//
// 规格本身由 core/runtime-spec.mjs 单点推导，这里只负责持久化与广播：
// 保存后下一次导演全流程 / 六步执行会按新片段数重新分配镜头预算。
import { json, readBody } from '../http.mjs';
import { MATCH } from './match.mjs';
import { loadProject, saveProject } from '../../core/store.mjs';
import { emit } from '../../core/events.mjs';
import { ensureManagement, applyManageAction } from '../../core/project-steps.mjs';
import { DEFAULT_RUNTIME, normalizeRuntimeSpec, resolveRuntimeSpec,
  clipTimeline, verifyRuntime } from '../../core/runtime-spec.mjs';
import { filmPolicyPublic, evaluateFilm } from '../../core/film-policy.mjs';
import { broadcastMeta } from '../../core/step-runner.mjs';

function snapshot(project) {
  const m = ensureManagement(project);
  const spec = resolveRuntimeSpec(project);
  return {
    ok: true,
    defaults: normalizeRuntimeSpec(DEFAULT_RUNTIME),
    spec,
    timeline: clipTimeline(spec),
    verification: verifyRuntime(project, spec),
    deliverables: { ...(m.deliverables || { video: true, pack: true }) },
    filmPolicies: filmPolicyPublic(),
    filmReality: evaluateFilm({
      project, film: (project.nodes || []).find((n) => n.type === 'final')?.data?.film || null,
      policy: spec.filmPolicy, clipCount: spec.clipCount,
    }),
  };
}

export async function handleRuntime(req, res, url) {
  const match = url.pathname.match(MATCH.runtime);
  if (!match) return false;
  const method = req.method || 'GET';
  const id = decodeURIComponent(match[1]);
  const project = loadProject(id);
  if (!project) return json(res, { error: '项目不存在' }, 404), true;
  const m = ensureManagement(project);
  if (m.kind !== 'novel') {
    return json(res, { error: '短剧时长规格只作用于小说创作项目' }, 400), true;
  }

  if (method === 'GET') return json(res, snapshot(project)), true;

  if (method === 'POST') {
    const body = await readBody(req);
    // 明确拒绝非法数值，不静默回落到默认，避免用户以为保存成功
    for (const key of ['totalSeconds', 'clipSeconds', 'fps']) {
      if (body[key] === undefined) continue;
      const n = Number(body[key]);
      if (!Number.isFinite(n) || n <= 0) {
        return json(res, { error: `${key} 必须是正数` }, 400), true;
      }
    }
    // 只提交本次真正给出的字段：undefined 不能用展开覆盖已有设置
    const patch = {};
    for (const key of ['totalSeconds', 'clipSeconds', 'fps', 'enabled', 'filmPolicy']) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (body.filmPolicy !== undefined && !['real', 'preview'].includes(String(body.filmPolicy))) {
      return json(res, { error: 'filmPolicy 只能是 real（真实 AI 视频）或 preview（关键帧预览）' }, 400), true;
    }
    const out = applyManageAction(project, 'runtime', patch);
    if (!out.ok) return json(res, out, 400), true;
    saveProject(project);
    broadcastMeta(project);
    emit('state', { projectId: id, project, reason: 'runtime' });
    return json(res, { ...snapshot(project), message: out.message }), true;
  }

  return json(res, { error: `不支持的请求 ${method} ${url.pathname}` }, 405), true;
}
