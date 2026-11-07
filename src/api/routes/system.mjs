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
import { loadAppSettings, saveAppSettings, appSettingsSummary, ensureModelRoster, normalizeModelProfile, modelProfileSummary } from '../../core/app-settings.mjs';

const cut60 = (v) => String(v ?? '').trim().slice(0, 60);
const cut400 = (v) => String(v ?? '').trim().slice(0, 400);

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

  /** 全局模型库：设置面板唯一模型管理入口。清单永不返回明文 Key。
   *  GET 清单 / POST 保存档案（新增或按 id 更新）/ DELETE 删除（body {id}）。 */
  if (pathname === '/api/system/llm-models' && method === 'GET') {
    const { settings } = ensureModelRoster();
    return json(res, {
      models: settings.models.map(modelProfileSummary),
      activeModelId: settings.activeModelId,
    }), true;
  }
  if (pathname === '/api/system/llm-models' && method === 'POST') {
    const body = await readBody(req);
    const { settings } = ensureModelRoster();
    const list = [...settings.models];
    const id = cut60(body.id);
    const idx = id ? list.findIndex((p) => p.id === id) : -1;
    if (id && idx < 0) return json(res, { error: '模型档案不存在' }, 404), true;
    // 编辑时 Key 留空 = 沿用旧 Key（浏览器拿不到明文 Key，不会误清空）
    const prev = idx >= 0 ? list[idx] : {};
    const profile = normalizeModelProfile({
      ...prev,
      name: body.name, provider: body.provider, model: body.model,
      baseUrl: body.baseUrl, llmTimeoutMs: body.llmTimeoutMs, temperature: body.temperature,
      apiKey: cut400(body.apiKey) || prev.apiKey || '',
      id: idx >= 0 ? prev.id : id,
    });
    if (!profile) return json(res, { error: '请至少填写模型名或 Base URL' }, 400), true;
    if (idx >= 0) list[idx] = profile; else list.push(profile);
    // 库里还没有默认档案时，把新增的模型设为默认：避免「配了模型但运行时仍回落 Mock」
    const patch = { models: list };
    if (!settings.activeModelId && idx < 0) patch.activeModelId = profile.id;
    const saved = saveAppSettings(patch);
    return json(res, {
      ok: true, profile: modelProfileSummary(profile),
      models: saved.models.map(modelProfileSummary), activeModelId: saved.activeModelId,
    }), true;
  }
  if (pathname === '/api/system/llm-models' && method === 'DELETE') {
    const body = await readBody(req);
    const { settings } = ensureModelRoster();
    const id = cut60(body.id);
    const list = settings.models.filter((p) => p.id !== id);
    if (list.length === settings.models.length) return json(res, { error: '模型档案不存在' }, 404), true;
    // 删除默认档案时回落到清单第一个
    const activeModelId = settings.activeModelId === id ? (list[0]?.id || '') : settings.activeModelId;
    const saved = saveAppSettings({ models: list, activeModelId });
    return json(res, {
      ok: true, models: saved.models.map(modelProfileSummary), activeModelId: saved.activeModelId,
      message: '模型档案已删除',
    }), true;
  }
  /** 设为默认模型：对话框未显式选择时用它 */
  if (pathname === '/api/system/llm-models/activate' && method === 'POST') {
    const body = await readBody(req);
    const { settings } = ensureModelRoster();
    const id = cut60(body.id);
    if (!settings.models.some((p) => p.id === id)) return json(res, { error: '模型档案不存在' }, 404), true;
    const saved = saveAppSettings({ activeModelId: id });
    return json(res, { ok: true, activeModelId: saved.activeModelId }), true;
  }

  /** 测试模型连接：用档案或表单值发一次微型调用，不落盘。
   *  ① ref:{profileId} —— 服务端按模型库档案的完整配置（含明文 Key）来测；
   *  ② 表单值（provider/model/baseUrl/apiKey）—— 未重新输入 Key 时沿用已保存的旧全局 Key。 */
  if (pathname === '/api/system/llm-test' && method === 'POST') {
    const body = await readBody(req);
    const saved = loadAppSettings().llm;
    let cfg;
    if (body.ref && body.ref.profileId) {
      const { settings } = ensureModelRoster();
      const profile = settings.models.find((p) => p.id === cut60(body.ref.profileId));
      if (!profile) return json(res, { ok: false, error: '模型档案不存在或已删除' }, 404), true;
      cfg = profile;
    } else {
      // 设置弹窗出于安全不回传明文 Key：测试时若未重新输入，就用已保存的全局 Key 补齐
      cfg = {
        provider: body.provider, model: body.model,
        baseUrl: body.baseUrl, apiKey: body.apiKey || saved.apiKey,
        llmTimeoutMs: body.llmTimeoutMs, temperature: body.temperature,
      };
    }
    const providers = createProviders({
      provider: cfg.provider, model: cfg.model,
      baseUrl: cfg.baseUrl, apiKey: cfg.apiKey,
      llmTimeoutMs: body.llmTimeoutMs ?? cfg.llmTimeoutMs, temperature: cfg.temperature,
    });
    const result = await providers.testConnection();
    return json(res, result), true;
  }

  return false;
}
