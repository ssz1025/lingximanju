/* ============================================================================
 * 本地预览成片：零 Key / 无 ComfyUI 时，把分镜关键帧渲染成等长片段并拼成 MP4。
 *
 * 诚实化边界：这不是 AI 生成的视频，产物明确标记 source='preview-frames' 与
 * isRealVideo=false，报告里必须写明「关键帧预览成片」并记为降级。
 *
 * 重要：本模块只在用户显式把成片策略切到 `filmPolicy='preview'` 时才允许调用。
 * 默认 `real` 策略下 composer 绝不生成本产物——ComfyUI 没被调用时就不能
 * 交付一条看起来像成片的 MP4（这正是此前「30s 假短剧」的根因）。
 * 接入 ComfyUI 视频工作流后 composer 改用真实片段拼接（stitchClips）。
 * ==========================================================================*/
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAssetBinary, uid } from './store.mjs';
import { placeholderFrame } from './raster.mjs';
import { hasFfmpeg, probeDuration, probeVideoInfo } from './film.mjs';
import { resolveRuntimeSpec } from './runtime-spec.mjs';

const round2 = (n) => Math.round(n * 100) / 100;

/** 按全局镜头序号取稳定的片段顺序，与 composer / 导演包口径一致 */
function previewFrames(project, spec) {
  const seq = (n) => Number(n.data?.sequence ?? n.data?.shot?.sequence ?? n.data?.shot?.shotNo ?? 0);
  const videos = (project?.nodes || []).filter((n) => n.type === 'video' && n.data?.clip)
    .sort((a, b) => seq(a) - seq(b));
  const style = project?.settings?.style || 'cinematic';
  return videos.slice(0, spec.clipCount).map((n, i) => ({
    index: i + 1,
    nodeId: n.id,
    shotNo: n.data?.shot?.shotNo || i + 1,
    png: placeholderFrame({ seed: n.id, shotNo: n.data?.shot?.sequence || i + 1, style, kind: 'keyframe' }),
  }));
}

/**
 * @returns {{url,file,method,clips,duration,declaredDuration,measured,bytes,source,note}|null}
 * 不可用 / 无片段 / ffmpeg 失败一律返回 null，绝不伪造产物。
 */
export function renderPreviewFilm(project, specOrNull = null) {
  const spec = specOrNull?.schema === 1 ? specOrNull : resolveRuntimeSpec(project);
  if (!hasFfmpeg()) return null;
  const frames = previewFrames(project, spec);
  if (!frames.length) return null;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lingximanju-preview-'));
  try {
    const clipFiles = [];
    for (const frame of frames) {
      const pngPath = path.join(tmp, `frame_${String(frame.index).padStart(2, '0')}.png`);
      const out = path.join(tmp, `clip_${String(frame.index).padStart(2, '0')}.mp4`);
      fs.writeFileSync(pngPath, frame.png);
      const r = spawnSync('ffmpeg', [
        '-y', '-loglevel', 'error',
        '-loop', '1', '-framerate', String(spec.fps), '-i', pngPath,
        '-t', String(spec.clipSeconds),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(spec.fps),
        '-vf', `scale=${spec.width}:${spec.height}`, '-an', out,
      ], { encoding: 'utf8', timeout: 120000 });
      if (r.status !== 0 || !fs.existsSync(out)) return null;
      clipFiles.push(out);
    }

    const list = path.join(tmp, 'concat.txt');
    fs.writeFileSync(list, clipFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n', 'utf8');
    const finalPath = path.join(tmp, 'final.mp4');
    const concat = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(spec.fps), finalPath,
    ], { encoding: 'utf8', timeout: 300000 });
    if (concat.status !== 0 || !fs.existsSync(finalPath)) return null;

    const info = probeVideoInfo(finalPath);
    const declaredDuration = round2(clipFiles.length * spec.clipSeconds);
    const buf = fs.readFileSync(finalPath);
    const name = `${uid('film')}.mp4`;
    const url = writeAssetBinary(name, buf);
    return {
      url, file: name,
      method: 'preview-reencode',
      clips: clipFiles.length,
      duration: info.duration ?? declaredDuration,
      declaredDuration,
      measured: info.duration !== null,
      width: info.width ?? spec.width,
      height: info.height ?? spec.height,
      bytes: buf.length,
      source: 'preview-frames',
      isRealVideo: false,
      synthetic: true,
      note: '关键帧预览成片：由本机 ffmpeg 把每段首帧渲染为等长静态片段后拼接，不是 AI 生成视频；真实短剧请切到「真实 AI 视频」策略并接入 ComfyUI 视频工作流。',
    };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
