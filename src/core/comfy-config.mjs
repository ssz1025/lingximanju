// 全局 ComfyUI 接入配置：与具体项目解耦，落盘 data/comfyui.json
// 项目 settings 只保留「产物模式」这类与创作相关的开关，连接与 workflow 模板全局复用。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, uid } from './store.mjs';
import { parseWorkflow } from './comfyui.mjs';

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
  // 音色抽卡工作流（TTS / 语音克隆）：抽卡时按 seed 与说话人轮换注入朗读文案，
  // 产出真实音频后进候选池，满意再保存为音色。
  audioWorkflow: null,
  imageWorkflowName: '',
  videoWorkflowName: '',
  audioWorkflowName: '',
  // 工作流库：多导入 + 选中生效。选中项会镜像回填到上面的 imageWorkflow/videoWorkflow，
  // 因此 providers / director-pack / run-test / comfySummary 等消费端零改动。
  imageWorkflowLib: [],   // [{id, name, workflow, createdAt, lastTest:{ok,durationMs,at,error}|null}]
  videoWorkflowLib: [],
  audioWorkflowLib: [],
  imageActiveId: null,
  videoActiveId: null,
  audioActiveId: null,
  bindings: { image: [], video: [], audio: [] }, // 显式绑定 [{node:'6', input:'text', value:'{{prompt}}'}]
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

/** 工作流种类：image=出图 / video=图生视频 / audio=音色抽卡（TTS） */
export const WORKFLOW_KINDS = ['image', 'video', 'audio'];
/** 任意输入串归一为合法 kind；未识别一律按出图（历史行为） */
export const kindOf = (v) => (WORKFLOW_KINDS.includes(v) ? v : 'image');

function normalize(raw) {
  const cfg = { ...DEFAULT_COMFY, ...(raw || {}) };
  cfg.bindings = {
    image: Array.isArray(raw?.bindings?.image) ? raw.bindings.image : [],
    video: Array.isArray(raw?.bindings?.video) ? raw.bindings.video : [],
    audio: Array.isArray(raw?.bindings?.audio) ? raw.bindings.audio : [],
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
  for (const kind of WORKFLOW_KINDS) {
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

/**
 * 图片规格智能默认（agent 决定，用户无需填写）：
 * 宽高由画幅自动映射（16:9 → 864×480，9:16 → 480×864），步数/CFG 用内置最优值。
 * 视频的 fps / frames 仍由用户在设置里配置。项目感知的组装点必须在本函数之后展开，
 * 保证用户此前手填或旧配置遗留的 width/height/steps/cfg 不再生效。
 */
export function imageSpecFor(aspect) {
  const portrait = String(aspect || '16:9') === '9:16';
  return { width: portrait ? 480 : 864, height: portrait ? 864 : 480, steps: 25, cfg: 1.0 };
}

/** 组装项目生效的 ComfyUI 配置：全局 + 项目覆盖 + 画幅图片规格（规格永远自动决定） */
export function resolveComfyConfig(project, cfg) {
  return {
    ...(cfg || loadComfyConfig()),
    ...(project?.settings?.comfy || {}),
    ...imageSpecFor(project?.settings?.aspect),
  };
}

export function saveComfyConfig(patch = {}) {
  const merged = { ...loadComfyConfig(), ...patch };
  // 切换选中：从库回填「当前生效」镜像；id 不在库中 → 清空（回退 Mock）
  for (const kind of WORKFLOW_KINDS) {
    const activeKey = `${kind}ActiveId`;
    if (!(activeKey in patch)) continue;   // 普通保存不碰镜像
    const entry = (merged[`${kind}WorkflowLib`] || []).find((e) => e.id === patch[activeKey]);
    merged[`${kind}Workflow`] = entry ? entry.workflow : null;
    merged[`${kind}WorkflowName`] = entry ? entry.name : '';
  }
  const next = normalize(merged);
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
  return next;
}

/** 给前端的库概览：只回 id/名称/节点数/测试结果，不重复塞 workflow 本体 */
function libOverview(lib) {
  return Array.isArray(lib) ? lib.map((e) => ({
    id: e.id, name: e.name, nodes: Object.keys(e.workflow || {}).length,
    createdAt: e.createdAt, lastTest: e.lastTest,
  })) : [];
}

/** 给前端的概览：不把整份 workflow 重复塞进每个项目 */
export function comfySummary(cfg = loadComfyConfig()) {
  return {
    enabled: cfg.enabled, baseUrl: cfg.baseUrl, strict: cfg.strict,
    outputMode: cfg.outputMode, packTarget: cfg.packTarget, stitch: cfg.stitch,
    width: cfg.width, height: cfg.height, fps: cfg.fps, frames: cfg.frames,
    imageWorkflow: cfg.imageWorkflow ? { name: cfg.imageWorkflowName, nodes: Object.keys(cfg.imageWorkflow).length } : null,
    videoWorkflow: cfg.videoWorkflow ? { name: cfg.videoWorkflowName, nodes: Object.keys(cfg.videoWorkflow).length } : null,
    audioWorkflow: cfg.audioWorkflow ? { name: cfg.audioWorkflowName, nodes: Object.keys(cfg.audioWorkflow).length } : null,
    imageWorkflowLib: libOverview(cfg.imageWorkflowLib),
    videoWorkflowLib: libOverview(cfg.videoWorkflowLib),
    audioWorkflowLib: libOverview(cfg.audioWorkflowLib),
  };
}

/**
 * 批量导入工作流到库（纯计算，不落盘）。
 * 逐项 parseWorkflow 校验：非法项进 failed 不阻断合法项；
 * 同名同内容 → 跳过报「已存在」；同名不同内容 → 名称自动加 (2) 后缀。
 * @returns {{added: Array<{id,name,nodes}>, failed: Array<{name,error}>, lib: Array}}
 */
export function addLibraryItems(cfg, kind, items) {
  const k = kindOf(kind);
  const libKey = `${k}WorkflowLib`;
  const lib = (Array.isArray(cfg[libKey]) ? cfg[libKey] : []).slice();
  const added = [];
  const failed = [];
  for (const item of items || []) {
    const name = String(item?.name || '').trim() || '未命名工作流';
    let wf;
    try {
      wf = parseWorkflow(item?.workflow, name);
    } catch (err) {
      failed.push({ name, error: err.message });
      continue;
    }
    const content = JSON.stringify(wf);
    if (lib.some((e) => e.name === name && JSON.stringify(e.workflow) === content)) {
      failed.push({ name, error: '已存在（同名同内容），已跳过' });
      continue;
    }
    let finalName = name;
    if (lib.some((e) => e.name === name)) {
      let n = 2;
      while (lib.some((e) => e.name === `${name} (${n})`)) n += 1;
      finalName = `${name} (${n})`;
    }
    const entry = { id: uid('wf'), name: finalName, workflow: wf, createdAt: Date.now(), lastTest: null };
    lib.push(entry);
    added.push({ id: entry.id, name: finalName, nodes: Object.keys(wf).length });
  }
  return { added, failed, lib };
}
