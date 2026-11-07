// 连线选择器：拖拽松手后弹出的「选择下一个节点 / 选择连接关系」浮层。
// 纯自主实现，无框架依赖；支持搜索、分组、键盘操作、点击外部关闭。

import { esc, clamp } from './utils.js';

let current = null;

export function isLinkPickerOpen() { return !!current; }

export function closeLinkPicker(reason = 'cancel') {
  if (!current) return;
  const { root, onCancel, cleanup } = current;
  current = null;
  cleanup();
  root.remove();
  if (reason === 'cancel') onCancel?.();
}

/**
 * @param {object} o
 * @param {number} o.x / o.y  屏幕坐标（鼠标松手位置）
 * @param {string} o.title / o.subtitle
 * @param {Array<{key:string,label:string,items:Array}>} o.groups
 *        item: { id, icon, label, hint, color, badge, keywords, disabled }
 * @param {(item, group)=>void} o.onPick
 */
export function openLinkPicker(o) {
  closeLinkPicker('silent');

  const root = document.createElement('div');
  root.className = 'link-picker';
  root.tabIndex = -1;
  root.setAttribute('role', 'dialog');
  root.innerHTML = `
    <div class="lp-head">
      <div class="lp-head-text"><div class="lp-title"></div><div class="lp-sub"></div></div>
      <button class="lp-close" type="button" title="关闭 (Esc)">✕</button>
    </div>
    <div class="lp-search-wrap"><input class="lp-search" type="text" autocomplete="off" spellcheck="false"></div>
    <div class="lp-list"></div>
    <div class="lp-foot"><span>↑↓ 选择</span><span>Enter 确认</span><span>Esc 取消</span></div>`;
  document.body.appendChild(root);

  root.querySelector('.lp-title').textContent = o.title || '选择节点';
  root.querySelector('.lp-sub').textContent = o.subtitle || '';
  root.querySelector('.lp-sub').hidden = !o.subtitle;
  const input = root.querySelector('.lp-search');
  input.placeholder = o.placeholder || '搜索节点类型或名称…';
  const list = root.querySelector('.lp-list');

  // 贴近鼠标定位，并避开视口边界
  const w = root.offsetWidth || 320;
  const h = root.offsetHeight || 420;
  root.style.left = `${clamp(o.x + 8, 8, Math.max(8, window.innerWidth - w - 8))}px`;
  root.style.top = `${clamp(o.y + 8, 8, Math.max(8, window.innerHeight - h - 8))}px`;

  let active = 0;
  let flat = [];

  const match = (item, group, q) => {
    if (!q) return true;
    const hay = [item.label, item.hint, item.keywords, group.label].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  };

  function draw() {
    const q = input.value.trim().toLowerCase();
    flat = [];
    const html = [];
    for (const group of o.groups || []) {
      const items = (group.items || []).filter((it) => match(it, group, q));
      if (!items.length) continue;
      // 未搜索时按 limit 收起长列表，输入关键词后展示该组全部匹配项
      const shown = !q && group.limit ? items.slice(0, group.limit) : items;
      html.push(`<div class="lp-group">${esc(group.label)}${group.hint ? `<span class="lp-group-hint">${esc(group.hint)}</span>` : ''}</div>`);
      for (const it of shown) {
        const idx = flat.length;
        flat.push({ item: it, group });
        const color = it.color || 'var(--accent)';
        html.push(`<div class="lp-item${it.disabled ? ' disabled' : ''}${idx === active ? ' active' : ''}" data-i="${idx}" style="--lp-color:${esc(color)}">
          <span class="lp-ico">${esc(it.icon || '·')}</span>
          <span class="lp-label">${esc(it.label)}</span>
          ${it.hint ? `<span class="lp-hint">${esc(it.hint)}</span>` : ''}
          ${it.badge ? `<span class="lp-badge">${esc(it.badge)}</span>` : ''}
        </div>`);
      }
      if (shown.length < items.length) {
        html.push(`<div class="lp-more">还有 ${items.length - shown.length} 项 · 输入关键词可搜索全部</div>`);
      }
    }
    if (!flat.length) {
      list.innerHTML = `<div class="lp-empty">没有匹配的选项<br><small>换个关键词，或按 Esc 取消</small></div>`;
    } else {
      if (active >= flat.length) active = flat.length - 1;
      list.innerHTML = html.join('');
      // 过滤后 active 可能越界，重绘一次高亮
      list.querySelectorAll('.lp-item').forEach((el) => el.classList.toggle('active', Number(el.dataset.i) === active));
    }
  }

  function move(delta) {
    if (!flat.length) return;
    active = (active + delta + flat.length) % flat.length;
    list.querySelectorAll('.lp-item').forEach((el) => el.classList.toggle('active', Number(el.dataset.i) === active));
    const act = list.querySelector('.lp-item.active');
    if (!act) return;
    // 部分 webview / DOM 实现没有 scrollIntoView，降级为手动滚动
    if (typeof act.scrollIntoView === 'function') act.scrollIntoView({ block: 'nearest' });
    else list.scrollTop = Math.max(0, act.offsetTop - list.clientHeight / 2);
  }

  function pick(idx) {
    const entry = flat[idx];
    if (!entry || entry.item.disabled) return;
    const chosen = { item: entry.item, group: entry.group };
    closeLinkPicker('silent');
    o.onPick?.(chosen.item, chosen.group);
  }

  input.addEventListener('input', () => { active = 0; draw(); });
  root.addEventListener('keydown', (e) => {
    e.stopPropagation(); // 避免触发画布快捷键（R / Delete / Space 等）
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape') { e.preventDefault(); closeLinkPicker('cancel'); }
  });
  list.addEventListener('pointermove', (e) => {
    const el = e.target.closest('.lp-item');
    if (!el || el.classList.contains('disabled')) return;
    active = Number(el.dataset.i);
    list.querySelectorAll('.lp-item').forEach((x) => x.classList.toggle('active', x === el));
  });
  list.addEventListener('click', (e) => {
    const el = e.target.closest('.lp-item');
    if (el) pick(Number(el.dataset.i));
  });
  root.querySelector('.lp-close').addEventListener('click', () => closeLinkPicker('cancel'));

  const dismiss = (e) => { if (!root.contains(e.target)) closeLinkPicker('cancel'); };
  const onResize = () => closeLinkPicker('cancel');
  const cleanup = () => {
    clearTimeout(timer);
    document.removeEventListener('pointerdown', dismiss, true);
    window.removeEventListener('resize', onResize);
  };
  const timer = setTimeout(() => {
    document.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('resize', onResize);
  }, 0);

  current = { root, onCancel: o.onCancel, cleanup };
  draw();
  input.focus();
  return root;
}
