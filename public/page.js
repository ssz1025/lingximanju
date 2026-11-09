/* ============================================================================
 * 统一页面宿主（Page Host）—— 取代「浮层弹窗」的内容型对话框
 *
 * 设计要点：
 *  1. 页面宿主是 #main 内的独立区域（#page-root），打开时收起 #workspace，
 *     顶栏与左侧栏保持可见，用户始终知道自己还在哪个项目里。
 *  2. 页面栈：可在页面上再开子页面（资源库 → 资源详情 / 确认弹窗 → 返回），
 *     子页面覆盖在上层，「‹ 返回」回到上一层；栈空时关闭页面回到工作区。
 *  3. 页面头部统一：返回按钮 + 标题 + 说明 + 关闭按钮；内容区自由滚动。
 * ==========================================================================*/
import { $ } from './utils.js';

const stack = [];

/**
 * 以「整页」形式打开一个内容面板（showModal 的页面版替身）。
 * 参数与返回值语义与 showModal 保持一致，便于逐个迁移：
 * @param {object} o
 * @param {string} o.title      页面标题
 * @param {string} [o.sub]      标题下的说明行
 * @param {string} [o.body]     内容 HTML
 * @param {Array}  [o.actions]  [{ label, primary, onClick(root) -> keep }]
 * @param {string} [o.variant]  内容区变体（'wide' / 'chat'）
 * @returns {{root:HTMLElement, content:HTMLElement, close:Function}}
 */
export function showPage({ title, sub = '', body = '', actions = [], variant = '' }) {
  const page = openPage({ title, sub, variant });
  page.content.innerHTML = body;
  if (actions.length) {
    const foot = document.createElement('div');
    foot.className = 'page-foot';
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = `btn ${a.primary ? 'primary' : ''}`;
      b.textContent = a.label;
      b.onclick = async () => {
        const keep = await a.onClick?.(page.content);
        if (!keep) page.close();
      };
      foot.appendChild(b);
    }
    page.root.appendChild(foot);
  }
  return { root: page.content, content: page.content, close: page.close };
}

/** 当前是否有打开的页面（app.js 的 Escape / 模态判断需要） */
export function hasOpenPage() {
  return stack.length > 0;
}

/** 页面宿主根元素 */
function host() {
  return $('page-root');
}

/**
 * 打开一个页面。
 * @param {object} o
 * @param {string} o.title        页面标题
 * @param {string} [o.sub]        标题下的说明行
 * @param {string} [o.variant]    内容区变体（'wide' 全宽 / 'chat' 对话满高）
 * @param {Function} [o.onMount]  (contentEl) => void  内容区挂载后回调
 * @param {Function} [o.onClose]  () => void  页面关闭后回调
 * @param {Function} [o.onResume]  () => void  从子页面返回本页时回调
 * @returns {{root:HTMLElement, content:HTMLElement, close:Function, setTitle:Function}}
 */
export function openPage(o = {}) {
  const { title = '', sub = '', variant = '', onMount = null, onClose = null, onResume = null, guardClose = null } = o;
  const h = host();
  const prev = stack[stack.length - 1];
  if (prev) prev.root.hidden = true;

  const root = document.createElement('section');
  root.className = 'page';
  root.innerHTML = `<header class="page-head">
      <div class="page-head-l">
        <button class="btn sm" data-pg-back title="返回">‹ 返回</button>
        <div class="page-head-t">
          <h2 class="page-title"></h2>
          ${sub ? '<div class="page-sub"></div>' : ''}
        </div>
      </div>
      <button class="icon-btn" data-pg-close title="关闭" aria-label="关闭">✕</button>
    </header>
    <div class="page-content${variant ? ' ' + variant : ''}"></div>`;

  const titleEl = root.querySelector('.page-title');
  const subEl = root.querySelector('.page-sub');
  titleEl.textContent = title;
  if (subEl) subEl.textContent = sub;
  const content = root.querySelector('.page-content');
  const setSub = (t) => { if (subEl) subEl.textContent = t; };

  const entry = { root, content, onClose, onResume };
  stack.push(entry);
  h.appendChild(root);
  h.hidden = false;
  document.body.classList.add('body-page');

  const close = () => {
    if (guardClose && guardClose() === false) return;
    const i = stack.indexOf(entry);
    if (i < 0) return;
    stack.splice(i, 1);
    root.remove();
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.root.hidden = false;
      parent.onResume?.();
    } else {
      h.hidden = true;
      h.innerHTML = '';
      document.body.classList.remove('body-page');
    }
    onClose?.();
  };

  root.querySelector('[data-pg-back]').addEventListener('click', close);
  root.querySelector('[data-pg-close]').addEventListener('click', close);
  onMount?.(content);
  return { root, content, close, setTitle: (t) => { titleEl.textContent = t; }, setSub };
}

/** 关闭最上层页面（Escape 用） */
export function closeTopPage() {
  const top = stack[stack.length - 1];
  if (!top) return false;
  const i = stack.indexOf(top);
  stack.splice(i, 1);
  top.root.remove();
  const parent = stack[stack.length - 1];
  if (parent) {
    parent.root.hidden = false;
    parent.onResume?.();
  } else {
    const h = host();
    h.hidden = true;
    h.innerHTML = '';
    document.body.classList.remove('body-page');
  }
  top.onClose?.();
  return true;
}

/**
 * 关闭全部打开的页面（主动导航到别处时用）。
 * 侧栏 / 顶栏 / 快捷键都属于「离开当前页面」的动作，必须把页面栈清空，
 * 否则 #workspace 被 body-page 隐藏，视图切换看起来毫无反应。
 */
export function closeAllPages() {
  while (stack.length) {
    const top = stack.pop();
    top.root.remove();
    top.onClose?.();
  }
  const h = host();
  if (h) { h.hidden = true; h.innerHTML = ''; }
  document.body.classList.remove('body-page');
}
