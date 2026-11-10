// Provider 抽象：把「模型能力」与「智能体业务」彻底解耦
// - mock：确定性中文内容 + 自绘 SVG 资产，零 Key 可完整跑通
// - openai：任意 OpenAI 兼容 /chat/completions，失败自动回退 mock
// - comfyui：图片 / 视频直接提交本地 ComfyUI 导出的 API 格式 workflow（主路径）
import { uid, writeAsset, readAsset } from './store.mjs';
import { hash, storyboardSVG, characterSVG, characterViewSVG, characterSheetSVG, transitionSVG, posterSVG } from './artwork.mjs';
import { parseWorkflow, runWorkflow, parseAgentParamReply } from './comfyui.mjs';
import { resolveInterface } from './comfy-config.mjs';
import { placeholderFrame, characterViewFrame } from './raster.mjs';
import { chunkNovel, KnowledgeBase, retrieveRelevantChunks } from './knowledge.mjs';
import { matchAll as matchVoicesForCharacters } from './voices.mjs';
import { normalizeFilmPolicy } from './film-policy.mjs';
import { skillAesthetic, getDirectorSkill } from './director-skills.mjs';
import { aestheticPrompt } from './director-styles.mjs';
import {
  SCREENPLAY_SCHEMA, SCREENPLAY_GUIDE, SCREENPLAY_PROJECT_GUIDE, SCREENPLAY_FORMAT_GUIDE,
  screenplayGuide, isEpisodeScreenplay, enrichScreenplay, guessInterior, parseScriptLine,
} from './screenplay.mjs';

// 剧本写作准则的单一来源在 core/screenplay.mjs；这里继续导出，
// 保持 `import { SCREENPLAY_GUIDE } from providers` 的既有调用方与测试不变。
export { SCREENPLAY_GUIDE, SCREENPLAY_PROJECT_GUIDE, SCREENPLAY_FORMAT_GUIDE, SCREENPLAY_SCHEMA };

const SCHEMAS = {
  screenplay: SCREENPLAY_SCHEMA,
  events: '事件图谱：{events:[{title,summary,processChain:[字符串],scenes:[{title,location,time,summary}]}]}',
  shots: '分镜表：{shots:[{shotNo,size,angle,movement,ffDesc,motionDesc,audioDesc,duration,characters:[名称]}]}',
  characters: '角色设定：{characters:[{name,role,appearance,palette:[颜色],traits:[字符串]}]}',
  // 角色抽取：论文 ViMax「Character Extractor」方法论的结构化映射
  //   static_features  = 不随场景变化的外貌/体型（跨镜头恒定，保证身份一致）
  //   dynamic_features = 服饰/配饰/随身物品（随场景可变）
  //   aliases          = 同一实体的多种称呼（原文用过的别称都列出，便于跨集归并）
  charExtract: '角色抽取：{characters:[{name,aliases:[string](原文中出现过的别称/昵称/职务，同一实体的多种称呼都要列出),role,gender,age,personality,appearance,hair,costume,props,staticFeatures:string(固定特征：脸型五官、发型发色、体型、肤色等不随场景变化的外貌特征，40~80 字，须具体可视化，不要写「气质出众」这类抽象词),dynamicFeatures:string(可变特征：服装、配饰、随身道具等会随场景变化的造型元素，30~60 字，须具体到颜色与款式),style:string(基本设定风格：综合该角色的提取信息输出一句话造型风格总结，须同时覆盖 ①题材/画风气质（如古风玄幻、赛博朋克、校园清新）②造型方向（发型、服装、轮廓等关键特征）③主配色倾向与整体氛围；30~40 字，风格统一便于跨镜头定妆，例：「古风玄幻 · 清冷剑修，白衣墨发佩长剑，水墨淡彩冷色调」),relations:[{target,label}],palette:[颜色](该角色的主色，用于定妆配色，须与其他角色明显不同),viewPrompt:string(定妆画面提示词：一句话概括该角色的标志性外观，20~40 字，供生成三视图参考),evidence:[{quote:string(该角色在输入原著片段中逐字出现的一句完整原文，不得超过 60 字),kind:string(mention|dialogue|description)}](证据引用：每个角色 1~3 条，全部来自下方「原著片段」，用于回溯校验与幻觉过滤)]}',
  // 角色抽取的推理准则：对应 ViMax character_extractor.py 的 Guidelines 段
  charExtractGuide: [
    '按出场权重排序输出：先主角（推动主线、全文出场最多的人），再核心配角，最后次要角色。主角绝不能因为「片段里没有直接对白」或「只以身份指代出现」而被漏掉。',
    '只依据输入的原著片段抽取角色，不得引入片段之外的设定；片段未写明但必需的外观特征可以依据题材与上下文合理补全，但不得与原文矛盾。',
    'name 必须是原文中真实出现过的「人物称呼」：姓名、绰号、职务+姓（如「老周」「沈父」「魏掌柜」），或以稳定身份指代的角色（如「穿灰风衣的刑警队长」）。',
    '严禁把下列内容当作角色：动作或动词短语（如「回头」「开口」「冲他」「朝林外」）、身体部位（手/眼/脸/嘴角）、物件（刀光/剑光/匾额）、方位与时间（身后/片刻）、天气与环境（雨水/风声）、泛称与代词（众人/对方/他/她/他们）。这些词即使紧挨着「说/看/站」等动词，也不是角色。',
    '名字必须是一个完整的人的称呼：不得把人名和紧随其后的字粘在一起。例如原文「沈青崖不动声色」的角色是「沈青崖」，不是「沈青崖不」；「魏残始终站在原地」的角色是「魏残」，不是「魏残始终」。',
    '同一实体在原文中出现的所有称呼（姓名、昵称、职务、称谓）都要归并到同一个角色，其余写法列入 aliases；不要为同一人物输出多条。',
    '原文未点名、以身份或外貌指代的关键角色，也要提取并用「身份+外貌特征」命名（如「穿灰风衣的刑警队长」）。',
    '与主线无关的背景群众不单独建角色。',
    'staticFeatures 只写跨场景恒定的外貌体型，dynamicFeatures 只写会变的服饰配饰；两者都不要写性格、身份定位或人物关系。',
    '不同角色的外形与主配色要能明确区分开，便于生成定妆图后仍能分辨谁是谁。',
    '每个角色必须给出 evidence：quote 必须是下方「原著片段」里逐字出现的一句原文（含标点），不得改写、拼接或编造；找不到原文依据的角色不要输出。',
  ].join('\n'),
  cameras: '机位依赖图：{cameras:[{id,label,shotNos:[数字],parent,reason}]}',
  context: '检索结果：{query, passages:[字符串], notes:[字符串]}',
  spatial: '转场说明：{fromCam,toCam,spatialNotes,axisRule,cameraPath}',
  review: '评审：{reason, highlights:[字符串]}',
  coverPrompt: '封面文生图提示词：{prompt:string(可直接喂 SDXL 的完整正向提示词), negative:string(负向提示词), style:string}（输出该 JSON 对象本身，不要加外层键名包裹）',
  // 独立封面提示词 agent：只做提示词设计优化，不承担对话职责
  coverPromptDesign: '封面提示词设计师：把项目资料、用户画面要求与参考图，设计优化成一句完整、连贯、有画面感的中文封面描述（40~120 字，须涵盖主体、场景/动作、光影、构图、风格氛围，是一句通顺的话而不是关键词堆砌），prompt 末尾可追加少量英文质量词（如 cinematic movie poster, highly detailed, no text）。输出 {prompt:string(上述完整描述句), negative:string(负向提示词，含 text/watermark 等), style:string}（输出该 JSON 对象本身，不要加外层键名包裹）',
  // 封面创作助手对话：回复 + 可直接使用的提示词 + 用户可点击的下一步建议
  coverChat: '封面创作助手对话：{reply:string(对用户的自然回复，一两句话), prompt:string(可直接喂 SDXL 的完整正向提示词，融合项目资料、对话要求与参考图), negative:string(负向提示词), suggestions:[string,2~3条用户可直接点击的下一步建议]}（输出该 JSON 对象本身，不要加外层键名包裹）',
  // 项目信息 AI 补全：按一句话构想产出创作设定各字段（bible）
  storyIdea: '项目信息补全：{title, genre, audience, logline, tone, artStyle, firstEpisodeTheme, worldview}（logline 为一句话简介，worldview 200 字以内）',
  // AI 生成小说：先出分章大纲，再逐章写正文
  novelOutline: '小说分章大纲：{title, genre, logline, chapters:[{title, summary, hook}]}（title 形如「第X章 · 标题」，summary 80 字内，hook 为结尾悬念句）',
  novelChapter: '小说章节正文：{title, text}（text 为该章完整正文，简体中文小说文体，多段落，不含章节标题行，不写「本章完」）',
  // 音色分配：给每个角色从音色库里挑一个最合适的 voiceId，并给出可解释的匹配理由
  voiceAssign: '音色分配：{assignments:[{characterName:string(角色名，须与原输入一致), voiceId:string(音色库中的音色 id), voiceName:string(音色名), reason:string(一句话匹配理由，说明性别/年龄/性格/定位如何契合)}]}（为每个输入角色匹配恰好一个音色，voiceId 必须来自提供的音色库；无合适音色时可省略该角色）',
  // 导演阐述：导演 Agent 在跑六步之前给出的全片视听纲领，会作为一致性约束喂给分镜与打包
  directorTreatment: '导演阐述：{title:string(本片导演方案标题), logline:string(一句话故事核心), tone:string(情绪基调), visualStyle:string(画面风格与色彩策略), pacing:string(叙事节奏与每集时长分配), shotStrategy:string(景别/运镜/轴线策略), audioStrategy:string(对白、环境声与音色策略), continuityRules:[string,3~5条跨镜头一致性硬约束], risks:[string,2~3条制作风险与规避办法]}（全部使用简体中文，须依据输入的项目设定与原著梗概，不要编造未提供的角色名）',
  // 导演风格设计师对话：多轮引导用户收集信息，逐步补全风格草稿，ready 后可直接保存为自定义导演风格
  styleForge: '导演风格设计师对话：{reply:string(对用户的自然回复：先用一句话确认已收集到的要点，再只追问 1~2 个最关键的缺口，语气专业友好), draft:object(风格草稿——把用户本轮提到的信息合并进上一轮草稿后输出**完整草稿**，未提及的字段保持原值，不要删除已有字段。可用字段：label(风格名), director(参考导演/流派), icon(一个 emoji), tagline(一句话卖点), summary(风格概述), tone(情绪基调), palettes:[{key,name,hex,mood}](1~4 组主色调，hex 为 #RRGGBB), defaultPalette, colorRule(主色占比规则), light(光线方案), composition(构图方案), camera(运镜方案), texture(质感关键词), taboos:[string](画面禁忌), medium:[string](自然媒介：风雨雪雾等), pace:{minShotSec,maxShotSec,fixedShotRatio,mode}(节奏：mode 取 slow/fragment/kinetic/ritual/breath/contrast/silence-burst/mixed), stylePrompt(正向风格提示词,拼接进每张图), negativePrompt(负向提示词), highlights:[string](4 个高亮标签), continuityRules:[string](3~4 条连戏规则), risks:[string](2~3 条风险), audioStrategy(声音策略), visualStyle(视觉风格总结), shotStrategy(景别策略), pacing(节奏描述)}, ready:boolean(草稿是否已足够完整可直接保存——至少要有 label、palettes、stylePrompt、light、composition、camera、tone), suggestions:[string,2~3条用户可直接点击的下一步建议]}（输出该 JSON 对象本身，不要加外层键名包裹）',
};

/**
 * 单集剧本的写作准则已迁到 `core/screenplay.mjs`（与整剧准则放在一起维护）。
 * 这里保留注释作为导航：旧实现是「一集一段自由文本」，缺人物动机 / 场景目标 /
 * 情绪节拍，导致模型只写 3 场概述就收工；新准则要求逐场写满戏剧结构。
 */

const THEMES = [  {
    key: 'noir', test: /侦探|悬疑|案|凶|警|雨夜|推理|谜|罪/,
    genre: '悬疑 / 黑色电影', styleHint: 'noir',
    chars: [
      { name: '沈砚', role: '私家侦探', appearance: '深色风衣、略显疲惫的眼神、左手旧怀表' },
      { name: '林夏', role: '调查记者', appearance: '短发、米色风衣、随身相机' },
      { name: '老周', role: '刑警队长', appearance: '灰呢大衣、烟斗、沉稳' },
    ],
    scenes: [
      { location: '雨夜旧城区 · 巷口', time: '深夜', summary: '一封没有署名的信把侦探引到案发地' },
      { location: '警局审讯室', time: '凌晨', summary: '证词里出现无法解释的时间差' },
      { location: '码头仓库', time: '黎明前', summary: '真相在潮湿的雾气里浮出水面' },
    ],
  },
  {
    key: 'scifi', test: /太空|星际|飞船|宇宙|未来|机器人|空间站|星球/,
    genre: '科幻 / 冒险', styleHint: 'cinematic',
    chars: [
      { name: '叶舟', role: '领航员', appearance: '银灰飞行服、短发、左眉疤痕' },
      { name: '苏离', role: '工程师', appearance: '橙色工装、护目镜、工具腰带' },
      { name: 'K-7', role: '机载智能体', appearance: '蓝色全息投影、无实体' },
    ],
    scenes: [
      { location: '沙漠坠毁点', time: '黄昏', summary: '飞船迫降，沙尘中传来求救信号' },
      { location: '驾驶舱', time: '夜', summary: '两人核对航线，发现坐标被篡改' },
      { location: '空间站环形走廊', time: '深夜', summary: '在失重前完成最后一道闸门' },
    ],
  },
  {
    key: 'youth', test: /校园|青春|少年|少女|同学|毕业|夏天|成长/,
    genre: '青春 / 成长', styleHint: 'anime',
    chars: [
      { name: '许知夏', role: '转学生', appearance: '白衬衫、蓝色发带、帆布书包' },
      { name: '陆屿', role: '同桌', appearance: '高个、校服外套、总戴耳机' },
      { name: '阿婆', role: '旧书店店主', appearance: '银发、圆框眼镜、方格围裙' },
    ],
    scenes: [
      { location: '高二教室', time: '午后', summary: '一张纸条改变了两个人的夏天' },
      { location: '街角旧书店', time: '傍晚', summary: '在旧书里发现上一届留下的秘密' },
      { location: '学校天台', time: '日落', summary: '约定在毕业前把故事写完' },
    ],
  },
  {
    key: 'general', test: /.*/, genre: '剧情 / 短片', styleHint: 'cinematic',
    chars: [
      { name: '顾言', role: '主角', appearance: '简洁深色外套、目光坚定' },
      { name: '程曦', role: '搭档', appearance: '浅色衬衫、随身笔记本' },
    ],
    scenes: [
      { location: '故事开始的地方', time: '清晨', summary: '一个意外打破了日常' },
      { location: '转折发生的房间', time: '夜', summary: '选择必须在此刻做出' },
      { location: '终点与起点', time: '黎明', summary: '带着新的理解重新出发' },
    ],
  },
];

export function detectTheme(text = '') {
  return THEMES.find((t) => t.key !== 'general' && t.test.test(text)) || THEMES[THEMES.length - 1];
}

const SIZES = ['建立全景', '全景', '双人中景', '过肩中景', '特写', '插入镜头', '反打中景', '反应特写'];
const ANGLES = ['平视', '低角度', '过肩', '俯拍', '平视', '微仰', '平视', '平视'];
const MOVES = ['缓慢推镜', '固定', '横移', '固定', '缓慢推近', '固定', '固定', '轻微手持'];

function pick(arr, i) { return arr[i % arr.length]; }
function shortTitle(idea = '') {
  const clean = idea.replace(/\s+/g, ' ').trim();
  return clean.length > 14 ? `${clean.slice(0, 13)}…` : (clean || '未命名故事');
}

/** 风格对话零 Key 兜底用：中文颜色词 → 色号（与 director-style-store 的校验兜底同源语义） */
const COLOR_TABLE = {
  '红': '#C81D25', '赤': '#B83227', '橙': '#E2571F', '金': '#C89A4B', '黄': '#D9A441',
  '绿': '#2F4F3A', '青': '#5E8A8C', '蓝': '#1F3B5C', '紫': '#6B3E86', '粉': '#D98BA3',
  '黑': '#12100F', '白': '#DCE0E2', '灰': '#5A6068', '褐': '#8B6B4A', '棕': '#6B5842',
  '银': '#A8B0B8', '墨': '#1C1C1C', '米': '#E8DCC0', '霓虹': '#D99A3C', '青灰': '#8A9A9E',
};

/* ------------------------------------------------------------------ 零 Key 剧本
 * 旧兜底把「分集梗概」原样塞进 script，产出「3 场概述 + 一段原文」：
 * 没有场次头、没有对白、没有目标 / 冲突 / 转折，用户看到的就是「不够详细」。
 * 新兜底把原文**转写**成统一格式（v2）：分场 → 场次头 → 动作 / 画面 / 旁白 / 对白行，
 * 再从原文句子推导 objective / conflict / turn / beat / keyProp / transition。
 * 只做转写与结构推导，不虚构剧情——零 Key 时「详尽但不编」。
 */
const clip = (v, n) => { const t = String(v ?? '').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** 地点词表：原文里出现过的具体场所优先当作 location，比「段落 1」可用得多 */
const PLACE_WORDS = ['办公室', '办公区', '会议室', '教室', '走廊', '楼道', '仓库', '酒楼', '客栈', '厨房', '卧室',
  '书房', '医院', '警局', '派出所', '档案室', '公司', '学校', '操场', '天台', '码头', '车站', '机场', '地铁',
  '酒吧', '咖啡馆', '茶馆', '客厅', '宿舍', '网吧', '车库', '后院', '柴房', '屋内', '店内', '街', '巷', '路口',
  '桥', '河边', '山坡', '广场', '院子', '门口', '城门', '山道',
  // 古装 / 年代戏常见场所：小说改编最容易缺的就是这类词，缺了就只能退回「段落 1」
  '破庙', '庙', '寺', '道观', '祠堂', '衙门', '牢房', '驿馆', '酒肆', '茶楼', '书院', '绣楼', '闺房',
  '堂屋', '厢房', '庭院', '廊下', '渡口', '长街', '城墙', '军营', '帐篷', '船舱', '画舫', '当铺', '药铺',
  '钱庄', '赌坊', '米铺', '井台', '灶房', '树林', '竹林', '溪边', '粮仓', '地窖', '密道', '山洞'];
/** 关键道具词表：命中即写入 keyProp，供分镜 / 出图时当视觉母题 */
const PROP_WORDS = ['信', '照片', '相机', '枪', '刀', '钥匙', '手机', '怀表', '卷宗', '账本', '酒', '烟', '伞',
  '车', '电脑', '灯', '镜子', '戒指', '玉佩', '剑', '药', '钱袋', '信封', '名片', '皮箱', '箱子', '背包', '文件',
  // 古装 / 年代戏道具：铜钱、银两、令牌这类小物件往往就是全片的视觉母题
  '铜钱', '银两', '银子', '玉', '镯', '簪', '书信', '密信', '令牌', '契约', '婚书', '灯笼', '火折', '蜡烛',
  '手帕', '绢', '面具', '琴', '笛', '酒壶', '茶盏', '药包', '血书', '纸钱', '印章', '图纸', '地图', '绳', '锁'];
/** 冲突兜底句：按场次轮换，避免整部剧每场都写「谁都不肯先开口」 */
const CONFLICT_FALLBACK = [
  '对方不肯配合，话到一半就停住',
  '局面僵住，谁都不肯先开口',
  '时间在催，可关键的人还没到',
  '越接近答案，阻力越具体',
];
/** 转折兜底句：同样轮换，避免每场都写「以悬念收束」 */
const TURN_FALLBACK = ['本场以悬念收束', '真相被推近一步', '主动权换了人', '一句话把退路堵死'];
/** 转折句 / 冲突句的线索词：用来从原文里挑真正承担戏剧功能的句子 */
const TURN_HINT = /但|却|然而|突然|忽然|没想到|原来|竟|才发现|不料|谁知|结果|只见/;
const CONFLICT_HINT = /不|没|别|拒绝|拦|挡|僵|沉默|冷笑|吼|质问|争|吵|推开|挣脱|威胁|瞪|咬牙|否则/;
const TIME_HINTS = [
  ['清晨', /清晨|早晨|黎明|破晓|天刚亮/],
  ['午后', /午后|正午|中午|下午/],
  ['黄昏', /黄昏|傍晚|夕阳|落日|天色暗/],
  ['深夜', /深夜|凌晨|半夜/],
  ['夜', /夜/],
];
const MOOD_BY_THEME = { noir: '冷、压抑、悬着', scifi: '疏离、警觉', youth: '明亮、微涩', general: '克制、暗流' };

/** 中文断句：引号内的标点不断句（`「这封信是谁送来的？」他低声问。` 必须是一句）；保留原句末标点 */
function splitSentences(text = '') {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const out = [];
  let buf = '';
  let depth = 0;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    // 引号内的换行不断句：一段台词被硬回车断开时不能拆成两段
    if (ch === '\n') { if (!depth) { out.push(buf); buf = ''; } continue; }
    if ('「“‘'.includes(ch)) depth += 1;
    buf += ch;
    if ('」”'.includes(ch)) depth = Math.max(0, depth - 1);
    if (!depth && '。！？!?；;'.includes(ch)) { out.push(buf); buf = ''; continue; }
    // 小说常写「…没还。」刘左皱眉：「…」」：引导台词结束却没有句号。
    // 引号后紧跟着**下一句台词**时按两句处理，否则整段会被当成一句、台词归属也会串。
    if (!depth && '」”'.includes(ch)) {
      const ahead = src.slice(i + 1, i + 14);
      if (!/[。！？!?；;]/.test(ahead) && /[「“"]/.test(ahead)) { out.push(buf); buf = ''; }
    }
  }
  if (buf) out.push(buf);
  return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 2);
}

/** 「第一章 雨夜」「段落 12」这类拆分标签不是地点：去掉前缀后再当兜底场景名 */
function cleanSourceLabel(v = '') {
  return String(v || '')
    .replace(/^第\s*[0-9一二三四五六七八九十百千]+\s*[章回节集卷篇话]\s*[·.、:：\-—]?\s*/, '')
    .replace(/^段落\s*\d+\s*[·.、:：\-—]?\s*/, '')
    .trim();
}

/** 拼接断句单元：前一段没有句末标点时补一个「。」，避免出现「…(1)刘左就是…」这种粘连 */
function joinUnits(units = []) {
  return units.reduce((acc, s) => {
    if (!acc) return s;
    return /[。！？!?；;，,、…」”]$/.test(acc) ? `${acc}${s}` : `${acc}。${s.replace(/^[\s，,、]+/, '')}`;
  }, '');
}

/** 把一段原文按句分组，均分成 want 段；短句不够时按逗号再切（并保留逗号，拼接后仍是通顺原文） */
function splitIntoParts(text = '', want = 2) {
  let units = splitSentences(text);
  const n = Math.max(1, Math.min(want, units.length || 1));
  // 原文只有一两句时按逗号细化，否则「每集至少 2 场」在短集上永远做不到
  if (units.length < want) {
    const fragments = String(text || '').split(/[，,、]/).map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s.length >= 2);
    const finer = fragments.map((s, i) => (i < fragments.length - 1 ? `${s}，` : s));
    if (finer.length > units.length) units = finer;
  }
  if (!units.length) return [''];
  const per = Math.ceil(units.length / n);
  const parts = [];
  for (let i = 0; i < units.length; i += per) parts.push(joinUnits(units.slice(i, i + per)).trim());
  while (parts.length > n) {
    const tail = parts.pop();
    parts[parts.length - 1] = joinUnits([parts[parts.length - 1], tail]);
  }
  return parts;
}

/**
 * 引号里的内容不一定是对白：中文小说常用引号标绰号、术语、口号（「危险的屁」）。
 * 只保留像"说出口的话"的引号内容，宁可少一句假台词，也不要让角色念名词。
 */
function isSpeech(text = '') {
  const t = String(text).trim();
  if (t.length < 4) return false;
  if (/[？?！!]/.test(t)) return true;
  if (/[我你您他她它咱]/.test(t)) return true;
  if (/[吗呢吧啊呀嘛哦哎嗯]/.test(t)) return true;
  if (/[，。…—]/.test(t) && t.length >= 8) return true;
  return t.length >= 12;
}

/** 取出原文里像对白的引号内容 */
function pickQuotes(text = '') {
  return [...String(text).matchAll(/[「“"]([^」”"]{2,60})[」”"]/g)]
    .map((m) => m[1].trim()).filter(Boolean).filter(isSpeech);
}

function detectTime(text = '', index = 0) {
  for (const [label, re] of TIME_HINTS) if (re.test(text)) return label;
  return ['夜', '清晨', '午后', '黄昏', '深夜'][index % 5];
}

/** 只认真实时间线索，没有就返回空串（用来判断「本场自己写了时间」还是「只能沿用本集」） */
function timeHint(text = '') {
  for (const [label, re] of TIME_HINTS) if (re.test(text)) return label;
  return '';
}

/** 去掉引号与首尾标点，让「目标 / 冲突 / 转折」读起来像一句话而不是原文碎片 */
function plain(t = '') {
  return String(t || '').replace(/[「」“”"]/g, '')
    .replace(/^[\s，。、；：！？]+|[\s，。、；：！？]+$/g, '').trim();
}

function detectPlace(text = '', fallback = '') {
  // 取**最早出现**的地点词：词表顺序只用于同位置并列时去重，不代表优先级
  let best = '';
  let pos = Infinity;
  for (const w of PLACE_WORDS) {
    const p = String(text).indexOf(w);
    if (p >= 0 && p < pos) { pos = p; best = w; }
  }
  return best || fallback || '';
}

/**
 * 引号对白归属：在这句台词**之前**的原文里找最后被提到的角色，
 * 而不是「本段出现过谁」——否则 `「这封信是谁送来的？」他低声问。`
 * 会被错判成后一句才出场的人说的。
 */
function speakerBefore(fullText = '', quote = '', cast = []) {
  const at = String(fullText).indexOf(String(quote));
  if (at <= 0) return '';
  const head = String(fullText).slice(0, at);
  let best = '';
  let pos = -1;
  for (const c of cast) {
    if (!c.name) continue;
    const p = head.lastIndexOf(c.name);
    if (p > pos) { pos = p; best = c.name; }
  }
  return best;
}

/** 补句末标点：断句时为了拼摘要去掉了尾部标点，写回正文行时要补上 */
function endSentence(t = '') {
  const s = String(t).trim();
  return /[。！？…」”!?]$/.test(s) ? s : `${s}。`;
}

/**
 * 零 Key 的单场生成：把 partText 转写成场次对象。
 * 行序遵循「场次头 → 动作 / 旁白 / 画面 → 对白」，原文引号内的句子直接当对白。
 */
function mockScene({ partText = '', ep = {}, index = 0, total = 1, cast = [], fallbackLocation = '', theme }) {
  const sentences = splitSentences(partText);
  const source = partText || String(ep.summary || '');
  const episodeText = String(ep.excerpt || ep.text || '') || source;
  // 地点只从本场原文里找；本场没有地名词时退回本集统一地点（同一集前后场应在同一个空间）。
  // 「庙」与「破庙」这类互为子串的算同一处，取更具体的那个，否则同一集会在两个名字间跳。
  const detected = (() => {
    const local = detectPlace(source);
    const epPlace = String(ep.place || '');
    if (!local) return epPlace;
    if (!epPlace) return local;
    if (epPlace.includes(local) || local.includes(epPlace)) return epPlace.length >= local.length ? epPlace : local;
    return local;
  })();
  const location = detected || clip(cleanSourceLabel(fallbackLocation || ep.title), 24) || '未指定场景';
  // 时间：本场原文自己写了「夜里 / 午后」就以它为准（同一集本来就可以跨时间），
  // 没写才沿用本集统一结论，再没有才按集号轮换。
  const time = timeHint(source) || String(ep.timeLabel || '')
    || detectTime(`${episodeText}。${ep.title || ''}。${ep.summary || ''}`, (Number(ep.no) || 1) - 1);
  // 只有真的识别出地点才敢判内外景；退回集名时不猜（写成「内外景」）
  const interior = detected ? guessInterior(detected, source) : '内外景';
  // 人物：本场原文里出现过的角色优先；都没出现时按场次轮换，保证镜头里有具体的人
  const present = cast.filter((c) => c.name && source.includes(c.name)).slice(0, 3);
  const speakers = (present.length ? present : [cast[index % Math.max(1, cast.length)]].filter(Boolean)).slice(0, 3);
  const lead = speakers[0]?.name || '旁白';

  const lines = [`【${time} · ${location}】`];
  let dialogue = 0;
  sentences.slice(0, 10).forEach((s, si) => {
    // 引号里就是台词时用 pickQuotes；「说完就停住」这种句子（「埋了才好记。」）缺少问号 /
    // 人称，会被 isSpeech 判成非台词，这里再用「说 / 道 / 问 / 答 + 冒号 + 引号」补一次识别
    const quotes = pickQuotes(s).length
      ? pickQuotes(s)
      : (/[^。！？\n]{0,12}[：:]\s*[「“"]/.test(s)
        ? [...s.matchAll(/[「“"]([^」”"]{2,60})[」”"]/g)].map((m) => m[1].trim()).filter((t) => t.length >= 2)
        : []);
    if (quotes.length) {
      // 归属顺序：本句台词之前最近被提到的角色 → 本场原文 → 整集原文。
      // 先看「本句里出现过谁」是错的：同一句既写「沈砚翻出铜钱」又写「刘左皱眉」时会把台词判给沈砚。
      const who = speakerBefore(s, quotes[0], cast)
        || speakerBefore(source, quotes[0], cast)
        || speakerBefore(episodeText, quotes[0], cast)
        || speakers.find((c) => s.includes(c.name))?.name || lead;
      for (const q of quotes.slice(0, 2)) { lines.push(`${who}：「${clip(q, 60)}」`); dialogue += 1; }
      // 去掉引号后剩下的动作描写：顺手清掉「低声说：」「刘左皱眉：」这类引导语残片
      const rest = s.replace(/[「“"][^」”"]*[」”"]/g, '')
        .replace(/[^，。；！？：]{0,10}[：:]/g, '')
        .replace(/[，、；：]{2,}/g, '，')
        .replace(/[，、；：]+(?=。)/g, '')
        .replace(/^[\s，。、；：!？—-]+|[\s，。、；：!？—-]+$/g, '')
        .trim();
      if (rest.length >= 6) lines.push(`动作：${endSentence(clip(rest, 56))}`);
      return;
    }
    if (si % 3 === 2) lines.push(`画面：${endSentence(clip(s, 56))}`);
    else if (si % 3 === 1) lines.push(`旁白：${endSentence(clip(s, 56))}`);
    else lines.push(`动作：${endSentence(clip(s, 56))}`);
  });
  // 场次收尾：本集最后一场落到 hook（有引号就写成台词，没有就当画面悬念）
  const isLastOfEpisode = index === total - 1;
  const norm = (t) => String(t || '').replace(/[^\u4e00-\u9fa5]/g, '');
  // 已经写进正文的句子：hook / 摘要常常就是其中最后一句，重复写一遍会让剧本末尾出现同句两次
  const spoken = lines.map(norm).filter((x) => x.length >= 4);
  const dup = (t) => {
    const k = norm(t);
    return k.length >= 4 && spoken.some((x) => x.includes(k) || k.includes(x));
  };
  if (isLastOfEpisode && ep.hook) {
    const hq = pickQuotes(ep.hook);
    if (hq.length && !dup(hq[0])) {
      const who = speakerBefore(String(ep.hook), hq[0], cast) || lead;
      lines.push(`${who}：「${clip(hq[0], 60)}」`); dialogue += 1;
    }
    else if (!hq.length) {
      // hook 可能被上游按字数硬截断，留下「」沈砚把……「那你告诉」这种断引号：
      // 画面行不能带引号残片，否则读起来像排版错误
      const h = String(ep.hook).replace(/[「」“”"]/g, '')
        .replace(/[^，。；！？：]{0,10}[：:]/g, '')
        .replace(/^[\s，。、；：!？—-]+/, '').trim();
      if (h && !dup(h)) lines.push(`画面：${endSentence(clip(h, 56))}`);
    }
  }
  // 行数太少且没有画面行时补一条，保证「每场都能被拍出来」；已有画面就不重复堆。
  // 首场可以用本集摘要起一个概述性画面；后面几场改用空镜，避免每场都写同一句摘要。
  if (lines.length < 4 && !lines.some((l) => /^画面[:：]/.test(l))) {
    const pic = index === 0 ? clip(ep.summary || source || '环境保持连续', 56) : '';
    if (pic && !dup(pic)) lines.push(`画面：${endSentence(pic)}`);
    else lines.push(`画面：${location}空镜 · ${time}，声音先入。`);
  }

  const turnLine = sentences.find((s) => TURN_HINT.test(s));
  const conflictLine = sentences.find((s) => CONFLICT_HINT.test(s));
  // 冲突句与转折句撞在一起时换一句当转折；也尽量别用首句（首句已经是本场目标 / 摘要）
  const turnPick = turnLine && turnLine !== conflictLine
    ? turnLine
    : (sentences.find((s) => s !== conflictLine && s !== sentences[0] && s.length >= 6)
      || sentences.find((s) => s !== conflictLine && s.length >= 6));
  // 道具按「在原文里出现的先后」取，而不是词表顺序：先出现的东西才是这一场的视觉母题；
  // 同时剔除互为子串的词（「信」与「书信」），否则 keyProp 会写成「信、书信」
  const props = (() => {
    const hits = PROP_WORDS
      .map((w) => ({ w, at: source.indexOf(w) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at || b.w.length - a.w.length);
    const picked = [];
    for (const { w } of hits) {
      if (picked.some((p) => p.includes(w) || w.includes(p))) continue;
      picked.push(w);
      if (picked.length >= 2) break;
    }
    return picked;
  })();
  // 目标锚点：本集最后一场用 hook（这一场要把钩子抛出来），但正文素材够多时优先用本场首句，
  // 只有「一场戏就把整集演完」时才拿 hook 当目标，否则目标会写成旁白复述
  const anchorSource = isLastOfEpisode && ep.hook && sentences.length >= 3
    ? ep.hook
    : (sentences[0] || ep.hook || ep.summary || '当下的处境');
  // 只取第一个「实词分句」当锚点：「清晨，沈砚在破庙里翻出…」→「沈砚在破庙里翻出…」，
  // 否则目标会写成「弄清『清晨，…低声说：刘…』的原委」这种读不通的句子
  const clauseOf = (t = '') => {
    const parts = plain(t).split(/[，,、：:；;。]/).map((x) => x.trim()).filter((x) => x.length >= 4);
    return parts[0] || plain(t);
  };
  const anchor = clip(clauseOf(anchorSource), 20);
  // 冲突 / 转折要写成「一句话」，不是把整句原文（含「低声说：」）搬过来：
  // 先取承担该功能的分句，再清掉引导语残片
  const stripCue = (t = '') => plain(t).replace(/[^，。；！？：]{0,10}[：:]/g, '')
    .replace(/^[\s，。、；：]+|[\s，。、；：]+$/g, '').trim();
  const clauseWith = (t = '', re = null) => {
    const parts = plain(t).split(/[，,、；;。]/).map((x) => x.trim()).filter((x) => x.length >= 3);
    return (re ? parts.find((p) => re.test(p)) : '') || parts[0] || '';
  };
  const conflictPhrase = conflictLine ? (clauseWith(conflictLine, CONFLICT_HINT) || clauseOf(conflictLine)) : '';
  const beat = total === 1
    ? '建置 → 施压 → 抛出钩子'
    : index === 0 ? '建置 → 扰动'
      : isLastOfEpisode ? '逼到墙角 → 抛出钩子'
        : '试探 → 施压 → 揭示';
  return {
    id: `SC${String(index + 1).padStart(2, '0')}`,
    episodeNo: Number(ep.no) || 1,
    no: index + 1,
    location, time, interior,
    durationSec: Math.max(12, Math.min(90, lines.length * 5)),
    characters: speakers.map((c) => c.name).filter(Boolean),
    summary: clip(joinUnits(sentences.slice(0, 2)) || ep.summary || '承接上文，推进冲突', 90),
    objective: index === 0
      ? clip(`弄清「${anchor}」的原委`, 80)
      : clip(`把「${clip(clauseOf(sentences[0]) || anchor, 18)}」推到不可回头`, 80),
    conflict: clip(stripCue(conflictPhrase) || CONFLICT_FALLBACK[index % CONFLICT_FALLBACK.length], 60),
    turn: clip(stripCue(turnPick ? clauseWith(turnPick) : '') || TURN_FALLBACK[index % TURN_FALLBACK.length], 60),
    beat,
    mood: MOOD_BY_THEME[theme?.key] || MOOD_BY_THEME.general,
    keyProp: props.join('、'),
    props,
    transition: ['切至', '叠影', '黑场', '声音先入', '动作接动作'][index % 5],
    script: lines,
    dialogueCount: dialogue,
  };
}

/** 角色表：沿用项目角色，缺字段时给可写作的最小集合 */
function mockCast(vars = {}, theme) {
  const src = Array.isArray(vars.characters) && vars.characters.length ? vars.characters : theme.chars;
  return src.slice(0, 6).map((c, i) => ({
    name: c.name,
    role: c.role || (i === 0 ? '主角' : '配角'),
    age: c.age || '', gender: c.gender || '',
    personality: c.personality || '',
    appearance: c.appearance || `${c.name}的造型待定`,
  })).filter((c) => c.name);
}

/** 整剧兜底：逐集展开成 2~3 场，覆盖全部分集（最多 12 集，与写作准则一致） */
function mockProjectScreenplay(vars = {}, theme) {
  const eps = (Array.isArray(vars.episodes) ? vars.episodes : []).filter((e) => e && (e.no || e.title));
  const cast = mockCast(vars, theme);
  const MAX_EPISODES = 12;
  const covered = eps.slice(0, MAX_EPISODES);
  const scenes = [];
  // 分集没带原文（历史项目只存了集名 + 梗概）时，把整段小说按集数均分回填：
  // 顺序基本对齐，内容比一句梗概厚得多，兜底剧本才不会整集只有三行
  const shared = String(vars.novelExcerpt || vars.sourceText || '').trim();
  const sharedParts = shared && covered.length > 1 ? splitIntoParts(shared, covered.length) : [];
  covered.forEach((ep, ei) => {
    const text = String(ep.excerpt || ep.text || '').trim() || sharedParts[ei] || String(ep.summary || '');
    // 本集统一地点与时间：某一场没写地点/时间线索时沿用本集结论，避免同集内乱跳
    const place = detectPlace(text) || detectPlace(String(ep.title || '')) || '';
    const timeLabel = detectTime(`${text}。${ep.title || ''}。${ep.summary || ''}`, (Number(ep.no) || 1) - 1);
    const brief = { ...ep, place, timeLabel };
    // 按「每场约 5 句」切场：切太碎会退化成 3 行一场的假详细，切太粗又回到一集一场
    const sentences = splitSentences(text).length;
    const want = Math.max(2, Math.min(4, Math.ceil(sentences / 5)));
    const parts = splitIntoParts(text, want);
    parts.forEach((part, si) => {
      scenes.push(mockScene({
        partText: part, ep: brief, index: si, total: parts.length, cast,
        fallbackLocation: clip(ep.sourceTitles?.[0] || ep.title, 24), theme,
      }));
    });
  });
  // 没有任何分集（历史项目）：用一句话构想 / 梗概起三场，保证剧本不是空数组
  if (!scenes.length) {
    const seedText = String(vars.novelExcerpt || vars.idea || '').trim();
    const parts = splitIntoParts(seedText || theme.scenes.map((s) => s.summary).join('。'), 3);
    parts.forEach((part, i) => {
      const s = theme.scenes[i % theme.scenes.length];
      scenes.push(mockScene({
        partText: part || s.summary, ep: { no: 1, title: s.location, summary: s.summary, hook: '' },
        index: i, total: parts.length, cast, fallbackLocation: s.location, theme,
      }));
    });
  }
  scenes.forEach((s, i) => { s.id = `SC${String(i + 1).padStart(2, '0')}`; s.no = i + 1; });
  const episodeList = covered.map((e, i) => ({
    no: Number(e.no) || i + 1,
    title: clip(e.title, 80),
    logline: clip(e.summary, 200),
    hook: clip(e.hook, 200),
  }));
  return {
    title: vars.title || shortTitle(vars.idea || '') || '未命名小说',
    genre: `小说改编 / ${theme.genre}`,
    logline: clip(eps[0]?.summary || vars.idea || '', 160),
    tone: MOOD_BY_THEME[theme.key] || MOOD_BY_THEME.general,
    // 主题优先用分集标题（「第 1 集 · 破庙铜钱」）而不是一句话构想：构想常是半句原文，
    // 直接当主题会显示成一长串叙事，读起来不像主题
    theme: clip(String(vars.theme || '').trim() || eps[0]?.title || vars.idea || '', 40),
    style: vars.style || theme.styleHint,
    characters: cast,
    acts: [],
    episodes: episodeList,
    scenes,
    durationSec: scenes.reduce((n, s) => n + (Number(s.durationSec) || 0), 0),
    coverage: {
      totalEpisodes: eps.length,
      coveredEpisodes: [...new Set(scenes.map((s) => s.episodeNo))],
      note: eps.length > MAX_EPISODES ? `仅转写前 ${MAX_EPISODES} 集，其余集见分集剧本` : '',
    },
    __mock: true,
  };
}

/** 单集兜底：按本集原文分场，用本集真实角色写可读剧本（不引入主题模板角色） */
function mockEpisodeScreenplay(vars = {}, theme) {
  const cast = mockCast(vars, theme);
  const target = Math.max(3, Math.min(10, Number(vars.targetScenes) || 3));
  const text = String(vars.originalText || vars.logline || '');
  const parts = splitIntoParts(text, target);
  while (parts.length < target) parts.push('');
  const chapters = Array.isArray(vars.chapters) ? vars.chapters.filter(Boolean) : [];
  const ep = {
    no: Number(vars.episodeNo) || 1, title: vars.episodeTitle || vars.title || '',
    summary: vars.logline || '', hook: vars.hook || '',
    // 本集原文既是分场素材，也是「台词归属」的检索上下文（谁在这句台词之前出场）
    text,
  };
  const scenes = parts.slice(0, target).map((part, i) => mockScene({
    partText: part, ep, index: i, total: target, cast,
    fallbackLocation: clip(chapters[i] || ep.title || vars.logline, 24), theme,
  }));
  // 首场承接上集结尾：把 prevRecap 写成一句旁白，避免每集都像第一集
  if (vars.prevRecap && scenes[0]) scenes[0].script.splice(1, 0, `旁白：承接上集——${clip(vars.prevRecap, 50)}`);
  return {
    title: clip(ep.title || `第 ${ep.no} 集`, 80),
    genre: clip(vars.project?.genre || theme.genre, 40),
    logline: clip(vars.logline || scenes[0]?.summary || '', 160),
    tone: MOOD_BY_THEME[theme.key] || MOOD_BY_THEME.general,
    style: clip(vars.project?.artStyle || theme.styleHint || 'cinematic', 30),
    characters: cast,
    scenes,
    durationSec: scenes.reduce((n, s) => n + (Number(s.durationSec) || 0), 0),
    __mock: true,
  };
}

function mockGenerate(intent, vars = {}) {
  const idea = String(vars.idea || vars.text || '');
  const theme = detectTheme(idea || vars.title || '');
  const seed = hash(idea + intent);
  switch (intent) {
    case 'screenplay': {
      // 单集剧本（episode-service 调用）：没有 episodes 数组，但会带本集原文 / 集号。
      // 旧实现落到下面的「主题模板」，会突然出现沈砚、顾言这类与用户小说无关的角色。
      if (isEpisodeScreenplay(vars)) return mockEpisodeScreenplay(vars, theme);
      // 创作项目（上传小说）：逐集展开为统一格式剧本（ViMax 式 1）
      if (Array.isArray(vars.episodes) && vars.episodes.length) return mockProjectScreenplay(vars, theme);
      const title = vars.title || (theme.key === 'noir' ? '雨夜来信' : theme.key === 'scifi' ? '坐标之外' : theme.key === 'youth' ? '夏末纸条' : shortTitle(idea) || '无名短片');
      return {
        title,
        genre: theme.genre,
        logline: `${shortTitle(idea) || '一个念头'}，被拆成三个场景、若干镜头，最终成为一段可以观看的故事。`,
        tone: MOOD_BY_THEME[theme.key] || MOOD_BY_THEME.general,
        style: vars.style || theme.styleHint,
        characters: theme.chars.map((c) => ({ ...c })),
        scenes: theme.scenes.map((s, i) => mockScene({
          partText: s.summary, ep: { no: 1, title: s.location, summary: s.summary, hook: '' },
          index: i, total: theme.scenes.length, cast: theme.chars, fallbackLocation: s.location, theme,
        })),
      };
    }
    case 'events': {
      const scenes = vars.scenes || theme.scenes;
      return {
        events: scenes.slice(0, 3).map((s, i) => ({
          title: `事件 ${i + 1} · ${s.location || s.title || '转折'}`,
          summary: s.summary || '推动故事向前的关键节点',
          processChain: i === 0 ? ['起因', '发现线索', '决定调查'] : i === 1 ? ['追问', '证词矛盾', '信任动摇'] : ['对峙', '真相浮现', '做出选择'],
          scenes: [
            { title: s.title || s.location || '场景', location: s.location || '内景', time: s.time || '夜', summary: s.summary || '' },
            // 式(5)：一个事件可含多个场景，decomposer 会递归展开全部场景
            { title: `${s.title || s.location || '场景'} · 后段`, location: s.location || '内景', time: s.time || '夜', summary: `${s.summary || '承接上文'}（续）` },
          ],
        })),
      };
    }
    case 'shots': {
      // count 由全片镜头预算下发，不能再用 3~8 的玩具范围覆盖，否则片段数无法精确
      const count = Math.max(1, Math.min(24, Number(vars.count) || 5));
      const clipSeconds = Number(vars.clipSeconds) || 3;
      const scene = vars.scene || theme.scenes[0];
      const location = scene.location || '场景';
      // 导演风格台词本：零 Key 时也用该导演的景别 / 光线 / 媒介词汇写分镜，
      // 而不是所有风格共用一套「冷调侧光 / 逆光轮廓」。
      // 动作词汇按档案的 pace.mode 分组：静默爆发 / 凌厉武打 / 慢仪式 / 生活呼吸 /
      // 缓慢静观 / 碎片跳切 / 骤起骤落，七种节奏各有一套，避免十位导演写成同一本。
      const a = vars.aesthetic && vars.aesthetic.id ? vars.aesthetic : null;
      const media = a?.medium?.length ? a.medium : ['冷调侧光', '逆光轮廓', '柔和顶光'];
      const light = a?.light ? a.light.split('；')[0].replace(/，.*$/, '') : '';
      const MOTION_BANK = {
        'silence-burst': ['角色保持不动', '极缓慢地转头', '手指移到枪柄', '画面静止'],
        kinetic: ['角色腾跃而起', '兵器横切过画面', '脚步急停扬起尘土', '衣袂随冲击扬起'],
        'slow': ['角色缓慢起身，衣摆垂落', '人物走入画面后停住', '镜头内只有光影在移动', '角色缓缓抬头看向远处'],
        ritual: ['队形从两侧合拢', '角色按仪轨一步步向前', '众人齐齐俯身行礼', '队列在鼓点中转向'],
        breath: ['角色蹲下捧起一把草', '风吹动衣角与发梢', '远处有什么在慢慢移动', '角色抬头看向天空'],
        fragment: ['角色错身而过', '手停在半空又收回', '门在身后缓缓关上', '烟灰落下的瞬间'],
        contrast: ['角色静立，气息先动', '刀出鞘的一瞬', '人影从梁上落下', '脚步在门外顿住'],
      };
      const motionBank = MOTION_BANK[a?.pace?.mode]
        || ['角色缓缓转身看向画外', '雨滴沿镜头前滑落', '远处灯光次第亮起', '纸页被风翻动'];
      // 运镜词汇同样按节奏分组：固定长镜导演不该每镜都「缓慢推镜」，
      // 凌厉武打也不该出现四种固定机位。fixedShotRatio 越高的导演，固定机位出现得越多。
      const MOVE_BANK = {
        'silence-burst': ['固定', '固定', '固定', '极缓慢横移'],
        kinetic: ['快速跟拍', '手持晃动', '急推', '甩镜'],
        'slow': ['固定', '缓慢横移', '固定', '极缓慢推近'],
        ritual: ['固定', '对称横移', '固定', '缓慢升降'],
        breath: ['固定', '缓慢横移', '固定', '缓慢拉远'],
        fragment: ['手持晃动', '跳切', '固定', '错位跟拍'],
        contrast: ['固定', '快速横移', '固定', '急推'],
      };
      const moveBank = MOVE_BANK[a?.pace?.mode] || MOVES;
      // 音频词汇：从媒介短语里抽出「真的会发声」的声源词（风 / 雨 / 雪 / 沙 / 海 / 潮 / 雷 / 浪），
      // 而不是整句照搬——「玻璃水汽的声音」「热浪扭曲的声音」都是不通的中文。
      const SOUND_WORDS = ['狂风', '暴雨', '雨丝', '细雨', '雨滴', '雨柱', '雨', '风沙', '沙尘',
        '飞雪', '落雪', '雪', '海风', '海潮', '潮水', '浪', '雷', '风', '水'];
      const natural = (a?.medium || [])
        .map((m) => SOUND_WORDS.find((w) => String(m).includes(w)))
        .filter(Boolean);
      const uniqueNatural = [...new Set(natural)].slice(0, 3);
      const audioBank = a
        ? [...uniqueNatural.map((m) => `${m}声`), '环境声压低人声', '转场保留连续底噪']
        : ['雨声与远处警笛', '低频环境音', '脚步与衣料摩擦', '短暂的静默'];
      // 出场人物优先用场景 / 剧本自带的角色，不要落回主题模板的玩具角色
      //（否则用户小说里的沈砚会变成模板里的「顾言」，分镜提示词与定妆资产对不上）。
      const castNames = [
        ...(Array.isArray(scene.characters) ? scene.characters : []),
        ...(Array.isArray(vars.characters) ? vars.characters.map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean) : []),
      ].filter(Boolean);
      const castBank = [...new Set(castNames)].length ? [...new Set(castNames)] : theme.chars.map((c) => c.name);
      return {
        shots: Array.from({ length: count }, (_, i) => ({
          shotNo: i + 1,
          size: pick(SIZES, i + (seed % 3)),
          angle: pick(ANGLES, i + (seed % 2)),
          movement: pick(moveBank, i),
          ffDesc: [
            location,
            pick(SIZES, i + (seed % 3)),
            `${castBank[i % castBank.length]}位于画面${['左三分之一', '中央', '右三分之一'][i % 3]}`,
            a ? `${a.paletteName} 主色调` : '',
            light || ['冷调侧光', '逆光轮廓', '柔和顶光'][i % 3],
            media[i % media.length],
            a?.texture || '环境细节保持一致',
          ].filter(Boolean).join('｜'),
          motionDesc: `${pick(moveBank, i)}，${motionBank[i % 4]}`,
          audioDesc: `${audioBank[i % audioBank.length]}`,
          duration: clipSeconds,
          characters: [castBank[i % castBank.length]],
        })),
      };
    }
    case 'characters': {
      const list = vars.characters || theme.chars;
      return {
        characters: list.map((c, i) => ({
          name: c.name, role: c.role || '角色',
          appearance: c.appearance || '造型待定',
          palette: ['#0b111c', ['#3a506b', '#6b4f8a', '#7a6fc4', '#3f6b5c'][i % 4], '#ff9a5c'],
          traits: ['动机连贯', '跨镜头可辨识', '服装一致'],
        })),
      };
    }
    case 'charExtract': {
      // 零 Key 兜底：只给「能从原著片段回溯」的占位设定，绝不编造人设。
      // 旧实现按候选序号轮流塞「男/女、18/25/30 岁、主角/反派」并生成模板外貌，
      // 结果会被路由当成 LLM 产物写入项目（source=llm），既误导用户，也会污染音色分配，
      // 还因来源不是 heuristic 导致后续真实 LLM 无法覆盖这些占位值。
      const candidates = Array.isArray(vars.candidates) && vars.candidates.length
        ? vars.candidates : theme.chars.map((c) => ({ name: c.name, hits: 1 }));
      const fragments = (Array.isArray(vars.fragments) ? vars.fragments : [])
        .map((f) => String(f?.text || ''));
      /** 从原文片段里截一句含角色名的完整原文（一定能在原著中逐字定位） */
      const quoteFor = (name) => {
        for (const frag of fragments) {
          const at = frag.indexOf(name);
          if (at < 0) continue;
          let start = at;
          for (let i = at - 1; i >= 0 && at - i <= 160; i -= 1) {
            if (/[。！？!?\n]/.test(frag[i])) { start = i + 1; break; }
          }
          let end = at + name.length;
          for (let i = end; i < frag.length && i - at <= 160; i += 1) {
            if (/[。！？!?\n]/.test(frag[i])) { end = i + 1; break; }
          }
          const q = frag.slice(start, end).trim().slice(0, 120);
          if (q.includes(name)) return q;
        }
        return '';
      };
      return {
        characters: candidates.slice(0, 12).map((c) => {
          const name = String(c.name || '');
          // hint 是候选抽取时从原著首现位置截出的原句；退化时再从片段里找
          const quote = String(c.hint || '') || quoteFor(name);
          return {
            name,
            aliases: [],
            role: '原著角色（占位）',
            // 性别 / 年龄 / 性格 / 配色 / 画风 / 关系一律留空：原文没写就不猜
            gender: '', age: '', personality: '', hair: '', costume: '', props: '',
            style: '', viewPrompt: '', palette: [], relations: [],
            appearance: quote ? `原著依据：${quote}` : '待补全 · 原著片段中未定位到该角色的外貌描写',
            staticFeatures: quote ? `原著原文：${quote}` : '待补全 · 未从原著片段识别出固定外貌特征',
            dynamicFeatures: '待补全 · 原著片段中未明确描写服饰与随身物件',
            evidence: quote ? [{ quote, kind: 'mention' }] : [],
          };
        }),
      };
    }
    case 'cameras': {
      const shots = vars.shots || [];
      const groups = [];
      for (let i = 0; i < shots.length; i += 2) {
        groups.push({
          id: `cam_${groups.length + 1}`,
          label: `机位 ${String.fromCharCode(65 + groups.length)}`,
          shotNos: shots.slice(i, i + 2).map((s) => s.shotNo),
          parent: groups.length > 0 ? `cam_${groups.length}` : null,
          reason: groups.length === 0 ? '建立镜头作为视觉锚点根节点' : '复用上一机位的角色与空间状态',
        });
      }
      return { cameras: groups };
    }
    case 'context': {
      const corpus = String(vars.corpus || '');
      const query = String(vars.query || '');
      const parts = corpus.split(/[。！？\n]/).map((s) => s.trim()).filter((s) => s.length > 6);
      const keys = query.replace(/[，。、\s]/g, '').slice(0, 6);
      const matched = parts.filter((s) => keys && s.includes(keys.slice(0, 2))).slice(0, 3);
      return {
        query,
        passages: (matched.length ? matched : parts.slice(0, 3)).map((s) => `……${s}。`),
        notes: [
          '角色动机：不要在后续镜头中改变既定立场',
          '空间状态：保持上一场景的道具位置与光照方向',
          '主题线索：呼应开篇出现的意象',
        ],
      };
    }
    case 'spatial': {
      return {
        fromCam: vars.fromCam || '机位 A', toCam: vars.toCam || '机位 B',
        spatialNotes: '两位角色的相对座位、桌面道具与墙面陈设保持一致；反打镜头隐式满足 180 度轴线规则。',
        axisRule: '180°',
        cameraPath: '从建立全景平滑过渡至反打过肩，保持视线方向连续',
      };
    }
    case 'review': {
      return { reason: '候选与镜头规格的语义对齐度更高，角色身份与空间布局更稳定。', highlights: ['构图符合景别', '角色可辨识', '光照方向一致'] };
    }
    case 'coverPrompt': {
      // 封面文生图提示词：片名 + 剧情梗概 + 电影海报视觉要求，可直接喂 SDXL；
      // 与 management.buildCoverPrompt 同构，作为零 Key / LLM 失败时的确定性回退
      const title = String(vars.title || '').trim().slice(0, 40) || shortTitle(idea) || '未命名故事';
      const gist = String(vars.logline || vars.summary || '').replace(/\s+/g, ' ').trim().slice(0, 160)
        || String(idea).replace(/\s+/g, ' ').trim().slice(0, 160)
        || (Array.isArray(vars.episodes) && vars.episodes.length ? String(vars.episodes[0]?.summary || '').slice(0, 160) : '');
      const custom = String(vars.custom || '').trim().slice(0, 400);
      const subject = custom || gist || '一部富有戏剧张力的故事';
      return {
        prompt: `电影海报风格的项目封面插画，片名《${title}》，${subject}，` +
          `cinematic movie poster, dramatic cinematic lighting, rich atmosphere, centered composition, ` +
          `highly detailed, film grain, no text, no watermark, no lettering`,
        negative: 'text, watermark, logo, lettering, caption, low quality, blurry, deformed',
        style: vars.style || theme.styleHint,
      };
    }
    case 'coverPromptDesign': {
      // 独立封面提示词 agent 的确定性兜底：输出完整连贯的中文描述句（非关键词堆砌）+ 少量英文质量词
      const title = String(vars.title || '').trim().slice(0, 40) || shortTitle(idea) || '未命名故事';
      const gist = String(vars.logline || vars.summary || '').replace(/\s+/g, ' ').trim().slice(0, 120)
        || String(idea).replace(/\s+/g, ' ').trim().slice(0, 120);
      const custom = String(vars.requirement || vars.custom || '').trim().slice(0, 200);
      const anime = vars.style === 'anime' || theme.styleHint === 'anime';
      const subject = custom
        ? `画面聚焦于${custom}的核心戏剧瞬间`
        : gist ? `画面呈现「${gist}」中最具张力的关键瞬间` : '画面呈现故事中最具张力的戏剧性瞬间';
      return {
        prompt: `为漫剧《${title}》设计的一张电影感封面插画：${subject}，` +
          `主角居于画面视觉中心，逆光与冷暖对比强化戏剧氛围，构图讲究留白与视线引导，` +
          `整体呈现${anime ? '高清赛璐璐动漫质感' : '写实电影质感'}，细节丰富，画面中不出现任何文字。` +
          `cinematic movie poster, highly detailed, dramatic lighting, no text, no watermark`,
        negative: 'text, watermark, logo, lettering, caption, low quality, blurry, deformed, bad anatomy',
        style: vars.style || theme.styleHint,
      };
    }
    case 'coverChat': {
      // 封面对话确定性回退：提示词交给独立设计 agent 的兜底模板（带上用户要求），再补一段回复与建议
      const nRefs = Array.isArray(vars.refs) ? vars.refs.length : 0;
      const lastUser = [...(Array.isArray(vars.history) ? vars.history : [])].reverse().find((x) => x?.role === 'user');
      const custom = String(lastUser?.content || '').trim();
      const base = mockGenerate('coverPromptDesign', { ...vars, requirement: custom });
      const lead = nRefs
        ? `已结合 ${nRefs} 张参考图的构图与配色基调，`
        : (custom ? `按「${custom.slice(0, 40)}」的要求，` : '');
      return {
        reply: `${nRefs || custom ? lead : '已根据项目资料'}为《${vars.title || '未命名影片'}》写好封面提示词，确认后即可生成。`,
        prompt: base.prompt,
        negative: base.negative,
        suggestions: ['再大气一点', '换一种画面风格', '直接生成封面'],
      };
    }
    case 'styleForge': {
      // 导演风格设计师对话（零 Key 确定性兜底）：从全部用户发言里抠出可用线索，
      // 合并进上一轮草稿；核心字段齐了就 ready，缺什么就在 reply 里追问什么。
      const prev = vars.draft && typeof vars.draft === 'object' ? { ...vars.draft } : {};
      const said = (Array.isArray(vars.history) ? vars.history : [])
        .filter((x) => x?.role === 'user').map((x) => String(x.content || '')).join('；');
      const draft = { ...prev };
      const named = said.match(/[《「“]([^》」”]{2,16})[》」”]/);
      const nameGuess = named?.[1]?.trim()
        || said.match(/(?:风格名|命名|叫|风格叫)\s*[：:]?\s*([^\s，,。；;]{2,16})/)?.[1]?.trim() || '';
      if (nameGuess && !draft.label) draft.label = nameGuess;
      const dirGuess = said.match(/(?:致敬|参考|仿|像)\s*([^\s，,。；;]{2,10})(?:的|风格|导演)?/)?.[1]?.trim() || '';
      if (dirGuess && !draft.director) draft.director = dirGuess;
      if (said.includes('慢') && !draft.pace?.mode) draft.pace = { minShotSec: 6, maxShotSec: 12, fixedShotRatio: 0.7, mode: 'slow' };
      if (said.includes('快') && !draft.pace?.mode) draft.pace = { minShotSec: 2, maxShotSec: 6, fixedShotRatio: 0.3, mode: 'kinetic' };
      // 颜色词 → 主色调（最多 4 组，颜色去重）
      const colorHit = [];
      for (const [word, hex] of Object.entries(COLOR_TABLE)) {
        if (said.includes(word) && !colorHit.some((p) => p.hex === hex)) {
          colorHit.push({ key: `pal-${colorHit.length + 1}`, name: `${word}调`, hex, mood: '' });
          if (colorHit.length >= 4) break;
        }
      }
      if (colorHit.length && !(Array.isArray(draft.palettes) && draft.palettes.length)) draft.palettes = colorHit;
      if (said && !draft.tone) draft.tone = `${detectTheme(said).genre.split(' / ')[0]}基调`;
      if (!draft.icon) draft.icon = '◇';

      const have = (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
      // 用户必须亲自给的只有三样：名称 / 主色调 / 基调；其余美学字段零 Key 用模板确定性补齐
      const missing = [];
      if (!have(draft.label)) missing.push('风格名称');
      if (!have(draft.palettes)) missing.push('主色调（1~4 组颜色，如「暗红与墨黑」）');
      if (!have(draft.tone)) missing.push('情绪基调');
      // 零 Key 时核心美学字段用题材模板确定性补齐：能给出可用草稿，但如实标注来源
      if (!have(draft.light)) draft.light = `${theme.key === 'noir' ? '单一实用光源与大面暗部' : '自然光为主，方向明确'}；情绪高点用逆光`;
      if (!have(draft.composition)) draft.composition = '大景别交代环境，中景给人物关系，特写只给关键道具与手部';
      if (!have(draft.camera)) draft.camera = draft.pace?.mode === 'kinetic' ? '手持跟拍与横移为主，升格只给关键动作' : '固定长镜为主，极缓横移，不用变焦';
      if (!have(draft.texture)) draft.texture = '胶片颗粒、真实织物与皮肤纹理';
      if (!have(draft.medium)) draft.medium = ['微风', '尘埃', '光影'];
      if (!have(draft.taboos)) draft.taboos = ['塑料美颜', '杂色堆砌', '无来源光晕'];
      if (!have(draft.stylePrompt)) {
        draft.stylePrompt = `${draft.label || '自定义'}电影感，${(draft.palettes?.[0]?.name) || '单一主色'}统治画面，${draft.light}，${draft.composition}，胶片颗粒质感`;
      }
      if (!have(draft.negativePrompt)) {
        draft.negativePrompt = 'washed-out colors, flat lighting, beauty filter, plastic skin, oversaturated rainbow palette, text watermark';
      }
      if (!have(draft.highlights)) {
        draft.highlights = [
          (draft.palettes?.[0]?.name ? `${draft.palettes[0].name}主色` : '单一主色'),
          draft.pace?.mode === 'kinetic' ? '高动能运镜' : '固定长镜',
          '胶片颗粒质感',
          '有来源光线',
        ];
      }
      if (!have(draft.summary)) draft.summary = `${draft.label || '自定义'}风格：以${(draft.palettes?.[0]?.name) || '主色'}与${draft.pace?.mode === 'kinetic' ? '快节奏运镜' : '静观长镜'}构建${draft.tone || '统一'}的画面基调。`;
      if (!have(draft.tagline)) draft.tagline = `${draft.pace?.mode === 'kinetic' ? '高动能' : '静观'} · ${(draft.palettes?.[0]?.name) || '主色'}统治`;
      if (!have(draft.colorRule)) draft.colorRule = '主色调占画面 60% 以上，辅色降饱和';
      if (!have(draft.pacing)) draft.pacing = `单镜 ${draft.pace?.minShotSec ?? 3}–${draft.pace?.maxShotSec ?? 8} 秒`;
      if (!have(draft.visualStyle)) draft.visualStyle = draft.stylePrompt;
      if (!have(draft.shotStrategy)) draft.shotStrategy = '先以全景交代空间，再以中景给人物关系，特写只给关键动作与道具';
      if (!have(draft.audioStrategy)) draft.audioStrategy = '环境声放大自然媒介，BGM 权重低、情绪克制';
      if (!have(draft.continuityRules)) {
        draft.continuityRules = ['主色调跨镜头保持同一色号', '光源方向在同一场戏内固定', '角色服装配色以身份板为唯一基准'];
      }
      if (!have(draft.risks)) draft.risks = ['主色被模型稀释：提示词前置色号并加大权重', '节奏被平均化：显式指定铺垫与爆发的时长'];
      const ready = !missing.length;
      const confirmed = [draft.label, draft.palettes?.[0]?.name, draft.tone].filter(Boolean).slice(0, 3).join(' · ');
      return {
        reply: `${confirmed ? `已记下：${confirmed}。` : ''}${ready
          ? '关键信息已齐，可以直接保存为导演风格了；想继续调整就直接说改哪里。'
          : `还缺：${missing.slice(0, 2).join('、')}。`}`,
        draft,
        ready,
        suggestions: ready
          ? ['保存为导演风格', '主色再暗一点', '节奏再快一些']
          : [`我想要${missing[0] || '主色'}：…`, '参考王家卫的都市暧昧感', '先看看已收集的内容'],
      };
    }
    case 'storyIdea': {
      // 项目信息 AI 补全：一句话构想 → 创作设定各字段；零 Key 时用主题模板确定性生成
      const name = String(vars.title || '').trim() || shortTitle(idea) || '未命名项目';
      const brief = String(vars.idea || '').replace(/\s+/g, ' ').trim();
      return {
        title: name,
        genre: theme.genre,
        audience: '16–30 岁 · 短剧 / 漫剧观众',
        logline: brief.slice(0, 80) || `《${name}》：${theme.scenes[0].summary}；${theme.scenes[2].summary}。`,
        tone: '张弛有度 · 情绪浓度高',
        artStyle: vars.style || theme.styleHint,
        firstEpisodeTheme: theme.scenes[0].summary,
        worldview: `以「${theme.genre}」为基调的近现实世界观：${theme.scenes.map((s) => s.location).join('、')}是主要舞台，${theme.chars.map((c) => c.name).join('、')}的命运在此交汇。`,
      };
    }
    case 'novelOutline': {
      const count = Math.max(1, Math.min(8, Number(vars.chapterCount) || 3));
      const title = String(vars.title || '').trim() || NOVEL_TITLES[theme.key] || NOVEL_TITLES.general;
      return {
        title,
        genre: theme.genre,
        logline: String(vars.idea || '').slice(0, 80) || `${theme.scenes[0].summary}，${theme.chars[0].name}被卷入其中。`,
        chapters: Array.from({ length: count }, (_, i) => {
          const scene = theme.scenes[i % theme.scenes.length];
          const last = i === count - 1;
          return {
            title: `第${CN_NUM[i] || i + 1}章 · ${shortTitle(scene.location) || `转折 ${i + 1}`}`,
            summary: last ? `${scene.summary}，所有线索收束，真相浮出水面。` : `${scene.summary}，${theme.chars[i % theme.chars.length].name}决定追查到底。`,
            hook: last ? '故事在黎明前抵达终点，也抵达了新的起点。' : `就在这时，${theme.chars[(i + 1) % theme.chars.length].name}带来了一个谁也没想到的消息。`,
          };
        }),
      };
    }
    case 'novelChapter': {
      const ch = {
        title: String(vars.chapterTitle || vars.title || '第一章'),
        summary: String(vars.summary || ''),
        hook: String(vars.hook || ''),
      };
      return {
        title: ch.title,
        text: mockChapterText(theme, ch, {
          chapterChars: vars.chapterChars,
          index: Number(vars.index) || 0,
          total: Number(vars.total) || 1,
        }),
      };
    }
    case 'voiceAssign': {
      // 零 Key 确定性匹配：把角色列表交给启发式打分器，在给定音色库里各挑最佳，输出与 LLM 同构
      const characters = Array.isArray(vars.characters) ? vars.characters : [];
      const voices = Array.isArray(vars.voices) ? vars.voices : [];
      const matched = matchVoicesForCharacters(characters, voices);
      return {
        assignments: matched
          .filter((m) => m.voiceId)
          .map((m) => ({
            characterName: m.characterName,
            voiceId: m.voiceId,
            voiceName: m.voiceName,
            reason: m.reason,
          })),
        source: 'heuristic',
      };
    }
    case 'directorTreatment': {
      // 零 Key 的导演阐述只依据项目里真实存在的字段拼装，不编造剧情细节；
      // director-agent 会把 source 标为 heuristic，前端如实提示「配置模型后可由 LLM 重写」。
      // __mockKeys 必须打上：导演智能体靠它判断「这是模板而非 LLM 输出」，
      // 进而改用导演风格基线；漏打会让选谁都拿到这份通用方案。
      const title = String(vars.title || '').trim().slice(0, 40) || shortTitle(idea) || '未命名影片';
      const gist = String(vars.logline || '').replace(/\s+/g, ' ').trim().slice(0, 120)
        || String(idea).replace(/\s+/g, ' ').trim().slice(0, 120)
        || theme.scenes[0].summary;
      const style = String(vars.style || '').trim() || theme.styleHint;
      const episodes = Array.isArray(vars.episodes) ? vars.episodes.length : 0;
      const characters = Array.isArray(vars.characters) ? vars.characters.length : 0;
      return withMockKeys({
        title: `《${title}》导演阐述 · ${style}`,
        logline: gist,
        tone: `${theme.genre}基调 · 情绪递进克制、关键段落留白`,
        visualStyle: `${style} 画风 · 冷暖对比布光，主色随场次推进渐变，避免跨镜头色温跳变`,
        pacing: episodes
          ? `全片 ${episodes} 集，每集以「建立空间 → 冲突升级 → 结尾钩子」三段推进，单镜头控制在 4–6 秒`
          : '以「建立空间 → 冲突升级 → 结尾钩子」三段推进，单镜头控制在 4–6 秒',
        shotStrategy: '先全景建立人物关系，再以过肩与特写交替推进；全程遵守 180 度轴线，运动镜头承接上一镜头的动势',
        audioStrategy: characters
          ? `按 ${characters} 位角色的音色分配结果铺设对白，环境声压低以突出人声，转场处保留连续底噪`
          : '对白优先，环境声压低以突出人声，转场处保留连续底噪',
        continuityRules: [
          '角色面部、发型、服装与主配色跨镜头保持一致',
          '同一场戏的光位与色温不随切镜改变',
          '遵守 180 度轴线，反打机位不越轴',
          '每组首帧以前一镜头尾帧为空间锚点',
        ],
        risks: [
          '人物身份漂移：用定妆参考图与公共提示词锁定造型',
          '镜头衔接断裂：显式生成跨机位转场片段',
        ],
      });
    }
    default:
      return { text: `${intent} 的模拟输出`, seed };
  }
}

/** 给纯模板产物打上补位来源标记，供上层判断「这是模板而非 LLM 输出」 */
function withMockKeys(obj) {
  return { ...obj, __mockKeys: Object.keys(obj) };
}

/** AI 小说 Mock 素材：确定性段落模板，围绕主题角色与场景生成可读正文 */
const NOVEL_TITLES = { noir: '雨夜来信', scifi: '坐标之外', youth: '夏末纸条', general: '未命名故事' };
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八'];

function mockChapterText(theme, ch, opts = {}) {
  const target = Math.max(300, Math.min(2000, Number(opts.chapterChars) || 800));
  const [c0, c1, c2] = [theme.chars[0], theme.chars[1 % theme.chars.length], theme.chars[2 % theme.chars.length] || theme.chars[0]];
  const scene = theme.scenes[(opts.index || 0) % theme.scenes.length];
  const beats = [
    `${scene.time}的${scene.location}比往日更安静。${c0.name}站在${['街角', '窗前', '灯影里'][opts.index % 3 || 0]}，${c0.appearance || ''}，目光落在${ch.hook ? '远处' : '手里的东西上'}。${String(ch.summary || scene.summary).replace(/。$/, '')}，这件事从一开始就不像看上去那么简单。`,
    `「${opts.index === 0 ? '你确定要从这里开始吗？' : '线索到这里就断了。'}」${c1.name}${['低声问', '抬起眼', '把声音压得很低'][opts.index % 3 || 0]}。${c1.appearance || ''}。${c0.name}没有立刻回答，只是${['把那张纸又看了一遍', '望向雨幕深处', '轻轻摇了摇头'][opts.index % 3 || 0]}。`,
    `回忆像潮水一样涌上来。${scene.summary}——那是所有事情的起点。${c2.name}曾经说过：「真相不会自己走出来，它要等一个愿意弯腰的人。」这句话，${c0.name}一直记到现在。`,
    `时间一点点过去，${scene.location}的光线慢慢变了。${c0.name}终于开口：「${opts.total > (opts.index || 0) + 1 ? '继续查下去，不管结局是什么。' : '现在，是时候把这一切讲完了。'}」${c1.name}点了点头，两个人都没有再说话。`,
    `${ch.hook ? `直到${ch.hook.replace(/。$/, '')}，${c0.name}才意识到，真正的答案一直藏在最显眼的地方。` : `风从${scene.location}穿过，吹散了最后一点犹豫。`}故事还远没有结束，但方向已经清晰。`,
  ];
  let text = beats.join('\n\n');
  // 不足目标字数时按确定性顺序循环补段（内容围绕主题，不重复整段）
  let i = 0;
  while (text.length < target) {
    const s = theme.scenes[i % theme.scenes.length];
    text += `\n\n${s.time}，${s.location}。${s.summary}。${theme.chars[i % theme.chars.length].name}在这里停留了很久，把每一个细节都记进心里——这些细节，后来都成了拼图上不可或缺的一块。`;
    i += 1;
  }
  return text.slice(0, target + 80);
}

function mergeDefaults(intent, real, vars) {
  const base = mockGenerate(intent, vars);
  const merged = { ...base, ...(real && typeof real === 'object' ? real : {}) };
  // 真实输出缺字段时由 Mock 补位——逐键标注补位来源，避免模板内容冒充 LLM 产物
  const mockKeys = [];
  for (const key of Object.keys(base)) {
    const v = merged[key];
    const empty = v === undefined || v === null || v === ''
      || (Array.isArray(base[key]) && (!Array.isArray(v) || !v.length));
    if (empty) merged[key] = base[key];
    if (empty || !(real && typeof real === 'object' && key in real)) mockKeys.push(key);
  }
  return mockKeys.length ? { ...merged, __mockKeys: mockKeys } : merged;
}

/** 模型常把结果包进以任务命名的单键里（如 {"cover文生图提示词":"{\"prompt\":...}"}），递归解包 */
function unwrapNested(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const keys = Object.keys(obj);
  if (keys.length === 1 && typeof obj[keys[0]] === 'string') {
    const inner = obj[keys[0]].trim();
    if (inner.startsWith('{')) {
      try { return unwrapNested(JSON.parse(inner)); } catch { /* 值不是 JSON，保持原样 */ }
    }
  }
  return obj;
}

function extractJSON(text = '') {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('响应中没有 JSON 对象');
  return unwrapNested(JSON.parse(cleaned.slice(start, end + 1)));
}

export function createProviders(settings = {}, log = () => {}, onUsage = null) {
  const mode = settings.provider === 'openai' && settings.baseUrl && settings.apiKey ? 'openai' : 'mock';
  const comfy = settings.comfy || null;
  // 成片真实性策略由项目 runtime 下发；real 模式下 composer 不会生成预览成片，
  // 这里同时把策略透传给片段产物标记，供验收逐片段核对「ComfyUI 是否真的被调用」。
  const filmPolicy = normalizeFilmPolicy(settings.runtime?.filmPolicy ?? comfy?.filmPolicy);
  const comfyWorkflows = { image: null, video: null };
  if (comfy?.enabled) {
    for (const kind of ['image', 'video']) {
      const raw = comfy[`${kind}Workflow`];
      if (!raw) continue;
      try { comfyWorkflows[kind] = parseWorkflow(raw, `${kind} 工作流`); }
      catch (err) { log('warn', `ComfyUI ${kind} 工作流无效：${err.message}`); }
    }
  }
  const comfyActive = Boolean(comfyWorkflows.image || comfyWorkflows.video
    || (Array.isArray(comfy?.imageWorkflowLib) && comfy.imageWorkflowLib.length)
    || (Array.isArray(comfy?.videoWorkflowLib) && comfy.videoWorkflowLib.length));
  // 板块级接口档案：库里有可选档案时也算「已配置」，由各入口在提交前按板块解析。
  // 旧配置的镜像字段仍在，解析不到任何档案时会原样回退它，行为与升级前一致。
  const IMAGE_SCOPE_BY_KIND = {
    cover: 'cover', poster: 'poster', grid: 'grid', storyboard: 'storyboard',
    character: 'character', 'character-view': 'character-view', 'character-sheet': 'character-sheet',
    transition: 'transition', keyframe: 'keyframe',
  };
  const hasInterface = (kind) => Boolean(comfyWorkflows[kind]
    || (Array.isArray(comfy?.[`${kind}WorkflowLib`]) && comfy[`${kind}WorkflowLib`].length));
  // 导演风格（美学档案）：由编排器 / 导演智能体通过 settings.aesthetic 下发。
  // 只认已解析好的纯数据对象，不在这里再读项目，避免 provider 与业务层耦合。
  const aesthetic = settings.aesthetic && settings.aesthetic.id ? settings.aesthetic : null;
  /** 把导演风格拼进出图 / 出片提示词；没有选风格时原样返回（行为与升级前一致） */
  const stylePrompts = (prompt, extraNegative = '') => {
    if (!aesthetic) return { prompt: String(prompt ?? ''), negative: String(extraNegative ?? '') };
    const out = aestheticPrompt(aesthetic.id, {
      base: prompt, paletteKey: aesthetic.paletteKey, extraNegative,
    });
    return { prompt: out.positive, negative: out.negative };
  };
  /** Mock 出图用的调色板：有风格用风格色板，否则退回内置风格名 */
  const styleArg = (style) => (aesthetic?.svg ? aesthetic.svg : (style || settings.style || 'cinematic'));
  const delay = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('已取消', 'AbortError')); }, { once: true });
  });

  /**
   * 接口参数 Agent：只有当该接口的可视化输入参数表里标了「由 Agent 生成」时才触发。
   * 真实 LLM 模式下按本次画面内容产出参数；mock / 调用失败时用档案里填的兜底值，
   * 任何情况都不阻断出图。结果转成 nodeOverrides，沿用既有注入链路（零改注入器）。
   */
  async function agentParamOverrides(cfg, vars, signal) {
    const plan = Array.isArray(cfg?.paramPlan) ? cfg.paramPlan : [];
    if (!plan.length) return [];
    const fallback = plan.filter((p) => p.fallback !== undefined && p.fallback !== '')
      .map((p) => ({ node: p.node, input: p.input, value: p.fallback }));
    if (mode !== 'openai') return fallback;   // Mock 项目不发无谓请求
    const fields = plan.map((p) => ({ node: p.node, input: p.input, 名称: p.label || p.input, 要求: p.hint || '' }));
    const system = '你是 ComfyUI 工作流参数配置助手。只输出严格 JSON：{"params":[{"node":"节点id","input":"输入名","value":"参数值"}]}，不要解释、不要 Markdown 代码块。只为列出的字段给值，node 与 input 必须原样照抄；value 只能是字符串或数字，不要写对象、数组或 {{占位符}}。';
    const user = JSON.stringify({
      接口: cfg.imageWorkflowName || cfg.videoWorkflowName || cfg.audioWorkflowName || '',
      本次画面提示词: String(vars?.prompt ?? '').slice(0, 900),
      负向提示词: String(vars?.negative ?? cfg.negativePrompt ?? '').slice(0, 300),
      画幅: `${cfg.width || ''}x${cfg.height || ''}`,
      需要生成的参数: fields,
    });
    try {
      const reply = await callLLM(system, user, signal, { intent: 'interface-params' });
      const rows = parseAgentParamReply(reply, plan);
      log('info', `接口参数 Agent 生成 ${rows.length}/${plan.length} 项`);
      return rows.length ? rows : fallback;
    } catch (err) {
      log('warn', `接口参数 Agent 失败，回退档案兜底值：${err.message}`);
      return fallback;
    }
  }

  /**
   * 按「板块 + 本次指定接口」解析一份 ComfyUI 接口档案后执行。
   * 优先级：请求 interfaceId > 板块绑定 > 类别 activeId > 旧镜像字段。
   * 档案自带的请求参数 / 节点覆盖 / 显式绑定全部随 cfg 进入注入器。
   */
  async function runComfy(kind, vars, signal, hooks = {}, scopeOpts = {}) {
    const scope = scopeOpts.scope || (kind === 'video' ? 'video' : 'keyframe');
    // 单次调用没显式指定时，回落到路由层挂在 cfg 上的「本次接口」（body.interfaceId）。
    // 这样所有生成入口只需把请求级选择放进 config，不必逐层改业务函数签名。
    const interfaceId = scopeOpts.interfaceId || comfy?.requestInterfaceId || '';
    const resolved = resolveInterface(comfy || {}, { kind, scope, interfaceId });
    if (!resolved.workflow) throw new Error(`板块 ${scope} 没有可用的 ComfyUI 接口文件`);
    let workflow;
    try { workflow = parseWorkflow(resolved.workflow, `${kind} 工作流`); }
    catch (err) { throw new Error(`接口档案「${resolved.interfaceName || resolved.interfaceId}」无效：${err.message}`); }
    const cfg = {
      ...resolved.config,
      resolvedInterface: {
        id: resolved.interfaceId, name: resolved.interfaceName, kind: resolved.kind,
        scope: resolved.scope, via: resolved.via, warnings: resolved.warnings,
      },
    };
    // 输入参数表里标为「由 Agent 生成」的槽位在这里补齐；接口没标记时零额外开销。
    const agentOverrides = await agentParamOverrides(cfg, vars, signal);
    if (agentOverrides.length) cfg.nodeOverrides = [...(cfg.nodeOverrides || []), ...agentOverrides];
    const r = await runWorkflow(cfg, workflow, { ...vars, cfg }, {
      signal, log, bindings: resolved.bindings,
      // 提交即把 prompt_id 交给上层落盘：服务重启后能凭它把已完成的结果认回来
      onSubmitted: hooks.onPromptId,
    });
    return {
      ...r, config: cfg,
      interfaceId: resolved.interfaceId, interfaceName: resolved.interfaceName,
      via: resolved.via, warnings: resolved.warnings,
    };
  }

  /**
   * 画布资产 → ComfyUI 可上传的二进制；SVG 渲染成等价 PNG 占位。
   * 一次可取多张（角色定妆需要「正面 + 3/4 侧 + 面部」多参考），
   * 逐张独立转换，任何一张缺失都不影响其余参考图可用。
   */
  function referenceBuffer(url, opts = {}) {
    if (!url) return null;
    const m = String(url).match(/\/assets\/([A-Za-z0-9_.-]+)/);
    if (!m) return null;
    const name = m[1];
    const buf = readAsset(name);
    if (!buf) return null;
    if (/\.svg$/i.test(name)) {
      // Mock 模式下角色定妆图是 SVG，槽位只收位图。这里按「视图语义」栅格化：
      // 角色视图画成对应角度的人形，其余（分镜 / 转场 / 海报）仍用分镜占位帧。
      // 旧实现一律转成风景占位图，会让下游拿着一张无关画面当角色参考。
      const isCharacter = Boolean(opts.view) || opts.kind === 'character' || opts.kind === 'character-view';
      const buffer = isCharacter
        ? characterViewFrame({
          view: opts.view || 'front', palette: opts.palette || [], style: opts.style,
          seed: `${opts.seed || ''}-${name}`, label: opts.label || '',
        })
        : placeholderFrame({ seed: `${opts.seed || ''}-${name}`, shotNo: opts.shotNo || 1, style: opts.style });
      return {
        buffer, name: `${name.replace(/\.svg$/i, '')}.png`, converted: true,
        synthetic: true, view: isCharacter ? (opts.view || 'front') : null,
      };
    }
    return { buffer: buf, name, converted: false, synthetic: false, view: opts.view || null };
  }

  /** 多参考图 → [{buffer,name}]，按传入顺序对应工作流的多个 LoadImage 插槽
   *  条目可以是 URL 字符串，也可以是 {url, view, palette, label} —— 后者让 SVG 转 PNG 时
   *  能按正确的视角／配色栅格化，而不是退化成风景占位图。 */
  function referenceBuffers(urls = [], opts = {}) {
    return (Array.isArray(urls) ? urls : [urls])
      .map((u, i) => {
        const item = typeof u === 'string' ? { url: u } : (u || {});
        return referenceBuffer(item.url, {
          ...opts, seed: `${opts.seed || ''}-ref${i}`,
          view: item.view || opts.view, palette: item.palette || opts.palette,
          label: item.label || opts.label, kind: item.kind || opts.kind,
        });
      })
      .filter((r) => r && r.buffer);
  }

  /** 论文式(6)：原著分块 → BM25 召回 → 归一化重排 → 相关片段 */
  function localContext(vars = {}) {
    const corpus = String(vars.corpus || '');
    const query = String(vars.query || '');
    const chunks = chunkNovel(corpus);
    const kb = new KnowledgeBase(chunks);
    const hits = retrieveRelevantChunks(kb, [query], { topK: 6, threshold: 0 });
    return {
      query,
      passages: hits.slice(0, 3).map((h) => h.text),
      notes: [
        '角色动机：不要在后续镜头中改变既定立场',
        '空间状态：保持上一场景的道具位置与光照方向',
        '主题线索：呼应开篇出现的意象',
      ],
      chunkCount: chunks.length,
    };
  }

  // 端点挂起兜底：LLM 调用没有超时会让节点永久卡死；超时按普通失败处理，回退 Mock
  // 默认 300s：推理型模型（如 MiMo）单请求实测可达 140s+，旧默认 120s 会静默超时回退
  const LLM_TIMEOUT_MS = Number(settings.llmTimeoutMs) || 300_000;

  // Token 用量采集：每次真实 LLM 调用产出一条记录，经 onUsage 回调交给上层归集
  function reportUsage(record) {
    if (!onUsage) return;
    try { onUsage(record); } catch (err) { log('warn', `token 统计回调异常：${err.message}`); }
  }

  async function callLLM(system, user, callerSignal, meta = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`LLM 调用超时（${LLM_TIMEOUT_MS / 1000}s）`)), LLM_TIMEOUT_MS);
    const onAbort = () => ctrl.abort(callerSignal?.reason);
    const attached = Boolean(callerSignal) && !callerSignal.aborted;
    if (callerSignal?.aborted) ctrl.abort(callerSignal.reason);
    else if (attached) callerSignal.addEventListener('abort', onAbort, { once: true });
    try {
      const base = String(settings.baseUrl).replace(/\/+$/, '');
      const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
        body: JSON.stringify({
          model: settings.model || 'gpt-4o-mini',
          temperature: Number.isFinite(Number(settings.temperature)) ? Number(settings.temperature) : 0.7,
          // meta.images 存在时用 OpenAI 兼容多模态消息格式（VLM 看图评审）
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: meta.images?.length
              ? [{ type: 'text', text: user }, ...meta.images.map((url) => ({ type: 'image_url', image_url: { url } }))]
              : user },
          ],
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const json = await res.json();
      const content = json?.choices?.[0]?.message?.content || '';
      // OpenAI 兼容端点在响应里自带 usage；缺失时按字符估算（CJK 场景 ≈ 2 字符/token）
      const u = json?.usage || {};
      const promptTokens = Number(u.prompt_tokens) || Math.ceil(String(system).length / 2);
      const completionTokens = Number(u.completion_tokens) || Math.ceil(String(content).length / 2);
      reportUsage({
        intent: meta.intent || '', model: json?.model || settings.model || 'gpt-4o-mini', ts: Date.now(),
        promptTokens, completionTokens,
        totalTokens: Number(u.total_tokens) || promptTokens + completionTokens,
        calls: 1,
        estimated: !json?.usage,
      });
      return extractJSON(content);
    } finally {
      clearTimeout(timer);
      if (attached) callerSignal.removeEventListener('abort', onAbort);   // 长运行中避免在 run 级 signal 上堆积监听器
    }
  }

  async function generate(intent, vars = {}, signal) {
    // 式(6) 检索是确定性算法，不经过 LLM：既避免长篇原著撑爆上下文，也保证 Mock/真实模型行为一致
    if (intent === 'context') return localContext(vars);
    let fellBack = false;
    // 导演风格统一兜底：调用方（分镜 / 场景 / 事件）没显式传 aesthetic 时，
    // 用本项目生效的风格补上，避免「有的智能体吃到了风格、有的没吃到」。
    if (aesthetic && !vars.aesthetic) vars = { ...vars, aesthetic };
    if (mode === 'openai') {
      try {
        // __images：多模态图片输入（dataURL），不进文本 payload，走 OpenAI image_url 消息
        const userVars = { ...vars };
        const images = userVars.__images;
        delete userVars.__images;
        const system = `你是影视制作智能体。只输出严格 JSON，不要解释、不要 Markdown 代码块。输出结构：${SCHEMAS[intent] || '{text:string}'}。内容使用简体中文，符合用户提供的故事设定。` +
          (intent === 'screenplay' ? `\n${screenplayGuide(vars)}` : '') +
          (intent === 'charExtract'
            ? '输入的「原著片段」是全书检索召回的原文证据（FRAGMENT 标签）。只能依据这些片段抽取角色，不得引入片段之外的设定；片段未写明但必需的外观特征可以依据题材与上下文合理补全，但不得与原文矛盾。'
            : (vars.fragments ? '输入中的 fragments 是原著检索片段（FRAGMENT 标签），镜头/场景描述必须与其人物、道具、环境、光线保持一致，不要引入矛盾设定。' : '')) +
          (intent === 'charExtract' ? `\n角色抽取准则：\n${SCHEMAS.charExtractGuide}` : '');
        // 角色抽取：原文证据以可读文本呈现（JSON 里再塞一遍会重复占 token），fragments 只保留元信息
        let user;
        if (intent === 'charExtract') {
          const { fragments, novelText, ...rest } = userVars;
          user = `任务类型：${intent}\n输入数据：\n${JSON.stringify(rest, null, 2)}`
            + `\n\n原著片段（FRAGMENT，抽取角色的唯一证据来源）：\n${vars.novelText || ''}`
            + (fragments?.length ? `\n\n（已召回 ${fragments.length} 段相关原文）` : '');
        } else {
          user = `任务类型：${intent}\n输入数据：\n${JSON.stringify(userVars, null, 2)}`;
        }
        // 输出解析失败（响应不是合法 JSON / 缺结构）给一次带提示的重试：
        // 模型偶发的 Markdown 包裹或尾部截断不该直接把整次提取退回启发式
        let out = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const retryHint = attempt
              ? '\n注意：上一次响应不是合法 JSON。只能输出符合上述结构的严格 JSON 对象，不要 Markdown 代码块、不要任何解释文字。'
              : '';
            out = await callLLM(system + retryHint, user, signal, { intent, images });
            break;
          } catch (err) {
            const parseFailed = /JSON|响应中没有|Unexpected token|Unterminated/i.test(String(err?.message || ''));
            if (!parseFailed || attempt === 1) throw err;
            log('warn', `模型输出解析失败，重试一次：${err.message}`);
          }
        }
        if (!out) throw new Error('模型未返回输出');
        // 角色抽取不做 Mock 补位：模型没给的字段一律留空。
        // 补位会让 mockGenerate 的玩具角色属性冒充真实提取结果写进项目（且不触发 __fallback）。
        if (intent === 'charExtract') {
          if (!Array.isArray(out.characters) || !out.characters.length) throw new Error('模型未返回有效角色');
          return out;
        }
        const merged = mergeDefaults(intent, out, vars);
        // 剧本补结构不补内容：场号 / 内外景 / 时长 / 说话人 / 分集覆盖由代码推导，
        // 人物动机、场景目标这些创作字段没写就是没写（留给质量告警提示重跑）。
        return intent === 'screenplay' ? enrichScreenplay(merged, vars) : merged;
      } catch (err) {
        // 失败回退 Mock 也计入调用次数（tokens 为 0），保证「调用了真实端点」这件事可审计
        reportUsage({ intent, model: settings.model || 'gpt-4o-mini', ts: Date.now(),
          promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 1, estimated: false, fallback: true });
        log('warn', `模型调用失败，已回退 Mock：${err.message}`);
        fellBack = true;
      }
    }
    await delay(140 + (hash(intent + JSON.stringify(vars)) % 260), signal);
    const mock = mockGenerate(intent, vars);
    // 零 Key / 回退的剧本同样补齐结构：前端与下游拿到的是同一份 v2 契约，
    // 不会出现「有模型时是十几场、没模型时是 3 段概述」的两套剧本。
    const shaped = intent === 'screenplay' ? enrichScreenplay(mock, vars) : mock;
    // 零 Key 的角色抽取只是「按原文片段生成的启发式占位」，不是 LLM 成果：
    // 显式打标让路由把 source 定为 heuristic，前端也能如实提示「配置模型后可重提」，
    // 避免把模板角色冒充 AI 提取结果写进项目（同时保证后续真实 LLM 可以覆盖占位值）。
    if (mode === 'mock' && intent === 'charExtract') return { ...shaped, __mock: true };
    // 回退显式化：真实模型失败才打 __fallback（Mock 模式本身不算「失败回退」）
    return fellBack ? { ...shaped, __fallback: true } : shaped;
  }

  async function image(opts = {}, signal) {
    const { kind = 'keyframe', style = 'cinematic', label = '', seed = '', shotNo = 1,
      size = '中景', angle = '平视', movement = '固定', prompt = '', characters = [] } = opts;
    // 导演风格介入点 ①：正向提示词追加主色 + 视觉语法，负向追加该风格的固定否定词。
    // 未选风格技能时 stylePrompts 原样返回，行为与升级前完全一致。
    const styled = stylePrompts(opts.prompt ?? prompt, opts.negative || '');
    const finalPrompt = styled.prompt;
    const finalNegative = styled.negative;
    // Mock 出图用导演调色板：不同导演风格画出来的 SVG 真的不一样，而不是只换文字
    const mockPalette = styleArg(style);
    // ComfyUI 的 style 变量仍传原风格名，避免把对象塞进工作流 JSON
    const styleName = typeof mockPalette === 'string' ? mockPalette : (style || settings.style || 'cinematic');

    // 参考图：角色定妆 / 关键帧都可能带多张（正面 + 3/4 侧 + 面部特写），
    // 按顺序对应工作流的多个 LoadImage 插槽；单张时沿用旧行为（应用到全部插槽）。
    // 条目可为字符串 URL 或 {url, view, palette, label}，便于 SVG→PNG 时按视角栅格化。
    const refItems = Array.isArray(opts.refs) ? opts.refs.filter(Boolean) : [opts.refs].filter(Boolean);
    const refUrls = refItems.map((r) => (typeof r === 'string' ? r : r?.url)).filter(Boolean);
    const refBuffers = referenceBuffers(refItems, {
      seed, shotNo, style: mockPalette,
      palette: opts.palette, label: label || opts.name, kind,
    });

    // requireReal=true：只认本地 ComfyUI 真实出图。工作流未配置直接报错、
    // ComfyUI 调用失败也不再静默回退自绘 SVG——「没有生成」绝不能拿占位图冒充。
    const requireReal = opts.requireReal === true;

    // 主路径：本地 ComfyUI「导出(API)」工作流
    if (hasInterface('image')) {
      try {
        // 角色多视图提示词已含视图角度与风格锁，不再叠加景别/机位默认值；海报（封面）同理
        const fullPrompt = ['character-view', 'character-sheet', 'poster'].includes(kind)
          ? `${finalPrompt}｜${styleName}`
          : `${finalPrompt}｜${size}｜${angle}｜${movement}｜${styleName}`;
        const result = await runComfy('image', {
          prompt: fullPrompt, negative: finalNegative,
          seed: `${kind}-${seed}-${shotNo}`, style: styleName, shotNo,
          filenamePrefix: `lingximanju_${kind}_${shotNo}`,
          imageRefs: refBuffers,
          imageBuffer: refBuffers[0]?.buffer, imageName: refBuffers[0]?.name,
        }, signal, { onPromptId: opts.onPromptId }, {
          scope: IMAGE_SCOPE_BY_KIND[kind] || 'keyframe',
          interfaceId: opts.interfaceId,
        });
        return {
          url: result.primary.url,
          width: result.config.width, height: result.config.height,
          provider: 'comfyui', promptId: result.promptId,
          source: 'comfyui', isRealImage: true,
          workflow: String(result.interfaceName || comfy.imageWorkflowName || 'image'),
          interfaceId: result.interfaceId, scope: IMAGE_SCOPE_BY_KIND[kind] || 'keyframe',
          applied: result.applied.length, assets: result.assets,
          refsUsed: refBuffers.length, refsRequested: refUrls.length,
        };
      } catch (err) {
        if (comfy.strict || requireReal) throw err;
        log('warn', `ComfyUI 出图失败，已回退本地生成：${err.message}`);
      }
    }
    if (requireReal) {
      throw new Error(hasInterface('image')
        ? `ComfyUI 真实出图失败：已按要求中止，不回退占位图`
        : '未配置 ComfyUI 出图工作流：请到「设置 → 本地 ComfyUI」导入一份「导出(API)」格式的图像工作流后再生成');
    }

    if (settings.imageEndpoint) {
      try {
        const res = await fetch(settings.imageEndpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: finalPrompt, negative_prompt: finalNegative, size: '1280x720', n: 1 }), signal,
        });
        if (res.ok) {
          const json = await res.json();
          const url = json?.data?.[0]?.url || json?.url;
          if (url) return { url, width: 1280, height: 720, provider: 'remote', refsUsed: 0, refsRequested: refUrls.length };
          const b64 = json?.data?.[0]?.b64_json;
          if (b64) return { url: writeAsset(`${uid('img')}.png`, Buffer.from(b64, 'base64')), width: 1280, height: 720, provider: 'remote', refsUsed: 0, refsRequested: refUrls.length };
        }
      } catch (err) { log('warn', `图像接口失败，已回退自绘 SVG：${err.message}`); }
    }
    await delay(180 + (hash(seed + finalPrompt) % 320), signal);
    let svg;
    // Mock 自绘使用导演调色板（mockPalette），提示词用 finalPrompt：同一镜头换导演风格画面会不同
    if (kind === 'character') svg = characterSVG({ name: label, appearance: finalPrompt, style: mockPalette, seed });
    else if (kind === 'character-view') svg = characterViewSVG({ name: label, appearance: finalPrompt, view: opts.view, palette: opts.palette, style: mockPalette, seed });
    else if (kind === 'character-sheet') svg = characterSheetSVG({ name: label, appearance: finalPrompt, views: opts.views, palette: opts.palette, style: mockPalette, seed });
    else if (kind === 'transition') svg = transitionSVG({ from: opts.from, to: opts.to, style: mockPalette, seed });
    else if (kind === 'poster') svg = posterSVG({ title: label, shotCount: opts.shotCount || 0, duration: opts.duration || 0, style: mockPalette });
    else svg = storyboardSVG({ title: label, shotNo, size, angle, movement, prompt: finalPrompt, style: mockPalette, characters, seed, kind });
    return {
      url: writeAsset(`${uid('img')}.svg`, svg), width: 640, height: 360, provider: 'mock',
      // Mock 自绘不消费参考图：如实标注，避免把「有参考图」误当成「参考图已生效」
      refsUsed: 0, refsRequested: refUrls.length,
      styleApplied: aesthetic ? aesthetic.id : null,
      note: refUrls.length ? 'Mock 自绘占位不消费参考图；接入 ComfyUI 出图工作流后参考图按 LoadImage 插槽生效' : '',
    };
  }

  async function video(opts = {}, signal) {
    const frames = opts.frames || [];
    const duration = Number(opts.duration) || 5;
    // 导演风格介入点 ②：视频提示词同样追加风格串与否定词，
    // 保证「上一镜关键帧 + 运动描述」出的片段也符合该导演的光线与色彩语法。
    const styledVideo = stylePrompts(opts.prompt || '', opts.negative || '');
    const videoPrompt = styledVideo.prompt;
    const videoNegative = styledVideo.negative;
    const videoStyleName = typeof styleArg(opts.style) === 'string' ? styleArg(opts.style) : 'cinematic';

    // 主路径：本地 ComfyUI 图生视频 / 首尾帧工作流
    // 只导出导演包时跳过本地视频渲染（成片交给导演工作台生成），避免浪费 GPU
    if (hasInterface('video') && comfy.outputMode !== 'director-pack') {
      try {
        const first = frames.find(Boolean);
        const ref = referenceBuffer(first, { seed: opts.prompt, shotNo: opts.shotNo || 1, style: styleArg(opts.style) });
        // 帧率可能由该板块绑定的接口档案覆盖，先解析一次再算帧数
        const clipCfg = resolveInterface(comfy || {}, { kind: 'video', scope: 'video', interfaceId: opts.interfaceId }).config;
        const result = await runComfy('video', {
          prompt: videoPrompt, negative: videoNegative,
          motion: videoPrompt,
          seed: `clip-${first}-${opts.shotNo || 1}`,
          frames: Math.round(duration * (Number(clipCfg.fps) || 24)), duration,
          shotNo: opts.shotNo || 1, style: videoStyleName,
          filenamePrefix: `lingximanju_clip_${opts.shotNo || 1}`,
          imageBuffer: ref?.buffer, imageName: ref?.name,
        }, signal, { onPromptId: opts.onPromptId }, {
          scope: 'video', interfaceId: opts.interfaceId,
        });
        const videoAsset = result.assets.find((a) => a.kind === 'video');
        // 工作流只出图时绝不能把图片当视频片段：真实模式必须拿到视频文件
        if (!videoAsset) {
          throw new Error(`ComfyUI 工作流已执行（${result.promptId}）但没有视频产物，请确认输出节点是 SaveVideo / VHS_VideoCombine`);
        }
        const posterAsset = result.assets.find((a) => a.kind === 'image');
        return {
          url: videoAsset.url, file: videoAsset.file, assets: result.assets,
          poster: posterAsset?.url || first || null,
          frames, duration, promptId: result.promptId,
          provider: 'comfyui', synthetic: false,
          source: 'comfyui', isRealVideo: true,
          workflow: String(result.interfaceName || comfy.videoWorkflowName || 'video'),
          interfaceId: result.interfaceId, scope: 'video',
          filmPolicy,
          note: `由 ComfyUI「${result.interfaceName || comfy.videoWorkflowName || '视频工作流'}」真实生成（prompt_id ${result.promptId}）。`,
        };
      } catch (err) {
        // 用户确实接了视频工作流时，real 策略不允许把失败静默伪装成片段：
        // 抛错让节点标红，直接看到是哪一段的 ComfyUI 出问题。
        // 完全没有配置工作流时仍走 mock，但验收会明确判「真实片段 0/N」并给出配置指引。
        if (comfy.strict || (filmPolicy === 'real' && hasInterface('video'))) throw err;
        log('warn', `ComfyUI 视频生成失败，已回退帧序列预览：${err.message}`);
      }
    }

    await delay(260 + (hash(JSON.stringify(opts)) % 340), signal);
    return {
      poster: frames[0] || null,
      frames,
      duration,
      synthetic: true,
      provider: 'mock',
      source: 'mock', isRealVideo: false,
      note: 'Mock 模式以关键帧序列模拟镜头预览，不是 AI 生成视频；导入 ComfyUI 视频工作流后返回真实片段。',
    };
  }

  /** 候选图 → data URL（SVG 复用占位帧转换链路转 PNG）；取不到返回 null */
  function candidateDataURL(c, i) {
    const ref = referenceBuffer(c.url, { seed: c.seed || `${i}`, shotNo: i + 1, style: settings.style });
    if (!ref?.buffer) return null;
    const mime = /\.jpe?g$/i.test(ref.name) ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,${ref.buffer.toString('base64')}`;
  }

  /** 启发式评审：Mock 模式或 VLM 不可用时的回退；judgeMode 显式标注来源，消灭假 VLM */
  async function judgeHeuristic(opts, candidates, fellBack, signal) {
    await delay(120, signal);
    const scores = candidates.map((c, i) => {
      const h = hash(`${i}|${c.prompt || ''}|${c.url || ''}`);
      const base = 0.62 + (h % 350) / 1000;
      return Math.min(0.98, base + (i === 0 ? 0.04 : 0));
    });
    const index = scores.indexOf(Math.max(...scores));
    return {
      index,
      scores: scores.map((s) => Number(s.toFixed(3))),
      criteria: ['视觉保真度', '叙事一致性', '镜头规格遵循'],
      reason: `候选 ${index + 1} 在角色可辨识度、构图与光照方向上与「${opts.shotTitle || '镜头规格'}」最一致；其余候选存在身份或空间状态漂移风险。`,
      judgeMode: 'heuristic',
      ...(fellBack ? { fallback: true } : {}),
    };
  }

  /** 式(4) best-of-k：把全部候选图喂给多模态模型真实看图择优 */
  async function judgeWithVLM(opts, candidates, signal) {
    const images = candidates.map((c, i) => candidateDataURL(c, i));
    if (!images.length || images.some((x) => !x)) throw new Error('候选图无法读取为位图');
    const system = '你是影视质量评审，直接观察给出的候选关键帧图片打分。只输出严格 JSON：'
      + '{"index":数字,"scores":[数字],"criteria":["..."],"reason":"..."}。'
      + 'index 为最优候选序号（从 0 开始），scores 与候选一一对应（0~1 之间），内容使用简体中文。';
    const user = `评审对象：${opts.shotTitle || '镜头规格'}\n`
      + `评审维度：${(opts.criteria || []).join('、') || '视觉保真度、叙事一致性、镜头规格遵循'}\n`
      + `候选数量：${candidates.length}\n`
      + `各候选的镜头/构图要求：${JSON.stringify(candidates.map((c) => c.prompt || ''))}`;
    const out = await callLLM(system, user, signal, { intent: 'judge', images });
    const index = Math.max(0, Math.min(candidates.length - 1, Math.round(Number(out.index)) || 0));
    const scores = candidates.map((_, i) => Math.max(0, Math.min(1, Number(out.scores?.[i]) || 0.6)));
    return {
      index,
      scores: scores.map((s) => Number(s.toFixed(3))),
      criteria: Array.isArray(out.criteria) && out.criteria.length ? out.criteria.map(String) : (opts.criteria || []),
      reason: String(out.reason || '').slice(0, 200) || `候选 ${index + 1} 综合评分最高。`,
      judgeMode: 'vlm',
    };
  }

  async function judge(opts = {}, signal) {
    const candidates = opts.candidates || [];
    // 式(4)：模型支持图片输入时真实 VLM 看图择优；失败/无图回退启发式并显式标注
    if (mode === 'openai' && candidates.length) {
      try {
        return await judgeWithVLM(opts, candidates, signal);
      } catch (err) {
        log('warn', `VLM 评审失败，回退启发式打分：${err.message}`);
        return judgeHeuristic(opts, candidates, true, signal);
      }
    }
    return judgeHeuristic(opts, candidates, false, signal);
  }

  /** 连接自检：发一次微型真实调用，返回延迟与预览；不落盘、不产资产 */
  async function testConnection(signal) {
    const t0 = Date.now();
    if (mode !== 'openai') return { ok: true, mode: 'mock', latencyMs: 0, preview: 'Mock 模式无需连接真实端点' };
    try {
      const out = await callLLM('只输出严格 JSON：{"pong":"pong"}', 'ping', signal, { intent: 'test' });
      return { ok: true, mode, latencyMs: Date.now() - t0, preview: JSON.stringify(out).slice(0, 60) };
    } catch (err) {
      return { ok: false, mode, latencyMs: Date.now() - t0, error: err.message };
    }
  }

  return { mode, comfyActive, filmPolicy, generate, image, video, judge, detectTheme, testConnection };
}
