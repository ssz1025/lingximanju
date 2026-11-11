/* ============================================================================
 * 统一 AI 对话的应用层接线（chat-hub.js）
 *
 * 职责：
 *  ① 打开统一面板（全项目只有一个面板，重复打开只是切档位）
 *  ② 承接面板发来的**客户端动作**——真正要碰浏览器的东西：
 *     封面参考图上传 / 资源库选图 / 封面出图 / 风格保存 / 画布定位……
 *     这些动作在服务端做不了（要文件选择器、要资源库弹窗、要 ComfyUI 结果确认），
 *     做完之后一律用 append 端点把产物回写进同一条线程。
 *
 * 服务端的统一线程在 src/core/ai-thread.mjs；面板 UI 在 public/chat-panel.js。
 * ==========================================================================*/
import { openChatPanel } from './chat-panel.js';
import { openAssetLibrary } from './asset-manager.js';
import { openGeneratedConfirm } from './project-manager.js';
import { esc } from './utils.js';
import { withModelId, pickedModelId } from './model-picker.js';
import { withInterfaceId } from './interface-picker.js';

/** 各档位的模型入口：模型下拉按「项目 + 档位」分别记忆 */
const MODEL_ENTRY = { cover: 'cover', canvas: 'canvas', style: 'style', project: 'chat' };

/** 面板句柄（当前打开的统一面板） */
let panel = null;

/** 封面档的临时状态：参考图与最近一次提示词（随面板存活，不进项目 JSON） */
const coverState = { refs: [], prompt: '', negative: '', generated: null, coverUrl: '' };

/**
 * 打开统一 AI 对话面板。
 * @param {object} o
 * @param {string} o.projectId
 * @param {string} [o.projectName]
 * @param {string} [o.scope]     打开时定位的档位
 * @param {Function} [o.onChanged] 数据变化回调（外层据此刷新面板 / 画布）
 */
export function openAIChat(o = {}) {
  const { projectId, projectName = '', scope = 'project', onChanged = null, prefill = '' } = o;
  if (!projectId) return null;
  panel = openChatPanel({
    projectId,
    projectName,
    scope,
    prefill,
    onChanged: async () => { await onChanged?.(); },
    onAction: (act, ctx) => handleClientAction(act, ctx),
  });
  return panel;
}

/** 当前面板是否已开 */
export function aiChatOpen() {
  return Boolean(panel);
}

/**
 * 服务端事件转发给统一面板（制片助手的后台任务完成后把结果补进线程）。
 * @param {object} e SSE 事件
 */
export function onServerEvent(e) {
  panel?.onServerEvent?.(e);
}

/**
 * 客户端动作分发：面板上的「上传参考图」「一键生成封面」「保存导演风格」等按钮。
 * 任何一步失败都要把原因写回线程——静默失败会让用户以为按钮没生效。
 */
async function handleClientAction(act, ctx = {}) {
  const scope = ctx.scope || 'project';
  const projectId = panel?.projectId;
  if (!projectId) return;

  try {
    if (act === 'cover.one-click') return await coverOneClick(projectId);
    if (act === 'cover.upload-refs') return await coverUploadRefs(projectId);
    if (act === 'cover.pick-refs') return await coverPickRefs(projectId);
    if (act === 'cover.upload-cover') return await coverUploadCover(projectId);
    if (act === 'cover.from-library-cover') return await coverFromLibrary(projectId);
    if (act === 'cover.reset-cover') return await coverReset(projectId);
    if (act === 'cover.confirm') return await coverConfirm(projectId, ctx.message?.extra?.generated);
    if (act === 'style.save') return await styleSave(projectId);
  } catch (err) {
    // 出图这类动作可能要跑一两分钟，失败原因必须回到线程里
    await panel?.writeBack?.({ role: 'assistant', text: `✗ ${err.message}` });
    return undefined;
  }
  return undefined;
}

/** 封面档：把参考图 / 提示词等状态写回线程，让关窗再打开也不丢 */
async function coverWriteBack(projectId, patch = {}) {
  return panel?.writeBack?.({
    role: 'assistant',
    text: patch.text || '',
    images: patch.images || [],
    promptBlock: patch.promptBlock || null,
    links: patch.links || [],
    actions: patch.actions || [],
    extra: { ...(patch.extra || {}), cover: { refs: coverState.refs.map((r) => ({ name: r.name, url: r.url })) } },
  });
}

/** 一键生成封面：先让 AI 写提示词，再直接出图，出完写回线程 */
async function coverOneClick(projectId) {
  const d = await postJson(`/api/projects/${projectId}/ai/chat`, {
    scope: 'cover',
    message: '一键生成封面',
    modelId: pickedModelId(MODEL_ENTRY.cover),
  });
  panel?.mergeAppended?.(d.appended || []);
  const last = (d.appended || []).filter((m) => m.role === 'assistant').at(-1);
  coverState.prompt = last?.promptBlock?.prompt || '';
  coverState.negative = last?.promptBlock?.negative || '';
  // 提示词已经有了：接着出图
  if (coverState.prompt) await coverGenerate(projectId);
}

/** 封面出图：调 ComfyUI，产物写回线程（图片 + 提示词块 + 确认按钮） */
async function coverGenerate(projectId) {
  if (!coverState.prompt) return;
  const d = await postJson(`/api/projects/${projectId}/cover/generate`, withInterfaceId('cover', {
    prompt: coverState.prompt,
    negative: coverState.negative,
    refs: coverState.refs.map((r) => (r.file ? { asset: r.file } : { dataUrl: r.dataUrl })),
  }));
  const g = d.generated || {};
  coverState.generated = g;
  await coverWriteBack(projectId, {
    text: `✓ 封面已生成${d.durationMs ? ` · ${(d.durationMs / 1000).toFixed(1)}s` : ''}，放大确认后才会保存为项目封面`,
    images: g.url ? [g.url] : [],
    promptBlock: { prompt: coverState.prompt, negative: coverState.negative },
    links: g.file ? [{ label: '⤓ 下载封面原图', url: `/api/assets/${g.file}` }] : [],
    actions: g.file ? [{ label: '👁 放大确认', act: 'cover.confirm', primary: true }] : [],
    extra: { generated: g },
  });
}

/**
 * 放大确认 → 保存为封面：沿用既有的「确认才保存」契约（不确认就只留在资源库）。
 * 生成结果**先内联在统一线程里**给用户看，确认页只是放大与最后一步。
 */
async function coverConfirm(projectId, generated) {
  const g = generated || coverState.generated;
  if (!g?.file || !g?.url) return;
  openGeneratedConfirm({
    project: { id: projectId },
    // 确认页的提示要回到同一条线程，而不是另开一个对话框
    ui: { addMessage: (m) => panel?.writeBack?.({ ...m }) },
    generated: { ...g, prompt: g.prompt || coverState.prompt || '' },
    // 保存时把封面地址记下来，回写线程时要用
    applyCover: (cover) => { coverState.coverUrl = cover?.url || ''; },
    onChanged: async () => {
      await panel?.writeBack?.({
        role: 'assistant',
        text: '✓ 已保存为项目封面（提示词已随封面完整保存）',
        images: [coverState.coverUrl].filter(Boolean),
      });
      panel?.refresh?.();
    },
    toast: (msg, kind) => { if (kind === 'err') console.warn(msg); },
  });
}

/** 上传参考图（本地文件 → 资源库） */
async function coverUploadRefs(projectId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp';
  input.multiple = true;
  input.addEventListener('change', async () => {
    const files = [...(input.files || [])];
    input.value = '';
    for (const file of files.slice(0, 6 - coverState.refs.length)) {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) continue;
      if (file.size > 2 * 1024 * 1024) continue;
      const dataUrl = await fileToDataUrl(file);
      coverState.refs.push({ dataUrl, name: file.name, url: dataUrl });
    }
    await coverWriteBack(projectId, { text: `已添加 ${coverState.refs.length} 张参考图` });
  });
  input.click();
}

/** 从资源库选参考图 */
async function coverPickRefs(projectId) {
  openAssetLibrary({
    mode: 'pick', multi: true, accept: 'image',
    onPick: async (list) => {
      const chosen = (Array.isArray(list) ? list : [list]).filter(Boolean);
      for (const a of chosen) {
        coverState.refs.push({ file: a.file, name: a.name, url: a.url });
      }
      await coverWriteBack(projectId, { text: `已从资源库选入 ${chosen.length} 张参考图` });
    },
  });
}

/** 上传图片直接作封面 */
async function coverUploadCover(projectId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp,image/gif';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    const d = await postJson(`/api/projects/${projectId}/cover`, { dataUrl });
    await coverWriteBack(projectId, {
      text: '✓ 封面图片已上传',
      images: d.cover?.url ? [d.cover.url] : [],
    });
    panel?.refresh?.();
  });
  input.click();
}

/** 从资源库选图作封面 */
async function coverFromLibrary(projectId) {
  openAssetLibrary({
    mode: 'pick', accept: 'image',
    onPick: async (a) => {
      const d = await postJson(`/api/projects/${projectId}/cover`, { asset: a.file });
      await coverWriteBack(projectId, {
        text: '✓ 已从资源库选用封面',
        images: d.cover?.url ? [d.cover.url] : [],
      });
      panel?.refresh?.();
    },
  });
}

/** 恢复名称封面 */
async function coverReset(projectId) {
  const d = await postJson(`/api/projects/${projectId}/cover`, undefined, 'DELETE');
  await coverWriteBack(projectId, { text: '✓ 已恢复为项目名称封面' });
  panel?.refresh?.();
  return d;
}

/** 风格档：保存草稿为自定义导演风格 */
async function styleSave(projectId) {
  // 草稿由服务端会话状态持有（关窗不丢）：保存时取回完整草稿再提交
  const draft = panel?.scopeDef?.()?.draft || null;
  if (!draft) {
    await panel?.writeBack?.({ role: 'assistant', text: '✗ 还没有可保存的草稿，先聊出一份完整的风格。' });
    return;
  }
  const out = await postJson('/api/director-styles', { style: draft });
  await panel?.writeBack?.({ role: 'assistant', text: `✓ ${out.message || '已保存为导演风格'}。新风格已进入项目技能清单。` });
}

/* ------------------------------------------------------------------ 工具 */

async function getJson(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

async function postJson(path, body, method = 'POST') {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}
