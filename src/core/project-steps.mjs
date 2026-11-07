/* ============================================================================
 * 创作项目管理层 · 纯逻辑（六步任务定义、状态机、元数据、统计、管理动作）
 *
 * 六步严格按 ViMax 论文（arXiv:2606.07649v2）式(1)–(8) 的机制顺序编排，
 * 并把每一步映射到本仓库真实执行的节点类型（scope），供 orchestrator 分阶段调度。
 * 理论依据与消融数据见 docs/THEORY.md；论文原文见 docs/paper/。
 * ==========================================================================*/
import { normalizeCharacter, MAX_CHARACTERS } from './characters.mjs';

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
    id: 'storyboard', no: 5, title: '分镜 · 机位图 · 择优 · 片段', short: '视觉一致性的三根支柱',
    icon: '⌗', auto: false, scope: ['keyframe', 'review', 'video', 'transition', 'camera'], nodeLabel: '分镜 / 择优 / 片段节点',
    desc: '按镜头规格生成 k 张候选关键帧并 VLM 择优；机位依赖图按拓扑序传播视觉锚点，跨机位转场视频锁定三维空间关系；最后逐镜头生成视频片段。',
    checklist: ['每镜头 best-of-2 择优并记录评分', 'anchor 边传播视觉锚点 + 转场空间锚点', '机位依赖图统计并行层与一致性'],
    theory: {
      ref: '式(2)(3)(4)(7)(8)',
      text: 'ShotPlanning 出分镜规格；GenConditioned(Sᵢ, Aᵢ) 让依赖机位继承前驱锚点；GenTransition / ExtractViews 用转场视频锁空间；C* = argmax VLM-Judge 做质量闸门（论文 RQ6：k=2 最优）。',
      map: [['式(2)(7)', 'src/agents/narrative.mjs · storyboard / camera-graph'], ['式(3)', 'src/agents/visual.mjs · keyframe / video'], ['式(4)', 'src/agents/visual.mjs · review（k=2）'], ['式(8)', 'src/agents/visual.mjs · transition + anchor 边'], ['消融', '去全部跨镜头依赖 GC −8.7%；去 VLM 择优 −3.8%'], ['并行', 'src/core/orchestrator.mjs · topoLayers（405s / GC 0.5571）']],
    },
  },
  {
    id: 'deliver', no: 6, title: '双产物交付', short: '成片视频 / 导演包',
    icon: '✦', auto: false, scope: ['final'], nodeLabel: '成片时间线节点',
    desc: '组装成片时间线与封面，按交付设置产出 ① 成片视频（本机 ComfyUI 真实片段经 ffmpeg 拼接）或 ② *.mmxpack.zip 导演包（可导入 ComfyUI MiniMax H3 Director）。',
    checklist: ['时间线节点汇总所有片段并变绿 ✓', '导演包已生成且可下载', '成片视频按配置产出或明确标注降级原因'],
    theory: {
      ref: '式(3) + 依赖图并行调度',
      text: '生成阶段以「镜头规格 + 关键帧」为条件逐镜头出片，依赖图拓扑序保证同层可并行；成片与交接包是流水线末端的可交付状态（论文未展开交付格式，属本项目扩展）。',
      map: [['式(3)', 'ImageGen → VideoGen（providers / comfyui）'], ['交付 A', 'src/core/film.mjs · stitchClips → MP4'], ['交付 B', 'src/core/director-pack.mjs · exportDirectorPack → mmxpack.zip'], ['RQ4', '完整依赖图 405s / GC 0.5571']],
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
    tokens: zeroTokens(), lastTokens: null,
  }));
}

/** 漫剧基础信息（创作设定）：分集展示与 AI 生成环节的统一依据；长文本字段宽容存储，前端负责编辑 */
export function defaultBible(opts = {}) {
  return {
    title: String(opts.title || '').slice(0, 80),        // 剧名（可与项目名不同）
    genre: '', audience: '',
    logline: String(opts.logline || '').slice(0, 300),   // 一句话简介（AI 补全 / 手动填写）
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
  // 老项目惰性补角色库并逐项归一
  if (!Array.isArray(project.management.characters)) project.management.characters = [];
  else project.management.characters = project.management.characters.map((c) => normalizeCharacter(c));
  // 老项目惰性补剧集详情字段，保证单集详情页对历史项目也可用
  if (!Array.isArray(project.management.chapters)) project.management.chapters = [];
  if (!Array.isArray(project.management.sources)) project.management.sources = [];
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

export function startStep(m, id) {
  const s = m.steps?.find((x) => x.id === id);
  if (!s) return null;
  s.status = 'running'; s.startedAt = now(); s.finishedAt = null; s.note = '智能体执行中…';
  s.runs = (s.runs || 0) + 1;
  if (!s.tokens) s.tokens = zeroTokens();
  s.lastTokens = null;                       // 本次运行明细从零开始，完成时写入
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
  s.status = ok ? 'done' : 'error';
  s.finishedAt = now(); s.durationMs = durationMs;
  s.note = note || (ok ? '执行完成' : '执行失败，可重试');
  if (!s.tokens) s.tokens = zeroTokens();
  addTokens(s, tokens);
  const p = stepProgress(m);
  m.currentStep = p.currentNo;
  m.status = p.failed ? 'error' : p.allDone ? 'done' : 'draft';
  const tokNote = s.tokens.total ? ` · ${fmtTokens(s.tokens.total)} tokens` : '';
  logHistory(m, ok ? 'step:done' : 'step:error', `第 ${s.no} 步 · ${STEP_BY_ID[id]?.title || id} · ${s.note}${tokNote}`);
  return s;
}

/** token 数字格式化：≥1000 显示 x.xk（前端同规则） */
function fmtTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function resetStep(m, id) {
  const s = m.steps?.find((x) => x.id === id);
  if (!s || STEP_BY_ID[id]?.auto) return null;
  s.status = 'pending'; s.startedAt = null; s.finishedAt = null; s.note = '已重置，等待重新执行'; s.durationMs = 0;
  s.tokens = zeroTokens(); s.lastTokens = null;
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
      return { ok: true, message: `交付设置已更新：${mode}`, outputMode: mode };
    }
    case 'split': {
      if (m.kind !== 'novel') return { ok: false, message: '标准项目没有分集参数' };
      m.split = {
        strategy: value?.strategy || m.split.strategy,
        targetChars: Number(value?.targetChars) || m.split.targetChars,
        maxEpisodes: Number(value?.maxEpisodes) || m.split.maxEpisodes,
      };
      logHistory(m, 'split', `分集参数：${m.split.strategy} / ${m.split.targetChars} 字 / 最多 ${m.split.maxEpisodes} 集`);
      return { ok: true, message: '分集参数已保存（重新执行第 ② 步生效）' };
    }
    case 'bible': {
      const b = m.bible || (m.bible = defaultBible());
      // undefined = 本次未提交该字段，保留原值；空串 = 用户显式清空
      const s = (k, max) => value?.[k] === undefined ? b[k] : String(value[k]).slice(0, max);
      b.title = s('title', 80); b.genre = s('genre', 24); b.audience = s('audience', 24);
      b.logline = s('logline', 300);
      b.ending = s('ending', 24); b.artStyle = s('artStyle', 24); b.tone = s('tone', 24);
      b.firstEpisodeTheme = s('firstEpisodeTheme', 300);
      b.adaptation = s('adaptation', 1200); b.bottomLines = s('bottomLines', 1200);
      b.worldview = s('worldview', 4000); b.characters = s('characters', 6000);
      b.stylePrompt = s('stylePrompt', 600); b.negativePrompt = s('negativePrompt', 600);
      if (value?.totalEpisodes !== undefined) {
        b.totalEpisodes = Math.max(0, Math.min(64, Number(value.totalEpisodes) || 0));
      }
      // 总集数是分集目标的上位设定：同步分集参数，重新执行第 ② 步生效
      if (m.kind === 'novel' && b.totalEpisodes > 0 && m.split) {
        m.split.maxEpisodes = Math.max(1, Math.min(12, b.totalEpisodes));
      }
      logHistory(m, 'bible', `更新创作设定${b.title ? ` ·《${b.title}》` : ''}${b.totalEpisodes ? ` · 总集数 ${b.totalEpisodes}` : ''}`);
      return { ok: true, message: '创作设定已保存', bible: b };
    }
    case 'char-upsert': {
      if (!Array.isArray(m.characters)) m.characters = [];
      const raw = { ...(value || {}) };
      const name = String(raw.name || '').trim();
      if (!name) return { ok: false, message: '角色姓名不能为空' };
      const idx = raw.id ? m.characters.findIndex((x) => x.id === raw.id) : -1;
      if (idx >= 0) {
        // 只在本 action 内合并更新；views 产物只由生成端点写入
        const prev = m.characters[idx];
        // 标记为「用户手改」：后续重新提取时不再覆盖这些字段
        const next = normalizeCharacter({ ...prev, ...raw, id: prev.id, source: prev.source, views: prev.views, edited: true, updatedAt: now() });
        m.characters[idx] = next;
        logHistory(m, 'characters', `更新角色「${next.name}」属性`);
        return { ok: true, message: `角色「${next.name}」已保存`, character: next };
      }
      if (m.characters.length >= MAX_CHARACTERS) return { ok: false, message: `角色最多 ${MAX_CHARACTERS} 个` };
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
        project.settings.aspect = aspect;
      }
      logHistory(m, 'settings', `画面设置：风格 ${project.settings.style || '默认'} · 画幅 ${project.settings.aspect || '默认'}`);
      return { ok: true, message: '画面设置已保存' };
    }
    case 'reset-steps':
      resetAllSteps(m);
      return { ok: true, message: '六步任务状态已重置' };
    case 'cover': {
      const source = ['upload', 'comfyui'].includes(value?.source) ? value.source : 'name';
      const url = source === 'name' ? '' : String(value?.url || '').slice(0, 300);
      if (source !== 'name' && !url) return { ok: false, message: '封面图片地址不能为空' };
      m.cover = {
        url, source,
        // 完整保存生成时实际使用的提示词（不截断）：文本框内容即完整提示词，截断会破坏可复现性
        prompt: String(value?.prompt || ''),
        updatedAt: Date.now(),
      };
      logHistory(m, 'cover', source === 'name' ? '恢复为项目名称封面'
        : source === 'upload' ? '上传了项目封面图片' : '用 ComfyUI 生成了项目封面');
      return { ok: true, message: source === 'name' ? '已恢复为项目名称封面'
        : source === 'upload' ? '项目封面已上传' : '项目封面已生成', cover: m.cover };
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
    cover: m.cover || { url: '', source: 'name', updatedAt: 0, prompt: '' },
    hasPack: !!(p.nodes || []).find((n) => n.type === 'final')?.data?.directorPack?.file,
    // LLM 配置摘要（绝不含明文 Key）：「已配置模型清单」据此免解析完整项目 JSON
    llm: {
      provider: p.settings?.provider, model: p.settings?.model,
      baseUrl: p.settings?.baseUrl, hasApiKey: Boolean(p.settings?.apiKey),
    },
  };
}
