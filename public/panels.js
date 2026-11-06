// 检查器、对话、设置、弹窗、右键菜单、Toast 等 UI 组件
import { NODE_TYPES, typeOf, STATUS_LABEL, previewHTML } from './nodes.js';

const $ = (id) => document.getElementById(id);
const esc = (s = '') => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v) => (v === undefined || v === null || v === '' ? '—' : String(v));

/* ---------- Toast ---------- */
export function toast(message, type = '') {
  const root = $('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; el.style.transition = '.25s'; }, 2800);
  setTimeout(() => el.remove(), 3100);
}

/* ---------- 通用弹窗 ---------- */
export function showModal({ title, sub = '', body = '', actions = [] }) {
  const root = $('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal">
    <h2>${esc(title)}</h2>${sub ? `<div class="sub">${sub}</div>` : ''}
    <div class="modal-body">${body}</div>
    <div class="modal-actions"></div>
  </div>`;
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const actionsEl = backdrop.querySelector('.modal-actions');
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = `btn ${a.primary ? 'primary' : ''}`;
    b.textContent = a.label;
    b.onclick = async () => { const keep = await a.onClick?.(backdrop); if (!keep) close(); };
    actionsEl.appendChild(b);
  }
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  root.appendChild(backdrop);
  return { root: backdrop, close };
}

/* ---------- 设置：模型运行 + 本地 ComfyUI / 最终产物 ---------- */
const WF_HELP = `直接粘贴 ComfyUI 工作流菜单里「导出(API) / Export (API)」得到的 JSON，无需改动节点图。
程序会自动识别 CLIPTextEncode / KSampler / EmptyLatentImage / LoadImage / 输出节点并注入参数；
也可在任意字符串输入里写占位符：{{prompt}} {{negative_prompt}} {{seed}} {{width}} {{height}} {{frames}} {{fps}} {{duration}} {{filename_prefix}} {{title}} {{shot_no}}。`;

export async function openSettings(project, onSave) {
  const s = project.settings || {};
  let cfg = {};
  try {
    const r = await fetch('/api/comfyui/config');
    cfg = (await r.json()).config || {};
  } catch { /* 后端不可达时仍允许编辑模型设置 */ }

  const num = (v, d) => `<input id="cf-${v}" type="number" value="${esc(cfg[v] ?? d)}">`;
  const body = `
    <div class="settings-tabs">
      <button class="settings-tab active" data-pane="model">模型与运行</button>
      <button class="settings-tab" data-pane="comfy">本地 ComfyUI / 最终产物</button>
    </div>

    <div class="settings-pane" id="pane-model">
      <div class="modal-grid">
        <div class="field"><label>模型模式</label><select id="set-provider">
          <option value="mock" ${s.provider !== 'openai' ? 'selected' : ''}>Mock · 零 Key 演示</option>
          <option value="openai" ${s.provider === 'openai' ? 'selected' : ''}>OpenAI 兼容接口</option></select></div>
        <div class="field"><label>模型名称</label><input id="set-model" value="${esc(s.model || '')}" placeholder="gpt-4o-mini"></div>
        <div class="field" style="grid-column:1/-1"><label>Base URL</label><input id="set-base" value="${esc(s.baseUrl || '')}" placeholder="https://api.example.com/v1"></div>
        <div class="field" style="grid-column:1/-1"><label>API Key（仅存本地）</label><input id="set-key" type="password" value="${esc(s.apiKey || '')}" placeholder="sk-..."></div>
        <div class="field"><label>best-of-k 候选数</label><input id="set-k" type="number" min="1" max="4" value="${s.k || 2}"></div>
        <div class="field"><label>最大并发</label><input id="set-conc" type="number" min="1" max="8" value="${s.concurrency || 3}"></div>
        <div class="field"><label>画面风格</label><select id="set-style">
          ${['noir', 'cinematic', 'anime', 'watercolor'].map((v) => `<option value="${v}" ${s.style === v ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
        <div class="field"><label>画幅</label><select id="set-aspect"><option value="16:9" ${s.aspect !== '9:16' ? 'selected' : ''}>16:9 横屏</option><option value="9:16" ${s.aspect === '9:16' ? 'selected' : ''}>9:16 竖屏</option></select></div>
        <div class="field" style="grid-column:1/-1"><label>图像接口（可选，留空使用本地生成）</label><input id="set-img" value="${esc(s.imageEndpoint || '')}" placeholder="https://.../images/generations"></div>
      </div>
      <div class="cf-note">LLM 只负责剧本 / 分镜 / 机位规划；画面与视频由下方 ComfyUI 工作流生成。</div>
    </div>

    <div class="settings-pane" id="pane-comfy" hidden>
      <div class="cf-section">
        <div class="cf-row">
          <label class="cf-check"><input type="checkbox" id="cf-enabled" ${cfg.enabled !== false ? 'checked' : ''}> 启用本地 ComfyUI 生成</label>
          <label class="cf-check"><input type="checkbox" id="cf-strict" ${cfg.strict ? 'checked' : ''}> 严格模式（失败不回退 Mock）</label>
        </div>
        <div class="field"><label>ComfyUI 地址</label><input id="cf-base" value="${esc(cfg.baseUrl || 'http://127.0.0.1:8188')}" placeholder="http://127.0.0.1:8188"></div>
        <div class="cf-note">需以 <code>--listen 127.0.0.1 --port 8188</code> 启动 ComfyUI。未配置对应工作流时，该环节自动使用 Mock 自绘，流水线不会中断。</div>
      </div>

      <div class="cf-section">
        <h4>出图工作流库（关键帧 / 角色 / 转场 / 海报）</h4>
        <div class="cf-note">${esc(WF_HELP).replace(/\n/g, '<br>')}</div>
        <div class="cf-row" style="margin-top:9px">
          <button class="btn" id="cf-import-image" type="button">⇧ 导入 JSON</button>
          <button class="btn" id="cf-testall-image" type="button">▶ 测试全部</button>
        </div>
        <div class="wf-lib" id="cf-lib-image"></div>
      </div>

      <div class="cf-section">
        <h4>视频工作流库（图生视频 / 首尾帧 / 导演台）</h4>
        <div class="cf-note">选中项即当前生效的工作流，切换即时生效；无选中时该环节使用 Mock 自绘。测试 = 提交本地 ComfyUI 真实串行试跑一次。</div>
        <div class="cf-row" style="margin-top:9px">
          <button class="btn" id="cf-import-video" type="button">⇧ 导入 JSON</button>
          <button class="btn" id="cf-testall-video" type="button">▶ 测试全部</button>
        </div>
        <div class="wf-lib" id="cf-lib-video"></div>
      </div>

      <div class="cf-section">
        <h4>生成参数</h4>
        <div class="modal-grid">
          <div class="field"><label>宽</label>${num('width', 864)}</div>
          <div class="field"><label>高</label>${num('height', 480)}</div>
          <div class="field"><label>帧率 fps</label>${num('fps', 24)}</div>
          <div class="field"><label>单镜头帧数</label>${num('frames', 124)}</div>
          <div class="field"><label>采样步数</label>${num('steps', 25)}</div>
          <div class="field"><label>CFG</label>${num('cfg', 1)}</div>
        </div>
        <div class="field"><label>全局负向提示词</label><input id="cf-negative" value="${esc(cfg.negativePrompt || '')}"></div>
      </div>

      <div class="cf-section">
        <h4>最终产物（可同时产出）</h4>
        <div class="modal-grid">
          <div class="field"><label>产物模式</label><select id="cf-mode">
            <option value="both" ${cfg.outputMode !== 'video' && cfg.outputMode !== 'director-pack' ? 'selected' : ''}>两种都要（推荐）</option>
            <option value="video" ${cfg.outputMode === 'video' ? 'selected' : ''}>只生成成片视频</option>
            <option value="director-pack" ${cfg.outputMode === 'director-pack' ? 'selected' : ''}>只导出导演包</option>
          </select></div>
          <div class="field"><label>导演包目标</label><select id="cf-target">
            <option value="minimax-h3" ${cfg.packTarget !== 'generic' ? 'selected' : ''}>MiniMax H3 Director · mmxpack.zip</option>
            <option value="generic" ${cfg.packTarget === 'generic' ? 'selected' : ''}>通用 ComfyUI 包</option>
          </select></div>
        </div>
        <label class="cf-check"><input type="checkbox" id="cf-stitch" ${cfg.stitch !== false ? 'checked' : ''}> 用本机 ffmpeg 把 ComfyUI 片段拼成一条成片 MP4</label>
        <div class="cf-note">导演包包含 pack.json、shared_params/、asset_groups/NN/group.json、timeline.json，可被 ComfyUI 导演工作台「Import pack」直接读取；extra/ 附带中文分镜表与原始 API 工作流。</div>
      </div>

      <div id="cf-result" class="cf-result" hidden></div>
    </div>`;

  const modal = showModal({
    title: '模型、ComfyUI 与最终产物设置',
    sub: '图片与视频主路径为本地 ComfyUI（直接使用导出的 API 工作流）。连接配置全局保存，项目设置单独保存；所有数据只写入本地 data/ 目录。',
    body,
    actions: [
      { label: '取消' },
      { label: '测试连接', onClick: async (root) => {
        const box = root.querySelector('#cf-result');
        box.hidden = false;
        box.textContent = '正在连接 ComfyUI…';
        try {
          const r = await fetch('/api/comfyui/test', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ baseUrl: root.querySelector('#cf-base').value.trim() }),
          });
          const d = await r.json();
          box.innerHTML = d.ok
            ? `<b class="ok">✓ 已连接</b> ${esc(d.baseUrl)} · ComfyUI ${esc(d.version)} · ${esc(d.device)}`
            : `<b class="err">✕ 连接失败</b> ${esc(d.error)}`;
        } catch (e) { box.innerHTML = `<b class="err">✕</b> ${esc(e.message)}`; }
        return true;
      } },
      { label: '保存设置', primary: true, onClick: async (root) => {
        const q = (id) => root.querySelector(`#${id}`);
        const box = q('cf-result');
        try {
          const patch = {
            enabled: q('cf-enabled').checked,
            strict: q('cf-strict').checked,
            baseUrl: q('cf-base').value.trim(),
            width: Number(q('cf-width').value) || 864,
            height: Number(q('cf-height').value) || 480,
            fps: Number(q('cf-fps').value) || 24,
            frames: Number(q('cf-frames').value) || 124,
            steps: Number(q('cf-steps').value) || 25,
            cfg: Number(q('cf-cfg').value) || 1,
            negativePrompt: q('cf-negative').value,
            outputMode: q('cf-mode').value,
            packTarget: q('cf-target').value,
            stitch: q('cf-stitch').checked,
          };
          const r = await fetch('/api/comfyui/config', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
          onSave({
            ...project.settings,
            provider: q('set-provider').value, model: q('set-model').value.trim(),
            baseUrl: q('set-base').value.trim(), apiKey: q('set-key').value.trim(),
            k: Number(q('set-k').value) || 2, concurrency: Number(q('set-conc').value) || 3,
            style: q('set-style').value, aspect: q('set-aspect').value,
            imageEndpoint: q('set-img').value.trim(),
          });
          toast('ComfyUI 与产物配置已保存', 'ok');
          return false;
        } catch (e) {
          box.hidden = false;
          box.innerHTML = `<b class="err">✕ 保存失败</b> ${esc(e.message)}`;
          return true;
        }
      } },
    ],
  });

  const root = modal.root;
  root.querySelectorAll('.settings-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      root.querySelectorAll('.settings-tab').forEach((t) => t.classList.toggle('active', t === tab));
      root.querySelector('#pane-model').hidden = tab.dataset.pane !== 'model';
      root.querySelector('#pane-comfy').hidden = tab.dataset.pane !== 'comfy';
    });
  });

  /* ---------- 工作流库：选中生效 / 展开 / 重命名 / 删除 ---------- */
  const libKey = (kind) => `${kind}WorkflowLib`;
  const activeKey = (kind) => `${kind}ActiveId`;
  const testing = new Set();   // 正在试跑的库项 id → 行内转圈（Task 7 接线）

  const postJSON = async (url, body) => {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  };

  const libItemHTML = (kind, e) => {
    const t = e.lastTest;
    const active = e.id === cfg[activeKey(kind)];
    const badge = testing.has(e.id)
      ? `<span class="wf-badge run"><span class="wf-spin"></span>试跑中</span>`
      : !t ? `<span class="wf-badge none" title="尚未真实试跑">未测</span>`
      : t.ok ? `<span class="wf-badge ok" title="上次试跑：${esc(new Date(t.at || Date.now()).toLocaleString())}">✓ ${(Number(t.durationMs) / 1000).toFixed(1)}s</span>`
      : `<span class="wf-badge err" title="${esc(t.error || '失败')}">✕ ${esc(String(t.error || '失败').slice(0, 18))}</span>`;
    return `<div class="wf-item ${active ? 'active' : ''}" data-id="${esc(e.id)}">
      <input type="radio" name="wf-pick-${kind}" ${active ? 'checked' : ''} data-act="pick" title="选中即当前生效">
      <span class="wf-name" data-act="expand" title="点击查看 / 复制 JSON · 双击重命名">${esc(e.name)}</span>
      <span class="wf-nodes">${Object.keys(e.workflow || {}).length} 节点</span>
      ${badge}
      <button class="wf-del" type="button" data-act="del" title="删除">✕</button>
      <textarea class="cf-code wf-json" rows="7" readonly hidden>${esc(JSON.stringify(e.workflow, null, 2))}</textarea>
    </div>`;
  };

  const renderLib = (kind) => {
    const box = root.querySelector(`#cf-lib-${kind}`);
    if (!box) return;
    const lib = cfg[libKey(kind)] || [];
    box.innerHTML = lib.length
      ? lib.map((e) => libItemHTML(kind, e)).join('')
      : `<div class="wf-empty">暂无工作流 · 点「⇧ 导入 JSON」选择本地 ComfyUI「导出(API)」文件（可多选）</div>`;
  };

  const applyConfig = (d) => {
    if (d?.config) { cfg = d.config; renderLib('image'); renderLib('video'); }
  };

  const deleteItem = async (kind, entry, isActive) => {
    try {
      const r = await fetch(`/api/comfyui/library/${kind}/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      applyConfig(d);
      toast(isActive ? `已删除「${entry.name}」· 该环节已回退 Mock 自绘` : `已删除「${entry.name}」`, 'ok');
    } catch (e) { toast(`删除失败：${e.message}`, 'err'); }
  };

  const requestDelete = (kind, entry) => {
    const isActive = cfg[activeKey(kind)] === entry.id;
    if (!isActive) { deleteItem(kind, entry, false); return; }
    showModal({
      title: '删除正在使用的工作流？',
      sub: `「${esc(entry.name)}」是当前生效的工作流，删除后该环节回退到 Mock 自绘。`,
      actions: [
        { label: '取消' },
        { label: '删除', primary: true, onClick: async () => { await deleteItem(kind, entry, true); } },
      ],
    });
  };

  const pickActive = async (kind, entry) => {
    try {
      const r = await fetch('/api/comfyui/library', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, id: entry.id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      applyConfig(d);
      toast(`生效工作流已切换为「${entry.name}」`, 'ok');
    } catch (e) { toast(`切换失败：${e.message}`, 'err'); }
  };

  const startRename = (kind, item, entry) => {
    const span = item.querySelector('.wf-name');
    if (!span) return;
    const input = document.createElement('input');
    input.className = 'wf-rename';
    input.value = entry.name;
    span.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (commit && next && next !== entry.name) {
        try {
          const r = await fetch('/api/comfyui/library', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind, id: entry.id, name: next }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
          applyConfig(d);
          toast(`已重命名为「${next}」`, 'ok');
          return;
        } catch (e) {
          toast(`重命名失败：${e.message}`, 'err');
        }
      }
      renderLib(kind);
    };
    input.addEventListener('keydown', (ke) => {
      if (ke.key === 'Enter') finish(true);
      if (ke.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  };

  const setupLib = (kind) => {
    const box = root.querySelector(`#cf-lib-${kind}`);
    if (!box) return;
    box.addEventListener('click', (ev) => {
      const item = ev.target.closest('.wf-item');
      if (!item) return;
      const entry = (cfg[libKey(kind)] || []).find((e) => e.id === item.dataset.id);
      if (!entry) return;
      const act = ev.target.dataset.act;
      if (act === 'expand') {
        const ta = item.querySelector('.wf-json');
        if (ta) ta.hidden = !ta.hidden;
        return;
      }
      if (act === 'del') { requestDelete(kind, entry); return; }
      if (ev.target.matches('input[data-act="pick"]') && cfg[activeKey(kind)] !== entry.id) {
        pickActive(kind, entry);
      }
    });
    box.addEventListener('dblclick', (ev) => {
      const item = ev.target.closest('.wf-item');
      if (!item || !ev.target.classList.contains('wf-name')) return;
      const entry = (cfg[libKey(kind)] || []).find((e) => e.id === item.dataset.id);
      if (entry) startRename(kind, item, entry);
    });
  };

  /* ---------- 批量真实试跑（进度经 SSE log 事件回显） ---------- */
  let testES = null;
  const testBatch = async (kind, ids) => {
    if (!ids.length) { toast('库为空，先导入工作流', 'err'); return; }
    ids.forEach((id) => testing.add(id));
    renderLib(kind);
    const box = root.querySelector('#cf-result');
    box.hidden = false;
    box.innerHTML = `<div class="wf-run"><span class="wf-spin"></span> 串行试跑 ${ids.length} 项 · 进度实时回显</div>`;
    testES?.close();
    testES = new EventSource('/api/events');
    testES.onmessage = (ev) => {
      let e; try { e = JSON.parse(ev.data); } catch { return; }
      if (e.type !== 'log' || e.source !== 'wf-test') return;
      if (!document.contains(box)) { testES?.close(); testES = null; return; }
      const line = document.createElement('div');
      if (e.level === 'error') line.className = 'err';
      line.textContent = e.message;
      box.appendChild(line);
      box.scrollTop = box.scrollHeight;
    };
    try {
      const d = await postJSON('/api/comfyui/test-batch', { kind, ids });
      if (d.connectionError) throw new Error(d.connectionError);
      applyConfig(d);
      const ok = d.results.filter((x) => x.ok).length;
      const fail = d.results.length - ok;
      box.querySelector('.wf-run')?.remove();
      box.insertAdjacentHTML('afterbegin',
        `<b class="${fail ? 'err' : 'ok'}">${fail ? '试跑完成（存在失败项）' : '✓ 试跑全部成功'}</b> 成功 ${ok} · 失败 ${fail}`);
      box.scrollTop = 0;
      toast(`试跑完成：成功 ${ok} · 失败 ${fail}`, fail ? '' : 'ok');
    } catch (e) {
      const conn = /无法连接/.test(e.message);
      box.querySelector('.wf-run')?.remove();
      box.insertAdjacentHTML('afterbegin',
        `<b class="err">✕ ${conn ? 'ComfyUI 连接失败' : '试跑失败'}</b> ${esc(e.message)}${conn ? ' · 请先启动 ComfyUI（--listen 127.0.0.1 --port 8188）' : ''}`);
      box.scrollTop = 0;
      toast(`试跑失败：${e.message}`, 'err');
    } finally {
      testES?.close(); testES = null;
      ids.forEach((id) => testing.delete(id));
      renderLib(kind);
    }
  };

  /* ---------- 多选导入：入库 → toast 汇总 → 自动逐个串行试跑 ---------- */
  const importLib = (kind) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      const box = root.querySelector('#cf-result');
      box.hidden = false;
      const items = [];
      const bad = [];
      for (const f of files) {
        try { items.push({ name: f.name.replace(/\.json$/i, ''), workflow: JSON.parse(await f.text()) }); }
        catch { bad.push(f.name); }
      }
      if (bad.length) toast(`${bad.length} 个文件不是合法 JSON：${bad.join('、')}`, 'err');
      if (!items.length) return;
      box.textContent = `正在导入 ${items.length} 个文件…`;
      try {
        const d = await postJSON('/api/comfyui/library', { kind, items });
        applyConfig(d);
        const summary = `新增 ${d.added.length}${d.failed.length ? ` · 失败 ${d.failed.length}` : ''}`;
        box.innerHTML = d.failed.length
          ? `<b class="ok">✓ ${summary}</b><div class="cf-code" style="margin-top:6px">${d.failed.map((x) => `<div><b class="err">✕ ${esc(x.name)}</b> ${esc(x.error)}</div>`).join('')}</div>`
          : `<b class="ok">✓ ${summary}</b> 已入库，开始自动串行试跑…`;
        toast(summary, d.failed.length ? '' : 'ok');
        if (d.added.length) await testBatch(kind, d.added.map((x) => x.id));
      } catch (e) {
        box.innerHTML = `<b class="err">✕ 导入失败</b> ${esc(e.message)}`;
        toast(`导入失败：${e.message}`, 'err');
      }
    };
    input.click();
  };

  for (const kind of ['image', 'video']) {
    setupLib(kind);
    renderLib(kind);
    root.querySelector(`#cf-import-${kind}`).addEventListener('click', () => importLib(kind));
    root.querySelector(`#cf-testall-${kind}`).addEventListener('click', () =>
      testBatch(kind, (cfg[libKey(kind)] || []).map((e) => e.id)));
  }
}

/* ---------- 新建项目 ---------- */
export function openNewProject(templates, onCreate) {
  const body = `<div class="field"><label>项目名称</label><input id="np-name" value="未命名影片" placeholder="给项目起个名字"></div>
    <div class="field"><label>选择流水线模板</label><div id="np-templates" style="display:flex;flex-direction:column;gap:6px">
      ${templates.map((t, i) => `<label style="display:flex;gap:9px;align-items:flex-start;padding:9px;border:1px solid var(--border);border-radius:9px;cursor:pointer;background:var(--panel-2)">
        <input type="radio" name="np-tpl" value="${t.id}" ${i === 0 ? 'checked' : ''} style="margin-top:3px">
        <span><strong style="font-size:12px">${t.icon} ${esc(t.name)}</strong><br><small style="color:var(--muted);font-size:10.5px">${esc(t.description)}</small></span>
      </label>`).join('')}
    </div></div>
    <div class="field"><label>创作想法（可选）</label><textarea id="np-idea" rows="2" placeholder="例如：一位侦探在雨夜收到一封没有署名的信"></textarea></div>`;
  showModal({
    title: '新建项目', sub: '模板会生成一张可任意修改的初始节点图，运行后画布会自动生长出事件、场景与镜头链。', body,
    actions: [{ label: '取消' }, { label: '创建项目', primary: true, onClick: (root) => {
      onCreate({
        name: root.querySelector('#np-name').value.trim() || '未命名影片',
        template: root.querySelector('input[name="np-tpl"]:checked')?.value || 'idea2video',
        idea: root.querySelector('#np-idea').value.trim(),
      });
    } }],
  });
}

/* ---------- 快捷键帮助 ---------- */
export function openHelp() {
  const rows = [
    ['空格 + 拖拽 / 中键', '平移画布'], ['滚轮', '以指针为中心缩放'], ['拖拽节点', '移动（支持多选整体移动）'],
    ['空白处拖拽', '框选多个节点'], ['从右侧端口拖出并松手', '弹窗选下一个节点：新建 / 连接已有'],
    ['拖到目标节点后松手', '弹窗选 flow / anchor / ref 连接关系'], ['Alt / Shift + 拖线到节点', '跳过弹窗，直接连 anchor / ref'],
    ['从节点库拖入画布', '弹窗选要连接的上游节点，Esc 跳过'], ['双击节点', '在检查器中编辑'],
    ['右键节点', '单节点重跑 / 复制 / 删除'],
    ['Ctrl/Cmd + Z', '撤销'], ['Ctrl/Cmd + Shift + Z', '重做'], ['Ctrl/Cmd + D', '复制选中节点'],
    ['Delete / Backspace', '删除选中节点'], ['Ctrl/Cmd + A', '全选'], ['F', '适应视图'],
    ['L', '自动布局'], ['R', '运行完整流水线'], ['Esc', '取消选择 / 关闭弹窗'],
    ['N', '新建创作项目（上传小说 → 分集 → 视频 / 导演包）'],
    ['S', '执行创作项目的下一步任务'], ['P', '打开项目管理面板（分集 / 产物 / 快照）'],
    ['右侧「任务步骤」Tab', '六步执行清单、四态视觉提示与对应的论文公式'],
  ];
  showModal({ title: '快捷键与交互', sub: '无限画布完整保留；创作项目在「任务步骤」Tab 逐步执行，画布节点随每一步生长。',
    body: `<div class="help-grid">${rows.map(([k, v]) => `<kbd>${esc(k)}</kbd><span>${esc(v)}</span>`).join('')}</div>`,
    actions: [{ label: '知道了', primary: true }] });
}

/* ---------- 资产预览 ---------- */
export function openAssetPreview(url, title = '资产预览') {
  showModal({ title, sub: 'Mock 模式下的画面由本地自绘 SVG 生成；接入真实图像模型后会替换为模型输出。',
    body: `<img src="${esc(url)}" style="width:100%;border-radius:10px;border:1px solid var(--border)">`,
    actions: [{ label: '关闭', primary: true }] });
}

/* ---------- 右键菜单 ---------- */
export function showContextMenu(x, y, items) {
  const menu = $('context-menu');
  menu.innerHTML = '';
  for (const item of items) {
    if (item.sep) { const d = document.createElement('div'); d.className = 'cm-sep'; menu.appendChild(d); continue; }
    const b = document.createElement('button');
    b.className = item.danger ? 'danger' : '';
    b.innerHTML = `<span>${item.icon || '·'}</span><span>${esc(item.label)}</span>`;
    b.onclick = () => { menu.hidden = true; item.action(); };
    menu.appendChild(b);
  }
  menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - items.length * 32 - 20)}px`;
  menu.hidden = false;
  const dismiss = (e) => { if (!menu.contains(e.target)) { menu.hidden = true; document.removeEventListener('pointerdown', dismiss); } };
  setTimeout(() => document.addEventListener('pointerdown', dismiss), 0);
}
export const hideContextMenu = () => { $('context-menu').hidden = true; };

/* ---------- 检查器 ---------- */
export function renderInspector(node, project, handlers) {
  const box = $('insp-props');
  if (!node) {
    box.innerHTML = `<div class="insp-placeholder"><span class="big">◈</span>点击画布上的任意节点<br>查看属性、产物与运行信息<br><br><small>提示：右键节点可单独重跑</small></div>`;
    return;
  }
  const t = typeOf(node.type);
  const d = node.data || {};
  const meta = node.meta || {};
  const imageUrl = d.poster || d.keyframeUrl || d.transition?.url || d.url || d.clip?.poster || d.candidates?.[0]?.url || d.characters?.[0]?.portraitUrl;

  const fields = [
    { key: '__title', label: '节点标题', type: 'text', value: node.title },
    ...(t.fields || []).map((f) => ({ ...f, value: d[f.key] })),
    { key: '__agent', label: '绑定智能体', type: 'text', value: node.agent || '' },
  ];
  const fieldHTML = fields.map((f) => `<div class="field"><label>${esc(f.label)}</label>${
    f.type === 'textarea'
      ? `<textarea data-field="${esc(f.key)}" rows="4">${esc(f.value ?? '')}</textarea>`
      : `<input data-field="${esc(f.key)}" type="${f.type === 'number' ? 'number' : 'text'}" value="${esc(f.value ?? '')}">`
  }</div>`).join('');

  const kv = (k, v) => `<div class="insp-kv"><span>${esc(k)}</span><span>${esc(fmt(v))}</span></div>`;
  const extra = [];
  if (d.script) extra.push(kv('剧本', `${d.script.title || ''} · ${d.script.genre || ''}`));
  if (d.shotPlan) extra.push(kv('规划镜头', d.plannedShots || d.shotPlan.reduce((a, s) => a + (s.shots?.length || 0), 0)));
  if (d.shots) extra.push(kv('镜头数', d.shots.length));
  if (d.candidates) extra.push(kv('候选择优', `${(d.selected ?? 0) + 1} / ${d.candidates.length}`));
  if (d.context) extra.push(kv('检索片段', d.context.passages?.length || 0));
  if (d.cameras) extra.push(kv('机位 / 锚点', `${d.cameras.length} / ${d.anchorCount || 0}`));
  if (d.timeline) extra.push(kv('成片时长', `${d.duration}s`));
  if (d.clip) extra.push(kv('片段时长', `${d.duration}s`));

  let details = '';
  if (d.script?.scenes) details = `<div class="insp-card"><h4>剧本场景</h4><div class="pre">${esc(d.script.scenes.map((s, i) => `${i + 1}. ${s.location}（${s.time}）\n   ${s.summary}`).join('\n'))}</div></div>`;
  else if (d.shots?.length) details = `<div class="insp-card"><h4>分镜表</h4><div class="pre">${esc(d.shots.map((s) => `${s.shotNo}. ${s.size} · ${s.angle} · ${s.movement} · ${s.duration}s\n   ${s.ffDesc}`).join('\n'))}</div></div>`;
  else if (d.events?.length) details = `<div class="insp-card"><h4>事件图谱</h4><div class="pre">${esc(d.events.map((e, i) => `${i + 1}. ${e.title}\n   ${(e.processChain || []).join(' → ')}`).join('\n'))}</div></div>`;
  else if (d.context?.passages) details = `<div class="insp-card"><h4>RAG 检索片段</h4><div class="pre">${esc([...d.context.passages, ...(d.context.notes || [])].join('\n'))}</div></div>`;
  else if (d.cameras?.length) details = `<div class="insp-card"><h4>机位依赖</h4><div class="pre">${esc(d.cameras.map((c) => `${c.label} ← ${c.parent || '根节点'}｜镜头 ${c.shotNos.join(',')}\n   ${c.reason}`).join('\n'))}</div></div>`;
  else if (d.timeline?.length) details = `<div class="insp-card"><h4>成片时间线</h4><div class="pre">${esc(d.timeline.map((x) => `${x.index}. ${x.title} · ${x.duration}s`).join('\n'))}</div></div>`;
  else if (d.reason) details = `<div class="insp-card"><h4>VLM 评审意见</h4><div class="pre">${esc(d.reason)}</div></div>`;
  else if (d.transition) details = `<div class="insp-card"><h4>空间锚点</h4><div class="pre">${esc(`${d.transition.axisRule} 轴线\n${d.transition.spatialNotes}\n${d.transition.cameraPath}`)}</div></div>`;

  if (d.deliverables || d.film || d.directorPack) {
    const dv = d.deliverables || {};
    const film = d.film;
    const pack = d.directorPack;
    const filmDesc = film
      ? `${film.clips} 个 ComfyUI 片段 · ${film.method} · ${(film.bytes / 1024).toFixed(0)} KB`
      : (dv.video?.note || '未生成');
    const packDesc = pack
      ? `${pack.filename} · ${pack.shotCount || 0} 组 · ${pack.fileCount || 0} 文件 · ${(pack.bytes / 1024).toFixed(0)} KB`
      : '未生成（顶栏「导演包」可即时导出）';
    details += `<div class="insp-card"><h4>最终产物</h4>
      <div class="deliver-item"><strong>① 本地 ComfyUI 成片</strong><div class="cf-note">${esc(filmDesc)}</div>
        ${film ? '<button class="btn" data-act="download-film" style="margin-top:6px">⇩ 下载成片 MP4</button>' : ''}</div>
      <div class="deliver-item"><strong>② 导演包 · ComfyUI 导演工作台</strong><div class="cf-note">${esc(packDesc)}</div>
        <div class="insp-actions" style="margin-top:6px">
          ${pack ? '<button class="btn" data-act="download-pack">⇩ 下载导演包</button>' : ''}
          <button class="btn" data-act="regen-pack">↻ 重新导出</button>
        </div></div>
      <div class="cf-note">产物模式：${esc(dv.outputMode || d.outputMode || 'both')}${pack?.target ? ` · 目标 ${esc(pack.target)}` : ''}</div>
    </div>`;
  }

  box.innerHTML = `
    <div class="insp-card" style="border-left:3px solid ${t.color}">
      <div style="display:flex;align-items:center;gap:9px;margin-bottom:8px">
        <span style="font-size:20px;color:${t.color}">${t.icon}</span>
        <div style="flex:1;min-width:0"><strong style="font-size:13px">${esc(node.title)}</strong>
        <div style="font-size:10.5px;color:var(--muted);margin-top:2px">${t.label} · ${esc(STATUS_LABEL[node.status] || node.status)}</div></div>
      </div>
      <div style="font-size:10px;color:var(--muted);word-break:break-all">ID: <code>${esc(node.id)}</code> <button class="mini-btn" id="btn-copy-id" style="float:right">复制</button></div>
    </div>

    ${imageUrl ? `<div class="insp-card"><h4>产物预览</h4><img class="insp-img preview-click" src="${esc(imageUrl)}" alt="预览">${d.candidates?.length > 1 ? `<div style="display:flex;gap:5px">${d.candidates.map((c, i) => `<img class="insp-img preview-click" src="${esc(c.url)}" style="width:48%;${i === d.selected ? 'outline:2px solid var(--green)' : ''}">`).join('')}</div>` : ''}</div>` : ''}

    <div class="insp-card"><h4>运行状态</h4>
      ${kv('状态', STATUS_LABEL[node.status] || node.status)}
      ${kv('智能体', node.agent || '无（数据节点）')}
      ${kv('进度', `${Math.round((node.progress || 0) * 100)}%`)}
      ${kv('耗时', meta.durationMs ? `${meta.durationMs} ms` : '—')}
      ${kv('估算成本', meta.cost ? `$${meta.cost}` : '—')}
      ${node.error ? kv('错误', node.error) : ''}
      ${extra.join('')}
    </div>

    ${details}

    <div class="insp-card"><h4>编辑</h4>${fieldHTML}
      <div class="insp-actions">
        <button class="btn" data-act="pick-asset">▣ 从资源库选图</button>
        <button class="btn" data-act="rerun">↻ 从此处重跑</button>
        <button class="btn" data-act="focus">⌖ 聚焦</button>
        <button class="btn" data-act="dup">⧉ 复制</button>
        <button class="btn" data-act="chat">@ 问 Agent</button>
        <button class="btn" data-act="delete" style="color:var(--red)">✕ 删除</button>
      </div>
    </div>

    <div class="insp-card"><h4>原始产物 JSON</h4><div class="pre">${esc(JSON.stringify(d, null, 2).slice(0, 3200))}</div></div>`;

  box.querySelector('#btn-copy-id')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(node.id).then(() => toast('节点 ID 已复制，可在 Agent 对话里用 @ 引用', 'ok')).catch(() => {});
  });
  box.querySelectorAll('.preview-click').forEach((el) => el.addEventListener('click', () => openAssetPreview(el.src, node.title)));
  box.querySelectorAll('[data-field]').forEach((el) => {
    el.addEventListener('change', () => handlers.onFieldChange(node.id, el.dataset.field, el.value));
  });
  box.querySelectorAll('[data-act]').forEach((el) => {
    el.addEventListener('click', () => handlers.onAction(el.dataset.act, node.id));
  });
}

/* ---------- 对话气泡 ---------- */
export function appendChat(role, content) {
  const log = $('chat-log');
  const el = document.createElement('div');
  el.className = `chat-msg ${role}`;
  el.textContent = content;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}
