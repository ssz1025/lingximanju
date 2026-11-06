// ComfyUI 本地 API 客户端
// 设计目标：用户把 ComfyUI 里「导出(API)」得到的 workflow JSON 原样贴进来即可运行，
// 不要求改写节点图。参数注入有三层优先级：显式绑定 > {{占位符}} > 按 class_type 自动识别。
//
// 官方链路：POST /prompt → 轮询 /history/{prompt_id} → GET /view 下载产物
// 参考图：POST /upload/image（multipart）→ 把返回的 name 写进 LoadImage.image
import { writeAsset, uid } from './store.mjs';
import { placeholderFrame } from './raster.mjs';

const PLACEHOLDER_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;
const VIDEO_EXTS = /\.(mp4|webm|mov|mkv|m4v|gif)$/i;
const IMAGE_EXTS = /\.(png|jpe?g|webp|bmp)$/i;

export function parseWorkflow(input, label = 'workflow') {
  let wf = input;
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) throw new Error(`${label} 为空`);
    try { wf = JSON.parse(text); } catch { throw new Error(`${label} 不是合法 JSON`); }
  }
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) throw new Error(`${label} 必须是 JSON 对象`);
  if (Array.isArray(wf.nodes) || Array.isArray(wf.links)) {
    throw new Error('这是 ComfyUI 界面保存格式。请在 ComfyUI 工作流菜单选择「导出(API) / Export (API)」后再导入。');
  }
  const entries = Object.entries(wf).filter(([id]) => !String(id).startsWith('_'));
  if (!entries.length) throw new Error(`${label} 没有任何节点`);
  for (const [id, node] of entries) {
    if (!node || typeof node !== 'object' || typeof node.class_type !== 'string') {
      throw new Error(`节点 ${id} 缺少 class_type，请确认导出的是 API 格式`);
    }
    if (!node.inputs || typeof node.inputs !== 'object') {
      throw new Error(`节点 ${id} 缺少 inputs，请确认导出的是 API 格式`);
    }
  }
  // 丢弃 _comment 等说明字段，避免把非节点对象提交给 /prompt
  return Object.fromEntries(entries);
}

/** 扫描工作流，给出自动识别到的可注入位置（供设置页展示与测试） */
export function analyzeWorkflow(wf) {
  const found = [];
  const textNodes = [];
  for (const [id, node] of Object.entries(wf)) {
    if (String(id).startsWith('_')) continue;
    const push = (input, role) => found.push({ node: id, classType: node.class_type, input, role, value: node.inputs[input] });
    for (const key of Object.keys(node.inputs)) {
      const val = node.inputs[key];
      if (typeof val === 'string' && PLACEHOLDER_RE.test(val)) {
        PLACEHOLDER_RE.lastIndex = 0;
        const keys = [...val.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
        PLACEHOLDER_RE.lastIndex = 0;
        push(key, `占位符 ${keys.join(',')}`);
      }
      if (/^(seed|noise_seed|rand_seed)$/i.test(key)) push(key, 'seed');
      if (/^(width|height)$/i.test(key) && Number.isFinite(Number(val))) push(key, key.toLowerCase());
      if (/^(num_frames|frame_count|length|total_frames)$/i.test(key) && Number.isFinite(Number(val))) push(key, 'frames');
      if (/^fps$/i.test(key)) push(key, 'fps');
      if (/^filename_prefix$/i.test(key)) push(key, 'outputPrefix');
      if (/^(steps|cfg)$/i.test(key) && Number.isFinite(Number(val))) push(key, key.toLowerCase());
    }
    if (/CLIPTextEncode/i.test(node.class_type) && typeof node.inputs.text === 'string') {
      textNodes.push({ node: id, text: node.inputs.text });
    }
    if (/^(LoadImage|LoadImageMask)$/i.test(node.class_type)) push('image', 'loadImage');
    if (/^(SaveImage|SaveAnimatedWEBP|SaveAnimatedPNG|VHS_VideoCombine|SaveVideo|PreviewImage)$/i.test(node.class_type)) {
      push('_output', 'outputNode');
    }
  }
  textNodes.sort((a, b) => String(a.node).localeCompare(String(b.node), 'en', { numeric: true }));
  textNodes.forEach((t, i) => found.push({
    node: t.node, classType: 'CLIPTextEncode', input: 'text',
    role: i === 0 ? 'positive' : i === 1 ? 'negative' : 'text', value: t.text,
  }));
  return found;
}

function seedValue(seedText = '') {
  let h = 2166136261;
  const s = `${seedText}|${Date.now()}|${Math.random()}`;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 4294967295;
}

function resolveVars(vars) {
  const cfg = vars.cfg || {};
  return {
    prompt: String(vars.prompt ?? ''),
    negative_prompt: String(vars.negative ?? cfg.negativePrompt ?? ''),
    seed: seedValue(String(vars.seed ?? '')),
    width: Number(cfg.width) || 864,
    height: Number(cfg.height) || 480,
    fps: Number(cfg.fps) || 24,
    frames: Number(vars.frames || cfg.frames) || 124,
    duration: Number(vars.duration) || 5,
    steps: Number(cfg.steps) || 25,
    cfg: Number(cfg.cfg) || 1.0,
    filename_prefix: String(vars.filenamePrefix || 'lingximanju'),
    image: String(vars.imageName || ''),
    title: String(vars.title || ''),
    shot_no: String(vars.shotNo || ''),
    motion: String(vars.motion || ''),
  };
}

/**
 * 把变量注入 workflow。返回 { prompt, applied, uploadSlots, outputNodes }
 * 不修改传入的 workflow 对象。
 */
export function injectWorkflow(workflow, vars = {}, bindings = []) {
  const wf = JSON.parse(JSON.stringify(workflow));
  const values = resolveVars(vars);
  const applied = [];
  const uploadSlots = [];
  const outputNodes = [];
  const touched = new Set(); // 已被占位符/显式绑定处理过的 node::input

  const replace = (str) => String(str).replace(PLACEHOLDER_RE, (_, key) => {
    const val = values[key];
    return val === undefined ? `{{${key}}}` : String(val);
  });

  // 1) 占位符：任何字符串输入（以及 link 之外的字符串）都支持
  for (const [id, node] of Object.entries(wf)) {
    if (String(id).startsWith('_')) continue;
    for (const [key, val] of Object.entries(node.inputs)) {
      if (typeof val === 'string' && PLACEHOLDER_RE.test(val)) {
        PLACEHOLDER_RE.lastIndex = 0;
        const next = replace(val);
        PLACEHOLDER_RE.lastIndex = 0;
        if (next !== val) {
          node.inputs[key] = next;
          applied.push({ node: id, input: key, value: next, by: 'placeholder' });
          touched.add(`${id}::${key}`);
        }
      }
    }
  }

  // 2) 自动识别：只处理未被占位符覆盖的字段
  const auto = (id, node, key, value, role) => {
    if (touched.has(`${id}::${key}`) || value === undefined) return;
    if (!(key in node.inputs)) return;
    node.inputs[key] = value;
    applied.push({ node: id, input: key, value, by: `auto:${role}` });
    touched.add(`${id}::${key}`);
  };
  const textNodes = Object.entries(wf)
    .filter(([id, n]) => !String(id).startsWith('_') && /CLIPTextEncode/i.test(n.class_type) && typeof n.inputs.text === 'string')
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en', { numeric: true }));

  for (const [id, node] of Object.entries(wf)) {
    if (String(id).startsWith('_')) continue;
    for (const [key, val] of Object.entries(node.inputs)) {
      if (touched.has(`${id}::${key}`)) continue;
      if (/^(seed|noise_seed|rand_seed)$/i.test(key)) auto(id, node, key, values.seed, 'seed');
      else if (key === 'width' && Number.isFinite(Number(val))) auto(id, node, key, values.width, 'width');
      else if (key === 'height' && Number.isFinite(Number(val))) auto(id, node, key, values.height, 'height');
      else if (/^(num_frames|frame_count|total_frames)$/i.test(key) && Number.isFinite(Number(val))) auto(id, node, key, values.frames, 'frames');
      else if (key === 'length' && /Video|Animate|WAN|H3|Frame/i.test(node.class_type) && Number.isFinite(Number(val))) auto(id, node, key, values.frames, 'frames');
      else if (key === 'fps' && Number.isFinite(Number(val))) auto(id, node, key, values.fps, 'fps');
      else if (key === 'filename_prefix') auto(id, node, key, values.filename_prefix, 'outputPrefix');
    }
    if (/^(LoadImage|LoadImageMask)$/i.test(node.class_type)) {
      uploadSlots.push({ node: id, input: 'image' });
    }
    if (/^(SaveImage|SaveAnimatedWEBP|SaveAnimatedPNG|VHS_VideoCombine|SaveVideo|PreviewImage)$/i.test(node.class_type)) {
      outputNodes.push({ node: id, classType: node.class_type });
    }
  }
  // 文本节点：第一个为正向、第二个为负向（若原文本自带占位符则已被 touched 跳过）
  if (textNodes[0]) auto(textNodes[0][0], textNodes[0][1], 'text', values.prompt, 'positive');
  if (textNodes[1] && values.negative_prompt) auto(textNodes[1][0], textNodes[1][1], 'text', values.negative_prompt, 'negative');

  // 3) 显式绑定优先级最高
  for (const b of bindings || []) {
    const id = String(b.node ?? '').trim();
    const key = String(b.input ?? '').trim();
    if (!id || !key || !wf[id]) continue;
    wf[id].inputs[key] = replace(String(b.value ?? ''));
    applied.push({ node: id, input: key, value: wf[id].inputs[key], by: 'binding' });
  }

  return { prompt: wf, applied, uploadSlots, outputNodes, values };
}

async function requestJSON(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const detail = body?.error || text.slice(0, 300) || `HTTP ${res.status}`;
    const nodeErrors = body?.node_errors
      ? `；节点错误：${JSON.stringify(body.node_errors).slice(0, 600)}` : '';
    throw new Error(`${detail}${nodeErrors}`);
  }
  return body;
}

export async function testConnection(baseUrl, signal) {
  const base = String(baseUrl).replace(/\/+$/, '');
  try {
    const stats = await requestJSON(`${base}/system_stats`, { signal });
    return {
      ok: true, baseUrl: base,
      version: stats?.system?.comfyui_version || stats?.system?.python_version || 'unknown',
      device: stats?.devices?.[0]?.name || 'unknown',
      vram: stats?.devices?.[0]?.vram_total || null,
    };
  } catch (primary) {
    // 老版本没有 /system_stats，降级探测根路由
    try {
      const res = await fetch(base, { signal });
      if (res.ok) return { ok: true, baseUrl: base, version: 'legacy', device: 'unknown', note: '未暴露 /system_stats' };
    } catch { /* ignore */ }
    throw new Error(`无法连接 ${base}：${primary.message}`);
  }
}

/** POST /upload/image，multipart 手写，无第三方依赖 */
export async function uploadImage(config, buffer, filename = 'reference.png', signal) {
  const base = config.baseUrl;
  const boundary = `----lingximanju${Date.now().toString(36)}`;
  const safeName = String(filename).replace(/[^A-Za-z0-9_.-]/g, '_');
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${safeName}"\r\n` +
    `Content-Type: image/png\r\n\r\n`, 'utf8');
  const tail = Buffer.from(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n` +
    `--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([head, Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer)), tail]);
  const res = await fetch(`${base}/upload/image`, {
    method: 'POST', signal,
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`参考图上传失败：${text.slice(0, 200)}`);
  let out = {};
  try { out = JSON.parse(text); } catch { /* 有些版本返回纯文本 */ }
  return { name: out.name || safeName, subfolder: out.subfolder || '', type: out.type || 'input' };
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('已取消', 'AbortError')); }, { once: true });
});

/** 从 history outputs 中提取所有可下载文件 */
function collectOutputs(history) {
  const files = [];
  for (const [nodeId, out] of Object.entries(history?.outputs || {})) {
    for (const key of ['images', 'gifs', 'videos', 'audio', 'files']) {
      for (const item of out?.[key] || []) {
        if (!item || typeof item !== 'object') continue;
        const filename = item.filename || item.name;
        if (!filename) continue;
        files.push({
          nodeId, key, filename,
          subfolder: item.subfolder || '',
          type: item.type || 'output',
        });
      }
    }
  }
  return files;
}

async function downloadOutput(config, file, signal) {
  const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
  const res = await fetch(`${config.baseUrl}/view?${q}`, { signal });
  if (!res.ok) throw new Error(`下载产物失败 ${file.filename}：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (file.filename.match(/\.[A-Za-z0-9]{1,6}$/) || ['.png'])[0].toLowerCase();
  const kind = VIDEO_EXTS.test(file.filename) ? 'video'
    : IMAGE_EXTS.test(file.filename) ? 'image' : 'file';
  const name = `${uid('comfy')}${ext}`;
  const url = writeAsset(name, buf);
  return { url, file: name, filename: file.filename, kind, nodeId: file.nodeId, bytes: buf.length };
}

/**
 * 完整执行一次 API 格式工作流。
 * @returns {Promise<{assets:Array, primary:Object|null, promptId:string, applied:Array, durationMs:number}>}
 */
export async function runWorkflow(config, workflow, vars = {}, opts = {}) {
  const { signal, log = () => {}, bindings = [] } = opts;
  const built = injectWorkflow(workflow, vars, bindings);
  const prompt = built.prompt;

  // 参考图：优先用调用方给的 buffer，否则按帧信息生成一张合法 PNG 占位
  if (built.uploadSlots.length) {
    let buffer = vars.imageBuffer;
    let name = vars.imageName || 'reference.png';
    if (!buffer) {
      buffer = placeholderFrame({ seed: vars.seed, shotNo: vars.shotNo, style: vars.style, kind: 'reference' });
      name = 'lingximanju_reference.png';
    }
    if (!IMAGE_EXTS.test(name)) name = `${name.replace(/\.[^.]+$/, '')}.png`;
    const uploaded = await uploadImage(config, buffer, name, signal);
    for (const slot of built.uploadSlots) {
      if (!prompt[slot.node]) continue;
      const rel = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
      prompt[slot.node].inputs[slot.input] = rel;
      built.applied.push({ node: slot.node, input: slot.input, value: rel, by: 'auto:uploadImage' });
    }
    log('info', `参考图已上传至 ComfyUI input：${uploaded.name}`);
  }

  const t0 = Date.now();
  const queued = await requestJSON(`${config.baseUrl}/prompt`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: config.clientId || 'lingximanju' }),
  });
  const promptId = queued?.prompt_id;
  if (!promptId) throw new Error('ComfyUI 未返回 prompt_id');
  log('info', `ComfyUI 已排队 ${promptId} · 注入 ${built.applied.length} 个参数`);

  let history = null;
  const deadline = Date.now() + (config.timeoutMs || 900000);
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
    const body = await requestJSON(`${config.baseUrl}/history/${encodeURIComponent(promptId)}`, { signal });
    const item = body?.[promptId];
    if (item) {
      const status = item.status || {};
      if (status.status_str === 'error' || status.completed === true && status.status_str !== 'success' && !Object.keys(item.outputs || {}).length) {
        const msg = (status.messages || []).map((m) => JSON.stringify(m)).join(' | ').slice(0, 500);
        throw new Error(`ComfyUI 执行失败：${msg || status.status_str || '未知错误'}`);
      }
      if (Object.keys(item.outputs || {}).length) { history = item; break; }
    }
    await sleep(config.pollIntervalMs || 1000, signal);
  }
  if (!history) throw new Error(`ComfyUI 执行超时（${Math.round((config.timeoutMs || 0) / 1000)}s）`);

  const outputs = collectOutputs(history);
  if (!outputs.length) throw new Error('工作流完成但没有可下载的输出节点（请确认工作流里有 SaveImage / VHS_VideoCombine 等输出节点）');
  const assets = [];
  for (const file of outputs.slice(0, 24)) {
    try { assets.push(await downloadOutput(config, file, signal)); }
    catch (err) { log('warn', `产物 ${file.filename} 下载失败：${err.message}`); }
  }
  if (!assets.length) throw new Error('所有产物下载失败');
  const primary = assets.find((a) => a.kind === 'video') || assets.find((a) => a.kind === 'image') || assets[0];
  log('info', `ComfyUI 完成 · ${assets.length} 个产物 · ${Date.now() - t0}ms`);
  return { assets, primary, promptId, applied: built.applied, durationMs: Date.now() - t0 };
}

/**
 * 把画布上的一个图片 URL 变成可上传给 ComfyUI 的二进制。
 * SVG 无法被 ComfyUI LoadImage 读取，统一渲染为等价的 PNG 占位。
 */
export function prepareReferenceImage(url, opts = {}) {
  if (!url) return null;
  if (/\.svg(\?|$)/i.test(String(url))) {
    return {
      buffer: placeholderFrame({ seed: opts.seed || url, shotNo: opts.shotNo || 1, style: opts.style, kind: 'reference' }),
      name: 'lingximanju_reference.png',
      converted: true,
    };
  }
  return null; // 真实 png/jpg 由调用方从本地资产目录读取
}
