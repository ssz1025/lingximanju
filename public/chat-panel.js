/* ============================================================================
 * 统一 AI 对话面板（Unified AI Chat Panel）
 *
 * 全项目**只有一个** AI 对话面板：任何入口（顶栏 / 六步面板 / 工作台步骤区 /
 * 项目封面 / 导演风格 / 画布）都打开它，并定位到对应「档位」。
 *
 * 面板结构（自上而下）：
 *   ① 档位切换条 —— 总览 / 六步 / 封面 / 风格 / 画布，带各档消息计数
 *   ② 提示条     —— 当前档的现状摘要（随档位变化）
 *   ③ 功能按钮行 —— 当前档专属按钮（重跑本步 / 一键生成封面 / 保存导演风格…）
 *   ④ 消息区     —— 所有档位的消息按时间混排，每条带来源标签；向上滚动可翻历史
 *   ⑤ 输入区     —— 占位文案随档位变化；模型 / 接口选择器按档位切换
 *
 * 与旧入口的分工：
 *   ai-chat.js      —— 底层气泡组件（渲染 + 忙等态），本面板复用它
 *   step-chat.js    —— 旧的分步对话页（P3 收敛到本面板后删除）
 *   ai-thread.mjs   —— 服务端统一线程（本面板的数据来源）
 * ==========================================================================*/
import { bubbleHTML, bindBubble, openImgPreview } from './ai-chat.js';
import { openPage } from './page.js';
import { esc } from './utils.js';
import { ensureModelPicker, withModelId } from './model-picker.js';
import { ensureInterfacePicker, withInterfaceId } from './interface-picker.js';

const PAGE_SIZE = 80;

/** 当前打开的面板（单例：再次打开时切档位而不是叠一个新页面） */
let current = null;

/**
 * 打开统一 AI 对话面板。
 * @param {object} o
 * @param {string} o.projectId
 * @param {string} [o.projectName]
 * @param {string} [o.scope]    打开时定位的档位（默认 project）
 * @param {Function} [o.onChanged] 业务数据变化后的回调（外层据此刷新步骤面板 / 画布）
 * @param {Function} [o.onAction] 客户端动作回调（封面 / 风格等真正的前端交互）
 */
export function openChatPanel(o = {}) {
  const { projectId, projectName = '', scope = 'project', onChanged = null, onAction = null, prefill = '' } = o;
  if (!projectId) return null;

  // 面板已开着：只切档位，不叠新页面（这正是「一个对话框」的关键）
  if (current && current.projectId === projectId) {
    current.setScope(scope);
    return current;
  }
  // 换了项目：旧面板属于上一个项目，先关掉，避免两套面板同时存在
  if (current) {
    current.close();
    current = null;
  }

  const state = {
    projectId,
    projectName,
    scope,
    scopes: [],          // 档位目录（服务端下发）
    counts: {},
    filter: 'all',       // 'all' | 当前档位
    messages: [],        // 已加载的消息（升序）
    cursor: null,        // 更早一页的游标
    hasMore: false,
    loadingOlder: false,
    busy: false,
  };

  const page = openPage({
    title: '✦ AI 对话',
    sub: projectName ? `${projectName} · 所有对话都在这里` : '所有对话都在这里',
    variant: 'chat',
    onClose: () => { if (current === api) current = null; },
  });
  const backdrop = page.content;

  backdrop.innerHTML = `
    <div class="acp-scopes" data-acp="scopes"></div>
    <div class="acp-hint" data-acp="hint"></div>
    <div class="acp-actions" data-acp="actions"></div>
    <div class="acp-list" data-acp="list"></div>
    <div class="acp-inputbar">
      <div class="acp-inputrow">
        <textarea data-acp="input" rows="1" placeholder="输入消息，Enter 发送…" aria-label="消息输入"></textarea>
        <button class="btn primary" data-acp="send" aria-label="发送">➤</button>
      </div>
      <div class="acp-filterrow">
        <button class="acp-filter" data-acp="filter-all">全部对话</button>
        <button class="acp-filter" data-acp="filter-scope">仅当前档</button>
        <span class="acp-grow"></span>
        <button class="acp-mini" data-acp="export" title="导出全部对话记录（Markdown / JSON）">⤓ 导出记录</button>
      </div>
    </div>`;

  const elScopes = backdrop.querySelector('[data-acp="scopes"]');
  const elHint = backdrop.querySelector('[data-acp="hint"]');
  const elActions = backdrop.querySelector('[data-acp="actions"]');
  const elList = backdrop.querySelector('[data-acp="list"]');
  const elInput = backdrop.querySelector('[data-acp="input"]');
  const elSend = backdrop.querySelector('[data-acp="send"]');
  const elFilterAll = backdrop.querySelector('[data-acp="filter-all"]');
  const elFilterScope = backdrop.querySelector('[data-acp="filter-scope"]');
  const elInputRow = backdrop.querySelector('.acp-inputrow');

  /* ---------------- 发送 ---------------- */

  async function req(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
    return data;
  }

  /* ---------------- 消息渲染 ---------------- */

  /** 消息 → 气泡（复用 ai-chat 的渲染层） */
  function bubbleOf(msg) {
    return {
      role: msg.role,
      text: msg.text,
      images: msg.images || [],
      promptBlock: msg.promptBlock || null,
      suggestions: [],
      // 消息自带的功能按钮（如「保存为封面」「重新生成」）走 act 键，由上层处理
      actions: (msg.actions || []).map((a) => ({
        label: a.label, act: a.act, primary: !!a.primary, disabled: !!a.disabled, data: a.data,
      })),
      links: (msg.links || []).concat(
        (msg.artifacts || []).map((a) => ({ label: a.label, url: a.url })),
      ),
    };
  }

  function sourceTag(msg) {
    return `<span class="acp-src acp-src-${esc(msg.scope)}" title="${esc(msg.scopeLabel || '')}">${esc(msg.scopeIcon || '')} ${esc(msg.scopeShort || msg.scopeLabel || msg.scope)}</span>`;
  }

  /** 渲染一条消息到列表（可选 prepend：向上翻历史时插到最前面） */
  function renderMessage(msg, prepend = false) {
    const wrap = document.createElement('div');
    wrap.className = 'acp-item';
    wrap.dataset.uid = msg.uid || '';
    const srcRow = document.createElement('div');
    srcRow.className = 'acp-srcrow';
    srcRow.innerHTML = `${sourceTag(msg)}<time>${timeText(msg.at)}</time>`;
    const bubble = document.createElement('div');
    bubble.innerHTML = bubbleHTML(bubbleOf(msg));
    const msgEl = bubble.firstElementChild;
    if (msgEl) {
      msgEl.classList.add('acp-msg');
      bindBubble(msgEl, bubbleOf(msg), {
        disabled: () => state.busy,
        onChip: () => {},
        onAction: (act) => {
          if (!act.act) return;
          onAction?.(act.act, { scope: state.scope, scopeDef: currentScope(), message: msg, act });
        },
      });
    }
    wrap.appendChild(srcRow);
    wrap.appendChild(bubble);
    if (prepend) elList.insertBefore(wrap, elList.firstChild);
    else elList.appendChild(wrap);
    return wrap;
  }

  function timeText(at) {
    if (!at) return '';
    const d = new Date(at);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay
      ? d.toLocaleTimeString('zh-CN', { hour12: false })
      : d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit' });
  }

  /** 按当前筛选重新渲染整个列表 */
  function renderList() {
    elList.replaceChildren();
    const list = visibleMessages();
    for (const msg of list) renderMessage(msg);
    if (!list.length) {
      elList.innerHTML = `<div class="acp-empty">还没有对话记录。选一个档位，说句话开始。</div>`;
    }
    scrollBottom();
  }

  /** 当前筛选下可见的消息 */
  function visibleMessages() {
    if (state.filter === 'all') return state.messages;
    return state.messages.filter((m) => m.scope === state.scope);
  }

  function scrollBottom() {
    elList.scrollTop = elList.scrollHeight;
  }

  /** 向上翻历史：滚到顶部时自动加载更早一页 */
  async function loadOlder() {
    if (state.loadingOlder || !state.hasMore || !state.cursor) return;
    state.loadingOlder = true;
    const el = document.createElement('div');
    el.className = 'acp-loading';
    el.textContent = '正在载入更早的对话…';
    elList.insertBefore(el, elList.firstChild);
    try {
      const d = await req(`/api/projects/${state.projectId}/ai/thread?scope=all&limit=${PAGE_SIZE}&before=${encodeURIComponent(state.cursor)}`);
      const prevH = elList.scrollHeight;
      const prevTop = elList.scrollTop;
      for (const msg of d.messages || []) {
        state.messages.unshift(msg);
        renderMessage(msg, true);
      }
      state.cursor = d.nextCursor || null;
      state.hasMore = !!d.hasMore;
      // 保持视觉位置：不跳走（用户正在读历史）
      elList.scrollTop = prevTop + (elList.scrollHeight - prevH);
    } catch (err) {
      el.textContent = `✗ ${err.message}`;
    } finally {
      state.loadingOlder = false;
      el.remove();
    }
  }

  elList.addEventListener('scroll', () => {
    if (elList.scrollTop < 40) loadOlder();
  });

  /* ---------------- 档位切换条 ---------------- */

  function renderScopes() {
    const groups = [];
    for (const s of state.scopes) {
      let g = groups.find((x) => x.name === s.group);
      if (!g) { g = { name: s.group, items: [] }; groups.push(g); }
      g.items.push(s);
    }
    elScopes.innerHTML = groups.map((g) => `<div class="acp-scopeline">
      <span class="acp-group">${esc(g.name)}</span>
      ${g.items.map((s) => {
        const n = state.counts[s.id] || 0;
        const cls = `acp-scope${s.id === state.scope ? ' active' : ''}${s.available ? '' : ' off'}`;
        return `<button class="${cls}" data-scope="${esc(s.id)}" title="${esc(s.label)}${s.available ? '' : ` · ${esc(s.unavailableReason || '不可用')}`}">
          <span class="acp-scope-ico">${esc(s.icon)}</span>${esc(s.short)}${n ? `<i class="acp-badge">${n}</i>` : ''}</button>`;
      }).join('')}
    </div>`).join('');
    elScopes.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => {
      if (b.classList.contains('off')) return;
      setScope(b.dataset.scope);
    }));
  }

  /* ---------------- 提示条与功能按钮行 ---------------- */

  function renderHint() {
    const s = currentScope();
    if (!s) { elHint.innerHTML = ''; elActions.innerHTML = ''; return; }
    if (!s.available) {
      elHint.innerHTML = `<div class="acp-hintline acp-hint-off">${esc(s.label)} · ${esc(s.unavailableReason || '当前项目不可用')}</div>`;
      elActions.innerHTML = '';
      return;
    }
    elHint.innerHTML = `<div class="acp-hintline">${esc(s.hint)}</div>`
      + (s.context?.length
        ? `<div class="acp-ctx">${s.context.map((c) => `<span>${esc(c)}</span>`).join('')}</div>`
        : '');
  }

  function renderActions() {
    const s = currentScope();
    const acts = (s?.available ? s.actions : []) || [];
    // 快捷指令（chips）：点了就发出去
    const chips = (s?.available ? s.suggestions : []) || [];
    const chipHTML = chips.length
      ? `<div class="acp-chips">${chips.map((c) => `<button class="acp-chip" data-chip="${esc(c.text)}">${esc(c.label || c.text)}</button>`).join('')}</div>`
      : '';
    const btnHTML = acts.length
      ? `<div class="acp-actbtns">${acts.map((a, i) => `<button class="btn sm ${a.primary ? 'primary' : ''}" data-act="${i}">${esc(a.label)}</button>`).join('')}</div>`
      : '';
    elActions.innerHTML = chipHTML + btnHTML;
    elActions.querySelectorAll('[data-chip]').forEach((b) => b.addEventListener('click', () => {
      if (state.busy) return;
      send(b.dataset.chip);
    }));
    elActions.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      if (state.busy) return;
      const a = acts[Number(b.dataset.act)];
      if (!a) return;
      if (a.say) { send(a.say); return; }
      // 客户端动作（封面出图 / 保存风格 / 导出记录…）：交给上层处理
      if (a.act === 'thread.export') { exportThread(); return; }
      onAction?.(a.act, { scope: state.scope, scopeDef: s });
    }));
  }

  function currentScope() {
    return state.scopes.find((s) => s.id === state.scope) || null;
  }

  /* ---------------- 发送 ---------------- */

  function setBusy(v, note = '') {
    state.busy = !!v;
    elInput.disabled = v;
    elSend.disabled = v;
    for (const b of elActions.querySelectorAll('button')) b.disabled = v;
    let tip = backdrop.querySelector('.acp-typing');
    if (v) {
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'acp-typing';
        backdrop.querySelector('.acp-list').appendChild(tip);
      }
      tip.innerHTML = `<span></span><span></span><span></span>${note ? `<em>${esc(note)}</em>` : ''}`;
    } else {
      tip?.remove();
    }
  }

  /** 发一句话：走统一线程接口，返回的消息直接并进列表 */
  async function send(text) {
    const body = { scope: state.scope, message: String(text || '').trim() };
    if (!body.message) return;
    // 用户气泡先上屏（不等服务端），再补服务端返回的正式记录
    elInput.value = '';
    elInput.dispatchEvent(new Event('input'));
    const optimistic = {
      uid: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      scope: state.scope,
      scopeLabel: currentScope()?.label || '',
      scopeShort: currentScope()?.short || '',
      scopeIcon: currentScope()?.icon || '',
      role: 'user', text: body.message, at: Date.now(),
      suggestions: [], artifacts: [], links: [], images: [], calls: [],
    };
    state.messages.push(optimistic);
    renderMessage(optimistic);
    scrollBottom();
    setBusy(true, '正在处理…');
    try {
      const d = await req(`/api/projects/${state.projectId}/ai/chat`, {
        method: 'POST',
        body: withModelId(modelEntry(), body),
      });
      // 服务端返回本轮追加的**全部**记录（含用户那条）。
      // 乐观气泡只是让用户先看到自己说了什么，正式记录回来后要把它换掉，
      // 否则同一条用户消息会显示两遍。
      const added = d.appended || [];
      if (added.some((m) => m.role === 'user')) {
        const i = state.messages.findIndex((x) => x.uid === optimistic.uid);
        if (i >= 0) state.messages.splice(i, 1);
      }
      for (const msg of added) {
        const idx = state.messages.findIndex((x) => x.uid === msg.uid);
        if (idx >= 0) state.messages.splice(idx, 1);
        state.messages.push(msg);
      }
      if (!added.length) {
        // 兜底：服务端没给追加消息时，用回复文本补一条
        state.messages.push({
          uid: `r-${Date.now()}`, scope: state.scope,
          scopeLabel: currentScope()?.label || '', scopeShort: currentScope()?.short || '',
          scopeIcon: currentScope()?.icon || '',
          role: 'assistant', text: d.reply || '', at: Date.now(),
          suggestions: [], artifacts: [], links: [], images: [], calls: [],
        });
      }
      state.counts = d.counts || state.counts;
      renderList();
      renderScopes();
      await refreshScopes();
      onChanged?.();
    } catch (err) {
      const el = elList.lastElementChild;
      if (el) {
        const bubble = el.querySelector('.aichat-bubble');
        if (bubble) bubble.insertAdjacentHTML('beforeend', `<div class="aichat-text acp-err">✗ ${esc(err.message)}</div>`);
      }
    } finally {
      setBusy(false);
    }
  }

  /** 当前档位用哪个模型入口（模型 / 接口选择器按档位区分记忆） */
  function modelEntry() {
    const s = currentScope();
    return s?.id === 'cover' ? 'cover' : 'chat';
  }

  function interfaceEntry() {
    const s = currentScope();
    return s?.id === 'cover' ? 'cover' : '';
  }

  /** 换档位：模型 / 接口下拉也要跟着换（各自按档位记忆） */
  async function refreshPickers() {
    for (const sel of elInputRow.querySelectorAll('select.model-picker, select.interface-picker')) sel.remove();
    const m = modelEntry();
    const i = interfaceEntry();
    // 下拉是锦上添花：拉不到（离线 / 无模型库）不能影响对话本身
    try {
      if (m) await ensureModelPicker(m, elInputRow, elInput);
      if (i) await ensureInterfacePicker(i, elInputRow, elInput);
    } catch { /* 忽略：没有下拉也能正常对话 */ }
  }

  function exportThread() {
    window.open(`/api/projects/${state.projectId}/ai/export?format=md`, '_blank');
  }

  /* ---------------- 档位切换 ---------------- */

  async function setScope(scopeId) {
    if (!scopeId || scopeId === state.scope) {
      renderHint(); renderActions();
      return;
    }
    state.scope = scopeId;
    renderScopes();
    renderHint();
    renderActions();
    elInput.placeholder = currentScope()?.placeholder || '输入消息，Enter 发送…';
    await refreshPickers();
    renderList();
  }

  /* ---------------- 后台任务事件：制片助手的长任务（跑六步 / 一键全流程） ---------------- */

  /**
   * 服务端后台任务完成时把结果补进这条线程。
   * 制片助手的长意图是异步跑的（HTTP 立即返回「已开始」，结果稍后由 SSE 推回来），
   * 没有这个回调，结果就永远看不见。
   */
  function onServerEvent(e) {
    if (!e || e.type !== 'production:chat') return;
    if (e.projectId && state.projectId !== e.projectId) return;
    if (e.type === 'production:chat' && e.reply) {
      // 结果已由服务端写进会话记录，这里只需把线程重新拉一遍
      loadThread().catch(() => {});
    }
  }

  /* ---------------- 事件绑定 ---------------- */

  elSend.addEventListener('click', () => {
    const text = elInput.value.trim();
    if (!text || state.busy) return;
    send(text);
  });
  elInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); elSend.click(); }
  });
  elInput.addEventListener('input', () => {
    elInput.style.height = 'auto';
    elInput.style.height = `${Math.min(96, elInput.scrollHeight)}px`;
  });
  elFilterAll.addEventListener('click', () => {
    state.filter = 'all';
    elFilterAll.classList.add('active');
    elFilterScope.classList.remove('active');
    renderList();
  });
  elFilterScope.addEventListener('click', () => {
    state.filter = 'scope';
    elFilterAll.classList.remove('active');
    elFilterScope.classList.add('active');
    renderList();
  });
  backdrop.querySelector('[data-acp="export"]').addEventListener('click', exportThread);

  /* ---------------- 载入 ---------------- */

  async function refreshScopes() {
    try {
      const d = await req(`/api/projects/${state.projectId}/ai/scopes`);
      state.scopes = d.scopes || [];
      state.counts = d.counts || state.counts;
      renderScopes();
      renderHint();
      renderActions();
    } catch { /* 目录拿不到时保留上一次的 */ }
  }

  async function loadThread() {
    try {
      const d = await req(`/api/projects/${state.projectId}/ai/thread?scope=all&limit=${PAGE_SIZE}`);
      state.messages = d.messages || [];
      state.cursor = d.nextCursor || null;
      state.hasMore = !!d.hasMore;
      state.counts = d.counts || state.counts;
      renderList();
    } catch (err) {
      elList.innerHTML = `<div class="acp-empty acp-err">✗ ${err.message}</div>`;
    }
  }

  const api = {
    projectId,
    // 当前档位随切换变化（读实时值，不要用创建时的快照）
    get scope() { return state.scope; },
    get state() { return state; },
    setScope,
    refresh: async () => { await refreshScopes(); await loadThread(); },
    close: () => page.close(),
    /** 供外部（封面出图 / 保存风格等客户端动作）把产物回写进这条线程 */
    appendClient: async (msg) => {
      const d = await req(`/api/projects/${state.projectId}/ai/append`, {
        method: 'POST',
        body: { scope: state.scope, ...msg },
      });
      if (d.message) { state.messages.push(d.message); renderList(); }
      return d;
    },
    /** 把服务端返回的「本轮追加消息」并进列表（客户端动作触发的对话也走这条） */
    mergeAppended: (appended = []) => {
      for (const msg of appended) {
        const idx = state.messages.findIndex((x) => x.uid === msg.uid);
        if (idx >= 0) state.messages.splice(idx, 1);
        state.messages.push(msg);
      }
      renderList();
      scrollBottom();
      return appended.length;
    },
    /** 客户端动作完成后的统一回写入口 */
    writeBack: async (msg) => {
      const d = await req(`/api/projects/${state.projectId}/ai/append`, {
        method: 'POST',
        body: { scope: state.scope, ...msg },
      });
      if (d.message) { state.messages.push(d.message); renderList(); scrollBottom(); }
      await refreshScopes();
      return d;
    },
    /** 当前档位定义（含风格草稿等） */
    scopeDef: () => currentScope(),
    /** 服务端事件回调（后台任务完成后把结果补进线程） */
    onServerEvent,
  };

  current = api;

  // 首次载入
  (async () => {
    try {
      await refreshScopes();
      await refreshPickers();
      elInput.placeholder = currentScope()?.placeholder || '输入消息，Enter 发送…';
      await loadThread();
      await setScope(scope);
      // 预填（如从画布节点右键进来时带上 @节点ID）：只放进输入框，不自动发送
      if (prefill) {
        elInput.value = prefill;
        elInput.dispatchEvent(new Event('input'));
        elInput.focus();
      }
    } catch (err) {
      elList.innerHTML = `<div class="acp-empty acp-err">✗ ${esc(err.message)}</div>`;
    }
  })();

  return api;
}

/** 面板是否已打开（外部据此决定是切档位还是新建） */
export function chatPanelOpen(projectId = '') {
  return Boolean(current && (!projectId || current.projectId === projectId));
}
