// 全局 ComfyUI 接入配置：与具体项目解耦，落盘 data/comfyui.json
// 项目 settings 只保留「产物模式」这类与创作相关的开关，连接与 workflow 模板全局复用。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, uid } from './store.mjs';
import { parseWorkflow, describeInterfaceInputs, isBuiltinVarKey } from './comfyui.mjs';

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
  // 板块 → 接口档案 id：让封面 / 角色定妆 / 分镜 / 视频 / 音色各自选用不同的 ComfyUI 接口文件。
  // 未绑定的板块回退到该类别的 activeId（保持旧行为）。
  scopeBindings: {},
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

/**
 * 媒体生成板块：一个板块对应一类生成入口，可各自绑定不同的 ComfyUI 接口文件。
 * 例如封面用文生图、角色定妆用多参考生图、关键帧用图生图。
 */
export const MEDIA_SCOPES = [
  'cover', 'character', 'character-view', 'character-sheet',
  'keyframe', 'storyboard', 'transition', 'poster', 'grid',
  'video', 'voice',
];
export const SCOPE_KIND = {
  cover: 'image', character: 'image', 'character-view': 'image', 'character-sheet': 'image',
  keyframe: 'image', storyboard: 'image', transition: 'image', poster: 'image', grid: 'image',
  video: 'video', voice: 'audio',
};
/** 未识别的板块按出图处理（与 kindOf 的兜底策略一致） */
export const scopeKind = (scope) => SCOPE_KIND[String(scope || '')] || 'image';

/** 接口档案允许覆盖的全局参数；数值型单独钳制，其余按字符串保存 */
const PARAM_KEYS = [
  'negativePrompt', 'model', 'filenamePrefix',
  'width', 'height', 'fps', 'frames', 'steps', 'cfg', 'timeoutMs', 'pollIntervalMs',
];
const NUMERIC_PARAMS = new Set(['width', 'height', 'fps', 'frames', 'steps', 'cfg', 'timeoutMs', 'pollIntervalMs']);

/** 归一化「每个接口档案一套请求参数」；extra 是自定义 {{占位符}} 表 */
export function normalizeInterfaceParams(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const key of PARAM_KEYS) {
    const v = raw[key];
    if (v === undefined || v === null || v === '') continue;
    if (NUMERIC_PARAMS.has(key)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[key] = n;
    } else {
      out[key] = String(v).slice(0, 2000);
    }
  }
  if (raw.extra && typeof raw.extra === 'object' && !Array.isArray(raw.extra)) {
    const extra = {};
    for (const [k, v] of Object.entries(raw.extra).slice(0, 40)) {
      if (!/^[A-Za-z][\w.-]{0,40}$/.test(k)) continue;
      extra[k] = v && typeof v === 'object' ? JSON.stringify(v).slice(0, 2000) : String(v ?? '').slice(0, 2000);
    }
    if (Object.keys(extra).length) out.extra = extra;
  }
  return out;
}

/** 节点级覆盖：把模型名 / LoRA / 采样器等写进指定节点的指定输入 */
export function normalizeNodeOverrides(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 40)) {
    if (!item || typeof item !== 'object') continue;
    const node = String(item.node ?? '').trim().slice(0, 40);
    const input = String(item.input ?? '').trim().slice(0, 60);
    if (!node || !input) continue;
    const v = item.value;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') continue;   // 不接受对象 / 连线，避免破坏工作流图
    if (typeof v === 'string' && v.length > 2000) continue;
    out.push({ node, input, value: v });
  }
  return out;
}

/**
 * 接口输入参数表（可视化编辑的产物）：每行对应工作流里一个「节点 id + 输入名」。
 * source 决定该输入的取值来源：
 *   auto    → 未设置（默认）：完全沿用系统原有的自动识别 / 占位符注入；
 *   builtin → 写 {{varName}} 占位符，运行时由系统内置变量填充；
 *   fixed   → 写死 value（值里仍可含占位符）；
 *   agent   → 交给生图 Agent 按本次画面内容生成（value 作为兜底值）；
 *   skip    → 保持工作流里写死的原值，锁定不让自动识别改写。
 * 旧配置没有这个字段 → 空数组，行为与升级前完全一致。
 */
export const INPUT_SOURCES = ['auto', 'builtin', 'fixed', 'agent', 'skip'];

/**
 * 参数表显示顺序：纯展示语义，元素是 `node::input` 键。
 * 单独存一个数组而不塞进 inputSchema，因为后者只记录「非默认来源」的行，
 * 用它存顺序会让大量「自动识别」参数无法参与排序。
 * 缺省/非法 → 去重后取有效项；空数组 = 按工作流扫描顺序（升级前的行为）。
 */
export function normalizeInputOrder(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const v of raw.slice(0, 400)) {
    const key = String(v ?? '').trim().slice(0, 120);
    if (!key || !key.includes('::')) continue;
    const [node, input] = key.split('::');
    if (!node.trim() || !input.trim() || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * 中文备注表：节点备注键为节点 id，参数备注键为 `node::input`。
 * 独立于 workflow 本体存放，所以「✎ 接口 JSON」或重新导入同一份工作流都不会把备注冲掉。
 * 值只留 60 字以内的非空字符串；前端传全量表，清空某个备注直接删掉该键即可。
 */
export function normalizeNotes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, val] of Object.entries(raw).slice(0, 400)) {
    const k = String(key).trim().slice(0, 120);
    const v = typeof val === 'string' ? val.trim().slice(0, 60) : '';
    if (k && v) out[k] = v;
  }
  return out;
}

/** 按用户顺序重排输入清单；未出现在顺序表里的（工作流新增的）统一排到末尾 */
export function applyInputOrder(inputs = [], order = []) {
  const norm = normalizeInputOrder(order);
  if (!norm.length) return inputs;
  const rank = new Map(norm.map((k, i) => [k, i]));
  const known = [];
  const rest = [];
  for (const it of inputs) {
    if (rank.has(`${it.node}::${it.input}`)) known.push(it); else rest.push(it);
  }
  known.sort((a, b) => rank.get(`${a.node}::${a.input}`) - rank.get(`${b.node}::${b.input}`));
  return [...known, ...rest];
}

export function normalizeInputSchema(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 80)) {
    if (!item || typeof item !== 'object') continue;
    const node = String(item.node ?? '').trim().slice(0, 40);
    const input = String(item.input ?? '').trim().slice(0, 60);
    if (!node || !input) continue;
    const source = INPUT_SOURCES.includes(String(item.source || '')) ? String(item.source) : 'auto';
    const varName = isBuiltinVarKey(item.varName) ? String(item.varName).trim() : '';
    let value = item.value;
    if (value === null || value === undefined) value = '';
    else if (typeof value === 'object') value = '';
    else if (typeof value === 'string') value = value.slice(0, 2000);
    out.push({
      node, input, source, varName, value,
      label: String(item.label || '').trim().slice(0, 120),
      hint: String(item.hint || '').trim().slice(0, 300),
    });
  }
  return out;
}

/**
 * 连线槽位判定（与 comfyui.mjs 的 isLink 同口径）：[节点id, 输出序号] 恰好两项且第二项为数字。
 * 不能把「数组」一律当连线：多图 / 多素材参数本身就是数组，那样会被锁死改不了。
 */
const isLinkVal = (v) => Array.isArray(v) && v.length === 2
  && (typeof v[0] === 'string' || typeof v[0] === 'number')
  && typeof v[1] === 'number';

/**
 * 把可视化参数表编译成注入器能直接消费的 nodeOverrides + Agent 待办。
 * 与工作流本体比对：节点/输入已不存在或为连线时跳过并给 warnings，
 * 避免改过接口 JSON 之后旧配置把图连坏。
 */
export function compileInputSchema(schema = [], workflow = {}) {
  const overrides = [];
  const paramPlan = [];
  const warnings = [];
  for (const row of normalizeInputSchema(schema)) {
    const node = workflow?.[row.node];
    if (!node || !node.inputs || !(row.input in node.inputs)) {
      warnings.push(`输入 ${row.node}.${row.input} 不在当前接口 JSON 中，已跳过`);
      continue;
    }
    const current = node.inputs[row.input];
    const linked = isLinkVal(current);
    const isArr = !linked && Array.isArray(current);
    // 固定值与 Agent 兜底值按原值类型还原：数组 / 布尔 / 数字，避免 ComfyUI 类型校验失败
    const kind = isArr ? 'array' : typeof current === 'boolean' ? 'boolean'
      : typeof current === 'number' ? 'number' : 'none';
    if (linked && row.source !== 'skip') {
      warnings.push(`输入 ${row.node}.${row.input} 是连线槽位，已保留原连接`);
      continue;
    }
    if (row.source === 'builtin') {
      if (!row.varName) { warnings.push(`输入 ${row.node}.${row.input} 未选择内置变量，已跳过`); continue; }
      overrides.push({ node: row.node, input: row.input, value: `{{${row.varName}}}` });
    } else if (row.source === 'fixed') {
      // 多图 / 多值数组参数：固定值按 JSON 数组写回，否则传单个字符串会被 ComfyUI 拒绝
      overrides.push({ node: row.node, input: row.input, value: coerceFixed(row.value, kind, row, warnings) });
    } else if (row.source === 'agent') {
      paramPlan.push({
        node: row.node, input: row.input,
        label: row.label || row.input, hint: row.hint,
        fallback: row.value === '' ? undefined : coerceFixed(row.value, kind, row, warnings),
        multiple: isArr,
        kind,
      });
    } else if (row.source === 'skip' && !linked) {
      // skip：用工作流里的原值生成覆盖，标记 touched 后自动识别不会再改写它。
      // auto 必须落空（完全沿用原有自动识别），不能也生成锁定覆盖。
      overrides.push({ node: row.node, input: row.input, value: current });
    }
  }
  return { overrides, paramPlan, warnings };
}

/** 数组型输入的可视化值按 JSON 解析；解析失败保留原文并提示，不阻断保存 */
function parseFixedValue(value, isArr, row, warnings) {
  if (!isArr) return value;
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    warnings.push(`输入 ${row.node}.${row.input} 需要 JSON 数组，已按单项处理`);
    return [parsed];
  } catch {
    // 允许逗号分隔的简写（多图场景手写更方便）
    return text.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  }
}

/**
 * 固定值的类型还原：参数表里 value 一律是字符串，写回工作流时按原值类型转换。
 * - 数组：JSON 数组文本 / 逗号简写 → 真数组（ComfyUI 拒绝把数组收成字符串）
 * - 布尔：真值原样返回；字符串 "true"/"false"/"1"/"0" → 真布尔（下拉框回传的是字符串）
 * - 数字：真值原样返回；字符串数字 → Number（数值槽位写成字符串会被 ComfyUI 拒绝）
 */
function coerceFixed(value, kind, row, warnings) {
  if (kind === 'array') return parseFixedValue(value, true, row, warnings);
  if (kind === 'none') return value;
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (kind === 'boolean') {
    if (/^(true|1|是|开|yes|on)$/i.test(text)) return true;
    if (/^(false|0|否|关|no|off)$/i.test(text)) return false;
    if (!text) return value;
    warnings.push(`输入 ${row.node}.${row.input} 需要布尔值（true / false），已保留原文`);
    return value;
  }
  if (kind === 'number') {
    if (!text) return value;
    const num = Number(text);
    if (Number.isFinite(num)) return num;
    warnings.push(`输入 ${row.node}.${row.input} 需要数字，已保留原文`);
    return value;
  }
  return value;
}

/** 手写 nodeOverrides 与可视化参数表合并时，同一槽位以后者为准 */
function mergeNodeOverrides(hand, compiled) {
  const map = new Map();
  for (const o of [...(hand || []), ...(compiled || [])]) {
    if (o && o.node && o.input) map.set(`${o.node}::${o.input}`, o);
  }
  return [...map.values()];
}

/** 板块绑定表：只保留已知板块与合法 id，不校验 id 是否存在（导入顺序不丢绑定） */
function normalizeScopeBindings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const scope of MEDIA_SCOPES) {
    const v = raw[scope];
    if (typeof v === 'string' && v.trim()) out[scope] = v.trim().slice(0, 60);
  }
  return out;
}

/** 档案自带的显式绑定（可选）：与全局 bindings 同构 */
function normalizeEntryBindings(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 40).filter((b) => b && typeof b === 'object'
    && String(b.node ?? '').trim() && String(b.input ?? '').trim())
    .map((b) => ({
      node: String(b.node).trim().slice(0, 40),
      input: String(b.input).trim().slice(0, 60),
      value: String(b.value ?? '').slice(0, 2000),
    }));
}

function normalize(raw) {
  const cfg = { ...DEFAULT_COMFY, ...(raw || {}) };
  cfg.bindings = {
    image: Array.isArray(raw?.bindings?.image) ? raw.bindings.image : [],
    video: Array.isArray(raw?.bindings?.video) ? raw.bindings.video : [],
    audio: Array.isArray(raw?.bindings?.audio) ? raw.bindings.audio : [],
  };
  cfg.scopeBindings = normalizeScopeBindings(raw?.scopeBindings);
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
        // 接口档案自带的一套请求参数 / 节点覆盖 / 显式绑定 / 能力标签。
        // 老配置没有这些字段 → 补空值，解析时完全沿用全局参数，行为与升级前一致。
        params: normalizeInterfaceParams(item.params),
        nodeOverrides: normalizeNodeOverrides(item.nodeOverrides),
        bindings: normalizeEntryBindings(item.bindings),
        inputSchema: normalizeInputSchema(item.inputSchema),
        inputOrder: normalizeInputOrder(item.inputOrder),
        // 中文备注（节点 / 参数）：与 workflow 本体解耦，重新导入 JSON 不丢
        nodeNotes: normalizeNotes(item.nodeNotes),
        inputNotes: normalizeNotes(item.inputNotes),
        capability: String(item.capability || '').trim().slice(0, 40),
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
            params: {}, nodeOverrides: [], bindings: [], inputSchema: [], inputOrder: [], capability: '',
            nodeNotes: {}, inputNotes: {}, lastTest: null,
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
 * 宽高优先取项目成片规格按画幅选定的分辨率档位（runtime-spec 的 width/height），
 * 规格缺省时按画幅回落内置档（16:9 → 864×480，9:16 → 480×864），步数/CFG 用内置最优值。
 * 视频的 fps / frames 仍由用户在设置里配置。项目感知的组装点必须在本函数之后展开，
 * 保证用户此前手填或旧配置遗留的 width/height/steps/cfg 不再生效。
 */
export function imageSpecFor(aspect, resolution = null) {
  const portrait = String(aspect || '16:9') === '9:16';
  const w = Math.round(Number(resolution?.width));
  const h = Math.round(Number(resolution?.height));
  return {
    width: w > 0 ? w : (portrait ? 480 : 864),
    height: h > 0 ? h : (portrait ? 864 : 480),
    steps: 25, cfg: 1.0,
  };
}

/** 该类别是否配置了任何可用接口（镜像字段或库项）。用于「是否可生成」的粗粒度校验 */
export function hasWorkflowFor(cfg, kind) {
  const k = kindOf(kind);
  if (cfg?.[`${k}Workflow`]) return true;
  return Array.isArray(cfg?.[`${k}WorkflowLib`]) && cfg[`${k}WorkflowLib`].length > 0;
}

/** 跨三类库按 id 找接口档案：返回 {kind, entry} */
export function findInterface(cfg, id) {
  const key = String(id || '').trim();
  if (!key) return null;
  for (const kind of WORKFLOW_KINDS) {
    const entry = (Array.isArray(cfg?.[`${kind}WorkflowLib`]) ? cfg[`${kind}WorkflowLib`] : [])
      .find((e) => e.id === key);
    if (entry) return { kind, entry };
  }
  return null;
}

/**
 * 本次生成的唯一接口解析点。
 * 优先级：请求显式 interfaceId > 板块绑定 scopeBindings > 类别 activeId > 旧镜像字段。
 *
 * 返回 {config, workflow, bindings, interfaceId, interfaceName, kind, scope, via,
 *       params, nodeOverrides, extraValues, warnings}
 * config 已把该档案自带的参数合并（档案参数优先于全局），并挂上 nodeOverrides /
 * extraValues 供 injectWorkflow 消费；未选中任何档案时 config 与传入 cfg 同构，
 * 调用方拿不到 workflow 时按旧行为回退 Mock。
 */
export function resolveInterface(cfg = {}, opts = {}) {
  const kind = kindOf(opts.kind || scopeKind(opts.scope));
  const scope = String(opts.scope || '').trim();
  const warnings = [];
  const lib = Array.isArray(cfg?.[`${kind}WorkflowLib`]) ? cfg[`${kind}WorkflowLib`] : [];
  const byId = (id) => (id ? lib.find((e) => e.id === String(id)) : null) || null;

  let entry = null;
  let via = 'none';
  if (opts.interfaceId) {
    entry = byId(opts.interfaceId);
    if (entry) via = 'request';
    else warnings.push(`指定的接口档案 ${String(opts.interfaceId).slice(0, 40)} 不存在，已回退默认接口`);
  }
  if (!entry && scope && cfg?.scopeBindings?.[scope]) {
    entry = byId(cfg.scopeBindings[scope]);
    if (entry) via = 'scope';
    else warnings.push(`板块 ${scope} 绑定的接口档案不存在，已回退默认接口`);
  }
  if (!entry) {
    entry = byId(cfg?.[`${kind}ActiveId`]);
    if (entry) via = 'active';
  }
  const workflow = entry ? entry.workflow : (cfg?.[`${kind}Workflow`] || null);
  if (workflow && via === 'none') via = 'mirror';
  const params = normalizeInterfaceParams(entry?.params);
  const inputSchema = normalizeInputSchema(entry?.inputSchema);
  // 可视化输入参数表编译成节点覆盖（内置变量 / 固定值 / 锁定原值），
  // 标为「由 Agent 生成」的字段留到 runComfy 里按本次画面内容产出。
  const compiled = compileInputSchema(inputSchema, workflow || {});
  warnings.push(...compiled.warnings);
  // Agent 待办按用户调好的参数顺序排列，提示词更贴近人工整理的顺序（注入本身与顺序无关）
  const inputOrder = normalizeInputOrder(entry?.inputOrder);
  if (inputOrder.length) {
    const moved = applyInputOrder(compiled.paramPlan, inputOrder);
    compiled.paramPlan.length = 0;
    compiled.paramPlan.push(...moved);
  }
  const nodeOverrides = mergeNodeOverrides(normalizeNodeOverrides(entry?.nodeOverrides), compiled.overrides);
  const extraValues = params.extra || {};
  // 档案自带的显式绑定优先于全局绑定：图生图 / 多参考生图常需要不同的注入点
  const bindings = (Array.isArray(entry?.bindings) && entry.bindings.length
    ? entry.bindings : (cfg?.bindings?.[kind] || []));
  const config = {
    ...cfg,
    ...params,
    extraValues,
    nodeOverrides,
    inputSchema,
    inputOrder,
    paramPlan: compiled.paramPlan,
    [`${kind}Workflow`]: workflow,
    [`${kind}WorkflowName`]: entry ? entry.name : (cfg?.[`${kind}WorkflowName`] || ''),
  };
  return {
    config, workflow, bindings,
    interfaceId: entry?.id || null,
    interfaceName: entry ? entry.name : (cfg?.[`${kind}WorkflowName`] || ''),
    kind, scope, via, params, nodeOverrides, extraValues, inputSchema, inputOrder,
    paramPlan: compiled.paramPlan, warnings,
  };
}

/**
 * 组装项目生效的 ComfyUI 配置：全局 + 项目覆盖 + 画幅×成片规格。
 * 传入 opts.scope / opts.interfaceId 时按板块解析接口档案；此时档案里显式填写的
 * width/height 等参数优先于项目自动规格（留空才自动推断）。
 * 不传 opts 时返回值与升级前完全一致，所有旧调用点零改动。
 */
export function resolveComfyConfig(project, cfg, opts = {}) {
  const spec = project?.management?.runtime;
  const resolution = spec && Number(spec.width) > 0 && Number(spec.height) > 0
    ? { width: spec.width, height: spec.height } : null;
  const base = {
    ...(cfg || loadComfyConfig()),
    ...(project?.settings?.comfy || {}),
    ...imageSpecFor(project?.settings?.aspect, resolution),
  };
  if (!opts.scope && !opts.interfaceId && !opts.kind) return base;
  const resolved = resolveInterface(base, {
    kind: opts.kind || scopeKind(opts.scope),
    scope: opts.scope,
    interfaceId: opts.interfaceId,
  });
  return {
    ...resolved.config,
    // 档案自带的显式绑定直接替换该类别的全局绑定，消费端读 cfg.bindings[kind] 即可
    bindings: { ...(base.bindings || {}), [resolved.kind]: resolved.bindings },
    resolvedInterface: {
      id: resolved.interfaceId, name: resolved.interfaceName,
      kind: resolved.kind, scope: resolved.scope, via: resolved.via,
      warnings: resolved.warnings,
    },
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

/** 给前端的库概览：只回 id/名称/节点数/测试结果，不重复塞 workflow 本体。
 *  字段集合保持旧契约不变（既有前端与测试都依赖它）；接口档案的参数详情
 *  由 interfaceOverview / GET /api/comfyui/interfaces 单独下发。 */
function libOverview(lib) {
  return Array.isArray(lib) ? lib.map((e) => ({
    id: e.id, name: e.name, nodes: Object.keys(e.workflow || {}).length,
    createdAt: e.createdAt, lastTest: e.lastTest,
  })) : [];
}

/** 全部接口档案的扁平概览：参数 / 节点覆盖 / 能力 / 板块绑定（不含 workflow 本体） */
export function interfaceOverview(cfg = loadComfyConfig()) {
  const out = [];
  for (const kind of WORKFLOW_KINDS) {
    const lib = Array.isArray(cfg[`${kind}WorkflowLib`]) ? cfg[`${kind}WorkflowLib`] : [];
    for (const e of lib) {
      const slots = describeInterfaceInputs(e.workflow || {});
      out.push({
        id: e.id, name: e.name, kind,
        nodes: Object.keys(e.workflow || {}).length,
        createdAt: e.createdAt, lastTest: e.lastTest,
        capability: e.capability || '',
        params: e.params || {},
        nodeOverrides: e.nodeOverrides || [],
        bindings: e.bindings || [],
        inputSchema: e.inputSchema || [],
        inputOrder: e.inputOrder || [],
        // 参数表只列需要人填的槽位：inputCount = 可编辑项，linkCount = 被隐藏的连线槽位
        inputCount: slots.filter((i) => i.editable).length,
        linkCount: slots.filter((i) => !i.editable).length,
        active: cfg[`${kind}ActiveId`] === e.id,
        boundScopes: Object.entries(cfg.scopeBindings || {})
          .filter(([, id]) => id === e.id).map(([scope]) => scope),
      });
    }
  }
  return out;
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
    interfaces: interfaceOverview(cfg),
    scopeBindings: { ...(cfg.scopeBindings || {}) },
    scopes: MEDIA_SCOPES.map((scope) => ({ id: scope, kind: scopeKind(scope) })),
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
    // 同一份工作流改名重新导入时，中文备注应当跟着走（备注独立于 JSON 内容）
    const twin = lib.find((e) => JSON.stringify(e.workflow) === content);
    let finalName = name;
    if (lib.some((e) => e.name === name)) {
      let n = 2;
      while (lib.some((e) => e.name === `${name} (${n})`)) n += 1;
      finalName = `${name} (${n})`;
    }
    const entry = {
      id: uid('wf'), name: finalName, workflow: wf, createdAt: Date.now(), lastTest: null,
      params: normalizeInterfaceParams(item?.params),
      nodeOverrides: normalizeNodeOverrides(item?.nodeOverrides),
      bindings: normalizeEntryBindings(item?.bindings),
      inputSchema: normalizeInputSchema(item?.inputSchema),
      inputOrder: normalizeInputOrder(item?.inputOrder),
      nodeNotes: normalizeNotes(twin?.nodeNotes),
      inputNotes: normalizeNotes(twin?.inputNotes),
      capability: String(item?.capability || '').trim().slice(0, 40),
    };
    lib.push(entry);
    added.push({ id: entry.id, name: finalName, nodes: Object.keys(wf).length, kind: k });
  }
  return { added, failed, lib };
}
