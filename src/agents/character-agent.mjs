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
  MAX_CHARACTERS, buildExtractVars, mergeExtracted, supplementMainCharacters,
  verifyEvidence, charNameKey,
} from '../core/characters.mjs';
import { sanitizeCharacterList } from '../core/character-names.mjs';
import {
  episodeCastSources, episodeCastVars, collectEpisodeCastCandidates, diffEpisodeCast,
  buildCastCards, applyEpisodeCast,
} from '../core/episode-cast.mjs';
import { matchEpisodeCharacters } from '../core/episode-model.mjs';

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
  const stats = { candidates: 0, fragments: 0, verified: 0, dropped: 0, invalid: 0, supplemented: 0 };
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

  // 主角兜底：无论 LLM 还是启发式，都按「全书出场频次」补回被漏掉的高频角色。
  // 这一步不依赖模型判断——出场 800 次的角色漏掉是硬错误，不该靠提示词碰运气。
  const guard = supplementMainCharacters(extracted, text, { max: cap });
  extracted = guard.characters;
  stats.supplemented = guard.added.length;
  if (guard.added.length) {
    const tail = guard.displaced.length ? `（名额已满，挤掉：${guard.displaced.join('、')}）` : '';
    log('warn', `角色提取 · 按出场频次补回 ${guard.added.length} 位被漏掉的角色：${guard.added.slice(0, 6).join('、')}${guard.added.length > 6 ? '…' : ''}${tail}`);
    message += `；按出场频次补回 ${guard.added.length} 位（${guard.added.slice(0, 4).join('、')}${guard.added.length > 4 ? '…' : ''}）${tail}`;
  }

  // 统一清洗：无论 LLM 还是启发式，非人物（回头/刀光/冲他）、粘连扩展名（沈青崖不）
  // 与同一实体的重复称呼都在这里被剔除/归并，避免「把动作当角色」进项目。
  const cleaned = sanitizeCharacterList(extracted, { text, max: cap });
  stats.invalid = cleaned.dropped.length;
  extracted = cleaned.characters;
  if (cleaned.dropped.length) {
    log('warn', `角色提取 · 已剔除 ${cleaned.dropped.length} 个非人物/重复候选：${cleaned.dropped.slice(0, 6).join('、')}${cleaned.dropped.length > 6 ? '…' : ''}`);
  }

  return { ok: true, extracted, source, fellBack, message, stats };
}

/**
 * 第⑤步「角色和上下文」的每集补齐：检查本集出场人物是否都在项目角色库里，
 * 缺的直接在本集局部证据上生成角色卡并写入全局角色库，再回写本集 characterIds。
 *
 * 与 extractProjectCharacters 的关系：
 *   - 全书提取仍是项目级手动动作，这里**不重抽全书、不为每集建库**；
 *   - 只对「本集出现但全局库没有」的名字做增量补齐，语料仅限本集原文 + 剧本；
 *   - 沿用同一套 LLM intent（charExtract）、证据校验、人名清洗与 mergeExtracted 合并口径。
 *
 * 零 Key / 模型失败 / 模型漏人：统一用「带本集原文证据的启发式角色卡」兜底，
 * 只写可溯源依据不编造人设，并标记 source=heuristic 供后续真实 LLM 覆盖。
 *
 * @param {object} opts { project, m, ep, modelId?, log?, signal?, minHits?, mode?:'llm'|'heuristic' }
 * @returns {Promise<{ok:boolean, added:number, addedNames:string[], skipped:string[],
 *                    matched:number, cast:string[], source:string, message:string, notes:string[]}>}
 */
export async function ensureProjectCharactersForEpisode({
  project, m, ep, modelId = '', log = () => {}, signal, minHits, mode = 'llm',
} = {}) {
  const src = episodeCastSources(ep);
  const base = { added: 0, addedNames: [], skipped: [], cast: Array.isArray(ep?.characterIds) ? ep.characterIds.slice() : [] };
  if (!src.hasBody) {
    return { ok: true, ...base, matched: 0, source: 'none',
      message: '本集没有原文 / 剧本，未做角色对账', notes: ['本集没有原文或剧本，跳过角色补齐'] };
  }
  const existing = Array.isArray(m?.characters) ? m.characters : [];
  const candidates = collectEpisodeCastCandidates(ep, { minHits });
  const { matched, missing } = diffEpisodeCast(candidates, existing);
  // 姓名/别名直匹配是另一条更保守的口径：低频但确实登记过的角色（如只出现一次的
  // 「沈砚」）也要进本集名单，与候选抽取取并集，避免新逻辑让旧行为倒退。
  const nameMatched = matchEpisodeCharacters(ep, existing);
  const matchedIds = [...new Set([...matched.map((x) => x.id), ...nameMatched])];
  const free = Math.max(0, MAX_CHARACTERS - existing.length);
  const notes = [];

  if (!missing.length) {
    const applied = applyEpisodeCast({ m, ep, cards: [], source: 'heuristic', matchedIds });
    return { ok: true, ...applied, matched: matchedIds.length, source: 'existing',
      message: `本集识别到 ${applied.cast.length} 位出场角色，均已在项目角色库中（无需新增）`, notes };
  }
  if (free <= 0) {
    const names = missing.map((c) => c.name);
    const applied = applyEpisodeCast({ m, ep, cards: [], source: 'heuristic', matchedIds });
    notes.push(`角色库已满 ${MAX_CHARACTERS} 位，未自动挤掉任何已有角色`);
    return { ok: true, ...applied, matched: matchedIds.length, skipped: names, source: 'full',
      message: `本集新识别 ${names.length} 位角色（${names.slice(0, 4).join('、')}${names.length > 4 ? '…' : ''}）：项目角色库已满 ${MAX_CHARACTERS} 位，未自动入库，请在角色管理里手动取舍`,
      notes };
  }

  const wanted = new Set(missing.slice(0, free).map((c) => charNameKey(c.name)));
  let cards = [];
  let source = 'heuristic';
  if (mode === 'heuristic') {
    // 显式「只用本集原文证据」：不发起任何模型请求（离线 / 测试 / 批量快速对账）
    notes.push('按调用方指定：直接用本集原文证据建卡，不调用大模型');
  } else {
    try {
      const providers = createProviders(
        resolveModelSettings(project, modelId),
        (level, msg) => log(level, `本集角色补齐 · ${msg}`),
      );
      const vars = episodeCastVars(ep, missing.slice(0, free), { title: m?.source?.title || project?.name });
      log('info', `本集角色补齐 · 第 ${ep?.no} 集缺 ${wanted.size} 位，召回 ${vars.fragments.length} 段本集原文`);
      const out = await providers.generate('charExtract', vars, signal);
      if (out?.__fallback || out?.__mock || !Array.isArray(out?.characters) || !out.characters.length) {
        throw new Error(out?.__mock ? '未配置文本模型' : '模型未返回有效角色');
      }
      const checked = verifyEvidence(out.characters, src.text);
      if (checked.dropped) notes.push(`${checked.dropped} 条无法在本集原文定位的引用已丢弃`);
      const onlyMissing = checked.characters.filter((c) => wanted.has(charNameKey(c?.name)));
      const cleaned = sanitizeCharacterList(onlyMissing, { text: src.text, max: free });
      cards = cleaned.characters.map((c) => ({ ...c, source: 'llm' }));
      if (!cards.length) throw new Error('模型未返回任何本集缺失角色');
      source = 'llm';
      notes.push(`大模型依据本集原文生成 ${cards.length} 位角色设定`);
    } catch (err) {
      notes.push(`未用大模型生成（${err.message}），已改用带原文证据的启发式角色卡`);
      log('warn', `本集角色补齐 · ${err.message}，回退启发式占位设定`);
      cards = [];
      source = 'heuristic';
    }
  }

  // 模型可能只覆盖了部分缺失者：剩下的一律用启发式占位补齐，保证「本集出现即入库」
  const covered = new Set(cards.map((c) => charNameKey(c.name)));
  const rest = missing.slice(0, free).filter((c) => !covered.has(charNameKey(c.name)));
  if (rest.length) {
    cards = [...cards, ...buildCastCards(rest, src.text, { cap: free - cards.length })];
    notes.push(`${rest.length} 位由本集原文证据自动建卡（人设待完善）`);
  }
  const applied = applyEpisodeCast({ m, ep, cards, source, matchedIds });
  const sourceLabel = source === 'llm' ? '大模型生成' : '原文证据占位';
  return {
    ok: true, ...applied, matched: matchedIds.length, source,
    message: `本集新识别 ${applied.added} 位角色已入库全局角色库（${sourceLabel}：${applied.addedNames.slice(0, 4).join('、')}${applied.addedNames.length > 4 ? '…' : ''}）`
      + `${applied.skipped.length ? ` · ${applied.skipped.length} 位因角色库满 12 位未入库` : ''}`
      + ` · 本集出场 ${applied.cast.length} 位`,
    notes,
  };
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
      removed: merged.removed || [],
      source: result.source,
      fellBack: result.fellBack,
      stats: result.stats,
      summary: result.message,
    });
    ctx.log('info', `${result.message} · 新增 ${merged.added} / 合并 ${merged.merged}${merged.removed?.length ? ` / 清理 ${merged.removed.length}` : ''}`);
    return { ...result, added: merged.added, merged: merged.merged, removed: merged.removed };
  },
});
