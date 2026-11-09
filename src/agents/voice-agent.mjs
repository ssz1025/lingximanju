// 音色分配智能体：按角色性别 / 年龄 / 性格 / 定位，从音色库里为每个角色挑最合适的音色，
// 并把 voiceId / voiceName / voiceReason 写回角色。LLM 优先，未配置 / 失败时启发式兜底。
//
// 设计对齐《AI漫剧项目功能实现原理深度拆解》第 5 节 voice_assigner：
//   list_voices → get_characters → assign_voice（写回 characters.voiceStyle）。
// 本实现把「音色库」显式建模为全局资产（data/voices.json），并支持角色界面逐条试听。
import { defineAgent } from '../core/agent.mjs';
import { createProviders } from '../core/providers.mjs';
import { resolveModelSettings } from '../core/app-settings.mjs';
import { seedVoices, getVoice, matchAll } from '../core/voices.mjs';

/** 把音色库投影成 LLM 只需的精简字段，控制 token 体积 */
function projectVoices(voices) {
  return (voices || []).map((v) => ({
    id: v.id, name: v.name, gender: v.gender, ageGroup: v.ageGroup, tags: v.tags || [],
  }));
}

/** 把角色投影成匹配所需字段 */
function projectCharacters(chars) {
  return (chars || []).map((c) => ({
    id: c.id, name: c.name, gender: c.gender, age: c.age,
    personality: c.personality, role: c.role,
  }));
}

/**
 * 核心业务：为项目角色分配音色。
 * 直接改写 m.characters（就地设置 voiceId / voiceName / voiceReason / voiceScore），返回汇总。
 * 路由层调用后负责 saveProject + 广播；画布 agent 复用同一函数后由编排器落盘。
 *
 * @param {object} opts { project, m, library?, modelId?, log?, signal? }
 * @returns {Promise<{assignments:Array, applied:number, skipped:number, fellBack:boolean, source:string}>}
 */
export async function assignVoices({ project, m, library, modelId = '', log = () => {}, signal } = {}) {
  const characters = Array.isArray(m?.characters) ? m.characters : [];
  if (!characters.length) return { assignments: [], applied: 0, skipped: 0, fellBack: false, source: 'empty', message: '还没有角色' };
  // 全新数据目录里 voices.json 尚不存在：惰性播种默认音色库，
  // 否则「导演技能 → 音色分配」会在首次运行时零命中（库为空却显示成功）。
  const libraryVoices = Array.isArray(library) ? library : seedVoices().voices;
  const charProj = projectCharacters(characters);
  const voiceProj = projectVoices(libraryVoices);

  // 1) 优先调 LLM（若已配置模型）；失败 / 未配置回退启发式打分
  let assignments;
  let fellBack = false;
  const settings = resolveModelSettings(project, modelId);
  if (settings.provider === 'openai' && settings.baseUrl && settings.apiKey) {
    try {
      const providers = createProviders(settings, (lvl, msg) => log(lvl, `音色分配 · ${msg}`));
      const out = await providers.generate('voiceAssign', { characters: charProj, voices: voiceProj }, signal);
      const list = Array.isArray(out?.assignments) ? out.assignments : [];
      if (!list.length) throw new Error('模型未返回有效分配');
      assignments = list.map((a) => ({
        characterName: String(a.characterName || ''),
        voiceId: String(a.voiceId || ''),
        voiceName: String(a.voiceName || ''),
        reason: String(a.reason || ''),
        score: 0,
      }));
    } catch (err) {
      log('warn', `模型分配失败，改用启发式匹配：${err.message}`);
      fellBack = true;
      const matched = matchAll(charProj, libraryVoices);
      assignments = matched.map((mt) => ({
        characterName: mt.characterName, voiceId: mt.voiceId, voiceName: mt.voiceName, reason: mt.reason, score: mt.score,
      }));
    }
  } else {
    fellBack = true;
    const matched = matchAll(charProj, libraryVoices);
    assignments = matched.map((mt) => ({
      characterName: mt.characterName, voiceId: mt.voiceId, voiceName: mt.voiceName, reason: mt.reason, score: mt.score,
    }));
  }

  // 2) 按角色名回写；voiceId 必须确实存在于库里，否则视为未匹配（清空旧值）
  const byName = new Map(assignments.map((a) => [String(a.characterName || '').toLowerCase(), a]));
  let applied = 0;
  let skipped = 0;
  for (const c of characters) {
    const a = byName.get(String(c.name || '').toLowerCase());
    const voice = a?.voiceId ? getVoice(a.voiceId, libraryVoices) : null;
    if (a && voice) {
      c.voiceId = voice.id;
      c.voiceName = voice.name;
      c.voiceReason = a.reason || '按性别 / 年龄 / 性格 / 定位匹配';
      c.voiceScore = Number(a.score) || 0;
      applied += 1;
    } else {
      // 未匹配：保留用户可能已手动指定的音色，不强行清空
      if (!c.voiceId) skipped += 1;
    }
  }
  return {
    assignments, applied, skipped, fellBack,
    source: fellBack ? 'heuristic' : 'llm',
    message: `已为 ${applied} 位角色分配音色${fellBack ? '（启发式兜底）' : ''}${skipped ? ` · ${skipped} 位未匹配` : ''}`,
  };
}

// 注册为画布 / 智能体列表里的一等公民：可在画布作为「音色分配」节点运行
defineAgent({
  id: 'voice-assigner',
  label: '音色分配智能体',
  group: '资产',
  icon: '🔊',
  color: '#f59e0b',
  description: '按角色性别 / 年龄 / 性格 / 定位，从音色库为每个角色匹配最合适的音色并写回，支持逐条试听。',
  async run(ctx) {
    const m = ctx.project.management || (ctx.project.management = {});
    ctx.progress(0.15);
    ctx.log('info', '正在读取角色与音色库，准备分配音色…');
    const result = await assignVoices({
      project: ctx.project, m, modelId: '', log: (lvl, msg) => ctx.log(lvl, msg), signal: ctx.signal,
    });
    ctx.progress(0.95);
    ctx.patch({
      applied: result.applied,
      skipped: result.skipped,
      fellBack: result.fellBack,
      source: result.source,
      summary: result.message,
    });
    ctx.log(result.applied ? 'info' : 'warn', result.message);
    return result;
  },
});
