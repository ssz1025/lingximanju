// 成片拼接：把 ComfyUI 产出的各镜头片段用本机 ffmpeg 合成一条 MP4
// 并用 ffprobe 实测成片时长，避免「元数据求和」冒充真实成片时长。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assetPath, writeAssetBinary, uid } from './store.mjs';

let ffmpegChecked = null;
export function hasFfmpeg() {
  if (ffmpegChecked !== null) return ffmpegChecked;
  try { ffmpegChecked = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0; }
  catch { ffmpegChecked = false; }
  return ffmpegChecked;
}

let ffprobeChecked = null;
export function hasFfprobe() {
  if (ffprobeChecked !== null) return ffprobeChecked;
  try { ffprobeChecked = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0; }
  catch { ffprobeChecked = false; }
  return ffprobeChecked;
}

/** 实测一个本地视频文件的秒数；不可用 / 探测失败时返回 null，绝不编造 */
export function probeDuration(localFile) {
  if (!localFile || !hasFfprobe() || !fs.existsSync(localFile)) return null;
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', localFile,
  ], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) return null;
  const n = Number(String(r.stdout || '').trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/**
 * 把每个真实片段归一到 clipSeconds：ComfyUI 工作流返回的片段长度可能因帧率/
 * 帧数取整而与规格差零点几秒，直接 concat 会让成片不是精确的 30.0s。
 * 偏差在容差内就复用原文件（无重编码、无画质损失），否则逐段 -t 截断重编码。
 */
function normalizeClipLengths(files, clipSeconds, tmp) {
  const tolerance = 0.25;
  const measured = files.map((f) => probeDuration(f.local));
  const needFix = measured.some((d) => d === null || Math.abs(d - clipSeconds) > tolerance);
  if (!needFix) return { paths: files.map((f) => f.local), method: 'concat-copy', measured };
  const paths = [];
  for (const [i, f] of files.entries()) {
    const out = path.join(tmp, `norm_${String(i).padStart(2, '0')}.mp4`);
    const r = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', f.local, '-t', String(clipSeconds),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '24', '-an', out,
    ], { encoding: 'utf8', timeout: 300000 });
    if (r.status !== 0 || !fs.existsSync(out)) return { paths: [], method: 'failed', measured };
    paths.push(out);
  }
  return { paths, method: 'clip-normalized', measured };
}

/**
 * @param {Array<{file?:string, url?:string, duration?:number}>} clips 视频节点里的真实 ComfyUI 片段
 * @param {{clipSeconds?:number}} opts clipSeconds 由项目成片规格下发
 * @returns {{url,file,method,clips,bytes,duration,declaredDuration,measured,source,isRealVideo}|null}
 */
export function stitchClips(clips = [], opts = {}) {
  const clipSeconds = Number(opts.clipSeconds) || 5;
  const files = clips
    .filter((c) => c?.file)
    .map((c) => ({ ...c, local: assetPath(c.file) }))
    .filter((c) => fs.existsSync(c.local) && /\.(mp4|webm|mov|mkv|m4v)$/i.test(c.local));
  if (!files.length) return null;
  // 真实成片的标称时长一律按「片段数 × 规格时长」，不把工作流元数据里的
  // 4/5/6 秒残留拿来求和；最终仍以 ffprobe 实测为准。
  const declaredDuration = Math.round(files.length * clipSeconds * 100) / 100;
  const real = { source: 'comfyui', isRealVideo: true };

  if (files.length === 1) {
    const measured = probeDuration(files[0].local);
    return {
      url: `/assets/${files[0].file}`, file: files[0].file, method: 'single', clips: 1,
      duration: measured ?? declaredDuration, declaredDuration,
      measured: measured !== null,
      bytes: fs.statSync(files[0].local).size,
      ...real,
    };
  }
  if (!hasFfmpeg()) return null;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lingximanju-'));
  try {
    const norm = normalizeClipLengths(files, clipSeconds, tmp);
    if (!norm.paths.length) return null;
    const list = path.join(tmp, 'concat.txt');
    fs.writeFileSync(list, norm.paths.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n', 'utf8');
    const out = path.join(tmp, 'final.mp4');
    let method = norm.method;
    let r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out], { encoding: 'utf8' });
    if (r.status !== 0 || !fs.existsSync(out)) {
      method = `${norm.method}-reencode`;
      r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '24', out], { encoding: 'utf8', timeout: 300000 });
    }
    if (r.status !== 0 || !fs.existsSync(out)) return null;
    const measured = probeDuration(out);
    const buf = fs.readFileSync(out);
    const name = `${uid('film')}.mp4`;
    const url = writeAssetBinary(name, buf);
    return {
      url, file: name, method, clips: files.length,
      duration: measured ?? declaredDuration, declaredDuration,
      measured: measured !== null,
      bytes: buf.length,
      ...real,
    };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
