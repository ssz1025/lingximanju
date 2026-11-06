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
  // 工作流库：多导入 + 选中生效。选中项会镜像回填到上面的 imageWorkflow/videoWorkflow，
  // 因此 providers / director-pack / run-test / comfySummary 等消费端零改动。
  imageWorkflowLib: [],   // [{id, name, workflow, createdAt, lastTest:{ok,durationMs,at,error}|null}]
  videoWorkflowLib: [],
  imageActiveId: null,
  videoActiveId: null,
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

/** 由内容推导稳定 id：迁移在每次 load 时重放，确定性 id 保证 GET → PUT 切换选中不丢匹配 */
function contentId(seed, obj) {
  const s = JSON.stringify(obj);
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${seed}_${(h >>> 0).toString(36)}`;
}

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
  // ---- 工作流库：防御性清洗 + 旧配置迁移 ----
  for (const kind of ['image', 'video']) {
    const libKey = `${kind}WorkflowLib`;
    const activeKey = `${kind}ActiveId`;
    const raw = Array.isArray(cfg[libKey]) ? cfg[libKey] : [];
    const cleaned = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.id !== 'string' || !item.id) continue;
      if (!item.workflow || typeof item.workflow !== 'object' || Array.isArray(item.workflow)) continue;
      cleaned.push({
        id: item.id,
        name: String(item.name || '').trim() || '未命名工作流',
        workflow: item.workflow,
        createdAt: Number(item.createdAt) || 0,
        lastTest: item.lastTest && typeof item.lastTest === 'object' ? {
          ok: Boolean(item.lastTest.ok),
          durationMs: Number(item.lastTest.durationMs) || 0,
          at: Number(item.lastTest.at) || 0,
          error: item.lastTest.error ? String(item.lastTest.error) : null,
        } : null,
      });
    }
    cfg[libKey] = cleaned;
    // 选中 id 必须是字符串且存在于库中，否则视为未选中（镜像字段原样保留，绝不丢工作流）
    cfg[activeKey] = typeof cfg[activeKey] === 'string' && cleaned.some((e) => e.id === cfg[activeKey])
      ? cfg[activeKey] : null;
    // 迁移：旧配置单槽位镜像非空而对应处理见下——幂等；异常时保留镜像，下次 load 重试
    try {
      const mirror = cfg[`${kind}Workflow`];
      if (mirror && typeof mirror === 'object' && !Array.isArray(mirror)) {
        const dup = cleaned.find((e) => JSON.stringify(e.workflow) === JSON.stringify(mirror));
        if (dup) {
          if (!cfg[activeKey]) cfg[activeKey] = dup.id;      // 内容已在库中 → 只补选中，不重复加
        } else if (!cleaned.length) {
          const id = contentId(`wf${kind}`, mirror);
          cleaned.push({
            id,
            name: String(cfg[`${kind}WorkflowName`] || '').trim() || '未命名工作流',
            workflow: mirror,
            createdAt: Date.now(),
            lastTest: null,
          });
          cfg[activeKey] = id;
        }
      }
    } catch { /* 迁移失败保留镜像，下次 load 重试，保证不丢工作流 */ }
  }
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
