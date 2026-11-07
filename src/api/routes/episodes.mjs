/* ============================================================================
 * 剧集详情域：单个剧集的原文 / 剧本 / 角色 / 宫格图 / 资源链接图 / 导出 / 生成
 *
 * 所有状态都写在 project.management.episodes[no-1]，走 saveProject 全量落盘；
 * 每次变更广播 `episode:update` SSE，前端详情页面可无刷新联动。
 * ==========================================================================*/
import { json, readBody, streamAsset, assetFile } from '../http.mjs';
import { MATCH } from './match.mjs';
import { loadProject, saveProject } from '../../core/store.mjs';
import { ensureManagement, stepProgress } from '../../core/project-steps.mjs';
import { emit } from '../../core/events.mjs';
import { resolveComfyConfig } from '../../core/comfy-config.mjs';
import { appSettingsSummary } from '../../core/app-settings.mjs';
import { buildEpisodeGraph, matchEpisodeCharacters, reconstructEpisodeText, splitSegments } from '../../core/episode-model.mjs';
import {
  ensureEpisodeBody, generateEpisodeScript, generateEpisodeGrids, generateSegmentGrid,
  exportEpisodePack, generateEpisodeVideo, collectProjectKeyframes,
} from '../../core/episode-service.mjs';

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
  const itemMatch = pathname.match(MATCH.episodeItem);
  const actionMatch = pathname.match(MATCH.episodeAction);
  if (!scriptsMatch && !itemMatch && !actionMatch) return false;

  const id = decodeURIComponent((scriptsMatch || itemMatch || actionMatch)[1]);
  const project = loadProject(id);
  if (!project) return fail(res, '项目不存在', 404);
  const m = ensureManagement(project);
  if (m.kind !== 'novel') return fail(res, '只有漫剧创作项目才有剧集详情');
  // 项目生效配置：全局 + 项目覆盖，图片规格（宽高/步数/CFG）由画幅自动决定
  const cfg = resolveComfyConfig(project);
  const log = (level, message) => emit('log', { projectId: id, level, message: `剧集 · ${message}` });

  /* ---------- 批量生成本项目全部分集剧本 ---------- */
  if (scriptsMatch) {
    if (method !== 'POST') return fail(res, '需要 POST', 405);
    const list = m.episodes || [];
    if (!list.length) return fail(res, '尚未拆分剧集');
    const body = await readBody(req);
    const done = [];
    for (const ep of list) {
      await generateEpisodeScript(project, m, ep, { log, modelId: body.modelId });
      done.push(ep.no);
      emit('episode:progress', { projectId: id, done: done.length, total: list.length, episodeNo: ep.no, kind: 'script' });
    }
    commit(project, list[0], 'scripts');
    return json(res, { ok: true, generated: done.length, message: `已生成 ${done.length} 集剧本` }), true;
  }

  const no = Number((itemMatch || actionMatch)[2]);
  const ep = findEpisode(m, no);
  if (!ep) return fail(res, `第 ${no} 集不存在`, 404);
  const action = actionMatch ? actionMatch[3] : null;

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
        prev: idx > 0 ? { no: eps[idx - 1].no, title: eps[idx - 1].title } : null,
        next: idx >= 0 && idx < eps.length - 1 ? { no: eps[idx + 1].no, title: eps[idx + 1].title } : null,
      },
      episodeCount: eps.length,
      progress: stepProgress(m),
      config: {
        llmConfigured: appSettingsSummary().llm.configured || (project.settings?.provider === 'openai' && !!project.settings?.apiKey),
        comfyVideo: Boolean(cfg.enabled && cfg.videoWorkflow),
        comfyImage: Boolean(cfg.enabled && cfg.imageWorkflow),
        comfyBaseUrl: cfg.baseUrl || '',
        keyframes: collectProjectKeyframes(project).length,
      },
    }), true;
  }

  if (!action) return fail(res, '不支持的方法', 405);
  if (method !== 'POST' && !(action === 'director-pack' && method === 'GET') && !(action === 'video' && method === 'GET')) {
    return fail(res, '需要 POST', 405);
  }
  const body = (method === 'POST') ? await readBody(req) : {};

  /* ---------- 生成本集剧本 ---------- */
  if (action === 'script') {
    try {
      const script = await generateEpisodeScript(project, m, ep, { log, modelId: body.modelId });
      commit(project, ep, 'script');
      return json(res, {
        ok: true, script,
        message: script.source === 'llm' ? '已由大模型生成本集剧本' : '未配置大模型，已用内置模板生成本集剧本（设置 → 模型可切换）',
      }), true;
    } catch (err) { return fail(res, err.message, 502); }
  }

  /* ---------- 生成宫格图：整集或指定一段 ---------- */
  if (action === 'grids') {
    try {
      const out = body.segmentNo
        ? { segment: (await generateSegmentGrid(project, m, ep, Number(body.segmentNo), {
          cfg, log, mode: body.mode === 'comfy' ? 'comfy' : 'local',
          keyframes: body.mode === 'comfy' ? [] : collectProjectKeyframes(project),
        })).segment, generated: 1 }
        : await generateEpisodeGrids(project, m, ep, { cfg, log });
      commit(project, ep, 'grids');
      return json(res, {
        ok: true, segments: ep.segments, generated: out.generated,
        message: `已生成 ${out.generated} 张 3×3 宫格图${out.keyframeCount ? ` · 复用画布关键帧 ${out.keyframeCount} 张` : ''}`,
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

  return fail(res, '未知剧集操作', 404);
}
