// 共享模型选择器：所有 AI 入口旁插入 <select>，临时选择本次使用的模型（localStorage 按入口记忆）。
// 选择结果通过 withModelId() 并进请求体（body.modelId），由后端 resolveModelSettings 统一解析。
let roster = null;
let rosterPromise = null;

const esc = (s = '') => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const storeKey = (entryKey) => `lm.model.${entryKey}`;

async function fetchRoster(force = false) {
  if (roster && !force) return roster;
  if (!rosterPromise || force) {
    rosterPromise = fetch('/api/system/llm-models')
      .then((r) => r.json())
      .then((d) => { roster = { models: d.models || [], activeModelId: d.activeModelId || '' }; return roster; })
      .catch(() => { roster = { models: [], activeModelId: '' }; return roster; });
  }
  return rosterPromise;
}

/** 某入口当前选中的模型 id；'' 表示使用默认模型（后端 activeModelId） */
export function pickedModelId(entryKey) {
  try { return localStorage.getItem(storeKey(entryKey)) || ''; } catch { return ''; }
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
  sel.title = '本次使用的模型（在 设置 → 模型与运行 → 全局模型库 中维护）';
  sel.innerHTML = `<option value="">默认模型</option>${
    r.models.map((m) => `<option value="${esc(m.id)}">${esc(m.name || m.model)}${m.id === r.activeModelId ? ' · 默认' : ''}</option>`).join('')
  }`;
  const saved = pickedModelId(entryKey);
  sel.value = [...sel.options].some((o) => o.value === saved) ? saved : '';
  sel.addEventListener('change', () => {
    try {
      if (sel.value) localStorage.setItem(storeKey(entryKey), sel.value);
      else localStorage.removeItem(storeKey(entryKey));
    } catch { /* 隐私模式等场景忽略 */ }
  });
  if (before) host.insertBefore(sel, before); else host.appendChild(sel);
  return sel;
}
