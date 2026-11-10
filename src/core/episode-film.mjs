/* ============================================================================
 * 按集成片：把「本集分镜格」当作镜头单元，逐格出视频片段并拼接成本集成片。
 *
 * 为什么以格为单位：分集制作里每一集的镜头结构就是「段 → 格」（每段一张分镜板，
 * 每格带景别 / 机位 / 运镜 / videoPrompt / 站位图 / 角色参考），第⑤步已经把
 * 这些物料落到 ep.segments[].cells 上。按集交付不需要回到全项目画布的镜头链，
 * 直接消费这些格子即可得到一部真正属于这一集的成片 MP4。
 *
 * 产物约定（与单集剧本 / 分镜板 / 导演包一致，全部回写 episode record）：
 *   cell.video = { url, file, provider, promptId, duration, at }   每格视频片段
 *   ep.film    = { url, file, bytes, duration, clips, ... }        本集成片
 * ==========================================================================*/
import { createProviders } from './providers.mjs';
import { effectiveProjectSettings } from './app-settings.mjs';
import { resolveRuntimeSpec } from './runtime-spec.mjs';
import { hasWorkflowFor } from './comfy-config.mjs';
import { stitchClips } from './film.mjs';
import { isRealImage, allowMockArtifacts } from './keyframe-status.mjs';
import { ensureEpisodeBody } from './episode-service.mjs';
import fs from 'node:fs';
import { assetPath } from './store.mjs';

const cut = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * 按段序摊平本集分镜格，并标注「有真实首帧图」的格子。
 * 真实口径与第⑤步验收一致：mock 自绘 SVG / 占位不算（离线测试夹具例外），
 * 否则「9 张 SVG 示意图」会被当成 9 个可出视频的镜头。
 * @returns {Array<{segNo:number, cellNo:number, index:number, cell:object, seg:object, hasFrame:boolean}>}
 */
export function collectEpisodeCells(ep, opts = {}) {
  const allowMock = opts.allowMock ?? true;   // 格子 url 落盘时已过滤过 mock；这里只挡 .svg 占位
  const out = [];
  let index = 0;
  for (const seg of (Array.isArray(ep?.segments) ? ep.segments : [])) {
    for (const cell of (Array.isArray(seg?.cells) ? seg.cells : [])) {
      const hasFrame = isRealImage({ url: cell?.url, provider: cell?.provider }, { allowMock });
      index += 1;
      out.push({
        segNo: Number(seg?.no) || 0, cellNo: Number(cell?.no) || 0,
        index, cell, seg, hasFrame,
      });
    }
  }
  return out;
}

/** 本集可出视频的格子（有真实首帧图） */
export function shootableCells(ep) {
  return collectEpisodeCells(ep).filter((x) => x.hasFrame);
}

/**
 * 逐格调用本地 ComfyUI 视频工作流，生成本集全部视频片段。
 * 幂等：已有真实片段（provider=comfyui 且有 file）的格子默认跳过，force=true 才重出。
 * 单格失败不阻断整集：错误记入 failed，最后统一汇报。
 *
 * @param {object} cfg resolveComfyConfig(project) 的结果
 * @param {object} opts { force?, modelId?, log?, onProgress?({done,total,failed,segNo,cellNo}), signal? }
 * @returns {Promise<{ok:boolean, total:number, generated:number, skipped:number, failed:Array, message:string}>}
 */
export async function generateEpisodeCellVideos(project, m, ep, cfg, opts = {}) {
  ensureEpisodeBody(project, ep);
  if (!cfg?.enabled) throw new Error('本地 ComfyUI 未启用：设置 → 本地 ComfyUI 勾选「启用」');
  // 板块可绑定库里的接口档案，此时镜像字段可能为空；按「是否有任何可用接口」判断
  if (!hasWorkflowFor(cfg, 'video')) throw new Error('尚未导入视频工作流：设置 → 本地 ComfyUI → 导入视频工作流 JSON（导出 API 格式）');
  const log = opts.log || (() => {});
  const cells = shootableCells(ep);
  if (!cells.length) {
    throw new Error('本集还没有带真实画面的分镜格：请先在第⑤步（或本集「分镜板 · ⚙ ComfyUI」）出图，再逐格生成视频');
  }
  const runtime = resolveRuntimeSpec(project);
  const providers = createProviders({
    ...effectiveProjectSettings(project),
    comfy: { ...cfg, enabled: true, outputMode: 'video' },
  }, log);
  const style = project.settings?.style || 'cinematic';
  const failed = [];
  let generated = 0;
  let skipped = 0;
  for (const { segNo, cellNo, index, cell } of cells) {
    const total = cells.length;
    const ready = cell.video?.provider === 'comfyui' && cell.video?.file && !opts.force;
    if (ready) { skipped += 1; opts.onProgress?.({ done: index, total, failed: failed.length, segNo, cellNo, skipped: true }); continue; }
    const prompt = cell.videoPrompt || cell.imagePrompt || cell.prompt || cell.caption
      || `第 ${ep.no} 集 · ${cut(segTitle(ep, segNo), 30)} · 第 ${cellNo} 格`;
    try {
      log('info', `第 ${ep.no} 集 · 格 ${index}/${total}（段 ${segNo} · 格 ${cellNo}）提交视频工作流`);
      const out = await providers.video({
        prompt, interfaceId: String(opts.interfaceId || cfg?.requestInterfaceId || ''),
        frames: [cell.url],
        duration: Math.max(0.5, Number(cell.duration) || runtime.clipSeconds),
        shotNo: index,
        style,
      }, opts.signal);
      if (out.provider !== 'comfyui' || !out.url || !out.file) {
        throw new Error('ComfyUI 未返回视频片段');
      }
      cell.video = {
        url: out.url, file: out.file, poster: out.poster || cell.url,
        provider: 'comfyui', promptId: out.promptId || '', prompt,
        duration: Number(cell.duration) || runtime.clipSeconds, at: Date.now(),
      };
      generated += 1;
      ep.updatedAt = Date.now();
    } catch (err) {
      failed.push({ segNo, cellNo, index, error: err.message });
      log('warn', `第 ${ep.no} 集 · 格 ${index}/${total} 出视频失败：${err.message}`);
    }
    opts.onProgress?.({ done: index, total, failed: failed.length, segNo, cellNo });
  }
  const ok = generated + skipped > 0;
  const parts = [`新增 ${generated} 段`];
  if (skipped) parts.push(`复用已有 ${skipped} 段`);
  if (failed.length) parts.push(`失败 ${failed.length} 段`);
  return {
    ok, total: cells.length, generated, skipped, failed,
    message: `本集视频片段：${parts.join(' · ')}（共 ${cells.length} 格）`,
  };
}

function segTitle(ep, segNo) {
  return (ep.segments || []).find((s) => Number(s.no) === Number(segNo))?.title || `段 ${segNo}`;
}

/**
 * 拼接本集成片：按段序收集每格真实片段 → ffmpeg concat（与项目成片同一套
 * 归一 / 封顶 / 实测口径）。没有任何真实片段时明确失败，不用静态图冒充成片。
 * @returns {{ok:boolean, film?:object, message:string}}
 */
export function stitchEpisodeFilm(project, m, ep, opts = {}) {
  ensureEpisodeBody(project, ep);
  const runtime = resolveRuntimeSpec(project);
  const all = shootableCells(ep)
    .filter((x) => x.cell.video?.provider === 'comfyui' && x.cell.video?.file)
    .map((x) => ({ file: x.cell.video.file, url: x.cell.video.url, segNo: x.segNo, cellNo: x.cellNo }));
  // 片段文件可能已被清理：磁盘上不存在的先剔除并如实汇报，不进 ffmpeg
  const existing = all.filter((c) => fs.existsSync(assetPath(c.file)));
  const missing = all.length - existing.length;
  if (!existing.length) {
    return { ok: false, message: '还没有可拼接的真实视频片段：请先逐格生成视频（本集成片不用静态图冒充）' };
  }
  const film = stitchClips(existing, { clipSeconds: runtime.clipSeconds });
  if (!film) {
    return { ok: false, message: `成片拼接失败：${clips.length} 个片段无法合成（请检查本机 ffmpeg 与片段文件是否完整）` };
  }
  const record = {
    url: film.url, file: film.file, bytes: film.bytes,
    duration: film.duration, declaredDuration: film.declaredDuration,
    width: film.width || runtime.width, height: film.height || runtime.height,
    clips: film.clips, method: film.method, isRealVideo: film.isRealVideo === true,
    provider: 'comfyui', clipSeconds: runtime.clipSeconds,
    shotCount: existing.length, at: Date.now(),
  };
  ep.film = record;
  ep.updatedAt = Date.now();
  const bits = [`本集成片 ${record.duration}s · ${record.clips} 段 · ${record.width}×${record.height}`];
  if (missing) bits.push(`${missing} 段文件缺失已跳过`);
  if (film.measured === false) bits.push('时长为标称值（ffprobe 不可用）');
  return { ok: true, film: record, message: bits.join(' · ') };
}

/** 本集视频交付进度摘要（工作台分集列表 / 剧集详情共用口径） */
export function episodeFilmSummary(ep) {
  const cells = shootableCells(ep);
  const videos = cells.filter((x) => x.cell.video?.provider === 'comfyui' && x.cell.video?.file);
  return {
    cells: cells.length,
    videos: videos.length,
    film: ep?.film && ep.film.file ? ep.film : null,
    pack: ep?.pack && ep.pack.file ? ep.pack : null,
  };
}
