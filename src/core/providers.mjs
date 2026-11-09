// Provider 抽象：把「模型能力」与「智能体业务」彻底解耦
// - mock：确定性中文内容 + 自绘 SVG 资产，零 Key 可完整跑通
// - openai：任意 OpenAI 兼容 /chat/completions，失败自动回退 mock
// - comfyui：图片 / 视频直接提交本地 ComfyUI 导出的 API 格式 workflow（主路径）
import { uid, writeAsset, readAsset } from './store.mjs';
import { hash, storyboardSVG, characterSVG, characterViewSVG, characterSheetSVG, transitionSVG, posterSVG } from './artwork.mjs';
import { parseWorkflow, runWorkflow } from './comfyui.mjs';
import { placeholderFrame, characterViewFrame } from './raster.mjs';
import { chunkNovel, KnowledgeBase, retrieveRelevantChunks } from './knowledge.mjs';
import { matchAll as matchVoicesForCharacters } from './voices.mjs';
import { normalizeFilmPolicy } from './film-policy.mjs';
import { skillAesthetic, getDirectorSkill } from './director-skills.mjs';
import { aestheticPrompt } from './director-styles.mjs';

const SCHEMAS = {
  screenplay: '剧本：{title, genre, logline, style, characters:[{name,role,appearance}], scenes:[{id,location,time,summary,script:[字符串]}]}',
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
    '只依据输入的原著片段抽取角色，不得引入片段之外的设定；片段未写明但必需的外观特征可以依据题材与上下文合理补全，但不得与原文矛盾。',
    '同一实体在原文中出现的所有称呼（姓名、昵称、职务、称谓）都要归并到同一个角色，其余写法列入 aliases。',
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
};

const THEMES = [
  {
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

function mockGenerate(intent, vars = {}) {
  const idea = String(vars.idea || vars.text || '');
  const theme = detectTheme(idea || vars.title || '');
  const seed = hash(idea + intent);
  switch (intent) {
    case 'screenplay': {
      // 创作项目（上传小说）：把分集梗概与结尾钩子归一为统一格式剧本（ViMax 式 1）
      if (Array.isArray(vars.episodes) && vars.episodes.length) {
        const clip = (v, n) => { const t = String(v ?? '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
        const chars = (Array.isArray(vars.characters) && vars.characters.length ? vars.characters : theme.chars)
          .slice(0, 4).map((c, i) => ({ name: c.name, role: c.role || (i === 0 ? '主角' : '配角'), appearance: c.appearance || '造型待定' }));
        return {
          title: vars.title || shortTitle(idea) || '未命名小说',
          genre: `小说改编 / ${theme.genre}`,
          logline: clip(vars.episodes[0]?.summary || idea, 60),
          style: vars.style || theme.styleHint,
          characters: chars,
          episodeCount: vars.episodes.length,
          scenes: vars.episodes.slice(0, 3).map((e, i) => ({
            id: `sc_ep${e.no || i + 1}`,
            location: clip(e.sourceTitles?.[0] || e.title || `第 ${i + 1} 集`, 24),
            time: i === 0 ? '开篇' : '接续',
            summary: clip(e.summary, 50),
            script: [
              `【第 ${e.no || i + 1} 集 · ${clip(e.sourceTitles?.[0] || e.title, 20)}】`,
              clip(i === 0 ? (vars.novelExcerpt || e.summary) : e.summary, 90),
              `结尾钩子：${clip(e.hook, 42)}`,
            ],
          })),
        };
      }
      const title = vars.title || (theme.key === 'noir' ? '雨夜来信' : theme.key === 'scifi' ? '坐标之外' : theme.key === 'youth' ? '夏末纸条' : shortTitle(idea) || '无名短片');
      return {
        title,
        genre: theme.genre,
        logline: `${shortTitle(idea) || '一个念头'}，被拆成三个场景、若干镜头，最终成为一段可以观看的故事。`,
        style: vars.style || theme.styleHint,
        characters: theme.chars.map((c) => ({ ...c })),
        scenes: theme.scenes.map((s, i) => ({
          id: `sc_${i + 1}`, location: s.location, time: s.time, summary: s.summary,
          script: [
            `【${s.time} · ${s.location}】`,
            `${s.summary}。`,
            `${theme.chars[0].name}：「${i === 0 ? '这件事，不像看上去那么简单。' : i === 1 ? '再给我一点时间，线索能连上。' : '现在，我们终于可以把它讲完了。'}」`,
            `${theme.chars[1 % theme.chars.length].name} 没有回答，只是看向画面外的某个方向。`,
          ],
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
      return {
        shots: Array.from({ length: count }, (_, i) => ({
          shotNo: i + 1,
          size: pick(SIZES, i + (seed % 3)),
          angle: pick(ANGLES, i + (seed % 2)),
          movement: pick(moveBank, i),
          ffDesc: [
            location,
            pick(SIZES, i + (seed % 3)),
            `${theme.chars[i % theme.chars.length].name}位于画面${['左三分之一', '中央', '右三分之一'][i % 3]}`,
            a ? `${a.paletteName} 主色调` : '',
            light || ['冷调侧光', '逆光轮廓', '柔和顶光'][i % 3],
            media[i % media.length],
            a?.texture || '环境细节保持一致',
          ].filter(Boolean).join('｜'),
          motionDesc: `${pick(moveBank, i)}，${motionBank[i % 4]}`,
          audioDesc: `${audioBank[i % audioBank.length]}`,
          duration: clipSeconds,
          characters: [theme.chars[i % theme.chars.length].name],
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
  const comfyActive = Boolean(comfyWorkflows.image || comfyWorkflows.video);
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

  /** 执行一份用户粘贴的 API 格式工作流 */
  function runComfy(kind, vars, signal) {
    return runWorkflow(comfy, comfyWorkflows[kind], { ...vars, cfg: comfy }, {
      signal, log, bindings: comfy?.bindings?.[kind] || [],
    });
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
        return mergeDefaults(intent, out, vars);
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
    // 零 Key 的角色抽取只是「按原文片段生成的启发式占位」，不是 LLM 成果：
    // 显式打标让路由把 source 定为 heuristic，前端也能如实提示「配置模型后可重提」，
    // 避免把模板角色冒充 AI 提取结果写进项目（同时保证后续真实 LLM 可以覆盖占位值）。
    if (mode === 'mock' && intent === 'charExtract') return { ...mock, __mock: true };
    // 回退显式化：真实模型失败才打 __fallback（Mock 模式本身不算「失败回退」）
    return fellBack ? { ...mock, __fallback: true } : mock;
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

    // 主路径：本地 ComfyUI「导出(API)」工作流
    if (comfyWorkflows.image) {
      try {
        // 角色多视图提示词已含视图角度与风格锁，不再叠加景别/机位默认值
        const fullPrompt = kind === 'character-view' || kind === 'character-sheet'
          ? `${finalPrompt}｜${styleName}`
          : `${finalPrompt}｜${size}｜${angle}｜${movement}｜${styleName}`;
        const result = await runComfy('image', {
          prompt: fullPrompt, negative: finalNegative,
          seed: `${kind}-${seed}-${shotNo}`, style: styleName, shotNo,
          filenamePrefix: `lingximanju_${kind}_${shotNo}`,
          imageRefs: refBuffers,
          imageBuffer: refBuffers[0]?.buffer, imageName: refBuffers[0]?.name,
        }, signal);
        return {
          url: result.primary.url, width: comfy.width, height: comfy.height,
          provider: 'comfyui', promptId: result.promptId,
          source: 'comfyui', isRealImage: true,
          workflow: String(comfy.imageWorkflowName || 'image'),
          applied: result.applied.length, assets: result.assets,
          refsUsed: refBuffers.length, refsRequested: refUrls.length,
        };
      } catch (err) {
        if (comfy.strict) throw err;
        log('warn', `ComfyUI 出图失败，已回退本地生成：${err.message}`);
      }
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
    if (comfyWorkflows.video && comfy.outputMode !== 'director-pack') {
      try {
        const first = frames.find(Boolean);
        const ref = referenceBuffer(first, { seed: opts.prompt, shotNo: opts.shotNo || 1, style: styleArg(opts.style) });
        const result = await runComfy('video', {
          prompt: videoPrompt, negative: videoNegative,
          motion: videoPrompt,
          seed: `clip-${first}-${opts.shotNo || 1}`,
          frames: Math.round(duration * (comfy.fps || 24)), duration,
          shotNo: opts.shotNo || 1, style: videoStyleName,
          filenamePrefix: `lingximanju_clip_${opts.shotNo || 1}`,
          imageBuffer: ref?.buffer, imageName: ref?.name,
        }, signal);
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
          workflow: String(comfy.videoWorkflowName || 'video'),
          filmPolicy,
          note: `由 ComfyUI「${comfy.videoWorkflowName || '视频工作流'}」真实生成（prompt_id ${result.promptId}）。`,
        };
      } catch (err) {
        // 用户确实接了视频工作流时，real 策略不允许把失败静默伪装成片段：
        // 抛错让节点标红，直接看到是哪一段的 ComfyUI 出问题。
        // 完全没有配置工作流时仍走 mock，但验收会明确判「真实片段 0/N」并给出配置指引。
        if (comfy.strict || (filmPolicy === 'real' && comfyWorkflows.video)) throw err;
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
