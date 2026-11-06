/* ============================================================================
 * 可复用 AI 对话弹窗组件：消息气泡（用户 / 助手）、图片附件、提示词块、
 * 可点击建议（chips）与动作按钮、输入框、忙等指示。
 * 纯 DOM 实现、零依赖；任何需要「和 AI 对话」的入口（封面创作、后续其他场景）
 * 都通过 openAIChat({ onSend, actions }) 接入：组件只管交互，业务在调用方。
 * ==========================================================================*/

const $esc = (s = '') => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * 打开一个 AI 对话弹窗。
 * @param {object} o
 * @param {string} [o.title]      弹窗标题
 * @param {string} [o.subtitle]  标题下的说明行
 * @param {string} [o.placeholder] 输入框占位文案
 * @param {object} [o.welcome]   开场消息（普通消息结构，可带 actions / suggestions）
 * @param {Function} o.onSend    async ({ text, history, ui }) => {}  用户发送文本
 * @param {object} [o.actions]   { actKey: async (ui, data, msg) => {} } 动作按钮回调
 * @param {Function} [o.onClose] () => {} 关闭后回调
 * @returns 对话实例：{ addMessage, setBusy, history, close }
 */
export function openAIChat(o = {}) {
  const {
    title = '✦ AI 助手',
    subtitle = '',
    placeholder = '输入消息，Enter 发送…',
    welcome = null,
    onSend = null,
    actions = {},
    onClose = null,
  } = o;

  const root = document.getElementById('modal-root') || document.body;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const history = [];               // [{role:'user'|'assistant', content}] 文本对话上下文
  let busy = false;
  let busyNote = null;              // 忙等气泡（打字指示 + 说明）

  function close() {
    if (busy) return;
    backdrop.remove();
    onClose?.();
  }
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(); });

  backdrop.innerHTML = `<div class="modal aichat-modal" role="dialog" aria-label="${$esc(title)}">
    <div class="pmm-head"><div><h2>${$esc(title)}</h2>${subtitle ? `<div class="sub">${$esc(subtitle)}</div>` : ''}</div>
      <button class="icon-btn" data-aichat="close" aria-label="关闭">✕</button></div>
    <div class="aichat-list" data-aichat="list"></div>
    <div class="aichat-inputbar">
      <textarea data-aichat="input" rows="1" placeholder="${$esc(placeholder)}" aria-label="消息输入"></textarea>
      <button class="btn primary" data-aichat="send" aria-label="发送">➤</button>
    </div>
  </div>`;
  root.appendChild(backdrop);

  const list = backdrop.querySelector('[data-aichat="list"]');
  const input = backdrop.querySelector('[data-aichat="input"]');
  const sendBtn = backdrop.querySelector('[data-aichat="send"]');
  const closeBtn = backdrop.querySelector('[data-aichat="close"]');

  /** 消息渲染：气泡内可含图片行、提示词块、建议 chips、动作按钮 */
  function bubbleHTML(msg) {
    const isUser = msg.role === 'user';
    const imgs = (Array.isArray(msg.images) && msg.images.length)
      ? `<div class="aichat-imgs">${msg.images.map((u) => `<img src="${$esc(u)}" alt="" loading="lazy">`).join('')}</div>` : '';
    const pb = msg.promptBlock
      ? `<div class="aichat-promptbox"><b>✦ 画面提示词${msg.promptBlock.negative ? ' <small>（已保存，可继续对话调整）</small>' : ''}</b>
          <p>${$esc(msg.promptBlock.prompt)}</p>${msg.promptBlock.negative ? `<small>负向：${$esc(msg.promptBlock.negative)}</small>` : ''}</div>` : '';
    const chips = (Array.isArray(msg.suggestions) && msg.suggestions.length)
      ? `<div class="aichat-chips">${msg.suggestions.map((s, i) => `<button class="aichat-chip" data-aichat-chip="${i}" title="点击发送">${$esc(s)}</button>`).join('')}</div>` : '';
    const acts = (Array.isArray(msg.actions) && msg.actions.length)
      ? `<div class="aichat-acts">${msg.actions.map((a, i) => `<button class="btn sm ${a.primary ? 'primary' : ''}" data-aichat-act="${i}" ${a.disabled ? 'disabled' : ''}>${$esc(a.label)}</button>`).join('')}</div>` : '';
    const text = String(msg.text || '').trim();
    return `<div class="aichat-msg ${isUser ? 'user' : 'assistant'}">
      <div class="aichat-bubble">${text ? `<div class="aichat-text">${$esc(text).replace(/\n/g, '<br>')}</div>` : ''}${imgs}${pb}${chips}${acts}</div></div>`;
  }

  const ui = {
    /** 追加一条消息并滚动到底部；text 会进入对话历史供 onSend 组装上下文 */
    addMessage(msg) {
      const wrap = document.createElement('div');
      wrap.innerHTML = bubbleHTML({ role: 'assistant', ...msg });
      const el = wrap.firstElementChild;
      list.appendChild(el);
      busyNote?.classList.add('stale');
      list.scrollTop = list.scrollHeight;
      const text = String(msg.text || '').trim();
      if (text) history.push({ role: msg.role === 'user' ? 'user' : 'assistant', content: text });
      // 建议 chips：点击即作为用户消息发送；同气泡内按钮互斥（点击后全部禁用，防重复触发）
      el.querySelectorAll('[data-aichat-chip]').forEach((chip) => chip.addEventListener('click', () => {
        if (busy) return;
        el.querySelectorAll('button').forEach((b) => (b.disabled = true));
        dispatchSend(chip.textContent.trim());
      }));
      // 动作按钮：交给调用方 actions 表处理
      el.querySelectorAll('[data-aichat-act]').forEach((btn) => btn.addEventListener('click', () => {
        if (busy) return;
        const act = msg.actions[Number(btn.dataset.aichatAct)];
        if (!act || act.disabled) return;
        el.querySelectorAll('button').forEach((b) => (b.disabled = true));
        runTask(() => actions[act.act]?.(ui, act.data, msg) ?? Promise.resolve());
      }));
      return el;
    },
    /** 忙等态：输入禁用 + 打字指示（note 为进度说明，如「ComfyUI 正在生成封面…」） */
    setBusy(v, note = '') {
      busy = !!v;
      input.disabled = busy;
      sendBtn.disabled = busy;
      closeBtn.disabled = busy;
      backdrop.querySelectorAll('.aichat-chip').forEach((c) => (c.disabled = c.disabled || busy));
      if (busy) {
        busyNote?.remove();
        busyNote = document.createElement('div');
        busyNote.className = 'aichat-msg assistant';
        busyNote.innerHTML = `<div class="aichat-bubble aichat-typing"><span></span><span></span><span></span>${note ? `<em>${$esc(note)}</em>` : ''}</div>`;
        list.appendChild(busyNote);
      } else {
        busyNote?.remove();
        busyNote = null;
      }
      list.scrollTop = list.scrollHeight;
    },
    history: () => history.map((x) => ({ ...x })),
    close,
  };

  /** 统一的异步任务包装：忙等态包住整个任务，异常由调用方消息自行呈现 */
  async function runTask(task) {
    ui.setBusy(true);
    try { await task(); } finally { ui.setBusy(false); }
  }

  function dispatchSend(text) {
    input.value = '';
    ui.addMessage({ role: 'user', text });
    if (onSend) runTask(() => onSend({ text, history: ui.history(), ui }));
  }

  sendBtn.addEventListener('click', () => {
    const text = input.value.trim();
    if (!text || busy) return;
    dispatchSend(text);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
  });
  closeBtn.addEventListener('click', close);

  if (welcome) ui.addMessage({ role: 'assistant', ...welcome });
  return ui;
}
