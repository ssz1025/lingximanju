// 系统域：SSE 事件流 / 健康检查 / 启动引导 / 示例原著 / 分集预览
import fs from 'node:fs';
import path from 'node:path';
import { json, readBody } from '../http.mjs';
import { subscribe } from '../../core/events.mjs';
import { listProjects, saveProject, EXAMPLES_DIR } from '../../core/store.mjs';
import { buildTemplate, TEMPLATE_META } from '../../pipelines/templates.mjs';
import { listAgents } from '../../agents/index.mjs';
import { loadComfyConfig, comfySummary } from '../../core/comfy-config.mjs';
import { STEPS } from '../../core/project-steps.mjs';
import { validateNovelInput, novelPreview, mergeNovelFiles } from '../../core/novel.mjs';
import { createProviders } from '../../core/providers.mjs';
import { loadAppSettings, saveAppSettings, appSettingsSummary } from '../../core/app-settings.mjs';

export async function handleSystem(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  if (pathname === '/api/events' && method === 'GET') { subscribe(req, res); return true; }
  if (pathname === '/api/health') return json(res, { ok: true, ts: Date.now() }), true;

  /** 应用级模型配置：启动检查 / 设置弹窗共用；响应永不包含完整 API Key */
  if (pathname === '/api/settings' && method === 'GET') {
    return json(res, { settings: appSettingsSummary(), comfy: comfySummary(loadComfyConfig()) }), true;
  }
  if (pathname === '/api/settings' && (method === 'PUT' || method === 'POST')) {
    const body = await readBody(req);
    const patch = {};
    if (body.llm !== undefined) patch.llm = body.llm;
    if (body.skipConfigCheck !== undefined) patch.skipConfigCheck = body.skipConfigCheck;
    const saved = saveAppSettings(patch);
    return json(res, { ok: true, settings: appSettingsSummary(saved) }), true;
  }

  if (pathname === '/api/bootstrap' && method === 'GET') {
    let projects = listProjects();
    if (!projects.length) {
      const demo = buildTemplate('idea2video');
      saveProject(demo);
      projects = listProjects();
    }
    const active = projects.filter((p) => !p.archived);
    return json(res, {
      projects, templates: TEMPLATE_META, agents: listAgents(),
      recent: projects[0]?.id || null, serverTime: Date.now(),
      comfy: comfySummary(loadComfyConfig()),
      // 启动检查：前端据此判断是否需要弹「首次配置模型」引导框
      settings: appSettingsSummary(),
      steps: STEPS,
      stats: {
        total: projects.length, active: active.length,
        novels: projects.filter((p) => p.kind === 'novel').length,
        done: projects.filter((p) => p.status === 'done').length,
        running: projects.filter((p) => p.status === 'running').length,
        archived: projects.length - active.length,
        favorite: projects.filter((p) => p.favorite).length,
      },
    }), true;
  }

  /** 向导「载入示例小说」：示例文本随仓库自包含，不依赖外部网络 */
  if (pathname === '/api/novel/sample' && method === 'GET') {
    try {
      const text = fs.readFileSync(path.join(EXAMPLES_DIR, 'sample-novel.txt'), 'utf8');
      return json(res, { ok: true, filename: 'sample-novel.txt', text }), true;
    } catch {
      return json(res, { error: '示例小说不存在（examples/sample-novel.txt）' }, 404), true;
    }
  }

  /** 新建项目向导的实时分集预览（不落盘） */
  if (pathname === '/api/novel/preview' && method === 'POST') {
    const body = await readBody(req);
    // 多文件：先合并成一份带文件出处的原著，再走与单文件完全相同的解析 / 分集
    const merged = Array.isArray(body.files) && body.files.length ? mergeNovelFiles(body.files) : null;
    if (merged && !merged.ok) return json(res, { ok: false, message: merged.message }), true;
    const text = merged ? merged.text : body.text;
    const filename = merged ? merged.filename : body.filename;
    const checked = validateNovelInput(text, { filename, split: body.split });
    if (!checked.ok) return json(res, { ok: false, message: checked.message }), true;
    return json(res, {
      ok: true,
      message: merged ? `${merged.message}；${checked.message}` : checked.message,
      preview: novelPreview(checked.novel, checked.episodes),
      sources: merged ? merged.sources : [],
      chapterSources: merged ? merged.chapterSources : [],
    }), true;
  }

  /** 只合并、不落盘：工作台多文件选择后实时显示「文件 → 章节 → 剧集」预估 */
  if (pathname === '/api/novel/merge' && method === 'POST') {
    const body = await readBody(req);
    const merged = mergeNovelFiles(body.files);
    if (!merged.ok) return json(res, { ok: false, message: merged.message }), true;
    const checked = validateNovelInput(merged.text, { filename: merged.filename, split: body.split });
    if (!checked.ok) return json(res, { ok: false, message: checked.message }), true;
    return json(res, {
      ok: true, message: `${merged.message}；${checked.message}`,
      text: merged.text, filename: merged.filename,
      sources: merged.sources, chapterSources: merged.chapterSources,
      preview: novelPreview(checked.novel, checked.episodes),
    }), true;
  }

  /** 设置面板「测试模型连接」：用请求体临时 settings 发一次微型调用，不落盘 */
  if (pathname === '/api/system/llm-test' && method === 'POST') {
    const body = await readBody(req);
    // 设置弹窗出于安全不回传明文 Key：测试时若未重新输入，就用已保存的全局 Key 补齐
    const saved = loadAppSettings().llm;
    const providers = createProviders({
      provider: body.provider, model: body.model,
      baseUrl: body.baseUrl, apiKey: body.apiKey || saved.apiKey,
      llmTimeoutMs: body.llmTimeoutMs, temperature: body.temperature,
    });
    const result = await providers.testConnection();
    return json(res, result), true;
  }

  return false;
}
