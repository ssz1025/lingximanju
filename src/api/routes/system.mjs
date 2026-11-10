// 系统域：SSE 事件流 / 健康检查 / 启动引导 / 示例原著 / 分集预览
import fs from 'node:fs';
import path from 'node:path';
import { json, readBody, NOVEL_BODY_LIMIT } from '../http.mjs';
import { subscribe } from '../../core/events.mjs';
import { listProjects, saveProject, EXAMPLES_DIR } from '../../core/store.mjs';
import { buildTemplate, TEMPLATE_META } from '../../pipelines/templates.mjs';
import { listAgents } from '../../agents/index.mjs';
import { loadComfyConfig, comfySummary } from '../../core/comfy-config.mjs';
import { STEPS } from '../../core/project-steps.mjs';
import { listDirectorSkills, listDirectorSkillsByGroup, DIRECTOR_CAPABILITIES,
  DIRECTOR_SKILL_GROUPS } from '../../core/director-skills.mjs';
import { DEFAULT_RUNTIME, normalizeRuntimeSpec } from '../../core/runtime-spec.mjs';
import { STORYBOARD_LAYOUTS, STORYBOARD_ASPECTS, STORYBOARD_SOURCES, STORYBOARD_CAPTIONS,
  STORYBOARD_GUIDES, PROMPT_PARTS, normalizeStoryboardSettings } from '../../core/storyboard-settings.mjs';
import { validateNovelInput, novelPreview, mergeNovelFiles } from '../../core/novel.mjs';
import { createProviders } from '../../core/providers.mjs';
import { loadAppSettings, saveAppSettings, appSettingsSummary, ensureModelRoster, normalizeModelProfile, modelProfileSummary } from '../../core/app-settings.mjs';

const cut60 = (v) => String(v ?? '').trim().slice(0, 60);
const cut400 = (v) => String(v ?? '').trim().slice(0, 400);

/**
 * 前端依赖的 API 能力清单。
 * 服务端是常驻进程：改了后端代码但没重启时，前端会照常拿到旧接口。
 * 把能力显式暴露给前端，旧进程就能被立刻识别并提示重启，而不是让用户
 * 以为「点了生成没反应 / 只出占位图」。
 */
const API_REVISION = '2026-11-09.10';
const API_CAPABILITIES = [
  'char-portrait-jobs',        // 角色定妆后台任务 + 进度查询/暂停
  'char-portrait-require-real', // requireReal：无 ComfyUI 工作流直接失败，不回退占位图
  'char-portrait-regen',        // 单视图 / 全部重生成
  'step-artifact-check',        // 六步按真实产物校验，0 节点不再标绿
  'step-stale-node-heal',       // 残留 running 节点自动复位后可重跑
  'storyboard-images-only',     // 第⑤步只出提示词 + 关键帧 + 分镜板，不出视频
  'video-in-deliver',           // 视频片段 / 转场视频统一在第⑥步生成
  'step-incremental-regen',     // 重跑只补缺失图 / 缺失片段，不无条件全量重烧
  'storyboard-real-image-check', // 分镜验收只看真实图，mock 占位不算已出图
  'storyboard-shot-regen',      // 单镜头重出分镜图（不动其它镜头）
  'step-stale-done-heal',       // 「已完成但没产物」的步骤自动降级为失败
  'storyboard-layout-settings', // 分镜画面设置：版式（九宫格等）/ 画幅 / 格内信息 / 提示词公式
  'storyboard-sheet-regen',     // 按当前版式重排分镜板（纯 SVG，不烧 GPU、不动关键帧）
  'comfy-job-reconcile',        // ComfyUI 任务对账：已完成直接取回，找不到才重发
  'comfy-queue-adopt',          // 无 prompt_id 的老任务也能凭队列前缀认领，不重复提交
  'task-sent-vs-planned',       // 任务看板区分「已发送到 ComfyUI」与「本地排期等待发送」
];
function apiInfo() {
  return { revision: API_REVISION, capabilities: API_CAPABILITIES };
}

export async function handleSystem(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  if (pathname === '/api/events' && method === 'GET') { subscribe(req, res); return true; }
  if (pathname === '/api/health') return json(res, { ok: true, ts: Date.now(), ...apiInfo() }), true;

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
      // 导演 Agent 技能清单：工作台首屏即可渲染技能卡，无需等项目级接口。
      // directorSkillGroups 直接给分组元数据（顺序 + 说明），前端不必再硬编码分组标题。
      directorSkills: listDirectorSkills(), directorCapabilities: DIRECTOR_CAPABILITIES,
      directorSkillGroups: Object.values(DIRECTOR_SKILL_GROUPS),
      // 短剧成片规格默认值：工作台首屏即可显示「30s / 3s / 10 片段」
      runtimeDefaults: normalizeRuntimeSpec(DEFAULT_RUNTIME),
      // 分镜画面设置：版式清单与默认值随 bootstrap 下发，前端不硬编码「九宫格」
      storyboardLayouts: STORYBOARD_LAYOUTS,
      storyboardOptions: {
        aspects: STORYBOARD_ASPECTS, sources: STORYBOARD_SOURCES,
        captions: STORYBOARD_CAPTIONS, guides: STORYBOARD_GUIDES, promptParts: PROMPT_PARTS,
      },
      storyboardDefaults: normalizeStoryboardSettings(),
      recent: projects[0]?.id || null, serverTime: Date.now(),
      comfy: comfySummary(loadComfyConfig()),
      api: apiInfo(),
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
    const body = await readBody(req, NOVEL_BODY_LIMIT);
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
    const body = await readBody(req, NOVEL_BODY_LIMIT);
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
