/* ============================================================================
 * 应用级设置（全局 LLM 模型配置 + 首次启动引导状态）
 *
 * 与项目级 project.settings 的关系：
 *   · 全局配置落在 data/app-settings.json，一次配置对所有项目生效（推荐入口）；
 *   · 项目自己显式填过完整 OpenAI 配置时，以项目为准（高级覆盖）；
 *   · effectiveProjectSettings() 是两者唯一的合并点，所有 Provider 调用方共用。
 * 纯逻辑部分（mergeLlmSettings / llmConfigured）无副作用，便于测试。
 * ==========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.mjs';

const FILE = path.join(DATA_DIR, 'app-settings.json');

export const DEFAULT_LLM = {
  provider: 'mock', model: '', baseUrl: '', apiKey: '',
  llmTimeoutMs: 300000, temperature: 0.7,
};

const DEFAULT_SETTINGS = {
  schema: 1,
  llm: { ...DEFAULT_LLM },
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

export function loadAppSettings() {
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      return {
        ...DEFAULT_SETTINGS,
        ...raw,
        llm: normalizeLlm({ ...DEFAULT_LLM, ...(raw.llm || {}) }),
        skipConfigCheck: Boolean(raw.skipConfigCheck),
      };
    }
  } catch (err) {
    console.warn('[settings] 配置读取失败，使用默认值：', err.message);
  }
  return { ...DEFAULT_SETTINGS, llm: { ...DEFAULT_LLM } };
}

/** patch 支持 { llm: {...}, skipConfigCheck: boolean }；原子写入 */
export function saveAppSettings(patch = {}) {
  const current = loadAppSettings();
  const next = {
    ...current,
    llm: patch.llm === undefined ? current.llm : normalizeLlm({ ...current.llm, ...(patch.llm || {}) }),
    skipConfigCheck: patch.skipConfigCheck === undefined ? current.skipConfigCheck : Boolean(patch.skipConfigCheck),
    updatedAt: Date.now(),
  };
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
  return next;
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
  return {
    llm: {
      configured: llmConfigured(llm),
      provider: llm.provider, model: llm.model, baseUrl: llm.baseUrl,
      hasApiKey: Boolean(llm.apiKey), maskedKey: maskKey(llm.apiKey),
      llmTimeoutMs: llm.llmTimeoutMs, temperature: llm.temperature,
    },
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
