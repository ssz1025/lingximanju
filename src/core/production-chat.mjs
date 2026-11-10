/* ============================================================================
 * AI 制片对话（Production Chat）· 让「小说 → 真实短剧」的每一步都能在对话框里完成
 *
 * 设计要点：
 *  ① 每个意图都映射到**真实存在的业务函数**，并把等价的 HTTP 请求 / curl 记进
 *     对话记录，其他用户拿到导出的 Markdown 就能照着重放，不需要读源码。
 *  ② 长任务（跑六步 / 一键全流程 / 生成小说）异步执行、进度可轮询，避免 GPU
 *     生成动辄十几分钟把 HTTP 请求拖死；任务结果同样写入对话记录。
 *  ③ 所有回复都如实标注来源：ComfyUI 真实调用 / 关键帧预览 / 模板占位，
 *     绝不把「没调用 ComfyUI」说成成片已生成。
 *
 * 本文件不碰 HTTP：REST 封装见 src/api/routes/production-chat.mjs。
 * ==========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, saveProject, loadProject, uid } from './store.mjs';
import { emit } from './events.mjs';
import { ensureManagement, applyManageAction, stepProgress, STEPS } from './project-steps.mjs';
import { resolveRuntimeSpec, clipTimeline, verifyRuntime } from './runtime-spec.mjs';
import { normalizeFilmPolicy, FILM_POLICIES, evaluateFilm } from './film-policy.mjs';
import { listDirectorSkills, getDirectorSkill, planDirectorRun,
  verifyDirectorDeliverables, ensureDirectorState } from './director-skills.mjs';
import { executeSteps, ensureDirectorPack, broadcastMeta } from './step-runner.mjs';
import { runDirector, ensureDirectorSource } from '../agents/director-agent.mjs';
import { extractProjectCharacters } from '../agents/character-agent.mjs';
import { mergeExtracted } from './characters.mjs';
import { assignVoices } from '../agents/voice-agent.mjs';
import { attachSource } from '../pipelines/novel-project.mjs';
import { createProviders } from './providers.mjs';
import { resolveModelSettings } from './app-settings.mjs';
import { loadComfyConfig, resolveComfyConfig, comfySummary, hasWorkflowFor } from './comfy-config.mjs';
import { testConnection, describeWorkflow, parseWorkflow } from './comfyui.mjs';

const CONV_DIR = path.join(DATA_DIR, 'conversations');
const LONG_INTENTS = new Set(['novel', 'characters', 'step', 'steps', 'director']);
const TASKS = new Map();

/* -------------------------------------------------------------------------- *
 * 对话步骤清单：前端快捷指令、帮助文案、复刻指南都从这里生成，避免多处漂移
 * -------------------------------------------------------------------------- */
export const CHAT_STEPS = [
  { id: 'status', label: '看项目状态', say: '现在做到哪一步了？', desc: '六步进度、片段数、真实 AI 片段数、成片策略' },
  { id: 'help', label: '能做什么', say: '你能做什么？', desc: '列出全部可用指令' },
  { id: 'novel', label: '准备小说', say: '根据「雨夜便利店的相遇」生成小说', desc: '一句话构想 → 分章大纲 → 正文 → 解析分集（或直接粘贴原著）' },
  { id: 'bible', label: '设置基础信息', say: '把片名设为《雨夜便利店》，类型是悬疑', desc: '剧名 / 类型 / 基调 / 画风 / 世界观' },
  { id: 'runtime', label: '设置成片规格', say: '做成 30 秒短剧，每个片段 3 秒', desc: '总时长 / 每片段时长 → 片段数 / 帧数' },
  { id: 'policy', label: '选成片策略', say: '使用真实 AI 视频模式', desc: '真实 ComfyUI 视频（默认）或关键帧预览（明确降级）' },
  { id: 'comfy', label: '检查 ComfyUI', say: '检查 ComfyUI 连接和工作流', desc: '连通性、版本、工作流节点、提示词注入自检' },
  { id: 'skill', label: '选导演技能', say: '选择全流程导演技能', desc: '全流程 / 剧本精修 / 视觉一致 / 交接包 / 十位导演风格' },
  { id: 'characters', label: '提取角色', say: '从原著提取角色', desc: '全书扫描 + 证据召回，写回角色库' },
  { id: 'voices', label: '分配音色', say: '给角色分配音色', desc: '从音色库匹配并写回 voiceId' },
  { id: 'step', label: '跑单步', say: '执行第 3 步：剧本生成', desc: '按步骤序号或名称执行六步中的任一步' },
  { id: 'steps', label: '跑完六步', say: '依次跑完全部六个步骤', desc: '逐阶段调度真实智能体链' },
  { id: 'director', label: '一键全流程', say: '一键完成最终产物全流程', desc: '能力 → 六步 → 导演包 → 验收报告' },
  { id: 'verify', label: '验收报告', say: '给出最终产物验收报告', desc: '逐项核对，含 ComfyUI 真实片段与成片来源' },
  { id: 'pack', label: '导出导演包', say: '导出导演包', desc: '生成可导入 ComfyUI 导演工作台的交接包' },
  { id: 'film', label: '查看成片', say: '成片好了吗？给我下载链接', desc: '真实成片 / 预览成片 / 未达成原因' },
  { id: 'export', label: '导出对话记录', say: '导出完整对话记录', desc: 'Markdown + JSON，含 curl 复刻命令' },
];

export const STEP_BY_ID = Object.fromEntries(CHAT_STEPS.map((s) => [s.id, s]));
export const QUICK_SAYS = CHAT_STEPS.filter((s) => s.id !== 'export').map((s) => s.say);

/* -------------------------------------------------------------------------- *
 * 对话记录：落进项目 management.conversation，并同步一份独立 JSON 便于分享
 * -------------------------------------------------------------------------- */
function ensureConversation(project) {
  const m = ensureManagement(project);
  if (!m.conversation || m.conversation.schema !== 1) {
    m.conversation = { schema: 1, startedAt: Date.now(), messages: [], runs: [] };
  }
  return m.conversation;
}

function persistConversation(project) {
  try {
    fs.mkdirSync(CONV_DIR, { recursive: true });
    const conv = ensureConversation(project);
    fs.writeFileSync(path.join(CONV_DIR, `${project.id}.json`),
      JSON.stringify({ projectId: project.id, projectName: project.name, ...conv }, null, 2), 'utf8');
  } catch { /* 分享文件写失败不影响主流程 */ }
}

/** 追加一条消息；消息自带可复刻的 http/curl 与实际调用结果 */
export function appendMessage(project, msg) {
  const conv = ensureConversation(project);
  const rec = {
    seq: conv.messages.length + 1,
    at: Date.now(),
    role: msg.role || 'assistant',
    text: String(msg.text || ''),
    intent: msg.intent || null,
    params: msg.params || null,
    calls: Array.isArray(msg.calls) ? msg.calls : [],
    artifacts: Array.isArray(msg.artifacts) ? msg.artifacts : [],
    suggestions: Array.isArray(msg.suggestions) ? msg.suggestions : [],
    durationMs: Number(msg.durationMs) || 0,
    ok: msg.ok !== false,
  };
  conv.messages.push(rec);
  if (conv.messages.length > 300) conv.messages.splice(0, conv.messages.length - 300);
  saveProject(project);
  persistConversation(project);
  return rec;
}

export function chatHistory(project) {
  return ensureConversation(project).messages;
}

/* -------------------------------------------------------------------------- *
 * 意图识别：中文自然语言 → 意图 + 参数（不依赖 LLM，保证零 Key 也能用）
 * -------------------------------------------------------------------------- */
const SKILL_WORDS = [
  [/全流程|一键成片|完整流程/, 'full'],
  [/剧本精修|精修剧本|先把故事/, 'script'],
  [/视觉一致|视觉风格一致|专注画面/, 'visual'],
  [/交接包|只出导演包|最快拿包/, 'pack'],
];
const STEP_WORDS = [
  [/第?\s*1\s*步|上传小说|上传原著/, 'upload'],
  [/第?\s*2\s*步|分集拆解|分集/, 'episodes'],
  [/第?\s*3\s*步|剧本生成|写剧本|统一格式剧本/, 'script'],
  [/第?\s*4\s*步|上下文|RAG|层次分解/, 'context'],
  [/第?\s*5\s*步|分镜|关键帧|镜头链/, 'storyboard'],
  [/第?\s*6\s*步|成片组装|交付步|最终交付/, 'deliver'],
];

function numbersInSeconds(text) {
  return [...String(text).matchAll(/(\d+(?:\.\d+)?)\s*(?:秒|s\b)/gi)].map((m) => Number(m[1]));
}

function quoted(text) {
  const m = String(text).match(/[「『"“]([^」』"”]{2,120})[」』"”]/);
  return m ? m[1].trim() : '';
}

export function classify(text) {
  const t = String(text || '').trim();
  const low = t.toLowerCase();
  const secs = numbersInSeconds(t);

  if (/导出.*对话|对话记录|复刻记录|分享.*流程|导出.*流程/.test(t)) return { id: 'export', params: {} };
  if (/帮助|能做什么|怎么用|指令|功能列表|help/i.test(t)) return { id: 'help', params: {} };
  if (/验收|报告|核对|检查产物|达标/.test(t)) return { id: 'verify', params: {} };
  if (/状态|进度|到哪|做了多少|概览|当前情况|summary/i.test(t)) return { id: 'status', params: {} };
  if (/comfy|工作流|连接|显卡|gpu|自检/i.test(t)) return { id: 'comfy', params: {} };
  if (/真实\s*ai|真实视频|真实成片|不要用预览|必须调用\s*comfy|严格模式/.test(low)) return { id: 'policy', params: { filmPolicy: 'real' } };
  if (/关键帧预览|预览模式|预览成片|静态片段|允许降级/.test(t)) return { id: 'policy', params: { filmPolicy: 'preview' } };
  if (/成片|短剧|片段|秒|fps|帧率|时长/.test(t) && /设置|改成|做成|设为|调整|规格|总时长|每/.test(t)) {
    const params = {};
    if (secs.length >= 2) { params.totalSeconds = secs[0]; params.clipSeconds = secs[1]; }
    else if (secs.length === 1) {
      if (/每|单片段|片段时长/.test(t)) params.clipSeconds = secs[0];
      else params.totalSeconds = secs[0];
    }
    const fps = t.match(/(\d+)\s*fps/i);
    if (fps) params.fps = Number(fps[1]);
    return { id: 'runtime', params };
  }
  if (/成片.*(好了|下载|链接)|给我.*成片|下载.*视频|看.*成片/.test(t)) return { id: 'film', params: {} };
  if (/导演包|交接包|mmxpack|打包/.test(t) && /导出|生成|下载|重打|重新/.test(t)) return { id: 'pack', params: {} };
  if (/一键|全流程.*跑|跑完全部|全部流程|最终产物/.test(t) && !/六步|六个步骤/.test(t)) return { id: 'director', params: { idea: quoted(t) } };
  if (/六步|全部步骤|依次跑|跑完所有|所有步骤/.test(t)) return { id: 'steps', params: {} };
  if (/第\s*[1-6]\s*步|执行.*步|单步|重跑.*步/.test(t)) {
    const hit = STEP_WORDS.find(([re]) => re.test(t));
    return { id: 'step', params: { stepId: hit ? hit[1] : '' } };
  }
  if (/技能|导演风格|选择.*导演/.test(t)) {
    const hit = SKILL_WORDS.find(([re]) => re.test(t));
    let skillId = hit ? hit[1] : '';
    if (!skillId) {
      const skill = listDirectorSkills().find((s) => t.includes(s.label) || t.includes(s.id));
      skillId = skill?.id || '';
    }
    return { id: 'skill', params: { skillId } };
  }
  if (/音色|配音|voice|试听/.test(t)) return { id: 'voices', params: {} };
  if (/提取角色|角色提取|识别角色|找角色|角色库/.test(t)) return { id: 'characters', params: {} };
  if (/上传小说|粘贴.*原文|这是小说|原著如下/.test(t) || t.length > 220) {
    return { id: 'novel', params: { pasted: t.length > 220 ? t : '' } };
  }
  if (/构想|生成.*小说|写个故事|创作.*原著|一句话/.test(t)) {
    return { id: 'novel', params: { idea: quoted(t) || t.replace(/^(请根据|根据|用|按|帮我|生成|写|创作)+/, '').slice(0, 120) } };
  }
  if (/设定|片名|剧名|类型|基调|画风|世界观|基础信息/.test(t)) {
    const params = {};
    const title = t.match(/[《]([^》]{1,40})[》]/);
    if (title) params.title = title[1];
    if (/悬疑|科幻|古风|都市|爱情|喜剧|恐怖/.test(t)) params.genre = t.match(/悬疑|科幻|古风|都市|爱情|喜剧|恐怖/)[0];
    if (!params.title && !params.genre) params.logline = t.slice(0, 200);
    return { id: 'bible', params };
  }
  return { id: 'help', params: { unknown: true } };
}

/* -------------------------------------------------------------------------- *
 * 复刻命令：每个意图都给出等价 HTTP 请求，导出文档据此生成 curl
 * -------------------------------------------------------------------------- */
export function replayOf(intent, params, projectId) {
  const P = `/api/projects/${projectId || '{projectId}'}`;
  const post = (p, body) => ({ method: 'POST', path: `${P}${p}`, body });
  switch (intent) {
    case 'status': return { method: 'GET', path: `${P}/director/skills`, body: null, note: '技能 / 计划 / 验收快照' };
    case 'verify': return { method: 'GET', path: `${P}/director/skills`, body: null, note: 'verification 字段即验收清单' };
    case 'comfy': return { method: 'GET', path: '/api/comfyui', body: null, note: '全局 ComfyUI 配置摘要' };
    case 'runtime': return post('/runtime', params);
    case 'policy': return post('/runtime', params);
    case 'skill': return post('/director/skills', params);
    case 'bible': return post('/manage', { action: 'bible', value: params });
    case 'novel': return params.pasted
      ? post('/source', { text: '<粘贴的原著正文>', filename: 'novel.txt' })
      : post('/novel/ai', { idea: params.idea || '<一句话构想>' });
    case 'characters': return post('/characters/extract', { mode: 'llm' });
    case 'voices': return post('/voices/assign', {});
    case 'step': return post('/step', { stepId: params.stepId, force: false });
    case 'steps': return post('/step', { all: true });
    case 'director': return post('/director/run', params.idea ? { idea: params.idea } : {});
    case 'pack': return { method: 'GET', path: `${P}/director-pack`, body: null, note: '下载交接包（若尚未生成会先导出）' };
    case 'film': return { method: 'GET', path: `${P}/film`, body: null, note: '下载成片 MP4（仅真实/预览成片存在时可用）' };
    case 'export': return { method: 'GET', path: `${P}/production/chat/export?format=md`, body: null, note: '导出本对话记录' };
    default: return { method: 'GET', path: `${P}/production/chat`, body: null, note: '对话帮助' };
  }
}

export function curlOf(http, base = 'http://127.0.0.1:4599') {
  const url = `${base.replace(/\/+$/, '')}${http.path}`;
  const head = `curl -s -X ${http.method} '${url}' -H 'Content-Type: application/json'`;
  return http.body ? `${head} -d '${JSON.stringify(http.body)}'` : head;
}

/* -------------------------------------------------------------------------- *
 * 状态摘要 / 帮助 / 验收：只读意图
 * -------------------------------------------------------------------------- */
function stateSummary(project) {
  const m = ensureManagement(project);
  const spec = resolveRuntimeSpec(project);
  const prog = stepProgress(m);
  const videos = (project.nodes || []).filter((n) => n.type === 'video');
  const real = videos.filter((n) => n.data?.clip?.provider === 'comfyui' && n.data?.clip?.file && !n.data?.clip?.synthetic);
  const final = (project.nodes || []).find((n) => n.type === 'final');
  const film = final?.data?.film || null;
  const v = verifyDirectorDeliverables(project, ensureDirectorState(m).skillId);
  return {
    m, spec, prog, videos, real, film, verification: v,
    lines: [
      `项目「${project.name}」· ${project.nodes?.length || 0} 个画布节点`,
      `六步进度 ${prog.done}/${prog.total}${prog.failed ? ` · ${prog.failed} 步失败` : ''}`,
      `成片规格 ${spec.totalSeconds}s ÷ ${spec.clipSeconds}s = ${spec.clipCount} 个片段 @ ${spec.fps}fps · ${spec.filmPolicy === 'real' ? '真实 AI 视频模式' : '关键帧预览模式'}`,
      `ComfyUI 真实片段 ${real.length}/${spec.clipCount} · 成片 ${film ? (film.isRealVideo ? '真实 AI MP4' : '关键帧预览（非 AI 视频）') : '尚未产出'}`,
      `验收 ${v.passed} 达成 / ${v.degraded} 降级 / ${v.missing} 缺失${v.complete ? '' : ' · 尚未全部达成'}`,
    ],
  };
}

function helpText(s) {
  const lines = CHAT_STEPS.map((x, i) => `${String(i + 1).padStart(2, '0')}. ${x.label} — 「${x.say}」`).join('\n');
  return [
    '我是 AI 制片助手，小说合成短剧的每一步都能在这里用一句话完成。可用指令：',
    lines,
    '',
    `当前策略：${s.spec.filmPolicy === 'real' ? '真实 AI 视频（必须调用 ComfyUI）' : '关键帧预览（非 AI 视频）'}。`,
    '直接说「做成 30 秒短剧，每个片段 3 秒」「检查 ComfyUI」「一键完成最终产物全流程」即可。',
    '每次操作都会记录实际调用的接口与参数，随时说「导出完整对话记录」拿可复刻的 Markdown/JSON。',
  ].join('\n');
}

/* -------------------------------------------------------------------------- *
 * 意图执行：所有写操作都走既有业务函数，和 UI 按钮完全同一条链路
 * -------------------------------------------------------------------------- */
async function executeIntent({ project, intent, params, modelId, log = () => {} }) {
  const t0 = Date.now();
  const m = ensureManagement(project);
  const calls = [];
  const artifacts = [];
  const reply = [];
  const call = (name, http, fn) => {
    calls.push({ name, ...http });
    return fn();
  };
  const settings = resolveModelSettings(project, modelId);

  switch (intent) {
    case 'help': {
      reply.push(helpText(stateSummary(project)));
      break;
    }
    case 'status': {
      const s = stateSummary(project);
      reply.push(s.lines.join('\n'));
      calls.push({ name: '读取项目状态', ...replayOf('status', params, project.id) });
      break;
    }
    case 'verify': {
      const s = stateSummary(project);
      reply.push(`最终产物验收（${s.verification.items.length} 项）：`);
      for (const it of s.verification.items) {
        const mark = it.level === 'ok' ? '✓' : it.level === 'degraded' ? '△' : '✗';
        reply.push(`${mark} ${it.label}：${it.detail}`);
      }
      reply.push(`\n${s.verification.summary}`);
      calls.push({ name: '最终产物验收', ...replayOf('verify', params, project.id) });
      break;
    }
    case 'comfy': {
      const cfg = loadComfyConfig();
      const http = replayOf('comfy', params, project.id);
      calls.push({ name: '读取 ComfyUI 配置', ...http });
      reply.push(`ComfyUI 配置：${cfg.baseUrl} · enabled=${cfg.enabled} · strict=${cfg.strict} · outputMode=${cfg.outputMode}`);
      reply.push(`工作流：图片 ${cfg.imageWorkflowName || '未配置'}（${cfg.imageWorkflow ? Object.keys(cfg.imageWorkflow).length : 0} 节点）· 视频 ${cfg.videoWorkflowName || '未配置'}（${cfg.videoWorkflow ? Object.keys(cfg.videoWorkflow).length : 0} 节点）`);
      try {
        const conn = await call('真实连接自检', { method: 'GET', path: `${cfg.baseUrl}/system_stats`, body: null },
          () => testConnection(cfg.baseUrl));
        reply.push(`✓ 真实连通：ComfyUI ${conn.version} · ${conn.device}`);
        calls[calls.length - 1].result = conn;
        calls[calls.length - 1].ok = true;
      } catch (err) {
        reply.push(`✗ 连接失败：${err.message}`);
        calls[calls.length - 1].ok = false;
        calls[calls.length - 1].result = { error: err.message };
      }
      for (const kind of ['image', 'video']) {
        const wf = cfg[`${kind}Workflow`];
        if (!wf) { reply.push(`⚠ 未配置 ${kind} 工作流：${kind === 'video' ? '真实 AI 视频无法生成' : '关键帧会回退本地自绘'}`); continue; }
        try {
          const parsed = parseWorkflow(wf, `${kind} 工作流`);
          const d = describeWorkflow(parsed, { cfg: resolveComfyConfig(project, cfg) }, cfg.bindings?.[kind] || []);
          reply.push(`${kind === 'video' ? '🎬' : '🖼'} ${kind} 工作流注入自检：${d.ok ? '✓ 可注入提示词' : '⚠ 未找到提示词注入点'} · ${d.positive ? `${d.positive.node}.${d.positive.input} (${d.positive.strategy})` : '请在工作流里写 {{prompt}}'}`);
          calls.push({ name: `${kind} 工作流自检`, method: 'POST', path: '/api/comfyui/analyze', body: { kind },
            ok: d.ok, result: { positive: d.positive, warnings: d.warnings } });
        } catch (err) {
          reply.push(`⚠ ${kind} 工作流无效：${err.message}`);
        }
      }
      if (!hasWorkflowFor(cfg, 'video')) reply.push('\n下一步：在「设置 → ComfyUI」导入「导出(API)」格式的视频工作流，然后说「使用真实 AI 视频模式」。');
      break;
    }
    case 'runtime':
    case 'policy': {
      const patch = { ...params };
      if (!Object.keys(patch).length) {
        const s = stateSummary(project);
        reply.push(`当前成片规格：${s.spec.totalSeconds}s ÷ ${s.spec.clipSeconds}s = ${s.spec.clipCount} 片段 @ ${s.spec.fps}fps · ${s.spec.filmPolicy === 'real' ? '真实 AI 视频' : '关键帧预览'}。\n可以说「做成 30 秒短剧，每个片段 3 秒」或「使用真实 AI 视频模式」。`);
        break;
      }
      const out = call('保存成片规格', replayOf('runtime', patch, project.id),
        () => applyManageAction(project, 'runtime', patch));
      if (!out.ok) { reply.push(`✗ ${out.message}`); break; }
      const spec = resolveRuntimeSpec(project);
      reply.push(`✓ ${out.message}`);
      reply.push(`时间线：${clipTimeline(spec).map((x) => `${x.start}~${x.end}s`).join(' / ')}`);
      if (spec.filmPolicy === 'real') reply.push('真实模式：每个片段都必须由 ComfyUI 视频工作流生成，缺一段就不会用关键帧预览冒充成片。');
      else reply.push('⚠ 预览模式：成片是静态关键帧拼接，不是 AI 视频，验收会记为降级。');
      calls[calls.length - 1].result = { runtime: spec };
      calls[calls.length - 1].ok = true;
      saveProject(project); broadcastMeta(project);
      emit('state', { projectId: project.id, project, reason: 'runtime' });
      break;
    }
    case 'bible': {
      const out = call('保存创作设定', replayOf('bible', params, project.id),
        () => applyManageAction(project, 'bible', params));
      reply.push(out.ok ? `✓ ${out.message}：${JSON.stringify(params)}` : `✗ ${out.message}`);
      calls[calls.length - 1].ok = out.ok;
      saveProject(project); broadcastMeta(project);
      emit('state', { projectId: project.id, project, reason: 'bible' });
      break;
    }
    case 'skill': {
      const id = String(params.skillId || '').trim();
      if (!id) {
        reply.push(`可选导演技能：\n${listDirectorSkills().map((s) => `· ${s.label}（${s.id}）— ${s.tagline}`).join('\n')}`);
        break;
      }
      const skill = getDirectorSkill(id);
      if (skill.id !== id) { reply.push(`✗ 未知技能「${id}」`); break; }
      const out = call('选择导演技能', replayOf('skill', { skillId: id }, project.id),
        () => applyManageAction(project, 'director-skill', { skillId: id }));
      const planned = planDirectorRun({ project, m, skillId: id });
      reply.push(`✓ 已选「${skill.label}」：${skill.tagline}`);
      reply.push(`计划步骤 ${planned.plan.runStepIds.length} 步 · 能力 ${planned.plan.capabilities.length} 项`);
      calls[calls.length - 1].ok = out.ok;
      saveProject(project); broadcastMeta(project);
      emit('state', { projectId: project.id, project, reason: 'director-skill' });
      break;
    }
    case 'novel': {
      const http = replayOf('novel', params, project.id);
      calls.push({ name: params.pasted ? '上传原著正文' : '按构想生成小说', ...http });
      if (params.pasted) {
        const r = attachSource(project, { text: params.pasted, filename: '对话粘贴原著.txt', split: m.split });
        reply.push(`✓ 原著已解析：《${r.novel.title}》· ${r.novel.chapterCount} 章 / ${r.novel.totalChars} 字 → ${r.episodes.length} 集`);
      } else {
        const r = await ensureDirectorSource({ project, m, idea: params.idea || '', settings,
          modelId, log: (lv, msg) => log(lv, msg), signal: undefined });
        if (!r.ok) { reply.push(`✗ ${r.error}`); break; }
        reply.push(`✓ 已生成原著：《${r.title}》· ${r.chapters} 章 → ${r.episodes} 集 · 来源 ${r.source === 'mock' ? '内置模板（未配置 LLM）' : 'LLM'}`);
      }
      calls[calls.length - 1].ok = true;
      saveProject(project); broadcastMeta(project);
      emit('state', { projectId: project.id, project, reason: 'source' });
      break;
    }
    case 'characters': {
      const r = await call('角色提取', replayOf('characters', params, project.id),
        () => extractProjectCharacters({ project, m, mode: 'llm', modelId, log: (lv, msg) => log(lv, msg) }));
      if (!r.ok) { reply.push(`✗ ${r.error}`); break; }
      const merged = mergeExtracted(m.characters || [], r.extracted, { source: r.source });
      applyManageAction(project, 'characters', merged.characters);
      reply.push(`✓ ${r.message} · 新增 ${merged.added} / 归并 ${merged.merged} · 来源 ${r.source}`);
      calls[calls.length - 1].ok = true;
      saveProject(project); broadcastMeta(project);
      emit('state', { projectId: project.id, project, reason: 'characters' });
      break;
    }
    case 'voices': {
      const r = await call('音色分配', replayOf('voices', params, project.id),
        () => assignVoices({ project, m, modelId, log: (lv, msg) => log(lv, msg) }));
      reply.push(`✓ ${r.message} · 命中 ${r.applied} 位角色 · 来源 ${r.source}`);
      calls[calls.length - 1].ok = true;
      saveProject(project); broadcastMeta(project);
      emit('state', { projectId: project.id, project, reason: 'voices' });
      break;
    }
    case 'step': {
      const stepId = params.stepId || stepProgress(m).currentId;
      const r = await call(`执行第 ${stepId} 步`, replayOf('step', { stepId }, project.id),
        () => executeSteps(project, { stepId, force: false }));
      reply.push(r.ok
        ? `✓ 第 ${stepId} 步执行完成：${(r.executed || []).map((x) => `${x.id}:${x.status}`).join(' / ') || r.message || '完成'}`
        : `✗ ${r.error || r.message}`);
      calls[calls.length - 1].ok = r.ok !== false;
      break;
    }
    case 'steps': {
      const r = await call('依次跑完六步', replayOf('steps', params, project.id),
        () => executeSteps(project, { all: true }));
      reply.push(`✓ 六步链路已执行：${(r.executed || []).map((x) => `${x.id}:${x.status}`).join(' / ') || r.message || '完成'}`);
      const s = stateSummary(project);
      reply.push(`真实 AI 片段 ${s.real.length}/${s.spec.clipCount} · ${s.film ? (s.film.isRealVideo ? '真实成片已生成' : '预览成片（非 AI 视频）') : '未产出成片'}`);
      calls[calls.length - 1].ok = r.ok !== false;
      break;
    }
    case 'director': {
      const r = await call('导演 Agent 一键全流程', replayOf('director', params, project.id),
        () => runDirector({ project, idea: params.idea || '', modelId,
          log: (lv, msg) => log(lv, msg) }));
      if (r.blocked || !r.ok) {
        reply.push(`✗ 全流程未达成：${r.error || r.message || '验收未通过'}`);
      } else {
        reply.push(`✓ 全流程执行完成 · ${r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : ''}`);
        const s = stateSummary(project);
        reply.push(s.lines.slice(2).join('\n'));
        reply.push(`验收：${s.verification.summary}`);
        if (s.verification.filmReality?.blockers?.length) {
          reply.push(`未达成原因：${s.verification.filmReality.blockers.join('；')}`);
        }
        if (s.film?.file) artifacts.push({ label: '下载成片 MP4', url: `/api/projects/${project.id}/film`, kind: 'film',
          real: s.film.isRealVideo === true });
        const pack = (project.nodes || []).find((n) => n.type === 'final')?.data?.directorPack;
        if (pack?.file) artifacts.push({ label: '下载导演包', url: `/api/projects/${project.id}/director-pack`, kind: 'pack' });
      }
      calls[calls.length - 1].ok = r.ok !== false;
      calls[calls.length - 1].result = { ok: r.ok, complete: r.verification?.complete, checkCount: r.checklist?.length };
      break;
    }
    case 'pack': {
      const pack = call('导出导演包', replayOf('pack', params, project.id),
        () => ensureDirectorPack(project, { force: true }));
      if (!pack) { reply.push('✗ 画布还没有最终节点，请先跑「一键完成最终产物全流程」'); break; }
      reply.push(`✓ 导演包已生成：${pack.filename} · ${pack.shotCount} 组镜头 / ${pack.fileCount} 个文件`);
      artifacts.push({ label: '下载导演包', url: `/api/projects/${project.id}/director-pack`, kind: 'pack' });
      calls[calls.length - 1].ok = true;
      break;
    }
    case 'film': {
      const s = stateSummary(project);
      calls.push({ name: '查询成片', ...replayOf('film', params, project.id) });
      if (!s.film) {
        reply.push(`尚未产出成片。${s.verification.filmReality?.blockers?.join('；') || ''}`);
        reply.push('真实模式需要先「检查 ComfyUI 连接和工作流」，再「一键完成最终产物全流程」。');
      } else {
        reply.push(s.film.isRealVideo
          ? `✓ 真实 AI 成片：${(s.film.bytes / 1024 / 1024).toFixed(1)} MB · ${s.film.clips} 片段 · ${s.film.duration}s（${s.film.measured ? 'ffprobe 实测' : '标称'}）`
          : `△ 关键帧预览成片（非 AI 视频）：${s.film.duration}s · 验收已如实降级`);
        artifacts.push({ label: '下载成片 MP4', url: `/api/projects/${project.id}/film`, kind: 'film', real: s.film.isRealVideo === true });
      }
      break;
    }
    case 'export': {
      calls.push({ name: '导出对话记录', ...replayOf('export', params, project.id) });
      reply.push('已可导出完整对话记录：Markdown（人读 + curl 复刻命令）与 JSON（结构化可重放）。');
      reply.push(`接口：GET /api/projects/${project.id}/production/chat/export?format=md|json`);
      break;
    }
    default:
      reply.push(helpText(stateSummary(project)));
  }

  const s = stateSummary(project);
  return {
    reply: reply.join('\n'),
    calls,
    artifacts,
    suggestions: nextSuggestions(intent, s),
    state: { stepProgress: s.prog, spec: s.spec, verification: { complete: s.verification.complete,
      passed: s.verification.passed, degraded: s.verification.degraded, missing: s.verification.missing } },
    durationMs: Date.now() - t0,
  };
}

function nextSuggestions(intent, s) {
  const map = {
    help: ['现在做到哪一步了？', '做成 30 秒短剧，每个片段 3 秒', '检查 ComfyUI 连接和工作流'],
    status: ['一键完成最终产物全流程', '给出最终产物验收报告', '导出完整对话记录'],
    comfy: ['使用真实 AI 视频模式', '一键完成最终产物全流程', '检查 ComfyUI 连接和工作流'],
    runtime: ['选择全流程导演技能', '从原著提取角色', '一键完成最终产物全流程'],
    policy: ['检查 ComfyUI 连接和工作流', '一键完成最终产物全流程', '给出最终产物验收报告'],
    novel: ['把片名设为《雨夜便利店》，类型是悬疑', '做成 30 秒短剧，每个片段 3 秒', '从原著提取角色'],
    bible: ['从原著提取角色', '给角色分配音色', '一键完成最终产物全流程'],
    skill: ['一键完成最终产物全流程', '给出最终产物验收报告', '依次跑完全部六个步骤'],
    characters: ['给角色分配音色', '执行第 3 步：剧本生成', '一键完成最终产物全流程'],
    voices: ['执行第 3 步：剧本生成', '一键完成最终产物全流程', '现在做到哪一步了？'],
    step: ['依次跑完全部六个步骤', '一键完成最终产物全流程', '给出最终产物验收报告'],
    steps: ['导出导演包', '给出最终产物验收报告', '导出完整对话记录'],
    director: ['给出最终产物验收报告', '导出导演包', '导出完整对话记录'],
    verify: ['一键完成最终产物全流程', '成片好了吗？给我下载链接', '导出完整对话记录'],
    pack: ['成片好了吗？给我下载链接', '导出完整对话记录', '现在做到哪一步了？'],
    film: ['给出最终产物验收报告', '导出完整对话记录', '导出导演包'],
    export: ['现在做到哪一步了？', '一键完成最终产物全流程'],
  };
  return map[intent] || map.help;
}

/* -------------------------------------------------------------------------- *
 * 对外入口：同步短意图 / 异步长意图
 * -------------------------------------------------------------------------- */
export function chatTaskSnapshot(projectId = '') {
  return [...TASKS.values()]
    .filter((t) => !projectId || t.projectId === projectId)
    .map(({ id, projectId: pid, intent, status, startedAt, finishedAt, error }) =>
      ({ id, projectId: pid, intent, status, startedAt, finishedAt, error }));
}

/** 当前是否有长任务在跑（前端用来禁用重复触发） */
export function hasRunningTask(projectId) {
  return [...TASKS.values()].some((t) => t.projectId === projectId && t.status === 'running');
}

export async function runProductionChat({ project, message, modelId = '', log = () => {} } = {}) {
  const text = String(message || '').trim();
  if (!text) return { ok: false, error: '消息不能为空' };
  const { id: intent, params } = classify(text);
  const http = replayOf(intent, params, project.id);
  const user = appendMessage(project, {
    role: 'user', text, intent, params, calls: [{ name: '等价 HTTP 请求', ...http, curl: curlOf(http) }],
  });

  if (LONG_INTENTS.has(intent)) {
    if (hasRunningTask(project.id)) {
      return { ok: false, pending: false, error: '已有一个长任务在执行，请等它完成再发下一条指令', userSeq: user.seq };
    }
    const taskId = uid('pchat');
    TASKS.set(taskId, { id: taskId, projectId: project.id, intent, status: 'running', startedAt: Date.now() });
    // 先落一条「已开始」助手消息，保证对话记录里能看到任务被触发的时间点
    appendMessage(project, {
      role: 'assistant', intent,
      text: `⏳ 已开始「${STEP_BY_ID[intent]?.label || intent}」。真实 ComfyUI / 六步链路可能耗时数分钟，完成后我会把结果与调用记录写回这里。`,
      calls: [{ name: '后台任务', taskId, ...http, curl: curlOf(http) }],
    });
    emit('production:chat', { projectId: project.id, type: 'task-start', taskId, intent });
    setImmediate(async () => {
      const fresh = loadProject(project.id) || project;
      let result;
      try {
        result = await executeIntent({ project: fresh, intent, params, modelId, log });
      } catch (err) {
        result = { reply: `✗ 执行失败：${err.message}`, calls: [], artifacts: [], suggestions: ['现在做到哪一步了？'], durationMs: 0 };
        log('error', `制片对话任务异常：${err.message}`);
      }
      const rec = appendMessage(fresh, {
        role: 'assistant', intent, params, text: result.reply,
        calls: [{ name: '等价 HTTP 请求', ...http, curl: curlOf(http) }, ...(result.calls || [])],
        artifacts: result.artifacts, suggestions: result.suggestions,
        durationMs: result.durationMs, ok: !/^✗/.test(result.reply),
      });
      const task = TASKS.get(taskId);
      if (task) { task.status = 'done'; task.finishedAt = Date.now(); task.replySeq = rec.seq; }
      emit('production:chat', { projectId: fresh.id, type: 'task-done', taskId, intent, seq: rec.seq, reply: result.reply });
      emit('state', { projectId: fresh.id, project: fresh, reason: 'production-chat' });
    });
    return {
      ok: true, pending: true, taskId, intent, userSeq: user.seq,
      reply: `⏳ 已开始「${STEP_BY_ID[intent]?.label || intent}」，完成后会自动把结果写回对话。\n等价复刻命令：${curlOf(http)}`,
      suggestions: [],
    };
  }

  const result = await executeIntent({ project, intent, params, modelId, log });
  const rec = appendMessage(project, {
    role: 'assistant', intent, params, text: result.reply,
    calls: [{ name: '等价 HTTP 请求', ...http, curl: curlOf(http) }, ...result.calls],
    artifacts: result.artifacts, suggestions: result.suggestions,
    durationMs: result.durationMs, ok: !/^✗/.test(result.reply),
  });
  return { ok: true, pending: false, seq: rec.seq, intent, reply: result.reply,
    calls: rec.calls, artifacts: result.artifacts, suggestions: result.suggestions,
    state: result.state, durationMs: result.durationMs };
}

/* -------------------------------------------------------------------------- *
 * 导出：Markdown（人读 + 复刻命令）与 JSON（结构化可重放）
 * -------------------------------------------------------------------------- */
export function exportChat(project, format = 'md') {
  const conv = ensureConversation(project);
  const cfg = loadComfyConfig();
  const s = stateSummary(project);
  const meta = {
    projectId: project.id, projectName: project.name, exportedAt: new Date().toISOString(),
    baseUrl: cfg.baseUrl, comfyVideoWorkflow: cfg.videoWorkflowName || null,
    comfyImageWorkflow: cfg.imageWorkflowName || null,
    runtime: s.spec, filmPolicy: s.spec.filmPolicy,
    verification: { complete: s.verification.complete, passed: s.verification.passed,
      degraded: s.verification.degraded, missing: s.verification.missing },
  };
  const steps = conv.messages.map((msg) => ({
    seq: msg.seq, at: new Date(msg.at).toISOString(), role: msg.role, text: msg.text,
    intent: msg.intent, params: msg.params, calls: msg.calls,
    artifacts: msg.artifacts, durationMs: msg.durationMs, ok: msg.ok,
    curl: (msg.calls || []).find((c) => c.curl)?.curl || null,
  }));
  if (format === 'json') {
    return { contentType: 'application/json; charset=utf-8', filename: `${project.id}-chat.json`,
      body: JSON.stringify({ ...meta, steps }, null, 2) };
  }

  const lines = [
    `# 灵犀漫剧 · AI 制片对话复刻记录`,
    '',
    `- 项目：**${project.name}**（\`${project.id}\`）`,
    `- 导出时间：${meta.exportedAt}`,
    `- ComfyUI：\`${cfg.baseUrl}\` · 图片工作流 \`${meta.comfyImageWorkflow || '未配置'}\` · 视频工作流 \`${meta.comfyVideoWorkflow || '未配置'}\``,
    `- 成片规格：${s.spec.totalSeconds}s ÷ ${s.spec.clipSeconds}s = ${s.spec.clipCount} 片段 @ ${s.spec.fps}fps · **${s.spec.filmPolicy === 'real' ? '真实 AI 视频' : '关键帧预览（非 AI 视频）'}**`,
    `- 最终验收：${s.verification.passed} 达成 / ${s.verification.degraded} 降级 / ${s.verification.missing} 缺失 · ${s.verification.complete ? '全部必需项达成' : '尚未全部达成'}`,
    '',
    `> 复刻方式：把下面每步的 \`{projectId}\` 换成你自己的项目 ID，\`curl\` 里的端口换成你启动服务的端口。`,
    `> 真实 AI 视频要求：ComfyUI 可达，且已在「设置 → ComfyUI」导入「导出(API)」格式的图片与视频工作流。`,
    '',
    `## 一、完整对话流程`,
    '',
  ];
  for (const st of steps) {
    lines.push(`### ${st.seq}. ${st.role === 'user' ? '🧑 用户' : '🤖 制片助手'}${st.intent ? ` · 意图 \`${st.intent}\`` : ''}`);
    lines.push('');
    lines.push('```text');
    lines.push(st.text);
    lines.push('```');
    lines.push('');
    if (st.params && Object.keys(st.params).length) lines.push(`参数：\`${JSON.stringify(st.params)}\`  `);
    if (st.durationMs) lines.push(`耗时：${(st.durationMs / 1000).toFixed(1)}s  `);
    const real = (st.calls || []).filter((c) => c.path && !c.taskId);
    if (real.length) {
      lines.push('实际调用：');
      lines.push('');
      for (const c of real) lines.push(`- \`${c.method} ${c.path}\` — ${c.name}${c.ok === false ? '（失败）' : ''}`);
      lines.push('');
    }
    if (st.curl) {
      lines.push('等价复刻命令：');
      lines.push('');
      lines.push('```bash');
      lines.push(st.curl.replace(project.id, '{projectId}'));
      lines.push('```');
      lines.push('');
    }
    if (st.artifacts?.length) {
      lines.push(`产物：${st.artifacts.map((a) => `[${a.label}](${a.url.replace(project.id, '{projectId}')})`).join(' · ')}`);
      lines.push('');
    }
  }
  lines.push('## 二、一键复刻命令串（按顺序执行）', '');
  lines.push('```bash');
  lines.push(`# 0) 启动服务（端口按实际替换）`);
  lines.push(`PORT=4599 node server.mjs`);
  lines.push(`PROJECT={projectId}`);
  lines.push('');
  for (const st of steps) {
    if (st.role !== 'user' || !st.curl) continue;
    lines.push(`# ${st.seq}. ${st.text.replace(/\n/g, ' ').slice(0, 60)}`);
    lines.push(st.curl.replace(project.id, '{projectId}').replace(/:4599/g, ':4599'));
    lines.push('');
  }
  lines.push('```', '');
  lines.push('## 三、环境要求与诚实化说明', '');
  lines.push('1. **真实模式（默认）**：每个片段都必须由 ComfyUI 视频工作流生成；少一段、或成片是 ffmpeg 关键帧预览，验收一律判「缺失」，不会冒充真实短剧。');
  lines.push('2. **关键帧预览模式**：显式说「使用关键帧预览模式」才启用，产物是静态帧等长拼接，验收记为「降级」，不是 AI 视频。');
  lines.push('3. **零 Key LLM**：小说 / 剧本 / 导演阐述会标 `mock` / `heuristic`，不冒充模型生成；配置模型后重跑即可覆盖。');
  lines.push('4. **GPU 时间**：MiniMax H3 等视频工作流单片段可能需数分钟，10 片段 × 3s 的 30s 短剧请预留约 10 倍单段耗时。');
  lines.push('5. 导出的 JSON 含每一步的 `intent / params / calls / curl / artifacts`，可直接被脚本重放。');
  lines.push('');
  return { contentType: 'text/markdown; charset=utf-8', filename: `${project.id}-chat.md`, body: lines.join('\n') };
}
