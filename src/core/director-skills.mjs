/* ============================================================================
 * 导演 Agent 技能（Director Skills）· 纯逻辑层
 *
 * 「项目可以选择导演技能」：技能不是文案标签，而是一份可执行的制片策略声明，
 * 由 src/agents/director-agent.mjs 逐项落实：
 *   capabilities  —— 主流程之前额外调度的业务 Agent（真实写回项目）
 *   deliverables  —— 该技能锁定的最终产物组合（会同步项目交付设置）
 *   steps         —— 允许编排器执行的制作步骤范围
 *   repack/verify —— 收尾是否补齐导演包、是否生成验收清单
 *
 * 本文件不含任何 IO：计划 / 验收清单都是纯函数，便于单元测试与前端预览。
 * ==========================================================================*/
import { STEPS, stepProgress } from './project-steps.mjs';
import { resolveRuntimeSpec, verifyRuntime } from './runtime-spec.mjs';
import { evaluateFilm, isRealClip, normalizeFilmPolicy } from './film-policy.mjs';
import { DIRECTOR_STYLES, getDirectorStyle, normalizeStyleId, styleCard, resolveAesthetic } from './director-styles.mjs';

/** 能力清单：每一项都对应一个真实存在的业务函数，见 director-agent.mjs */
export const DIRECTOR_CAPABILITIES = [
  { id: 'bible', icon: '✦', label: '创作设定补全', desc: '按一句话构想补齐剧名 / 类型 / 基调 / 世界观' },
  { id: 'treatment', icon: '🎬', label: '导演阐述', desc: '生成全片视听方案：节奏、镜头策略、声音与一致性约束' },
  { id: 'characters', icon: '🧬', label: '角色提取', desc: '原文证据驱动的角色候选与占位设定（零 Key 如实标注）' },
  { id: 'portraits', icon: '🎭', label: '角色定妆', desc: '按全片风格锁生成多视图定妆（正面 / 3-4 侧 / 侧面 / 背面 / 面部特写）+ 定妆板，供关键帧与导演包取参考' },
  { id: 'voices', icon: '🔊', label: '音色分配', desc: '从音色库为每位角色匹配音色，可逐条试听' },
];

export const CAP_BY_ID = Object.fromEntries(DIRECTOR_CAPABILITIES.map((c) => [c.id, c]));

/** 步骤范围：all = 六步全链路；core = 只跑智能体链（跳过已由服务端完成的 auto 步骤） */
export const DIRECTOR_STEP_MODES = {
  all: { label: '完整六步', desc: '逐项确认 ①上传 → ②分集 → ③剧本 → ④上下文 → ⑤分镜 → ⑥交付' },
  core: { label: '智能体四步', desc: '专注 ③剧本 → ④上下文 → ⑤分镜 → ⑥交付，auto 步骤沿用现有结果' },
};

/**
 * 技能分组：流程策略只管「交付什么 / 跑哪些步骤」，导演风格还额外决定「画面长什么样」。
 * 前端的技能卡按这个分组渲染，两种技能不要混在一格里。
 */
export const DIRECTOR_SKILL_GROUPS = {
  flow: { id: 'flow', label: '制片流程策略', desc: '决定交付物组合与执行步骤范围，不改变画面美学' },
  style: { id: 'style', label: '导演风格', desc: '把一位导演的视听语法注入导演阐述与画面生成，真正改变成片的样子' },
};

/** 四份流程策略 */
const FLOW_SKILLS = [
  {
    id: 'full', icon: '🎬', label: '全流程导演', tagline: '一键成片 · 从原著到双产物',
    summary: '串起全部六个制作步骤：先补齐导演阐述、角色库与音色，再逐阶段调度智能体，最后核对导演包与成片。适合第一次把项目跑到底。',
    capabilities: ['treatment', 'characters', 'portraits', 'voices'],
    deliverables: null,   // 沿用项目自己的交付设置
    steps: 'all', repack: true, verify: true,
    highlights: ['导演阐述', '角色 / 音色', '六步全跑', '双产物验收'],
  },
  {
    id: 'script', icon: '▤', label: '剧本精修导演', tagline: '先把故事立住，再进画面',
    summary: '在全流程之前先补齐创作设定（剧名 / 类型 / 世界观 / 基调），并做导演阐述、角色与音色，让剧本与上下文阶段拿到的信息更完整。',
    capabilities: ['bible', 'treatment', 'characters', 'portraits', 'voices'],
    deliverables: null,
    steps: 'all', repack: true, verify: true,
    highlights: ['创作设定', '导演阐述', '角色 / 音色', '六步全跑'],
  },
  {
    id: 'visual', icon: '⌗', label: '视觉一致性导演', tagline: '锁定画风，专注画面链',
    summary: '锁定「成片视频 + 导演包」双产物，只编排智能体四步（剧本 → 上下文 → 分镜 → 交付），并强制按当前画布重新打包，方便反复调整画面后重出交接包。',
    capabilities: ['treatment', 'characters', 'portraits', 'voices'],
    deliverables: { video: true, pack: true },
    steps: 'core', repack: true, repackForce: true, verify: true,
    highlights: ['双产物锁定', '智能体四步', '画布重打包', '一致性约束'],
  },
  {
    id: 'pack', icon: '▦', label: '交接包导演', tagline: '最快拿可导入的导演包',
    summary: '只产出 *.mmxpack.zip 交接包：同步交付设置跳过本地视频渲染，跳过角色 / 音色等附加 Agent，用最短链路把剧本、分镜与首帧送到 ComfyUI 导演工作台。',
    capabilities: ['treatment'],
    deliverables: { video: false, pack: true },
    steps: 'all', repack: true, verify: true,
    highlights: ['仅导演包', '跳过视频渲染', '最短链路', '可导入导演台'],
  },
].map((s) => ({ ...s, group: 'flow' }));

/**
 * 十位导演风格技能：由美学档案生成，避免清单与档案两处手写漂移。
 * 风格技能的 deliverables 一律为 null —— 只改画面，不动用户已选的交付组合。
 */
const STYLE_SKILLS = DIRECTOR_STYLES.map((style) => ({
  id: style.id, icon: style.icon, label: style.label, tagline: style.tagline,
  summary: style.summary,
  capabilities: ['treatment', 'characters', 'portraits', 'voices'],
  deliverables: null,
  steps: 'all', repack: true, verify: true,
  group: 'style',
  styleId: style.id,
  highlights: (style.highlights || []).slice(0, 4),
}));

export const DIRECTOR_SKILLS = [...FLOW_SKILLS, ...STYLE_SKILLS];

export const SKILL_BY_ID = Object.fromEntries(DIRECTOR_SKILLS.map((s) => [s.id, s]));
export const DEFAULT_DIRECTOR_SKILL = 'full';

/**
 * 未知 / 脏输入一律回落到默认技能，绝不把非法 id 写进项目。
 * 导演风格的 id 及其别名（中文名 / 片名意象 / 英文写法）都收敛到同一项技能。
 */
export function normalizeDirectorSkillId(id) {
  const raw = String(id ?? '').trim();
  if (!raw) return DEFAULT_DIRECTOR_SKILL;
  const lower = raw.toLowerCase();
  if (SKILL_BY_ID[lower]) return lower;
  const styleId = normalizeStyleId(raw);
  return styleId && SKILL_BY_ID[styleId] ? styleId : DEFAULT_DIRECTOR_SKILL;
}

export function getDirectorSkill(id) {
  return SKILL_BY_ID[normalizeDirectorSkillId(id)] || null;
}

/** 该技能对应的导演美学档案（已收敛为含主色 / 节奏 / 否定词的可消费对象）；流程策略技能返回 null */
export function skillAesthetic(id, opts = {}) {
  return resolveAesthetic(getDirectorSkill(id)?.styleId || '', opts);
}

export function isStyleSkill(id) {
  return Boolean(getDirectorSkill(id)?.styleId);
}

/** 给 bootstrap / 工作台用的投影：补齐能力元数据与步骤模式说明，不含内部函数 */
export function directorSkillPublic(skill) {
  if (!skill) return null;
  const style = getDirectorStyle(skill.styleId || '');
  return {
    id: skill.id, icon: skill.icon, label: skill.label, tagline: skill.tagline,
    summary: skill.summary, highlights: [...(skill.highlights || [])],
    capabilities: (skill.capabilities || []).map((id) => ({ ...(CAP_BY_ID[id] || { id, label: id }) })),
    deliverables: skill.deliverables ? { ...skill.deliverables } : null,
    steps: skill.steps, stepMode: { ...(DIRECTOR_STEP_MODES[skill.steps] || DIRECTOR_STEP_MODES.all) },
    repack: !!skill.repack, verify: !!skill.verify,
    group: skill.group || 'flow',
    groupLabel: (DIRECTOR_SKILL_GROUPS[skill.group] || DIRECTOR_SKILL_GROUPS.flow).label,
    styleId: style?.id || null,
    // 风格卡要显示调色板色块、节奏说明与媒介，供用户选择前就看清差别
    style: style ? styleCard(style.id) : null,
  };
}

export function listDirectorSkills() {
  return DIRECTOR_SKILLS.map(directorSkillPublic);
}

/** 按分组切分后的清单：前端两组卡片各取一段 */
export function listDirectorSkillsByGroup() {
  const all = listDirectorSkills();
  return Object.values(DIRECTOR_SKILL_GROUPS).map((g) => ({
    ...g, skills: all.filter((s) => s.group === g.id),
  }));
}

export function defaultDirectorState() {
  return { schema: 1, skillId: DEFAULT_DIRECTOR_SKILL, treatment: null, lastRun: null };
}

/** 惰性补齐老项目：字段缺失时给一份完整默认状态，不覆盖已有运行记录 */
export function ensureDirectorState(m) {
  if (!m || typeof m !== 'object') return defaultDirectorState();
  if (!m.director || m.director.schema !== 1) {
    m.director = { ...defaultDirectorState(), skillId: normalizeDirectorSkillId(m.director?.skillId) };
  }
  m.director.skillId = normalizeDirectorSkillId(m.director.skillId);
  if (m.director.treatment === undefined) m.director.treatment = null;
  if (m.director.lastRun === undefined) m.director.lastRun = null;
  return m.director;
}

/**
 * 运行计划（纯函数）：前端「将执行什么」与后端实际执行共用同一份口径。
 * @returns {{ok:boolean, skill:object, plan:object, error?:string}}
 */
export function planDirectorRun({ project, m, skillId, force = false } = {}) {
  const management = m || project?.management || {};
  if (management.kind && management.kind !== 'novel') {
    return { ok: false, error: '导演智能体只作用于小说创作项目（标准流水线请用顶栏「运行完整流水线」）' };
  }
  const skill = getDirectorSkill(skillId || management.director?.skillId);
  const steps = skill.steps === 'core' ? STEPS.filter((s) => !s.auto) : STEPS;
  const stateById = Object.fromEntries((management.steps || []).map((s) => [s.id, s.status]));
  const stepPlan = steps.map((s) => {
    const status = stateById[s.id] || 'pending';
    return {
      id: s.id, no: s.no, title: s.title, auto: !!s.auto,
      status, willRun: !!force || status !== 'done',
    };
  });
  const deliverables = {
    video: skill.deliverables ? !!skill.deliverables.video : management.deliverables?.video !== false,
    pack: skill.deliverables ? !!skill.deliverables.pack : management.deliverables?.pack !== false,
  };
  const capabilityPlan = (skill.capabilities || []).map((id) => ({
    ...(CAP_BY_ID[id] || { id, label: id, desc: '' }),
  }));
  const preconditions = [
    {
      id: 'source', label: '原著与分集',
      ok: !!management.source?.text,
      detail: management.source?.text
        ? `《${management.source.title || '未命名'}》· ${management.source.chapterCount || 0} 章 · ${(management.episodes || []).length} 集`
        : '尚未准备原著 · 运行时可用一句话构想自动生成演示小说，或先在「准备故事」上传',
    },
    {
      id: 'steps', label: '制作步骤',
      ok: (management.steps || []).length > 0,
      detail: `共 ${steps.length} 步纳入本次编排，其中 ${stepPlan.filter((s) => s.willRun).length} 步待执行`,
    },
  ];
  return {
    ok: true,
    skill: directorSkillPublic(skill),
    plan: {
      skillId: skill.id, force: !!force, stepMode: skill.steps,
      steps: stepPlan,
      runStepIds: stepPlan.filter((s) => s.willRun).map((s) => s.id),
      capabilities: capabilityPlan,
      deliverables,
      preconditions,
      warnings: [
        ...(!management.source?.text ? ['项目还没有原著：运行时会按一句话构想生成演示小说（未配置模型为内置模板）'] : []),
        ...(skill.deliverables ? [`该技能会把项目交付设置同步为：${deliverables.video ? '成片视频 ' : ''}${deliverables.pack ? '导演包' : ''}`] : []),
        ...(!deliverables.video && deliverables.pack ? ['仅交接包模式会跳过本地视频渲染，成片由导演工作台生成'] : []),
      ],
    },
  };
}

/**
 * 最终产物验收（纯函数）：把「跑完了吗」拆成可逐项核对的清单。
 * level: ok（达成） / degraded（如实降级，例如 Mock 帧序列预览） / missing（缺失）
 * complete: 所有必需项都不是 missing；degraded 会单独计数，不冒充成功。
 */
export function verifyDirectorDeliverables(project, skillOrId = null) {
  const m = project?.management || {};
  const nodes = project?.nodes || [];
  const final = nodes.find((n) => n.type === 'final');
  const skill = typeof skillOrId === 'string' ? getDirectorSkill(skillOrId) : (skillOrId || getDirectorSkill(m.director?.skillId));
  const wanted = skill?.deliverables
    ? { video: !!skill.deliverables.video, pack: !!skill.deliverables.pack }
    : { video: m.deliverables?.video !== false, pack: m.deliverables?.pack !== false };
  const count = (types) => nodes.filter((n) => types.includes(n.type)).length;
  const prog = stepProgress(m);
  const packInfo = final?.data?.directorPack;
  const filmInfo = final?.data?.film;
  const spec = resolveRuntimeSpec(project);
  const filmPolicy = normalizeFilmPolicy(spec.filmPolicy);
  const realClips = nodes.filter((n) => n.type === 'video' && isRealClip(n.data?.clip)).length;
  // 成片真实性：real 策略下预览成片 / 缺片段一律判缺失，绝不算「全流程已达成」。
  const reality = evaluateFilm({ project, film: filmInfo, policy: filmPolicy, clipCount: spec.clipCount });
  // 时长规格验收：片段数 / 每片段时长 / 时间线总长 / 导演包组数 / MP4 实测时长
  // / 成片是否来自真实 AI 视频。以前这一项完全缺席，12 片段 60s 也会被判成达标。
  const runtimeCheck = verifyRuntime(project, spec, {
    filmSeconds: filmInfo?.file && Number.isFinite(Number(filmInfo.duration)) ? Number(filmInfo.duration) : undefined,
    requireRealFilm: filmPolicy === 'real' && wanted.video,
    filmIsReal: reality.isRealVideo,
  });

  const items = [
    {
      id: 'source', label: '原著与分集', required: true,
      level: m.source?.text && (m.episodes || []).length ? 'ok' : 'missing',
      detail: m.source?.text ? `《${m.source.title || '未命名'}》· ${(m.episodes || []).length} 集` : '缺少原著或分集',
    },
    {
      id: 'script', label: '统一格式剧本', required: true,
      level: nodes.find((n) => n.type === 'script')?.data?.script ? 'ok' : 'missing',
      detail: nodes.find((n) => n.type === 'script')?.data?.script?.title || '剧本节点尚未产出统一格式剧本',
    },
    {
      id: 'context', label: '角色与上下文', required: true,
      level: count(['rag', 'character', 'plan', 'event', 'scene']) > 0 ? 'ok' : 'missing',
      detail: `${count(['rag', 'character', 'plan', 'event', 'scene'])} 个上下文节点 · ${(m.characters || []).length} 位角色`,
    },
    {
      id: 'storyboard', label: '分镜 / 关键帧 / 片段', required: true,
      level: count(['shot', 'keyframe', 'video']) > 0 ? 'ok' : 'missing',
      detail: `${count(['shot'])} 镜头 · ${count(['keyframe'])} 关键帧 · ${count(['video'])} 片段`,
    },
    {
      id: 'steps', label: '制作步骤全部完成', required: true,
      level: prog.allDone ? 'ok' : 'missing',
      detail: `${prog.done}/${prog.total} 步完成${prog.failed ? ` · ${prog.failed} 步失败` : ''}`,
    },
    {
      id: 'runtime', label: '成片时长规格', required: true,
      level: runtimeCheck.ok ? 'ok' : 'missing',
      detail: runtimeCheck.ok
        ? runtimeCheck.summary
        : `${runtimeCheck.summary} · ${runtimeCheck.failures.map((f) => f.detail).join('；')}`,
      checks: runtimeCheck.checks,
    },
  ];
  if (wanted.pack) {
    items.push({
      id: 'pack', label: '导演包 *.mmxpack.zip', required: true,
      level: packInfo?.file ? 'ok' : 'missing',
      detail: packInfo?.file
        ? `${packInfo.fileCount || 0} 个文件 · ${packInfo.shotCount || 0} 组镜头 · ${((packInfo.bytes || 0) / 1024).toFixed(0)} KB`
        : '未生成导演包',
      file: packInfo?.file || null, filename: packInfo?.filename || null,
    });
  }
  if (wanted.video) {
    items.push({
      id: 'film', label: filmPolicy === 'real' ? '真实 AI 成片 MP4' : '成片视频 MP4（预览策略）', required: true,
      level: reality.level,
      detail: filmInfo?.file
        ? `${((filmInfo.bytes || 0) / 1024 / 1024).toFixed(1)} MB · ${filmInfo.clips || 1} 片段 · ${filmInfo.method || '拼接'}${Number.isFinite(Number(filmInfo.duration)) ? ` · ${filmInfo.measured ? '实测' : '标称'} ${filmInfo.duration}s` : ''} · ${reality.detail}`
        : reality.detail,
      file: filmInfo?.file || null,
      source: filmInfo?.source || null,
      isRealVideo: reality.isRealVideo,
    });
    // 独立核对「ComfyUI 到底有没有被真实调用」：逐片段检查 provider 与视频文件，
    // 而不是只看最终有没有一个 MP4。真实策略下少一段就判缺失。
    items.push({
      id: 'aiVideo', label: 'ComfyUI 真实 AI 片段', required: filmPolicy === 'real',
      level: realClips === spec.clipCount ? 'ok' : (filmPolicy === 'real' ? 'missing' : 'degraded'),
      detail: realClips === spec.clipCount
        ? `${realClips} 个片段均由 ComfyUI 视频工作流生成${final?.data?.comfyPromptIds?.length ? ` · ${final.data.comfyPromptIds.length} 个 prompt_id 已留痕` : ''}`
        : `${realClips}/${spec.clipCount} 个片段是 ComfyUI 真实产物${filmPolicy === 'real' ? ' · 请在设置中导入视频工作流并检查连接，或把成片策略切为「关键帧预览」' : ' · 预览策略下如实降级'}`,
      promptIds: final?.data?.comfyPromptIds || [],
    });
  }
  const missing = items.filter((i) => i.required && i.level === 'missing');
  const degraded = items.filter((i) => i.level === 'degraded');
  const passed = items.filter((i) => i.level === 'ok');
  return {
    items, passed: passed.length, degraded: degraded.length, missing: missing.length,
    runtime: { ok: runtimeCheck.ok, spec: runtimeCheck.spec, checks: runtimeCheck.checks },
    filmReality: reality,
    complete: missing.length === 0,
    summary: missing.length
      ? `有 ${missing.length} 项最终产物未达成：${missing.map((i) => i.label).join('、')}`
      : degraded.length
        ? `必需产物已就绪，${degraded.length} 项为如实降级：${degraded.map((i) => i.label).join('、')}`
        : '全部最终产物已就绪',
  };
}
