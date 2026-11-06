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
  return fs.readdirSync(PROJECT_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, f), 'utf8'));
        // 索引字段由项目管理层统一推导：状态、进度、收藏、归档、标签、交付物
        return projectIndex(p);
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

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
  return project;
}

export function deleteProject(id) {
  const file = fileOf(id);
  if (fs.existsSync(file)) fs.unlinkSync(file);
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

/* ---------------- 项目快照：手动版本点，可随时恢复 ---------------- */
const snapshotDirOf = (id) => path.join(SNAPSHOT_DIR, String(id).replace(/[^a-zA-Z0-9_-]/g, ''));

export function writeSnapshot(project) {
  const dir = snapshotDirOf(project.id);
  fs.mkdirSync(dir, { recursive: true });
  const at = Date.now();
  const file = path.join(dir, `${at}.json`);
  const body = JSON.stringify(project, null, 2);
  fs.writeFileSync(file, body, 'utf8');
  return { at, size: Buffer.byteLength(body), nodeCount: (project.nodes || []).length, name: project.name };
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
    .slice(0, 20);
}

export function readSnapshot(id, at) {
  const file = path.join(snapshotDirOf(id), `${Number(at)}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
