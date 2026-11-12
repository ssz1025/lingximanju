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
 * v3 增量（2026-11-11）：正文行改为「可拍摄契约」——集/场编号、圆括号动作行
 *   （一段一个可见变化）、表演策略、[OS]/[VO]/[SFX]/[画面文字]/[连续性] 五类标记；
 *   parseScriptLine 双兼容旧格式，新增 parseScriptLineRich 供下游读标记与表演策略。
 *
 * 契约（v3，向后兼容 v1/v2）：
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
  '统一格式剧本（v3）：{',
  'title, genre, logline, tone, theme, style,',
  'episodeCode:string(本集编号，如 EP001；整剧可省略),',
  'durationSec:number(全片或本集预估秒数),',
  'characters:[{name,role,age,gender,identity(身份/职业),personality,motivation(本片最想得到的东西),secret(不肯说出口的秘密),arc(从开场到结尾的变化),appearance(可视觉化的外形),voice(说话方式与口癖)}],',
  'acts:[{no,name,purpose}]（2~4 幕，name 形如「第一幕 · 失衡」，purpose 写这一幕把故事推到哪）,',
  'episodes:[{no,title,logline,hook}]（分集映射，与输入 novelEpisodes 对齐；单集剧本可省略）,',
  'scenes:[{id,no,sceneCode:string(场次编号，如 EP001-SC001),episodeNo,act,interior:"内景"|"外景"|"内外景",location,time,durationSec:number,characters:[名称],',
  '  summary(这一场发生了什么),objective(本场谁想要什么),conflict(阻力是什么),turn(结束时发生的变化或揭示),',
  '  beat(情绪节拍，如「试探→逼近→崩塌」),mood(情绪基调),keyProp(关键道具/视觉母题),transition(转场方式),',
  '  script:[字符串]（每行一条可拍摄信息，行首标记见「剧本正文行规范」）,',
  '  continuity:[字符串]（本场 [连续性] 状态，可由 script 行推导）}',
  ']',
  '}',
  '（scenes 不能为空；每场必须写满 objective / conflict / turn / beat / transition，不能只写概述）',
].join('');

/**
 * 剧本正文行规范（整剧与单集共用，写进 system 提示）。
 * v3「可拍摄契约」：一行只写一件镜头前能看见 / 听见 / 读清的事，
 * 让下游分镜、配音、画面文字、跨集连续性都能直接按行首标记消费。
 * 旧格式（动作： / 画面： / 旁白： / 「台词」）仍会被解析，但新剧本不再使用。
 */
export const SCREENPLAY_FORMAT_GUIDE = [
  '剧本正文行规范（v3 可拍摄契约）：一行一个信息单元，只写镜头前能看见、能听见、能读清的内容。',
  '· 集首行：`# EP001 【集名】`，EP 编号取自输入 episodeCode。',
  '· 场次头：`## EP001-SC001 内 · 地点 · 时间`，每场第一行且只写一次；用「内 / 外 / 内外」标内外景，地点与时间必须与本场 location / time 一致，编号取自 sceneCode。',
  '· 动作：`（可见、可表演的动作）` 用圆括号包裹，一段只写一个可见变化；不写心理活动、气氛概述、镜号景别运镜。',
  '· 对白：`角色名（可执行的表演策略）：台词`。括号里必须是演员能立刻做出来的动作（把杯子推过桌面 / 背对对方不回头 / 把照片翻过来），不能只写「愤怒」「低声」这类抽象情绪；台词不加引号，单条 ≤60 字，必须是此人此刻真会说出口的话。',
  '· [OS] 角色名：同场画外对白（人在现场但此刻不在画面里，如门外、隔壁、背身喊话），算该角色的一句对白。',
  '· [VO] 角色名：非现场叙述声音（旁白 / 事后回忆 / 书信念白），一集不超过 5 行，不算现场对白。',
  '· [SFX] 会改变行动或信息的声音：只写能让人物改变动作、或让观众拿到新信息的画内声（门被撞开 / 手机震动 / 脚步在门外停住）；不写配乐、环境垫音与 BGM。',
  '· [画面文字] 载体：观众必须读清的准确文字：载体写屏幕 / 纸条 / 招牌 / 字幕条，冒号后逐字写出观众要读到的内容，不写「上面写着一些字」。',
  '· [连续性] 后续易丢失且影响故事的状态：只在跨场 / 跨集会丢、且会影响后续理解时写（谁受伤了、道具在谁手里、门是否锁上、时间过去了多久），一行一个状态。',
  '禁止写镜号、景别、运镜、机位、与行动无关的环境音效、配乐 BGM、字幕样式、心理活动与「气氛紧张」「众人震惊」这类概述——这些属于分镜阶段或根本拍不出来。',
  '每场正文至少 6 行，其中至少 2 句现场对白（含 [OS]）；确为默场时在 beat 标注「默场」，用圆括号动作行补足可拍信息。',
].join('\n');

/**
 * 单集剧本写作准则（分集剧本 / 剧集详情页「生成本集剧本」）。
 * 固定写进 system 提示的硬约束，对应「每集各自生成、开场像第一集、没有对白」的旧问题。
 */
export const SCREENPLAY_GUIDE = [
  '只写本集：覆盖 originalText 的关键事件与情绪转折，不要把整本书或其它集的内容浓缩进来。',
  '场次数量贴近 targetScenes（3~10 场）：每场都要有 location、time、summary 与 script 正文，过场戏合并，不要用一场戏写完全集。',
  '集编号：title 前用 `# <episodeCode> 【集名】`；每场 script 首行必须写 `## <sceneCode> 内|外|内外 · 地点 · 时间`，sceneCode 用 sceneCodePrefix 按场序编号（如 EP001-SC001）。',
  'script 每行严格按「剧本正文行规范 v3」：动作写 `（一个可见变化）`，对白写 `角色名（可执行的表演策略）：台词`（不加引号），按需写 [OS] / [VO] / [SFX] / [画面文字] / [连续性]；不要写镜号、景别、运镜、BGM 等拍摄指令。',
  '开场三句内承接 prevRecap / prevTail（上一集结尾的人物处境或悬念），结尾必须落到本集 hook，可用台词、动作或一个明确的画面悬念。',
  '承接 prevContinuity（上一集留下的 [连续性] 状态）：伤势、道具归属、门锁、时间跳跃等必须在开场交代清楚，且全集不得与它矛盾。',
  '本集最后一场至少写一条 [连续性]，记录会带到下一集又容易丢的状态；只写状态，不写评价或抒情。',
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
  '场次编号：`## EP<3 位集号>-SC<3 位场号> 内|外|内外 · 地点 · 时间` 是每场 script 的首行；集首行写 `# EP<3 位集号> 【集名】`，编号由 episodeNo 与场序推导，不得跳号或重复。',
  'script 每行严格按「剧本正文行规范 v3」：动作写 `（一个可见变化）`，对白写 `角色名（可执行的表演策略）：台词`（不加引号），按需写 [OS] / [VO] / [SFX] / [画面文字] / [连续性]；不要写镜号、景别、运镜、BGM。',
  '用 excerpt 里的原文细节写戏：专有名词、道具、天气、身体动作、原句对白都要保留；禁止用「气氛紧张」「众人震惊」这类概述代替画面。',
  '每集最后一场至少写一条 [连续性]，记录会带到下一集又容易丢的状态；后一集开场必须承接它，不能出现人物伤势或道具归属前后矛盾。',
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

/** 行首关键词 → 行类型（旧格式，这些不是说话人，避免被当成角色） */
const LINE_KEYWORDS = {
  动作: 'action', 画面: 'action', 镜头: 'action',
  旁白: 'narration', 画外音: 'narration', 内心: 'narration',
  音效: 'sound', 声音: 'sound', 环境声: 'sound',
  字幕: 'subtitle', 备注: 'note', 注: 'note',
  场景: 'note', 时间: 'note', 地点: 'note', 转场: 'note',
};

/** v3 行首方括号标记 → 行类型（OS 仍算对白，VO 不算现场对白） */
const TAG_KINDS = {
  OS: 'dialogue', VO: 'narration', SFX: 'sound',
  画面文字: 'subtitle', 连续性: 'continuity',
};
const TAG_RE = /^[\[［](OS|VO|SFX|画面文字|连续性)[\]］]\s*([\s\S]*)$/;
const SCENE_HEAD_RE = /^#{1,2}\s*(EP\d{3}-SC\d{3})\s+([\s\S]*)$/;
const EPISODE_HEAD_RE = /^#\s*(EP\d{3})\s*【([^】]*)】\s*$/;
const BRACKET_ACTION_RE = /^[（(]([\s\S]+)[）)]$/;
const DIALOGUE_RE = /^([^：:\s【】（）()]{1,12})(?:（([^）]{0,16})）|\(([^)]{0,16})\))?\s*[：:]\s*([\s\S]*)$/;
const cleanQuote = (s) => str(s).replace(/^[「“"']+/, '').replace(/[」”"']+$/, '').trim();

/** 场次头 `内 · 地点 · 时间` → 结构化元信息（内 / 外 / 内外 → 内景 / 外景 / 内外景） */
function parseSceneHead(rest = '') {
  const bits = str(rest).split(/\s*[·・]\s*/).map((x) => x.trim()).filter(Boolean);
  const map = { 内: '内景', 外: '外景', 内外: '内外景', 内景: '内景', 外景: '外景', 内外景: '内外景' };
  return {
    interior: map[bits[0]] || '',
    location: bits[1] || '',
    time: bits[2] || '',
  };
}

/**
 * 完整行解析：v3 标记行 + 旧格式双兼容。
 * 返回 { kind, speaker, text, tag, cue, carrier, sceneCode, interior, location, time }。
 * kind：dialogue | action | narration | sound | subtitle | continuity | note | heading | plain | empty
 */
function parseLineCore(raw) {
  const line = str(raw);
  const base = {
    kind: 'plain', speaker: '', text: line,
    tag: '', cue: '', carrier: '', sceneCode: '', interior: '', location: '', time: '',
  };
  if (!line) return { ...base, kind: 'empty', text: '' };

  const episodeHead = line.match(EPISODE_HEAD_RE);
  if (episodeHead) {
    return { ...base, kind: 'heading', tag: 'EPISODE', sceneCode: episodeHead[1], text: episodeHead[2].trim() };
  }
  const sceneHead = line.match(SCENE_HEAD_RE);
  if (sceneHead) {
    return { ...base, kind: 'heading', sceneCode: sceneHead[1], text: line, ...parseSceneHead(sceneHead[2]) };
  }
  if (/^【.*】$/.test(line)) return { ...base, kind: 'heading', text: line.replace(/^【|】$/g, '') };

  const action = line.match(BRACKET_ACTION_RE);
  if (action) return { ...base, kind: 'action', text: str(action[1]).trim() };

  const tag = line.match(TAG_RE);
  if (tag) {
    const name = tag[1];
    const body = str(tag[2]).trim();
    const out = { ...base, kind: TAG_KINDS[name], tag: name, text: body };
    if (name === 'OS' || name === 'VO') {
      const m = body.match(DIALOGUE_RE);
      if (m) { out.speaker = m[1].trim(); out.text = cleanQuote(m[4]); }
    } else if (name === '画面文字') {
      const m = body.match(/^([^：:]{1,20})\s*[：:]\s*([\s\S]*)$/);
      if (m) { out.carrier = m[1].trim(); out.text = str(m[2]).trim(); }
    }
    return out;
  }

  // 旧格式 + v3 对白：括号里的内容既可能是旧式情绪提示，也可能是 v3 表演策略，
  // 统一放进 cue；旧调用方只看三字段，不受影响。
  const m = line.match(DIALOGUE_RE);
  if (!m) return base;
  const head = m[1].trim();
  const body = cleanQuote(m[4]);
  const kw = LINE_KEYWORDS[head];
  if (kw) return { ...base, kind: kw, text: body };
  return { ...base, kind: 'dialogue', speaker: head, cue: str(m[2] || m[3]).trim(), text: body };
}

/**
 * 把一行正文解析成 { kind, speaker, text }（保持旧调用方与 deepEqual 断言不变）。
 * 需要 tag / cue / carrier / 场次编号时用 parseScriptLineRich。
 */
export function parseScriptLine(raw) {
  const p = parseLineCore(raw);
  return { kind: p.kind, speaker: p.speaker, text: p.text };
}

/** 完整行信息：v3 标记、表演策略、画面文字载体、场次头元信息 */
export function parseScriptLineRich(raw) {
  return parseLineCore(raw);
}

/** 集编号：1 → EP001 */
export function episodeCodeOf(no = 1) {
  return `EP${String(clamp(Math.round(num(no, 1)), 0, 999)).padStart(3, '0')}`;
}

/** 场次编号：1, 2 → EP001-SC002 */
export function sceneCodeFor(epNo = 1, sceneNo = 1) {
  const sc = String(clamp(Math.round(num(sceneNo, 1)), 0, 999)).padStart(3, '0');
  return `${episodeCodeOf(epNo)}-SC${sc}`;
}

/** 单场正文里的 [连续性] 状态（去标记、去空、去重、保序） */
export function continuityOf(lines = []) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(lines) ? lines : [])) {
    const p = parseLineCore(raw);
    if (p.tag !== '连续性' || !p.text || seen.has(p.text)) continue;
    seen.add(p.text);
    out.push(p.text);
  }
  return out;
}

/** 整份剧本里所有 [连续性] 状态（去重、保序），供下一集生成时注入上下文 */
export function screenplayContinuity(script = {}) {
  const scenes = Array.isArray(script?.scenes) ? script.scenes : [];
  const out = [];
  const seen = new Set();
  for (const s of scenes) {
    const fromField = Array.isArray(s?.continuity) ? s.continuity : [];
    for (const raw of [...fromField, ...continuityOf(s?.script)]) {
      const text = str(raw).trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
  }
  return out;
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
  'sceneCode', 'continuity',
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
  const sceneNo = num(s.no) || index + 1;
  const continuity = Array.isArray(s.continuity)
    ? s.continuity.map((x) => cut(x, 120)).filter(Boolean).slice(0, 8)
    : continuityOf(lines);
  return {
    ...s,
    id: cut(s.id || `SC${String(index + 1).padStart(2, '0')}`, 16),
    no: sceneNo,
    sceneCode: cut(s.sceneCode, 16) || sceneCodeFor(episodeNo, sceneNo),
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
    continuity,
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
    episodeCode: cut(src.episodeCode, 16) || (isEpisodeScreenplay(vars) ? episodeCodeOf(fallbackEpisodeNo) : ''),
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
