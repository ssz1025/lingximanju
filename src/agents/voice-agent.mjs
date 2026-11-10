// 音色分配智能体：按角色性别 / 年龄 / 性格 / 定位，从音色库里为每个角色挑最合适的音色，
// 并把 voiceId / voiceName / voiceReason 写回角色。LLM 优先，未配置 / 失败时启发式兜底。
//
// 设计对齐《AI漫剧项目功能实现原理深度拆解》第 5 节 voice_assigner：
//   list_voices → get_characters → assign_voice（写回 characters.voiceStyle）。
// 本实现把「音色库」显式建模为全局资产（data/voices.json），并支持角色界面逐条试听。
//
// 唯一性硬约束：同一项目里每个角色的音色不能重复。
//   - LLM 返回的分配要逐条校验：音色不存在 / 已被前面角色占用 → 该角色退回启发式，
//     在「剩余未被占用」的音色里重挑，绝不把同一个 voiceId 写给两个角色。
//   - 启发式兜底直接用 matchAllUnique（贪心：每个角色只在未占用音色里取最优）。
import { defineAgent } from '../core/agent.mjs';
import { createProviders } from '../core/providers.mjs';
import { resolveModelSettings } from '../core/app-settings.mjs';
import { seedVoices, getVoice, matchVoice, matchAllUnique } from '../core/voices.mjs';

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
 * @param {object} opts { project, m, library?, modelId?, onlyMissing?, log?, signal? }
 *   - onlyMissing: true 时只给还没有音色的角色分配，用户手动指定的绑定原样保留
 *     （提取角色后的自动分配走这个模式；「AI 分配音色」按钮不带它，全量重排）。
 * @returns {Promise<{assignments:Array, applied:number, skipped:number, fellBack:boolean, source:string}>}
 */
export async function assignVoices({ project, m, library, modelId = '', onlyMissing = false, log = () => {}, signal } = {}) {
  const characters = Array.isArray(m?.characters) ? m.characters : [];
  if (!characters.length) return { assignments: [], applied: 0, skipped: 0, fellBack: false, source: 'empty', message: '还没有角色' };
  // 全新数据目录里 voices.json 尚不存在：惰性播种默认音色库，
  // 否则「导演技能 → 音色分配」会在首次运行时零命中（库为空却显示成功）。
  const libraryVoices = Array.isArray(library) ? library : seedVoices().voices;
  // 本轮要分配的角色 / 保持不动（已绑定）的角色。
  const targets = onlyMissing ? characters.filter((c) => !c.voiceId) : characters;
  const keepBound = onlyMissing ? characters.filter((c) => c.voiceId) : [];
  if (!targets.length) {
    return { assignments: [], applied: 0, skipped: 0, fellBack: false, source: 'empty', message: '所有角色都已绑定音色（未改动手动指定的绑定）' };
  }
  // 已绑定角色占掉的音色本轮不许再分配出去 —— 这是「音色不能重复」的第一道闸。
  const taken = new Set(keepBound.map((c) => c.voiceId).filter(Boolean));

  // 1) 优先调 LLM（若已配置模型）；失败 / 未配置回退启发式打分
  let assignments;
  let fellBack = false;
  const settings = resolveModelSettings(project, modelId);
  if (settings.provider === 'openai' && settings.baseUrl && settings.apiKey) {
    try {
      const providers = createProviders(settings, (lvl, msg) => log(lvl, `音色分配 · ${msg}`));
      // 提示 LLM 哪些音色已被占用：让它优先在空闲音色里挑，减少重分配次数
      const voiceProj = projectVoices(libraryVoices).map((v) => ({
        ...v, taken: taken.has(v.id) ? true : undefined,
      }));
      const out = await providers.generate('voiceAssign', { characters: projectCharacters(targets), voices: voiceProj }, signal);
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
      assignments = matchAllUnique(projectCharacters(targets), libraryVoices, { taken });
    }
  } else {
    fellBack = true;
    assignments = matchAllUnique(projectCharacters(targets), libraryVoices, { taken });
  }

  // 2) 按角色名回写，并做唯一性收敛：voiceId 必须存在且未被占用，
  //    重复 / 非法的分配退回启发式，在剩余空闲音色里重挑（仍挑不出就保持未分配）。
  const byName = new Map(assignments.map((a) => [String(a.characterName || '').toLowerCase(), a]));
  let applied = 0;
  let reassigned = 0;
  let skipped = 0;
  for (const c of targets) {
    const a = byName.get(String(c.name || '').toLowerCase());
    let voice = a?.voiceId && !taken.has(a.voiceId) ? getVoice(a.voiceId, libraryVoices) : null;
    let reason = a?.reason || '';
    let score = Number(a?.score) || 0;
    if (!voice) {
      // LLM 给了重复 / 不存在的音色（或没给）：在剩余空闲音色里启发式重挑。
      // 空闲集为空时直接判未分配 —— matchVoice 对空数组会回退读磁盘库，会把
      // 别的角色已占用的音色再捡回来，破坏唯一性。
      const free = libraryVoices.filter((v) => !taken.has(v.id));
      const mt = free.length ? matchVoice(c, free) : { voice: null, score: 0, reasons: [] };
      voice = mt.voice;
      if (voice) {
        reason = a?.voiceId && getVoice(a.voiceId, libraryVoices)
          ? `模型重复分配了「${a.voiceName || a.voiceId}」，已改配：${mt.reasons.join('；') || '启发式匹配'}`
          : mt.reasons.join('；') || '启发式匹配';
        score = mt.score;
        reassigned += 1;
      }
    }
    if (voice) {
      taken.add(voice.id);
      c.voiceId = voice.id;
      c.voiceName = voice.name;
      c.voiceReason = reason || '按性别 / 年龄 / 性格 / 定位匹配';
      c.voiceScore = score;
      applied += 1;
    } else {
      // 没挑到：保留用户可能已手动指定的音色（targets 里 voiceId 本应为空），不强行清空
      if (!c.voiceId) skipped += 1;
    }
  }
  const dupNote = reassigned ? ` · 修正 ${reassigned} 个重复分配` : '';
  return {
    assignments, applied, skipped, fellBack,
    source: fellBack ? 'heuristic' : 'llm',
    message: `已为 ${applied} 位角色分配互不重复的音色${fellBack ? '（启发式兜底）' : ''}${dupNote}${skipped ? ` · ${skipped} 位因音色不足未分配` : ''}`,
  };
}

// 注册为画布 / 智能体列表里的一等公民：可在画布作为「音色分配」节点运行
defineAgent({
  id: 'voice-assigner',
  label: '音色分配智能体',
  group: '资产',
  icon: '🔊',
  color: '#f59e0b',
  description: '按角色性别 / 年龄 / 性格 / 定位，从音色库为每个角色匹配最合适的音色并写回，保证角色间音色不重复，支持逐条试听。',
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
