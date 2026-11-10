/* ============================================================================
 * 剧集详情域：单个剧集的原文 / 剧本 / 角色 / 宫格图 / 资源链接图 / 导出 / 生成
 *
 * 所有状态都写在 project.management.episodes[no-1]，走 saveProject 全量落盘；
 * 每次变更广播 `episode:update` SSE，前端详情页面可无刷新联动。
 * ==========================================================================*/
import { json, readBody, streamAsset, assetFile, downloadText } from '../http.mjs';
import { MATCH } from './match.mjs';
import { loadProject, saveProject } from '../../core/store.mjs';
import { ensureManagement, stepProgress } from '../../core/project-steps.mjs';
import { emit } from '../../core/events.mjs';
import { resolveComfyConfig, hasWorkflowFor } from '../../core/comfy-config.mjs';
import { appSettingsSummary } from '../../core/app-settings.mjs';
import { buildEpisodeGraph, matchEpisodeCharacters, reconstructEpisodeText, splitSegments } from '../../core/episode-model.mjs';
import {
  ensureEpisodeBody, generateEpisodeScript, saveEpisodeScript, generateEpisodeGrids, generateSegmentGrid,
  exportEpisodePack, generateEpisodeVideo, collectProjectKeyframes, collectProjectFrames,
} from '../../core/episode-service.mjs';
import { describeStoryboardSettings, resolveStoryboardSettings } from '../../core/storyboard-settings.mjs';
import { scriptToMarkdown, scriptsToMarkdown, scriptsCoverage } from '../../core/episode-script.mjs';
import { runEpisodeStep, runEpisodeSteps, EPISODE_STEP_BY_ID } from '../../core/episode-runner.mjs';

function findEpisode(m, no) {
  const target = Number(no);
  const list = Array.isArray(m.episodes) ? m.episodes : [];
  return list.find((e) => Number(e.no) === target) || null;
}

function fail(res, message, status = 400) {
  return json(res, { ok: false, error: message }, status), true;
}

function commit(project, ep, reason) {
  saveProject(project);
  emit('episode:update', { projectId: project.id, episodeNo: ep.no, reason });
  emit('state', { projectId: project.id, project, reason: `episode:${reason}` });
}

export async function handleEpisodes(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  const scriptsMatch = pathname.match(MATCH.episodeScripts);
  const stepBatchMatch = pathname.match(MATCH.episodeStepBatch);
  const scriptExportMatch = pathname.match(MATCH.episodeScriptExport);
  const projectExportMatch = pathname.match(MATCH.projectScriptExport);
  const itemMatch = pathname.match(MATCH.episodeItem);
  const actionMatch = pathname.match(MATCH.episodeAction);
  if (!scriptsMatch && !stepBatchMatch && !scriptExportMatch && !projectExportMatch && !itemMatch && !actionMatch) return false;

  const id = decodeURIComponent((scriptsMatch || stepBatchMatch || scriptExportMatch || projectExportMatch || itemMatch || actionMatch)[1]);
  const project = loadProject(id);
  if (!project) return fail(res, '项目不存在', 404);
  const m = ensureManagement(project);
  if (m.kind !== 'novel') return fail(res, '只有漫剧创作项目才有剧集详情');
  // 项目生效配置：全局 + 项目覆盖，图片规格（宽高/步数/CFG）由画幅自动决定
  // 生成请求可在 body 带 interfaceId 临时指定本次接口；挂到 cfg 供 createProviders 统一解析。
  let cfg = resolveComfyConfig(project);
  const cfgForRequest = (id) => (String(id || '').trim()
    ? { ...cfg, requestInterfaceId: String(id).trim().slice(0, 60) } : cfg);
  const log = (level, message) => emit('log', { projectId: id, level, message: `剧集 · ${message}` });

  /* ---------- 导出全项目剧本（Markdown，含覆盖率抬头） ---------- */
  if (projectExportMatch) {
    if (method !== 'GET') return fail(res, '需要 GET', 405);
    const coverage = scriptsCoverage(m.episodes || []);
    if (!coverage.written) return fail(res, '还没有任何一集生成剧本', 404);
    return downloadText(res, scriptsToMarkdown(project, m),
      `lingximanju-scripts-${new Date().toISOString().slice(0, 10)}.md`), true;
  }

  /* ---------- 批量生成本项目分集剧本 ---------- */
  if (scriptsMatch) {
    if (method !== 'POST') return fail(res, '需要 POST', 405);
    const list = m.episodes || [];
    if (!list.length) return fail(res, '尚未拆分剧集');
    const body = await readBody(req);
    // nos：只跑指定的几集（工作台勾选 / 单季批量）；onlyMissing：跳过已有剧本的集（「补齐缺失」）
    const nos = Array.isArray(body.nos) && body.nos.length
      ? new Set(body.nos.map((n) => Number(n)))
      : null;
    const onlyMissing = body.onlyMissing === true;
    const force = body.force === true;
    // 已定稿的集四段产物锁定：批量生成剧本一律跳过，撤销定稿后才可再改
    const targets = list.filter((ep) => (!nos || nos.has(Number(ep.no)))
      && (!onlyMissing || !ep.script || force) && !ep.finalized?.at);
    if (!targets.length) {
      return json(res, {
        ok: true, generated: 0, skipped: list.length, results: [],
        message: onlyMissing ? '全部剧集都已有剧本，无需补齐' : '没有匹配的剧集',
      }), true;
    }
    const done = [];
    const failed = [];
    for (const ep of targets) {
      try {
        await generateEpisodeScript(project, m, ep, { log, modelId: body.modelId });
        done.push(ep.no);
      } catch (err) {
        failed.push({ no: ep.no, error: err.message });
        log('error', `第 ${ep.no} 集剧本生成失败：${err.message}`);
      }
      emit('episode:progress', {
        projectId: id, done: done.length + failed.length, total: targets.length,
        episodeNo: ep.no, kind: 'script', failed: failed.length,
      });
    }
    if (done.length) commit(project, targets[0], 'scripts');
    if (!done.length) return json(res, { ok: false, error: `全部 ${failed.length} 集剧本生成失败`, results: failed }, 502), true;
    return json(res, {
      ok: true, generated: done.length, failed: failed.length,
      skipped: list.length - targets.length, nos: done, results: failed,
      message: `已生成 ${done.length} 集剧本`
        + (failed.length ? ` · ${failed.length} 集失败` : '')
        + (list.length - targets.length ? ` · ${list.length - targets.length} 集跳过` : ''),
    }), true;
  }

  /* ---------- 分集制作批量执行（第⑤⑥⑦步按集补齐） ---------- */
  if (stepBatchMatch) {
    if (method !== 'POST') return fail(res, '需要 POST', 405);
    const body = await readBody(req);
    const stepId = String(body.stepId || '');
    if (!EPISODE_STEP_BY_ID.has(stepId)) {
      return fail(res, `未知分集步骤：${stepId || '（空）'}（可用：context / storyboard / deliver）`);
    }
    try {
      const out = await runEpisodeSteps(project, body.nos, stepId, {
        force: body.force === true,
        comfy: body.comfy === true,
        stitchOnly: body.stitchOnly === true,
        modelId: body.modelId || '',
        // 交付步骤需要完整 ComfyUI 配置（含本次指定的接口档案），否则逐格视频拿不到工作流
        ...(stepId === 'deliver' ? { cfg: cfgForRequest(body.interfaceId), interfaceId: String(body.interfaceId || '').slice(0, 60) } : {}),
        log,
      });
      return json(res, {
        ok: out.ok, message: out.message, results: out.results,
        episodes: m.episodes,
      }, out.ok ? 200 : 207), true;
    } catch (err) { return fail(res, err.message, 409); }
  }

  const no = Number((itemMatch || actionMatch || scriptExportMatch)[2]);
  const ep = findEpisode(m, no);
  if (!ep) return fail(res, `第 ${no} 集不存在`, 404);
  const action = actionMatch ? actionMatch[3] : null;

  /* ---------- 导出单集剧本（Markdown） ---------- */
  if (scriptExportMatch) {
    if (method !== 'GET') return fail(res, '需要 GET', 405);
    if (!ep.script) return fail(res, `第 ${no} 集还没有剧本，请先生成`, 404);
    return downloadText(res, scriptToMarkdown(ep.script, { episodeNo: no }),
      `lingximanju-ep${String(no).padStart(2, '0')}-script.md`), true;
  }

  /* ---------- 剧集详情 ---------- */
  if (itemMatch && method === 'GET') {
    ensureEpisodeBody(project, ep);
    const text = ep.text || reconstructEpisodeText(project, ep);
    if (!ep.text && text) ep.text = text;
    if (!Array.isArray(ep.segments) || !ep.segments.length) ep.segments = splitSegments(text, 6, ep.no);
    const eps = m.episodes || [];
    const idx = eps.indexOf(ep);
    const allChars = m.characters || [];
    const ids = Array.isArray(ep.characterIds) && ep.characterIds.length ? ep.characterIds : matchEpisodeCharacters(ep, allChars);
    return json(res, {
      ok: true,
      project: { id: project.id, name: project.name, style: project.settings?.style || 'cinematic' },
      episode: ep,
      chapters: (m.chapters || []).filter((c) => Number(c.episodeNo) === no),
      sources: m.sources || [],
      characters: allChars, involvedCharacterIds: ids,
      graph: buildEpisodeGraph(project, m, ep),
      neighbors: {
        prev: idx > 0 ? { no: eps[idx - 1].no, title: eps[idx - 1].title, hasScript: Boolean(eps[idx - 1].script) } : null,
        next: idx >= 0 && idx < eps.length - 1 ? { no: eps[idx + 1].no, title: eps[idx + 1].title, hasScript: Boolean(eps[idx + 1].script) } : null,
      },
      episodeCount: eps.length,
      scriptCoverage: scriptsCoverage(eps),
      progress: stepProgress(m),
      config: {
        llmConfigured: appSettingsSummary().llm.configured || (project.settings?.provider === 'openai' && !!project.settings?.apiKey),
        comfyVideo: Boolean(cfg.enabled && hasWorkflowFor(cfg, 'video')),
        comfyImage: Boolean(cfg.enabled && hasWorkflowFor(cfg, 'image')),
        comfyBaseUrl: cfg.baseUrl || '',
        keyframes: collectProjectKeyframes(project).length,
      },
    }), true;
  }

  /* ---------- 保存人工编辑的本集剧本（PUT /episodes/:no/script 或 /episodes/:no） ---------- */
  if ((action === 'script' || itemMatch) && method === 'PUT') {
    if (action === 'script' && ep.finalized?.at) {
      return fail(res, `第 ${no} 集已定稿：请在工作台撤销定稿后再修改本集剧本`, 409);
    }
    const body = await readBody(req);
    try {
      const script = saveEpisodeScript(project, m, ep, body.script || body);
      commit(project, ep, 'script-edit');
      return json(res, {
        ok: true, script,
        message: `第 ${no} 集剧本已保存 · ${script.stats.sceneCount} 场 · ${script.stats.lineCount} 行`,
      }), true;
    } catch (err) { return fail(res, err.message, 400); }
  }

  if (!action) return fail(res, '不支持的方法', 405);
  if (method !== 'POST' && !(action === 'director-pack' && method === 'GET') && !(action === 'video' && method === 'GET') && !(action === 'film' && method === 'GET')) {
    return fail(res, '需要 POST', 405);
  }
  const body = (method === 'POST') ? await readBody(req) : {};
  const requestInterfaceId = String(body.interfaceId || '').trim().slice(0, 60);
  cfg = cfgForRequest(body.interfaceId);

  /* ---------- 生成本集剧本 ---------- */
  if (action === 'script') {
    if (ep.finalized?.at) {
      return fail(res, `第 ${no} 集已定稿：请在工作台撤销定稿后再生成 / 重写本集剧本`, 409);
    }
    try {
      const script = await generateEpisodeScript(project, m, ep, { log, modelId: body.modelId });
      commit(project, ep, 'script');
      return json(res, {
        ok: true, script,
        message: (script.source === 'llm' ? '已由大模型生成本集剧本' : '未配置大模型，已用内置模板生成本集剧本（设置 → 模型可切换）')
          + ` · ${script.stats.sceneCount} 场 · ${script.stats.dialogueCount} 句对白`,
      }), true;
    } catch (err) { return fail(res, err.message, 502); }
  }

  /* ---------- 生成宫格图：整集或指定一段 ---------- */
  if (action === 'grids') {
    try {
      const out = body.segmentNo
        ? { segment: (await generateSegmentGrid(project, m, ep, Number(body.segmentNo), {
          cfg, log, mode: body.mode === 'comfy' ? 'comfy' : 'local',
          frames: body.mode === 'comfy' ? [] : collectProjectFrames(project),
        })).segment, generated: 1 }
        : await generateEpisodeGrids(project, m, ep, { cfg, log });
      commit(project, ep, 'grids');
      const desc = describeStoryboardSettings(resolveStoryboardSettings(project));
      return json(res, {
        ok: true, segments: ep.segments, generated: out.generated,
        layout: out.layout || null, cells: out.cells || null,
        message: `已生成 ${out.generated} 张分镜板（${desc}）${out.keyframeCount ? ` · 复用画布关键帧 ${out.keyframeCount} 张` : ''}`,
      }), true;
    } catch (err) { return fail(res, err.message, 502); }
  }

  /* ---------- 本集角色：重新识别 / 手动关联 ---------- */
  if (action === 'characters') {
    if (Array.isArray(body.characterIds)) {
      const valid = new Set((m.characters || []).map((c) => c.id));
      ep.characterIds = body.characterIds.filter((x) => valid.has(String(x))).slice(0, 12);
    } else {
      ensureEpisodeBody(project, ep);
      ep.characterIds = matchEpisodeCharacters(ep, m.characters || []);
    }
    ep.updatedAt = Date.now();
    commit(project, ep, 'characters');
    return json(res, { ok: true, characterIds: ep.characterIds, message: `本集已关联 ${ep.characterIds.length} 位角色` }), true;
  }

  /* ---------- 本集导演包：POST 生成 / GET 下载 ---------- */
  if (action === 'director-pack') {
    if (method === 'POST') {
      try {
        ensureEpisodeBody(project, ep);
        const info = exportEpisodePack(project, m, ep, cfg);
        ep.pack = { url: info.url, file: info.file, filename: info.filename, bytes: info.bytes, shotCount: info.shotCount, at: Date.now() };
        commit(project, ep, 'pack');
        return json(res, { ok: true, ...info, message: `第 ${no} 集导演包已生成 · ${info.fileCount} 个文件` }), true;
      } catch (err) { return fail(res, `导演包生成失败：${err.message}`, 502); }
    }
    const info = ep.pack?.file && assetFile(ep.pack.file) ? ep.pack : exportEpisodePack(project, m, ep, cfg);
    return streamAsset(res, info.file, info.filename || `episode-${no}.zip`, 'application/zip'), true;
  }

  /* ---------- 本集视频：POST 调本地 ComfyUI / GET 下载 ---------- */
  if (action === 'video') {
    if (method === 'POST') {
      try {
        const video = await generateEpisodeVideo(project, m, ep, cfg, { log, duration: body.duration });
        commit(project, ep, 'video');
        return json(res, { ok: true, video, message: `第 ${no} 集已由本地 ComfyUI 生成视频片段` }), true;
      } catch (err) { return fail(res, err.message, 502); }
    }
    if (!ep.video?.file) return fail(res, '本集尚未生成视频，请先点击「调用本地 ComfyUI 生成」', 404);
    return streamAsset(res, ep.video.file, `lingximanju-ep${no}.mp4`, 'video/mp4'), true;
  }

  /* ---------- 分集制作：执行本集的一个制作步骤（④角色和上下文 / ⑤分镜与画面 / ⑥视频与交付） ---------- */
  if (action === 'step') {
    if (method !== 'POST') return fail(res, '需要 POST', 405);
    const stepId = String(body.stepId || '');
    if (!EPISODE_STEP_BY_ID.has(stepId)) {
      return fail(res, `未知分集步骤：${stepId || '（空）'}（可用：context / storyboard / deliver）`);
    }
    try {
      const out = await runEpisodeStep(project, no, stepId, {
        force: body.force === true,
        comfy: body.comfy === true,
        stitchOnly: body.stitchOnly === true,
        modelId: body.modelId || '',
        ...(stepId === 'deliver' ? { cfg, interfaceId: requestInterfaceId } : {}),
        log,
      });
      return json(res, {
        ok: out.ok, message: out.message, step: out.step, episode: ep,
      }, out.ok ? 200 : 422), true;
    } catch (err) { return fail(res, err.message, 409); }
  }

  /* ---------- 本集成片：GET 下载 ---------- */
  if (action === 'film') {
    if (!ep.film?.file) return fail(res, '本集还没有成片：请先在「视频与交付」逐格生成视频并拼接', 404);
    return streamAsset(res, ep.film.file, `lingximanju-ep${no}-film.mp4`, 'video/mp4'), true;
  }

  return fail(res, '未知剧集操作', 404);
}
