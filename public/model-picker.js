// 共享模型选择器：所有 AI 入口旁插入 <select>，临时选择本次使用的模型。
// 打开项目后按「项目 + 入口」分别记忆（localStorage）：切换 / 关闭项目自动恢复，
// 保证项目会话里看到的模型永远是本项目上次用的那个，不串到别的项目。
// 选择结果通过 withModelId() 并进请求体（body.modelId），由后端 resolveModelSettings 统一解析。
import { esc } from './utils.js';

let roster = null;
let rosterPromise = null;
let scope = { projectId: '', projectName: '' };

const storeKey = (entryKey) => `lm.model.${entryKey}`;

/** 纯函数：某入口的存储键。传入 projectId 时按项目隔离，否则回退应用级默认值 */
export function modelScopeKey(entryKey, projectId = '') {
  return projectId ? `${storeKey(entryKey)}.p_${projectId}` : storeKey(entryKey);
}

function pickerTitle() {
  return scope.projectId
    ? `「${scope.projectName || '本项目'}」本次使用的模型 · 按项目分别记忆`
    : '本次使用的模型（在 设置 → 模型与运行 → 全局模型库 中维护）';
}

/**
 * 切换项目会话：把页面上所有已插入的模型下拉同步到该项目的记忆值。
 * 关闭项目时传空 id，回到应用级默认。纯逻辑部分可在 Node 下单测。
 */
export function setModelProjectScope(projectId = '', projectName = '') {
  scope = { projectId: String(projectId || ''), projectName: String(projectName || '') };
  if (typeof document === 'undefined') return;
  document.querySelectorAll('select.model-picker[data-model-pick]').forEach((sel) => {
    const saved = pickedModelId(sel.dataset.modelPick);
    sel.value = [...sel.options].some((o) => o.value === saved) ? saved : '';
    sel.title = pickerTitle();
    if (sel.options[0]) sel.options[0].textContent = scope.projectId ? '本项目默认模型' : '默认模型';
  });
}

function fetchRoster(force = false) {
  if (roster && !force) return Promise.resolve(roster);
  if (!rosterPromise || force) {
    rosterPromise = fetch('/api/system/llm-models')
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { roster = { models: d.models || [], activeModelId: d.activeModelId || '' }; return roster; })
      .catch(() => {
        // 关键：一次网络抖动不能把「空模型库」缓存到整个会话结束，否则选择条会永远
        // 只剩「未配置」文字、不再出现下拉。失败结果不写 roster，并清掉 pending 允许重试。
        rosterPromise = null;
        return { models: [], activeModelId: '', error: true };
      });
  }
  return rosterPromise;
}

/**
 * 当前全局模型库（只读快照）。供模型选择条在「库为空」时也能渲染出可见状态，
 * 而不是像 ensureModelPicker 那样整个控件消失，让用户以为不能选模型。
 * 传 force=true 可在设置页新增 / 删除档案后强制刷新缓存。
 * error=true 表示这次没读到模型库（接口失败），与「库里真的没有档案」区分开。
 */
export async function modelRoster(force = false) {
  const r = await fetchRoster(force);
  return { models: r.models || [], activeModelId: r.activeModelId || '', error: Boolean(r.error) };
}

/** 某入口当前选中的模型 id；'' 表示使用默认模型（后端 activeModelId） */
export function pickedModelId(entryKey, projectId = scope.projectId) {
  try { return localStorage.getItem(modelScopeKey(entryKey, projectId)) || ''; } catch { return ''; }
}

/**
 * 写入某入口本次选择的模型（'' = 跟随默认）。弹窗里的「换一个模型重试」与
 * 剧本台选择条共用这一份「项目 + 入口」记忆，切换后立刻对下一次请求生效。
 */
export function setPickedModelId(entryKey, id = '') {
  const value = String(id || '');
  try {
    const key = modelScopeKey(entryKey, scope.projectId);
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* 隐私模式等场景忽略 */ }
  return value;
}

/**
 * 清掉已经失效的模型记忆（档案被删除 /换库后 localStorage 里还留着旧 id）。
 * 返回仍然有效的所选 id；'' 表示已清理或本来就没选。
 */
export function clearStaleModelId(entryKey, models = []) {
  const saved = pickedModelId(entryKey);
  if (!saved) return '';
  if (models.some((m) => String(m.id) === String(saved))) return saved;
  try { localStorage.removeItem(modelScopeKey(entryKey, scope.projectId)); } catch { /* 隐私模式忽略 */ }
  return '';
}

/** 请求体并上所选模型：withModelId('cover', {messages}) → {messages, modelId} */
export function withModelId(entryKey, body = {}) {
  return { ...body, modelId: pickedModelId(entryKey) };
}

/**
 * 在 host 里（before 之前）插入模型下拉。
 * 库为空时不插入（入口回退默认链，不打扰界面）。返回 select 或 null。
 */
export async function ensureModelPicker(entryKey, host, before = null) {
  if (!host) return null;
  const r = await fetchRoster();
  if (!r.models.length) return null;
  const sel = document.createElement('select');
  sel.className = 'model-picker';
  sel.dataset.modelPick = entryKey;
  sel.title = pickerTitle();
  sel.innerHTML = `<option value="">${scope.projectId ? '本项目默认模型' : '默认模型'}</option>${
    r.models.map((m) => `<option value="${esc(m.id)}">${esc(m.name || m.model)}${m.id === r.activeModelId ? ' · 默认' : ''}</option>`).join('')
  }`;
  const saved = pickedModelId(entryKey);
  sel.value = [...sel.options].some((o) => o.value === saved) ? saved : '';
  sel.addEventListener('change', () => setPickedModelId(entryKey, sel.value));
  if (before) host.insertBefore(sel, before); else host.appendChild(sel);
  return sel;
}
