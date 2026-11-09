// 角色提取智能体：从原著全文检索召回原文证据 → 提取角色 → 证据校验 → 合并写回项目。
//
// 过去这段逻辑内联在 management.mjs 的 /characters/extract 路由里，只能在 HTTP 请求中运行；
// 这里抽成可复用函数并注册为画布 / 智能体列表的一等公民，路由与画布 Agent 共用同一口径。
//
// 设计对齐《AI漫剧项目功能实现原理深度拆解》与 ViMax character_extractor.py：
//   - 式(6) 检索增强：BM25 全书召回 + 候选名字面定位窗口（buildCharacterPassages）
//   - Guidelines：只依据原著片段、别名归并、static/dynamic 特征二分、evidence 可回溯
//   - 零 Key 可跑通：LLM 未配置时给出「可溯源的占位设定」，并如实标记来源为 heuristic
import { defineAgent } from '../core/agent.mjs';
import { createProviders } from '../core/providers.mjs';
import { resolveModelSettings } from '../core/app-settings.mjs';
import { extractCharacters } from '../core/novel.mjs';
import {
  MAX_CHARACTERS, buildExtractVars, mergeExtracted, verifyEvidence,
} from '../core/characters.mjs';

export const MAX_EXTRACT_LIMIT = MAX_CHARACTERS;

/**
 * 核心业务：为项目提取「待合并」的角色列表与可观测统计。
 * 纯业务层：不落盘、不广播、不发应用级事件（log 由调用方注入），
 * 路由负责 saveProject + broadcastMeta，画布 Agent 由编排器统一落盘。
 *
 * @param {object} opts { project, m, mode?:'llm'|'heuristic', limit?, modelId?, log?, signal? }
 * @returns {Promise<{ok:boolean, extracted:Array, source:string, fellBack:boolean,
 *                    message:string, stats:{candidates:number,fragments:number,verified:number,dropped:number}, error?:string}>}
 */
export async function extractProjectCharacters({
  project, m, mode = 'llm', limit = MAX_CHARACTERS, modelId = '', log = () => {}, signal,
} = {}) {
  const text = String(m?.source?.text || '');
  if (!text) return { ok: false, error: '尚未上传小说，无法提取角色' };

  const cap = Math.max(1, Math.min(MAX_CHARACTERS, Number(limit) || MAX_CHARACTERS));
  const heuristic = () => extractCharacters(text, cap);
  const stats = { candidates: 0, fragments: 0, verified: 0, dropped: 0 };
  let extracted = [];
  let source = 'llm';
  let fellBack = false;
  let message = '';

  if (mode === 'heuristic') {
    extracted = heuristic();
    source = 'heuristic';
    stats.candidates = extracted.length;
    message = `启发式提取到 ${extracted.length} 位候选角色`;
  } else {
    try {
      const providers = createProviders(
        resolveModelSettings(project, modelId),
        (level, msg) => log(level, `角色提取 · ${msg}`),
      );
      // 式(6)：全书分块 → BM25 召回 + 候选名原文定位 → 原文证据喂给模型
      const vars = buildExtractVars(project, m, cap);
      stats.candidates = vars.candidates.length;
      stats.fragments = vars.fragments.length;
      log('info', `角色提取 · 召回 ${vars.fragments.length} 段原著片段（候选 ${vars.candidates.length} 位）`);

      const out = await providers.generate('charExtract', vars, signal);
      if (out?.__fallback || !Array.isArray(out?.characters) || !out.characters.length) {
        throw new Error('模型未返回有效角色');
      }
      extracted = out.characters;

      // 证据校验：引用必须能在原著原文里逐字定位，定位不到即视为幻觉引用并丢弃
      const checked = verifyEvidence(extracted, text);
      extracted = checked.characters;
      stats.verified = checked.verified;
      stats.dropped = checked.dropped;
      if (checked.dropped) {
        log('info', `角色提取 · 证据校验：${checked.verified} 条引用有效，${checked.dropped} 条无法在原著中定位已丢弃`);
      }

      if (out.__mock) {
        // 零 Key：Mock 只给可溯源的占位设定，不能冒充 LLM 成果。
        // 来源定为 heuristic 后，mergeExtracted 允许后续真实 LLM 覆盖这些占位值。
        source = 'heuristic';
        message = `未配置模型：已按原著片段生成 ${extracted.length} 位候选角色的占位设定，配置模型后可重新提取完整人设`;
      } else {
        message = `LLM 提取到 ${extracted.length} 位角色`;
      }
    } catch (err) {
      // LLM 不可用/失败自动落回启发式，响应里明示，避免假成功
      extracted = heuristic();
      source = 'heuristic';
      stats.candidates = extracted.length;
      fellBack = true;
      message = `LLM 提取失败（${err.message}），已回退启发式提取 ${extracted.length} 位候选`;
    }
  }

  return { ok: true, extracted, source, fellBack, message, stats };
}

// 注册为智能体列表 / 画布节点：可在画布作为「角色提取」节点运行
defineAgent({
  id: 'character-extractor',
  label: '角色提取智能体',
  group: '资产',
  icon: '🧬',
  color: '#8b5cf6',
  description: '按全书检索召回的原文证据提取角色并写回项目：LLM 优先，未配置模型时给出可溯源的占位设定，支持别名归并、证据校验与手改保护。',
  async run(ctx) {
    const m = ctx.project.management || (ctx.project.management = {});
    ctx.progress(0.15);
    ctx.log('info', '正在检索原著片段，准备提取角色…');
    const result = await extractProjectCharacters({
      project: ctx.project,
      m,
      modelId: '',
      signal: ctx.signal,
      log: (level, msg) => ctx.log(level, msg),
    });
    if (!result.ok) {
      ctx.log('warn', result.error);
      ctx.patch({ summary: result.error, source: 'empty' });
      return result;
    }
    const merged = mergeExtracted(m.characters || [], result.extracted, { source: result.source });
    m.characters = merged.characters;
    ctx.progress(0.95);
    ctx.patch({
      added: merged.added,
      merged: merged.merged,
      source: result.source,
      fellBack: result.fellBack,
      stats: result.stats,
      summary: result.message,
    });
    ctx.log('info', `${result.message} · 新增 ${merged.added} / 合并 ${merged.merged}`);
    return { ...result, added: merged.added, merged: merged.merged };
  },
});
