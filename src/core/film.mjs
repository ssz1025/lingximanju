// 成片拼接：把 ComfyUI 产出的各镜头片段用本机 ffmpeg 合成一条 MP4
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

/**
 * @param {Array<{file?:string, url?:string, duration?:number}>} clips 视频节点里的片段
 * @returns {{url,file,method,clips,bytes,duration}|null}
 */
export function stitchClips(clips = []) {
  const files = clips
    .filter((c) => c?.file)
    .map((c) => ({ ...c, local: assetPath(c.file) }))
    .filter((c) => fs.existsSync(c.local) && /\.(mp4|webm|mov|mkv|m4v)$/i.test(c.local));
  if (!files.length) return null;
  const duration = files.reduce((a, c) => a + (Number(c.duration) || 5), 0);

  if (files.length === 1) {
    return { url: `/assets/${files[0].file}`, file: files[0].file, method: 'single', clips: 1, duration, bytes: fs.statSync(files[0].local).size };
  }
  if (!hasFfmpeg()) return null;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lingximanju-'));
  try {
    const list = path.join(tmp, 'concat.txt');
    fs.writeFileSync(list, files.map((f) => `file '${f.local.replace(/'/g, "'\\''")}'`).join('\n') + '\n', 'utf8');
    const out = path.join(tmp, 'final.mp4');
    let method = 'concat-copy';
    let r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out], { encoding: 'utf8' });
    if (r.status !== 0 || !fs.existsSync(out)) {
      method = 'concat-reencode';
      r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '24', out], { encoding: 'utf8', timeout: 300000 });
    }
    if (r.status !== 0 || !fs.existsSync(out)) return null;
    const buf = fs.readFileSync(out);
    const name = `${uid('film')}.mp4`;
    const url = writeAssetBinary(name, buf);
    return { url, file: name, method, clips: files.length, duration, bytes: buf.length };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
