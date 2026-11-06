// 本地 JSON 持久化：原子写入、轻量索引、资产落盘、项目快照
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectIndex } from './project-steps.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// 数据目录解析优先级：
// 1. LINGXIMANJU_DATA_DIR —— Electron 打包后由主进程注入（OS 用户数据目录），也可手动指定；
// 2. 默认跟随仓库 ./data —— 源码/开发形态行为完全不变。
export const DATA_DIR = process.env.LINGXIMANJU_DATA_DIR
  ? path.resolve(process.env.LINGXIMANJU_DATA_DIR)
  : path.join(ROOT, 'data');
export const PROJECT_DIR = path.join(DATA_DIR, 'projects');
export const ASSET_DIR = path.join(DATA_DIR, 'assets');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const EXAMPLES_DIR = path.join(ROOT, 'examples');
export const SNAPSHOT_DIR = path.join(DATA_DIR, 'snapshots');

for (const dir of [DATA_DIR, PROJECT_DIR, ASSET_DIR, SNAPSHOT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

let seq = 0;
export function uid(prefix = 'id') {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

const fileOf = (id) => path.join(PROJECT_DIR, `${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);

export function listProjects() {
  // 解析缓存：项目 JSON 可内嵌整本小说，每次列表全量重解析会阻塞事件循环。
  // 以 (mtimeMs, size) 为凭据复用轻量索引，文件一变即失效；save/delete 另行主动失效。
  return fs.readdirSync(PROJECT_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const file = path.join(PROJECT_DIR, f);
        const st = fs.statSync(file);
        const key = `${st.mtimeMs}:${st.size}`;
        const hit = indexCache.get(f);
        if (hit && hit.key === key) return hit.index;
        const index = projectIndex(JSON.parse(fs.readFileSync(file, 'utf8')));
        indexCache.set(f, { key, index });
        return index;
      } catch { indexCache.delete(f); return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
const indexCache = new Map();

export function loadProject(id) {
  const file = fileOf(id);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function saveProject(project) {
  project.updatedAt = Date.now();
  const file = fileOf(project.id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(project, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  indexCache.delete(path.basename(file));   // 主动失效，不依赖 mtime 恰好变化
  return project;
}

export function deleteProject(id) {
  const file = fileOf(id);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  indexCache.delete(path.basename(file));
}

export function writeAsset(name, content) {
  const safe = String(name).replace(/[^a-zA-Z0-9_.-]/g, '');
  fs.writeFileSync(path.join(ASSET_DIR, safe), content, 'utf8');
  return `/assets/${safe}`;
}

/** 二进制资产（ComfyUI 下载的 PNG / MP4、导演包 ZIP、ffmpeg 成片） */
export function writeAssetBinary(name, buffer) {
  const safe = String(name).replace(/[^a-zA-Z0-9_.-]/g, '');
  fs.writeFileSync(path.join(ASSET_DIR, safe), buffer);
  return `/assets/${safe}`;
}

/** 资产 URL → 本地绝对路径，供 ffmpeg / 导演包读取 */
export function assetPath(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9_.-]/g, '');
  return path.join(ASSET_DIR, safe);
}

export function readAsset(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9_.-]/g, '');
  const file = path.join(ASSET_DIR, safe);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

const ASSET_TYPES = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'],
  video: ['.mp4', '.webm', '.mov'],
};

/** 全量资产索引：资源库弹窗与复用选择都从这里取数 */
export function listAssets() {
  if (!fs.existsSync(ASSET_DIR)) return [];
  return fs.readdirSync(ASSET_DIR)
    .map((name) => {
      try {
        const st = fs.statSync(path.join(ASSET_DIR, name));
        if (!st.isFile()) return null;
        const ext = path.extname(name).toLowerCase();
        const type = ASSET_TYPES.image.includes(ext) ? 'image'
          : ASSET_TYPES.video.includes(ext) ? 'video' : 'other';
        return { name, url: `/assets/${name}`, type, ext: ext.slice(1), size: st.size, mtime: st.mtimeMs };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

export function deleteAsset(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9_.-]/g, '');
  const file = path.join(ASSET_DIR, safe);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

/* ---------------- 项目快照：手动版本点，可随时恢复 ---------------- */
const snapshotDirOf = (id) => path.join(SNAPSHOT_DIR, String(id).replace(/[^a-zA-Z0-9_-]/g, ''));
const SNAPSHOT_KEEP = 20;   // 与 listSnapshots 展示上限一致：每份都是项目全量副本，必须封顶

export function writeSnapshot(project) {
  const dir = snapshotDirOf(project.id);
  fs.mkdirSync(dir, { recursive: true });
  let at = Date.now();
  while (fs.existsSync(path.join(dir, `${at}.json`))) at += 1;   // 同毫秒连拍不互相覆盖
  const file = path.join(dir, `${at}.json`);
  const body = JSON.stringify(project, null, 2);
  fs.writeFileSync(file, body, 'utf8');
  pruneSnapshots(dir);
  return { at, size: Buffer.byteLength(body), nodeCount: (project.nodes || []).length, name: project.name };
}

/** 超出保留上限的最旧快照直接删除，防止磁盘无限膨胀 */
function pruneSnapshots(dir) {
  const files = fs.readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
  for (const f of files.slice(0, Math.max(0, files.length - SNAPSHOT_KEEP))) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
  }
}

export function listSnapshots(id) {
  const dir = snapshotDirOf(id);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f))
    .map((f) => {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return { at: Number(f.replace('.json', '')), size: fs.statSync(path.join(dir, f)).size,
          name: p.name, nodeCount: (p.nodes || []).length };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at)
    .slice(0, SNAPSHOT_KEEP);
}

export function readSnapshot(id, at) {
  const file = path.join(snapshotDirOf(id), `${Number(at)}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
