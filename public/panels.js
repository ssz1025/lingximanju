// 检查器、对话、设置、弹窗、右键菜单、Toast 等 UI 组件
import { NODE_TYPES, typeOf, STATUS_LABEL, previewHTML } from './nodes.js';
import { $, esc, fmt } from './utils.js';


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
  // 从「项目列表 / 首次启动引导」进入时可能还没有打开任何项目
  const s = (project && project.settings) || {};
  let cfg = {};
  let roster = { models: [], activeModelId: '' };   // 全局模型库（所有 AI 入口共用）
  let editingId = null;   // 正在编辑的档案 id；null = 新增
  try {
    const r = await fetch('/api/comfyui/config');
    cfg = (await r.json()).config || {};
  } catch { /* 后端不可达时仍允许编辑模型设置 */ }
  try {
    const r = await fetch('/api/system/llm-models');
    roster = await r.json();
  } catch { /* 后端不可达时显示空库 */ }

  const num = (v, d) => `<input id="cf-${v}" type="number" value="${esc(cfg[v] ?? d)}">`;
  const body = `
    <div class="settings-tabs">
      <button class="settings-tab active" data-pane="model">模型与运行</button>
      <button class="settings-tab" data-pane="comfy">本地 ComfyUI / 最终产物</button>
    </div>

    <div class="settings-pane" id="pane-model">
      <div class="cf-section">
        <h4>🧠 全局模型库 <span class="cf-tag">一次配置 · 所有 AI 入口共用</span></h4>
        <div class="llm-model-list" id="model-lib"></div>
        <div class="cf-row"><button class="btn sm" id="model-add" type="button">＋ 新增模型</button></div>
        <div id="model-form" hidden>
          <div class="modal-grid">
            <div class="field"><label>档案名称</label><input id="mf-name" placeholder="例如：DeepSeek V3"></div>
            <div class="field"><label>模型模式</label><select id="mf-provider">
              <option value="openai">OpenAI 兼容接口</option>
              <option value="mock">Mock · 零 Key 演示</option></select></div>
            <div class="field"><label>模型名称</label><input id="mf-model" placeholder="gpt-4o-mini / deepseek-chat…"></div>
            <div class="field"><label>LLM 超时（秒）</label><input id="mf-timeout" type="number" min="30" max="1800" step="10" value="300"></div>
            <div class="field" style="grid-column:1/-1"><label>Base URL</label><input id="mf-base" placeholder="https://api.example.com/v1"></div>
            <div class="field" style="grid-column:1/-1"><label>API Key（仅存本地）</label><input id="mf-key" type="password" placeholder="sk-...（编辑时留空保持原值）"></div>
            <div class="field"><label>温度</label><input id="mf-temp" type="number" min="0" max="2" step="0.1" value="0.7"></div>
          </div>
          <div class="cf-row"><button class="btn primary sm" id="mf-save" type="button">保存档案</button>
            <button class="btn sm" id="mf-cancel" type="button">取消</button></div>
        </div>
        <div class="cf-note">点行首圆圈设为<b>默认模型</b>；每个对话框（封面 / 角色 / 剧本 / 画布…）旁都有模型下拉，可临时换用库中任一模型。「▶」用档案的完整配置真实调用一次，不落盘；推理模型响应可能需要 1-3 分钟。</div>
      </div>
      <div class="cf-section">
        <h4>⚙️ 运行参数 <span class="cf-tag">项目级</span></h4>
        <div class="modal-grid">
          <div class="field"><label>best-of-k 候选数</label><input id="set-k" type="number" min="1" max="4" value="${s.k || 2}"></div>
          <div class="field"><label>最大并发</label><input id="set-conc" type="number" min="1" max="8" value="${s.concurrency || 3}"></div>
        </div>
        <div class="cf-note">画面风格、画幅属于<b>项目设定</b>，请在项目工作台的「项目信息」中修改，随项目单独保存。</div>
      </div>

      <div class="cf-section">
        <h4>🖼 图像接口 <span class="cf-tag">可选 · 项目级</span></h4>
        <div class="field"><label>接口地址（留空使用本地生成）</label><input id="set-img" value="${esc(s.imageEndpoint || '')}" placeholder="https://.../images/generations"></div>
        <div class="cf-note">填写 OpenAI 兼容的 images/generations 地址后，出图会先走本地 ComfyUI，失败时改用该云端接口；留空则回退本地自绘。模型库只负责剧本 / 分镜 / 机位规划等文本生成。</div>
      </div>
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
        <div class="cf-note">每行「▶ 测试」只单独试跑该工作流（真实提交一次生成），结果显示产物、耗时与提示词注入位置，并把状态写回这一行；「▶ 测试全部」则按库顺序串行跑完。</div>
        <div class="wf-lib" id="cf-lib-image"></div>
      </div>

      <div class="cf-section">
        <h4>视频工作流库（图生视频 / 首尾帧 / 导演台）</h4>
        <div class="cf-note">选中项即当前生效的工作流，切换即时生效；无选中时该环节使用 Mock 自绘。每行「▶ 测试」单独真实试跑该工作流一次（视频生成通常较慢），不影响其它行；也可「▶ 测试全部」串行批量试跑。</div>
        <div class="cf-row" style="margin-top:9px">
          <button class="btn" id="cf-import-video" type="button">⇧ 导入 JSON</button>
          <button class="btn" id="cf-testall-video" type="button">▶ 测试全部</button>
        </div>
        <div class="wf-lib" id="cf-lib-video"></div>
      </div>

      <div class="cf-section">
        <h4>提示词注入自检 <span id="cf-inject-badge" class="wf-badge none">未检查</span></h4>
        <div class="cf-note">检查每个镜头 / 封面的提示词是否真的写进了工作流。若显示「未找到注入点」，所有镜头都会沿用工作流里写死的那句提示词，生成的图片会高度雷同。自检只做本地干跑，不调用 ComfyUI。</div>
        <div class="cf-row" style="margin-top:9px">
          <button class="btn" id="cf-inject-check" type="button">⌗ 检查提示词注入</button>
        </div>
        <div id="cf-inject-result" class="cf-note" style="margin-top:9px">尚未检查。</div>
      </div>

      <div class="cf-section">
        <h4>生成参数</h4>
        <div class="modal-grid">
          <div class="field"><label>帧率 fps</label>${num('fps', 24)}</div>
          <div class="field"><label>单镜头帧数</label>${num('frames', 124)}</div>
        </div>
        <div class="field"><label>全局负向提示词</label><input id="cf-negative" value="${esc(cfg.negativePrompt || '')}"></div>
        <div class="cf-note">图片规格（宽高 / 采样步数 / CFG）由智能体按项目设定的画幅自动决定：16:9 → 864×480，9:16 → 480×864，无需手动填写。</div>
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

    </div>

    <div id="cf-result" class="cf-result" hidden></div>`;

  const modal = showModal({
    title: project ? `「${project.name || '未命名项目'}」· 模型与运行设置` : '模型、ComfyUI 与最终产物设置',
    sub: project
      ? '本项目的运行参数随项目单独保存；模型库与 ComfyUI 连接是应用级共享配置。所有数据只写入本地 data/ 目录。'
      : '图片与视频主路径为本地 ComfyUI（直接使用导出的 API 工作流）。连接配置全局保存，项目设置单独保存；所有数据只写入本地 data/ 目录。',
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
            fps: Number(q('cf-fps').value) || 24,
            frames: Number(q('cf-frames').value) || 124,
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
          // 模型配置在模型库里增删改即时保存，这里只落项目创作开关
          onSave?.({
            ...(project?.settings || {}),
            k: Number(q('set-k').value) || 2, concurrency: Number(q('set-conc').value) || 3,
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

  /* ---------- 全局模型库：列表渲染 / 新增 / 编辑 / 设默认 / 删除 / 逐个测试 ---------- */
  const modelLib = root.querySelector('#model-lib');
  const modelForm = root.querySelector('#model-form');
  const json = async (url, method, body) => {
    const r = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  };
  const renderModelLib = () => {
    const models = roster.models || [];
    modelLib.innerHTML = models.length ? models.map((m) => `
      <div class="llm-model-row" data-id="${esc(m.id)}">
        <input type="radio" name="model-default" ${m.id === roster.activeModelId ? 'checked' : ''} data-act="pick" title="设为默认模型（对话框未选择时用它）">
        <div class="llm-model-info">
          <b>${esc(m.name || m.model)}${m.id === roster.activeModelId ? ' · 默认' : ''}</b>
          <small>${m.provider === 'openai' ? `${esc(m.model || '未填模型名')} · ${esc(m.baseUrl || '未填 Base URL')}` : 'Mock · 零 Key 演示'}${m.provider === 'openai' && !m.hasApiKey ? ' · 未配 Key' : ''}${m.provider === 'openai' && m.hasApiKey ? ` · Key ${esc(m.maskedKey || '已保存')}` : ''}</small>
        </div>
        <span class="llm-model-result muted"></span>
        <button class="btn sm" data-act="test" type="button" title="用该档案真实调用一次">▶</button>
        <button class="btn sm" data-act="edit" type="button" title="编辑">✎</button>
        <button class="btn sm" data-act="del" type="button" title="删除">✕</button>
      </div>`).join('')
      : '<div class="cf-note">模型库为空：点「＋ 新增模型」添加一个 OpenAI 兼容模型（或 Mock 演示）。添加前各 AI 入口将回退内置模板。</div>';
  };
  const openModelForm = (m = null) => {
    editingId = m?.id || null;
    root.querySelector('#mf-name').value = m?.name || '';
    root.querySelector('#mf-provider').value = m?.provider || 'openai';
    root.querySelector('#mf-model').value = m?.model || '';
    root.querySelector('#mf-base').value = m?.baseUrl || '';
    root.querySelector('#mf-key').value = '';
    root.querySelector('#mf-key').placeholder = m ? '•••••••• 留空保持原值' : 'sk-...';
    root.querySelector('#mf-timeout').value = Math.round((m?.llmTimeoutMs || 300000) / 1000);
    root.querySelector('#mf-temp').value = m?.temperature ?? 0.7;
    modelForm.hidden = false;
    root.querySelector('#mf-name').focus();
  };
  const closeModelForm = () => { modelForm.hidden = true; editingId = null; };

  root.querySelector('#model-add').addEventListener('click', () => openModelForm(null));
  root.querySelector('#mf-cancel').addEventListener('click', closeModelForm);
  root.querySelector('#mf-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const payload = {
      id: editingId || undefined,
      name: root.querySelector('#mf-name').value.trim(),
      provider: root.querySelector('#mf-provider').value,
      model: root.querySelector('#mf-model').value.trim(),
      baseUrl: root.querySelector('#mf-base').value.trim(),
      apiKey: root.querySelector('#mf-key').value.trim(),
      llmTimeoutMs: (Number(root.querySelector('#mf-timeout').value) || 300) * 1000,
      temperature: Number(root.querySelector('#mf-temp').value) || 0.7,
    };
    if (payload.provider === 'openai' && !payload.model && !payload.baseUrl) {
      toast('请至少填写模型名或 Base URL', 'err');
      return;
    }
    btn.disabled = true;
    try {
      const d = await json('/api/system/llm-models', 'POST', payload);
      roster = { models: d.models, activeModelId: d.activeModelId };
      renderModelLib();
      closeModelForm();
      toast(editingId ? '模型档案已更新' : '模型档案已添加', 'ok');
    } catch (err) {
      toast(`保存失败：${err.message}`, 'err');
    } finally { btn.disabled = false; }
  });

  modelLib.addEventListener('click', async (e) => {
    const row = e.target.closest('.llm-model-row');
    if (!row) return;
    const m = (roster.models || []).find((x) => x.id === row.dataset.id);
    if (!m) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'edit') { openModelForm(m); return; }
    if (act === 'del') {
      if (!confirm(`删除模型档案「${m.name || m.model}」？正在使用它的对话框将回退默认模型。`)) return;
      try {
        const d = await json('/api/system/llm-models', 'DELETE', { id: m.id });
        roster = { models: d.models, activeModelId: d.activeModelId };
        renderModelLib();
        toast('模型档案已删除', 'ok');
      } catch (err) { toast(`删除失败：${err.message}`, 'err'); }
      return;
    }
    if (act === 'pick') {
      try {
        const d = await json('/api/system/llm-models/activate', 'POST', { id: m.id });
        roster.activeModelId = d.activeModelId;
        renderModelLib();
        toast(`默认模型已切换为「${m.name || m.model}」`, 'ok');
      } catch (err) { toast(`切换失败：${err.message}`, 'err'); }
      return;
    }
    if (act === 'test') {
      const out = row.querySelector('.llm-model-result');
      const btn = e.target.closest('[data-act="test"]');
      btn.disabled = true;
      out.textContent = '测试中…（推理模型可能需要 1-3 分钟）';
      try {
        const d = await json('/api/system/llm-test', 'POST', { ref: { profileId: m.id } });
        out.innerHTML = d.ok
          ? `<b class="ok">✓ ${esc(d.mode === 'mock' ? 'Mock 模式' : '模型已响应')}</b> ${(d.latencyMs / 1000).toFixed(1)}s${d.preview ? ` · ${esc(String(d.preview).slice(0, 24))}` : ''}`
          : `<b class="err">✕ 失败</b> ${esc(d.error || '未知错误')}`;
      } catch (err) {
        out.innerHTML = `<b class="err">✕</b> ${esc(err.message)}`;
      } finally { btn.disabled = false; }
    }
  });
  renderModelLib();

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

  /* ---------- 提示词注入自检：纯本地干跑，打开设置即自动跑一次 ---------- */
  const injectBadge = root.querySelector('#cf-inject-badge');
  const injectBox = root.querySelector('#cf-inject-result');
  const injectLine = (label, p) => {
    if (!p) return `<div style="margin-bottom:7px"><b>${label}</b> · 未配置工作流，该环节回退 Mock 自绘</div>`;
    const warns = p.warnings?.length
      ? `<br><span class="cf-note">⚠ ${esc(p.warnings.join('；'))}</span>` : '';
    if (!p.ok || !p.positive) {
      return `<div style="margin-bottom:7px"><b class="err">✕ ${label}</b> · 未找到提示词注入点（${esc(p.name || '')}）${warns}</div>`;
    }
    const g = p.positive;
    const where = `<code>${esc(g.node)}.${esc(g.input)}</code>${g.title ? `「${esc(g.title)}」` : ''}`;
    const neg = p.negative ? ` · 负向 → <code>${esc(p.negative.node)}.${esc(p.negative.input)}</code>` : '';
    return `<div style="margin-bottom:7px"><b class="ok">✓ ${label}</b> · ${esc(p.name || '')}（${p.nodes || 0} 节点）
      <br>提示词 → ${where} · ${esc(g.strategy)}${neg}
      <br><span class="cf-note">示例文本：${esc(p.samplePrompt || '')}</span>${warns}</div>`;
  };
  const runInjectCheck = async () => {
    injectBox.textContent = '检查中…';
    try {
      const d = await postJSON('/api/comfyui/inject-check', {});
      injectBox.innerHTML = injectLine('出图', d.image) + injectLine('视频', d.video);
      const configured = [d.image, d.video].filter(Boolean);
      const bad = configured.some((p) => !p.ok);
      injectBadge.className = `wf-badge ${!configured.length ? 'none' : bad ? 'err' : 'ok'}`;
      injectBadge.textContent = !configured.length ? '未配置' : bad ? '✕ 有风险' : '✓ 正常';
    } catch (err) {
      injectBox.innerHTML = `<b class="err">✕ 自检失败</b> ${esc(err.message)}`;
      injectBadge.className = 'wf-badge err';
      injectBadge.textContent = '✕ 失败';
    }
  };
  root.querySelector('#cf-inject-check').addEventListener('click', runInjectCheck);
  runInjectCheck();

  const libItemHTML = (kind, e) => {
    const t = e.lastTest;
    const active = e.id === cfg[activeKey(kind)];
    const running = testing.has(e.id);
    const badge = running
      ? `<span class="wf-badge run"><span class="wf-spin"></span>试跑中</span>`
      : !t ? `<span class="wf-badge none" title="尚未真实试跑">未测</span>`
      : t.ok ? `<span class="wf-badge ok" title="上次试跑：${esc(new Date(t.at || Date.now()).toLocaleString())}">✓ ${(Number(t.durationMs) / 1000).toFixed(1)}s</span>`
      : `<span class="wf-badge err" title="${esc(t.error || '失败')}">✕ ${esc(String(t.error || '失败').slice(0, 18))}</span>`;
    const testBtn = running
      ? `<button class="wf-test run" type="button" disabled><span class="wf-spin"></span>试跑中</button>`
      : `<button class="wf-test" type="button" data-act="test-one" title="只测试这一个工作流：向本地 ComfyUI 真实提交一次生成">▶ 测试</button>`;
    return `<div class="wf-item ${active ? 'active' : ''}" data-id="${esc(e.id)}">
      <input type="radio" name="wf-pick-${kind}" ${active ? 'checked' : ''} data-act="pick" title="选中即当前生效">
      <span class="wf-name" data-act="expand" title="点击查看 / 复制 JSON · 双击重命名">${esc(e.name)}</span>
      <span class="wf-nodes">${Object.keys(e.workflow || {}).length} 节点</span>
      ${badge}
      ${testBtn}
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
      const actEl = ev.target.closest('[data-act]');
      const act = actEl && item.contains(actEl) ? actEl.dataset.act : undefined;
      if (act === 'expand') {
        const ta = item.querySelector('.wf-json');
        if (ta) ta.hidden = !ta.hidden;
        return;
      }
      if (act === 'del') { requestDelete(kind, entry); return; }
      if (act === 'test-one') { testOne(kind, entry); return; }
      if (act === 'pick' && actEl.matches('input[type="radio"]') && cfg[activeKey(kind)] !== entry.id) {
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

  /* ---------- 单独测试：把一次试跑的完整结果渲染成可读详情 ---------- */
  const oneResultHTML = (entry, d) => {
    const r = d?.result;
    if (!r) return `<b class="err">✕ 未拿到试跑结果</b>`;
    const head = r.ok
      ? `<b class="ok">✓「${esc(entry.name)}」测试通过</b>`
      : `<b class="err">✕「${esc(entry.name)}」测试失败</b>`;
    const headLine = `<div class="wf-one-head">${head} · ${(Number(r.durationMs) / 1000).toFixed(1)}s</div>`;
    if (!r.ok) {
      return `${headLine}<div class="wf-one-err">${esc(r.error || '未知错误')}</div>
        <div class="cf-note">排查后可再点该行的「▶ 测试」重试；本次失败状态已写入该行徽标。</div>`;
    }
    const plan = r.promptInjection || {};
    const p = plan.positive;
    const where = p
      ? `<code>${esc(p.node)}.${esc(p.input)}</code>${p.title ? `「${esc(p.title)}」` : ''} · ${esc(p.strategy || '')}`
      : '<b class="err">未找到提示词注入点</b>';
    const neg = plan.negative ? ` · 负向 → <code>${esc(plan.negative.node)}.${esc(plan.negative.input)}</code>` : '';
    const warns = Array.isArray(plan.warnings) && plan.warnings.length
      ? `<div class="cf-note">⚠ ${esc(plan.warnings.join('；'))}</div>` : '';
    const assets = Array.isArray(r.assets) ? r.assets : [];
    const thumbs = assets.filter((a) => a.kind === 'image' || a.kind === 'video').slice(0, 3)
      .map((a) => `<a class="wf-thumb" href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc(a.filename || '')}">${
        a.kind === 'image'
          ? `<img src="${esc(a.url)}" alt="试跑产物" loading="lazy">`
          : `<video src="${esc(a.url)}" muted preload="metadata"></video>`
      }</a>`).join('');
    return `${headLine}
      <div class="wf-one-meta">prompt_id <code>${esc(r.promptId || '—')}</code> · 产物 ${assets.length} 个 · 注入 ${Number(r.applied) || 0} 处参数</div>
      <div class="wf-one-meta">提示词 → ${where}${neg}</div>${warns}
      ${thumbs ? `<div class="wf-thumbs">${thumbs}<span class="cf-note">点击缩略图可打开原图 / 原视频</span></div>` : '<div class="cf-note">本次没有可预览的图片或视频产物。</div>'}
      <div class="cf-note">结果已写入该行的「上次试跑」徽标；点「▶ 测试」可随时重跑。</div>`;
  };

  /* ---------- 试跑（单项 / 批量共用；进度经 SSE log 事件回显） ---------- */
  let testES = null;
  let testBusy = false;   // ComfyUI 队列一次只跑一个任务，避免单项与批量互相抢队列、串日志
  const testBatch = async (kind, ids, opts = {}) => {
    if (!ids.length) { toast('库为空，先导入工作流', 'err'); return; }
    if (testBusy) { toast('已有试跑在进行中，请等待当前任务完成', ''); return; }
    testBusy = true;
    const one = opts.single || null;
    const allBtns = ['image', 'video']
      .map((k) => root.querySelector(`#cf-testall-${k}`)).filter(Boolean);
    allBtns.forEach((b) => { b.disabled = true; });
    ids.forEach((id) => testing.add(id));
    renderLib(kind);
    const box = root.querySelector('#cf-result');
    box.hidden = false;
    box.innerHTML = `<div class="wf-run"><span class="wf-spin"></span> ${one
      ? `单独试跑「${esc(one.name)}」· 只提交这一个工作流 · 进度实时回显`
      : `串行试跑 ${ids.length} 项 · 进度实时回显`}</div>`;
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
      const d = await postJSON(one ? '/api/comfyui/test-one' : '/api/comfyui/test-batch',
        one ? { kind, id: one.id } : { kind, ids });
      if (d.connectionError) throw new Error(d.connectionError);
      applyConfig(d);
      const results = Array.isArray(d.results) ? d.results : [];
      const ok = results.filter((x) => x.ok).length;
      const fail = results.length - ok;
      box.querySelector('.wf-run')?.remove();
      if (one) {
        box.insertAdjacentHTML('afterbegin', oneResultHTML(one, d));
        toast(fail ? `「${one.name}」测试失败` : `「${one.name}」测试通过`, fail ? 'err' : 'ok');
      } else {
        box.insertAdjacentHTML('afterbegin',
          `<b class="${fail ? 'err' : 'ok'}">${fail ? '试跑完成（存在失败项）' : '✓ 试跑全部成功'}</b> 成功 ${ok} · 失败 ${fail}`);
        toast(`试跑完成：成功 ${ok} · 失败 ${fail}`, fail ? '' : 'ok');
      }
      box.scrollTop = 0;
    } catch (e) {
      const conn = /无法连接/.test(e.message);
      box.querySelector('.wf-run')?.remove();
      box.insertAdjacentHTML('afterbegin',
        `<b class="err">✕ ${conn ? 'ComfyUI 连接失败' : (one ? '单独测试失败' : '试跑失败')}</b> ${esc(e.message)}${conn ? ' · 请先启动 ComfyUI（--listen 127.0.0.1 --port 8188）' : ''}`);
      box.scrollTop = 0;
      toast(`${one ? '单独测试' : '试跑'}失败：${e.message}`, 'err');
    } finally {
      testES?.close(); testES = null;
      ids.forEach((id) => testing.delete(id));
      renderLib(kind);
      allBtns.forEach((b) => { b.disabled = false; });
      testBusy = false;
    }
  };
  const testOne = (kind, entry) => testBatch(kind, [entry.id], { single: entry });

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
export function openHelp(project = null) {
  const canvasRows = [
    ['空格 + 拖拽 / 中键', '平移本项目画布'], ['滚轮', '以指针为中心缩放'], ['拖拽节点', '移动（支持多选整体移动）'],
    ['空白处拖拽', '框选多个节点'], ['从右侧端口拖出并松手', '弹窗选下一个节点：新建 / 连接已有'],
    ['拖到目标节点后松手', '弹窗选 flow / anchor / ref 连接关系'], ['Alt / Shift + 拖线到节点', '跳过弹窗，直接连 anchor / ref'],
    ['从本项目画布节点拖入', '弹窗选要连接的上游节点，Esc 跳过'], ['双击节点', '在检查器中编辑'],
    ['右键节点', '单节点重跑 / 复制 / 删除'],
    ['Ctrl/Cmd + Z', '撤销'], ['Ctrl/Cmd + Shift + Z', '重做'], ['Ctrl/Cmd + D', '复制选中节点'],
    ['Delete / Backspace', '删除选中节点'], ['Ctrl/Cmd + A', '全选'], ['F', '适应视图'],
    ['L', '自动布局'], ['R', '运行本项目流水线'], ['Esc', '从剧集详情返回 / 取消选择'],
    ['右侧「任务步骤」Tab', '本项目六步执行清单、四态视觉提示'],
  ];
  let rows;
  let title = '快捷键与交互';
  let sub = '无限画布完整保留；创作项目在「任务步骤」Tab 逐步执行，画布节点随每一步生长。';
  if (project) {
    const m = project.management || {};
    const steps = Array.isArray(m.steps) ? m.steps : [];
    const done = steps.filter((s) => s.status === 'done').length;
    const eps = Array.isArray(m.episodes) ? m.episodes.length : 0;
    const nodes = Array.isArray(project.nodes) ? project.nodes.length : 0;
    rows = [
      ['V', '本项目工作台 ⇄ 画布视图'],
      ['S', '执行本项目下一步任务'],
      ['P', '打开本项目管理面板（分集 / 产物 / 快照）'],
      ['H 或 ✕', '关闭本项目，返回项目列表'],
      ['N', '新建创作项目（在项目列表页也可使用）'],
      ['◐ / T', '切换外观主题'],
      ['?', '打开本项目操作指引'],
      ['左侧「项目资源」', `只显示「${project.name || '本项目'}」的资源，可筛选 / 预览 / 进资源库`],
      ['左侧「项目设置」', '项目信息 / 创作设定 / 角色 / 封面 / 运行参数 / 导出'],
      ...canvasRows,
    ];
    title = `「${project.name || '未命名项目'}」· 操作指引`;
    sub = `本项目：${done}/${steps.length || 6} 步 · ${eps} 集 · ${nodes} 节点；以下入口与快捷键都作用于当前项目。`;
  } else {
    rows = [
      ['N', '新建创作项目（上传小说 → 分集 → 视频 / 导演包）'],
      ['S', '执行创作项目的下一步任务'], ['P', '打开项目管理面板（分集 / 产物 / 快照）'],
      ...canvasRows,
    ];
  }
  showModal({ title, sub,
    body: `<div class="help-grid">${rows.map(([k, v]) => `<kbd>${esc(k)}</kbd><span>${esc(v)}</span>`).join('')}</div>`,
    actions: [{ label: '知道了', primary: true }] });
}

/* ---------- 资产预览 ---------- */
export function openAssetPreview(url, title = '资产预览') {
  const isVideo = /\.(mp4|webm|mov)(\?|$)/i.test(String(url));
  const media = isVideo
    ? `<video src="${esc(url)}" controls autoplay loop style="width:100%;border-radius:10px;border:1px solid var(--border)"></video>`
    : `<img src="${esc(url)}" style="width:100%;border-radius:10px;border:1px solid var(--border)">`;
  showModal({ title, sub: 'Mock 模式下的画面由本地自绘 SVG 生成；接入真实图像模型后会替换为模型输出。',
    body: media,
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
