// 全局 ComfyUI 接入配置：与具体项目解耦，落盘 data/comfyui.json
// 项目 settings 只保留「产物模式」这类与创作相关的开关，连接与 workflow 模板全局复用。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.mjs';

const FILE = path.join(DATA_DIR, 'comfyui.json');

export const DEFAULT_COMFY = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:8188',
  clientId: 'lingximanju',
  strict: false,              // true = ComfyUI 失败即报错，不回退 Mock
  timeoutMs: 900000,          // 单次工作流最长等待 15 分钟（视频生成较慢）
  pollIntervalMs: 1000,
  imageWorkflow: null,        // ComfyUI「导出(API)」的完整 JSON
  videoWorkflow: null,
  imageWorkflowName: '',
  videoWorkflowName: '',
  bindings: { image: [], video: [] }, // 显式绑定 [{node:'6', input:'text', value:'{{prompt}}'}]
  negativePrompt: 'low quality, blurry, deformed hands, extra fingers, watermark, text, inconsistent character',
  width: 864,
  height: 480,
  fps: 24,
  frames: 124,                // MiniMax H3 默认 5s / 24fps
  steps: 25,
  cfg: 1.0,
  outputMode: 'both',         // video | director-pack | both
  packTarget: 'minimax-h3',   // minimax-h3 | generic
  stitch: true,               // 所有片段就绪时用 ffmpeg 拼成一条成片
};

function normalize(raw) {
  const cfg = { ...DEFAULT_COMFY, ...(raw || {}) };
  cfg.bindings = {
    image: Array.isArray(raw?.bindings?.image) ? raw.bindings.image : [],
    video: Array.isArray(raw?.bindings?.video) ? raw.bindings.video : [],
  };
  cfg.baseUrl = String(cfg.baseUrl || DEFAULT_COMFY.baseUrl).replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(cfg.baseUrl)) cfg.baseUrl = DEFAULT_COMFY.baseUrl;
  cfg.timeoutMs = Math.max(10000, Math.min(3600000, Number(cfg.timeoutMs) || DEFAULT_COMFY.timeoutMs));
  cfg.pollIntervalMs = Math.max(200, Math.min(10000, Number(cfg.pollIntervalMs) || 1000));
  cfg.width = Math.max(64, Math.min(4096, Number(cfg.width) || 864));
  cfg.height = Math.max(64, Math.min(4096, Number(cfg.height) || 480));
  cfg.fps = Math.max(1, Math.min(120, Number(cfg.fps) || 24));
  cfg.frames = Math.max(1, Math.min(2000, Number(cfg.frames) || 124));
  if (!['video', 'director-pack', 'both'].includes(cfg.outputMode)) cfg.outputMode = 'both';
  if (!['minimax-h3', 'generic'].includes(cfg.packTarget)) cfg.packTarget = 'minimax-h3';
  return cfg;
}

export function loadComfyConfig() {
  try {
    if (fs.existsSync(FILE)) return normalize(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch (err) {
    console.warn('[comfy] 配置读取失败，使用默认值：', err.message);
  }
  return normalize({});
}

export function saveComfyConfig(patch = {}) {
  const next = normalize({ ...loadComfyConfig(), ...patch });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
  return next;
}

/** 给前端的概览：不把整份 workflow 重复塞进每个项目 */
export function comfySummary(cfg = loadComfyConfig()) {
  return {
    enabled: cfg.enabled, baseUrl: cfg.baseUrl, strict: cfg.strict,
    outputMode: cfg.outputMode, packTarget: cfg.packTarget, stitch: cfg.stitch,
    width: cfg.width, height: cfg.height, fps: cfg.fps, frames: cfg.frames,
    imageWorkflow: cfg.imageWorkflow ? { name: cfg.imageWorkflowName, nodes: Object.keys(cfg.imageWorkflow).length } : null,
    videoWorkflow: cfg.videoWorkflow ? { name: cfg.videoWorkflowName, nodes: Object.keys(cfg.videoWorkflow).length } : null,
  };
}
