/* ============================================================================
 * 统一格式剧本（Unified Screenplay v2）· 论文式(1) 的产物契约
 *
 * 𝒮 = ScreenWriting(ℐ; P_C(ℐ))
 *
 * 为什么要单独一层：
 *  - 「剧本不够详细」的根因不是模型不会写，而是**契约太薄**：旧 schema 只有
 *    {location,time,summary,script}，模型给 3 场概述就「符合要求」；下游分解、
 *    分镜、配音也拿不到人物动机、场景目标、情绪节拍这些可拍的东西。
 *  - 这里把「统一格式」定义成一份可执行的数据契约（schema v2），并给出两套
 *    写作准则：整剧（创作项目第③步）与单集（分集剧本）。提示词、零 Key 兜底、
 *    归一、统计、Markdown 导出、前端展示全部读同一份定义，避免各处口径分叉。
 *
 * 契约（v2，向后兼容 v1）：
 *   {
 *     schema: 2, title, genre, logline, tone, theme, style,
 *     durationSec, sceneCount,
 *     characters: [{ name, role, age, gender, identity, personality,
 *                    motivation, secret, arc, appearance, voice }],
 *     acts:     [{ no, name, purpose, sceneNos }],
 *     episodes: [{ no, title, logline, hook }],
 *     scenes:   [{
 *       id, no, episodeNo, act,
 *       interior: '内景' | '外景' | '内外景', location, time, durationSec,
 *       characters: [名称],
 *       summary,    // 这一场发生了什么（一句话）
 *       objective,  // 本场谁想要什么
 *       conflict,   // 阻力是什么
 *       turn,       // 结束时发生的变化 / 揭示
 *       beat,       // 情绪节拍：试探→逼近→崩塌
 *       mood, keyProp, transition,
 *       script: [string]   // 可拍摄正文行（对白 / 动作 / 画面 / 旁白 / 音效）
 *     }],
 *     coverage: { totalEpisodes, coveredEpisodes, scenesPerEpisode }
 *   }
 * ==========================================================================*/

const str = (v) => String(v ?? '').trim();
const cut = (s, n) => { const t = str(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* --------------------------------------------------------------- 数据契约 */

/**
 * 喂给模型的输出结构说明（system 提示里 `输出结构：…` 的那一段）。
 * 字段顺序即写作顺序：先定人物与幕，再逐场写戏，最后落到正文行。
 */
export const SCREENPLAY_SCHEMA = [
  '统一格式剧本（v2）：{',
  'title, genre, logline, tone, theme, style,',
  'durationSec:number(全片或本集预估秒数),',
  'characters:[{name,role,age,gender,identity(身份/职业),personality,motivation(本片最想得到的东西),secret(不肯说出口的秘密),arc(从开场到结尾的变化),appearance(可视觉化的外形),voice(说话方式与口癖)}],',
  'acts:[{no,name,purpose}]（2~4 幕，name 形如「第一幕 · 失衡」，purpose 写这一幕把故事推到哪）,',
  'episodes:[{no,title,logline,hook}]（分集映射，与输入 novelEpisodes 对齐；单集剧本可省略）,',
  'scenes:[{id,no,episodeNo,act,interior:"内景"|"外景"|"内外景",location,time,durationSec:number,characters:[名称],',
  '  summary(这一场发生了什么),objective(本场谁想要什么),conflict(阻力是什么),turn(结束时发生的变化或揭示),',
  '  beat(情绪节拍，如「试探→逼近→崩塌」),mood(情绪基调),keyProp(关键道具/视觉母题),transition(转场方式),',
  '  script:[字符串]}',
  ']',
  '}',
  '（scenes 不能为空；每场必须写满 objective / conflict / turn / beat / transition，不能只写概述）',
].join('');

/**
 * 剧本正文行规范（整剧与单集共用，写进 system 提示）。
 * 只约束「一行长什么样」，不涉及内容取向，便于测试与评审。
 */
export const SCREENPLAY_FORMAT_GUIDE = [
  '剧本正文只写可拍摄的内容，一行一个信息单元：',
  '· 对白：`角色名（情绪或动作提示）：「台词」`，情绪提示可省略；台词必须是这个角色此刻真的会说出口的话。',
  '· 动作：`动作：……` 写可见的行为、走位、手部与眼神细节；不写心理活动（心理活动要转成动作或台词）。',
  '· 画面：`画面：……` 写环境、光线、天气、道具、景深处的视觉信息。',
  '· 旁白：`旁白：……` 只用于小说改编里无法拍出来的叙述信息，一集不超过 5 行。',
  '· 音效：`音效：……` 只写画内声（门响、雨声、脚步、枪栓），不写配乐与 BGM。',
  '· 场次首行可写 `【时间 · 地点】`，必须与场次头 location / time 一致。',
  '禁止写镜号、景别、运镜、机位、BGM、字幕样式——这些属于分镜阶段，不是剧本。',
  '每场正文至少 6 行，其中至少 2 句对白；确为默场时在 beat 标注「默场」，并用 `画面：` 补足可拍信息。单条台词不超过 60 字。',
].join('\n');

/**
 * 单集剧本写作准则（分集剧本 / 剧集详情页「生成本集剧本」）。
 * 固定写进 system 提示的硬约束，对应「每集各自生成、开场像第一集、没有对白」的旧问题。
 */
export const SCREENPLAY_GUIDE = [
  '只写本集：覆盖 originalText 的关键事件与情绪转折，不要把整本书或其它集的内容浓缩进来。',
  '场次数量贴近 targetScenes（3~10 场）：每场都要有 location、time、summary 与 script 正文，过场戏合并，不要用一场戏写完全集。',
  'script 每行必须是可拍摄的内容：对白写「角色名：「台词」」，动作/画面写「动作：……」，场景提示写「【时间 · 地点】」；不要写镜号、景别、运镜、BGM 等拍摄指令。',
  '开场三句内承接 prevRecap / prevTail（上一集结尾的人物处境或悬念），结尾必须落到本集 hook，可用台词、动作或一个明确的画面悬念。',
  '角色只能来自 characters 名单（可加「旁白」「画外音」「众人」）；不要新造人名，也不要把未出场角色硬塞进来。',
  '对白要推进冲突或暴露信息，单条不超过 60 字；避免「你知道吗，事情是这样的」这类解释性台词。',
  '保留原文的专有名词（地点、道具、案件名、组织名），改写时不得替换成泛称。',
  '每场必须写满戏剧结构：objective（谁想要什么）、conflict（什么在拦他）、turn（结束时发生了什么变化或揭示）、beat（情绪节拍）、transition（怎么离场）。',
  '细节必须来自原文：地名、时间、天气、道具、身体动作、原句对白都要写具体；禁止用「气氛紧张」「众人震惊」这类概述代替画面。',
  '只输出严格 JSON，不要 Markdown 代码块、不要解释；scenes 不要为空。',
].join('\n');

/**
 * 整剧统一格式剧本写作准则（创作项目第③步 · 式(1)）。
 * 与单集不同：输入是一本书的分集梗概，必须逐集展开并标注 episodeNo。
 */
export const SCREENPLAY_PROJECT_GUIDE = [
  '整剧统一格式：输入是 novelEpisodes（每集含 title / summary / hook / excerpt / sourceTitles），要把每一集都写成可拍摄的场次，scenes[].episodeNo 必须标注属于第几集。',
  '每集至少 2 场、建议 2~3 场（全剧不超过 24 场）；同集内按「建置 → 施压 → 抛出钩子」推进，本集最后一场必须落到该集 hook。',
  '第一场用三句话之内建立：谁在什么处境、缺了什么、什么事件打破了平衡；不要在开场做世界观解说。',
  '场次信息必须具体：interior 写内景 / 外景 / 内外景，location 用原文里的具体地点（不要写「段落 1」这类拆分标签），time 写清晨 / 午后 / 黄昏 / 夜 / 深夜这类可打光的时间。',
  '每场必须写满戏剧结构：objective（谁想要什么）、conflict（什么在拦他）、turn（结束时发生了什么变化或揭示）、beat（情绪节拍）、transition（怎么离场）；只写剧情概述不合格。',
  '用 excerpt 里的原文细节写戏：专有名词、道具、天气、身体动作、原句对白都要保留；禁止用「气氛紧张」「众人震惊」这类概述代替画面。',
  '角色只能来自 characters 名单（可加「旁白」「画外音」「众人」）；不要新造人名。',
  '对白要推进冲突或暴露信息，单条不超过 60 字；避免解释性台词与自我介绍式对白。',
  '分集超过 12 集时，只写前 12 集（其余集留给分集剧本），并在 logline 里说明覆盖范围。',
  '只输出严格 JSON，不要 Markdown 代码块、不要解释；scenes 不要为空。',
].join('\n');

/** 按输入形态选写作准则：带 originalText / episodeNo 的是单集，带 episodes 的是整剧 */
export function isEpisodeScreenplay(vars = {}) {
  if (Array.isArray(vars.episodes) && vars.episodes.length) return false;
  if (Array.isArray(vars.novelEpisodes) && vars.novelEpisodes.length) return false;
  return Boolean(str(vars.originalText) || num(vars.episodeNo));
}

/** 拼出完整写作准则（含正文行规范），供 providers 组装 system 提示 */
export function screenplayGuide(vars = {}) {
  const head = isEpisodeScreenplay(vars) ? '剧本写作准则（单集）：\n' : '剧本写作准则（整剧）：\n';
  const body = isEpisodeScreenplay(vars) ? SCREENPLAY_GUIDE : SCREENPLAY_PROJECT_GUIDE;
  return `${head}${body}\n\n剧本正文行规范：\n${SCREENPLAY_FORMAT_GUIDE}`;
}

/* --------------------------------------------------------------- 行解析 */

/** 行首关键词 → 行类型（这些不是说话人，避免被当成角色） */
const LINE_KEYWORDS = {
  动作: 'action', 画面: 'action', 镜头: 'action',
  旁白: 'narration', 画外音: 'narration', 内心: 'narration',
  音效: 'sound', 声音: 'sound', 环境声: 'sound',
  字幕: 'subtitle', 备注: 'note', 注: 'note',
  场景: 'note', 时间: 'note', 地点: 'note', 转场: 'note',
};

/**
 * 把一行正文解析成 { kind, speaker, text }。
 * kind：dialogue | action | narration | sound | subtitle | note | heading | plain | empty
 * 说话人允许带情绪提示：`沈砚（低声）：「…」` → speaker = 沈砚。
 */
export function parseScriptLine(raw) {
  const line = str(raw);
  if (!line) return { kind: 'empty', speaker: '', text: '' };
  if (/^【.*】$/.test(line)) return { kind: 'heading', speaker: '', text: line.replace(/^【|】$/g, '') };
  // 说话人允许带情绪提示：`沈砚（低声）：「…」` → speaker = 沈砚。
  // 括号必须排除在名字字符集外，否则会把「沈砚（低声）」整体当成人名。
  const m = line.match(/^([^：:\s【】（）()]{1,12})(?:（[^）]{0,16}）|\([^)]{0,16}\))?\s*[：:]\s*([\s\S]*)$/);
  if (!m) return { kind: 'plain', speaker: '', text: line };
  const head = m[1].trim();
  const body = str(m[2]).replace(/^[「“"']+/, '').replace(/[」”"']+$/, '').trim();
  const kw = LINE_KEYWORDS[head];
  if (kw) return { kind: kw, speaker: '', text: body };
  return { kind: 'dialogue', speaker: head, text: body };
}

/** 一场景正文里的说话人（去重、保序） */
export function sceneSpeakers(lines = []) {
  const out = [];
  const seen = new Set();
  for (const line of (Array.isArray(lines) ? lines : [])) {
    const p = parseScriptLine(line);
    if (p.kind !== 'dialogue' || !p.speaker || seen.has(p.speaker)) continue;
    seen.add(p.speaker);
    out.push(p.speaker);
  }
  return out;
}

/* --------------------------------------------------------------- 结构补全 */

/**
 * 剧本 v2 相对 v1 新增的场次字段。归一（normalizeEpisodeScript）与人工编辑
 * （mergeScriptEdit）必须原样保留这些字段，否则「点一次编辑保存」就把场景目标、
 * 情绪节拍、转场这些信息全丢了。
 */
export const SCENE_EXTRA_KEYS = [
  'episodeNo', 'no', 'act', 'interior', 'durationSec', 'characters',
  'objective', 'conflict', 'turn', 'beat', 'mood', 'keyProp', 'transition', 'props',
];

const INT_WORDS = /室|房|屋|厅|店|铺|办公室|办公区|教室|走廊|楼道|车内|车厢|仓库|酒楼|客栈|厨房|卧室|书房|医院|警局|派出所|档案|电梯|大堂|包间|宿舍|网吧|机房/;
const EXT_WORDS = /街|巷|路|桥|山|河|海|码头|操场|天台|田野|树林|广场|庭院|院|门外|门口|荒野|沙漠|雪原|江边|湖畔|雨|雪/;

/** 由地点推断内外景：内 / 外都命中记「内外景」，都不命中记「内外景」（不假装知道） */
export function guessInterior(location = '', text = '') {
  const loc = str(location);
  const hay = loc || str(text);
  const int = INT_WORDS.test(hay);
  const ext = EXT_WORDS.test(hay);
  if (int && ext) return '内外景';
  if (int) return '内景';
  if (ext) return '外景';
  return '内外景';
}

/** 地点可能把内外景写进字符串（「内景 · 仓库」），拆出来并清洗「段落 1」这类占位 */
function parseLocation(interior, location) {
  let loc = cut(str(location).replace(/^[\s【\[]+|[\s】\]]+$/g, ''), 40);
  let it = str(interior);
  const m = loc.match(/^(内景|外景|内外景)\s*[·・:：\-\s]\s*(.+)$/);
  if (m) { it = it || m[1]; loc = m[2].trim(); }
  if (!/^(内景|外景|内外景)$/.test(it)) it = guessInterior(loc);
  return { interior: it, location: loc || '未指定场景' };
}

/** 按场次序号推幕名：少于 3 场不分幕，其余按建置 / 对抗 / 解决三段 */
export function actNameFor(index = 0, total = 1) {
  if (total <= 2) return '第一幕 · 起落';
  const third = total / 3;
  if (index < third) return '第一幕 · 建置';
  if (index < third * 2) return '第二幕 · 对抗';
  return '第三幕 · 解决';
}

/** 正文行数 → 时长估计（每行约 4 秒，8~90 秒） */
function estimateDuration(lines = [], raw = {}) {
  const given = num(raw?.durationSec) || num(raw?.duration);
  if (given) return clamp(Math.round(given), 3, 300);
  return clamp(Math.round((Array.isArray(lines) ? lines.length : 1) * 4), 8, 90);
}

/**
 * 单场补全：只补结构与可推导字段（场号 / 内外景 / 时长 / 说话人），
 * 不生成剧情内容——内容由模型或零 Key 兜底负责，避免虚构冒充。
 */
function shapeScene(raw = {}, index = 0, ctx = {}) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const lines = (Array.isArray(s.script) ? s.script : str(s.script).split(/\n+/))
    .map((l) => cut(str(l), 220)).filter(Boolean).slice(0, 80);
  const { interior, location } = parseLocation(s.interior, s.location);
  const speakers = sceneSpeakers(lines);
  const declared = Array.isArray(s.characters)
    ? s.characters.map((c) => cut(str(c), 24)).filter(Boolean)
    : str(s.characters).split(/[,，、]/).map((c) => cut(c, 24)).filter(Boolean);
  const characters = [...new Set([...declared, ...speakers])].slice(0, 10);
  const total = ctx.total || 1;
  // 没标 episodeNo 时按场次顺序均分到各集，保证「每集都有戏」可被下游按集消费
  const epIndex = ctx.episodes.length
    ? clamp(Math.floor(index / Math.max(1, ctx.perEpisode)), 0, ctx.episodes.length - 1)
    : -1;
  const episodeNo = num(s.episodeNo)
    || (epIndex >= 0 ? num(ctx.episodes[epIndex].no, epIndex + 1) : num(ctx.fallbackEpisodeNo, 1));
  return {
    ...s,
    id: cut(s.id || `SC${String(index + 1).padStart(2, '0')}`, 16),
    no: num(s.no) || index + 1,
    episodeNo,
    act: cut(s.act, 32) || actNameFor(index, total),
    interior,
    location,
    time: cut(s.time, 24),
    durationSec: estimateDuration(lines, s),
    characters,
    summary: cut(s.summary, 200),
    objective: cut(s.objective, 120),
    conflict: cut(s.conflict, 120),
    turn: cut(s.turn, 120),
    beat: cut(s.beat, 60),
    mood: cut(s.mood, 40),
    keyProp: cut(s.keyProp, 40),
    props: Array.isArray(s.props)
      ? s.props.map((x) => cut(x, 24)).filter(Boolean).slice(0, 6)
      : str(s.props).split(/[,，、]/).map((x) => cut(x, 24)).filter(Boolean).slice(0, 6),
    transition: cut(s.transition, 24) || '切至',
    script: lines,
  };
}

function normalizeCharacters(list = [], vars = {}) {
  const src = (Array.isArray(list) && list.length ? list : (Array.isArray(vars.characters) ? vars.characters : []))
    .filter((c) => c && (c.name || typeof c === 'string'));
  const seen = new Set();
  return src.map((c) => {
    const o = typeof c === 'string' ? { name: c } : c;
    return {
      name: cut(o.name, 24),
      role: cut(o.role, 24),
      age: cut(o.age, 12),
      gender: cut(o.gender, 8),
      identity: cut(o.identity, 40),
      personality: cut(o.personality, 80),
      motivation: cut(o.motivation, 80),
      secret: cut(o.secret, 80),
      arc: cut(o.arc, 100),
      appearance: cut(o.appearance, 160),
      voice: cut(o.voice, 60),
    };
  }).filter((c) => c.name && !seen.has(c.name) && seen.add(c.name)).slice(0, 12);
}

function normalizeActs(list = [], scenes = []) {
  if (Array.isArray(list) && list.length) {
    return list.slice(0, 6).map((a, i) => ({
      no: num(a?.no) || i + 1,
      name: cut(a?.name, 32) || actNameFor(i, list.length),
      purpose: cut(a?.purpose, 120),
      sceneNos: (Array.isArray(a?.sceneNos) ? a.sceneNos : scenes.filter((s) => s.act === a?.name).map((s) => s.no)).slice(0, 30),
    }));
  }
  const names = [];
  for (const s of scenes) if (s.act && !names.includes(s.act)) names.push(s.act);
  return names.map((name, i) => ({
    no: i + 1, name, purpose: '',
    sceneNos: scenes.filter((s) => s.act === name).map((s) => s.no),
  }));
}

/**
 * 把模型输出 / 兜底输出统一成 v2 剧本：补结构、算时长、算分集覆盖。
 * 幂等：对已经是 v2 的对象再跑一次，结果不变。
 */
export function enrichScreenplay(input = {}, vars = {}) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const episodes = (Array.isArray(vars.episodes) ? vars.episodes : []).filter((e) => e && (e.no || e.title));
  const fallbackEpisodeNo = num(vars.episodeNo) || 1;
  const rawScenes = Array.isArray(src.scenes) ? src.scenes : [];
  const perEpisode = episodes.length ? Math.max(1, Math.ceil(rawScenes.length / episodes.length)) : 1;
  const scenes = rawScenes.map((s, i) => shapeScene(s, i, {
    total: rawScenes.length, episodes, perEpisode, fallbackEpisodeNo,
  }));
  const durationSec = scenes.reduce((n, s) => n + s.durationSec, 0);
  const episodeList = (episodes.length ? episodes : (Array.isArray(src.episodes) ? src.episodes : []))
    .map((e, i) => ({
      no: num(e?.no) || i + 1,
      title: cut(e?.title, 80),
      logline: cut(e?.logline ?? e?.summary, 200),
      hook: cut(e?.hook, 200),
    }));
  const coveredEpisodes = [...new Set(scenes.map((s) => s.episodeNo))].sort((a, b) => a - b);
  return {
    ...src,
    schema: 2,
    title: cut(src.title, 120) || cut(vars.title, 120) || '未命名剧本',
    genre: cut(src.genre || vars.genre, 60),
    logline: cut(src.logline || vars.logline || vars.idea, 300),
    tone: cut(src.tone || vars.tone, 60),
    theme: cut(src.theme, 80),
    style: cut(src.style || vars.style, 40),
    characters: normalizeCharacters(src.characters, vars),
    acts: normalizeActs(src.acts, scenes),
    episodes: episodeList,
    scenes,
    durationSec,
    sceneCount: scenes.length,
    coverage: {
      totalEpisodes: episodeList.length,
      coveredEpisodes,
      scenesPerEpisode: Object.fromEntries(coveredEpisodes.map((no) => [no, scenes.filter((s) => s.episodeNo === no).length])),
    },
  };
}

/** 场次标题（前端 / Markdown 共用）：`内景 · 仓库 · 夜` */
export function sceneHeading(scene = {}) {
  const { interior, location } = parseLocation(scene.interior, scene.location);
  return [interior, location, cut(scene.time, 24)].filter(Boolean).join(' · ');
}

/** 时长格式化：95 → 1′35″ */
export function formatDuration(sec = 0) {
  const n = Math.max(0, Math.round(num(sec)));
  if (n < 60) return `${n}″`;
  return `${Math.floor(n / 60)}′${String(n % 60).padStart(2, '0')}″`;
}
