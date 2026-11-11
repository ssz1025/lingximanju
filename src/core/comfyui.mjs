// ComfyUI 本地 API 客户端
// 设计目标：用户把 ComfyUI 里「导出(API)」得到的 workflow JSON 原样贴进来即可运行，
// 不要求改写节点图。参数注入有三层优先级：显式绑定 > {{占位符}} > 按图自动识别。
//
// 官方链路：POST /prompt → 轮询 /history/{prompt_id} → GET /view 下载产物
// 参考图：POST /upload/image（multipart）→ 把返回的 name 写进 LoadImage.image
import { writeAsset, uid } from './store.mjs';
import { placeholderFrame } from './raster.mjs';

const PLACEHOLDER_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;
const VIDEO_EXTS = /\.(mp4|webm|mov|mkv|m4v|gif)$/i;
const IMAGE_EXTS = /\.(png|jpe?g|webp|bmp)$/i;
// 音频产物（TTS / 音色抽卡工作流的输出）：抽卡结果必须是可播放的真实音频，否则不入候选池
const AUDIO_EXTS = /\.(mp3|wav|ogg|m4a|flac|aac|opus)$/i;
// 支持 seed / noise_seed / sampling_mode.seed 这类带命名空间的种子字段
const SEED_KEY_RE = /^(?:.*\.)?(seed|noise_seed|rand_seed)$/i;
// 音色工作流的说话人 / 语言字段：抽卡时按候选音色轮换注入，制造可辨的声线差异
const VOICE_KEY_RE = /^(voice|voice_name|speaker|speaker_id|speaker_name|timbre|voice_id)$/i;
const LANG_KEY_RE = /^(language|lang|locale)$/i;
const TTS_TEXT_KEY_RE = /^(text|content|prompt_text|tts_text)$/i;

/* ------------------------------------------------------------------ *
 * 提示词注入点识别
 *
 * 很多现代工作流（Krea2 / Qwen-Image / Flux 等）并不把提示词直接写在
 * CLIPTextEncode.text 上，而是走「PrimitiveStringMultiline → StringConcatenate
 * / TextGenerate 提示词润色 / Switch → CLIPTextEncode」这类连线链路。
 * 旧实现只认「CLIPTextEncode.text 是字符串」的节点，遇到连线型工作流就一个
 * 提示词都不注入：每个镜头都沿用工作流里写死的那句话，表现为「所有图片都
 * 是同一张」。这里沿图回溯，找出真正提供文本的源节点并写入本次镜头提示词。
 * ------------------------------------------------------------------ */
const TEXT_INPUT_KEYS = new Set([
  'text', 'value', 'prompt', 'string', 'string_a', 'string_b',
  'positive', 'negative', 'positive_prompt', 'negative_prompt',
  'text_positive', 'text_negative', 'text_g', 'text_l',
  'prompt_text', 'input_text', 'wildcard_text', 'string_value',
]);
const SYSTEM_TITLE_RE = /system|系统|template|模板|instruction|指令|规则/i;
const SYSTEM_VALUE_RE = /^\s*(you are\b|as an?\b.*(?:expert|assistant)|think step by step|follow these rules|你是|您是|你的任务是|请按以下规则)/i;
const NEGATIVE_RE = /negative|负面|反向|反提示|ngative/i;
const PROMPT_TITLE_RE = /prompt|提示词|正向|用户|user|positive|画面|描述|caption/i;
const TEXT_NODE_RE = /String|Multiline|CLIPTextEncode|TextBox|TextGenerate|Prompt|TextInput/i;

/**
 * 连线槽位判定：ComfyUI「导出(API)」里连线固定是 [节点id, 输出序号] 恰好两项，
 * 且第二项一定是数字。旧实现只判 length >= 2，会把多图数组（["a.png","b.png"]）
 * 误当成连线锁死，导致这类参数无法在可视化表格里编辑。
 */
const isLink = (v) => Array.isArray(v) && v.length === 2
  && (typeof v[0] === 'string' || typeof v[0] === 'number')
  && typeof v[1] === 'number';
const nodeTitle = (n) => String(n?._meta?.title || '');
const placeholderKeys = (str) => [...String(str).matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
const clip = (s, n = 90) => String(s ?? '').slice(0, n);

/** 从若干节点沿输入连线向上回溯，返回可达节点（含起点），自动防环 */
function upstreamNodes(wf, startIds) {
  const seen = new Set();
  const queue = [...startIds].map(String);
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id) || !wf[id]) continue;
    seen.add(id);
    for (const val of Object.values(wf[id].inputs || {})) {
      if (isLink(val)) queue.push(String(val[0]));
      else if (Array.isArray(val)) {
        for (const v of val) if (isLink(v)) queue.push(String(v[0]));
      }
    }
  }
  return seen;
}

/** 判定正 / 负向 CLIPTextEncode：优先按 KSampler.positive / negative 反查 */
function textChains(wf) {
  const clipNodes = Object.entries(wf)
    .filter(([id, n]) => !String(id).startsWith('_') && /CLIPTextEncode/i.test(n.class_type))
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const positiveClips = new Set();
  const negativeClips = new Set();
  for (const [id, n] of Object.entries(wf)) {
    if (String(id).startsWith('_')) continue;
    for (const role of ['positive', 'negative']) {
      const link = n.inputs?.[role];
      if (!isLink(link)) continue;
      const chain = upstreamNodes(wf, [String(link[0])]);
      for (const c of clipNodes) {
        if (!chain.has(c)) continue;
        (role === 'positive' ? positiveClips : negativeClips).add(c);
      }
    }
  }
  // 无采样器显式连线时沿用旧启发式：按节点 ID 排序，第一个正向、第二个负向
  if (!positiveClips.size && !negativeClips.size) {
    if (clipNodes[0]) positiveClips.add(clipNodes[0]);
    if (clipNodes[1]) negativeClips.add(clipNodes[1]);
  }
  // 同一个 CLIP 节点同时供正负向（如 ConditioningZeroOut）时不算独立负向链路，
  // 否则会把负向词写回正向提示词源节点。
  for (const c of [...negativeClips]) if (positiveClips.has(c)) negativeClips.delete(c);
  return { clipNodes, positiveClips, negativeClips };
}

/** 收集所有「字符串文本槽位」并按是否位于正/负向链路打分 */
function collectTextSlots(wf, chains) {
  const positiveReach = upstreamNodes(wf, [...chains.positiveClips]);
  const negativeReach = upstreamNodes(wf, [...chains.negativeClips]);
  const slots = [];
  for (const [id, n] of Object.entries(wf)) {
    if (String(id).startsWith('_')) continue;
    const cls = String(n.class_type || '');
    const title = nodeTitle(n);
    for (const [key, val] of Object.entries(n.inputs || {})) {
      if (!TEXT_INPUT_KEYS.has(key) || typeof val !== 'string') continue;
      const system = SYSTEM_TITLE_RE.test(title) || SYSTEM_VALUE_RE.test(val);
      const negative = NEGATIVE_RE.test(`${title} ${key}`);
      let base = 0;
      if (system) base -= 10000;                                  // 系统提示词 / 模板绝不覆盖
      if (negative) base -= 300;
      if (/CLIPTextEncode/i.test(cls) && key === 'text') base += 250;
      if (PROMPT_TITLE_RE.test(title)) base += 100;
      if (TEXT_NODE_RE.test(cls)) base += 60;
      if (/Concatenate|Switch|Preview|Selector/i.test(cls)) base -= 40;
      if (/^string_[ab]$/.test(key)) base -= 30;
      if (/trigger|lora|风格触发/i.test(title)) base -= 60;
      if (val.length > 40) base += 20;
      if (placeholderKeys(val).length) base -= 5;
      slots.push({
        node: id, input: key, classType: cls, title, value: val, base,
        system, negative,
        inPositive: positiveReach.has(id), inNegative: negativeReach.has(id),
      });
    }
  }
  return { slots, positiveReach, negativeReach };
}

function slotScore(s, role, hasClips) {
  let v = s.base;
  if (!hasClips) return v;
  if (role === 'positive') {
    v += s.inPositive ? 300 : -300;
    if (s.inNegative && !s.inPositive) v -= 600;
    if (s.negative) v -= 400;
  } else {
    v += s.inNegative ? 300 : -300;
    if (s.negative) v += 400;
    if (s.inPositive && !s.inNegative) v -= 300;
  }
  return v;
}

export function parseWorkflow(input, label = 'workflow') {
  let wf = input;
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) throw new Error(`${label} 为空`);
    try { wf = JSON.parse(text); } catch { throw new Error(`${label} 不是合法 JSON`); }
  }
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) throw new Error(`${label} 必须是 JSON 对象`);
  if (Array.isArray(wf.nodes) || Array.isArray(wf.links)) {
    throw new Error('这是 ComfyUI 界面保存格式。请在 ComfyUI 工作流菜单选择「导出(API) / Export (API)」后再导入。');
  }
  const entries = Object.entries(wf).filter(([id]) => !String(id).startsWith('_'));
  if (!entries.length) throw new Error(`${label} 没有任何节点`);
  for (const [id, node] of entries) {
    if (!node || typeof node !== 'object' || typeof node.class_type !== 'string') {
      throw new Error(`节点 ${id} 缺少 class_type，请确认导出的是 API 格式`);
    }
    if (!node.inputs || typeof node.inputs !== 'object') {
      throw new Error(`节点 ${id} 缺少 inputs，请确认导出的是 API 格式`);
    }
  }
  // 丢弃 _comment 等说明字段，避免把非节点对象提交给 /prompt
  return Object.fromEntries(entries);
}

/** 扫描工作流，给出自动识别到的可注入位置（供设置页展示与自检） */
export function analyzeWorkflow(wf) {
  const found = [];
  const textNodes = [];
  for (const [id, node] of Object.entries(wf)) {
    if (String(id).startsWith('_')) continue;
    const push = (input, role) => found.push({ node: id, classType: node.class_type, input, role, value: node.inputs[input] });
    for (const key of Object.keys(node.inputs)) {
      const val = node.inputs[key];
      if (typeof val === 'string' && placeholderKeys(val).length) {
        push(key, `占位符 ${placeholderKeys(val).join(',')}`);
      }
      if (SEED_KEY_RE.test(key)) push(key, 'seed');
      if (/^(width|height)$/i.test(key) && Number.isFinite(Number(val))) push(key, key.toLowerCase());
      if (/^(num_frames|frame_count|length|total_frames)$/i.test(key) && Number.isFinite(Number(val))) push(key, 'frames');
      if (/^fps$/i.test(key)) push(key, 'fps');
      if (/^filename_prefix$/i.test(key)) push(key, 'outputPrefix');
      if (/^(steps|cfg)$/i.test(key) && Number.isFinite(Number(val))) push(key, key.toLowerCase());
    }
    if (/CLIPTextEncode/i.test(node.class_type) && typeof node.inputs.text === 'string') {
      textNodes.push({ node: id, text: node.inputs.text });
    }
    if (/^(LoadImage|LoadImageMask)$/i.test(node.class_type)) push('image', 'loadImage');
    if (/^(SaveImage|SaveAnimatedWEBP|SaveAnimatedPNG|VHS_VideoCombine|SaveVideo|PreviewImage)$/i.test(node.class_type)) {
      push('_output', 'outputNode');
    }
  }
  textNodes.sort((a, b) => String(a.node).localeCompare(String(b.node), 'en', { numeric: true }));
  textNodes.forEach((t, i) => found.push({
    node: t.node, classType: 'CLIPTextEncode', input: 'text',
    role: i === 0 ? 'positive' : i === 1 ? 'negative' : 'text', value: t.text,
  }));

  // 连线型工作流的文本源节点也要展示出来，否则用户在设置页看不到提示词到底写在哪
  const chains = textChains(wf);
  const { slots } = collectTextSlots(wf, chains);
  const seen = new Set(found.map((f) => `${f.node}::${f.input}`));
  for (const s of slots) {
    const id = `${s.node}::${s.input}`;
    if (seen.has(id)) continue;
    seen.add(id);
    found.push({
      node: s.node, classType: s.classType, input: s.input, value: s.value,
      title: s.title, score: s.base,
      role: s.system ? 'systemPrompt（不会覆盖）'
        : s.negative ? 'negative'
          : s.inPositive ? 'positive' : 'text',
    });
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * 接口输入参数 schema
 *
 * 导入一份「导出(API)」工作流后，把它需要填写的输入全量摊平成可视化清单：
 * 每个节点输入一行，带类型 / 当前值 / 推断角色 / 建议绑定的内置变量。
 * 与 analyzeWorkflow 的区别：后者只列自动识别到的注入点（给自检用），
 * 这里列全部输入（含连线槽位），供设置页决定每个输入的取值来源：
 * 内置变量 / 固定值 / 由 Agent 生成 / 不注入（保持工作流原值）。
 * ------------------------------------------------------------------ */

/** 内置变量：键可写进工作流字符串输入 {{key}}，也是设置页「内置变量」下拉的候选 */
export const BUILTIN_INPUT_VARS = [
  { key: 'prompt', label: '画面提示词 {{prompt}}' },
  { key: 'negative_prompt', label: '负向提示词 {{negative_prompt}}' },
  { key: 'seed', label: '随机种子 {{seed}}' },
  { key: 'width', label: '宽 {{width}}' },
  { key: 'height', label: '高 {{height}}' },
  { key: 'steps', label: '采样步数 {{steps}}' },
  { key: 'cfg', label: 'CFG {{cfg}}' },
  { key: 'fps', label: '帧率 {{fps}}' },
  { key: 'frames', label: '帧数 {{frames}}' },
  { key: 'duration', label: '时长 {{duration}}' },
  { key: 'filename_prefix', label: '产物前缀 {{filename_prefix}}' },
  { key: 'model', label: '模型名 {{model}}' },
  { key: 'image', label: '参考图 {{image}}' },
  { key: 'title', label: '标题 {{title}}' },
  { key: 'shot_no', label: '镜头号 {{shot_no}}' },
  { key: 'motion', label: '运镜 {{motion}}' },
  { key: 'voice', label: '说话人 {{voice}}' },
  { key: 'language', label: '语言 {{language}}' },
  { key: 'audioText', label: '朗读文案 {{audioText}}' },
];

/** 合法占位符键：内置变量 + 档案 extra 自定义键共用这一口径 */
export const isBuiltinVarKey = (k) => /^[A-Za-z][\w.-]{0,40}$/.test(String(k || ''));

/** 由输入名 / 角色 / 当前值推断该输入建议绑定的内置变量 */
function suggestedVar(node, key, val, role) {
  const keys = typeof val === 'string' ? placeholderKeys(val) : [];
  if (keys.length) return keys[0];
  if (/systemPrompt/i.test(role)) return '';
  if (/^positive/i.test(role)) return 'prompt';
  if (/^negative/i.test(role) || /negative/i.test(key)) return 'negative_prompt';
  if (SEED_KEY_RE.test(key) || role === 'seed') return 'seed';
  if (key === 'width' || role === 'width') return 'width';
  if (key === 'height' || role === 'height') return 'height';
  if (/^(steps|cfg)$/i.test(key) || role === 'steps' || role === 'cfg') return key.toLowerCase();
  if (key === 'fps' || role === 'fps') return 'fps';
  if (/^(num_frames|frame_count|length|total_frames)$/i.test(key) || role === 'frames') return 'frames';
  if (key === 'filename_prefix' || role === 'outputPrefix') return 'filename_prefix';
  if (/^(ckpt_name|model_name|model|unet_name|vae_name|clip_name|lora_name|checkpoint)$/i.test(key)) return 'model';
  if (/^LoadImage/i.test(node.class_type) && key === 'image') return 'image';
  if (VOICE_KEY_RE.test(key)) return 'voice';
  if (LANG_KEY_RE.test(key)) return 'language';
  if (TTS_TEXT_KEY_RE.test(key) && /TTS|Audio|Voice|Speech/i.test(node.class_type)) return 'audioText';
  return '';
}

/* ------------------------------------------------------------------ *
 * 参数表控件分类
 *
 * 参数表只展示「需要人来填」的槽位，并按类型匹配输入方式：
 * 文本框 / 数字 / 是-否 / 多值，以及图片·视频·音频对应的「上传 / 从资源库选择」。
 * 分类只用于前端渲染，不改 inputSchema 行结构（value 仍是字符串），
 * 因此 compileInputSchema → nodeOverrides → injectWorkflow 链路不受影响。
 * ------------------------------------------------------------------ */

/** 媒体输入：ComfyUI 里这些节点类型的文件名槽位可以直接上传素材 */
const MEDIA_NODE_RE = {
  image: /^(LoadImage|LoadImageMask|LoadImageSet|VHS_LoadImagePath)$/i,
  video: /^(VHS_LoadVideo|VHS_LoadVideoPath|LoadVideo|LoadVideoPath|LoadVideoUpload|VHS_LoadVideoUpload)$/i,
  audio: /^(LoadAudio|VHS_LoadAudio|LoadAudioUpload|LoadAudioPath)$/i,
};
/** 输入名兜底：节点名不认识时按槽位名猜（audio / video / image 这类很常见） */
const MEDIA_KEY_RE = {
  image: /^(image|images|image_path|image_name|img|img_name|picture|photo|mask_image)$/i,
  video: /^(video|videos|video_path|video_name|movie|film)$/i,
  audio: /^(audio|audios|audio_path|audio_name|sound|sound_path|voice_file)$/i,
};
/** 媒体扩展名：权重文件（.safetensors / .ckpt / .pt）一律不按媒体处理 */
const MEDIA_EXT_RE = {
  image: /\.(png|jpg|jpeg|webp|bmp|gif|tif|tiff)$/i,
  video: /\.(mp4|webm|mov|mkv|m4v|avi)$/i,
  audio: /\.(mp3|wav|ogg|m4a|flac|aac|opus)$/i,
};

/**
 * 判定该输入是否为「可上传的媒体槽位」。
 * 先看节点类型（最准），再看输入名，最后看当前值的扩展名；都命中不了返回 ''。
 * 数组型多素材只要元素全是同一类媒体，就按该类处理。
 */
function mediaKindOf(node, key, val) {
  const cls = String(node?.class_type || '');
  let kind = '';
  // 1) 节点类型最准：LoadImage → image、VHS_LoadVideo → video、LoadAudio → audio
  for (const [k, re] of Object.entries(MEDIA_NODE_RE)) {
    if (re.test(cls)) { kind = k; break; }
  }
  // 2) 输入名细分：视频节点常同时收音频槽位，同大类时不覆盖，冲突时以节点类型为准
  for (const [k, re] of Object.entries(MEDIA_KEY_RE)) {
    if (!re.test(String(key))) continue;
    if (!kind) kind = k;
    break;
  }
  if (kind) return kind;
  // 3) 扩展名兜底：既没有已知节点类型也没有已知输入名时，看当前值像什么文件
  const probe = Array.isArray(val) ? val.find((x) => typeof x === 'string') : val;
  if (typeof probe === 'string') {
    for (const [k, re] of Object.entries(MEDIA_EXT_RE)) if (re.test(probe)) return k;
  }
  return '';
}

/** 长文本判定：提示词 / 换行 / 超过 80 字，用多行输入框更好写 */
function isLongText(node, key, val) {
  if (typeof val !== 'string') return false;
  if (/CLIPTextEncode/i.test(node?.class_type || '') && /^text$/.test(String(key))) return true;
  if (val.includes('\n')) return true;
  return val.length > 80;
}

/**
 * 「常用参数」判定：参数表默认只展示需要用户输入的项，其余技术参数收进「显示全部」。
 * 常用 = 媒体素材（图片/视频/音频）、提示词（positive / negative / {{prompt}} 占位符 /
 * 无法归链的多行文本）、宽高尺寸、随机种子（固定种子可复现画面）。
 * 返回 '' 表示非常用 —— 默认不展示、不落盘（保持「自动识别」，工作流原值生效）。
 */
function commonTagOf(role, key, val, media, multiline, type) {
  if (media) return 'media';
  const r = String(role || '');
  // 系统提示词模板（工作流内部的 LLM 专家指令等）：默认不展示，需改时点「显示全部」
  if (/systemPrompt/.test(r)) return '';
  if (/^(positive|negative)/.test(r)) return 'prompt';
  // {{prompt}} 占位符：确切命中「占位符 prompt」，避免 prompt_json 之类误命中
  if (/^占位符 prompt(,|$)/.test(r)) return 'prompt';
  // 角色归不上链但确实是多行文本的槽位（串联节点里的用户提示词等）
  if (r === 'text' && multiline) return 'prompt';
  if (/^(width|height|aspect|ratio)/i.test(String(key)) && type === 'number') return 'size';
  if (r === 'seed' || SEED_KEY_RE.test(String(key))) return 'seed';
  return '';
}

function inputValueText(v) {
  if (isLink(v)) return `[连线 → 节点 ${v[0]}]`;
  // 多图 / 多素材数组：列出内容，让用户在表格里直接看到每张参考图
  if (Array.isArray(v)) return `[数组 ${v.length} 项] ${clip(v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('、'), 120)}`;
  if (v && typeof v === 'object') return clip(JSON.stringify(v), 120);
  if (typeof v === 'string') return clip(v, 160);
  return String(v);
}

/** 全量扫描工作流输入，返回可视化清单（不含 _ 开头的说明节点） */
export function describeInterfaceInputs(wf) {
  const analyzed = analyzeWorkflow(wf || {});
  const roleBySlot = new Map();
  for (const f of analyzed) {
    const k = `${f.node}::${f.input}`;
    if (!roleBySlot.has(k)) roleBySlot.set(k, f.role || '');
  }
  const out = [];
  for (const [id, node] of Object.entries(wf || {})) {
    if (String(id).startsWith('_') || !node || !node.inputs) continue;
    for (const [key, val] of Object.entries(node.inputs)) {
      const linked = isLink(val);
      // 数组但不是连线 = 多值参数（多图 / 多参考素材），必须可编辑；
      // 用固定值时按 JSON 数组文本保存。
      const isArr = !linked && Array.isArray(val);
      const role = roleBySlot.get(`${id}::${key}`) || '';
      const media = linked ? '' : mediaKindOf(node, key, val);
      const multiline = !linked && !media && isLongText(node, key, val);
      const type = linked ? 'link' : isArr ? 'array' : typeof val === 'number' ? 'number'
        : typeof val === 'boolean' ? 'boolean' : typeof val === 'string' ? 'text' : 'other';
      out.push({
        node: id,
        classType: String(node.class_type || ''),
        nodeTitle: nodeTitle(node),
        input: key,
        type,
        value: linked ? undefined : val,
        valueText: inputValueText(val),
        hasPlaceholder: typeof val === 'string' && placeholderKeys(val).length > 0,
        role,
        suggestedVar: linked ? '' : suggestedVar(node, key, val, role),
        lockable: !linked,
        multiple: isArr,
        // 参数表只渲染需要人填的槽位：连线由工作流内部驱动，不展示也不可配
        editable: !linked,
        // 常用参数归类（media / prompt / seed / size / ''）：前端默认只展示常用项
        common: commonTagOf(role, key, val, media, multiline, type),
        // 媒体槽位（image / video / audio）在表格里给「上传 / 从资源库选择」
        media,
        // 长文本用多行输入框：提示词、带换行的值、超长字符串
        multiline,
      });
    }
  }
  return out;
}

/**
 * 解析「参数 Agent」的回复 → 只保留 schema 里标为 agent 的槽位。
 * 兼容 {params:[…]} / {values:[…]} / 数组 / {"节点::输入": 值} 四种形态，
 * 缺失字段用档案里的兜底值；纯函数，便于离线回归。
 */
export function parseAgentParamReply(reply, plan = []) {
  let obj = reply;
  if (typeof reply === 'string') {
    try { obj = JSON.parse(reply.replace(/```(?:json)?/gi, '').trim()); } catch { obj = null; }
  }
  const rows = Array.isArray(obj) ? obj
    : Array.isArray(obj?.params) ? obj.params
      : Array.isArray(obj?.values) ? obj.values : null;
  const bySlot = new Map();
  if (rows) {
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const node = String(r.node ?? '').trim();
      const input = String(r.input ?? '').trim();
      if (!node || !input) continue;
      const v = r.value ?? r.val;
      if (v === undefined || v === null || typeof v === 'object') continue;
      bySlot.set(`${node}::${input}`, v);
    }
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (!k.includes('::') || v === undefined || v === null || typeof v === 'object') continue;
      const [node, input] = k.split('::');
      if (node && input) bySlot.set(k, v);
    }
  }
  return (Array.isArray(plan) ? plan : []).map((p) => {
    const key = `${p.node}::${p.input}`;
    const value = bySlot.has(key) ? bySlot.get(key) : p.fallback;
    return value === undefined || value === null || typeof value === 'object'
      ? null : { node: p.node, input: p.input, value };
  }).filter(Boolean);
}

/**
 * 种子生成。
 * 传纯数字（或数字字符串）时原样使用 —— 这是「复现同一段音频 / 同一张图」的唯一途径：
 * 音色抽卡把真实注入的 seed 记进 draw.seed，用户想再跑一遍时把它传回来即可。
 * 其它情况（没传 / 传的是 project-shot 这类字符串锚点）仍需每次随机，
 * 否则同一镜头反复重跑会拿到完全相同的产物，抽卡也就抽不出任何差异。
 */
function seedValue(seedText = '') {
  const asNum = Number(seedText);
  if (String(seedText).trim() !== '' && Number.isFinite(asNum) && asNum >= 0) {
    return Math.trunc(asNum) % 4294967295;
  }
  let h = 2166136261;
  const s = `${seedText}|${Date.now()}|${Math.random()}`;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 4294967295;
}

function resolveVars(vars) {
  const cfg = vars.cfg || {};
  const prompt = String(vars.prompt ?? '');
  // 接口档案自带的自定义占位符：{{model}} {{lora}} 等由档案参数 extra 提供，
  // 键名白名单在 comfy-config.normalizeInterfaceParams 里已经过滤过一次。
  const extraValues = (cfg.extraValues && typeof cfg.extraValues === 'object'
    && !Array.isArray(cfg.extraValues)) ? cfg.extraValues : {};
  const negativePrompt = String(vars.negative ?? cfg.negativePrompt ?? '');
  const seed = seedValue(String(vars.seed ?? ''));
  // prompt_json：JSON 字符串内部安全形态（转义引号/换行），供 timeline_data 这类 JSON 字符串字段使用
  const jsonInner = (s) => JSON.stringify(s).slice(1, -1);
  const prefix = String(vars.filenamePrefix || cfg.filenamePrefix || 'lingximanju');
  const values = {
    prompt,
    prompt_json: jsonInner(prompt),
    negative_prompt: negativePrompt,
    negative_json: jsonInner(negativePrompt),
    seed,
    width: Number(cfg.width) || 864,
    height: Number(cfg.height) || 480,
    fps: Number(cfg.fps) || 24,
    frames: Number(vars.frames || cfg.frames) || 124,
    // duration 未显式给出时由 frames/fps 推导，保证 timeline 时长与帧数自洽
    duration: Number(vars.duration) || Math.round((Number(vars.frames || cfg.frames) / (Number(cfg.fps) || 24)) * 100) / 100 || 5,
    steps: Number(cfg.steps) || 25,
    cfg: Number(cfg.cfg) || 1.0,
    // 每次运行用唯一前缀，避免自定义输出节点复用同名文件导致拿到上一次的图
    filename_prefix: `${prefix}_${seed}`,
    image: String(vars.imageName || 'lingximanju_reference.png'),
    title: String(vars.title || ''),
    shot_no: String(vars.shotNo || ''),
    motion: String(vars.motion || ''),
    // 音色抽卡：voice 是工作流里的说话人枚举值（如 MiniMax 的 male-qn-qingse），
    // language 是语言代码；两者为空时不注入，避免污染出图 / 出视频工作流。
    voice: String(vars.voice ?? ''),
    language: String(vars.language ?? ''),
    // 抽卡朗读文案：只在值为字符串、且确实存在该字段时注入（见 injectWorkflow 的 ttsText 分支）
    audioText: vars.audioText === undefined ? undefined : String(vars.audioText),
  };
  // 档案自定义占位符（优先级最低，不覆盖内置键）；{{model}} 也可由档案 params.model 直接给出
  for (const [k, v] of Object.entries(extraValues)) {
    if (!/^[A-Za-z][\w.-]{0,40}$/.test(k) || k in values) continue;
    values[k] = String(v);
  }
  if (cfg.model !== undefined && cfg.model !== null && cfg.model !== '') values.model = String(cfg.model);
  return values;
}

/**
 * 归一化参考图入参：imageRefs 数组（多图，逐 LoadImage 插槽对应）
 * 或 imageBuffer/imageName（单图，向后兼容，应用到全部插槽）。最多取 8 张。
 */
function normalizeRefs(vars = {}) {
  const list = Array.isArray(vars.imageRefs) ? vars.imageRefs : [];
  const out = list
    .filter((r) => r && r.buffer)
    .map((r) => ({ buffer: r.buffer, name: String(r.name || 'reference.png') }));
  if (!out.length && vars.imageBuffer) {
    out.push({ buffer: vars.imageBuffer, name: String(vars.imageName || 'reference.png') });
  }
  return out.slice(0, 8);
}

/**
 * 把变量注入 workflow。返回 { prompt, applied, uploadSlots, outputNodes, values, promptInjection }
 * 不修改传入的 workflow 对象。
 */
export function injectWorkflow(workflow, vars = {}, bindings = [], overrides = null) {
  const wf = JSON.parse(JSON.stringify(workflow));
  const values = resolveVars(vars);
  const applied = [];
  const uploadSlots = [];
  const outputNodes = [];
  const touched = new Set(); // 已被占位符/显式绑定/节点覆盖处理过的 node::input
  const plan = { positive: null, negative: null, warnings: [] };
  // 接口档案的节点级覆盖：没显式传时从 vars.cfg（即 resolveInterface 返回的 config）读取，
  // 这样 describeWorkflow / drawVoiceCandidates 等所有调用点无需改签名也能生效。
  const nodeOverrides = Array.isArray(overrides) ? overrides
    : (Array.isArray(vars.cfg?.nodeOverrides) ? vars.cfg.nodeOverrides : []);

  const replace = (str) => String(str).replace(PLACEHOLDER_RE, (_, key) => {
    const val = values[key];
    return val === undefined ? `{{${key}}}` : String(val);
  });
  const slotInfo = (node, input, strategy, text) => ({
    node: String(node), input: String(input),
    classType: wf[node]?.class_type || '', title: nodeTitle(wf[node]),
    strategy, preview: clip(text),
  });

  // -1) 接口档案的节点级覆盖（模型名 / LoRA / 采样器 / 自定义槽位）。
  //     值里可以写 {{prompt}} / {{model}} 等占位符；标记 touched 防止自动识别再次改写。
  //     显式绑定仍在第 4 步最后落盘，同一槽位冲突时以用户的显式绑定为准。
  for (const o of nodeOverrides) {
    const id = String(o?.node ?? '').trim();
    const key = String(o?.input ?? '').trim();
    if (!id || !key || !wf[id]) continue;
    const value = typeof o.value === 'string' ? replace(o.value) : o.value;
    wf[id].inputs[key] = value;
    applied.push({ node: id, input: key, value, by: 'interface:nodeOverride' });
    touched.add(`${id}::${key}`);
  }

  // 0) 显式绑定优先级最高：绑定里写了 {{prompt}} 就认定用户已指定注入位置，不再自动注入
  for (const b of bindings || []) {
    const keys = placeholderKeys(b.value);
    const id = String(b.node ?? '').trim();
    const key = String(b.input ?? '').trim();
    if (!id || !key || !wf[id]) continue;
    if (keys.includes('prompt')) plan.positive = slotInfo(id, key, 'binding', values.prompt);
    if (keys.some((k) => /^negative/.test(k))) plan.negative = slotInfo(id, key, 'binding', values.negative_prompt);
  }

  // 1) 占位符：任何字符串输入都支持
  for (const [id, node] of Object.entries(wf)) {
    if (String(id).startsWith('_')) continue;
    for (const [key, val] of Object.entries(node.inputs)) {
      if (typeof val !== 'string') continue;
      const keys = placeholderKeys(val);
      if (!keys.length) continue;
      const next = replace(val);
      if (next !== val) {
        node.inputs[key] = next;
        applied.push({ node: id, input: key, value: next, by: 'placeholder' });
        touched.add(`${id}::${key}`);
        if (keys.includes('prompt') && !plan.positive) plan.positive = slotInfo(id, key, 'placeholder', values.prompt);
        if (keys.some((k) => /^negative/.test(k)) && !plan.negative) {
          plan.negative = slotInfo(id, key, 'placeholder', values.negative_prompt);
        }
      }
    }
  }

  // 2) 自动识别：只处理未被占位符覆盖的字段
  const auto = (id, node, key, value, role) => {
    if (touched.has(`${id}::${key}`) || value === undefined) return;
    if (!(key in node.inputs)) return;
    node.inputs[key] = value;
    applied.push({ node: id, input: key, value, by: `auto:${role}` });
    touched.add(`${id}::${key}`);
  };

  for (const [id, node] of Object.entries(wf)) {
    if (String(id).startsWith('_')) continue;
    for (const [key, val] of Object.entries(node.inputs)) {
      if (touched.has(`${id}::${key}`)) continue;
      if (SEED_KEY_RE.test(key)) auto(id, node, key, values.seed, 'seed');
      else if (key === 'width' && Number.isFinite(Number(val))) auto(id, node, key, values.width, 'width');
      else if (key === 'height' && Number.isFinite(Number(val))) auto(id, node, key, values.height, 'height');
      else if (/^(num_frames|frame_count|total_frames)$/i.test(key) && Number.isFinite(Number(val))) auto(id, node, key, values.frames, 'frames');
      else if (key === 'length' && /Video|Animate|WAN|H3|Frame/i.test(node.class_type) && Number.isFinite(Number(val))) auto(id, node, key, values.frames, 'frames');
      else if (key === 'fps' && Number.isFinite(Number(val))) auto(id, node, key, values.fps, 'fps');
      else if (key === 'filename_prefix') auto(id, node, key, values.filename_prefix, 'outputPrefix');
      // 音色抽卡工作流：说话人 / 语言只在显式传值时注入，
      // 出图与出视频工作流不收这两个变量，因此不会误改它们的输入。
      else if (VOICE_KEY_RE.test(key) && values.voice) auto(id, node, key, values.voice, 'voice');
      else if (LANG_KEY_RE.test(key) && values.language) auto(id, node, key, values.language, 'language');
      // 朗读文案不在这里处理：TTS 节点的 text 通常是连线（→ PrimitiveStringMultiline），
      // 直接覆盖会把上游节点断成孤儿，留到第 3 步沿连线写进真正的文本源。
    }
    if (/^(LoadImage|LoadImageMask)$/i.test(node.class_type)) {
      uploadSlots.push({ node: id, input: 'image' });
    }
    // 音频输出节点也要收：TTS 工作流只 SaveAudio / SaveAudioMP3，漏掉就会让
    // describeAudioWorkflow 误报「没有音频输出节点」，抽卡自检直接变成不可用。
    if (/^(SaveImage|SaveAnimatedWEBP|SaveAnimatedPNG|VHS_VideoCombine|SaveVideo|PreviewImage|SaveAudio|SaveAudioMP3|SaveAudioOpus|SaveAudioFlamingo|PreviewAudio)$/i.test(node.class_type)) {
      outputNodes.push({ node: id, classType: node.class_type });
    }
  }

  // 3) 提示词注入：沿图回溯找真正的文本源节点，保证每个镜头的提示词都能写进去
  const chains = textChains(wf);
  const analysis = collectTextSlots(wf, chains);
  const hasClips = chains.clipNodes.length > 0;

  const ranked = (role) => analysis.slots
    .filter((s) => !s.system
      && !touched.has(`${s.node}::${s.input}`)
      && (!hasClips || (role === 'positive' ? analysis.positiveReach : analysis.negativeReach).has(s.node))
      && (role === 'positive' ? !s.negative : true))
    .map((s) => ({ slot: s, score: slotScore(s, role, hasClips) }))
    .sort((a, b) => b.score - a.score);

  const injectRole = (role, text) => {
    if (plan[role] || !text) return;   // 已由绑定/占位符处理，或本次没有该提示词
    const list = ranked(role);
    const clips = [...(role === 'positive' ? chains.positiveClips : chains.negativeClips)];
    const targets = clips.length ? clips : [null];
    const chosen = [];
    const overrides = [];
    for (const c of targets) {
      const reach = c ? upstreamNodes(wf, [c]) : null;
      const hit = list.find(({ slot }) => !reach || reach.has(slot.node));
      if (hit) {
        const s = hit.slot;
        if (!chosen.some((x) => x.node === s.node && x.input === s.input)) chosen.push(s);
      } else if (c) {
        overrides.push(c);   // 该 CLIP 节点上游没有可写文本 → 直接把 text 从连线改成字面量
      }
    }
    for (const s of chosen) {
      auto(s.node, wf[s.node], s.input, text, role);
      const strategy = /CLIPTextEncode/i.test(s.classType) && s.input === 'text' ? 'clipText' : 'primitive';
      plan[role] = slotInfo(s.node, s.input, strategy, text);
    }
    for (const c of overrides) {
      if (!wf[c]) continue;
      wf[c].inputs.text = text;
      applied.push({ node: c, input: 'text', value: text, by: `auto:${role}:overrideLink` });
      touched.add(`${c}::text`);
      plan[role] = slotInfo(c, 'text', 'overrideLink', text);
    }
    if (role === 'positive' && !plan.positive) {
      plan.warnings.push('未找到提示词注入点：本次出图会沿用工作流里写死的提示词，所有镜头可能得到同一画面。请在提示词节点写 {{prompt}}，或用「提示词注入自检」查看后添加显式绑定。');
    }
    if (plan[role]?.strategy === 'overrideLink') {
      plan.warnings.push(`工作流没有可写入的文本源节点，已直接覆盖 ${plan[role].node}.text（会绕过工作流内的提示词润色链路）。`);
    }
  };

  injectRole('positive', values.prompt);
  injectRole('negative', values.negative_prompt);

  // 3.5) 朗读文案（音色抽卡）：TTS 节点的 text 常是连线，必须沿连线写到上游文本源，
  //      直接覆盖连线会让上游那个 PrimitiveStringMultiline 变成孤立节点，工作流跑起来
  //      仍旧念它自己写死的那句话 —— 表现为「抽了 4 次，4 段音频念的是同一句无关文案」。
  if (values.audioText !== undefined) {
    const writeTtsText = () => {
      for (const [id, node] of Object.entries(wf)) {
        if (String(id).startsWith('_')) continue;
        for (const [key, val] of Object.entries(node.inputs || {})) {
          if (!TTS_TEXT_KEY_RE.test(key)) continue;
          if (touched.has(`${id}::${key}`)) continue;
          if (typeof val === 'string') {
            // 字面量文案：直接覆盖，但不要误伤已经有内容的角色台词等字段以外的东西
            wf[id].inputs[key] = values.audioText;
            applied.push({ node: id, input: key, value: values.audioText, by: 'auto:ttsText' });
            touched.add(`${id}::${key}`);
            continue;
          }
          if (!isLink(val)) continue;
          // 连线：沿上游找到真正存放文案的字符串槽位，写进去
          const reach = upstreamNodes(wf, [String(val[0])]);
          const target = [...reach]
            .filter((nid) => wf[nid])
            .flatMap((nid) => Object.entries(wf[nid].inputs || {})
              .filter(([k, v]) => TEXT_INPUT_KEYS.has(k) && typeof v === 'string')
              .map(([k]) => ({ node: nid, input: k })))
            // 有多个候选时优先最上游那个（真正的文案源，而不是下游的拼接结果）
            .sort((a, b) => upstreamNodes(wf, [a.node]).size - upstreamNodes(wf, [b.node]).size)[0]
            || { node: String(val[0]), input: 'text' };
          if (!wf[target.node]) continue;
          wf[target.node].inputs[target.input] = values.audioText;
          applied.push({
            node: target.node, input: target.input, value: values.audioText,
            via: `${id}.${key}`, by: 'auto:ttsText',
          });
          touched.add(`${target.node}::${target.input}`);
        }
      }
    };
    writeTtsText();
  }

  // 4) 显式绑定最后落盘，确保覆盖自动注入
  for (const b of bindings || []) {
    const id = String(b.node ?? '').trim();
    const key = String(b.input ?? '').trim();
    if (!id || !key || !wf[id]) continue;
    wf[id].inputs[key] = replace(String(b.value ?? ''));
    applied.push({ node: id, input: key, value: wf[id].inputs[key], by: 'binding' });
  }
  if (!values.prompt) plan.warnings.push('本次调用没有传入提示词（prompt 为空），跳过正向提示词注入。');
  plan.ok = Boolean(plan.positive);

  return { prompt: wf, applied, uploadSlots, outputNodes, values, promptInjection: plan };
}

/**
 * 不连接 ComfyUI 的干跑自检：返回提示词会被写到哪个节点、用什么策略、以及告警。
 * 供 /api/comfyui/analyze 与设置页「提示词注入自检」使用。
 */
export function describeWorkflow(workflow, vars = {}, bindings = []) {
  const samplePrompt = String(vars.prompt || '【自检示例】雨夜霓虹街头，少女撑伞回望，电影感中景');
  const built = injectWorkflow(workflow, { ...vars, prompt: samplePrompt }, bindings);
  return {
    ok: Boolean(built.promptInjection.positive),
    positive: built.promptInjection.positive,
    negative: built.promptInjection.negative,
    warnings: built.promptInjection.warnings,
    samplePrompt,
    applied: built.applied.filter((a) => /positive|negative|placeholder|binding/.test(a.by)),
  };
}

/**
 * 音色抽卡工作流的不连接自检：返回朗读文案 / 说话人 / 语言实际写到了哪个节点，
 * 以及能识别到的音频输出节点。图片注入自检那一套（正向 / 负向提示词）对 TTS 工作流无意义，
 * 这里单独给一份语义正确的计划，避免设置页把「未找到提示词注入点」误报成工作流有问题。
 */
export function describeAudioWorkflow(workflow, vars = {}, bindings = []) {
  const sampleText = String(vars.audioText || '这是一段音色试听，用来判断声线是否适合这个角色。');
  const built = injectWorkflow(workflow, { ...vars, prompt: '', audioText: sampleText }, bindings);
  const pick = (...bys) => built.applied.find((a) => bys.includes(a.by)) || null;
  const text = pick('auto:ttsText', 'auto:positive', 'placeholder', 'binding', 'auto:positive:overrideLink');
  const voice = pick('auto:voice', 'auto:language');
  const seed = built.applied.find((a) => a.by === 'auto:seed') || null;
  const audioNodes = built.outputNodes.filter((n) => /Audio|TTS|Voice|Sound|Music/i.test(n.classType));
  const warnings = built.promptInjection.warnings.filter((w) => !/提示词/.test(w));
  if (!audioNodes.length) {
    warnings.push('工作流里没有 SaveAudio / SaveAudioMP3 一类音频输出节点，抽卡拿不到可播放的音频。');
  }
  if (!built.applied.some((a) => a.by === 'auto:voice')) {
    // 没有说话人字段时，多次抽卡的差异只能靠随机源。TTS 工作流常常既没有 voice
    // 也没有 seed：此时跑 4 次会得到 4 段几乎一样的音频，必须提前说清楚，
    // 否则用户会以为「抽卡坏了」。
    warnings.push(seed
      ? `没找到说话人字段（voice / speaker / voice_id），抽卡会退化为同一音色多次采样：差异来自 seed（${seed.node}.${seed.input}）。`
      : '既没有说话人字段（voice / speaker / voice_id）也没有 seed 字段：多次抽卡很可能得到几乎相同的音频，建议在工作流里加一个 voice 或 seed 输入。');
  }
  return {
    ok: Boolean(text && audioNodes.length),
    name: vars.name || '',
    nodes: Object.keys(workflow || {}).length,
    sampleText,
    text: text ? { node: text.node, input: text.input, strategy: text.by, preview: String(text.value) } : null,
    voice: voice ? { node: voice.node, input: voice.input, strategy: voice.by, value: voice.value } : null,
    seed: seed ? { node: seed.node, input: seed.input, value: seed.value } : null,
    audioNodes,
    warnings,
  };
}

/**
 * 音色抽卡执行：同一份 TTS 工作流跑 N 次，每次换 seed（必要时换说话人），
 * 返回可进候选池的音频列表（只保留真实音频产物，图片 / 波形图不算抽卡结果）。
 * @param {object} config    ComfyUI 全局配置
 * @param {object} workflow  音频工作流（API 格式）
 * @param {object} o         {count, text, voiceValues[], language, bindings, signal, log, filenamePrefix}
 * @returns {Promise<{draws:Array<{url,file,bytes,seed,voiceValue}>, failures:Array, workflowName:string}>}
 */
export async function drawVoiceCandidates(config, workflow, o = {}) {
  // 显式判断而不是 `Number(o.count) || 4`：后者会把用户传的 0 静默变成 4 次，
  // 用户以为「抽 0 次」却真跑了 4 次队列。未传时默认 4（产品默认张数），
  // 传了非法/非正值一律按 1 次，绝不悄悄放大次数。
  const given = o.count === undefined || o.count === null || o.count === '';
  const rawCount = given ? 4 : Math.floor(Number(o.count));
  const count = Number.isFinite(rawCount)
    ? (rawCount > 0 ? Math.min(8, rawCount) : 1)
    : 1;
  const text = String(o.text || '这是一段音色试听，用来判断声线是否适合这个角色。');
  const voiceValues = Array.isArray(o.voiceValues) ? o.voiceValues.filter(Boolean) : [];
  const language = String(o.language || '');
  const log = o.log || (() => {});
  const draws = [];
  const failures = [];
  for (let i = 0; i < count; i += 1) {
    if (o.signal?.aborted) break;
    // 说话人槽位：给了候选列表就轮换（抽到不同音色），只给一个就靠 seed 采样差异
    const voiceValue = voiceValues.length ? voiceValues[i % voiceValues.length] : '';
    // 直接生成一个数字种子（而不是字符串锚点）：这样「本次注入的 seed」是确定的，
    // 记录下来后用户能把同一段音频原样跑回来；字符串锚点会被 seedValue 混入时间戳。
    const seedNum = (Math.trunc(Date.now() / 1000) * 1000 + i * 7 + Math.trunc(Math.random() * 1000)) % 4294967295;
    try {
      const r = await runWorkflow(config, workflow, {
        prompt: '',
        audioText: text,
        voice: voiceValue,
        language,
        filenamePrefix: o.filenamePrefix || 'lingximanju_voice',
        cfg: config,
        seed: seedNum,
      }, { bindings: o.bindings || [], signal: o.signal, log });
      const audio = r.assets.filter((a) => a.kind === 'audio');
      if (!audio.length) {
        failures.push({ index: i, error: '工作流跑完但没有音频产物（检查是否有 SaveAudio 类输出节点）' });
        continue;
      }
      for (const a of audio) {
        draws.push({
          url: a.url, file: a.file, bytes: a.bytes,
          seed: seedNum,   // 与真正注入工作流的种子完全一致，可据此复现同一段音频
          voiceValue,
          promptId: r.promptId,
          durationMs: r.durationMs,
        });
      }
      log('info', `抽卡 ${i + 1}/${count} · ${audio.length} 段音频${voiceValue ? ` · 说话人 ${voiceValue}` : ''}`);
    } catch (err) {
      failures.push({ index: i, error: err.message });
      log('warn', `抽卡 ${i + 1}/${count} 失败：${err.message}`);
    }
  }
  return { draws, failures, workflowName: o.workflowName || '' };
}

async function requestJSON(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const detail = body?.error || text.slice(0, 300) || `HTTP ${res.status}`;
    const nodeErrors = body?.node_errors
      ? `；节点错误：${JSON.stringify(body.node_errors).slice(0, 600)}` : '';
    throw new Error(`${detail}${nodeErrors}`);
  }
  return body;
}

export async function testConnection(baseUrl, signal) {
  const base = String(baseUrl).replace(/\/+$/, '');
  try {
    const stats = await requestJSON(`${base}/system_stats`, { signal });
    return {
      ok: true, baseUrl: base,
      version: stats?.system?.comfyui_version || stats?.system?.python_version || 'unknown',
      device: stats?.devices?.[0]?.name || 'unknown',
      vram: stats?.devices?.[0]?.vram_total || null,
    };
  } catch (primary) {
    // 老版本没有 /system_stats，降级探测根路由
    try {
      const res = await fetch(base, { signal });
      if (res.ok) return { ok: true, baseUrl: base, version: 'legacy', device: 'unknown', note: '未暴露 /system_stats' };
    } catch { /* ignore */ }
    throw new Error(`无法连接 ${base}：${primary.message}`);
  }
}

/** 按扩展名给 multipart 的 Content-Type：视频 / 音频也走 /upload/image（该端点通吃文件上传） */
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  bmp: 'image/bmp', gif: 'image/gif', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', m4v: 'video/x-m4v',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/opus',
};
const mimeOf = (name, fallback = 'image/png') => {
  const ext = String(name).toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1];
  return MIME_BY_EXT[ext] || fallback;
};

/**
 * 通用文件上传：POST /upload/image（multipart 手写，无第三方依赖）。
 * 参数表里的图片 / 视频 / 音频槽位都共用这一个函数，Content-Type 按扩展名给，
 * 否则 ComfyUI 会按 PNG 收下 mp4 / mp3 导致节点读不出文件。
 */
export async function uploadFile(config, buffer, filename = 'reference.png', signal) {
  const base = config.baseUrl;
  const boundary = `----lingximanju${Date.now().toString(36)}`;
  const safeName = String(filename).replace(/[^A-Za-z0-9_.-]/g, '_');
  const mime = mimeOf(safeName);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${safeName}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`, 'utf8');
  const tail = Buffer.from(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n` +
    `--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([head, Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer)), tail]);
  const res = await fetch(`${base}/upload/image`, {
    method: 'POST', signal,
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`文件上传失败：${text.slice(0, 200)}`);
  let out = {};
  try { out = JSON.parse(text); } catch { /* 有些版本返回纯文本 */ }
  return { name: out.name || safeName, subfolder: out.subfolder || '', type: out.type || 'input' };
}

/** POST /upload/image（图片专用薄封装，保持既有调用方与日志文案不变） */
export async function uploadImage(config, buffer, filename = 'reference.png', signal) {
  try {
    return await uploadFile(config, buffer, filename, signal);
  } catch (err) {
    throw new Error(String(err.message).replace(/^文件上传失败/, '参考图上传失败'));
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('已取消', 'AbortError')); }, { once: true });
});

/** 从 history outputs 中提取所有可下载文件 */
function collectOutputs(history) {
  const files = [];
  for (const [nodeId, out] of Object.entries(history?.outputs || {})) {
    for (const key of ['images', 'gifs', 'videos', 'audio', 'files']) {
      for (const item of out?.[key] || []) {
        if (!item || typeof item !== 'object') continue;
        const filename = item.filename || item.name;
        if (!filename) continue;
        files.push({
          nodeId, key, filename,
          subfolder: item.subfolder || '',
          type: item.type || 'output',
        });
      }
    }
  }
  return files;
}

async function downloadOutput(config, file, signal) {
  const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
  const res = await fetch(`${config.baseUrl}/view?${q}`, { signal });
  if (!res.ok) throw new Error(`下载产物失败 ${file.filename}：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (file.filename.match(/\.[A-Za-z0-9]{1,6}$/) || ['.png'])[0].toLowerCase();
  const kind = VIDEO_EXTS.test(file.filename) ? 'video'
    : IMAGE_EXTS.test(file.filename) ? 'image'
      : AUDIO_EXTS.test(file.filename) ? 'audio' : 'file';
  const name = `${uid('comfy')}${ext}`;
  const url = writeAsset(name, buf);
  return { url, file: name, filename: file.filename, kind, nodeId: file.nodeId, bytes: buf.length };
}

/**
 * 一次读回 ComfyUI 的「队列 + 历史」快照。
 * 对账只需要这两个接口：/queue 说明某条任务还在排队或正在跑，/history 说明它已经出结果。
 * 两者都没有 = 这条任务在 ComfyUI 侧不存在（进程重启过 / 队列被清空 / 从未真正发出）。
 */
export async function fetchComfySnapshot(config, opts = {}) {
  const base = String(config?.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置 ComfyUI 地址');
  const maxItems = Math.max(1, Math.min(2000, Number(opts.maxItems) || 500));
  // 对账是「顺手核对一下」，不能把页面 / 执行卡在一个连不上的地址上：
  // ComfyUI 关机或地址写错时 6 秒内必须给结论，退回「连不上 → 按未发送处理」。
  const signal = opts.signal || AbortSignal.timeout(Math.max(1000, Number(opts.timeoutMs) || 6000));
  const [queue, history] = await Promise.all([
    requestJSON(`${base}/queue`, { signal }),
    requestJSON(`${base}/history?max_items=${maxItems}`, { signal }),
  ]);
  return { queue: describeQueue(queue), history: history || {} };
}

/** /queue 的两种返回形态（新版对象 / 旧版数组）统一成 { running:Set, pending:Set } */
export function describeQueue(queue) {
  const running = new Set();
  const pending = new Set();
  const items = [];
  const idOf = (row) => (Array.isArray(row) ? row[1] : row?.prompt_id || row?.promptId) || '';
  const graphOf = (row) => (Array.isArray(row) ? row[2] : row?.prompt) || {};
  const states = [
    ['running', queue?.queue_running || queue?.running],
    ['pending', queue?.queue_pending || queue?.pending],
  ];
  for (const [state, list] of states) {
    for (const row of (Array.isArray(list) ? list : [])) {
      const promptId = idOf(row);
      if (!promptId) continue;
      (state === 'running' ? running : pending).add(promptId);
      // 队列条目同样带产物文件名前缀：没有 prompt_id 的老任务（升级前提交的）只能靠它认领，
      // 否则会被误判成「从未发出」而重发一遍——那正是把正在算的任务又烧一次的根源。
      const prefix = historyFilenamePrefix(graphOf(row));
      items.push({ promptId, state, prefix, tag: parseArtifactPrefix(prefix), claimed: false });
    }
  }
  return { running, pending, items };
}

/** history 条目的 prompt 图（新版是 [number, prompt_id, graph]，旧版直接是 graph） */
export function historyPromptGraph(item) {
  if (!item) return {};
  if (Array.isArray(item.prompt)) return item.prompt[2] || {};
  return item.prompt || {};
}

/** 从工作流图里取本次产物文件名前缀（SaveImage / VHS 等输出节点都带 filename_prefix） */
export function historyFilenamePrefix(graph) {
  for (const node of Object.values(graph || {})) {
    const prefix = node?.inputs?.filename_prefix ?? node?.inputs?.filenamePrefix;
    if (typeof prefix === 'string' && prefix) return prefix;
  }
  return '';
}

/**
 * 把本项目写进 ComfyUI 的产物前缀解析成「哪一类、第几镜」。
 * 前缀形如 lingximanju_keyframe_12_123456789：kind=keyframe，shotNo=12。
 */
export function parseArtifactPrefix(prefix) {
  const m = String(prefix || '').match(/^lingximanju_([a-z][a-z-]*)_(\d+)(?:_|$)/i);
  if (!m) return null;
  return { kind: m[1].toLowerCase(), shotNo: Number(m[2]) };
}

/** history 条目里第一条消息的时间戳（execution_start），无则退回 0 */
export function historyStartedAt(item) {
  const messages = item?.status?.messages;
  if (Array.isArray(messages)) {
    for (const m of messages) {
      const ts = m?.[1]?.timestamp;
      if (Number(ts) > 0) return Number(ts);
    }
  }
  return Number(item?.meta?.created_at) || 0;
}

/** history 条目是否已经跑完（有产物即视为完成；出错且无产物视为失败） */
export function historyOutcome(item) {
  const outputs = collectOutputs(item);
  const statusStr = item?.status?.status_str || (item?.status?.completed ? 'success' : '');
  if (outputs.length) return { state: 'success', outputs };
  if (statusStr === 'error') {
    const msg = (item?.status?.messages || []).map((m) => JSON.stringify(m)).join(' | ').slice(0, 400);
    return { state: 'error', outputs: [], error: msg || 'ComfyUI 执行失败' };
  }
  return { state: 'running', outputs };
}

/**
 * 从一条 history 记录里下载全部产物到本地资产目录。
 * 与 runWorkflow 内的下载走同一条路径（/view → assets/），保证取回的图片和正常链路完全一致。
 */
export async function downloadHistoryOutputs(config, item, opts = {}) {
  const { signal, log = () => {}, limit = 24 } = opts;
  const { outputs } = historyOutcome(item);
  const assets = [];
  for (const file of outputs.slice(0, limit)) {
    try {
      assets.push(await downloadOutput(config, file, signal));
    } catch (err) {
      log('warn', `取回产物 ${file.filename} 失败：${err.message}`);
    }
  }
  return assets;
}

/**
 * 完整执行一次 API 格式工作流。
 * vars.imageRefs：[{buffer,name}]，多张参考图按 LoadImage 插槽顺序一一对应；
 * vars.imageBuffer/imageName：单张参考图（应用到全部插槽，向后兼容）。
 * @returns {Promise<{assets:Array, primary:Object|null, promptId:string, applied:Array,
 *   promptInjection:Object, durationMs:number}>}
 */
export async function runWorkflow(config, workflow, vars = {}, opts = {}) {
  const { signal, log = () => {}, bindings = [], onSubmitted } = opts;
  const built = injectWorkflow(workflow, vars, bindings, config?.nodeOverrides || null);
  const prompt = built.prompt;
  const plan = built.promptInjection;
  const chosen = config?.resolvedInterface;
  if (chosen?.id) {
    log('info', `接口档案「${chosen.name || chosen.id}」· 板块 ${chosen.scope || '默认'} · ${chosen.via}`);
  }
  for (const w of chosen?.warnings || []) log('warn', w);

  if (plan.positive) {
    log('info', `提示词 → ${plan.positive.node}.${plan.positive.input}` +
      `${plan.positive.title ? `「${plan.positive.title}」` : ''} · ${plan.positive.strategy} · "${clip(plan.positive.preview, 60)}"`);
  }
  for (const w of plan.warnings) log('warn', w);

  // 参考图：多参考图按 LoadImage 插槽顺序一一对应；单图沿用旧行为（应用到全部插槽，
  // 兼容首尾帧同图的视频工作流）；没有参考图时按帧信息生成一张合法 PNG 占位
  const refs = normalizeRefs(vars);
  if (refs.length && !built.uploadSlots.length) {
    log('warn', `提供了 ${refs.length} 张参考图，但工作流没有 LoadImage 参考图插槽，参考图未被使用`);
  }
  if (built.uploadSlots.length) {
    const uploads = [];
    for (const ref of refs) {
      let name = ref.name || 'reference.png';
      if (!IMAGE_EXTS.test(name)) name = `${name.replace(/\.[^.]+$/, '')}.png`;
      uploads.push(await uploadImage(config, ref.buffer, name, signal));
    }
    if (!uploads.length) {
      const buffer = placeholderFrame({ seed: vars.seed, shotNo: vars.shotNo, style: vars.style, kind: 'reference' });
      uploads.push(await uploadImage(config, buffer, 'lingximanju_reference.png', signal));
    } else if (uploads.length > 1) {
      if (uploads.length > built.uploadSlots.length) {
        log('warn', `参考图 ${uploads.length} 张多于工作流的 ${built.uploadSlots.length} 个 LoadImage 插槽，多余的参考图未被使用`);
      } else if (uploads.length < built.uploadSlots.length) {
        log('warn', `参考图 ${uploads.length} 张少于工作流的 ${built.uploadSlots.length} 个 LoadImage 插槽，剩余插槽用占位图填充`);
        while (uploads.length < built.uploadSlots.length) {
          const buffer = placeholderFrame({ seed: `${vars.seed}-pad-${uploads.length}`, shotNo: vars.shotNo, style: vars.style, kind: 'reference' });
          uploads.push(await uploadImage(config, buffer, `lingximanju_reference_${uploads.length}.png`, signal));
        }
      }
    }
    built.uploadSlots.forEach((slot, i) => {
      if (!prompt[slot.node]) return;
      const u = uploads.length === 1 ? uploads[0] : uploads[i];
      if (!u) return;
      const rel = u.subfolder ? `${u.subfolder}/${u.name}` : u.name;
      prompt[slot.node].inputs[slot.input] = rel;
      built.applied.push({ node: slot.node, input: slot.input, value: rel, by: 'auto:uploadImage' });
    });
    log('info', uploads.length === 1
      ? `参考图已上传至 ComfyUI input：${uploads[0].name}`
      : `参考图 ${uploads.length} 张已按 LoadImage 插槽顺序上传：${uploads.map((u) => u.name).join('、')}`);
  }

  const t0 = Date.now();
  const queued = await requestJSON(`${config.baseUrl}/prompt`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: config.clientId || 'lingximanju' }),
  });
  const promptId = queued?.prompt_id;
  if (!promptId) throw new Error('ComfyUI 未返回 prompt_id');
  // 提交即回调：调用方可以立刻把 prompt_id 落盘到画布节点，
  // 这样服务重启 / 请求中断后仍能凭它去 ComfyUI 历史里把结果认领回来，
  // 而不是因为「不知道发的是哪一条」只能整批重烧一遍。
  try { onSubmitted?.(promptId, { applied: built.applied.length, vars }); }
  catch (err) { log('warn', `prompt_id 回调失败（不影响本次执行）：${err.message}`); }
  log('info', `ComfyUI 已排队 ${promptId} · 注入 ${built.applied.length} 个参数`);

  let history = null;
  const deadline = Date.now() + (config.timeoutMs || 900000);
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
    const body = await requestJSON(`${config.baseUrl}/history/${encodeURIComponent(promptId)}`, { signal });
    const item = body?.[promptId];
    if (item) {
      const status = item.status || {};
      if (status.status_str === 'error' || status.completed === true && status.status_str !== 'success' && !Object.keys(item.outputs || {}).length) {
        const msg = (status.messages || []).map((m) => JSON.stringify(m)).join(' | ').slice(0, 500);
        throw new Error(`ComfyUI 执行失败：${msg || status.status_str || '未知错误'}`);
      }
      if (Object.keys(item.outputs || {}).length) { history = item; break; }
    }
    await sleep(config.pollIntervalMs || 1000, signal);
  }
  if (!history) throw new Error(`ComfyUI 执行超时（${Math.round((config.timeoutMs || 0) / 1000)}s）`);

  const outputs = collectOutputs(history);
  if (!outputs.length) throw new Error('工作流完成但没有可下载的输出节点（请确认工作流里有 SaveImage / SaveAudio / VHS_VideoCombine 等输出节点）');
  const assets = [];
  for (const file of outputs.slice(0, 24)) {
    try { assets.push(await downloadOutput(config, file, signal)); }
    catch (err) { log('warn', `产物 ${file.filename} 下载失败：${err.message}`); }
  }
  if (!assets.length) throw new Error('所有产物下载失败');
  // 主产物按工作流语义挑：视频 > 音频 > 图片。音频排第二是因为音色抽卡工作流
  // 常同时输出波形图一类的图片产物，此时「主产物」必须是那段可播放的音频。
  const primary = assets.find((a) => a.kind === 'video')
    || assets.find((a) => a.kind === 'audio')
    || assets.find((a) => a.kind === 'image')
    || assets[0];
  log('info', `ComfyUI 完成 · ${assets.length} 个产物 · ${Date.now() - t0}ms`);
  return { assets, primary, promptId, applied: built.applied, promptInjection: plan, durationMs: Date.now() - t0 };
}

/**
 * 把画布上的一个图片 URL 变成可上传给 ComfyUI 的二进制。
 * SVG 无法被 ComfyUI LoadImage 读取，统一渲染为等价的 PNG 占位。
 */
export function prepareReferenceImage(url, opts = {}) {
  if (!url) return null;
  if (/\.svg(\?|$)/i.test(String(url))) {
    return {
      buffer: placeholderFrame({ seed: opts.seed || url, shotNo: opts.shotNo || 1, style: opts.style, kind: 'reference' }),
      name: 'lingximanju_reference.png',
      converted: true,
    };
  }
  return null; // 真实 png/jpg 由调用方从本地资产目录读取
}
