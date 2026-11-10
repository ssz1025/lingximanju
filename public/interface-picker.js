// 媒体生成接口选择器：在出图 / 视频 / 抽卡等生成入口旁插入 <select>，临时指定本次使用的
// ComfyUI 接口档案（一份「导出(API)」工作流 + 一套请求参数）。与 model-picker.js 同构：
// 按「项目 + 板块」分别记忆（localStorage），未选择时后端按 板块绑定 → 类别默认 → 镜像 解析。
// 结果通过 withInterfaceId() 并进请求体（body.interfaceId），由 resolveInterface() 统一解析。
import { esc } from './utils.js';

/** 板块中文名；顺序即设置页绑定表的展示顺序 */
export const SCOPE_LABELS = {
  cover: '封面', character: '角色立绘', 'character-view': '角色多视图',
  'character-sheet': '角色定妆板', keyframe: '关键帧', storyboard: '分镜图',
  transition: '转场', poster: '海报', grid: '宫格分镜',
  video: '视频片段', voice: '音色抽卡',
};
export const SCOPE_ORDER = Object.keys(SCOPE_LABELS);
const KIND_LABEL = { image: '出图', video: '视频', audio: '音频' };
export const scopeLabel = (id) => SCOPE_LABELS[id] || id;

/** 没有 scopes 元数据时的兜底（与后端 SCOPE_KIND 保持一致） */
const fallbackKind = (id) => (id === 'video' ? 'video' : id === 'voice' ? 'audio' : 'image');

let roster = null;
let rosterPromise = null;
let scope = { projectId: '', projectName: '' };

const storeKey = (scopeId) => `lm.iface.${scopeId}`;

/** 纯函数：某板块的存储键。传入 projectId 时按项目隔离，否则回退应用级默认值 */
export function interfaceScopeKey(scopeId, projectId = '') {
  return projectId ? `${storeKey(scopeId)}.p_${projectId}` : storeKey(scopeId);
}

/** 拉取接口档案概览；结果缓存，设置页保存后调 invalidateInterfaces() 强制刷新 */
export async function refreshInterfaces(force = false) {
  if (roster && !force) return roster;
  if (!rosterPromise || force) {
    rosterPromise = fetch('/api/comfyui/interfaces')
      .then((r) => r.json())
      .then((d) => {
        roster = {
          interfaces: Array.isArray(d.interfaces) ? d.interfaces : [],
          scopeBindings: d.scopeBindings && typeof d.scopeBindings === 'object' ? d.scopeBindings : {},
          scopes: Array.isArray(d.scopes) && d.scopes.length
            ? d.scopes : SCOPE_ORDER.map((id) => ({ id, kind: fallbackKind(id) })),
        };
        return roster;
      })
      .catch(() => {
        roster = { interfaces: [], scopeBindings: {}, scopes: SCOPE_ORDER.map((id) => ({ id, kind: fallbackKind(id) })) };
        return roster;
      });
  }
  return rosterPromise;
}

/** 纯函数：某板块可选的接口档案（按 kind 过滤） */
export function interfacesForScope(data, scopeId) {
  const meta = (data?.scopes || []).find((s) => s.id === scopeId);
  const kind = meta?.kind || fallbackKind(scopeId);
  return (Array.isArray(data?.interfaces) ? data.interfaces : []).filter((e) => e.kind === kind);
}

/** 某板块当前选中的接口档案 id；'' 表示跟随板块绑定 / 默认 */
export function pickedInterfaceId(scopeId, projectId = scope.projectId) {
  try { return localStorage.getItem(interfaceScopeKey(scopeId, projectId)) || ''; } catch { return ''; }
}

/** 请求体并上所选接口：withInterfaceId('cover', {prompt}) → {prompt, interfaceId} */
export function withInterfaceId(scopeId, body = {}) {
  const id = pickedInterfaceId(scopeId);
  return id ? { ...body, interfaceId: id } : { ...body };
}

function defaultLabel(data, scopeId) {
  const bound = data?.scopeBindings?.[scopeId];
  const found = bound ? (data.interfaces || []).find((e) => e.id === bound) : null;
  const fallback = (data.interfaces || []).find((e) => e.active
    && interfacesForScope(data, scopeId).some((x) => x.id === e.id));
  const name = found?.name || fallback?.name;
  const base = name ? `跟随默认（${name}）` : '跟随默认接口';
  return scope.projectId ? `本项目默认 · ${base}` : base;
}

function pickerTitle(scopeId) {
  return scope.projectId
    ? `「${scope.projectName || '本项目'}」· ${scopeLabel(scopeId)}本次使用的 ComfyUI 接口 · 按项目分别记忆`
    : `${scopeLabel(scopeId)}本次使用的 ComfyUI 接口（在 设置 → 本地 ComfyUI → 接口档案 中维护）`;
}

/** 用最新档案表重绘页面上已插入的所有下拉（新增档案 / 改绑定 / 切换项目后调用） */
export function repaintInterfacePickers(data = roster) {
  if (typeof document === 'undefined' || !data) return;
  document.querySelectorAll('select.interface-picker[data-iface-pick]').forEach((sel) => {
    const scopeId = sel.dataset.ifacePick;
    const list = interfacesForScope(data, scopeId);
    const saved = pickedInterfaceId(scopeId);
    sel.innerHTML = `<option value="">${esc(defaultLabel(data, scopeId))}</option>${list.map((e) =>
      `<option value="${esc(e.id)}">${esc(e.name)}${e.capability ? ` · ${esc(e.capability)}` : ''}${e.active ? ' · 默认' : ''}</option>`).join('')}`;
    sel.value = [...sel.options].some((o) => o.value === saved) ? saved : '';
    sel.title = pickerTitle(scopeId);
    // 档案被删光 / 只剩一个时下拉失去意义，直接隐藏，不留一个空控件
    sel.hidden = list.length < 2;
  });
}

/** 切换项目会话：所有接口下拉同步到该项目的记忆值 */
export function setInterfaceProjectScope(projectId = '', projectName = '') {
  scope = { projectId: String(projectId || ''), projectName: String(projectName || '') };
  repaintInterfacePickers();
}

/**
 * 在 host 里（before 之前）插入接口下拉。
 * 该板块可选档案少于 2 个时不插入（跟随默认即可，不打扰界面）。返回 select 或 null。
 */
export async function ensureInterfacePicker(scopeId, host, before = null) {
  if (!host || typeof document === 'undefined') return null;
  if (host.querySelector(`select.interface-picker[data-iface-pick="${scopeId}"]`)) return null;
  const data = await refreshInterfaces();
  if (interfacesForScope(data, scopeId).length < 2) return null;
  const sel = document.createElement('select');
  sel.className = 'interface-picker';
  sel.dataset.ifacePick = scopeId;
  sel.title = pickerTitle(scopeId);
  sel.addEventListener('change', () => {
    try {
      const key = interfaceScopeKey(scopeId, scope.projectId);
      if (sel.value) localStorage.setItem(key, sel.value);
      else localStorage.removeItem(key);
    } catch { /* 隐私模式等场景忽略 */ }
  });
  if (before && before.parentNode === host) host.insertBefore(sel, before); else host.appendChild(sel);
  repaintInterfacePickers(data);
  return sel;
}

/** 设置页保存档案 / 绑定后调用：强制重新取数并同步所有下拉 */
export async function invalidateInterfaces() {
  const data = await refreshInterfaces(true);
  repaintInterfacePickers(data);
  return data;
}

/** 供设置页展示：把 scope 元数据转成「id / 中文名 / kind」列表 */
export function scopeList(data = roster) {
  const known = new Map((data?.scopes || []).map((s) => [s.id, s.kind]));
  return SCOPE_ORDER.map((id) => ({
    id, label: scopeLabel(id), kind: known.get(id) || fallbackKind(id),
    kindLabel: KIND_LABEL[known.get(id) || fallbackKind(id)] || '',
  }));
}
