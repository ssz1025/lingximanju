/* ============================================================================
 * 音色抽卡候选池（Voice Drafts）
 *
 * 为什么单独一层：
 *   - 抽卡是「试错」而不是「入库」。用户一次抽 4 个，多数会被丢掉，
 *     若直接写进全局音色库（data/voices.json），库里很快堆满一次性垃圾，
 *     而音色库是跨项目共享的资产，污染成本远高于图片资源。
 *   - 候选因此独立落盘在 data/voice-drafts.json，带 TTL（默认 24h）与容量上限，
 *     过期或超限自动淘汰并回收音频文件；用户点「保存」才转正进 voices.json。
 *   - 转正不是「复制一份」，而是 id 迁移：promoteDraft() 产出的音色带
 *     source='draw' + audio + draw{seed,voiceValue,...}，同一条记录既能试听也能复现，
 *     避免「库里只有一个音色名，实际音频却找不回来」。
 *
 * 与角色绑定的关系（产品硬约束）：
 *   角色只能绑定「已保存」的音色。routes/voices.mjs 的 /voices/set 收到候选 id 时
 *   先 promoteDraft 落库再绑定，保证没有「绑定了一个随时会被 TTL 清掉的音色」这种悬空引用。
 *
 * 纯逻辑（normalizeDraft / promoteDraft）无 I/O，便于单元测试。
 * ==========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, deleteAsset, uid } from './store.mjs';

const FILE = path.join(DATA_DIR, 'voice-drafts.json');
export const DRAFT_PREFIX = 'vdr_';
/** 候选池上限与存活时间：抽卡是快消品，不留给未来的自己 */
export const DRAFT_CAPACITY = 40;
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
export const DRAFT_KEEP_PER_PROJECT = 24;

const AUDIO_EXT_RE = /\.(mp3|wav|ogg|m4a|flac|aac|opus)$/i;
const cut = (v, max) => String(v ?? '').trim().slice(0, max);

export const isDraftId = (id) => String(id || '').startsWith(DRAFT_PREFIX);

function genId() {
  return `${DRAFT_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 归一一条候选：音频必须落在 /assets/ 且是音频扩展名，否则视为无效候选（直接丢弃）。
 * @returns {object|null}
 */
export function normalizeDraft(raw = {}) {
  const audio = normalizeAudio(raw.audio);
  if (!audio) return null;
  return {
    id: isDraftId(raw.id) ? String(raw.id) : genId(),
    characterId: cut(raw.characterId, 60),
    characterName: cut(raw.characterName, 40),
    projectId: cut(raw.projectId, 60),
    // 抽卡时的角色条件：决定这条候选「像不像那个角色」，保存后成为音色元数据
    gender: ['男', '女', '中性'].includes(raw.gender) ? raw.gender : '中性',
    ageGroup: ['儿童', '青年', '中年', '老年'].includes(raw.ageGroup) ? raw.ageGroup : '青年',
    tags: Array.isArray(raw.tags)
      ? raw.tags.map((t) => cut(t, 12)).filter(Boolean).slice(0, 8)
      : String(raw.tags || '').split(/[,，、]/).map((t) => cut(t, 12)).filter(Boolean).slice(0, 8),
    language: cut(raw.language, 12) || 'zh-CN',
    sampleText: cut(raw.sampleText, 200) || '欢迎来到灵犀漫剧，这是一段音色试听。',
    nameHint: cut(raw.nameHint, 40),
    audio,
    draw: {
      seed: Math.max(0, Math.trunc(Number(raw.draw?.seed) || 0)),
      voiceValue: cut(raw.draw?.voiceValue, 80),
      workflowName: cut(raw.draw?.workflowName, 60),
      prompt: cut(raw.draw?.prompt, 2000),
      at: Number(raw.draw?.at) || Date.now(),
    },
    source: 'comfyui',
    createdAt: Number(raw.createdAt) || Date.now(),
  };
}

function normalizeAudio(raw) {
  const obj = typeof raw === 'string' ? { url: raw } : (typeof raw === 'object' ? raw : null);
  if (!obj) return null;
  const url = cut(obj.url, 300);
  if (!url.startsWith('/assets/')) return null;
  const file = cut(obj.file, 120) || url.slice('/assets/'.length).split('?')[0];
  if (!AUDIO_EXT_RE.test(file)) return null;
  return {
    url, file,
    bytes: Number(obj.bytes) || 0,
    durationSec: Number(obj.durationSec) || 0,
    at: Number(obj.at) || Date.now(),
    source: cut(obj.source, 20) || 'comfyui',
  };
}

/** 读全量候选（不做过期淘汰，交给 loadDrafts 处理） */
function readRaw() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(raw?.drafts) ? raw.drafts : [];
  } catch { return []; }
}

function writeAll(drafts) {
  const payload = { schema: 1, updatedAt: Date.now(), drafts };
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
  return drafts;
}

/**
 * 载入候选池：过期淘汰 + 容量裁剪，被淘汰的候选把音频文件一并删掉，
 * 避免 data/assets/ 里堆一批永远没人再听的 mp3。
 * @returns {Array}
 */
export function loadDrafts(now = Date.now()) {
  const raw = readRaw();
  const fresh = [];
  const dropped = [];
  for (const item of raw) {
    const d = normalizeDraft(item);
    if (!d) { dropped.push({ audio: normalizeAudio(item?.audio) }); continue; }
    if (now - d.createdAt > DRAFT_TTL_MS) { dropped.push(d); continue; }
    fresh.push(d);
  }
  // 超容量：按创建时间从新到旧保留，同时限制单项目配额，防一个项目抽卡挤占全局
  const sorted = fresh.sort((a, b) => b.createdAt - a.createdAt);
  const byProject = {};
  const kept = [];
  for (const d of sorted) {
    if (kept.length >= DRAFT_CAPACITY) { dropped.push(d); continue; }
    const k = d.projectId || '_';
    if ((byProject[k] || 0) >= DRAFT_KEEP_PER_PROJECT) { dropped.push(d); continue; }
    byProject[k] = (byProject[k] || 0) + 1;
    kept.push(d);
  }
  if (dropped.length) {
    for (const d of dropped) {
      const file = d?.audio?.file;
      if (file) { try { deleteAsset(file); } catch { /* 文件已不存在 */ } }
    }
    writeAll(kept);
  }
  return kept;
}

export function getDraft(id, drafts = null) {
  return (drafts || loadDrafts()).find((d) => d.id === id) || null;
}

/** 追加一批候选（抽卡产出）：先归一，再交给 loadDrafts 统一过期/容量淘汰，返回最终池 */
export function addDrafts(list = []) {
  const valid = list.map(normalizeDraft).filter(Boolean);
  if (!valid.length) return loadDrafts();
  const existing = readRaw();
  writeAll([...valid, ...existing]);
  return loadDrafts();
}

export function removeDraft(id, { keepAudio = false } = {}) {
  const all = loadDrafts();
  const target = all.find((d) => d.id === id);
  if (!target) return { ok: false, message: '候选不存在' };
  if (target.audio?.file && !keepAudio) { try { deleteAsset(target.audio.file); } catch { /* 忽略 */ } }
  writeAll(all.filter((d) => d.id !== id));
  return { ok: true, removed: id };
}

/** 候选池整体清空（用户手动「清空抽卡结果」）：候选是快消品，音频一并回收 */
export function clearDrafts() {
  const all = loadDrafts();
  for (const d of all) if (d.audio?.file) { try { deleteAsset(d.audio.file); } catch { /* 忽略 */ } }
  writeAll([]);
  return { ok: true, removed: all.length };
}

/**
 * 候选转正：产出可直接写入音色库的对象（source='draw'）。
 * id 换新（vox_…），音频与复现参数原样带走。
 * @param {object} draft  候选（normalizeDraft 后的）
 * @param {object} [patch] 用户补充的名称 / 标签 / 备注等
 * @returns {object} 归一后的音色（调用方负责 saveVoices 落盘）
 */
export function draftToVoice(draft, patch = {}) {
  if (!draft) return null;
  const name = cut(patch.name, 40)
    || draft.nameHint
    || `抽卡音色·${draft.gender}${draft.ageGroup}·${new Date(draft.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
  return {
    id: uid('vox'),
    name,
    gender: patch.gender || draft.gender,
    ageGroup: patch.ageGroup || draft.ageGroup,
    tags: Array.isArray(patch.tags) && patch.tags.length ? patch.tags : draft.tags,
    language: patch.language || draft.language,
    sampleText: patch.sampleText || draft.sampleText,
    rate: 1,
    pitch: 1,
    note: cut(patch.note, 200) || `ComfyUI 抽卡 · ${draft.draw?.workflowName || '本地音色工作流'} · seed ${draft.draw?.seed ?? 0}`,
    tts: patch.tts || (draft.draw?.voiceValue
      ? { provider: 'comfyui', voiceId: draft.draw.voiceValue }
      : null),
    audio: {
      url: draft.audio.url,
      file: draft.audio.file,
      bytes: draft.audio.bytes,
      durationSec: draft.audio.durationSec,
      at: draft.audio.at,
      source: 'comfyui',
    },
    draw: { ...draft.draw },
    source: 'draw',
    updatedAt: Date.now(),
  };
}

/** 候选池概览（前端与测试用，不含音频二进制） */
export function draftStats(drafts = null) {
  const list = drafts || loadDrafts();
  return {
    total: list.length,
    bytes: list.reduce((s, d) => s + (d.audio?.bytes || 0), 0),
    capacity: DRAFT_CAPACITY,
    ttlHours: DRAFT_TTL_MS / 3600000,
  };
}
