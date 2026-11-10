/* ============================================================================
 * 可复用 AI 对话弹窗组件：消息气泡（用户 / 助手）、图片附件、提示词块、
 * 可点击建议（chips）与动作按钮、输入框、忙等指示。
 * 纯 DOM 实现、零依赖；任何需要「和 AI 对话」的入口（封面创作、后续其他场景）
 * 都通过 openAIChat({ onSend, actions }) 接入：组件只管交互，业务在调用方。
 * ==========================================================================*/

/** 模型选择器（可选）：库里有模型时在输入栏前插入下拉，本次对话用哪个模型由用户临时决定 */
import { ensureModelPicker } from './model-picker.js';
import { ensureInterfacePicker } from './interface-picker.js';
import { openPage } from './page.js';
import { esc as $esc } from './utils.js';


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
    modelEntry = null,   // 模型库入口 key：设置后输入栏左侧出现模型下拉（如 'cover'）
    interfaceEntry = null, // 媒体生成板块 key：设置后输入栏出现「本次接口」下拉（如 'cover'）
  } = o;

  const history = [];               // [{role:'user'|'assistant', content}] 文本对话上下文
  let busy = false;
  let busyNote = null;              // 忙等气泡（打字指示 + 说明）
  let busyHeld = [];                // 忙等期间被临时禁用的按钮（动作 + 建议），结束后原样恢复。
                                    // 必须置灰：否则「生成封面」等按钮在任务进行中看起来可点，
                                    // 点击却被 busy 守卫静默吞掉，用户会以为「点了没反应」。
  const BUTTON_SELS = ['[data-aichat-act]', '[data-aichat-chip]'];
  const holdBusyButtons = (scope) => {
    for (const sel of BUTTON_SELS) {
      scope.querySelectorAll(sel).forEach((b) => {
        if (!b.disabled) { b.disabled = true; busyHeld.push(b); }
      });
    }
  };
  /** 消费式禁用一条消息内的全部按钮（动作 + 建议），防止同气泡内重复触发 */
  const disableMsgButtons = (el) => {
    for (const sel of BUTTON_SELS) el.querySelectorAll(sel).forEach((b) => (b.disabled = true));
  };

  const page = openPage({
    title, sub: subtitle, variant: 'chat',
    guardClose: () => !busy,
  });
  const backdrop = page.content;

  function close() {
    if (busy) return;
    page.close();
    onClose?.();
  }

  backdrop.innerHTML = `<div class="aichat-list" data-aichat="list"></div>
    <div class="aichat-inputbar">
      <textarea data-aichat="input" rows="1" placeholder="${$esc(placeholder)}" aria-label="消息输入"></textarea>
      <button class="btn primary" data-aichat="send" aria-label="发送">➤</button>
    </div>`;

  const list = backdrop.querySelector('[data-aichat="list"]');
  const input = backdrop.querySelector('[data-aichat="input"]');
  const sendBtn = backdrop.querySelector('[data-aichat="send"]');
  if (modelEntry) ensureModelPicker(modelEntry, backdrop.querySelector('.aichat-inputbar'), input);
  if (interfaceEntry) ensureInterfacePicker(interfaceEntry, backdrop.querySelector('.aichat-inputbar'), input);

  /** 气泡内图片点击放大：组件内自建 lightbox，保持零依赖（不引入 panels 的预览弹窗） */
  function openImgPreview(src) {
    const lb = document.createElement('div');
    lb.className = 'aichat-lightbox';
    lb.innerHTML = `<img src="${$esc(src)}" alt="放大预览">`;
    lb.addEventListener('click', () => lb.remove());
    document.body.appendChild(lb);
  }

  /** 消息渲染：气泡内可含图片行、提示词块、建议 chips、动作按钮 */
  function bubbleHTML(msg) {
    const isUser = msg.role === 'user';
    const imgs = (Array.isArray(msg.images) && msg.images.length)
      ? `<div class="aichat-imgs">${msg.images.map((u) => `<img src="${$esc(u)}" alt="" loading="lazy" title="点击放大查看">`).join('')}</div>` : '';
    const pb = msg.promptBlock
      ? `<div class="aichat-promptbox"><b>✦ 画面提示词${msg.promptBlock.negative ? ' <small>（已保存，可继续对话调整）</small>' : ''}</b>
          <p>${$esc(msg.promptBlock.prompt)}</p>${msg.promptBlock.negative ? `<small>负向：${$esc(msg.promptBlock.negative)}</small>` : ''}</div>` : '';
    const chips = (Array.isArray(msg.suggestions) && msg.suggestions.length)
      ? `<div class="aichat-chips">${msg.suggestions.map((s, i) => `<button class="aichat-chip" data-aichat-chip="${i}" title="点击发送">${$esc(s)}</button>`).join('')}</div>` : '';
    const acts = (Array.isArray(msg.actions) && msg.actions.length)
      ? `<div class="aichat-acts">${msg.actions.map((a, i) => `<button class="btn sm ${a.primary ? 'primary' : ''}" data-aichat-act="${i}" ${a.disabled ? 'disabled' : ''}>${$esc(a.label)}</button>`).join('')}</div>` : '';
    // 外链产物（下载导演包 / 成片 MP4 / 导出记录）：直接用 <a> 而不是动作按钮，
    // 浏览器原生下载与 target=_blank 比 JS 转发更可靠，也不会被忙等态静默禁用。
    const links = (Array.isArray(msg.links) && msg.links.length)
      ? `<div class="aichat-links">${msg.links.map((l) => `<a class="aichat-link" href="${$esc(l.url)}" target="_blank" rel="noopener">${$esc(l.label)}</a>`).join('')}</div>` : '';
    const text = String(msg.text || '').trim();
    return `<div class="aichat-msg ${isUser ? 'user' : 'assistant'}">
      <div class="aichat-bubble">${text ? `<div class="aichat-text">${$esc(text).replace(/\n/g, '<br>')}</div>` : ''}${imgs}${pb}${links}${chips}${acts}</div></div>`;
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
      // 图片：点击放大查看（生成结果、当前封面、参考图都适用）
      el.querySelectorAll('.aichat-imgs img').forEach((img) => img.addEventListener('click', () => openImgPreview(img.src)));
      // 建议 chips：点击即作为用户消息发送；同气泡内按钮互斥（点击后全部禁用，防重复触发）
      el.querySelectorAll('[data-aichat-chip]').forEach((chip) => chip.addEventListener('click', () => {
        if (busy) return;
        disableMsgButtons(el);
        dispatchSend(chip.textContent.trim());
      }));
      // 动作按钮：交给调用方 actions 表处理
      el.querySelectorAll('[data-aichat-act]').forEach((btn) => btn.addEventListener('click', () => {
        if (busy) return;
        const act = msg.actions[Number(btn.dataset.aichatAct)];
        if (!act || act.disabled) return;
        disableMsgButtons(el);
        runTask(() => actions[act.act]?.(ui, act.data, msg) ?? Promise.resolve());
      }));
      // 忙等期间新增的消息（如提示词生成中追加的回复）：按钮同样先置灰，忙等结束后恢复
      if (busy) holdBusyButtons(el);
      return el;
    },
    /** 忙等态：输入禁用 + 打字指示（note 为进度说明，如「ComfyUI 正在生成封面…」）。
     * 同时把所有动作按钮与建议 chips 置灰（结束时任一忙等开始前可用的恢复），
     * 让「任务进行中、按钮暂不可点」成为可见状态，而不是点击被静默吞掉。 */
    setBusy(v, note = '') {
      busy = !!v;
      input.disabled = busy;
      sendBtn.disabled = busy;
      if (busy) holdBusyButtons(backdrop);
      else { busyHeld.forEach((b) => (b.disabled = false)); busyHeld = []; }
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
  if (welcome) ui.addMessage({ role: 'assistant', ...welcome });
  return ui;
}
