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

const isLink = (v) => Array.isArray(v) && v.length >= 2 && (typeof v[0] === 'string' || typeof v[0] === 'number');
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
  const negativePrompt = String(vars.negative ?? cfg.negativePrompt ?? '');
  const seed = seedValue(String(vars.seed ?? ''));
  // prompt_json：JSON 字符串内部安全形态（转义引号/换行），供 timeline_data 这类 JSON 字符串字段使用
  const jsonInner = (s) => JSON.stringify(s).slice(1, -1);
  const prefix = String(vars.filenamePrefix || 'lingximanju');
  return {
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
export function injectWorkflow(workflow, vars = {}, bindings = []) {
  const wf = JSON.parse(JSON.stringify(workflow));
  const values = resolveVars(vars);
  const applied = [];
  const uploadSlots = [];
  const outputNodes = [];
  const touched = new Set(); // 已被占位符/显式绑定处理过的 node::input
  const plan = { positive: null, negative: null, warnings: [] };

  const replace = (str) => String(str).replace(PLACEHOLDER_RE, (_, key) => {
    const val = values[key];
    return val === undefined ? `{{${key}}}` : String(val);
  });
  const slotInfo = (node, input, strategy, text) => ({
    node: String(node), input: String(input),
    classType: wf[node]?.class_type || '', title: nodeTitle(wf[node]),
    strategy, preview: clip(text),
  });

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

/** POST /upload/image，multipart 手写，无第三方依赖 */
export async function uploadImage(config, buffer, filename = 'reference.png', signal) {
  const base = config.baseUrl;
  const boundary = `----lingximanju${Date.now().toString(36)}`;
  const safeName = String(filename).replace(/[^A-Za-z0-9_.-]/g, '_');
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${safeName}"\r\n` +
    `Content-Type: image/png\r\n\r\n`, 'utf8');
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
  if (!res.ok) throw new Error(`参考图上传失败：${text.slice(0, 200)}`);
  let out = {};
  try { out = JSON.parse(text); } catch { /* 有些版本返回纯文本 */ }
  return { name: out.name || safeName, subfolder: out.subfolder || '', type: out.type || 'input' };
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
 * 完整执行一次 API 格式工作流。
 * vars.imageRefs：[{buffer,name}]，多张参考图按 LoadImage 插槽顺序一一对应；
 * vars.imageBuffer/imageName：单张参考图（应用到全部插槽，向后兼容）。
 * @returns {Promise<{assets:Array, primary:Object|null, promptId:string, applied:Array,
 *   promptInjection:Object, durationMs:number}>}
 */
export async function runWorkflow(config, workflow, vars = {}, opts = {}) {
  const { signal, log = () => {}, bindings = [] } = opts;
  const built = injectWorkflow(workflow, vars, bindings);
  const prompt = built.prompt;
  const plan = built.promptInjection;

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
