/* ============================================================================
 * 工作台「每一步都能和 Agent 对话修改」· 按步骤独立的对话 + 真实业务动作
 *
 * 与 core/production-chat.mjs 的分工：
 *   production-chat = 项目级制片助手（一个会话，跨六步下指令）
 *   step-chat       = 挂在第 ①②③④⑤⑥ 步上的**分步会话**，只改这一步的事
 *
 * 三条硬约束：
 *  ① 对话不是聊天玩具：每个意图都落到真实业务函数（applyManageAction /
 *     executeSteps / 角色提取 / 音色分配 / 导演包），和 UI 按钮走同一条链路。
 *  ② 记录全部保留：消息按步存在 management.stepChats[stepId]，并同步落盘到
 *     DATA_DIR/conversations/{projectId}/step-{stepId}.json，可导出 Markdown/JSON。
 *  ③ token 分账：重跑步骤的消耗记在 step.tokens（那是执行），对话本身的消耗记在
 *     step.chatTokens；两者都能在面板里看到，合计才是该步总账。
 *
 * 本文件不碰 HTTP：REST 封装见 src/api/routes/step-chat.mjs。
 * ==========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, saveProject } from './store.mjs';
import { emit } from './events.mjs';
import {
  ensureManagement, applyManageAction, stepProgress, stepTokenReport, addChatTokens,
  STEPS, STEP_BY_ID,
} from './project-steps.mjs';
import { executeSteps, ensureDirectorPack, broadcastMeta } from './step-runner.mjs';
import { resolveRuntimeSpec, clipTimeline } from './runtime-spec.mjs';
import { buildStyleLock } from './character-style.mjs';
import { mergeExtracted } from './characters.mjs';
import { extractProjectCharacters } from '../agents/character-agent.mjs';
import { assignVoices } from '../agents/voice-agent.mjs';
import { attachSource } from '../pipelines/novel-project.mjs';
import { generateEpisodeScript } from './episode-service.mjs';

const CONV_DIR = path.join(DATA_DIR, 'conversations');
/** 单步会话消息上限：足够长期回溯，同时防止异常刷屏把项目 JSON 撑爆 */
export const MAX_MESSAGES_PER_STEP = 1000;
const MAX_TEXT = 8000;

const zeroTokens = () => ({ prompt: 0, completion: 0, total: 0, calls: 0 });
const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));

/** 工作台里允许对话的步骤（含项目级总助理） */
export const STEP_CHAT_SCOPE = [...STEPS.map((s) => s.id), 'project'];

/* -------------------------------------------------------------------------- *
 * 每步可用动作：前端快捷指令、帮助文案、意图识别共用这一份，避免多处漂移
 * -------------------------------------------------------------------------- */
export const STEP_CHAT_ACTIONS = {
  upload: [
    { id: 'bible', label: '改创作设定', say: '把片名改成《雨夜便利店》，类型悬疑，画风用冷调水墨' },
    { id: 'split', label: '改分集策略', say: '按 1500 字一集，最多 6 集' },
    { id: 'source', label: '替换原著', say: '（直接粘贴新的原著正文，≥120 字）' },
    { id: 'rerun', label: '重跑本步', say: '重新确认原著与分集' },
    { id: 'status', label: '本步现状', say: '这一步现在什么情况？' },
  ],
  episodes: [
    { id: 'split', label: '改分集参数', say: '按 1200 字一集，最多 4 集，重新拆' },
    { id: 'total-episodes', label: '设定总集数', say: '整部剧做成 8 集' },
    { id: 'episode-title', label: '改集标题', say: '把第 2 集改名为「雨夜的来信」' },
    { id: 'rerun', label: '重新拆集', say: '重新拆一遍分集' },
    { id: 'status', label: '本步现状', say: '现在分成几集？' },
  ],
  script: [
    { id: 'bible', label: '改剧本基调', say: '基调更冷峻，类型改成悬疑' },
    { id: 'episode-script', label: '重写某集', say: '重新生成第 2 集剧本' },
    { id: 'rerun', label: '重跑本步', say: '重新生成统一格式剧本' },
    { id: 'status', label: '本步现状', say: '剧本进度怎么样？' },
  ],
  context: [
    { id: 'characters', label: '提取角色', say: '从原著里提取角色' },
    { id: 'char-upsert', label: '改角色属性', say: '把林晚改成：月白长裙、清冷眉眼、性格克制' },
    { id: 'voices', label: '分配音色', say: '给角色分配音色' },
    { id: 'rerun', label: '重跑本步', say: '重新建 RAG 索引并做层次分解' },
    { id: 'status', label: '本步现状', say: '现在有几个角色？' },
  ],
  storyboard: [
    { id: 'runtime', label: '改成片规格', say: '做成 45 秒短剧，每个片段 3 秒' },
    { id: 'rerun', label: '重生成分镜', say: '重新生成分镜和关键帧' },
    { id: 'status', label: '本步现状', say: '关键帧和片段做到哪了？' },
  ],
  deliver: [
    { id: 'deliverables', label: '改交付物', say: '只要导演包，不要成片视频' },
    { id: 'policy', label: '切成片策略', say: '使用关键帧预览模式' },
    { id: 'pack', label: '重导导演包', say: '重新导出导演包' },
    { id: 'rerun', label: '重跑本步', say: '重新组装成片' },
    { id: 'status', label: '本步现状', say: '成片和导演包好了吗？' },
  ],
  project: [
    { id: 'status', label: '项目总览', say: '现在做到哪一步了？' },
    { id: 'tokens', label: 'Token 消耗', say: '各步 token 花了多少？' },
    { id: 'rerun-all', label: '跑完剩余步骤', say: '把剩下的步骤都跑完' },
  ],
};

/** 全部动作（按步骤）扁平索引，供路由校验 action 合法性 */
const ACTION_IDS = Object.fromEntries(Object.entries(STEP_CHAT_ACTIONS)
  .map(([k, list]) => [k, new Set(list.map((a) => a.id))]));

export function stepDefOf(stepId) {
  return stepId === 'project' ? null : (STEP_BY_ID[stepId] || null);
}

export function stepChatLabel(stepId) {
  const def = stepDefOf(stepId);
  return def ? `第 ${def.no} 步 · ${def.title}` : '项目总助理';
}

/* -------------------------------------------------------------------------- *
 * 会话存储：按步分桶 + 同步落盘（用户要求「所有对话记录保留」）
 * -------------------------------------------------------------------------- */
export function ensureStepChats(m) {
  if (!m.stepChats || typeof m.stepChats !== 'object' || Array.isArray(m.stepChats)) m.stepChats = {};
  return m.stepChats;
}

/** 取某步会话（惰性创建），不落盘 */
export function stepChatOf(project, stepId) {
  const m = ensureManagement(project);
  const all = ensureStepChats(m);
  if (!all[stepId] || typeof all[stepId] !== 'object') {
    all[stepId] = {
      schema: 1, stepId, label: stepChatLabel(stepId),
      createdAt: Date.now(), updatedAt: Date.now(),
      messages: [], tokens: zeroTokens(),
    };
  }
  const chat = all[stepId];
  if (!Array.isArray(chat.messages)) chat.messages = [];
  if (!chat.tokens) chat.tokens = zeroTokens();
  // counter = 累计写入条数：seq 用它而不是 messages.length，
  // 否则裁剪旧消息后新消息的 seq 会从 1 重新开始，导出与引用都会错位。
  if (!Number.isFinite(chat.counter) || chat.counter < chat.messages.length) {
    chat.counter = chat.messages.length;
  }
  chat.label = stepChatLabel(stepId);
  return chat;
}

function persistStepChat(project, stepId) {
  try {
    fs.mkdirSync(CONV_DIR, { recursive: true });
    const chat = stepChatOf(project, stepId);
    fs.writeFileSync(path.join(CONV_DIR, `${project.id}.step-${stepId}.json`),
      JSON.stringify({ projectId: project.id, projectName: project.name, ...chat }, null, 2), 'utf8');
  } catch { /* 分享副本写失败不影响主流程 */ }
}

/**
 * 追加一条消息。role=user 的用户发言、role=assistant 的 Agent 回复都走这里，
 * 保证「说过什么、改了什么、花了多少 token」三件事在同一条记录里。
 */
export function appendStepMessage(project, stepId, msg = {}) {
  const chat = stepChatOf(project, stepId);
  const tokens = msg.tokens ? {
    prompt: Number(msg.tokens.prompt) || 0,
    completion: Number(msg.tokens.completion) || 0,
    total: Number(msg.tokens.total) || 0,
    calls: Number(msg.tokens.calls) || 0,
  } : zeroTokens();
  const rec = {
    seq: chat.counter + 1,
    at: Date.now(),
    role: msg.role === 'user' ? 'user' : 'assistant',
    text: String(msg.text || '').slice(0, MAX_TEXT),
    action: msg.action || null,
    params: msg.params || null,
    calls: Array.isArray(msg.calls) ? msg.calls : [],
    artifacts: Array.isArray(msg.artifacts) ? msg.artifacts : [],
    suggestions: Array.isArray(msg.suggestions) ? msg.suggestions : [],
    tokens,
    durationMs: Number(msg.durationMs) || 0,
    ok: msg.ok !== false,
    changed: !!msg.changed,
    // 是否由这次对话触发了真实的步骤重跑（前端据此提示「已重新生成」）
    reran: msg.reran || null,
  };
  chat.messages.push(rec);
  chat.counter = rec.seq;
  if (chat.messages.length > MAX_MESSAGES_PER_STEP) {
    chat.messages.splice(0, chat.messages.length - MAX_MESSAGES_PER_STEP);
  }
  for (const k of ['prompt', 'completion', 'total', 'calls']) chat.tokens[k] += tokens[k];
  chat.updatedAt = Date.now();
  return rec;
}

/** 提交会话：保存项目 + 落盘分享副本（消息写入后由调用方统一调用一次） */
function commitChat(project, stepId) {
  saveProject(project);
  persistStepChat(project, stepId);
}

export function stepChatHistory(project, stepId) {
  return stepChatOf(project, stepId).messages;
}

/* -------------------------------------------------------------------------- *
 * 本步现状：对话开场白、welcome 文案、status 动作共用
 * -------------------------------------------------------------------------- */
export function stepChatContext(project, stepId) {
  const m = ensureManagement(project);
  const spec = resolveRuntimeSpec(project);
  const st = (m.steps || []).find((s) => s.id === stepId) || null;
  const prog = stepProgress(m);
  const nodes = project.nodes || [];
  const chars = m.characters || [];
  const eps = m.episodes || [];
  const lines = [];

  if (stepId === 'project') {
    lines.push(`项目「${project.name}」· ${nodes.length} 个画布节点`);
    lines.push(`六步进度 ${prog.done}/${prog.total}${prog.failed ? ` · ${prog.failed} 步失败` : ''}`);
    lines.push(`角色 ${chars.length} 位 · 分集 ${eps.length} 集 · 成片规格 ${spec.totalSeconds}s ÷ ${spec.clipSeconds}s = ${spec.clipCount} 段`);
  } else {
    const def = STEP_BY_ID[stepId];
    lines.push(`${stepChatLabel(stepId)} · 当前状态 ${st?.status || 'pending'}`);
    if (st?.note) lines.push(`最近一次：${st.note}`);
    if (stepId === 'upload') {
      lines.push(`原著：${m.source?.title ? `《${m.source.title}》` : '尚未上传'} · ${m.source?.chapterCount || 0} 章 / ${m.source?.totalChars || 0} 字`);
      lines.push(`分集策略：${m.split?.strategy || 'chapter'} · ${m.split?.targetChars || 1200} 字/集 · 最多 ${m.split?.maxEpisodes || 4} 集`);
      lines.push(`创作设定：${m.bible?.title ? `《${m.bible.title}》` : '未设片名'}${m.bible?.genre ? ` · ${m.bible.genre}` : ''}${m.bible?.artStyle ? ` · ${m.bible.artStyle}` : ''}`);
    } else if (stepId === 'episodes') {
      lines.push(`当前 ${eps.length} 集：${eps.slice(0, 6).map((e) => `第${e.no}集 ${e.title || ''}`).join(' / ')}`);
      lines.push(`分集参数：${m.split?.targetChars} 字/集 · 最多 ${m.split?.maxEpisodes} 集`);
    } else if (stepId === 'script') {
      const withScript = eps.filter((e) => e.script?.scenes?.length || e.script?.source);
      lines.push(`已生成剧本 ${withScript.length}/${eps.length} 集`);
      lines.push(`整体基调：${m.bible?.genre || '未设类型'} · ${m.bible?.tone || '未设调性'}`);
    } else if (stepId === 'context') {
      lines.push(`角色 ${chars.length} 位${chars.length ? `：${chars.slice(0, 6).map((c) => c.name).join('、')}` : '（尚未提取）'}`);
      const withVoice = chars.filter((c) => c.voiceId);
      lines.push(`已配音色 ${withVoice.length}/${chars.length}`);
      lines.push(`RAG / 层次分解节点：${nodes.filter((n) => ['rag', 'character', 'plan', 'event', 'scene', 'shot'].includes(n.type)).length} 个`);
    } else if (stepId === 'storyboard') {
      lines.push(`镜头 ${nodes.filter((n) => n.type === 'shot').length} 个 · 关键帧 ${nodes.filter((n) => n.type === 'keyframe').length} 个 · 片段 ${nodes.filter((n) => n.type === 'video').length} 个`);
      lines.push(`成片规格 ${spec.totalSeconds}s ÷ ${spec.clipSeconds}s = ${spec.clipCount} 段 @ ${spec.fps}fps`);
    } else if (stepId === 'deliver') {
      const final = nodes.find((n) => n.type === 'final');
      const film = final?.data?.film;
      lines.push(`交付物：${m.deliverables?.video ? '成片视频 ' : ''}${m.deliverables?.pack ? '导演包' : ''}`);
      lines.push(`成片：${film?.file ? `${film.isRealVideo ? '真实 AI MP4' : '关键帧预览（非 AI 视频）'} · ${film.duration || '?'}s` : '尚未产出'}`);
      lines.push(`导演包：${final?.data?.directorPack?.file ? `${final.data.directorPack.fileCount} 个文件` : '尚未生成'}`);
    }
  }

  const tokens = st ? {
    exec: st.tokens || zeroTokens(),
    chat: st.chatTokens || zeroTokens(),
    sum: {
      prompt: (st.tokens?.prompt || 0) + (st.chatTokens?.prompt || 0),
      completion: (st.tokens?.completion || 0) + (st.chatTokens?.completion || 0),
      total: (st.tokens?.total || 0) + (st.chatTokens?.total || 0),
      calls: (st.tokens?.calls || 0) + (st.chatTokens?.calls || 0),
    },
  } : null;

  return {
    stepId, def: stepDefOf(stepId), lines,
    styleLock: buildStyleLock({ project, management: m }),
    tokens, progress: prog, spec,
    actions: STEP_CHAT_ACTIONS[stepId] || STEP_CHAT_ACTIONS.project,
  };
}

/* -------------------------------------------------------------------------- *
 * 意图识别：中文自然语言 → 本步内的动作 + 参数（规则实现，零 Key 可用）
 * -------------------------------------------------------------------------- */
function quoted(text) {
  const m = String(text).match(/[「『"“《]([^」』"”》]{1,120})[」』"”》]/);
  return m ? m[1].trim() : '';
}

function secondsIn(text) {
  return [...String(text).matchAll(/(\d+(?:\.\d+)?)\s*(?:秒|s\b)/gi)].map((m) => Number(m[1]));
}

const GENRES = ['悬疑', '科幻', '古风', '都市', '爱情', '喜剧', '恐怖', '武侠', '奇幻', '现实'];
const ART_STYLES = ['水墨', '赛博', '写实', '胶片', '国风', '日系', '油画', '像素', '三维', '手绘'];

/** 从自由文本里抠出创作设定字段（只填用户真的说到的字段） */
function bibleParams(text) {
  const p = {};
  const t = String(text);
  const title = t.match(/[《]([^》]{1,40})[》]/);
  if (title) p.title = title[1];
  const genre = GENRES.find((g) => t.includes(g));
  if (genre) p.genre = genre;
  const style = ART_STYLES.find((s) => t.includes(s));
  if (style) p.artStyle = style;
  // 「画风 / 风格 / 全局风格（串）改成 X」→ 直接作为风格锁串，角色定妆会真的用上
  const sm = t.match(/(?:画风|风格|全局风格|style)\s*(?:改成|设为|用|是|换成为|换成)?\s*[：:]?\s*([^\n。；;]{2,80})/i);
  if (sm) p.stylePrompt = sm[1].trim();
  const tone = t.match(/基调\s*(?:改成|设为|更|是)?\s*([^\n。；;,，]{1,20})/);
  if (tone) p.tone = tone[1].trim();
  const logline = t.match(/(?:一句话简介|简介|梗概)\s*[：:]\s*([^\n]{4,200})/);
  if (logline) p.logline = logline[1].trim();
  return p;
}

export function classifyStepMessage(stepId, message) {
  const t = String(message || '').trim();
  const low = t.toLowerCase();
  const secs = secondsIn(t);

  // 所有步骤共用的只读 / 通用意图
  if (/token|消耗|花费|用了多少/.test(low)) return { action: 'tokens', params: {} };
  if (/帮助|能做什么|怎么用|指令|功能/.test(t)) return { action: 'help', params: {} };
  if (/状态|进度|到哪|什么情况|怎么样|多少/.test(t) && !/改成|设为|重新|重跑/.test(t)) {
    return { action: 'status', params: {} };
  }
  if (stepId === 'project') {
    if (/跑完|全部步骤|剩余步骤|继续跑/.test(t)) return { action: 'rerun-all', params: {} };
    if (/一键|全流程/.test(t)) return { action: 'rerun-all', params: { director: true } };
    return { action: 'status', params: {} };
  }

  // 重跑本步（明确的重跑词）
  const rerunWord = /重跑|重新(?:生成|执行|跑|做|来|拆|分|写)|再来一遍|再跑|重做|重拆|再拆|重新来|刷新一下/.test(t);

  if (stepId === 'upload') {
    if (/分集|拆集|每集|一集/.test(t) && /(\d+\s*字|\d+\s*集)/.test(t)) {
      return { action: 'split', params: splitParams(t) };
    }
    if (t.length >= 120) return { action: 'source', params: { text: t } };
    if (Object.keys(bibleParams(t)).length) return { action: 'bible', params: bibleParams(t) };
    if (rerunWord) return { action: 'rerun', params: {} };
  }

  if (stepId === 'episodes') {
    // 先认引号里的标题：「把第 2 集改名为『雨夜的来信』」——
    // 不能直接取「改名」后面的字符，否则会把「为『…』」的「为」也吃进标题。
    const quotedTitle = t.match(/第\s*(\d+)\s*集[^\n]*?[「『"“]([^」』"”]{2,30})[」』"”]/);
    if (quotedTitle && /改名|标题|叫|改成|换名/.test(t)) {
      return { action: 'episode-title', params: { no: Number(quotedTitle[1]), title: quotedTitle[2].trim() } };
    }
    const bareTitle = t.match(/第\s*(\d+)\s*集[^\n]*?(?:改名为|标题改为|改名|标题|叫做)\s*([^\s，,。；;]{2,30})/);
    if (bareTitle) {
      return { action: 'episode-title', params: { no: Number(bareTitle[1]), title: bareTitle[2].trim() } };
    }
    if (/总集数|整部.*集|做成\s*\d+\s*集/.test(t)) {
      const n = t.match(/(\d+)\s*集/);
      return { action: 'total-episodes', params: { totalEpisodes: n ? Number(n[1]) : 0 } };
    }
    if (/分集|拆集|每集|一集/.test(t) || rerunWord) {
      const p = splitParams(t);
      return { action: rerunWord && !Object.keys(p).length ? 'rerun' : 'split', params: p };
    }
  }

  if (stepId === 'script') {
    const epNo = t.match(/第\s*(\d+)\s*集/);
    if (epNo && /剧本|重写|重新生成|再写/.test(t)) {
      return { action: 'episode-script', params: { no: Number(epNo[1]) } };
    }
    if (Object.keys(bibleParams(t)).length && !rerunWord) return { action: 'bible', params: bibleParams(t) };
    if (rerunWord) return { action: 'rerun', params: {} };
  }

  if (stepId === 'context') {
    if (/提取角色|识别角色|找角色|角色提取/.test(t)) return { action: 'characters', params: {} };
    if (/音色|配音|voice/.test(t)) return { action: 'voices', params: {} };
    // 「把林晚改成：月白长裙、清冷眉眼」/「角色 沈默 改为 玄色劲装」
    // 不要求句子必须出现「角色」二字——用户更常直接说人名。
    if (/改成|改为|设定为|人设|外貌|造型/.test(t) && !/分集|时长|片段|画风|片名|集数|规格/.test(t)) {
      const named = t.match(/把?\s*[「『"“]?([^\s，,。：:「」『』"“”]{2,12})[」』"”]?\s*(?:改成|改为|设定为)/);
      const detail = t.replace(/^[\s\S]*?(?:改成|改为|设定为)[：:]?\s*/, '').trim();
      if (detail) return { action: 'char-upsert', params: { name: named ? named[1] : '', detail } };
    }
    if (rerunWord) return { action: 'rerun', params: {} };
  }

  if (stepId === 'storyboard') {
    if (/(\d+(?:\.\d+)?)\s*(?:秒|s\b)/i.test(t) && /时长|秒|片段|短剧|做成/.test(t)) {
      return { action: 'runtime', params: runtimeParams(t, secs) };
    }
    if (rerunWord) return { action: 'rerun', params: {} };
  }

  if (stepId === 'deliver') {
    if (/预览模式|关键帧预览|允许降级/.test(t)) return { action: 'policy', params: { filmPolicy: 'preview' } };
    if (/真实\s*ai|真实视频|真实成片|严格模式/.test(low)) return { action: 'policy', params: { filmPolicy: 'real' } };
    if (/交付物|只要|不要成片|只要导演包|也要视频/.test(t)) return { action: 'deliverables', params: deliverableParams(t) };
    if (/导演包|打包|mmxpack/.test(t) && /导出|生成|重打|重新/.test(t)) return { action: 'pack', params: {} };
    if (rerunWord) return { action: 'rerun', params: {} };
  }

  // 兜底：说了具体但没匹配上 → 仍按「重跑本步」执行，并把原话作为触发理由记进运行明细，
  // 避免「说了半天没反应」。reply 会如实说明这次只是重跑、以及怎样做才能改动提示词。
  return { action: 'rerun', params: {}, freeform: true };
}

function splitParams(t) {
  const p = {};
  const chars = t.match(/(\d+)\s*字/);
  if (chars) p.targetChars = Number(chars[1]);
  const maxEp = t.match(/最多\s*(\d+)\s*集/);
  if (maxEp) p.maxEpisodes = Number(maxEp[1]);
  if (/章节|按章/.test(t)) p.strategy = 'chapter';
  else if (/字数/.test(t)) p.strategy = 'chars';
  else if (/场景|段落/.test(t)) p.strategy = 'scene';
  return p;
}

function runtimeParams(t, secs) {
  const p = {};
  if (secs.length >= 2) { p.totalSeconds = secs[0]; p.clipSeconds = secs[1]; }
  else if (secs.length === 1) {
    if (/每|单片段|片段时长/.test(t)) p.clipSeconds = secs[0];
    else p.totalSeconds = secs[0];
  }
  const fps = t.match(/(\d+)\s*fps/i);
  if (fps) p.fps = Number(fps[1]);
  return p;
}

function deliverableParams(t) {
  if (/只要导演包|不要(?:成片|视频)/.test(t)) return { video: false, pack: true };
  if (/只要(?:成片|视频)|不要导演包/.test(t)) return { video: true, pack: false };
  if (/都要|两个都要|成片.*导演包|导演包.*成片/.test(t)) return { video: true, pack: true };
  return {};
}

/** 该步骤的等价 HTTP 复刻命令（导出 Markdown 用，便于照着重放） */
export function replayOfStepChat(stepId, action, params, projectId) {
  const P = `/api/projects/${projectId || '{projectId}'}`;
  const post = (p, body) => ({ method: 'POST', path: `${P}${p}`, body });
  switch (action) {
    case 'bible': return post('/manage', { action: 'bible', value: params });
    case 'split': return post('/manage', { action: 'split', value: params });
    case 'total-episodes': return post('/manage', { action: 'bible', value: params });
    case 'runtime': case 'policy': return post('/runtime', params);
    case 'deliverables': return post('/manage', { action: 'deliverables', value: params });
    case 'characters': return post('/characters/extract', { mode: 'llm' });
    case 'char-upsert': return post('/manage', { action: 'char-upsert', value: params });
    case 'voices': return post('/voices/assign', {});
    case 'source': return post('/source', { text: '<粘贴的原著正文>', filename: 'chat-novel.txt' });
    case 'rerun': return post('/step', { stepId, force: true });
    case 'rerun-all': return post('/step', { all: true });
    case 'episode-script': return post(`/episodes/${params?.no || 1}/script`, {});
    case 'pack': return { method: 'GET', path: `${P}/director-pack`, body: null, note: '重新导出并下载导演包' };
    case 'tokens': return { method: 'GET', path: `${P}/steps/tokens`, body: null, note: '每步 token 明细' };
    default: return { method: 'GET', path: `${P}/steps/${stepId}/chat`, body: null, note: '本步对话记录' };
  }
}

/* -------------------------------------------------------------------------- *
 * 动作执行：每个 action 都调用真实业务函数
 * -------------------------------------------------------------------------- */
async function runAction({ project, stepId, action, params, text, modelId, log }) {
  const m = ensureManagement(project);
  const calls = [];
  const artifacts = [];
  const reply = [];
  let changed = false;
  let reran = null;
  let changedStep = null;
  // ok 显式表达「这条指令是否真的办成了」：参数缺失、目标不存在都算没办成，
  // 不能靠 reply 是否以 ✗ 开头来猜（追问式回复也带提示语，容易误判成成功）。
  let ok = true;
  const fail = (msg) => { ok = false; reply.push(`✗ ${msg}`); };
  const call = (name, http, fn) => {
    calls.push({ name, ...http });
    return fn();
  };

  const rerunStep = async (targetStepId, why) => {
    const r = await call(`重跑第 ${STEP_BY_ID[targetStepId]?.no || ''} 步`, replayOfStepChat(targetStepId, 'rerun', {}, project.id),
      () => executeSteps(project, { stepId: targetStepId, force: true, action: 'chat', trigger: String(why || '').slice(0, 120) }));
    calls[calls.length - 1].ok = r?.ok !== false;
    reran = { stepId: targetStepId, ok: r?.ok !== false, executed: r?.executed || [] };
    changed = true;
    changedStep = targetStepId;
    return r;
  };

  switch (action) {
    case 'status': {
      const ctx = stepChatContext(project, stepId);
      reply.push(ctx.lines.join('\n'));
      calls.push({ name: '读取本步状态', ...replayOfStepChat(stepId, 'status', {}, project.id) });
      break;
    }
    case 'help': {
      reply.push(`我是「${stepChatLabel(stepId)}」的协作助手。这一步可以这样改：`);
      for (const a of (STEP_CHAT_ACTIONS[stepId] || STEP_CHAT_ACTIONS.project)) {
        reply.push(`· ${a.label} — 「${a.say}」`);
      }
      reply.push('每次改动都会写进项目并记录在本步对话里；「Token 消耗」可随时查这一步花了多少。');
      break;
    }
    case 'tokens': {
      const rep = stepTokenReport(m);
      const own = stepId === 'project' ? null : rep.steps.find((s) => s.id === stepId);
      reply.push(stepId === 'project' ? `项目 Token 总账：${rep.total.calls} 次调用 · ${fmtTok(rep.total.total)} tokens（输入 ${fmtTok(rep.total.prompt)} / 输出 ${fmtTok(rep.total.completion)}）` : '');
      const rows = own ? [own] : rep.steps;
      for (const r of rows) {
        reply.push(`第 ${r.no} 步 ${r.title}：执行 ${fmtTok(r.exec.total)} tok（${r.exec.calls} 次）· 对话 ${fmtTok(r.chat.total)} tok（${r.chat.calls} 次）· 合计 ${fmtTok(r.sum.total)} tok${own ? '' : ` · 占比 ${r.share}%`}`);
      }
      if (own && own.runLog.length) {
        reply.push('');
        reply.push('最近运行明细：');
        for (const it of own.runLog.slice(0, 5)) {
          const at = new Date(it.at).toLocaleString('zh-CN', { hour12: false });
          reply.push(`· ${at} · ${it.action === 'chat' ? '对话触发' : it.action === 'auto' ? '自动' : '手动'} · ${it.ok ? '成功' : '失败'} · ${fmtTok(it.tokens?.total || 0)} tok · ${(it.durationMs / 1000).toFixed(1)}s`);
        }
      }
      calls.push({ name: '读取 Token 明细', ...replayOfStepChat(stepId, 'tokens', {}, project.id) });
      break;
    }
    case 'bible': {
      if (!Object.keys(params || {}).length) { fail('没听出要改哪一项。可以说：把片名改成《X》、类型悬疑、画风用冷调水墨。'); break; }
      const out = call('保存创作设定', replayOfStepChat(stepId, 'bible', params, project.id),
        () => applyManageAction(project, 'bible', params));
      calls[calls.length - 1].ok = out.ok;
      if (!out.ok) { fail(out.message); break; }
      changed = true; changedStep = stepId;
      const b = m.bible;
      reply.push(`✓ 创作设定已更新：${[
        b.title && `片名《${b.title}》`, b.genre, b.artStyle, b.tone && `${b.tone}调性`,
        b.stylePrompt && `风格串「${b.stylePrompt.slice(0, 40)}」`,
      ].filter(Boolean).join(' · ') || JSON.stringify(params)}`);
      if (params.stylePrompt) {
        reply.push(`风格串会进「角色定妆」的风格锁（${buildStyleLock({ project, management: m }).source}），重新生成定妆时生效；分镜出图还会叠加导演风格技能的美学。`);
      }
      if (stepId === 'script') reply.push('类型 / 基调 / 一句话简介会进剧本提示词；要让已生成剧本跟着变，说「重新生成剧本」。');
      break;
    }
    case 'split': {
      if (!Object.keys(params || {}).length) { fail('没听出分集参数。可以说：按 1200 字一集，最多 4 集。'); break; }
      const out = call('保存分集参数', replayOfStepChat(stepId, 'split', params, project.id),
        () => applyManageAction(project, 'split', params));
      calls[calls.length - 1].ok = out.ok;
      if (!out.ok) { fail(out.message); break; }
      changed = true;
      reply.push(`✓ ${out.message}`);
      const r = await rerunStep('episodes', text);
      reply.push(describeRerun(r, 'episodes'));
      if (r?.ok !== false) reply.push(`现在分成 ${(m.episodes || []).length} 集：${(m.episodes || []).slice(0, 6).map((e) => `第${e.no}集`).join(' / ')}`);
      break;
    }
    case 'total-episodes': {
      const n = Number(params?.totalEpisodes) || 0;
      if (!n) { fail('请说明总集数，例如「整部剧做成 8 集」。'); break; }
      const out = call('设定总集数', replayOfStepChat(stepId, 'total-episodes', { totalEpisodes: n }, project.id),
        () => applyManageAction(project, 'bible', { totalEpisodes: n }));
      calls[calls.length - 1].ok = out.ok;
      changed = true;
      reply.push(`✓ 总集数设为 ${n}，分集上限同步为 ${m.split?.maxEpisodes} 集`);
      if (stepId === 'episodes') {
        const r = await rerunStep('episodes', text);
        reply.push(describeRerun(r, 'episodes'));
      }
      break;
    }
    case 'episode-title': {
      const no = Number(params?.no) || 0;
      const title = String(params?.title || '').trim();
      const ep = (m.episodes || []).find((e) => Number(e.no) === no);
      if (!ep) { fail(`第 ${no} 集不存在（当前 ${(m.episodes || []).length} 集）。`); break; }
      if (!title) { fail('请给出新标题，例如「把第 2 集改名为『雨夜的来信』」。'); break; }
      calls.push({ name: `第 ${no} 集改标题`, method: 'POST', path: `/api/projects/${project.id}/episodes/${no}`, body: { title } });
      const before = ep.title;
      ep.title = title.slice(0, 60);
      ep.updatedAt = Date.now();
      changed = true; changedStep = 'episodes';
      reply.push(`✓ 第 ${no} 集标题：${before || '（空）'} → 「${ep.title}」`);
      break;
    }
    case 'source': {
      const body = String(params?.text || text || '').trim();
      if (body.length < 120) { fail(`原著正文至少要 120 字（当前 ${body.length} 字）。直接粘贴整段正文即可。`); break; }
      const r = call('解析新原著', replayOfStepChat(stepId, 'source', {}, project.id),
        () => attachSource(project, { text: body, filename: '对话粘贴原著.txt', split: m.split }));
      calls[calls.length - 1].ok = true;
      changed = true; changedStep = 'upload';
      reply.push(`✓ 原著已替换：《${r.novel.title}》· ${r.novel.chapterCount} 章 / ${r.novel.totalChars} 字 → ${r.episodes.length} 集`);
      break;
    }
    case 'runtime':
    case 'policy': {
      if (!Object.keys(params || {}).length) {
        const spec = resolveRuntimeSpec(project);
        reply.push(`当前规格：${spec.totalSeconds}s ÷ ${spec.clipSeconds}s = ${spec.clipCount} 段 @ ${spec.fps}fps · ${spec.filmPolicy === 'real' ? '真实 AI 视频' : '关键帧预览'}`);
        break;
      }
      const out = call('保存成片规格', replayOfStepChat(stepId, 'runtime', params, project.id),
        () => applyManageAction(project, 'runtime', params));
      calls[calls.length - 1].ok = out.ok;
      if (!out.ok) { fail(out.message); break; }
      changed = true; changedStep = 'storyboard';
      reply.push(`✓ ${out.message}`);
      reply.push(`时间线：${clipTimeline(resolveRuntimeSpec(project)).map((x) => `${x.start}~${x.end}s`).join(' / ')}`);
      if (stepId === 'deliver' && params.filmPolicy) {
        reply.push(params.filmPolicy === 'real'
          ? '真实模式：每个片段都必须由 ComfyUI 视频工作流生成，缺一段就不会用关键帧预览冒充成片。'
          : '⚠ 预览模式：成片是静态关键帧拼接，不是 AI 视频，验收会记为降级。');
      }
      break;
    }
    case 'deliverables': {
      if (!Object.keys(params || {}).length) { fail('请说明交付物，例如「只要导演包，不要成片视频」。'); break; }
      const out = call('更新交付物', replayOfStepChat(stepId, 'deliverables', params, project.id),
        () => applyManageAction(project, 'deliverables', params));
      calls[calls.length - 1].ok = out.ok;
      if (!out.ok) { fail(out.message); break; }
      changed = true; changedStep = 'deliver';
      reply.push(`✓ ${out.message}`);
      break;
    }
    case 'characters': {
      const r = await call('角色提取', replayOfStepChat(stepId, 'characters', {}, project.id),
        () => extractProjectCharacters({ project, m, mode: 'llm', modelId, log: (lv, msg) => log(lv, msg) }));
      calls[calls.length - 1].ok = r?.ok !== false;
      if (!r.ok) { fail(r.error); break; }
      const merged = mergeExtracted(m.characters || [], r.extracted, { source: r.source });
      applyManageAction(project, 'characters', merged.characters);
      changed = true; changedStep = 'context';
      reply.push(`✓ ${r.message} · 新增 ${merged.added} / 归并 ${merged.merged} · 来源 ${r.source === 'mock' ? '内置模板（未配置 LLM）' : r.source}`);
      if (!(m.characters || []).length) reply.push('没有提取到角色：确认第 ③ 步剧本里已出现人物名，或直接说「新增角色 林晚」。');
      break;
    }
    case 'char-upsert': {
      let name = String(params?.name || '').trim();
      const detail = String(params?.detail || '').trim();
      // 只有一个角色时允许省略名字（「改成月白长裙」这种说法很常见）
      if (!name && (m.characters || []).length === 1) name = m.characters[0].name;
      if (!name) {
        const names = (m.characters || []).map((c) => c.name).slice(0, 8);
        fail(names.length
          ? `请指明要改哪位角色：${names.join('、')}。例如「把${names[0]}改成：月白长裙、清冷眉眼」。`
          : '角色库还是空的：先让我「从原著提取角色」，或说「新增角色 林晚」。');
        break;
      }
      const exist = (m.characters || []).find((c) => c.name === name);
      calls.push({ name: exist ? `更新角色「${name}」` : `新增角色「${name}」`,
        ...replayOfStepChat(stepId, 'char-upsert', { name, detail }, project.id) });
      // 一段描述里常同时含「衣/裙/袍」与「眉/眼/发」：按顿号切开后各归其位，
      // 比把整段塞进 appearance 再复制到三栏更可用（角色定妆提示词分栏引用）。
      const parts = detail.split(/[、，,；;]/).map((x) => x.trim()).filter(Boolean);
      const costume = parts.filter((p) => /[裙袍衣装甲衫褂斗篷披风鞋靴]/.test(p)).join('、');
      const statics = parts.filter((p) => /[眉眼脸发须疤痣唇鼻身形肩背影]/.test(p)).join('、');
      const raw = exist
        ? { ...exist, name, appearance: detail || exist.appearance,
          costume: costume || exist.costume, staticFeatures: statics || exist.staticFeatures, edited: true }
        : { name, appearance: detail, costume, staticFeatures: statics, role: '' };
      const out = applyManageAction(project, 'char-upsert', raw);
      calls[calls.length - 1].ok = out.ok;
      if (!out.ok) { fail(out.message); break; }
      changed = true; changedStep = 'context';
      reply.push(`✓ ${out.message}：${detail ? `外观「${detail}」` : '已保存'}`);
      reply.push('属性变化只影响后续生成的定妆与关键帧；已生成的定妆图要重新生成才会跟上（角色管理里可一键补全）。');
      break;
    }
    case 'voices': {
      const r = await call('音色分配', replayOfStepChat(stepId, 'voices', {}, project.id),
        () => assignVoices({ project, m, modelId, log: (lv, msg) => log(lv, msg) }));
      calls[calls.length - 1].ok = r?.ok !== false;
      changed = true; changedStep = 'context';
      reply.push(`✓ ${r.message} · 命中 ${r.applied} 位角色 · 来源 ${r.source === 'mock' ? '内置模板' : r.source}`);
      break;
    }
    case 'episode-script': {
      const no = Number(params?.no) || 0;
      const ep = (m.episodes || []).find((e) => Number(e.no) === no);
      if (!ep) { fail(`第 ${no} 集不存在（当前 ${(m.episodes || []).length} 集）。`); break; }
      const r = await call(`重写第 ${no} 集剧本`, replayOfStepChat(stepId, 'episode-script', params, project.id),
        () => generateEpisodeScript(project, m, ep, { log: (lv, msg) => log(lv, msg), modelId }));
      calls[calls.length - 1].ok = true;
      changed = true; changedStep = 'script';
      reply.push(`✓ 第 ${no} 集剧本已重写 · ${r?.scenes?.length || ep.script?.scenes?.length || 0} 个场景 · 来源 ${r?.source === 'llm' ? 'LLM' : '内置模板（未配置模型）'}`);
      break;
    }
    case 'rerun': {
      const r = await rerunStep(stepId, text);
      reply.push(describeRerun(r, stepId));
      const st = (m.steps || []).find((s) => s.id === stepId);
      if (st?.lastTokens?.total) reply.push(`本次消耗 ${fmtTok(st.lastTokens.total)} tokens（输入 ${fmtTok(st.lastTokens.prompt)} / 输出 ${fmtTok(st.lastTokens.completion)}）`);
      break;
    }
    case 'rerun-all': {
      const r = await call('跑完剩余步骤', replayOfStepChat('project', 'rerun-all', {}, project.id),
        () => executeSteps(project, { all: true, action: 'chat', trigger: String(text).slice(0, 120) }));
      calls[calls.length - 1].ok = r?.ok !== false;
      changed = true;
      reply.push(r.ok
        ? `✓ 剩余步骤已执行：${(r.executed || []).map((x) => `${x.id}:${x.status}`).join(' / ') || '全部已完成'}`
        : `✗ ${r.error || '执行失败'}`);
      break;
    }
    case 'pack': {
      const pack = call('重新导出导演包', replayOfStepChat(stepId, 'pack', {}, project.id),
        () => ensureDirectorPack(project, { force: true }));
      if (!pack) { fail('画布还没有最终节点，先把第 ⑥ 步跑通再打包。'); calls[calls.length - 1].ok = false; break; }
      calls[calls.length - 1].ok = true;
      changed = true; changedStep = 'deliver';
      reply.push(`✓ 导演包已重新生成：${pack.filename} · ${pack.shotCount} 组镜头 / ${pack.fileCount} 个文件`);
      artifacts.push({ label: '下载导演包', url: `/api/projects/${project.id}/director-pack`, kind: 'pack' });
      break;
    }
    default:
      reply.push('这一步暂时没有这个动作。可以说「能做什么」看可用指令。');
  }

  return { ok, reply: reply.filter((x) => x !== '').join('\n'), calls, artifacts, changed, reran, changedStep };
}

function describeRerun(r, stepId) {
  if (!r) return '未执行。';
  if (r.ok === false) return `✗ 重跑失败：${r.error || '未知原因'}`;
  const st = r.management?.steps?.find((s) => s.id === stepId);
  const state = st?.status === 'done' ? '完成' : st?.status === 'error' ? '失败' : st?.status || '完成';
  return `✓ 第 ${STEP_BY_ID[stepId]?.no || ''} 步已重跑 · ${state}${st?.note ? ` · ${st.note}` : ''}`;
}

function suggestionsFor(stepId, action) {
  const spec = STEP_CHAT_ACTIONS[stepId] || STEP_CHAT_ACTIONS.project;
  const after = {
    bible: { upload: ['按 1200 字一集重新拆', '把分集上限改成 6 集'], script: ['重新生成剧本', '重新生成第 2 集剧本'], project: ['现在做到哪一步了？'] },
    split: { upload: ['这一步现在什么情况？'], episodes: ['把第 1 集改名为「雨夜」', '整部剧做成 6 集'] },
    runtime: { storyboard: ['重新生成分镜', '这一步现在什么情况？'], deliver: ['重新组装成片'] },
    characters: { context: ['给角色分配音色', '把林晚改成：月白长裙'] },
    rerun: { upload: ['这一步现在什么情况？'], episodes: ['重新拆一遍分集'], script: ['重新生成第 2 集剧本'], context: ['给角色分配音色'], storyboard: ['这一步现在什么情况？'], deliver: ['重新导出导演包'] },
  };
  const picked = (after[action] && after[action][stepId]) || spec.slice(0, 3).map((a) => a.say);
  return picked;
}

/* -------------------------------------------------------------------------- *
 * 对外入口：一次对话 = 一条用户消息 + 一条助手消息
 * -------------------------------------------------------------------------- */
export async function runStepChat({ project, stepId, message, modelId = '', log = () => {} } = {}) {
  const text = String(message || '').trim();
  if (!text) return { ok: false, error: '消息不能为空' };
  if (!STEP_CHAT_SCOPE.includes(stepId)) return { ok: false, error: `未知步骤：${stepId}` };
  const m = ensureManagement(project);
  if (stepId !== 'project' && m.kind !== 'novel') {
    return { ok: false, error: '只有创作项目（六步工作台）才有分步对话' };
  }

  const t0 = Date.now();
  const { action, params } = classifyStepMessage(stepId, text);
  const http = replayOfStepChat(stepId, action, params, project.id);

  appendStepMessage(project, stepId, {
    role: 'user', text, action, params,
    calls: [{ name: '等价 HTTP 请求', ...http }],
  });
  commitChat(project, stepId);

  let out;
  try {
    out = await runAction({ project, stepId, action, params, text, modelId, log });
  } catch (err) {
    out = { reply: `✗ 执行失败：${err.message}`, calls: [], artifacts: [], changed: false };
    log('error', `分步对话异常（${stepId}/${action}）：${err.message}`);
  }

  // token 分账：重跑步骤的消耗已经由 finishStep 记进 step.tokens，
  // 这里只把「对话本身」的增量（若动作里有用 LLM 生成文案）记进 chatTokens。
  const chatUsage = out.chatTokens || null;
  if (chatUsage) addChatTokens(m, stepId, chatUsage);

  const rec = appendStepMessage(project, stepId, {
    role: 'assistant', text: out.reply, action, params,
    calls: out.calls, artifacts: out.artifacts,
    suggestions: suggestionsFor(stepId, action),
    tokens: chatUsage, changed: out.changed, reran: out.reran,
    durationMs: Date.now() - t0, ok: out.ok !== false && !/^✗/.test(out.reply),
  });

  saveProject(project);
  persistStepChat(project, stepId);
  broadcastMeta(project);
  emit('state', { projectId: project.id, project, reason: `step-chat:${stepId}` });
  emit('step:chat', { projectId: project.id, stepId, seq: rec.seq, action });

  return {
    ok: out.ok !== false, stepId, action, seq: rec.seq,
    reply: out.reply, calls: out.calls, artifacts: out.artifacts,
    suggestions: rec.suggestions, changed: out.changed, reran: out.reran,
    durationMs: rec.durationMs,
    context: stepChatContext(project, stepId),
    chat: stepChatOf(project, stepId),
  };
}

/* -------------------------------------------------------------------------- *
 * 导出：Markdown（人读 + 复刻命令）/ JSON（结构化重放）
 * -------------------------------------------------------------------------- */
/** 等价复刻命令：把一次真实调用还原成可照抄的 curl（端口用占位，正文压缩到一行） */
function curlOf(call, base = 'http://127.0.0.1:4599') {
  const url = `${base.replace(/\/+$/, '')}${call.path}`;
  const head = `curl -s -X ${call.method || 'GET'} '${url}' -H 'Content-Type: application/json'`;
  if (call.body === undefined || call.body === null) return head;
  return `${head} -d '${JSON.stringify(call.body).replace(/'/g, "'\\''")}'`;
}

export function exportStepChat(project, stepId, format = 'md') {
  const chat = stepChatOf(project, stepId);
  const ctx = stepChatContext(project, stepId);
  const tokens = stepTokenReport(ensureManagement(project));
  const own = stepId === 'project' ? null : tokens.steps.find((s) => s.id === stepId);

  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      filename: `${project.id}-${stepId}-chat.json`,
      body: JSON.stringify({
        projectId: project.id, projectName: project.name, stepId, label: stepChatLabel(stepId),
        exportedAt: new Date().toISOString(),
        // tokens 只放三本账（执行 / 对话 / 合计），完整的步骤行对象另放 step
        tokens: own ? { exec: own.exec, chat: own.chat, sum: own.sum } : tokens.total,
        step: own ? { no: own.no, title: own.title, runs: own.runs, runLog: own.runLog } : null,
        messages: chat.messages,
      }, null, 2),
    };
  }

  const lines = [
    `# ${project.name} · ${stepChatLabel(stepId)} 对话记录`,
    '',
    `- 项目：\`${project.id}\``,
    `- 导出时间：${new Date().toISOString()}`,
    own
      ? `- Token：执行 ${fmtTok(own.exec.total)}（${own.exec.calls} 次）· 对话 ${fmtTok(own.chat.total)}（${own.chat.calls} 次）· 合计 ${fmtTok(own.sum.total)}`
      : `- Token 总计：${fmtTok(tokens.total.total)}（${tokens.total.calls} 次调用）`,
    '',
    '## 本步现状',
    '',
    ...ctx.lines.map((l) => `- ${l}`),
    '',
    `## 对话（${chat.messages.length} 条）`,
    '',
  ];
  for (const msg of chat.messages) {
    const who = msg.role === 'user' ? '🧑 用户' : '🤖 协作助手';
    lines.push(`### ${msg.seq}. ${who}${msg.action ? ` · \`${msg.action}\`` : ''}`);
    lines.push('');
    lines.push('```text');
    lines.push(msg.text);
    lines.push('```', '');
    if (msg.at) lines.push(`时间：${new Date(msg.at).toLocaleString('zh-CN', { hour12: false })}  `);
    if (msg.durationMs) lines.push(`耗时：${(msg.durationMs / 1000).toFixed(1)}s  `);
    if (msg.tokens?.total) lines.push(`本次 token：${msg.tokens.total}（输入 ${msg.tokens.prompt} / 输出 ${msg.tokens.completion}）  `);
    if (msg.reran) lines.push(`触发重跑：第 ${STEP_BY_ID[msg.reran.stepId]?.no || ''} 步  `);
    const real = (msg.calls || []).filter((c) => c.path);
    if (real.length) {
      lines.push('', '实际调用：');
      for (const c of real) lines.push(`- \`${c.method} ${c.path}\` — ${c.name}${c.ok === false ? '（失败）' : ''}`);
      // 复刻命令：用户消息给出可直接照抄的 curl，其他用户拿到 Markdown 就能重放
      if (msg.role === 'user') {
        for (const c of real) {
          if (!c.method || !c.path) continue;
          lines.push('', '等价复刻命令：', '', '```bash', curlOf(c), '```');
        }
      }
    }
    if (msg.artifacts?.length) {
      lines.push('', `产物：${msg.artifacts.map((a) => `[${a.label}](${a.url.replace(project.id, '{projectId}')})`).join(' · ')}`);
    }
    lines.push('');
  }
  // 一键复刻命令串：把本步所有用户指令的 curl 按顺序汇总，他人可直接重放
  const replayable = chat.messages.filter((msg) => msg.role === 'user' && (msg.calls || []).some((c) => c.path && c.method));
  if (replayable.length) {
    lines.push('## 一键复刻命令串（按顺序执行）', '', '```bash', `# 0) 启动服务（端口按实际替换）`, `PORT=4599 node server.mjs`, `PROJECT={projectId}`, '');
    for (const msg of replayable) {
      for (const c of msg.calls.filter((x) => x.path && x.method)) {
        lines.push(`# ${msg.seq}. ${String(msg.text).replace(/\n/g, ' ').slice(0, 60)}`);
        lines.push(curlOf(c).replace(project.id, '{projectId}'));
        lines.push('');
      }
    }
    lines.push('```', '');
  }
  if (own?.runLog?.length) {
    lines.push('## 本步运行明细', '');
    lines.push('| 时间 | 触发 | 结果 | Token | 耗时 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const it of own.runLog) {
      lines.push(`| ${new Date(it.at).toLocaleString('zh-CN', { hour12: false })} | ${it.action === 'chat' ? '对话' : it.action === 'auto' ? '自动' : '手动'} | ${it.ok ? '成功' : '失败'} | ${it.tokens?.total || 0} | ${(it.durationMs / 1000).toFixed(1)}s |`);
    }
    lines.push('');
  }
  return {
    contentType: 'text/markdown; charset=utf-8',
    filename: `${project.id}-${stepId}-chat.md`,
    body: lines.join('\n'),
  };
}

/** 路由用：全部步骤的会话概览（不含完整消息，避免响应过大） */
export function stepChatIndex(project) {
  const m = ensureManagement(project);
  const chats = ensureStepChats(m);
  const report = stepTokenReport(m);
  return STEP_CHAT_SCOPE.map((stepId) => {
    const chat = chats[stepId];
    const row = report.steps.find((s) => s.id === stepId);
    return {
      stepId,
      label: stepChatLabel(stepId),
      messages: chat?.messages?.length || 0,
      updatedAt: chat?.updatedAt || null,
      lastText: chat?.messages?.length ? chat.messages[chat.messages.length - 1].text.slice(0, 80) : '',
      tokens: row ? { exec: row.exec, chat: row.chat, sum: row.sum } : { exec: zeroTokens(), chat: zeroTokens(), sum: zeroTokens() },
    };
  });
}
