/* ============================================================================
 * 角色名可信度（Character Name Sanity）
 *
 * 为什么单独抽出来：启发式抽取、LLM 抽取、批量合并三条路径都会产出「名字」，
 * 过去只有启发式内部做了几个正则过滤，LLM 返回什么就信什么，于是出现
 * 「回头」「刀光」「冲他」这类把动作/方位/物件当角色，以及「沈青崖不」
 * 这种把人名和下一句的第一个字粘在一起的问题。
 *
 * 这里只做「这个字符串像不像一个人的称呼」这一件事，纯函数、无 I/O，
 * 由 novel.mjs（启发式候选）与 characters.mjs（LLM 结果兜底清洗）共用。
 * ==========================================================================*/

/** 常见姓氏：命中即视为强人名信号（同时也是「允许的起始字」白名单） */
export const SURNAMES = '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤';

/** 明确不是人物的常见词：动作、方位、身体部位、物件、天气、泛称 */
export const NON_PERSON_NAMES = new Set([
  // 动作 / 方位 / 时间
  '回头', '扭头', '转头', '转身', '回身', '起身', '动身', '抽身', '侧身', '俯身',
  '低头', '抬头', '点头', '摇头', '抬眸', '垂眸', '抬眼', '垂眼', '回眸',
  '开口', '住口', '闭口', '张嘴', '咬牙', '皱眉', '冷笑', '苦笑', '沉默', '叹气',
  '伸手', '收手', '抬手', '拱手', '抱拳', '迈步', '止步', '驻足', '停步',
  '冲他', '冲她', '朝他', '朝她', '向他', '向她', '对他', '对她', '给他', '给她',
  '把刀', '将刀', '被人', '有人', '没人', '那人', '此人', '一人', '两人', '三人',
  '众人', '对方', '自己', '他们', '我们', '你们', '她们', '它们', '别人',
  '片刻', '终于', '忽然', '然后', '接着', '于是', '这时', '此时', '此刻',
  '当下', '次日', '半晌', '良久', '随后', '顿时', '猛地', '忽地', '马上', '立刻',
  // 身体部位
  '脸上', '眼中', '眼里', '手里', '手中', '心里', '心中', '身上', '身后', '身前',
  '面前', '口中', '肩上', '背上', '胸口', '嘴角', '眼神', '目光', '脸色', '额头',
  '手指', '手掌', '脚底', '脚边', '耳边', '身边', '眼前', '鼻尖', '喉咙', '脖颈',
  // 物件 / 环境 / 声音
  '刀光', '剑光', '血光', '刀锋', '剑锋', '刀身', '剑身', '血迹', '血流', '血水',
  '声音', '脚步', '脚步声', '呼吸', '气息', '雨水', '风雪', '风声', '雷声', '雨声',
  '雾气', '夜色', '月光', '灯光', '火光', '影子', '背影', '尸体', '匾额', '门楣',
  '窗外', '门外', '屋里', '屋内', '远处', '近处', '四周', '地上', '桌上', '天上',
  '空中', '半空', '墙角', '街口', '门口', '路口', '檐下', '树下', '灯下',
  '所有', '一切', '这些', '那些', '这样', '那样', '如此', '什么', '怎么', '为何',
  // 泛称 / 职业（没有具体姓名或稳定指代时不是角色）
  '贩夫', '走卒', '车夫', '马夫', '船夫', '樵夫', '渔夫', '农夫', '小二', '伙计',
  '掌柜', '路人', '行人', '百姓', '村民', '侍卫', '士兵', '官差', '捕快', '衙役',
  '邻居', '男人', '女人', '老人', '少年', '少女', '孩子', '小孩', '男孩', '女孩',
  '老板', '老板娘', '火车', '汽车', '肥女', '人群', '众人',
  // 泛称 / 时间 / 常用名词：姓氏字开头但显然不是角色（「大家说」「老头道」）
  '大家', '大伙', '各位', '老头', '老太', '老汉', '老娘', '老子', '老大', '大哥',
  '大姐', '大爷', '大妈', '小子', '高手', '大道', '大学', '小时', '程序', '老师',
  '大门', '胡子', '汉子', '姑娘', '黎明', '天亮', '半晌', '功夫',
  '同时', '当年', '如今', '毕竟', '果然', '竟然', '居然', '依然', '仍旧', '始终',
  '一向', '一直', '从来', '向来', '终于', '首先', '其次', '最后', '另外',
]);

/** 叠词副词：淡淡 / 冷冷 / 喃喃 这类是描写状语，不是人名。
 *  单独列出来（而不是「所有叠词」），是因为「惠惠」「晶晶」是真实昵称。 */
export const ADVERB_DUP = new Set([
  '淡淡', '冷冷', '喃喃', '轻轻', '缓缓', '慢慢', '静静', '默默', '微微', '悄悄',
  '偷偷', '匆匆', '渐渐', '狠狠', '幽幽', '连连', '暗暗', '早早', '远远', '高高', '远远',
]);

/** 名字里几乎不会出现的字：话/事/装/服 等（挡住「废话少」「龙王装」这类碎片） */
const NON_NAME_CHARS = /[话事装服衫裳帽鞋]/;
/** 数量词 + 量词拼出的泛称（两个人 / 三个人 / 数个家伙） */
const NUMERAL_FRAGMENT_RE = /^[两二三四五六七八九十几数半全][个位名人家只条群张把件]/;
/** 虚词 / 时间副词残片混进名字（曾经 / 已经 / 忽然） */
const FRAGMENT_WORD_RE = /(?:曾经|已经|终于|忽然|突然|立刻|马上|随即|依然|仍旧|始终|渐渐|连忙|赶紧|急忙|不由|不禁|似乎|仿佛|好像|一直|从来|向来|顿时|当下)/;
/** 名字尾部是副词残字（「老周曾」「张纸又」）：汉语人名几乎不以这些字收尾 */
const FRAGMENT_TAIL_RE = /[曾又已终仍便才却竟居倒偏忽顿猛]/;

/** 不能作为人名开头的字（动词 / 介词 / 代词 / 量词 / 物件词）。
 *  注意：姓氏表里的字一律放行（冷、白、金、石、江、林 等都是姓）。 */
const BAD_START = new Set(
  '回低抬转朝向往从把将被让给对跟和与为在到冲望看听说问答笑哭走跑站坐推拉握拿递扔踢劈砍挥伸缩点摇叹皱沉猛忽顿只却便又也都就才仍还已正刚忍不没无有刀剑血尸门窗墙雨风雷光声影手脚眼嘴心脸背胸腰腿臂她他它我你您这那每某所个位条只件把张片左右'.split(''),
);

const BAD_NAME_RE = /[的地得了着过们是很最每某所\s\dA-Za-z]/;
/** 名字第二字起不允许出现虚词/副词：挡住「夏已经」「林外」这类从叙述里切出来的碎片。
 *  只查首字之后，避免误伤「于谦」「向问天」这类首字本身就是姓氏/姓氏字的真实人名。
 *  注意「左 / 右」不在此列：它们是常见名字用字（刘左、陈右），曾经把它们当虚词
 *  导致「刘左」这种全书 800 次出场的主角被判成碎片、整条漏掉。 */
const FUNCTION_CHARS = /[的得了着过们是很最这那每某所已经就都也又还只才却便仍把将被让给为到冲和与从向往对跟而并且则若即再更太真没不外内上下里中前后旁边]/;
const ROLE_PREFIX = /^[老小阿大]/;
const VERB_TAIL_RE = /(?:说|道|问|答|笑|喊|叫|望|盯|瞥|叹|把|将|回|应|摇|看|听|想|站|坐|走|握|放|接|推|点|转|拿|递|进|出|声|低|轻|抬|忽|然|后|着|知)$/;
const IN_NAME_VERB_RE = /[说问答喊叫]/;
const PLACE_SUFFIX = /(?:城|镇|村|府|局|校|店|宫|寺|山|河|街|路|院|楼|站|国|军|队|帮|客栈|酒楼|茶馆|花园|广场|码头|车站|大街|小巷)$/;

const HAN_ONLY = /^[\u4e00-\u9fa5]{2,4}$/;
/** 复姓：四字人名几乎只可能是「复姓 + 双字名」，其余四字串一律视为句子碎片 */
const COMPOUND_SURNAMES = ['欧阳', '司马', '上官', '诸葛', '夏侯', '皇甫', '尉迟', '公孙', '慕容', '长孙',
  '宇文', '司徒', '令狐', '东方', '独孤', '南宫', '西门', '轩辕', '端木', '百里', '呼延', '东郭'];

/**
 * 这个字符串像不像一个人的称呼。
 * 判定顺序：长度 → 形态 → 常见非人名词 → 起始字 → 尾部动词 → 虚词。
 * 姓氏或「老/小/阿/大」这类称呼前缀开头的名字放行（老周 / 沈父 / 阿宝）。
 * @param {string} raw
 */
export function isLikelyPersonName(raw) {
  const name = String(raw || '').trim().replace(/^[「『“"']|[」』”"']$/g, '');
  if (!HAN_ONLY.test(name)) return false;
  if (NON_PERSON_NAMES.has(name)) return false;
  if (ADVERB_DUP.has(name)) return false;
  if (NUMERAL_FRAGMENT_RE.test(name)) return false;
  if (FRAGMENT_WORD_RE.test(name)) return false;
  if (FRAGMENT_TAIL_RE.test(name)) return false;
  if (NON_NAME_CHARS.test(name)) return false;
  if (name.length === 4 && !COMPOUND_SURNAMES.some((s) => name.startsWith(s))) return false;
  if (BAD_NAME_RE.test(name)) return false;
  if (FUNCTION_CHARS.test(name.slice(1))) return false;
  const hasSurname = SURNAMES.includes(name[0]);
  const rolePrefix = ROLE_PREFIX.test(name[0]);
  if (!hasSurname && !rolePrefix && BAD_START.has(name[0])) return false;
  if (!hasSurname && !rolePrefix && VERB_TAIL_RE.test(name)) return false;
  if (IN_NAME_VERB_RE.test(name)) return false;
  if (PLACE_SUFFIX.test(name)) return false;
  return true;
}

/**
 * 去掉「人名 + 下一句第一个字」粘出来的扩展名：
 *   「沈青崖不动声色」→ 抽出「沈青崖不」，而「沈青崖」本身已是候选 → 丢弃「沈青崖不」。
 * 只在短名（≥2 字）是长名前缀时才丢弃，避免误伤「沈父 / 沈青崖」这类真实共存的称呼。
 * @param {Array<{name:string}>} list
 */
export function dropExtendedNames(list = []) {
  const names = new Set((Array.isArray(list) ? list : []).map((c) => String(c?.name || '')).filter(Boolean));
  return (Array.isArray(list) ? list : []).filter((c) => {
    const n = String(c?.name || '');
    if (!n) return false;
    for (let len = 2; len < n.length; len += 1) {
      if (names.has(n.slice(0, len))) return false;
    }
    return true;
  });
}

/**
 * 清洗一批角色：过滤非人名、去扩展名、按名/别名去重，返回被丢弃的名字便于如实上报。
 * @param {Array} list 原始角色数组
 * @param {object} opts { text, max }
 * @returns {{characters:Array, dropped:string[]}}
 */
export function sanitizeCharacterList(list = [], opts = {}) {
  const max = Math.max(1, Number(opts.max) || 12);
  const dropped = [];
  const kept = [];
  const seen = new Map();   // nameKey → 角色

  const keyOf = (s) => String(s || '').replace(/[\s《》「」『』"'·]/g, '').toLowerCase();

  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name || '').trim();
    if (!name) continue;
    if (!isLikelyPersonName(name)) { dropped.push(name); continue; }
    if (opts.text && !String(opts.text).includes(name)) { dropped.push(name); continue; }
    const item = { ...raw, name };
    const keys = [keyOf(name), ...(Array.isArray(item.aliases) ? item.aliases.map(keyOf) : [])].filter(Boolean);
    const hit = keys.map((k) => seen.get(k)).find(Boolean);
    if (hit) {
      // 同一实体的多个称呼：合并别名与空字段，不新增重复角色
      const aliasKeys = new Set((hit.aliases || []).map(keyOf));
      for (const a of [name, ...(Array.isArray(item.aliases) ? item.aliases : [])]) {
        if (a && keyOf(a) !== keyOf(hit.name) && !aliasKeys.has(keyOf(a))) {
          hit.aliases = [...(hit.aliases || []), a].slice(0, 6);
          aliasKeys.add(keyOf(a));
        }
      }
      for (const f of ['role', 'gender', 'age', 'personality', 'appearance', 'hair', 'costume', 'props', 'staticFeatures', 'dynamicFeatures', 'style', 'viewPrompt']) {
        if (!hit[f] && item[f]) hit[f] = item[f];
      }
      continue;
    }
    kept.push(item);
    for (const k of keys) if (!seen.has(k)) seen.set(k, item);
  }

  const compact = dropExtendedNames(kept);
  for (const c of kept) if (!compact.includes(c)) dropped.push(c.name);
  return { characters: compact.slice(0, max), dropped };
}
