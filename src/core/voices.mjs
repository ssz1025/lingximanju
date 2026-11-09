/* ============================================================================
 * 音色库（Voice Library）数据层：全局共享的音色预设集合。
 *
 * 设计取向（对齐项目「零依赖 · 可离线 · Mock 优先」哲学）：
 *   - 音色库是跨项目共享的全局资产，落盘在 data/voices.json（与 app-settings.json 同级），
 *     多个项目里的角色都可从同一份库里挑音色，避免每个项目重复维护一堆音色。
 *   - 三种音色来源并存，全部走同一份数据模型：
 *     source='seed'   内置种子音色（只有文字描述 + rate/pitch）；
 *     source='manual' 用户手填的预设；
 *     source='draw'   用本地 ComfyUI TTS 工作流抽卡（seed 随机）得到的音色，
 *                     带 audio 真实音频样本与 draw 复现参数 —— 抽卡满意即可直接保存。
 *   - 角色「试听」默认走浏览器原生 SpeechSynthesis（Web Speech API）：
 *     零配置、离线可用、无需任何 API Key；每个音色用 sampleText + rate/pitch 区分，
 *     并在浏览器可用语音里按 language + gender/age 启发式挑选最接近的那一个。
 *     带 audio 的音色优先播放真实音频样本，不再受浏览器语音库限制。
 *   - 真实 TTS（MiniMax / MiMo / 任意 OpenAI /audio/speech 兼容端点）作为可选扩展点：
 *     音色预留 tts:{provider,voiceId} 绑定字段，配置 ttsEndpoint 后可生成真实音频，
 *     未配置时自动回退浏览器试听（见 routes/voices.mjs 的 sample 端点）。
 *
 * 纯逻辑（normalizeVoice / matchVoice / scoreVoiceForCharacter）无副作用，便于单元测试。
 * ==========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.mjs';

const FILE = path.join(DATA_DIR, 'voices.json');

const GENDERS = ['男', '女', '中性'];
const AGE_GROUPS = ['儿童', '青年', '中年', '老年'];
// 受支持的语言白名单（对齐浏览器 SpeechSynthesis 的 lang 与可选 TTS 端点）。
// 不在名单内的值一律回退 zh-CN，避免脏数据进入试听/合成链路。
const LANGUAGES = [
  'zh-CN', 'zh-TW', 'zh',
  'en-US', 'en-GB', 'en',
  'ja-JP', 'ja',
  'ko-KR', 'ko',
  'fr-FR', 'fr',
  'de-DE', 'de',
  'es-ES', 'es',
  'yue-HK', 'yue',
];
const LIMITS = {
  name: 40, gender: 4, ageGroup: 4, tags: 40, sampleText: 200, language: 12,
  note: 200, ttsProvider: 30, ttsVoiceId: 80,
  audioUrl: 300, audioFile: 120, workflowName: 60, prompt: 2000,
};

/** 音色来源：seed=内置种子 / manual=手填 / draw=ComfyUI 抽卡 */
export const VOICE_SOURCES = ['seed', 'manual', 'draw'];
const AUDIO_EXT_RE = /\.(mp3|wav|ogg|m4a|flac|aac|opus)$/i;

/** 字段截断工具：统一上限、去首尾空格 */
function cut(v, max) {
  return String(v ?? '').trim().slice(0, max);
}

let _seq = 0;
function genId() {
  _seq += 1;
  return `vox_${Date.now().toString(36)}${_seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 种子音色库：覆盖四种年龄层 × 双性别的常见叙事音色，
 * 每个带典型性格标签（与角色的 personality 做重叠匹配）和一段试听样例文案。
 * rate/pitch 给浏览器 SpeechSynthesis 用，制造音色差异；tts 绑定留空待真实 TTS 接入。
 */
export const DEFAULT_VOICES = [
  { name: '沉稳旁白·中年男声', gender: '男', ageGroup: '中年', tags: ['沉稳', '旁白', '威严', '讲故事'], language: 'zh-CN', sampleText: '这是一个发生在雨夜的故事，真相藏在最不起眼的角落。', rate: 0.92, pitch: 0.8, note: '适合开篇旁白与权威长者' },
  { name: '清亮少年·青年男声', gender: '男', ageGroup: '青年', tags: ['活泼', '阳光', '少年', '热血'], language: 'zh-CN', sampleText: '交给我吧！这条路我熟，保证没问题！', rate: 1.05, pitch: 1.35, note: '适合热血主角与少年角色' },
  { name: '磁性反派·中年男声', gender: '男', ageGroup: '中年', tags: ['磁性', '成熟', '反派', '冷峻'], language: 'zh-CN', sampleText: '你以为，你看到的才是全部吗？', rate: 0.9, pitch: 0.7, note: '适合反派、幕后黑手' },
  { name: '儒雅书生·青年男声', gender: '男', ageGroup: '青年', tags: ['儒雅', '温和', '书生', '冷静'], language: 'zh-CN', sampleText: '此中道理，容我慢慢道来。', rate: 0.95, pitch: 1.05, note: '适合军师、学者、暖男' },
  { name: '苍老智者·老年男声', gender: '男', ageGroup: '老年', tags: ['苍老', '智慧', '长者', '沉稳'], language: 'zh-CN', sampleText: '孩子，有些答案，要等你走够远才看得见。', rate: 0.85, pitch: 0.6, note: '适合爷爷、导师、史官' },
  { name: '温柔少女·青年女声', gender: '女', ageGroup: '青年', tags: ['温柔', '甜美', '清新', '治愈'], language: 'zh-CN', sampleText: '别怕，我一直都在你身边呀。', rate: 1.0, pitch: 1.4, note: '适合女主、妹妹、治愈系' },
  { name: '知性御姐·中年女声', gender: '女', ageGroup: '中年', tags: ['知性', '冷静', '御姐', '成熟'], language: 'zh-CN', sampleText: '数据不会说谎，我们只需要读懂它。', rate: 0.96, pitch: 1.1, note: '适合女强、记者、分析师' },
  { name: '英气女将·青年女声', gender: '女', ageGroup: '青年', tags: ['英气', '飒爽', '果断', '女强'], language: 'zh-CN', sampleText: '列队！今日，我们不退半步。', rate: 1.02, pitch: 1.15, note: '适合女将、侠女、队长' },
  { name: '俏皮萝莉·儿童女声', gender: '女', ageGroup: '儿童', tags: ['俏皮', '可爱', '活泼', '天真'], language: 'zh-CN', sampleText: '嘿嘿，这个秘密我只告诉你一个人哦！', rate: 1.08, pitch: 1.6, note: '适合妹妹、精灵、吉祥物' },
  { name: '中性叙述·中性声线', gender: '中性', ageGroup: '青年', tags: ['中性', '冷静', '纪录片', '旁白'], language: 'zh-CN', sampleText: '接下来，我们把镜头转向故事的背面。', rate: 0.98, pitch: 1.0, note: '适合纪录片旁白与无性别角色' },
];

/** 归一单个音色：补齐缺字段、截断超长、过滤非法枚举；保留已有 id/tts */
export function normalizeVoice(raw = {}) {
  const base = {
    id: /^[a-zA-Z0-9_-]+$/.test(String(raw.id || '')) ? String(raw.id) : genId(),
    name: cut(raw.name, LIMITS.name) || '未命名音色',
    gender: GENDERS.includes(raw.gender) ? raw.gender : '中性',
    ageGroup: AGE_GROUPS.includes(raw.ageGroup) ? raw.ageGroup : '青年',
    tags: Array.isArray(raw.tags)
      ? raw.tags.map((t) => cut(t, 12)).filter(Boolean).slice(0, 8)
      : String(raw.tags || '').split(/[,，、]/).map((t) => cut(t, 12)).filter(Boolean).slice(0, 8),
    language: LANGUAGES.includes(String(raw.language || '').trim()) ? String(raw.language).trim() : 'zh-CN',
    sampleText: cut(raw.sampleText, LIMITS.sampleText) || '欢迎来到灵犀漫剧，这是一段音色试听。',
    rate: clampRate(raw.rate),
    pitch: clampPitch(raw.pitch),
    note: cut(raw.note, LIMITS.note),
    tts: raw.tts && typeof raw.tts === 'object'
      ? {
          provider: cut(raw.tts.provider, LIMITS.ttsProvider),
          voiceId: cut(raw.tts.voiceId, LIMITS.ttsVoiceId),
        }
      : (raw.ttsProvider || raw.ttsVoiceId
        ? { provider: cut(raw.ttsProvider, LIMITS.ttsProvider), voiceId: cut(raw.ttsVoiceId, LIMITS.ttsVoiceId) }
        : null),
    // 真实音频样本（ComfyUI 抽卡产物 / 服务器 TTS 产物落盘后的 /assets/ 地址）。
    // 有样本的音色试听时直接播放该文件，不再走浏览器合成。
    audio: normalizeAudio(raw.audio || raw.audioUrl),
    // 抽卡复现参数：同一音色想再生成一段文案时按 draw.seed/voice 复跑即可
    draw: normalizeDraw(raw.draw),
    source: VOICE_SOURCES.includes(raw.source) ? raw.source : 'manual',
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
  return base;
}

/** 音频样本归一：接受 {url,file,...} 或裸 URL 字符串 */
function normalizeAudio(raw) {
  if (!raw) return null;
  const obj = typeof raw === 'string' ? { url: raw } : (typeof raw === 'object' ? raw : null);
  if (!obj) return null;
  const url = cut(obj.url, LIMITS.audioUrl);
  if (!url || !url.startsWith('/assets/')) return null;
  const file = cut(obj.file, LIMITS.audioFile) || url.slice('/assets/'.length).split('?')[0];
  if (!AUDIO_EXT_RE.test(file)) return null;
  return {
    url, file,
    bytes: Number(obj.bytes) || 0,
    durationSec: Number(obj.durationSec) || 0,
    at: Number(obj.at) || 0,
    source: cut(obj.source, 20) || 'comfyui',
  };
}

/** 抽卡参数归一：只保留可复现所需的最小集合 */
function normalizeDraw(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const seed = Number(raw.seed);
  return {
    // 0 是合法种子（部分工作流要求从 0 起），不能用 `|| 0` 之外的 falsy 判断把它丢掉
    seed: Number.isFinite(seed) ? Math.max(0, Math.trunc(seed)) : 0,
    workflowName: cut(raw.workflowName, LIMITS.workflowName),
    voiceValue: cut(raw.voiceValue, LIMITS.ttsVoiceId),
    prompt: cut(raw.prompt, LIMITS.prompt),
    at: Number(raw.at) || 0,
  };
}

function clampRate(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.max(0.5, Math.min(2, n)) : 1;
}
function clampPitch(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 1;
}

export function loadVoices() {
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (Array.isArray(raw.voices)) return raw.voices.map(normalizeVoice);
    }
  } catch (err) {
    console.warn('[voices] 音色库读取失败，回退空库：', err.message);
  }
  return [];
}

/** 原子写入音色库；list 经 normalizeVoice 后再落盘，保证字段口径一致 */
export function saveVoices(list = []) {
  const voices = (Array.isArray(list) ? list : []).map(normalizeVoice);
  const payload = { schema: 1, updatedAt: Date.now(), voices };
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
  return voices;
}

/** 首次访问惰性播种：库为空时写入 DEFAULT_VOICES，返回 {voices,seeded} */
export function seedVoices() {
  const existing = loadVoices();
  if (existing.length) return { voices: existing, seeded: false };
  const voices = saveVoices(DEFAULT_VOICES);
  return { voices, seeded: true };
}

export function getVoice(id, list = null) {
  const voices = list || loadVoices();
  return voices.find((v) => v.id === id) || null;
}

/**
 * 角色 → 单个音色的匹配打分（0~100），分数越高越契合。
 * 维度：性别（权重最高）→ 年龄层 → 性格标签重叠 → 定位关键词命中。
 * @param {object} character 角色（含 gender/age/personality/role）
 * @param {object} voice 归一后的音色
 * @returns {{score:number, reasons:string[]}}
 */
export function scoreVoiceForCharacter(character = {}, voice = {}) {
  const c = character || {};
  const charGender = String(c.gender || '').trim();
  const charAge = String(c.age || '').trim();
  const charTags = tokenize(c.personality || '');
  const charRole = String(c.role || '').trim();
  const voiceTags = Array.isArray(voice.tags) ? voice.tags : [];

  let score = 0;
  const reasons = [];

  // 1) 性别匹配（40 分）：中性音色对任何人都不扣分、但也不加分
  if (charGender && voice.gender !== '中性') {
    if (charGender === voice.gender) { score += 40; reasons.push(`性别一致（${voice.gender}）`); }
    else { score -= 25; reasons.push(`性别不符（角色${charGender} / 音色${voice.gender}）`); }
  } else if (voice.gender === '中性') {
    reasons.push('中性声线，通用适配');
  }

  // 2) 年龄层匹配（30 分）：角色 age 字段做模糊层映射
  const charAgeGroup = mapAgeToGroup(charAge);
  if (charAgeGroup) {
    if (charAgeGroup === voice.ageGroup) { score += 30; reasons.push(`年龄层吻合（${voice.ageGroup}）`); }
    else if (adjacentAge(charAgeGroup, voice.ageGroup)) { score += 12; reasons.push(`年龄层接近（${voice.ageGroup}）`); }
    else { score -= 10; reasons.push(`年龄层偏出（音色${voice.ageGroup}）`); }
  }

  // 3) 性格标签重叠（20 分）：角色 personality 分词后，与音色 tags 求交集
  if (charTags.length) {
    const overlap = charTags.filter((t) => voiceTags.some((vt) => vt.includes(t) || t.includes(vt)));
    if (overlap.length) {
      score += Math.min(20, overlap.length * 10);
      reasons.push(`性格契合：${overlap.join('、')}`);
    }
  }

  // 4) 定位关键词命中（10 分）：音色 tags 出现在角色定位里
  if (charRole) {
    const roleHit = voiceTags.filter((vt) => charRole.includes(vt));
    if (roleHit.length) { score += 10; reasons.push(`定位命中：${roleHit.join('、')}`); }
  }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

/** 角色 age 文本 → 年龄层枚举 */
function mapAgeToGroup(age) {
  if (!age) return '';
  if (/(儿童|小[朋孩]|幼|童)/.test(age)) return '儿童';
  if (/(少年|青|年轻|2[0-9]岁|1[5-9]岁|初中|高中|大学|20岁|30岁)/.test(age)) return '青年';
  if (/(中年|成[年熟]|4[0-9]岁|5[0-9]岁|40岁|50岁)/.test(age)) return '中年';
  if (/(老年|老|古稀|长辈|爷爷|奶奶|外公|外婆)/.test(age)) return '老年';
  return '';
}

/** 相邻年龄层（给部分分） */
function adjacentAge(a, b) {
  const order = ['儿童', '青年', '中年', '老年'];
  const ia = order.indexOf(a); const ib = order.indexOf(b);
  return ia >= 0 && ib >= 0 && Math.abs(ia - ib) === 1;
}

/** 角色 personality 中文粗分词（去停用字、按 2~4 字切分重叠匹配标签） */
function tokenize(text) {
  const t = String(text || '').replace(/[\s，。、；：！？""''()（）—\-]/g, '');
  if (!t) return [];
  const out = new Set();
  const stop = new Set(['的', '了', '是', '和', '与', '在', '也', '都', '而', '及', '并', '一个', '一种', '非常', '十分', '比较', '显得', '角色']);
  for (let len = 4; len >= 2; len -= 1) {
    for (let i = 0; i + len <= t.length; i += 1) {
      const w = t.slice(i, i + len);
      if (!stop.has(w) && w.length >= 2) out.add(w);
    }
  }
  return [...out].slice(0, 16);
}

/**
 * 在音色库里为单个角色挑最佳音色。
 * @returns {{voice:object|null, score:number, reasons:string[]}}
 */
export function matchVoice(character = {}, library = []) {
  const voices = Array.isArray(library) && library.length ? library : loadVoices();
  if (!voices.length) return { voice: null, score: 0, reasons: ['音色库为空'] };
  let best = null;
  let bestScore = -Infinity;
  let bestReasons = [];
  for (const v of voices) {
    const { score, reasons } = scoreVoiceForCharacter(character, v);
    if (score > bestScore) { bestScore = score; best = v; bestReasons = reasons; }
  }
  return { voice: best, score: bestScore, reasons: bestReasons };
}

/**
 * 批量匹配：为角色列表各挑一个最佳音色，返回 assignments。
 * 保证返回每个角色的 { characterId, characterName, voiceId, voiceName, reason, score }，
 * 即使某个角色无匹配也给出 null（前端可提示「未匹配」）。
 * @param {Array} characters 角色数组（需含 id/name）
 * @param {Array} [library] 可选的音色库（不传则自动读取）
 * @returns {Array}
 */
export function matchAll(characters = [], library = null) {
  const voices = library || loadVoices();
  return (Array.isArray(characters) ? characters : []).map((c) => {
    const { voice, score, reasons } = matchVoice(c, voices);
    return {
      characterId: c.id || '',
      characterName: c.name || '',
      voiceId: voice ? voice.id : null,
      voiceName: voice ? voice.name : null,
      reason: reasons.join('；') || '未找到合适音色',
      score,
    };
  });
}
