/* ============================================================================
 * 导演风格设计师对话（Style Forge Chat）· 纯业务层
 *
 * 与其它对话模块的分工：
 *   step-chat         —— 项目内分步协作（改这一步的数据）
 *   production-chat   —— 项目级制片助手
 *   cover-agent       —— 封面对话 + 提示词设计
 *   style-forge-chat  —— **项目无关**：多轮引导用户产出一份完整的导演美学档案，
 *                          ready 后保存为自定义风格（data/director-styles.json）
 *
 * 设计：
 *  ① 草稿是唯一事实：每轮把「上一轮草稿 + 用户本轮发言」交给 LLM，返回合并后的完整草稿；
 *     前端持草稿并在 ready 后一键保存，后端不做会话状态（无状态、可重放）。
 *  ② 字段与 DIRECTOR_STYLES 同构：保存后直接被 resolveAesthetic / aestheticPrompt 消费。
 *  ③ 零 Key 可用：providers 的 styleForge mock 会从用户发言里抠线索 + 模板补齐，
 *     并如实给出 ready 判定与追问。
 * ==========================================================================*/
import { createProviders } from './providers.mjs';
import { resolveModelSettings } from './app-settings.mjs';
import { allDirectorStyles } from './director-styles.mjs';
import { normalizeCustomStyle } from './director-style-store.mjs';

/** ready 的硬性字段口径（与 schema 描述一致；mock 与 LLM 结果共用同一判定） */
const REQUIRED_KEYS = ['label', 'palettes', 'tone', 'light', 'composition', 'camera', 'stylePrompt'];

function missingKeys(draft) {
  const d = draft && typeof draft === 'object' ? draft : {};
  return REQUIRED_KEYS.filter((k) => {
    const v = d[k];
    if (k === 'palettes') return !Array.isArray(v) || !v.length;
    return v === undefined || v === null || String(v).trim() === '';
  });
}

function cleanHistory(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((x) => x && (x.role === 'user' || x.role === 'assistant') && String(x.content || '').trim())
    .slice(-14)
    .map((x) => ({ role: x.role, content: String(x.content).slice(0, 800) }));
}

/** 草稿瘦身：只把引导需要的字段发给模型，长文本截断，避免上下文爆炸 */
function slimDraft(draft) {
  if (!draft || typeof draft !== 'object') return {};
  const slim = { ...draft };
  for (const k of Object.keys(slim)) {
    const v = slim[k];
    if (typeof v === 'string' && v.length > 300) slim[k] = v.slice(0, 300);
    if (Array.isArray(v)) slim[k] = v.slice(0, 8);
  }
  return slim;
}

/**
 * 一轮对话：历史 + 草稿 → { reply, draft, ready, missing, suggestions, source }
 * @param {object} o
 * @param {Array}  o.messages  [{role:'user'|'assistant', content}]
 * @param {object} [o.draft]   上一轮草稿（前端持有并回传）
 * @param {string} [o.modelId] 模型档案 id（可空，走全局激活模型）
 */
export async function styleForgeChat({ messages = [], draft = null, modelId = '', log = () => {}, onUsage = null } = {}) {
  const history = cleanHistory(messages);
  const prevDraft = slimDraft(draft);
  const providers = createProviders(resolveModelSettings(null, modelId), log, onUsage);
  const out = await providers.generate('styleForge', {
    history,
    draft: prevDraft,
    // 已有风格清单：让设计师避免重名 / 主动建议差异化
    existing: allDirectorStyles().map((x) => x.label),
  });
  const merged = { ...prevDraft, ...(out?.draft && typeof out.draft === 'object' ? out.draft : {}) };
  const missing = missingKeys(merged);
  const ready = missing.length === 0 && out?.ready !== false;
  const source = providers.mode === 'openai' && !out?.__fallback ? 'llm' : 'template';
  return {
    reply: String(out?.reply || '').trim() || (ready ? '信息已齐，可以保存了。' : `还缺：${missing.slice(0, 2).join('、')}。`),
    draft: merged,
    ready,
    missing,
    suggestions: (Array.isArray(out?.suggestions) ? out.suggestions : []).map(String).slice(0, 4),
    source,
    fellBack: Boolean(out?.__fallback),
  };
}

/** 校验草稿并生成可保存的完整风格（保存前预览 / 路由保存共用同一口径） */
export function draftToStyle(draft) {
  return normalizeCustomStyle(draft || {});
}
