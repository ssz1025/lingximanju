/* ============================================================================
 * 剧本专用「本次剧本模型」固定选择条：工作台 ④ 剧本创作 与剧集详情页共用。
 *
 * 与 ensureModelPicker 的区别：模型库为空 / 读取失败时不再整个控件消失，而是
 * 常驻一个可操作的下拉（至少「内置模板」）+「刷新模型列表」+「去配置模型」，
 * 让用户在看到「未配置模型」提示的地方就能立刻切换，不必滚回设置页猜。
 * 选择按「项目 + episode」入口记忆，与失败弹窗里的下拉共用同一份记忆。
 * 按钮用 data-smb / data-se，不新增 data-act（工作台 63 个功能入口基线由测试锁定）。
 * ==========================================================================*/
import { modelRoster, pickedModelId, setPickedModelId, clearStaleModelId } from './model-picker.js';
import { esc } from './utils.js';

// 上次拉库时间与结果：SSE 重绘不刷爆接口；但上次是空库 / 失败时每次挂载都重试，
// 避免把一次接口抖动缓存成整个会话的「没有模型可选」。
let lastFresh = 0;
let lastEmpty = false;
let lastError = false;

/**
 * @param {string} entryKey 记忆键，剧本链路固定 'episode'
 * @param {HTMLElement} host 固定槽位（渲染时输出，rerender 会重建）
 * @param {Object} opts { label, onSettings }
 */
export async function mountScriptModelBar(entryKey, host, { label = '本次剧本模型', onSettings } = {}) {
  if (!host || host.dataset.smbMounted === '1') return null;
  host.dataset.smbMounted = '1';
  host.classList.add('smb');

  const labelEl = document.createElement('span');
  labelEl.className = 'smb-label';
  labelEl.textContent = label;
  host.appendChild(labelEl);

  const sel = document.createElement('select');
  sel.className = 'model-picker';
  sel.dataset.modelPick = entryKey;
  sel.title = '本次剧本使用的模型 · 按项目分别记忆；留空跟随默认模型';
  host.appendChild(sel);

  const state = document.createElement('span');
  state.className = 'smb-state';
  host.appendChild(state);

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'btn sm';
  refreshBtn.dataset.smb = 'refresh';
  refreshBtn.textContent = '刷新模型列表';
  refreshBtn.addEventListener('click', () => render(true));
  host.appendChild(refreshBtn);

  if (onSettings) {
    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'btn sm';
    settingsBtn.dataset.smb = 'settings';
    settingsBtn.textContent = '去配置模型';
    settingsBtn.addEventListener('click', () => onSettings());
    host.appendChild(settingsBtn);
  }

  let current = { models: [], activeModelId: '', error: false };

  function syncState() {
    const picked = current.models.find((m) => String(m.id) === String(sel.value));
    const active = current.models.find((m) => String(m.id) === String(current.activeModelId));
    if (current.error) state.textContent = '模型列表读取失败 · 点「刷新」重试，本次将用内置模板';
    else if (picked) state.textContent = `当前：${picked.name || picked.model}（本次指定）`;
    else if (current.models.length) state.textContent = `当前：跟随默认 · ${active?.name || active?.model || '默认模型'}`;
    else state.innerHTML = '<span class="smb-warn">未配置文本模型 · 将使用内置模板</span>';
    host.dataset.modelId = sel.value;
  }

  async function render(force = false) {
    const needFresh = force || Date.now() - lastFresh > 10000 || lastEmpty || lastError;
    const r = await modelRoster(needFresh);
    if (needFresh) lastFresh = Date.now();
    lastEmpty = !r.models.length;
    lastError = Boolean(r.error);
    current = r;
    // 读取失败时不要清掉用户已选的有效档案（可能只是网络抖动）
    if (!r.error) clearStaleModelId(entryKey, r.models);

    const active = r.models.find((m) => String(m.id) === String(r.activeModelId));
    const defaultLabel = r.models.length
      ? `跟随默认 · ${active?.name || active?.model || '默认模型'}`
      : '内置模板 · 未配置模型';
    sel.innerHTML = `<option value="">${esc(defaultLabel)}</option>${r.models.map((m) =>
      `<option value="${esc(m.id)}">${esc(m.name || m.model)}${String(m.id) === String(r.activeModelId) ? ' · 默认' : ''}</option>`).join('')}`;
    const saved = pickedModelId(entryKey);
    sel.value = r.models.some((m) => String(m.id) === String(saved)) ? saved : '';
    // 常驻可切换：哪怕库为空 / 读取失败也不禁用，用户仍可留空用内置模板
    sel.disabled = false;
    syncState();
  }

  sel.addEventListener('change', () => {
    setPickedModelId(entryKey, sel.value);
    syncState();
  });

  await render(false);
  return { select: sel, refresh: () => render(true) };
}
