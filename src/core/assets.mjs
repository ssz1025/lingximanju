// 资源索引：给 data/assets/ 的文件补上「类型 / 名称 / 标签 / 来源项目」等元数据，
// 支撑资源库的友好展示、打标签共享与跨项目角色优先匹配。
// 文件本身仍是唯一事实来源（目录扫描定存在性），index.json 只存元数据：
// 文件被手动删掉 → reindex/list 时自动剔除；index 丢失 → 重新收录为未分类。
import fs from 'node:fs';
import path from 'node:path';
import { ASSET_DIR, uid } from './store.mjs';

const INDEX_FILE = path.join(ASSET_DIR, 'index.json');

/** 资源类型：封面 / 角色定妆 / 通用图片 / 视频片段 / 导演包 / 其他 */
export const ASSET_KINDS = ['cover', 'character', 'image', 'video', 'pack', 'other'];
const KIND_LABEL = { cover: '封面', character: '角色', image: '图片', video: '视频', pack: '导演包', other: '其他' };
export const kindLabel = (k) => KIND_LABEL[k] || KIND_LABEL.other;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov']);
const PACK_EXT = new Set(['.zip']);

/** 按文件名推断类型（未收录的新文件的初始 kind） */
export function inferKind(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (PACK_EXT.has(ext)) return 'pack';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (!IMAGE_EXT.has(ext)) return 'other';
  const n = String(name).toLowerCase();
  if (n.startsWith('cover_')) return 'cover';
  if (n.startsWith('char') || n.includes('portrait') || n.includes('character')) return 'character';
  return 'image';
}

let cache = null;   // { key, entries: Map<file, entry> }

function readIndexFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : [];
    return new Map(list.filter((e) => e && e.file).map((e) => [e.file, e]));
  } catch { return new Map(); }
}

function loadIndex() {
  let key = '';
  try { const st = fs.statSync(INDEX_FILE); key = `${st.mtimeMs}:${st.size}`; } catch { key = 'missing'; }
  if (cache && cache.key === key) return cache.entries;
  cache = { key, entries: readIndexFile() };
  return cache.entries;
}

function saveIndex(entries) {
  const list = [...entries.values()].sort((a, b) => String(a.file).localeCompare(String(b.file)));
  const tmp = `${INDEX_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: list }, null, 2), 'utf8');
  fs.renameSync(tmp, INDEX_FILE);
  cache = null;   // 主动失效，不依赖 mtime 恰好变化
}

/** 目录里真实存在的文件（index 的存在性以磁盘为准） */
function scanFiles() {
  if (!fs.existsSync(ASSET_DIR)) return [];
  return fs.readdirSync(ASSET_DIR).filter((f) => {
    if (f === 'index.json' || f.endsWith('.tmp')) return false;
    try { return fs.statSync(path.join(ASSET_DIR, f)).isFile(); } catch { return false; }
  });
}

function entryOf(file, existing) {
  const st = fs.statSync(path.join(ASSET_DIR, file));
  const base = existing || {};
  return {
    id: base.id || uid('ast'),
    file,
    url: `/assets/${file}`,   // 前端缩略图 / 预览 / 复用选图都直接用这个字段
    kind: ASSET_KINDS.includes(base.kind) ? base.kind : inferKind(file),
    name: base.name || file.replace(/\.[a-z0-9]+$/i, ''),
    tags: Array.isArray(base.tags) ? base.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()).slice(0, 12) : [],
    sourceProjectId: base.sourceProjectId || '',
    sourceProjectName: base.sourceProjectName || '',
    createdAt: base.createdAt || st.mtimeMs,
    bytes: st.size,
    ext: path.extname(file).toLowerCase().slice(1),
    type: IMAGE_EXT.has(path.extname(file).toLowerCase()) ? 'image'
      : VIDEO_EXT.has(path.extname(file).toLowerCase()) ? 'video' : 'other',
  };
}

/** 全量列表：磁盘定存在，index 定元数据；新文件自动按文件名推断类型收录 */
export function listAssets() {
  const entries = loadIndex();
  let dirty = false;
  const out = [];
  for (const file of scanFiles()) {
    let e = entries.get(file);
    if (!e) { e = entryOf(file, null); entries.set(file, e); dirty = true; }
    else {
      // 文件被重新生成（大小变化）→ 刷新字节数；元数据保持用户编辑过的值
      try {
        const st = fs.statSync(path.join(ASSET_DIR, file));
        if (st.size !== e.bytes) { e.bytes = st.size; dirty = true; }
      } catch { /* stat 失败保留旧值 */ }
    }
    // 旧版索引没有 url 字段 → 自愈补齐并落盘
    if (!e.url) { e.url = `/assets/${file}`; dirty = true; }
    out.push(e);
  }
  // 清掉已不存在的文件
  for (const file of [...entries.keys()]) {
    if (!out.some((e) => e.file === file)) { entries.delete(file); dirty = true; }
  }
  if (dirty) saveIndex(entries);
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** 单个资源元数据（不存在返回 null） */
export function getAsset(file) {
  return listAssets().find((e) => e.file === file) || null;
}

/**
 * 登记 / 更新资源元数据（幂等：同 file 覆盖合并）。
 * @param {object} o
 * @param {string} o.file  文件名（data/assets/ 下）
 * @param {string} [o.kind] cover|character|image|video|pack|other
 * @param {string} [o.name] 展示名
 * @param {string[]} [o.tags] 标签（跨项目共享的检索依据）
 * @param {string} [o.sourceProjectId] 产出该资源的项目
 * @param {string} [o.sourceProjectName]
 */
export function registerAsset(o = {}) {
  const file = String(o.file || '').split('/').pop();
  if (!file || !/^[a-zA-Z0-9_.-]+$/.test(file)) return null;
  const abs = path.join(ASSET_DIR, file);
  if (!fs.existsSync(abs)) return null;
  const entries = loadIndex();
  const prev = entries.get(file) || {};
  const next = entryOf(file, {
    ...prev,
    id: prev.id,
    kind: o.kind || prev.kind,
    name: o.name || prev.name,
    tags: o.tags || prev.tags,
    sourceProjectId: o.sourceProjectId || prev.sourceProjectId,
    sourceProjectName: o.sourceProjectName || prev.sourceProjectName,
    createdAt: prev.createdAt,
    userEdited: true,
  });
  entries.set(file, next);
  saveIndex(entries);
  return next;
}

/**
 * 更新元数据（改名 / 打标签 / 改类型）。tags 传数组整体覆盖，传字符串按逗号拆。
 * @returns {{ok:true, asset:object} | {ok:false, message:string}}
 */
export function updateAsset(file, patch = {}) {
  const entries = loadIndex();
  const prev = entries.get(file);
  if (!prev || !fs.existsSync(path.join(ASSET_DIR, file))) return { ok: false, message: '资源不存在' };
  const next = { ...prev, userEdited: true };
  if (patch.name !== undefined) {
    const name = String(patch.name).trim().slice(0, 80);
    if (!name) return { ok: false, message: '名称不能为空' };
    next.name = name;
  }
  if (patch.kind !== undefined) {
    if (!ASSET_KINDS.includes(patch.kind)) return { ok: false, message: `类型必须是 ${ASSET_KINDS.join(' / ')}` };
    next.kind = patch.kind;
  }
  if (patch.tags !== undefined) {
    const raw = Array.isArray(patch.tags) ? patch.tags : String(patch.tags).split(/[,，]/);
    next.tags = [...new Set(raw.map((t) => String(t).trim()).filter(Boolean))].slice(0, 12);
  }
  entries.set(file, next);
  saveIndex(entries);
  return { ok: true, asset: next };
}

/** 从索引移除（文件本身由 deleteAsset 负责删除） */
export function forgetAsset(file) {
  const entries = loadIndex();
  if (!entries.delete(file)) return false;
  saveIndex(entries);
  return true;
}

/**
 * 重新扫描目录：收录新文件、剔除已删除文件、按文件名修正未编辑条目的类型。
 * @returns {{total:number, added:number, removed:number, byKind:object}}
 */
export function reindex() {
  const entries = loadIndex();
  const files = scanFiles();
  const before = new Set(entries.keys());
  let added = 0;
  for (const file of files) {
    if (!entries.has(file)) { entries.set(file, entryOf(file, null)); added++; }
    else {
      const e = entries.get(file);
      if (!e.userEdited) { const fresh = entryOf(file, e); entries.set(file, fresh); }
      else entries.set(file, entryOf(file, e));
    }
  }
  let removed = 0;
  for (const file of [...entries.keys()]) {
    if (!files.includes(file)) { entries.delete(file); removed++; }
  }
  saveIndex(entries);
  const byKind = {};
  for (const e of entries.values()) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  return { total: entries.size, added, removed, byKind, had: before.size };
}

/* ---------------- 角色优先匹配：跨项目复用已生成的定妆图 ---------------- */

/** 角色名归一：全角/半角、大小写、空白与常见别名符号抹平，便于「李长歌 / 李 长歌」命中同一资源 */
export function normalizeCharName(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s·・.。，,、_\-—~「」『』《》()（）\[\]【】]/g, '')
    .replace(/(小姐|公子|先生|女士|老师|师傅|道长|道友)$/u, '');
}

/**
 * 为一批角色匹配可复用的已生成资源。
 * 匹配优先级：① 归一化角色名 = 资源名 / 标签命中 ② 标签交集 ≥2 且 kind=character。
 * @param {Array<{name:string, tags?:string[]}>} characters 待生成的角色
 * @param {object} [o]
 * @param {string} [o.excludeProjectId] 不排除任何项目——跨项目复用正是目标；仅排除同名文件已失效的情况
 * @returns {{map: Record<string, object>, reused:number, total:number}}
 */
export function matchCharacters(characters = [], o = {}) {
  const assets = listAssets().filter((a) => a.file && fs.existsSync(path.join(ASSET_DIR, a.file)));
  const pool = assets.filter((a) => a.kind === 'character' || (a.tags || []).includes('角色'));
  const map = {};
  let hit = 0;
  for (const c of characters) {
    const key = normalizeCharName(c.name);
    if (!key) continue;
    const charTags = (c.tags || []).map(normalizeCharName).filter(Boolean);
    let best = null;
    let bestScore = 0;
    for (const a of pool) {
      const names = [a.name, ...(a.tags || [])].map(normalizeCharName).filter(Boolean);
      let score = 0;
      if (names.includes(key)) score = 100;                      // 名字直接命中
      else if (names.some((n) => n && (n.includes(key) || key.includes(n)))) score = 60;  // 包含关系
      else if (charTags.length) {
        const overlap = charTags.filter((t) => (a.tags || []).map(normalizeCharName).includes(t));
        if (overlap.length >= 2) score = 30 + Math.min(20, overlap.length * 5);           // 标签强交集
      }
      if (score > bestScore) { bestScore = score; best = a; }
    }
    if (best && bestScore >= 30) { map[c.name] = { ...best, score: bestScore }; hit++; }
  }
  return { map, reused: hit, total: characters.length };
}

/** 资源库统计（面板头部与空态提示用） */
export function assetStats() {
  const list = listAssets();
  const byKind = {};
  let bytes = 0;
  for (const a of list) { byKind[a.kind] = (byKind[a.kind] || 0) + 1; bytes += a.bytes || 0; }
  return { total: list.length, bytes, byKind, tagCount: new Set(list.flatMap((a) => a.tags || [])).size };
}
