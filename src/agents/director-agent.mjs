// 导演智能体：项目选择一项「导演技能」后，由它一口气把最终产物的全流程跑完。
//
// 与画布节点型 Agent 的区别：它是流程型 Agent（Process Agent），不产出单个节点，
// 而是复用现有业务 Agent 与六步状态机，做四件事：
//   ① 前置保障：没有原著时按一句话构想生成演示小说（零 Key 明确标注模板来源）
//   ② 技能能力：创作设定 / 导演阐述 / 角色提取 / 音色分配，按技能声明真实写回项目
//   ③ 主流程：按技能的步骤范围调用 executeSteps，逐步调度真实智能体链路
//   ④ 收尾：补齐导演包（可强制按当前画布重打）→ 逐项验收最终产物 → 写运行报告
//
// 诚实化原则与角色提取 Agent 一致：零 Key / 回退一律标 heuristic，不冒充 LLM 成果；
// Mock 模式没有真实 MP4 时验收项标 degraded，绝不算「成片已生成」。
import { defineAgent } from '../core/agent.mjs';
import { createProviders } from '../core/providers.mjs';
import { resolveModelSettings } from '../core/app-settings.mjs';
import { saveProject } from '../core/store.mjs';
import { emit } from '../core/events.mjs';
import { ensureManagement, applyManageAction, stepProgress } from '../core/project-steps.mjs';
import { listDirectorSkills, getDirectorSkill, normalizeDirectorSkillId,
  planDirectorRun, verifyDirectorDeliverables, ensureDirectorState,
  CAP_BY_ID, skillAesthetic } from '../core/director-skills.mjs';
import { aestheticTreatment, resolveProjectAesthetic, paceLabel } from '../core/director-styles.mjs';
import { executeSteps, broadcastMeta, ensureDirectorPack } from '../core/step-runner.mjs';
import { attachSource } from '../pipelines/novel-project.mjs';
import { mergeExtracted } from '../core/characters.mjs';
import { extractProjectCharacters } from './character-agent.mjs';
import { ensureProjectPortraits } from './character-portrait-agent.mjs';
import { assignVoices } from './voice-agent.mjs';

export { listDirectorSkills, planDirectorRun, verifyDirectorDeliverables };

/** 阶段进度：SSE 推给工作台，前端只更新文案与进度条，不重建 DOM */
function directorEvent(projectId, phase, label, extra = {}) {
  emit('director:progress', { projectId, phase, label, at: Date.now(), ...extra });
}

function short(v, n) { return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n); }
/** 正文只裁首尾空白，保留段落换行（压缩空白会毁掉小说分段） */
function trimText(v, n) { return String(v ?? '').trim().slice(0, n); }

/** LLM 输出归一：字段缺失不编造，用项目里真实存在的资料补齐，并限制长度 */
function normalizeTreatment(raw, vars) {
  const list = (v, fallback) => {
    const items = (Array.isArray(v) ? v : []).map((x) => short(x, 160)).filter(Boolean).slice(0, 5);
    return items.length ? items : fallback;
  };
  return {
    title: short(raw?.title, 60) || `《${vars.title}》导演阐述`,
    logline: short(raw?.logline, 160) || short(vars.logline, 160),
    tone: short(raw?.tone, 120) || '情绪递进克制、关键段落留白',
    visualStyle: short(raw?.visualStyle, 200) || `${vars.style || 'cinematic'} 画风`,
    pacing: short(raw?.pacing, 200) || '建立空间 → 冲突升级 → 结尾钩子，单镜头 4–6 秒',
    shotStrategy: short(raw?.shotStrategy, 240) || '先全景建立关系，再过肩与特写交替；遵守 180 度轴线',
    audioStrategy: short(raw?.audioStrategy, 200) || '对白优先，环境声压低，转场保留连续底噪',
    continuityRules: list(raw?.continuityRules, [
      '角色造型与主配色跨镜头一致', '同场戏光位与色温不跳变', '遵守 180 度轴线', '首帧承接上一镜头尾帧',
    ]),
    risks: list(raw?.risks, ['人物身份漂移：用定妆参考图锁定', '镜头衔接断裂：生成跨机位转场']),
  };
}

/**
 * 技能能力 ①：创作设定补全（只在关键字段为空时写，不覆盖用户已填内容）
 */
async function runBibleCapability({ project, m, idea, settings, providers, log, signal }) {
  const b = m.bible || {};
  if (b.logline && b.genre && b.worldview) {
    return { status: 'skipped', reason: '创作设定已完整，保留用户填写内容' };
  }
  const seed = short(idea || b.logline || b.firstEpisodeTheme || project.name, 300);
  if (!seed) return { status: 'skipped', reason: '没有可用于补全的一句话构想' };
  const out = await providers.generate('storyIdea', {
    idea: seed, title: b.title || project.name, style: settings.style,
  }, signal);
  const patch = {};
  for (const key of ['genre', 'audience', 'tone', 'artStyle', 'firstEpisodeTheme', 'worldview']) {
    if (!b[key] && out?.[key]) patch[key] = short(out[key], key === 'worldview' ? 1000 : 300);
  }
  if (!b.logline && out?.logline) patch.logline = short(out.logline, 300);
  if (!Object.keys(patch).length) return { status: 'skipped', reason: '模型未给出可补字段' };
  const applied = applyManageAction(project, 'bible', patch);
  return {
    status: applied.ok ? 'ran' : 'skipped',
    reason: applied.ok ? `补全 ${Object.keys(patch).length} 个创作设定字段` : applied.message,
    source: providers.mode === 'openai' && !out?.__fallback && !(out?.__mockKeys || []).length ? 'llm' : 'heuristic',
    fields: Object.keys(patch),
  };
}

/** 技能能力 ②：导演阐述（写入 m.director.treatment，作为全片一致性纲领） */
async function runTreatmentCapability({ project, m, settings, providers, log, signal, force }) {
  const prev = m.director?.treatment;
  const aesthetic = skillAesthetic(m.director?.skillId, { paletteKey: m.director?.paletteKey });
  // 换了导演风格就必须重写阐述：沿用旧阐述会让「选了北野武却拿到通用方案」，
  // 所以只有「同技能 + 同风格 + 非 force」才沿用。
  // 主色也算风格的一部分：张艺谋从英雄红切到竹林绿，画面基准变了，阐述里的
  // visualStyle（主色 + 色号）必须跟着改，否则项目里存的是过期主色。
  const sameStyle = !aesthetic
    || (prev?.styleId === aesthetic.id && (prev?.paletteKey || null) === (aesthetic.paletteKey || null));
  if (prev && !force && sameStyle) {
    prev.skillId = m.director?.skillId || prev.skillId;   // 换技能重跑时归属跟随当前策略
    return { status: 'kept', reason: '沿用上次导演阐述', source: prev.source };
  }
  const b = m.bible || {};
  const vars = {
    title: b.title || project.name || '未命名影片',
    logline: b.logline || m.source?.title || '',
    genre: b.genre || '', style: settings.style || project.settings?.style || 'cinematic',
    episodes: m.episodes || [], characters: m.characters || [],
    deliverables: m.deliverables || { video: true, pack: true },
  };
  const out = await providers.generate('directorTreatment', {
    title: vars.title, logline: vars.logline, genre: vars.genre, style: vars.style,
    idea: vars.logline, episodes: vars.episodes.slice(0, 12).map((e) => ({ title: e.title, summary: short(e.summary, 120) })),
    characters: vars.characters.slice(0, 12).map((c) => ({ name: c.name, role: c.role })),
    // 风格档案作为约束下发给 LLM：让它按该导演的光线 / 构图 / 节奏写方案，而不是自由发挥
    aesthetic: aesthetic ? {
      label: aesthetic.label, director: aesthetic.director, tagline: aesthetic.tagline,
      palette: `${aesthetic.paletteName} ${aesthetic.paletteHex}`, colorRule: aesthetic.colorRule,
      light: aesthetic.light, composition: aesthetic.composition,
      camera: aesthetic.camera, texture: aesthetic.texture, pace: paceLabel(aesthetic.pace),
      taboos: aesthetic.taboos,
    } : null,
  }, signal);
  const isMock = providers.mode !== 'openai' || Boolean(out?.__fallback) || (out?.__mockKeys || []).length > 0;
  // 零 Key / 回退时直接用风格档案基线：不再走通用模板，否则选谁都是同一份阐述。
  // 关键点：模板输出（isMock）不能盖掉基线——mockGenerate 的 visualStyle 是
  // 「cinematic 画风 · 冷暖对比布光」这类通用文案，一旦整份合并进去，
  // 十位导演又变成同一份阐述。模板只借与用户内容相关的 title / logline。
  const base = (isMock && aesthetic) ? aestheticTreatment(aesthetic.id, vars, { paletteKey: m.director?.paletteKey }) : null;
  let body;
  if (base) {
    const patch = {};
    for (const key of ['title', 'logline']) {
      const v = out?.[key];
      if (typeof v === 'string' && v.trim()) patch[key] = short(v, 200);
    }
    body = { ...base, ...patch };
  } else {
    // 真实 LLM 输出优先，缺失的字段才由 normalizeTreatment 兜底
    body = { ...normalizeTreatment(out, vars), ...pickDefined(out) };
  }
  const treatment = {
    ...body,
    source: isMock ? 'heuristic' : 'llm',
    skillId: m.director?.skillId || 'full',
    styleId: aesthetic?.id || null,
    styleLabel: aesthetic?.label || null,
    paletteKey: aesthetic?.paletteKey || null,
    updatedAt: Date.now(),
  };
  m.director.treatment = treatment;
  log('info', `导演阐述已生成（${treatment.source === 'llm' ? 'LLM' : '内置模板'}）${aesthetic ? ` · 风格「${aesthetic.workTitle}」` : ''}`);
  return {
    status: 'ran', source: treatment.source, title: treatment.title,
    reason: aesthetic ? `${aesthetic.workTitle} · ${aesthetic.paletteName} · ${paceLabel(aesthetic.pace)}` : treatment.logline,
    styleId: aesthetic?.id || null,
  };
}

/** LLM 真实输出的字段优先，缺失的才由风格基线兜底（不拿模板覆盖模型写的内容） */
function pickDefined(out) {
  const patch = {};
  for (const key of ['title', 'logline', 'tone', 'visualStyle', 'pacing', 'shotStrategy', 'audioStrategy']) {
    const v = out?.[key];
    if (typeof v === 'string' && v.trim()) patch[key] = short(v, key === 'shotStrategy' ? 240 : 200);
  }
  if (Array.isArray(out?.continuityRules) && out.continuityRules.length) {
    patch.continuityRules = out.continuityRules.map((x) => short(x, 160)).filter(Boolean).slice(0, 5);
  }
  if (Array.isArray(out?.risks) && out.risks.length) {
    patch.risks = out.risks.map((x) => short(x, 160)).filter(Boolean).slice(0, 3);
  }
  return patch;
}

/** 技能能力 ③：角色提取（复用角色提取 Agent，路由与导演走同一口径） */
async function runCharactersCapability({ project, m, settings, modelId, log, signal }) {
  if (!m.source?.text) return { status: 'skipped', reason: '尚未准备原著' };
  const r = await extractProjectCharacters({
    project, m, mode: 'llm', modelId, signal,
    log: (level, msg) => log(level, `导演 · ${msg}`),
  });
  if (!r.ok) return { status: 'skipped', reason: r.error };
  const merged = mergeExtracted(m.characters || [], r.extracted, { source: r.source });
  applyManageAction(project, 'characters', merged.characters);
  return {
    status: 'ran', source: r.source, added: merged.added, merged: merged.merged,
    stats: r.stats, reason: r.message,
  };
}

/** 技能能力 ④：音色分配（复用音色 Agent，写回 voiceId 供角色界面试听） */
/**
 * 角色定妆能力：把「角色提取」拿到的人设真正落成可视定妆资产。
 *
 * 为什么必须放在 characters 之后、voices 之前：定妆图是后续关键帧 / 镜头片段 /
 * 导演包的唯一身份参考来源。过去一键全流程只提取角色、不产出定妆，于是下游只能
 * 拿文字描述去生成画面 —— 这是「角色明明建了却还是不像」的根因。
 *
 * 默认 scope='all'（5 视图）+ 定妆板：一次把视频需要的角度备齐，避免下游取不到脸部参考。
 * 单张失败不阻断能力整体：MOCK/缺失的图由完整度如实汇总，导演报告里能看出缺什么。
 */
async function runPortraitsCapability({ project, m, settings, modelId, log, signal }) {
  const chars = m.characters || [];
  if (!chars.length) return { status: 'skipped', reason: '还没有角色，跳过定妆生成' };
  const r = await ensureProjectPortraits({
    project, m,
    scope: 'all', onlyMissing: true, sheet: true,
    modelId,
    signal,
    log: (level, msg) => log(level, `导演 · ${msg}`),
    save: () => {},
    onProgress: (evt) => directorEvent(project.id, 'progress',
      `定妆 ${evt.done}/${evt.total} · ${evt.name || ''}${evt.label || ''}`,
      { stage: 'characters', done: evt.done, total: evt.total }),
  });
  const generated = r.generated || 0;
  const sheets = r.sheets || 0;
  const ready = r.videoReady || {};
  const reason = [
    r.message || '',
    ready.label || '',
    (r.failed && r.failed.length) ? `失败 ${r.failed.length} 张：${r.failed.slice(0, 2).join('；')}` : '',
  ].filter(Boolean).join(' · ');
  return {
    // 一张都没生成（全已存在）时算 kept 而不是 skipped：已有定妆同样满足下游需求
    status: generated || sheets ? 'ran' : (r.ok === false && r.error ? 'error' : 'kept'),
    source: 'image',
    generated, sheets, skipped: r.skipped || 0,
    failed: r.failed || [],
    styleLock: r.styleLock?.label || '',
    videoReady: ready,
    portraitStatus: r.portraitStatus,
    reason: r.error || reason,
  };
}

async function runVoicesCapability({ project, m, settings, modelId, log, signal }) {
  const chars = m.characters || [];
  if (!chars.length) return { status: 'skipped', reason: '还没有角色，跳过音色分配' };
  const r = await assignVoices({ project, m, modelId, signal, log: (level, msg) => log(level, `导演 · ${msg}`) });
  return { status: r.applied ? 'ran' : 'skipped', source: r.source, applied: r.applied, reason: r.message };
}

/**
 * 前置保障：没有原著时，用一句话构想生成演示小说并注入项目（等价于「准备故事」+「分集拆解」）。
 * 零 Key 时由内置模板生成，明确标 source='mock'，绝不假称 AI 原创。
 */
export async function ensureDirectorSource({ project, m, idea, settings, modelId, log, signal }) {
  if (m.source?.text) {
    return { ok: true, source: 'existing', title: m.source.title, episodes: (m.episodes || []).length };
  }
  const seed = short(idea || m.bible?.logline || m.bible?.firstEpisodeTheme, 300);
  if (!seed) {
    return {
      ok: false,
      error: '项目还没有原著：请先在「准备故事」上传小说，或在导演面板填写一句话构想让导演 Agent 生成演示小说',
    };
  }
  log('info', `导演 Agent · 项目缺少原著，按构想「${short(seed, 24)}」生成演示小说`);
  const providers = createProviders(resolveModelSettings(project, modelId),
    (level, msg) => log(level, `导演 · 生成原著 · ${msg}`));
  const outlineRaw = await providers.generate('novelOutline', {
    idea: seed, title: project.name, chapterCount: 3, style: settings.style,
  }, signal);
  const chapters = (Array.isArray(outlineRaw?.chapters) ? outlineRaw.chapters : [])
    .map((c, i) => ({
      title: short(c?.title, 46) || `第${i + 1}章`,
      summary: short(c?.summary, 200), hook: short(c?.hook, 120),
    })).filter((c) => c.title).slice(0, 3);
  if (!chapters.length) return { ok: false, error: '未能生成有效的分章大纲，请手动上传小说' };
  const parts = [];
  for (const [i, ch] of chapters.entries()) {
    const out = await providers.generate('novelChapter', {
      idea: seed, title: short(outlineRaw?.title, 40) || project.name,
      chapterTitle: ch.title, summary: ch.summary, hook: ch.hook,
      chapterChars: 700, index: i, total: chapters.length, style: settings.style,
    }, signal);
    const text = trimText(out?.text, 100000);
    if (text.length < 40) return { ok: false, error: `「${ch.title}」正文生成过短，请手动上传小说` };
    parts.push(`${ch.title}\n${text}`);
  }
  const title = short(outlineRaw?.title, 40) || `${project.name} · 演示小说`;
  const r = attachSource(project, {
    text: `${title}\n\n${parts.join('\n\n')}`,
    filename: `${title}.txt`, split: m.split,
  });
  return {
    ok: true,
    source: providers.mode === 'openai' && !outlineRaw?.__fallback ? 'llm' : 'mock',
    title: r.novel.title, chapters: r.novel.chapterCount,
    episodes: r.episodes.length, message: r.message,
  };
}

/**
 * 执行一次导演技能全流程。
 * @param {object} opts { project, skillId?, modelId?, idea?, force?, log?, progress?, signal? }
 * @returns {Promise<object>} 运行报告（含计划、能力明细、步骤结果、验收清单）
 */
export async function runDirector({
  project, skillId = '', modelId = '', idea = '', force = false,
  log = () => {}, progress = () => {}, signal,
} = {}) {
  const t0 = Date.now();
  if (!project) return { ok: false, error: '项目不存在' };
  const m = ensureManagement(project);
  if (m.kind !== 'novel') {
    return { ok: false, error: '导演智能体只作用于小说创作项目（标准流水线请用顶栏「运行完整流水线」）' };
  }
  const director = ensureDirectorState(m);
  const resolvedId = normalizeDirectorSkillId(skillId || director.skillId);
  const skill = getDirectorSkill(resolvedId);
  const planned = planDirectorRun({ project, m, skillId: resolvedId, force });
  const plan = planned.plan;
  const projectId = project.id;
  const capabilities = [];
  const stages = [];
  const pushStage = (phase, label, index, total) => {
    stages.push({ phase, label, at: Date.now() });
    directorEvent(projectId, phase, label, { index, total, status: 'running', skillId: resolvedId });
    progress(index / total, label);
  };
  const totalPhases = 3 + (skill.capabilities || []).length;
  let phaseIndex = 0;

  // ① 保存项目级技能选择 + 同步该技能锁定的交付设置
  pushStage('setup', `载入「${skill.label}」技能`, ++phaseIndex, totalPhases);
  // 主色必须在写入技能之前抓下来：applyManageAction('director-skill') 会把 paletteKey
  // 归零（换导演清主色），先读后写才能保住用户选的「竹林绿」这类主色。
  const wantedPalette = m.director?.paletteKey || '';
  applyManageAction(project, 'director-skill', { skillId: resolvedId });
  if (skill.deliverables) applyManageAction(project, 'deliverables', skill.deliverables);
  // 风格技能把 styleId 写进项目：后续出图 / 分镜 / 导演包都按这一份美学走
  const aesthetic = skillAesthetic(resolvedId, { paletteKey: wantedPalette });
  if (aesthetic) {
    const d = ensureDirectorState(project.management);
    d.styleId = aesthetic.id;
    d.paletteKey = aesthetic.paletteKey;
  }
  saveProject(project);
  broadcastMeta(project);
  log('info', `导演技能「${skill.label}」${aesthetic ? ` · 风格档案 ${aesthetic.paletteName} · ${paceLabel(aesthetic.pace)}` : ' · 沿用项目画面设置'}`);

  // ② 前置保障：原著 / 分集
  pushStage('source', '确认原著与分集', ++phaseIndex, totalPhases);
  const settings = resolveModelSettings(project, modelId);
  // 风格注入 Provider：正向提示词追加风格串、负向追加否定词、Mock 出图换调色板
  settings.aesthetic = aesthetic;
  let sourceInfo;
  try {
    sourceInfo = await ensureDirectorSource({ project, m, idea, settings, modelId, log, signal });
  } catch (err) {
    sourceInfo = { ok: false, error: `生成演示原著失败：${err.message}` };
  }
  if (!sourceInfo.ok) {
    directorEvent(projectId, 'blocked', sourceInfo.error, { status: 'blocked', skillId: resolvedId });
    return { ok: false, error: sourceInfo.error, blocked: 'source', skillId: resolvedId, plan };
  }
  // attachSource 可能重建了 management 中的角色 / 步骤，重新取一次引用
  const m2 = ensureManagement(project);
  const director2 = ensureDirectorState(m2);
  director2.skillId = resolvedId;
  saveProject(project);
  broadcastMeta(project);
  emit('state', { projectId, project, reason: 'director-source' });

  const providers = createProviders(settings, (level, msg) => log(level, `导演 · ${msg}`));
  // ③ 技能能力：每项都真实调用对应业务 Agent，并记录 ran / kept / skipped 与来源
  for (const capId of skill.capabilities || []) {
    const cap = CAP_BY_ID[capId] || { id: capId, label: capId };
    pushStage(`cap:${capId}`, cap.label, ++phaseIndex, totalPhases);
    try {
      let r;
      if (capId === 'bible') r = await runBibleCapability({ project, m: m2, idea, settings, providers, log, signal });
      else if (capId === 'treatment') r = await runTreatmentCapability({ project, m: m2, settings, providers, log, signal, force });
      else if (capId === 'characters') r = await runCharactersCapability({ project, m: m2, settings, modelId, log, signal });
      else if (capId === 'portraits') r = await runPortraitsCapability({ project, m: m2, settings, modelId, log, signal });
      else if (capId === 'voices') r = await runVoicesCapability({ project, m: m2, settings, modelId, log, signal });
      else r = { status: 'skipped', reason: '未实现的能力' };
      capabilities.push({ id: capId, label: cap.label, ...r });
      log(r.status === 'ran' ? 'info' : 'warn', `导演能力「${cap.label}」：${r.status} · ${r.reason || ''}`);
    } catch (err) {
      capabilities.push({ id: capId, label: cap.label, status: 'error', reason: err.message });
      log('warn', `导演能力「${cap.label}」失败：${err.message}`);
    }
    saveProject(project);
    broadcastMeta(project);
  }

  // ④ 主流程：按技能声明的步骤链逐步调度真实智能体
  pushStage('pipeline', '执行制作步骤链', ++phaseIndex, totalPhases);
  let stepResult = { executed: [], progress: stepProgress(m2) };
  // 所有步骤已完成时 plan.runStepIds 为空（例如换技能只做交付侧重打包），
  // 不再空调编排器，避免「未知步骤：null」的假失败。
  if (plan.runStepIds.length) {
    try {
      stepResult = await executeSteps(project, { steps: plan.runStepIds, force: !!force });
    } catch (err) {
      log('error', `制作步骤链异常：${err.message}`);
      stepResult = { ok: false, executed: [], error: err.message, progress: stepProgress(m2) };
    }
  } else {
    log('info', '制作步骤已全部完成，本次只重跑技能能力与最终产物核对');
  }

  // ⑤ 收尾：补齐 / 重打导演包
  pushStage('deliver', '核对最终产物', ++phaseIndex, totalPhases);
  let repack = null;
  if (skill.repack && m2.deliverables?.pack) {
    try {
      repack = ensureDirectorPack(project, { force: !!skill.repackForce || !!force });
      if (repack?.file) log('info', `导演包已就绪 · ${repack.fileCount || 0} 个文件`);
    } catch (err) {
      log('warn', `导演包生成失败：${err.message}`);
    }
  }
  const verification = verifyDirectorDeliverables(project, skill);

  // ⑥ 写运行报告（项目级持久化，工作台刷新后仍能看到上次验收结果）
  const durationMs = Date.now() - t0;
  const stepErrors = (stepResult.executed || []).filter((s) => s.status === 'error');
  const ok = verification.complete && stepErrors.length === 0 && !stepResult.error;
  const report = {
    ok, at: Date.now(), skillId: resolvedId, skillLabel: skill.label,
    durationMs, source: sourceInfo, capabilities,
    steps: stepResult.executed || [], stepProgress: stepResult.progress || stepProgress(m2),
    // 步骤链根本没启动时（已有运行中的任务 / 项目类型不符）executed 是空的，
    // 只报「有 6 项最终产物未达成」会把真正原因藏起来，用户完全不知道该去停哪个任务。
    error: stepResult.error || stepErrors[0]?.note || null,
    deliverables: { ...(m2.deliverables || {}) }, repack: repack?.file || null,
    checklist: verification.items, passed: verification.passed,
    degraded: verification.degraded, missing: verification.missing,
    complete: verification.complete, summary: verification.summary,
    message: ok
      ? `「${skill.label}」已完成全流程 · ${verification.summary}`
      : stepResult.error
        ? `制作步骤未能启动：${stepResult.error}`
        : stepErrors.length
          ? `制作步骤中断：${stepErrors[0].note || '请查看步骤状态'}`
          : verification.summary,
  };
  director2.lastRun = report;
  logHistory(m2, 'director:run', `导演技能「${skill.label}」· ${ok ? '完成' : '未完全达成'} · ${verification.summary}`);
  saveProject(project);
  broadcastMeta(project);
  emit('state', { projectId, project, reason: 'director' });
  directorEvent(projectId, 'done', report.message, {
    status: ok ? 'done' : 'error', skillId: resolvedId, index: totalPhases, total: totalPhases,
    complete: verification.complete, missing: verification.missing, degraded: verification.degraded,
  });
  progress(1, report.message);

  // 只回传精简状态：management 里含整本原著全文，绝不能塞进 HTTP 响应
  return {
    ok, ...report, plan, skill: planned.skill,
    director: { skillId: director2.skillId, treatment: director2.treatment, lastRun: director2.lastRun },
    stats: {
      nodeCount: (project.nodes || []).length,
      film: (project.nodes || []).find((n) => n.type === 'final')?.data?.film?.file || null,
      pack: repack?.file || (project.nodes || []).find((n) => n.type === 'final')?.data?.directorPack?.file || null,
    },
  };
}

/** m.history 是 project-steps 的统一审计轨，这里复用同一个结构 */
function logHistory(m, action, detail) {
  m.history = [{ id: `h_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(), action, detail }, ...(m.history || [])].slice(0, 60);
  m.updatedAt = Date.now();
}

// 注册为智能体列表里的一等公民：可在画布作为「导演」节点运行，也可由项目级 API 直接调度
defineAgent({
  id: 'director',
  label: '导演智能体',
  group: '导演',
  icon: '🎬',
  color: '#ff8a4c',
  description: '按项目选择的导演技能，串起创作设定 / 导演阐述 / 角色与音色、六步制作链路与最终产物验收，一键跑完整部漫剧。',
  async run(ctx) {
    const project = ctx.project;
    const skillId = ctx.node?.data?.skillId || project.management?.director?.skillId || 'full';
    ctx.progress(0.1);
    ctx.log('info', `导演智能体启动 · 技能「${skillId}」`);
    const result = await runDirector({
      project, skillId,
      idea: ctx.node?.data?.idea || '',
      log: (level, msg) => ctx.log(level, msg),
      progress: (v) => ctx.progress(v),
      signal: ctx.signal,
    });
    ctx.patch({
      skillId, ok: result.ok, complete: result.complete,
      summary: result.message, passed: result.passed,
      degraded: result.degraded, missing: result.missing,
    });
    ctx.progress(1);
    ctx.log(result.ok ? 'info' : 'warn', result.message || result.error);
    return result;
  },
});
