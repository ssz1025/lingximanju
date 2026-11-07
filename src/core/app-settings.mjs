/* ============================================================================
 * 应用级设置（全局 LLM 模型配置 + 模型库 + 首次启动引导状态）
 *
 * 模型库（models / activeModelId）是所有 AI 入口的唯一模型来源：
 *   · 用户在设置里维护多个模型档案（增删改 / 测连接 / 设默认）；
 *   · 每个对话框（封面 / 角色 / 剧本 / 画布……）可临时选择本次用哪个模型；
 *   · resolveModelSettings(project, modelId) 是运行时唯一解析点：
 *     对话框选择 modelId > 默认档案(activeModelId) > 项目旧配置 > 旧全局 llm 兜底。
 * 旧 llm 字段保留作迁移来源与兼容读取，新代码一律走 resolveModelSettings。
 * 纯逻辑部分（mergeLlmSettings / llmConfigured）无副作用，便于测试。
 * ==========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, listProjects, loadProject } from './store.mjs';

const FILE = path.join(DATA_DIR, 'app-settings.json');

export const DEFAULT_LLM = {
  provider: 'mock', model: '', baseUrl: '', apiKey: '',
  llmTimeoutMs: 300000, temperature: 0.7,
};

const DEFAULT_SETTINGS = {
  schema: 1,
  llm: { ...DEFAULT_LLM },
  models: [],              // 模型库：[{id, name, provider, model, baseUrl, apiKey, llmTimeoutMs, temperature}]
  activeModelId: '',       // 默认档案：对话框未显式选择时使用
  skipConfigCheck: false,   // 「先跳过」：不再每次启动弹窗，但顶栏仍保留可随时配置的入口
  updatedAt: 0,
};

const str = (v, max = 400) => String(v ?? '').trim().slice(0, max);
const num = (v, d, a, b) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.max(a, Math.min(b, n)) : d;
};

/** 归一 LLM 配置：只保留已知字段，避免把任意请求体写进配置文件 */
export function normalizeLlm(raw = {}) {
  return {
    provider: raw.provider === 'openai' ? 'openai' : 'mock',
    model: str(raw.model, 120),
    baseUrl: str(raw.baseUrl, 400).replace(/\/+$/, ''),
    apiKey: str(raw.apiKey, 400),
    llmTimeoutMs: num(raw.llmTimeoutMs, 300000, 10000, 3600000),
    temperature: Number.isFinite(Number(raw.temperature))
      ? Math.max(0, Math.min(2, Number(raw.temperature))) : 0.7,
  };
}

/** 归一模型库档案：id 缺失时自动生成；空档案（模型名与 BaseURL 皆无）直接丢弃 */
export function normalizeModelProfile(raw = {}) {
  const out = {
    id: str(raw.id, 60) || `mdl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: str(raw.name, 60) || str(raw.model, 60) || '未命名模型',
    ...normalizeLlm(raw),
  };
  if (out.provider !== 'openai' && !out.model && !out.baseUrl) return null;
  return out;
}

export function loadAppSettings() {
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      return {
        ...DEFAULT_SETTINGS,
        ...raw,
        llm: normalizeLlm({ ...DEFAULT_LLM, ...(raw.llm || {}) }),
        models: Array.isArray(raw.models) ? raw.models.map(normalizeModelProfile).filter(Boolean) : [],
        activeModelId: str(raw.activeModelId, 60),
        skipConfigCheck: Boolean(raw.skipConfigCheck),
      };
    }
  } catch (err) {
    console.warn('[settings] 配置读取失败，使用默认值：', err.message);
  }
  return { ...DEFAULT_SETTINGS, llm: { ...DEFAULT_LLM } };
}

/** patch 支持 { llm, models, activeModelId, skipConfigCheck }；原子写入。
 *  patch.models 为整表替换（路由层先读旧表合并后再整体写回）。 */
export function saveAppSettings(patch = {}) {
  const current = loadAppSettings();
  const next = {
    ...current,
    llm: patch.llm === undefined ? current.llm : normalizeLlm({ ...current.llm, ...(patch.llm || {}) }),
    models: patch.models === undefined ? current.models
      : (Array.isArray(patch.models) ? patch.models.map(normalizeModelProfile).filter(Boolean) : []),
    activeModelId: patch.activeModelId === undefined ? current.activeModelId : str(patch.activeModelId, 60),
    skipConfigCheck: patch.skipConfigCheck === undefined ? current.skipConfigCheck : Boolean(patch.skipConfigCheck),
    updatedAt: Date.now(),
  };
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
  return next;
}

/**
 * 模型库清单（惰性种子）：首次访问时把旧「全局 llm + 各项目显式配置」收编进 models，
 * 去重后一次性落盘，之后完全以 models 为准。返回 { settings, seeded }。
 */
export function ensureModelRoster() {
  const settings = loadAppSettings();
  if (settings.models.length || settings.seededAt) return { settings, seeded: false };
  const profiles = [];
  const seen = new Set();
  const push = (raw) => {
    const p = normalizeModelProfile(raw);
    if (!p) return;
    const key = `${p.provider}|${p.model}|${p.baseUrl}`;
    if (seen.has(key)) return;
    seen.add(key);
    profiles.push(p);
  };
  // ① 旧全局 llm（configured 或填过模型名都收编）
  const g = settings.llm || {};
  if (g.provider === 'openai' || g.model || g.baseUrl) {
    push({ ...g, id: 'mdl_global', name: g.model ? `全局 · ${g.model}` : '全局模型' });
  }
  // ② 各项目显式配置过完整 OpenAI 信息的（需 loadProject 拿明文 Key，索引摘要不含 Key）
  for (const idx of listProjects()) {
    const l = idx.llm || {};
    if (l.provider !== 'openai' || !l.baseUrl || !l.hasApiKey) continue;
    const full = loadProject(idx.id);
    const s = full?.settings || {};
    if (!llmConfigured({ provider: s.provider, baseUrl: s.baseUrl, apiKey: s.apiKey })) continue;
    push({ ...s, name: s.model ? `${idx.name} · ${s.model}` : `${idx.name} 模型` });
  }
  if (profiles.length) {
    settings.models = profiles;
    if (!settings.activeModelId) settings.activeModelId = profiles[0].id;
  }
  settings.seededAt = Date.now();
  const saved = saveAppSettings({
    models: settings.models,
    activeModelId: settings.activeModelId,
  });
  // saveAppSettings 不落 seededAt 之外的自定义字段，手动补写一次完整状态
  const withSeed = { ...saved, seededAt: settings.seededAt };
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(withSeed, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
  return { settings: withSeed, seeded: profiles.length > 0 };
}

/** 三者齐备才走真实 LLM —— 与 providers.mjs:createProviders 的判定保持一致 */
export function llmConfigured(llm = DEFAULT_LLM) {
  return llm?.provider === 'openai' && Boolean(llm.baseUrl) && Boolean(llm.apiKey);
}

export function maskKey(key = '') {
  const k = String(key || '');
  if (!k) return '';
  return k.length <= 8 ? `${k.slice(0, 2)}••••` : `${k.slice(0, 4)}••••${k.slice(-4)}`;
}

/** 对外摘要：绝不把完整 API Key 发给浏览器 */
export function appSettingsSummary(s = loadAppSettings()) {
  const llm = s.llm || DEFAULT_LLM;
  const models = Array.isArray(s.models) ? s.models : [];
  return {
    llm: {
      configured: llmConfigured(llm),
      provider: llm.provider, model: llm.model, baseUrl: llm.baseUrl,
      hasApiKey: Boolean(llm.apiKey), maskedKey: maskKey(llm.apiKey),
      llmTimeoutMs: llm.llmTimeoutMs, temperature: llm.temperature,
    },
    models: models.map(modelProfileSummary),
    activeModelId: str(s.activeModelId, 60),
    skipConfigCheck: Boolean(s.skipConfigCheck),
    updatedAt: s.updatedAt || 0,
  };
}

/**
 * 纯函数：全局默认 + 项目覆盖。
 * 项目显式配齐 provider/baseUrl/apiKey 时视为有意覆盖，其余场景继承全局。
 */
export function mergeLlmSettings(projectSettings = {}, globalLlm = DEFAULT_LLM) {
  const out = { ...(projectSettings || {}) };
  const projectExplicit = llmConfigured({
    provider: out.provider, baseUrl: out.baseUrl, apiKey: out.apiKey,
  });
  if (!projectExplicit && llmConfigured(globalLlm)) {
    for (const k of ['provider', 'model', 'baseUrl', 'apiKey', 'llmTimeoutMs', 'temperature']) {
      if (globalLlm[k] !== undefined && globalLlm[k] !== '') out[k] = globalLlm[k];
    }
  }
  // 项目级 comfy / style / k 等创作开关原样保留
  return out;
}

/** 所有 Provider 调用方共用的入口：拿到「项目设置 + 全局模型默认」的有效配置 */
export function effectiveProjectSettings(project, globalLlm) {
  const g = globalLlm || loadAppSettings().llm;
  return mergeLlmSettings(project?.settings || {}, g);
}

/**
 * 运行时唯一模型解析点（模型库版）：
 *   对话框选择的 modelId > 默认档案(activeModelId) > 项目旧配置 > 旧全局 llm 兜底。
 * 命中档案时只覆盖 LLM 字段，项目自己的 comfy / style / imageEndpoint 等创作开关原样保留。
 */
export function resolveModelSettings(project, modelId) {
  const settings = loadAppSettings();
  const roster = Array.isArray(settings.models) ? settings.models : [];
  const profile = (str(modelId, 60) && roster.find((mm) => mm.id === str(modelId, 60)))
    || roster.find((mm) => mm.id === settings.activeModelId)
    || null;
  const base = { ...(project?.settings || {}) };
  if (profile) {
    for (const k of ['provider', 'model', 'baseUrl', 'apiKey', 'llmTimeoutMs', 'temperature']) {
      if (profile[k] !== undefined && profile[k] !== '') base[k] = profile[k];
    }
    return base;
  }
  // 无可用档案（库为空 / id 失效）：沿用旧合并链，行为与升级前完全一致
  return mergeLlmSettings(base, settings.llm);
}

/** 模型档案脱敏摘要：绝不把完整 API Key 发给浏览器 */
export function modelProfileSummary(p = {}) {
  return {
    id: p.id, name: p.name,
    provider: p.provider, model: p.model, baseUrl: p.baseUrl,
    hasApiKey: Boolean(p.apiKey), maskedKey: maskKey(p.apiKey),
    llmTimeoutMs: p.llmTimeoutMs, temperature: p.temperature,
    configured: llmConfigured(p),
  };
}
