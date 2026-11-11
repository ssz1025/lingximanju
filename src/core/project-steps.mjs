/* ============================================================================
 * 创作项目管理层 · 纯逻辑（六步任务定义、状态机、元数据、统计、管理动作）
 *
 * 六步严格按 ViMax 论文（arXiv:2606.07649v2）式(1)–(8) 的机制顺序编排，
 * 并把每一步映射到本仓库真实执行的节点类型（scope），供 orchestrator 分阶段调度。
 * 理论依据与消融数据见 docs/THEORY.md；论文原文见 docs/paper/。
 * ==========================================================================*/
import { normalizeCharacter, MAX_CHARACTERS } from './characters.mjs';
import { getVoice } from './voices.mjs';
import { normalizeRuntimeSpec } from './runtime-spec.mjs';
import { normalizeStoryboardSettings, resolveStoryboardSettings, describeStoryboardSettings } from './storyboard-settings.mjs';
import { normalizeStyleId, getDirectorStyle, resolvePalette } from './director-styles.mjs';

/** 四份流程策略 id（字面量镜像 core/director-skills.mjs 的 FLOW_SKILLS，避免循环依赖） */
const FLOW_SKILL_IDS = ['full', 'script', 'visual', 'pack'];

export const STEP_STATUS = {
  pending: { label: '待执行', color: 'muted' },
  running: { label: '进行中', color: 'accent' },
  done: { label: '已完成', color: 'green' },
  error: { label: '失败 · 可重试', color: 'red' },
  skipped: { label: '已跳过', color: 'muted' },
};

/**
 * scope = 该步允许 orchestrator 执行的画布节点类型。
 * 与 src/agents/ 的动态展开链一致：
 *   script --(screenwriter)--> rag/character/plan --(decomposer)-->
 *   event/scene --(storyboard)--> shot/keyframe/review/video/transition
 *   --> camera(机位图) --> final(成片/导演包)
 * auto = 在「新建创作项目」时已由服务端完成，无需调度智能体。
 */
export const STEPS = [
  {
    id: 'upload', no: 1, title: '上传小说与交付设置', short: '解析原文与章节结构',
    icon: '⇧', auto: true, scope: [], nodeLabel: '小说上传节点',
    desc: '选择 .txt / .md 小说或粘贴正文，识别书名与章节、统计字数；同时确定分集策略与最终交付物（成片视频 / 导演包）。',
    checklist: ['上传或粘贴小说正文', '确认书名、章节数与总字数', '勾选最终交付物'],
    theory: {
      ref: '式(1) 前置 · 扩展层',
      text: 'ScreenWriting 的输入归一：把非结构化长文本整理为可索引的原著语料，供后续 RAG 检索；论文以 8–16 镜头短片为尺度，长篇输入需要在进入剧本前先分层。',
      map: [['输入', 'novel.text / chapters[]'], ['代码', 'src/core/novel.mjs · parseNovel()'], ['落点', '画布 idea 节点 + management.source']],
    },
  },
  {
    id: 'episodes', no: 2, title: '分集拆解', short: '长文本切成可拍摄的集',
    icon: '▥', auto: true, scope: [], nodeLabel: '分集节点',
    desc: '按章节 / 字数 / 场景段落聚合为集，每集给出摘要、结尾钩子与字数，并在无限画布上生成分集节点。',
    checklist: ['按策略合并章节或段落', '为每集生成摘要与结尾钩子', '画布上出现第 1…N 集节点'],
    theory: {
      ref: '式(5) 前置 · 扩展层',
      text: '层次化分解的第一层：先把长篇压成「集」这一中间粒度，使后续事件→场景→镜头每层只处理合适规模的上下文，避免单集超出推理容量。',
      map: [['挑战', '长程叙事规划（论文 §1 / §2.2.1）'], ['代码', 'src/core/novel.mjs · splitEpisodes()'], ['落点', '画布 episode 节点 + management.episodes[]']],
    },
  },
  {
    id: 'script', no: 3, title: '剧本生成与格式统一', short: '输入 → 统一格式剧本 S',
    icon: '▤', auto: false, scope: ['script'], nodeLabel: '剧本节点',
    desc: '编剧智能体把分集内容写成统一格式剧本（片名 / 类型 / 梗概 / 角色 / 场景表 / 对白），并把结果写回画布节点。',
    checklist: ['生成统一格式剧本 S', '识别角色与场景表', '剧本节点状态变绿 ✓'],
    theory: {
      ref: '式(1)',
      text: '𝒮 = ScreenWriting(ℐ; P_C(ℐ))：按输入类别路由提示词，把创意 / 小说归一成统一格式剧本，作为后续所有规划的唯一事实来源。',
      map: [['式(1)', 'src/agents/narrative.mjs · screenwriter'], ['Provider', 'src/core/providers.mjs · generate("screenplay")'], ['数据', 'script.data.script']],
    },
  },
  {
    id: 'context', no: 4, title: 'RAG · 角色 · 层次分解', short: '补全局上下文 + 事件→场景→镜头',
    icon: '⑂', auto: false, scope: ['rag', 'character', 'plan', 'event', 'scene', 'shot'], nodeLabel: 'RAG / 角色 / 分解节点',
    desc: '对整本原著建段落索引并检索补全局上下文，抽取角色生成定妆资产；随后递归展开 事件 → 场景 → 镜头 三级节点，画布实时生长。',
    checklist: ['原著全文进入 RAG 索引（不是只看剧本）', '角色资产库生成三视图并以 ref 边复用', '事件 / 场景 / 镜头节点出现在画布'],
    theory: {
      ref: '式(5)(6)',
      text: 'Decomp(N_{d-1,i}) 控制推理粒度；分解会丢失原著的角色动机与伏笔，因此用 Index/Retrieve/Enrich 对完整原著建索引补回全局信息——分解管复杂度，RAG 管信息不丢失。',
      map: [['式(5)', 'src/agents/narrative.mjs · decomposer'], ['式(6)', 'src/agents/narrative.mjs · rag（originalCorpus）'], ['消融', '去 RAG：NF 3.52→3.14；去事件链：3.52→2.34'], ['角色', 'src/agents/narrative.mjs · character + ref 边']],
    },
  },
  {
    id: 'storyboard', no: 5, title: '分镜提示词 · 分镜图', short: '提示词 + 关键帧 + 分镜板（不出视频）',
    icon: '⌗', auto: false, scope: ['keyframe', 'review', 'transition', 'camera'], nodeLabel: '分镜 / 关键帧 / 分镜板节点',
    desc: '按镜头规格生成 k 张候选关键帧并 VLM 择优，机位依赖图按拓扑序传播视觉锚点；每个镜头的分镜提示词、选中的关键帧图与每段分镜板都在本步落盘。分镜板版式（九宫格 / 六宫格 / 四宫格 / 条漫 / 二十五宫格 / 单图）与画幅、格内信息由「分镜画面设置」决定。**视频片段不在本步生成**——等全部画面确认后到第 ⑥ 步统一出片，避免图还没定型就烧 GPU。',
    checklist: ['每个镜头都有完整分镜提示词', '每镜头 best-of-2 择优并记录评分', '分镜画面设置已选（版式 / 画幅 / 格内信息）', '每段分镜板已生成（可点开查看）', '视频片段留到第 ⑥ 步统一生成'],
    theory: {
      ref: '式(2)(4)(7)(8)',
      text: 'ShotPlanning 出分镜规格；GenConditioned(Sᵢ, Aᵢ) 让依赖机位继承前驱锚点；GenTransition / ExtractViews 先用端点视图锁定空间关系（视频留到交付步）；C* = argmax VLM-Judge 做质量闸门（论文 RQ6：k=2 最优）。',
      map: [['式(2)(7)', 'src/agents/narrative.mjs · storyboard / camera-graph'], ['式(3) 图', 'src/agents/visual.mjs · keyframe（本步只出图）'], ['式(4)', 'src/agents/visual.mjs · review（k=2）'], ['式(8)', 'src/agents/visual.mjs · transition 端点帧 + anchor 边'], ['分镜板', 'src/core/grid-art.mjs · storyboardGridSVG（版式由 storyboard-settings 决定）'], ['设置', 'management.storyboard · 九宫格 / 六宫格 / 四宫格 / 条漫 / 二十五宫格 / 单图'], ['消融', '去全部跨镜头依赖 GC −8.7%；去 VLM 择优 −3.8%']],
    },
  },
  {
    id: 'deliver', no: 6, title: '视频生成与成片交付', short: '画面全就绪后统一出片',
    icon: '▶', auto: false, scope: ['video', 'transition', 'final'], nodeLabel: '视频片段 / 成片节点',
    desc: '第 ⑤ 步的分镜提示词与关键帧全部确认后，本步才逐镜头把「选中关键帧 + 运动描述」送进本机 ComfyUI 图生视频，补齐转场视频，最后由 ffmpeg 拼成片并按设置导出 *.mmxpack.zip 导演包。',
    checklist: ['全部镜头关键帧已定版（第 ⑤ 步完成）', '每个镜头都有视频片段（真实 ComfyUI 产物）', '时间线节点汇总所有片段并变绿 ✓', '导演包已生成且可下载', '成片视频按配置产出或明确标注降级原因', '成片时长规格逐项达标：片段数 / 单段时长 / 总时长 / 分辨率'],
    theory: {
      ref: '式(3) + 依赖图并行调度',
      text: '生成阶段以「镜头规格 + 关键帧」为条件逐镜头出片，依赖图拓扑序保证同层可并行；把视频集中到最后一步，是为了让画面定版与昂贵的图生视频解耦，改分镜不必重烧全部片段。',
      map: [['式(3)', 'ImageGen → VideoGen（providers / comfyui）'], ['转场视频', 'src/agents/visual.mjs · transition（videoOnly 续跑）'], ['交付 A', 'src/core/film.mjs · stitchClips → MP4'], ['交付 B', 'src/core/director-pack.mjs · exportDirectorPack → mmxpack.zip']],
    },
  },
];

export const STEP_BY_ID = Object.fromEntries(STEPS.map((s) => [s.id, s]));
const uid = (p = 'h') => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const now = () => Date.now();
const zeroTokens = () => ({ prompt: 0, completion: 0, total: 0, calls: 0 });

/**
 * 初始化六步状态。
 * opts.pending = true → 骨架项目：六步全部待执行（连① 上传小说也要用户后续完成），
 * 与「上传后立即创建」的既有行为（auto 步骤直接 done）保持兼容。
 */
/** 单步运行明细上限：保留最近 30 次，够回溯又不会把项目 JSON 撑爆 */
export const STEP_RUN_LOG_LIMIT = 30;

function freshSteps(opts = {}) {
  const pending = !!opts.pending;
  return STEPS.map((s) => ({
    id: s.id, no: s.no,
    status: pending || !s.auto ? 'pending' : 'done',
    startedAt: pending ? null : s.auto ? now() : null,
    finishedAt: pending ? null : s.auto ? now() : null,
    durationMs: 0,
    note: pending ? '' : s.auto ? '新建创作项目时由服务端完成' : '',
    runs: pending || !s.auto ? 0 : 1,
    // tokens = 执行本步的累计消耗（含对话里触发的重跑）；
    // chatTokens = 在本步「和 Agent 对话」中产生的 LLM 消耗（改写 / 解释 / 生成文案）。
    // 两者分开记是为了让「重跑花的」和「聊天花的」都能解释清楚，合计才是该步总账。
    tokens: zeroTokens(), lastTokens: null, chatTokens: zeroTokens(),
    // 每次运行的明细：谁触发的、花了多少 token、耗时多少 —— 「查看每一步 token 消耗」的数据源
    runLog: pending || !s.auto ? [] : [{ at: now(), action: 'auto', ok: true, durationMs: 0, tokens: zeroTokens(), note: '新建创作项目时由服务端完成' }],
  }));
}

/** 漫剧基础信息（创作设定）：分集展示与 AI 生成环节的统一依据；长文本字段宽容存储，前端负责编辑 */
export function defaultBible(opts = {}) {
  return {
    title: String(opts.title || '').slice(0, 80),        // 剧名（可与项目名不同）
    genre: '', audience: '',
    logline: String(opts.logline || '').slice(0, 300),   // 一句话简介（AI 补全 / 手动填写）
    synopsis: String(opts.synopsis || '').slice(0, 2000), // 故事概略（已上传小说时由 AI 读原著生成）
    totalEpisodes: Number(opts.totalEpisodes) || 0,      // 总集数：0 = 未设定
    ending: '', artStyle: '', tone: '',
    firstEpisodeTheme: '',                               // 首集锚定主题
    adaptation: '',                                      // 改编原则（含不可删减关键事件）
    bottomLines: '',                                     // 创作底线，每行一条
    worldview: '',                                       // 世界观设定
    characters: '',                                      // 人设（每段一个角色）
    stylePrompt: '', negativePrompt: '',                 // AI 生成：全局风格串 / 负面串
  };
}

export function createManagement(opts = {}) {
  const kind = opts.kind === 'novel' ? 'novel' : 'standard';
  const base = {
    schema: 1, kind,
    title: opts.title || '未命名项目',
    status: kind === 'novel' ? 'draft' : 'standard',
    favorite: false, archived: false, tags: [], note: '',
    bible: defaultBible(opts.bible || {}),
    // 角色库（角色管理 Tab）：从小说提取 + 手动维护，属性驱动多视图生成
    characters: [],
    // 封面：空 url + source:'name' 时前端渲染「项目名称封面」；
    // source:'upload' / 'comfyui' 时 url 指向 /assets/ 下的图片
    cover: { url: '', source: 'name', updatedAt: now(), prompt: '' },
    // 导演 Agent 技能（项目级制片策略）：选择、导演阐述与最近一次全流程验收报告随项目持久化。
    // 技能清单定义在 core/director-skills.mjs；这里只用字面量默认值，避免两个模块循环依赖。
    director: { schema: 1, skillId: 'full', treatment: null, lastRun: null },
    // 短剧成片规格（总时长 / 每片段时长 → 片段数 → 镜头预算 → 时间线）。
    // 默认 30s / 3s；具体推导在 core/runtime-spec.mjs，这里只用字面量避免语义重复。
    // filmPolicy='real' 是默认值：只认 ComfyUI 真实视频片段拼出的成片，
    // 关键帧预览成片必须显式切到 'preview' 才允许，且验收记为降级。
    runtime: { schema: 1, enabled: true, totalSeconds: 30, clipSeconds: 3, fps: 24, filmPolicy: 'real' },
    // 分镜画面设置（第⑤步操作台）：版式 / 画幅 / 格内信息 / 构图参考 / 提示词公式。
    // 默认九宫格 + 跟随项目画幅 + 真实分镜图优先；归一逻辑在 core/storyboard-settings.mjs。
    storyboard: normalizeStoryboardSettings(),
    createdAt: now(), updatedAt: now(), version: 1,
    history: [{ id: uid(), at: now(), action: 'create', detail: kind === 'novel' ? (opts.skeleton ? '新建创作项目骨架（待上传小说）' : '新建创作项目（小说分集）') : '标准流水线项目' }],
  };
  if (kind !== 'novel') return { ...base, steps: [], currentStep: 0, deliverables: { video: true, pack: true } };
  return {
    ...base,
    deliverables: {
      video: opts.deliverables?.video !== false,
      pack: opts.deliverables?.pack !== false,
    },
    split: {
      strategy: opts.split?.strategy || 'chapter',
      targetChars: Number(opts.split?.targetChars) || 1200,
      maxEpisodes: Number(opts.split?.maxEpisodes) || 4,
    },
    source: {
      filename: opts.source?.filename || '', title: opts.source?.title || opts.title || '',
      totalChars: Number(opts.source?.totalChars) || 0,
      chapterCount: Number(opts.source?.chapterCount) || 0,
      uploadedAt: now(), text: opts.source?.text || '',
    },
    // 剧集详情相关字段（原文 / 章节 / 段落 / 剧本 / 宫格图 / 产物）全部随项目 JSON 持久化；
    // 用展开保留已有字段，兼容上传时创建与后续按集生成的两种路径。
    episodes: (opts.episodes || []).map((e) => ({
      no: e.no, title: e.title, chars: e.chars, summary: e.summary, hook: e.hook,
      sourceTitles: e.sourceTitles || [],
      text: e.text || '', excerpt: e.excerpt || '', strategy: e.strategy || '',
      chapters: e.chapters || [], characterIds: e.characterIds || [],
      script: e.script || null, segments: e.segments || [],
      pack: e.pack || null, video: e.video || null,
      updatedAt: e.updatedAt || now(),
    })),
    // 章节 / 文件出处：与 episodes[].chapters 双向表达「章节 ↔ 剧集」关联
    chapters: opts.chapters || [],
    sources: opts.sources || [],
    // 骨架项目（尚未上传小说）：六步全 pending、当前停在第 ① 步
    steps: freshSteps({ pending: !!opts.skeleton }),
    // 每步独立对话记录（工作台「和 Agent 对话修改」）：{ [stepId]: { messages[], tokens } }
    stepChats: {},
    // 统一对话线程里新增档位的历史（封面 / 导演风格 / 画布）：
    // { [scope]: { messages[], tokens, state } }——旧项目惰性补齐，不覆盖已有内容
    aiScopes: {},
    currentStep: opts.skeleton ? 1 : 3,
    theory: { paper: 'ViMax · arXiv:2606.07649v2', doc: 'docs/THEORY.md', defaults: { k: 2, anchorRequired: true, ragRequired: true, eventChainRequired: true } },
  };
}

/** 老项目惰性补一层管理元数据，保证列表 / 收藏 / 归档 / 快照对所有项目可用 */
export function ensureManagement(project) {
  if (!project.management || project.management.schema !== 1) {
    project.management = createManagement({ kind: 'standard', title: project.name || '未命名项目' });
  }
  // 老项目惰性补封面字段（升级兼容）
  if (!project.management.cover) project.management.cover = { url: '', source: 'name', updatedAt: Date.now(), prompt: '' };
  // 老项目惰性补创作设定
  if (!project.management.bible) project.management.bible = defaultBible();
  // 老项目惰性补导演技能状态（ensureDirectorState 会进一步把非法 id 归一为默认技能）
  if (!project.management.director || project.management.director.schema !== 1) {
    project.management.director = { schema: 1, skillId: 'full', treatment: null, lastRun: null };
  }
  // 短剧时长规格始终归一后写回：老项目补齐、新项目补出 clipCount 等推导字段；
  // 分辨率结合项目画幅归一（9:16 → 480×864 起步，16:9 → 864×480 起步）
  project.management.runtime = normalizeRuntimeSpec({
    ...(project.management.runtime || {}),
    aspect: project.settings?.aspect,
  });
  // 分镜画面设置同样每次归一：老项目补齐默认九宫格，非法版式 / 画幅回落默认，
  // cols / rows / cells 由版式推导后落盘，前端与宫格渲染读到的是同一份几何。
  project.management.storyboard = normalizeStoryboardSettings({
    ...(project.management.storyboard || {}),
  });
  // 老项目惰性补角色库并逐项归一
  if (!Array.isArray(project.management.characters)) project.management.characters = [];
  else project.management.characters = project.management.characters.map((c) => normalizeCharacter(c));
  // 老项目惰性补剧集详情字段，保证单集详情页对历史项目也可用
  if (!Array.isArray(project.management.chapters)) project.management.chapters = [];
  if (!Array.isArray(project.management.sources)) project.management.sources = [];
  // 老项目惰性补「每步 token 账目」与「每步对话记录」容器（升级兼容，不覆盖已有内容）
  if (Array.isArray(project.management.steps)) {
    for (const s of project.management.steps) {
      if (!s.tokens) s.tokens = zeroTokens();
      if (!s.chatTokens) s.chatTokens = zeroTokens();
      if (!Array.isArray(s.runLog)) s.runLog = [];
    }
  }
  if (!project.management.stepChats || typeof project.management.stepChats !== 'object') {
    project.management.stepChats = {};
  }
  // 统一对话线程的新增档位桶（封面 / 导演风格 / 画布）
  if (!project.management.aiScopes || typeof project.management.aiScopes !== 'object') {
    project.management.aiScopes = {};
  }
  if (Array.isArray(project.management.episodes)) {
    project.management.episodes = project.management.episodes.map((e) => ({
      ...e,
      text: e.text || '', excerpt: e.excerpt || '', strategy: e.strategy || '',
      chapters: e.chapters || [], characterIds: e.characterIds || [],
      script: e.script || null, segments: e.segments || [],
      pack: e.pack || null, video: e.video || null,
    }));
  }
  return project.management;
}

export function stepProgress(m) {
  const steps = m?.steps || [];
  const total = steps.length || STEPS.length;
  const done = steps.filter((s) => s.status === 'done').length;
  const running = steps.filter((s) => s.status === 'running').length;
  const failed = steps.filter((s) => s.status === 'error').length;
  const current = steps.find((s) => s.status === 'running') || steps.find((s) => s.status === 'pending') || null;
  const allDone = total > 0 && done === total;
  return {
    total, done, running, failed, allDone,
    percent: total ? Math.round((done / total) * 100) : 0,
    currentId: current?.id || null,
    currentNo: current?.no || total,
    label: `${done}/${total}`,
    status: failed ? 'error' : running ? 'running' : allDone ? 'done' : m?.status === 'standard' ? 'standard' : 'draft',
  };
}

function logHistory(m, action, detail) {
  m.history = [{ id: uid(), at: now(), action, detail }, ...(m.history || [])].slice(0, 60);
  m.updatedAt = now();
}

/**
 * 工作台第 ① 步「设置基础信息」的完成标记。
 * 这一步在六步状态机之外（字段都落在 bible / settings / cover 上），没有「执行本步」按钮，
 * 唯一的完成方式就是用户保存过基础信息里的任意一项；因此这里显式记一个确认时间，
 * 前端 stepStatus('basic') 以它为准 —— 保证「提示已保存」与「步骤已完成」永远一致。
 */
function markBasicConfirmed(m) {
  m.basicInfo = { schema: 1, confirmedAt: now() };
}

export function startStep(m, id, meta = {}) {
  const s = m.steps?.find((x) => x.id === id);
  if (!s) return null;
  s.status = 'running'; s.startedAt = now(); s.finishedAt = null; s.note = '智能体执行中…';
  s.runs = (s.runs || 0) + 1;
  if (!s.tokens) s.tokens = zeroTokens();
  if (!s.chatTokens) s.chatTokens = zeroTokens();
  if (!Array.isArray(s.runLog)) s.runLog = [];
  s.lastTokens = null;                       // 本次运行明细从零开始，完成时写入
  // 记录「谁触发的这次运行」：面板手动 / 对话框指令 / 导演能力 / 全流程
  s.pendingAction = meta.action || 'manual';
  s.pendingTrigger = meta.trigger || '';
  m.currentStep = s.no;
  m.status = 'running';
  logHistory(m, 'step:start', `第 ${s.no} 步 · ${STEP_BY_ID[id]?.title || id}`);
  return s;
}

/** 把本次运行的 token 用量累加进步骤：tokens 为全周期累计，lastTokens 为最近一次运行明细 */
function addTokens(step, usage) {
  if (!usage) return;
  const t = step.tokens || zeroTokens();
  const last = { prompt: 0, completion: 0, total: 0, calls: 0 };
  for (const k of ['prompt', 'completion', 'total', 'calls']) {
    const v = Number(usage[k]) || 0;
    t[k] = (t[k] || 0) + v;
    last[k] = v;
  }
  step.tokens = t;
  step.lastTokens = last;
}

export function finishStep(m, id, { ok = true, note = '', durationMs = 0, tokens = null } = {}) {
  const s = m.steps?.find((x) => x.id === id);
  if (!s) return null;
  // 自动步骤（① 上传 / ② 分集）走 attachSource 直接 finishStep，没经过 startStep，
  // 这里补计一次运行，保证 runs 与 runLog 条数一致（否则面板上会出现「跑过 0 次但有明细」）。
  const viaStart = Boolean(s.pendingAction);
  if (!viaStart) s.runs = (s.runs || 0) + 1;
  s.status = ok ? 'done' : 'error';
  s.finishedAt = now(); s.durationMs = durationMs;
  s.note = note || (ok ? '执行完成' : '执行失败，可重试');
  if (!s.tokens) s.tokens = zeroTokens();
  addTokens(s, tokens);
  // 运行明细：把本次消耗单独留档，供「每步 token 消耗」逐次回看
  if (!Array.isArray(s.runLog)) s.runLog = [];
  s.runLog.unshift({
    at: s.finishedAt,
    action: s.pendingAction || 'manual',
    trigger: s.pendingTrigger || '',
    ok: !!ok,
    durationMs: Number(durationMs) || 0,
    tokens: tokens ? { ...s.lastTokens } : zeroTokens(),
    note: String(note || '').slice(0, 240),
  });
  if (s.runLog.length > STEP_RUN_LOG_LIMIT) s.runLog.length = STEP_RUN_LOG_LIMIT;
  s.pendingAction = null; s.pendingTrigger = null;
  const p = stepProgress(m);
  m.currentStep = p.currentNo;
  m.status = p.failed ? 'error' : p.allDone ? 'done' : 'draft';
  const tokNote = s.tokens.total ? ` · ${fmtTokens(s.tokens.total)} tokens` : '';
  logHistory(m, ok ? 'step:done' : 'step:error', `第 ${s.no} 步 · ${STEP_BY_ID[id]?.title || id} · ${s.note}${tokNote}`);
  return s;
}

/**
 * 记录「在本步对话框里」产生的 LLM 消耗。
 * 与 finishStep 的 tokens 分开：重跑步骤的消耗记在 tokens（那是执行），
 * 只有对话本身（解释 / 改写文案 / 生成建议）才记这里，避免两处重复计账。
 */
export function addChatTokens(m, id, usage) {
  const s = m.steps?.find((x) => x.id === id);
  if (!s || !usage) return null;
  if (!s.chatTokens) s.chatTokens = zeroTokens();
  for (const k of ['prompt', 'completion', 'total', 'calls']) {
    s.chatTokens[k] = (s.chatTokens[k] || 0) + (Number(usage[k]) || 0);
  }
  return s.chatTokens;
}

/** 每步 token 账目：执行 + 对话 = 合计；附运行明细，前端据此画占比条 */
export function stepTokenReport(m) {
  const steps = m?.steps || [];
  const blank = () => ({ prompt: 0, completion: 0, total: 0, calls: 0 });
  const total = blank();
  const rows = steps.map((s) => {
    const exec = s.tokens || blank();
    const chat = s.chatTokens || blank();
    const sum = blank();
    for (const k of ['prompt', 'completion', 'total', 'calls']) sum[k] = (exec[k] || 0) + (chat[k] || 0);
    for (const k of ['prompt', 'completion', 'total', 'calls']) total[k] += sum[k];
    return {
      id: s.id, no: s.no, title: STEP_BY_ID[s.id]?.title || s.id, status: s.status,
      exec, chat, sum, lastTokens: s.lastTokens || null,
      runs: s.runs || 0, runLog: Array.isArray(s.runLog) ? s.runLog : [],
    };
  });
  for (const r of rows) r.share = total.total ? Math.round((r.sum.total / total.total) * 100) : 0;
  return { total, steps: rows, anyUsage: total.total > 0 || total.calls > 0 };
}

/** token 数字格式化：≥1000 显示 x.xk（前端同规则） */
function fmtTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function resetStep(m, id) {
  const s = m.steps?.find((x) => x.id === id);
  if (!s || STEP_BY_ID[id]?.auto) return null;
  s.status = 'pending'; s.startedAt = null; s.finishedAt = null; s.note = '已重置，等待重新执行'; s.durationMs = 0;
  // 重置只清「本步执行账目」，对话框里的历史消息与对话消耗不丢：
  // 用户要的是「所有对话记录保留」，重置状态 ≠ 抹掉讨论过程。
  s.tokens = zeroTokens(); s.lastTokens = null; s.runLog = [];
  m.currentStep = s.no; m.status = 'draft';
  logHistory(m, 'step:reset', `第 ${s.no} 步已重置`);
  return s;
}

export function resetAllSteps(m) {
  if (!m.steps?.length) return m;
  // 骨架项目（还没上传小说）重置后 ①② 必须回到 pending，否则会出现「已完成但无原著」的假状态
  m.steps = freshSteps({ pending: m.kind === 'novel' && !m.source?.text });
  m.currentStep = m.kind === 'novel' && !m.source?.text ? 1 : 3;
  m.status = 'draft';
  logHistory(m, 'steps:reset', '六步任务状态已全部重置（节点状态未改动，可用「从此处重跑」）');
  return m;
}

/** 项目管理动作：所有写操作集中在此，便于审计与单元测试 */
export function applyManageAction(project, action, value) {
  const m = ensureManagement(project);
  switch (action) {
    case 'rename': {
      const name = String(value ?? '').trim().slice(0, 80);
      if (!name) return { ok: false, message: '名称不能为空' };
      project.name = name; m.title = name;
      markBasicConfirmed(m);   // 项目名属于第 ① 步的基础信息
      logHistory(m, 'rename', `重命名为「${name}」`);
      return { ok: true, message: `已重命名为「${name}」` };
    }
    case 'favorite':
      m.favorite = (value === undefined || value === null || value === '') ? !m.favorite : !!value;
      logHistory(m, 'favorite', m.favorite ? '加入收藏' : '取消收藏');
      return { ok: true, message: m.favorite ? '已加入收藏 ★' : '已取消收藏' };
    case 'archive':
      m.archived = (value === undefined || value === null || value === '') ? !m.archived : !!value;
      logHistory(m, 'archive', m.archived ? '归档项目' : '取消归档');
      return { ok: true, message: m.archived ? '项目已归档（列表默认隐藏）' : '项目已取消归档' };
    case 'tags': {
      const tags = (Array.isArray(value) ? value : String(value || '').split(/[,，\s]+/))
        .map((t) => String(t).trim().slice(0, 16)).filter(Boolean).slice(0, 8);
      m.tags = [...new Set(tags)];
      logHistory(m, 'tags', `标签：${m.tags.join(' / ') || '（清空）'}`);
      return { ok: true, message: `标签已更新：${m.tags.length} 个` };
    }
    case 'note':
      m.note = String(value ?? '').slice(0, 2000);
      logHistory(m, 'note', '更新项目备注');
      return { ok: true, message: '备注已保存' };
    case 'deliverables': {
      if (!m.deliverables) m.deliverables = { video: true, pack: true };
      const video = value?.video !== undefined ? !!value.video : m.deliverables.video;
      const pack = value?.pack !== undefined ? !!value.pack : m.deliverables.pack;
      if (!video && !pack) return { ok: false, message: '至少要选择一种交付物' };
      m.deliverables = { video, pack };
      const mode = video && pack ? 'both' : video ? 'video' : 'director-pack';
      project.settings = project.settings || {};
      project.settings.comfy = { ...(project.settings.comfy || {}), outputMode: mode };
      logHistory(m, 'deliverables', `交付物：${video ? '成片视频 ' : ''}${pack ? '导演包' : ''}（outputMode=${mode}）`);
      markBasicConfirmed(m);   // 交付形式属于第 ① 步的基础信息
      return { ok: true, message: `交付设置已更新：${mode}`, outputMode: mode };
    }
    case 'storyboard': {
      // 分镜画面设置：版式 / 画幅 / 格内信息 / 构图参考 / 提示词公式。
      // 只改设置，不在这里重排分镜板——重排是「保存并重排」按钮与第⑤步收尾的职责。
      const prev = m.storyboard || {};
      const patch = value && typeof value === 'object' ? value : {};
      const next = normalizeStoryboardSettings({
        ...prev,
        ...patch,
        prompt: { ...(prev.prompt || {}), ...(patch.prompt || {}) },
        updatedAt: Date.now(),
      });
      m.storyboard = next;
      const resolved = resolveStoryboardSettings(project);
      const text = describeStoryboardSettings(resolved);
      logHistory(m, 'storyboard', `分镜画面设置：${text}`);
      return {
        ok: true,
        message: `分镜画面设置已保存：${text}（点「重排分镜板」或重新执行第⑤步生效）`,
        storyboard: next,
      };
    }
    case 'split': {
      if (m.kind !== 'novel') return { ok: false, message: '标准项目没有分集参数' };
      m.split = {
        strategy: value?.strategy || m.split.strategy,
        targetChars: Number(value?.targetChars) || m.split.targetChars,
        maxEpisodes: Number(value?.maxEpisodes) || m.split.maxEpisodes,
        seasonSize: Math.max(1, Number(value?.seasonSize) || m.split.seasonSize || 12),
      };
      logHistory(m, 'split', `分集参数：${m.split.strategy} / ${m.split.targetChars} 字 / 最多 ${m.split.maxEpisodes} 集 · 每季 ${m.split.seasonSize} 集`);
      return { ok: true, message: '分集参数已保存（重新执行第 ② 步生效）' };
    }
    case 'bible': {
      const b = m.bible || (m.bible = defaultBible());
      // undefined = 本次未提交该字段，保留原值；空串 = 用户显式清空
      const s = (k, max) => value?.[k] === undefined ? b[k] : String(value[k]).slice(0, max);
      b.title = s('title', 80); b.genre = s('genre', 24); b.audience = s('audience', 24);
      b.logline = s('logline', 300);
      b.synopsis = s('synopsis', 2000) || '';   // 旧项目没有该字段时补空串，不落 undefined
      b.ending = s('ending', 24); b.artStyle = s('artStyle', 24); b.tone = s('tone', 24);
      b.firstEpisodeTheme = s('firstEpisodeTheme', 300);
      b.adaptation = s('adaptation', 1200); b.bottomLines = s('bottomLines', 1200);
      b.worldview = s('worldview', 4000); b.characters = s('characters', 6000);
      b.stylePrompt = s('stylePrompt', 600); b.negativePrompt = s('negativePrompt', 600);
      if (value?.totalEpisodes !== undefined) {
        b.totalEpisodes = Math.max(0, Math.min(600, Number(value.totalEpisodes) || 0));
      }
      // 总集数是分集目标的上位设定：同步分集参数，重新执行第 ② 步生效
      if (m.kind === 'novel' && b.totalEpisodes > 0 && m.split) {
        m.split.maxEpisodes = Math.max(1, Math.min(600, b.totalEpisodes));
      }
      // 保存即确认：第 ① 步没有独立的执行按钮，用户点了保存就等于「基础信息设置完成」，
      // 不能出现「提示已保存但步骤仍待执行」的错位（空提交也算确认，字段可随时再补）。
      markBasicConfirmed(m);
      logHistory(m, 'bible', `更新创作设定${b.title ? ` ·《${b.title}》` : ''}${b.totalEpisodes ? ` · 总集数 ${b.totalEpisodes}` : ''}`);
      return { ok: true, message: '创作设定已保存', bible: b };
    }
    case 'char-upsert': {
      if (!Array.isArray(m.characters)) m.characters = [];
      const raw = { ...(value || {}) };
      const name = String(raw.name || '').trim();
      if (!name) return { ok: false, message: '角色姓名不能为空' };
      // 音色绑定归一：给了 voiceId 就从全局音色库回填 voiceName（保持两者一致）；
      // 音色不存在视为无效绑定清空，避免角色挂着幽灵 voiceId。
      // 绑定变更时同步重置 voiceReason / voiceScore，不让旧理由挂在新音色上。
      if ('voiceId' in raw) {
        const voice = raw.voiceId ? getVoice(String(raw.voiceId)) : null;
        if (voice) {
          raw.voiceId = voice.id; raw.voiceName = voice.name;
          raw.voiceReason = String(raw.voiceReason || '').slice(0, 200) || `手动指定：${voice.name}`;
          raw.voiceScore = 0;
        } else {
          raw.voiceId = ''; raw.voiceName = ''; raw.voiceReason = ''; raw.voiceScore = 0;
        }
      }
      const idx = raw.id ? m.characters.findIndex((x) => x.id === raw.id) : -1;
      if (idx >= 0) {
        // 唯一性硬约束：一个音色在本项目里只能绑定一个角色。
        // 换绑 / 新绑到已被其它角色占用的音色时直接拒绝，并告知被谁占用。
        if (raw.voiceId && raw.voiceId !== m.characters[idx].voiceId) {
          const occupied = m.characters.find((c) => c.id !== raw.id && c.voiceId === raw.voiceId);
          if (occupied) {
            return { ok: false, message: `音色「${raw.voiceName}」已被角色「${occupied.name}」使用，不能重复绑定` };
          }
        }
        // 只在本 action 内合并更新；views 产物只由生成端点写入
        const prev = m.characters[idx];
        // 标记为「用户手改」：后续重新提取时不再覆盖这些字段
        const next = normalizeCharacter({ ...prev, ...raw, id: prev.id, source: prev.source, views: prev.views, edited: true, updatedAt: now() });
        m.characters[idx] = next;
        logHistory(m, 'characters', `更新角色「${next.name}」属性`);
        return { ok: true, message: `角色「${next.name}」已保存`, character: next };
      }
      if (m.characters.length >= MAX_CHARACTERS) return { ok: false, message: `角色最多 ${MAX_CHARACTERS} 个` };
      if (raw.voiceId) {
        const occupied = m.characters.find((c) => c.voiceId === raw.voiceId);
        if (occupied) {
          return { ok: false, message: `音色「${raw.voiceName}」已被角色「${occupied.name}」使用，不能重复绑定` };
        }
      }
      const created = normalizeCharacter({ ...raw, id: '', source: raw.source === 'llm' ? 'llm' : 'manual', updatedAt: now() });
      m.characters.push(created);
      logHistory(m, 'characters', `新增角色「${created.name}」`);
      return { ok: true, message: `角色「${created.name}」已添加`, character: created };
    }
    case 'char-del': {
      const id = String(value || '');
      const before = m.characters?.length || 0;
      m.characters = (m.characters || []).filter((c) => c.id !== id);
      if (m.characters.length === before) return { ok: false, message: '角色不存在' };
      logHistory(m, 'characters', '删除了一个角色');
      return { ok: true, message: '角色已删除' };
    }
    case 'characters': {
      const list = (Array.isArray(value) ? value : [])
        .map((c) => normalizeCharacter(c)).filter((c) => c.name).slice(0, MAX_CHARACTERS);
      m.characters = list;
      logHistory(m, 'characters', `角色列表已更新：${list.length} 个`);
      return { ok: true, message: `角色列表已更新：${list.length} 个`, characters: list };
    }
    case 'settings': {
      // 画面设置：风格 / 画幅（项目信息页可逐步补充，作用于 Provider 出图与视频）
      project.settings = project.settings || {};
      if (value?.style !== undefined) project.settings.style = String(value.style).slice(0, 24);
      if (value?.aspect !== undefined) {
        const aspect = String(value.aspect).slice(0, 8);
        if (!['16:9', '9:16'].includes(aspect)) return { ok: false, message: '画幅只支持 16:9 / 9:16' };
        const prev = project.settings.aspect;
        project.settings.aspect = aspect;
        // 画幅换了，成片规格的分辨率跟着换挡：16:9 的「高清」切到 9:16 仍是高清档，
        // 由 normalizeRuntimeSpec 的 pickResolution 按档位序号映射，不悄悄丢分辨率。
        if (prev !== aspect && m.runtime) {
          m.runtime = normalizeRuntimeSpec({ ...m.runtime, aspect });
        }
      }
      logHistory(m, 'settings', `画面设置：风格 ${project.settings.style || '默认'} · 画幅 ${project.settings.aspect || '默认'}`);
      markBasicConfirmed(m);   // 画面风格 / 画幅 属于第 ① 步的基础信息
      return { ok: true, message: '画面设置已保存' };
    }
    case 'director-skill': {
      // 技能清单由 core/director-skills.mjs 单点维护；这里只做形状校验，
      // 具体 id 是否合法由 normalizeStyleId / 技能清单归一，避免两个模块循环依赖。
      const raw = String(value?.skillId ?? value ?? '').trim().slice(0, 32);
      if (!raw) return { ok: false, message: '导演技能 id 不合法' };
      // 中文名 / 片名 / 英文写法都先归一（「张艺谋」→ zhangyimou），
      // 归一后仍必须是合法 id 形状，避免把任意脏字符串写进项目。
      const styleId = normalizeStyleId(raw);
      const id = styleId || raw.toLowerCase();
      if (!/^[a-z0-9_-]+$/.test(id)) return { ok: false, message: '导演技能 id 不合法' };
      // 只认「风格技能」或四份流程策略（字面量，与 director-skills.mjs 的 FLOW_SKILLS 对齐，
      // 不 import 它以免循环依赖）。未知 id 明确拒绝，而不是悄悄写进项目。
      if (!styleId && !FLOW_SKILL_IDS.includes(id)) {
        return { ok: false, message: `未知导演技能：${raw}` };
      }
      if (!m.director || m.director.schema !== 1) m.director = { schema: 1, skillId: id, treatment: null, lastRun: m.director?.lastRun || null };
      m.director.skillId = id;
      // 导演风格技能：顺手把 styleId 记到项目上，让「只选技能、还没跑全流程」
      // 时画面生成也已经按该导演的美学走（director-styles 无反向依赖，不会成环）。
      m.director.styleId = styleId || null;
      // 主色只属于某一位导演：换导演一律清空，回到新档案的默认主色。
      // 否则「北野武 + 竹林绿」这种跨档案残留会写进项目，虽然解析会回落默认，
      // 但落盘数据本身就是脏的，前端也会显示上一个导演的色号。
      m.director.paletteKey = null;
      logHistory(m, 'director:skill', `已选择导演技能「${id}」${styleId ? ' · 含画面风格' : ''}`);
      return { ok: true, message: `导演技能已切换为「${id}」`, skillId: id, styleId: styleId || null };
    }
    case 'director-palette': {
      // 主色调切换：只改 paletteKey（张艺谋四色 / 王家卫四色…），导演风格本身不变。
      // 必须已选风格技能，且 paletteKey 必须是该档案里真实存在的一项——
      // 否则宁可否掉，也不要让项目带上一个不存在的色号。
      const d = m.director && m.director.schema === 1 ? m.director : null;
      const style = getDirectorStyle(d?.styleId || '');
      const key = String(value?.paletteKey ?? value ?? '').trim();
      if (!style) return { ok: false, message: '尚未选择导演风格，无法切换主色调' };
      const pal = resolvePalette(style, key);
      // resolvePalette 对非法 key 会回落默认主色，这里必须核对用户要的就是这一色，
      // 否则「切了个不存在的颜色」会悄悄变成默认色，用户以为改成功了。
      if (!pal || (key && pal.key !== key)) {
        return { ok: false, message: `「${style.label}」没有主色调 ${key}，可选：${style.palettes.map((p) => p.key).join(' / ')}` };
      }
      d.paletteKey = pal.key;
      logHistory(m, 'director:palette', `主色调切换为「${pal.name}」${pal.hex}`);
      return { ok: true, message: `主色调已切换为「${pal.name}」`, paletteKey: pal.key, name: pal.name, hex: pal.hex };
    }
    case 'runtime': {
      if (m.kind !== 'novel') return { ok: false, message: '标准流水线项目不参与短剧时长规格' };
      const patch = Object.fromEntries(Object.entries(value || {}).filter(([, v]) => v !== undefined));
      // 分辨率结合画幅归一：画幅来自项目画面设置（settings.aspect），
      // width/height/resolution 任一给出都必须命中该画幅的档位，否则回落默认档。
      const next = normalizeRuntimeSpec({ ...(m.runtime || {}), ...patch, aspect: project.settings?.aspect });
      m.runtime = next;
      logHistory(m, 'runtime', `成片规格：${next.totalSeconds}s / ${next.clipSeconds}s × ${next.clipCount} 段 @ ${next.fps}fps · ${next.width}×${next.height} · ${next.filmPolicy === 'real' ? '真实 AI 视频' : '关键帧预览'}`);
      return {
        ok: true,
        message: `成片规格已保存：${next.clipCount} 个片段 × ${next.clipSeconds}s = ${next.totalSeconds}s · ${next.resolutionLabel} · ${next.filmPolicy === 'real' ? '真实 AI 视频模式（必须调用 ComfyUI）' : '关键帧预览模式（非 AI 视频，验收降级）'}${next.aligned ? '（总时长已按片段时长对齐）' : ''}`,
        runtime: next,
      };
    }
    case 'reset-steps':
      resetAllSteps(m);
      return { ok: true, message: '六步任务状态已重置' };
    case 'cover': {
      const source = ['upload', 'comfyui', 'ai'].includes(value?.source) ? value.source : 'name';
      const url = source === 'name' ? '' : String(value?.url || '').slice(0, 300);
      if (source !== 'name' && !url) return { ok: false, message: '封面图片地址不能为空' };
      m.cover = {
        url, source,
        // 完整保存生成时实际使用的提示词（不截断）：文本框内容即完整提示词，截断会破坏可复现性
        prompt: String(value?.prompt || ''),
        updatedAt: Date.now(),
      };
      logHistory(m, 'cover', source === 'name' ? '恢复为项目名称封面'
        : source === 'upload' ? '上传了项目封面图片'
        : source === 'ai' ? '用 AI 生成了项目封面' : '用 ComfyUI 生成了项目封面');
      markBasicConfirmed(m);   // 封面属于第 ① 步的基础信息
      return { ok: true, message: source === 'name' ? '已恢复为项目名称封面'
        : source === 'upload' ? '项目封面已上传'
        : source === 'ai' ? 'AI 封面已生成' : '项目封面已生成', cover: m.cover };
    }
    default:
      return { ok: false, message: `未知管理动作：${action}` };
  }
}

/** 管理面板 / 侧栏统计：全部由项目 JSON 推导，不额外维护计数 */
export function projectStats(project) {
  const nodes = project.nodes || [];
  const edges = project.edges || [];
  const m = ensureManagement(project);
  const final = nodes.find((n) => n.type === 'final');
  const p = stepProgress(m);
  // Token 汇总：六步累计 + 最近一次运行（不含标准项目 runs，标准项目见 runs[].tokens）
  const sumTokens = (m.steps || []).reduce((acc, s) => {
    for (const k of ['prompt', 'completion', 'total', 'calls']) acc[k] += s.tokens?.[k] || 0;
    return acc;
  }, { prompt: 0, completion: 0, total: 0, calls: 0 });
  return {
    nodeCount: nodes.length, edgeCount: edges.length,
    doneNodes: nodes.filter((n) => n.status === 'done').length,
    errorNodes: nodes.filter((n) => n.status === 'error').length,
    shotCount: nodes.filter((n) => n.type === 'shot').length,
    videoCount: nodes.filter((n) => n.type === 'video').length,
    anchorCount: edges.filter((e) => e.kind === 'anchor').length,
    refCount: edges.filter((e) => e.kind === 'ref').length,
    episodeCount: (m.episodes || []).length,
    runCount: (project.runs || []).length,
    lastRunAt: project.runs?.[0]?.finishedAt || null,
    tokens: sumTokens,
    lastRunTokens: project.runs?.[0]?.tokens || null,
    progress: p,
    film: final?.data?.film?.file ? { file: final.data.film.file, bytes: final.data.film.bytes } : null,
    pack: final?.data?.directorPack?.file ? {
      file: final.data.directorPack.file, filename: final.data.directorPack.filename,
      bytes: final.data.directorPack.bytes, fileCount: final.data.directorPack.fileCount,
    } : null,
  };
}

/** /api/bootstrap 与侧栏共用的轻量索引字段 */
export function projectIndex(p) {
  const m = p.management || createManagement({ kind: 'standard', title: p.name });
  const prog = stepProgress(m);
  // 项目级 token 累积：按全部运行汇总（创作类每步=一次运行，标准类每次编排=一次运行，两类项目统一口径）
  const tokens = (p.runs || []).reduce((a, r) => {
    for (const k of ['prompt', 'completion', 'total', 'calls']) a[k] += r.tokens?.[k] || 0;
    return a;
  }, { prompt: 0, completion: 0, total: 0, calls: 0 });
  return {
    id: p.id, name: p.name, mode: p.mode, updatedAt: p.updatedAt || 0,
    createdAt: p.createdAt || 0,
    nodeCount: (p.nodes || []).length,
    doneCount: (p.nodes || []).filter((n) => n.status === 'done').length,
    kind: m.kind, status: prog.status, favorite: !!m.favorite, archived: !!m.archived,
    tags: m.tags || [], episodeCount: (m.episodes || []).length,
    stepDone: prog.done, stepTotal: prog.total, progress: prog.percent,
    tokens,
    deliverables: m.deliverables || { video: true, pack: true },
    directorSkillId: m.director?.skillId || 'full',
    directorComplete: !!m.director?.lastRun?.complete,
    clipSeconds: m.runtime?.clipSeconds || 3,
    clipCount: m.runtime?.clipCount || 10,
    totalSeconds: m.runtime?.totalSeconds || 30,
    cover: m.cover || { url: '', source: 'name', updatedAt: 0, prompt: '' },
    hasPack: !!(p.nodes || []).find((n) => n.type === 'final')?.data?.directorPack?.file,
    // LLM 配置摘要（绝不含明文 Key）：「已配置模型清单」据此免解析完整项目 JSON
    llm: {
      provider: p.settings?.provider, model: p.settings?.model,
      baseUrl: p.settings?.baseUrl, hasApiKey: Boolean(p.settings?.apiKey),
    },
  };
}
