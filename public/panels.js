// 检查器、对话、设置、弹窗、右键菜单、Toast 等 UI 组件
import { NODE_TYPES, typeOf, STATUS_LABEL, previewHTML } from './nodes.js';
import { showPage } from './page.js';
import { $, esc, fmt } from './utils.js';
import { SCOPE_LABELS, scopeList, interfacesForScope, invalidateInterfaces } from './interface-picker.js';


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
  // 设置弹窗走宽屏左右分栏布局，用显式 class 标记（不依赖 :has()，兼容旧内核）
  const wide = body.includes('settings-shell');
  backdrop.innerHTML = `<div class="modal${wide ? ' modal-settings' : ''}">
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
  // 媒体生成接口档案概览：GET /config 的 summary 与 /interfaces 同构，避免重复请求
  let ifaceData = { interfaces: [], scopeBindings: {}, scopes: [] };
  /** 出图工作流库里已展开「⚙ 参数 / ✎ JSON」的条目：`kind:id`。
   *  提前声明：renderLib 会在闭包里更早执行，晚声明的 const 会撞 TDZ */
  const openLibIds = new Set();
  const isLibOpen = (kind, id) => openLibIds.has(`${kind}:${id}`);
  // 接口 schema 缓存（JSON 本体 + 输入清单）：接口档案卡与出图工作流库共用
  const schemaCache = new Map();
  const applySummary = (summary) => {
    if (!summary) return;
    ifaceData = {
      interfaces: Array.isArray(summary.interfaces) ? summary.interfaces : [],
      scopeBindings: summary.scopeBindings || {},
      scopes: Array.isArray(summary.scopes) ? summary.scopes : [],
    };
  };
  try {
    const r = await fetch('/api/comfyui/config');
    const d = await r.json();
    cfg = d.config || {};
    applySummary(d.summary);
  } catch { /* 后端不可达时仍允许编辑模型设置 */ }
  try {
    const r = await fetch('/api/system/llm-models');
    roster = await r.json();
  } catch { /* 后端不可达时显示空库 */ }

  const num = (v, d) => `<input id="cf-${v}" type="number" value="${esc(cfg[v] ?? d)}">`;
  const body = `
    <div class="settings-shell">
      <nav class="settings-nav" aria-label="设置分类">
        <button class="settings-nav-item active" type="button" data-nav="general">⚙ 通用设置</button>
        <button class="settings-nav-item" type="button" data-nav="workspace">🗂 工作空间</button>
        <button class="settings-nav-item" type="button" data-nav="agent">💬 Agent 设置</button>
        <button class="settings-nav-item" type="button" data-nav="image">🖼 图片服务</button>
        <button class="settings-nav-item" type="button" data-nav="audio">🎧 音频服务</button>
        <button class="settings-nav-item" type="button" data-nav="video">🎬 视频服务</button>
        <div class="settings-nav-note">图片 / 音频 / 视频服务里列出的，都是导入的本地 ComfyUI「导出(API)」工作流 JSON；可逐份改中文备注、按节点查看参数。</div>
      </nav>
      <div class="settings-main">
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

      <div class="cf-section" id="model-comfy-entry">
        <h4>🔌 ComfyUI 接口与输入参数 <span class="cf-tag">应用级共享</span></h4>
        <div class="cf-note">导入的每份 ComfyUI「导出(API)」JSON 都是一个生图接口：可以直接修改接口 JSON、可视化设置这份接口需要输入的参数，并决定封面 / 角色 / 分镜 / 视频 / 音色等生成服务各自使用哪个接口。生图 Agent 会按所选接口的参数表自动配置参数。</div>
        <div class="cf-row" style="margin-top:9px">
          <button class="btn primary sm" id="model-goto-iface" type="button">编辑接口 JSON / 输入参数 →</button>
          <button class="btn sm" id="model-goto-bindings" type="button">查看服务 → 接口绑定</button>
        </div>
        <div id="model-iface-summary" class="mi-summary"></div>
      </div>
      <div class="cf-section">
        <div class="cf-row">
          <label class="cf-check"><input type="checkbox" id="cf-enabled" ${cfg.enabled !== false ? 'checked' : ''}> 启用本地 ComfyUI 生成</label>
          <label class="cf-check"><input type="checkbox" id="cf-strict" ${cfg.strict ? 'checked' : ''}> 严格模式（失败不回退 Mock）</label>
        </div>
        <div class="field"><label>ComfyUI 地址</label><input id="cf-base" value="${esc(cfg.baseUrl || 'http://127.0.0.1:8188')}" placeholder="http://127.0.0.1:8188"></div>
        <div class="cf-note">需以 <code>--listen 127.0.0.1 --port 8188</code> 启动 ComfyUI。未配置对应工作流时，该环节自动使用 Mock 自绘，流水线不会中断。</div>
      </div>

      <div class="cf-section" id="iface-section">
        <h4>🔌 媒体生成接口档案 <span class="cf-tag">一份 API 工作流 + 一套请求参数</span></h4>
        <div class="cf-note">每个接口档案就是一份 ComfyUI「导出(API)」工作流：点「✎ 接口 JSON」可直接修改导入的文件，点「⚙ 输入参数」会<b>自动列出这份 JSON 里所有需要填写的输入</b>，逐项选择由内置变量 / 固定值 / 生图 Agent / 保持原值来提供。档案还可单独设置负向词、宽高、步数、CFG、帧率帧数、模型名、自定义占位符与节点级覆盖；<b>参数留空表示沿用全局值</b>。下方「板块绑定」决定封面 / 定妆 / 关键帧 / 视频 / 音色各自用哪个接口；生成入口旁的下拉还能临时覆盖本次选择。</div>
        <div class="cf-row" style="margin-top:9px">
          <button class="btn" id="iface-import" type="button">⇧ 导入接口 JSON</button>
          <button class="btn" id="iface-refresh" type="button">↻ 刷新档案</button>
          <button class="btn primary" id="iface-save-bindings" type="button">保存板块绑定</button>
        </div>
        <div class="iface-lib" id="iface-lib"></div>
        <div id="iface-bindings"></div>
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
        <h4>音色工作流库（抽卡 TTS / 语音克隆）<span class="wf-badge none" id="cf-audio-badge">可选</span></h4>
        <div class="cf-note">导入一份 TTS 工作流（导出(API) 格式），角色页的「🎲 抽卡音色」就会用它真实跑 N 次，产出可试听的音频候选。
          程序会沿连线找说话人字段（voice / speaker / voice_id）与朗读文案字段并注入；没找到说话人字段时靠种子采样差异。
          <b>未配置也能用</b>：音色库里的预设音色照常可分配与试听，只是没有真实音频样本。</div>
        <div class="cf-row" style="margin-top:9px">
          <button class="btn" id="cf-import-audio" type="button">⇧ 导入 JSON</button>
          <button class="btn" id="cf-testall-audio" type="button">▶ 测试全部</button>
        </div>
        <div class="wf-lib" id="cf-lib-audio"></div>
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
      <div id="cf-result" class="cf-result" hidden></div>
      </div>
    </div>
`;

  const modal = showModal({
    title: '设置',
    sub: project
      ? '本项目运行参数单独保存；模型库与 ComfyUI 连接为应用级共享配置，所有数据只写入本地 data/ 目录。'
      : '图片与视频主路径为本地 ComfyUI（直接使用导出的 API 工作流），所有配置只写入本地 data/ 目录。',
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
  /* 左侧分类导航：body 是一份静态模板，cf-section 的先后顺序固定，按序归类即可。
   * 只切显隐不重渲染，避免丢掉尚未保存的输入；右侧内容区独立滚动。 */
  const SECTION_PANES = [
    'agent',       // 全局模型库
    'workspace',   // 运行参数（项目级）
    'workspace',   // 图像接口（项目级）
    'agent',       // 接口与输入参数摘要
    'general',     // 本地 ComfyUI 连接
    'image',       // 媒体生成接口档案 + 板块绑定
    'image',       // 出图工作流库
    'video',       // 视频工作流库
    'audio',       // 音色工作流库
    'general',     // 提示词注入自检
    'general',     // 生成参数
    'general',     // 最终产物
  ];
  const sections = [...root.querySelectorAll('.settings-main > .cf-section')];
  sections.forEach((sec, i) => { sec.dataset.pane = SECTION_PANES[i] || 'general'; });
  const switchPane = (pane) => {
    root.querySelectorAll('.settings-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.nav === pane));
    sections.forEach((sec) => { sec.hidden = sec.dataset.pane !== pane; });
    const main = root.querySelector('.settings-main');
    if (main) main.scrollTop = 0;
  };
  root.querySelectorAll('.settings-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchPane(btn.dataset.nav));
  });
  switchPane('general');

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
      injectBox.innerHTML = injectLine('出图', d.image) + injectLine('视频', d.video) + injectAudioLine(d.audio);
      const configured = [d.image, d.video, d.audio].filter(Boolean);
      const bad = configured.some((p) => !p.ok);
      injectBadge.className = `wf-badge ${!configured.length ? 'none' : bad ? 'err' : 'ok'}`;
      injectBadge.textContent = !configured.length ? '未配置' : bad ? '✕ 有风险' : '✓ 正常';
      const audioBadge = root.querySelector('#cf-audio-badge');
      if (audioBadge) {
        audioBadge.className = `wf-badge ${d.audio ? (d.audio.ok ? 'ok' : 'err') : 'none'}`;
        audioBadge.textContent = d.audio ? (d.audio.ok ? '✓ 抽卡就绪' : '✕ 有风险') : '可选';
        audioBadge.title = d.audio ? (d.audio.warnings || []).join('；') : '未导入音频工作流：抽卡不可用，预设音色仍可分配';
      }
    } catch (err) {
      injectBox.innerHTML = `<b class="err">✕ 自检失败</b> ${esc(err.message)}`;
      injectBadge.className = 'wf-badge err';
      injectBadge.textContent = '✕ 失败';
    }
  };
  /* 音频自检用另一套语义：TTS 工作流没有「正向提示词」，看的是朗读文案与说话人写到哪 */
  const injectAudioLine = (p) => {
    if (!p) {
      return `<div style="margin-bottom:7px"><b>音色抽卡</b> · 未导入音频工作流，抽卡不可用（预设音色仍可分配与试听）</div>`;
    }
    const warns = p.warnings?.length ? `<br><span class="cf-note">⚠ ${esc(p.warnings.join('；'))}</span>` : '';
    const t = p.text ? `<code>${esc(p.text.node)}.${esc(p.text.input)}</code> · ${esc(p.text.strategy)}` : '未找到朗读文案注入点';
    const v = p.voice ? ` · 说话人 → <code>${esc(p.voice.node)}.${esc(p.voice.input)}</code>` : ' · 无说话人字段（靠种子采样差异）';
    const out = p.audioNodes?.length ? ` · 音频输出 ${p.audioNodes.length} 个` : ' · <b class="err">无音频输出节点</b>';
    return `<div style="margin-bottom:7px"><b class="${p.ok ? 'ok' : 'err'}">${p.ok ? '✓' : '✕'} 音色抽卡</b> · ${esc(p.name || '')}（${p.nodes || 0} 节点）
      <br>朗读文案 → ${t}${v}${out}${warns}</div>`;
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
    // 参数数来自接口概览（不在 cfg 原始库项里重复计算），没有就只显示「⚙ 参数」
    const ov = (ifaceData.interfaces || []).find((x) => x.id === e.id);
    const inputs = ov && ov.inputCount ? ov.inputCount : null;
    const paramBtn = `<button class="btn sm" type="button" data-act="lib-inputs" title="自动解析这份工作流中需要填写的参数（连线槽位自动隐藏）并可视化配置">⚙ 参数${inputs ? `（${inputs}）` : ''}</button>`;
    const open = openLibIds.has(`${kind}:${e.id}`);
    return `<div class="wf-item ${active ? 'active' : ''} ${open ? 'lib-open' : ''}" data-id="${esc(e.id)}">
      <input type="radio" name="wf-pick-${kind}" ${active ? 'checked' : ''} data-act="pick" title="选中即当前生效">
      <span class="wf-name" data-act="expand" title="点击查看 / 复制 JSON · 双击也能改中文备注">${esc(e.name)}</span>
      <button class="btn xs" type="button" data-act="rename-note" title="修改这份工作流的中文备注">✎ 备注</button>
      <span class="wf-nodes">${Object.keys(e.workflow || {}).length} 节点</span>
      ${badge}
      ${paramBtn}
      <button class="btn sm" type="button" data-act="lib-json" title="直接修改这份导入的接口 JSON">✎ JSON</button>
      ${testBtn}
      <button class="wf-del" type="button" data-act="del" title="删除">✕</button>
      <textarea class="cf-code wf-json" rows="7" readonly hidden>${esc(JSON.stringify(e.workflow, null, 2))}</textarea>
      <div class="iface-block lib-block" data-block="lib-inputs" ${open ? '' : 'hidden'}></div>
    </div>`;
  };

  const renderLib = (kind) => {
    const box = root.querySelector(`#cf-lib-${kind}`);
    if (!box) return;
    const lib = cfg[libKey(kind)] || [];
    box.innerHTML = lib.length
      ? lib.map((e) => libItemHTML(kind, e)).join('')
      : `<div class="wf-empty">暂无工作流 · 点「⇧ 导入 JSON」选择本地 ComfyUI「导出(API)」文件（可多选）</div>`;
    // 重绘后恢复已展开的参数表 / JSON 编辑器（列表重绘不能把用户正在看的参数表收起来）
    for (const item of box.querySelectorAll('.wf-item')) {
      const e = lib.find((x) => x.id === item.dataset.id);
      if (!e || !isLibOpen(kind, e.id)) continue;
      const blk = item.querySelector('[data-block="lib-inputs"]');
      if (!blk) continue;
      blk.hidden = false;
      const data = schemaCache.get(e.id);
      if (!data) continue;
      if (blk.dataset.mode === 'json') paintJsonEditor(blk, e); else paintInputTable(blk, e);
      prefixLibActions(blk);
    }
  };

  const applyConfig = (d) => {
    if (d?.config) { cfg = d.config; renderLib('image'); renderLib('video'); renderLib('audio'); }
    // 接口档案与板块绑定同源：库项增删改 / 试跑写回 lastTest 后同步刷新本卡片与页面上下拉
    applySummary(d?.summary);
    renderInterfaces();
    renderBindings();
    renderModelIfaceSummary();
    invalidateInterfaces().catch(() => {});
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
    box.addEventListener('click', async (ev) => {
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
      if (act === 'rename-note') { startRename(kind, item, entry); return; }
      if (act === 'lib-inputs' || act === 'lib-json') { libBlock(kind, item, entry, act === 'lib-json' ? 'json' : 'inputs'); return; }
      if (act === 'lib-save-inputs') { libSave(kind, item, entry); return; }
      if (act === 'lib-reset-order') { libResetOrder(kind, item, entry); return; }
      if (act === 'lib-save-json') { libSaveJson(kind, item, entry); return; }
      if (act === 'lib-format-json') { libFormatJson(item); return; }
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
  /** 试跑产物统一渲染（单项 / 批量共用）：音频就地可听、图片点击页内放大、视频内嵌直接播放 */
  const testAssetsHTML = (assets) => {
    const list = Array.isArray(assets) ? assets : [];
    if (!list.length) return '';
    const audio = list.filter((a) => a.kind === 'audio').slice(0, 3)
      .map((a) => `<div class="wf-audio"><audio src="${esc(a.url)}" controls preload="metadata"></audio>
        <span class="cf-note">${esc(a.filename || '')}${a.bytes ? ` · ${Math.round(a.bytes / 1024)} KB` : ''}</span></div>`).join('');
    const images = list.filter((a) => a.kind === 'image').slice(0, 3)
      .map((a) => `<button class="wf-thumb" type="button" data-preview="${esc(a.url)}" data-title="${esc(a.filename || '试跑产物')}"
        title="点击放大查看"><img src="${esc(a.url)}" alt="试跑产物" loading="lazy"></button>`).join('');
    const videos = list.filter((a) => a.kind === 'video').slice(0, 3)
      .map((a) => `<div class="wf-video"><video src="${esc(a.url)}" controls preload="metadata"></video>
        <span class="cf-note">${esc(a.filename || '')}${a.bytes ? ` · ${(a.bytes / 1048576).toFixed(1)} MB` : ''} · 可直接播放</span></div>`).join('');
    const parts = [];
    if (audio) parts.push(`<div class="wf-audios">${audio}<span class="cf-note">可直接播放：这就是试跑会产出的东西</span></div>`);
    if (images) parts.push(`<div class="wf-thumbs">${images}<span class="cf-note">点击图片放大查看</span></div>`);
    if (videos) parts.push(`<div class="wf-videos">${videos}</div>`);
    return parts.join('');
  };
  /** 结果面板插入后统一绑定图片放大（openAssetPreview 走页内弹层，不跳新标签页） */
  const bindTestPreview = (box) => {
    box.querySelectorAll('[data-preview]').forEach((el) => {
      el.addEventListener('click', () => openAssetPreview(el.dataset.preview, el.dataset.title || '试跑产物'));
    });
  };
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
    const assets = testAssetsHTML(r.assets);
    return `${headLine}
      <div class="wf-one-meta">prompt_id <code>${esc(r.promptId || '—')}</code> · 产物 ${(Array.isArray(r.assets) ? r.assets : []).length} 个 · 注入 ${Number(r.applied) || 0} 处参数</div>
      <div class="wf-one-meta">提示词 → ${where}${neg}</div>${warns}
      ${assets || '<div class="cf-note">本次没有可预览的图片或视频产物。</div>'}
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
    const allBtns = ['image', 'video', 'audio']
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
        // 批量试跑也直接给出每项的产物预览：图片点击放大、视频内嵌播放，不用逐个点行找文件
        const perItem = results.filter((x) => x.ok).map((x) => {
          const assets = testAssetsHTML(x.assets);
          return `<div class="wf-batch-item"><b>「${esc(x.name)}」</b> · ${(Number(x.durationMs) / 1000).toFixed(1)}s${assets ? '' : ' · <span class="cf-note">无可预览产物</span>'}${assets}</div>`;
        }).join('');
        if (perItem) box.insertAdjacentHTML('beforeend', `<div class="wf-batch-assets">${perItem}</div>`);
      }
      bindTestPreview(box);
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
        // 导入后当场把参数可视化展出：自动展开第一个新增条目的参数表（多文件时只展开首个，
        // 其余提示逐个点开，避免一次拉取十几份完整参数清单）
        if (d.added.length) {
          const first = d.added[0];
          openLibIds.add(`${kind}:${first.id}`);
          renderLib(kind);
          const item = root.querySelector(`#cf-lib-${kind} .wf-item[data-id="${first.id}"]`);
          if (item) {
            try {
              await libBlock(kind, item, first, 'inputs', true);
              item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            } catch { /* 展开失败不影响导入结果 */ }
          }
          if (d.added.length > 1) toast(`已展开「${first.name}」的参数，其余 ${d.added.length - 1} 份点行内「⚙ 参数」查看`, '');
        }
        if (d.added.length) await testBatch(kind, d.added.map((x) => x.id));
      } catch (e) {
        box.innerHTML = `<b class="err">✕ 导入失败</b> ${esc(e.message)}`;
        toast(`导入失败：${e.message}`, 'err');
      }
    };
    input.click();
  };

  for (const kind of ['image', 'video', 'audio']) {
    setupLib(kind);
    renderLib(kind);
    root.querySelector(`#cf-import-${kind}`)?.addEventListener('click', () => importLib(kind));
    root.querySelector(`#cf-testall-${kind}`)?.addEventListener('click', () =>
      testBatch(kind, (cfg[libKey(kind)] || []).map((e) => e.id)));
  }

  /* ---------- 媒体生成接口档案：一套参数 / 节点覆盖 / 板块绑定 ---------- */
  const IFACE_PARAMS = [
    { key: 'negativePrompt', label: '负向提示词', type: 'text', wide: true },
    { key: 'model', label: '模型名 {{model}}', type: 'text' },
    { key: 'filenamePrefix', label: '产物文件名前缀', type: 'text' },
    { key: 'width', label: '宽 width', type: 'number' },
    { key: 'height', label: '高 height', type: 'number' },
    { key: 'steps', label: '步数 steps', type: 'number' },
    { key: 'cfg', label: 'CFG', type: 'number' },
    { key: 'fps', label: '帧率 fps', type: 'number' },
    { key: 'frames', label: '帧数 frames', type: 'number' },
    { key: 'timeoutMs', label: '超时 ms', type: 'number' },
    { key: 'pollIntervalMs', label: '轮询 ms', type: 'number' },
  ];
  const IFACE_KIND_LABEL = { image: '出图', video: '视频', audio: '音频' };
  const openIfaceIds = new Set();
  const openJsonIds = new Set();      // 展开「✎ 接口 JSON」编辑器
  const openInputIds = new Set();     // 展开「⚙ 输入参数」表格
  const SOURCE_LABELS = {
    auto: '自动识别（默认）', builtin: '内置变量', fixed: '固定值',
    agent: '由 Agent 生成', skip: '保持原值（不注入）',
  };
  let bindingsDirty = false;

  const ifaceById = (id) => (ifaceData.interfaces || []).find((e) => e.id === id) || null;

  /** 按需拉取某份接口的 JSON 本体 + 自动解析出的输入清单 */
  const loadSchema = async (id, force = false) => {
    if (!force && schemaCache.has(id)) return schemaCache.get(id);
    const d = await json(`/api/comfyui/interfaces/${encodeURIComponent(id)}/schema`, 'GET');
    const data = {
      workflow: d.workflow || {},
      inputs: Array.isArray(d.inputs) ? d.inputs : [],
      builtinVars: Array.isArray(d.builtinVars) ? d.builtinVars : [],
      inputSchema: Array.isArray(d.inputSchema) ? d.inputSchema : [],
      inputOrder: Array.isArray(d.inputOrder) ? d.inputOrder : [],
      // 中文备注：节点 id → 中文名、`node::input` → 中文名，独立于接口 JSON
      nodeNotes: d.nodeNotes && typeof d.nodeNotes === 'object' ? d.nodeNotes : {},
      inputNotes: d.inputNotes && typeof d.inputNotes === 'object' ? d.inputNotes : {},
    };
    schemaCache.set(id, data);
    return data;
  };

  const blockMsg = (item, kind, text, bad = false) => {
    const el = item.querySelector(`[data-block="${kind}"] [data-msg]`);
    if (el) { el.className = bad ? 'mi-msg err' : 'mi-msg ok'; el.textContent = text; }
  };

  /** 接口 JSON 编辑器：直接改导入的文件，保存 / 文件替换 / 格式化 */
  function paintJsonEditor(box, e) {
    const data = schemaCache.get(e.id);
    if (!box || !data) return;
    box.innerHTML = `
      <div class="mi-head"><b>✎ 接口 JSON 文件</b> · ${esc(e.name)} · ${Object.keys(data.workflow || {}).length} 节点
        <span class="cf-note">保存后写回该接口档案；若它是当前生效接口，镜像会同步更新。</span></div>
      <textarea class="cf-code mi-json" rows="12" spellcheck="false">${esc(JSON.stringify(data.workflow, null, 2))}</textarea>
      <div class="cf-row mi-actions">
        <button class="btn primary sm" type="button" data-act="save-json">💾 保存 JSON</button>
        <button class="btn sm" type="button" data-act="replace-json">⇧ 用文件替换</button>
        <button class="btn sm" type="button" data-act="format-json">⌗ 格式化</button>
        <span data-msg class="mi-msg"></span>
      </div>
      <div class="cf-note">任意字符串输入都可写 {{prompt}} {{negative_prompt}} {{seed}} {{width}} {{height}} 等占位符；改过节点 id / 输入名后，输入参数表会自动跳过失效的行。</div>`;
  }

  const sourceOptions = (i, current) => (i.type === 'link'
    ? ['auto', 'skip'] : ['auto', 'builtin', 'fixed', 'agent', 'skip'])
    .map((v) => `<option value="${v}" ${current === v ? 'selected' : ''}>${esc(SOURCE_LABELS[v])}</option>`).join('');

  /* ---------- 中文备注：节点 / 参数名独立于接口 JSON，全量表提交 ---------- */
  /** 备注标签：显示中文名 + ✎ 编辑入口；data-note-value 存「真实备注」，清空后回落到原始名 */
  const noteLabelHTML = (kind, key, value = '', fallback = '') => `<span class="wf-note"
      data-note-kind="${esc(kind)}" data-note-key="${esc(key)}"
      data-note-value="${esc(value)}" data-fallback="${esc(fallback)}">
      <span class="wf-note-text">${esc(value || fallback)}</span>
      <button class="wf-note-edit" type="button" title="修改中文备注">✎</button>
    </span>`;

  /** 保存备注：前端维护全量表，删键 = 清空。
   *  刻意不调 applyConfig —— 那会重绘工作流库，把用户尚未保存的参数编辑冲掉。 */
  const saveNotes = async (box, patch) => {
    const eid = box.dataset.eid;
    const data = schemaCache.get(eid);
    if (!eid || !data) return null;
    const nodeNotes = { ...(data.nodeNotes || {}) };
    const inputNotes = { ...(data.inputNotes || {}) };
    for (const [k, v] of Object.entries(patch.nodeNotes || {})) {
      if (v) nodeNotes[k] = v; else delete nodeNotes[k];
    }
    for (const [k, v] of Object.entries(patch.inputNotes || {})) {
      if (v) inputNotes[k] = v; else delete inputNotes[k];
    }
    const d = await json(`/api/comfyui/interfaces/${encodeURIComponent(eid)}`, 'PUT', { nodeNotes, inputNotes });
    schemaCache.set(eid, { ...data, nodeNotes, inputNotes });
    cfg = d.config || cfg;
    return { nodeNotes, inputNotes };
  };

  /** 备注改动后只更新文本，不重绘参数表 */
  const syncNotesUI = (box, kind, key, value) => {
    box.querySelectorAll('.wf-note').forEach((el) => {
      if (el.dataset.noteKind !== kind || el.dataset.noteKey !== key) return;
      const t = el.querySelector('.wf-note-text');
      if (t) t.textContent = value || el.dataset.fallback || '';
      el.dataset.noteValue = value || '';
    });
    if (kind === 'input') {
      box.querySelectorAll('.mi-chip-btn').forEach((b) => {
        if (b.dataset.goto !== key) return;
        const t = b.querySelector('.mi-chip-btn-text');
        if (t) t.textContent = value || key.replace('::', '.');
      });
    }
  };

  /** 把备注标签原地变成输入框：Enter 保存 / Escape 取消 / 失焦保存 */
  const startNoteEdit = (box, label) => {
    if (label.querySelector('input')) return;
    const kind = label.dataset.noteKind;
    const key = label.dataset.noteKey;
    const before = label.dataset.noteValue || '';
    const original = label.innerHTML;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'wf-note-input';
    input.value = before;
    input.placeholder = '填中文备注，留空恢复默认';
    input.maxLength = 60;
    label.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (!commit || next === before) { label.innerHTML = original; return; }
      try {
        const patch = kind === 'node' ? { nodeNotes: { [key]: next } } : { inputNotes: { [key]: next } };
        await saveNotes(box, patch);
        label.innerHTML = original;
        syncNotesUI(box, kind, key, next);
        toast(next ? `中文备注已保存：${next}` : '中文备注已清空', 'ok');
      } catch (err) {
        label.innerHTML = original;
        toast(`备注保存失败：${err.message}`, 'err');
      }
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') finish(true);
      if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  };

  /* ---------- 参数表：只列需要人填的槽位，控件按类型匹配 ---------- */
  const MEDIA_LABEL = { image: '图片', video: '视频', audio: '音频' };
  const MEDIA_ACCEPT = { image: 'image/*', video: 'video/*', audio: 'audio/*' };
  const TYPE_LABELS = { text: '文本', number: '数字', boolean: '是否', array: '多值', other: '其他', link: '连线' };
  /** 常用参数的行内标签（后端 common 字段 → 中文） */
  const COMMON_LABELS = { media: '常用·素材', prompt: '常用·提示词', seed: '常用·种子', size: '常用·尺寸' };

  /** 参数表视图：默认「只看常用」（提示词 / 素材 / 尺寸 / 种子），可切「显示全部」。
   *  只影响行的显隐，不改保存语义 —— 没配置的行保存时本来就不落盘。 */
  let inputScope = 'common';
  try { if (localStorage.getItem('cc-inputs-scope') === 'all') inputScope = 'all'; } catch { /* 隐私模式等 */ }

  /** 多值参数的可视化值 → 素材列表（JSON 数组 / 逗号简写 / 单个文件名） */
  function mediaFiles(i, raw) {
    const text = String(raw ?? '').trim();
    if (!text) return [];
    if (!i.multiple) return [text];
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.map((x) => String(x)).filter(Boolean) : [String(parsed)];
    } catch {
      return text.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    }
  }
  const filesToValue = (i, files) => (i.multiple ? JSON.stringify(files) : (files[0] || ''));

  /** 媒体槽位的已选素材清单（可逐个移除，序号即对应工作流里的槽位顺序） */
  function mediaChipsHTML(i, files) {
    if (!files.length) {
      return `<div class="mi-chip-empty">未选${MEDIA_LABEL[i.media] || '素材'} · 点「⇧ 上传」或「📁 资源库」</div>`;
    }
    return files.map((f, n) => `<span class="mi-chip" title="${esc(f)}">
        <span class="mi-chip-n">${i.multiple ? n + 1 : '◉'}</span>
        <span class="mi-chip-name">${esc(f)}</span>
        <button class="mi-chip-x" type="button" data-act="media-drop" data-file="${esc(f)}" title="移除这个素材">✕</button>
      </span>`).join('');
  }
  /** 按参数类型给输入控件：文本 / 长文本 / 数字 / 是否 / 多值 / 媒体（上传 + 资源库） */
  function inputControlHTML(i, r, source) {
    const value = r.value ?? '';
    // 媒体槽位：上传或从资源库挑，选中的文件名同时是 ComfyUI 输入目录里的文件名。
    // 素材清单与两个入口始终可见（自动识别档下也能直接上传，上传后自动切到「固定值」生效）
    if (i.media) {
      // 没配过固定值时回落到工作流当前值，否则右边「当前值」有文件名、左边清单却空着，看起来像丢了
      const files = mediaFiles(i, value === '' ? (i.value ?? '') : value);
      const label = MEDIA_LABEL[i.media] || '素材';
      const pending = source === 'auto' || source === 'builtin';
      const headNote = pending
        ? `<span class="mi-media-note warn">当前来源不写素材 · 选好素材会自动切到「固定值」</span>`
        : `<span class="mi-media-note">${i.multiple ? '多值：按序号对应工作流槽位' : ''}</span>`;
      return `<div class="mi-media">
        <div class="mi-chips">${mediaChipsHTML(i, files)}</div>
        <div class="mi-media-btns">
          <button class="btn sm" type="button" data-act="media-upload" title="从本机上传${label}：同时写入本地资源库与 ComfyUI 输入目录">⇧ 上传</button>
          <button class="btn sm" type="button" data-act="media-pick" title="从资源库选择已有${label}">📁 资源库</button>
          ${headNote}
        </div>
        <input data-cell="value" data-show="fixed,agent" class="mi-val mi-val-raw" type="text"
          value="${esc(value)}" placeholder="${i.multiple ? 'JSON 数组或逗号分隔多个文件名' : `文件名（也可手写）`}"
          ${source === 'fixed' || source === 'agent' ? '' : 'hidden'} ${pending ? 'data-media-pending="1"' : ''}>
      </div>`;
    }
    if (i.type === 'boolean') {
      const cur = String(value).trim().toLowerCase();
      const on = cur === 'true' || cur === '1' ? 'true' : cur === 'false' || cur === '0' ? 'false' : '';
      return `<select data-cell="value" data-show="fixed,agent" class="mi-val"
        ${source === 'fixed' || source === 'agent' ? '' : 'hidden'}>
        <option value="">（保持工作流原值）</option>
        <option value="true" ${on === 'true' ? 'selected' : ''}>true · 启用</option>
        <option value="false" ${on === 'false' ? 'selected' : ''}>false · 关闭</option>
      </select>`;
    }
    if (i.type === 'number') {
      return `<input data-cell="value" data-show="fixed,agent" class="mi-val" type="number" step="any"
        value="${esc(value)}" placeholder="数字${source === 'agent' ? '（Agent 失败时的兜底值）' : ''}"
        ${source === 'fixed' || source === 'agent' ? '' : 'hidden'}>`;
    }
    // 多行：提示词 / 长文本 / 多值数组都写得更顺
    if (i.multiline || i.type === 'array') {
      const rows = i.type === 'array' ? 2 : 3;
      const ph = i.type === 'array' ? 'JSON 数组（如 ["a.png","b.png"]）或逗号分隔多项' : '可写占位符 {{prompt}}，也可直接写固定文本';
      return `<textarea data-cell="value" data-show="fixed,agent" class="mi-val mi-tall" rows="${rows}" spellcheck="false"
        placeholder="${esc(ph)}" ${source === 'fixed' || source === 'agent' ? '' : 'hidden'}>${esc(value)}</textarea>`;
    }
    return `<input data-cell="value" data-show="fixed,agent" class="mi-val" type="text" value="${esc(value)}"
      placeholder="${source === 'agent' ? '兜底值（Agent 失败时用）' : '固定值 / 占位符'}"
      ${source === 'fixed' || source === 'agent' ? '' : 'hidden'}>`;
  }

  /** 切来源时统一刷新控件可见性：按 data-show 声明的来源清单匹配；媒体行顺带更新提示语 */
  function syncCfgVisibility(row, source) {
    row.querySelectorAll('[data-show]').forEach((el) => {
      el.hidden = !el.dataset.show.split(',').includes(source);
    });
    const note = row.querySelector('.mi-media-note');
    if (note && row.dataset.media) {
      const active = source === 'fixed' || source === 'agent';
      const multi = row.dataset.multi === '1';
      note.className = active ? 'mi-media-note' : 'mi-media-note warn';
      note.textContent = active
        ? (multi ? '多值：按序号对应工作流槽位' : '')
        : '当前来源不写素材 · 选好素材会自动切到「固定值」';
    }
  }

  /** 输入参数表：从接口 JSON 自动解析出的每个「需要人填」的输入一行
   *  连线槽位（工作流内部连接驱动）不展示也不可配；媒体槽位给上传 / 资源库入口。
   *  box 由调用方给（接口档案卡 / 出图工作流库共用这套渲染，避免维护两份表格） */
  function paintInputTable(box, e) {
    const data = schemaCache.get(e.id);
    if (!box || !data) return;
    box.dataset.eid = e.id;
    const saved = new Map((data.inputSchema || []).map((r) => [`${r.node}::${r.input}`, r]));
    const varOptions = (sel) => (data.builtinVars || []).map((v) =>
      `<option value="${esc(v.key)}" ${sel === v.key ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
    // 只渲染需要输入的槽位：连线由工作流内部驱动
    const all = data.inputs || [];
    const slots = all.filter((i) => i.editable !== false && i.type !== 'link');
    const linkCount = all.length - slots.length;
    const slotMap = new Map(slots.map((i) => [`${i.node}::${i.input}`, i]));
    const nodeNotes = data.nodeNotes || {};
    const inputNotes = data.inputNotes || {};
    const rowHTML = (i, idx) => {
      const r = saved.get(`${i.node}::${i.input}`) || {};
      const source = r.source || 'auto';
      const typeLabel = i.media ? `${MEDIA_LABEL[i.media]}·素材`
        : i.type === 'array' ? `多值(${(i.value || []).length})`
          : i.multiline ? '长文本' : (TYPE_LABELS[i.type] || i.type);
      // 行详情：该节点全部输入 + 该槽位的完整上下文，方便「查看每个参数」
      const sibling = (Object.entries((data.workflow?.[i.node]?.inputs) || {})
        .map(([k, v]) => `${k}=${Array.isArray(v) ? (isLinkShape(v) ? `→节点${v[0]}` : `[${v.length}项]`) : JSON.stringify(v)}`)
        .join(' · '));
      return `<div class="mi-row" data-slot="${esc(`${i.node}::${i.input}`)}" data-media="${esc(i.media || '')}" data-multi="${i.multiple ? '1' : '0'}" draggable="true">
        <div class="mi-slot">
          <button class="mi-grip" type="button" title="拖动调整顺序">⠿</button>
          <b>${esc(i.node)}.${esc(i.input)}</b>
          ${noteLabelHTML('input', `${i.node}::${i.input}`, inputNotes[`${i.node}::${i.input}`] || '', '＋备注')}
          <span class="mi-type ${i.media ? 'media' : ''}">${esc(typeLabel)}</span>
          ${i.common ? `<span class="mi-common">${esc(COMMON_LABELS[i.common] || i.common)}</span>` : ''}
          <button class="mi-info" type="button" data-act="row-info" title="查看该参数的完整信息">ⓘ</button>
          <small>${esc(i.classType || '')}${i.nodeTitle ? ` · ${esc(i.nodeTitle)}` : ''}${i.role ? ` · ${esc(i.role)}` : ''}</small>
        </div>
        <div class="mi-cur" title="${esc(i.valueText)}">${esc(i.valueText)}</div>
        <select data-cell="source">${sourceOptions(i, source)}</select>
        <div class="mi-cfg">
          <select data-cell="varName" data-show="builtin" class="mi-var" ${source === 'builtin' ? '' : 'hidden'}>${varOptions(r.varName || i.suggestedVar || '')}</select>
          ${inputControlHTML(i, r, source)}
          <input data-cell="hint" data-show="agent" class="mi-hint" value="${esc(r.hint || '')}"
            placeholder="给 Agent 的要求，如：按画面情绪挑 LoRA 强度" ${source === 'agent' ? '' : 'hidden'}>
        </div>
        <div class="mi-order">
          <button class="btn xs" type="button" data-act="move-up" ${idx === 0 ? 'disabled' : ''} title="上移">↑</button>
          <button class="btn xs" type="button" data-act="move-down" ${idx === slots.length - 1 ? 'disabled' : ''} title="下移">↓</button>
        </div>
        <div class="mi-detail" hidden>
          <div><b>${esc(i.node)}.${esc(i.input)}</b> · 类型 ${esc(i.type)}${i.media ? ` · 媒体槽位（${esc(MEDIA_LABEL[i.media])}）` : ''} · 节点 ${esc(i.classType || '?')}${i.nodeTitle ? `（${esc(i.nodeTitle)}）` : ''}</div>
          <div>原始值：<code>${esc(JSON.stringify(i.value))}</code></div>
          ${i.role ? `<div>推断角色：<code>${esc(i.role)}</code>${i.suggestedVar ? ` · 建议变量 <code>{{${esc(i.suggestedVar)}}}</code>` : ''}</div>` : ''}
          ${i.media ? `<div>媒体槽位：<b>⇧ 上传</b> 会把文件同时写进本地资源库与 ComfyUI 输入目录，再把这个文件名写进该槽位；<b>📁 资源库</b> 直接复用已有素材。</div>` : ''}
          ${i.type === 'array' ? `<div>多值参数：固定值请写 JSON 数组（如 <code>["a.png","b.png"]</code>），也可用逗号分隔简写；${i.multiple ? '素材按顺序对应工作流里的多个槽位。' : ''}</div>` : ''}
          ${i.type === 'boolean' ? '<div>布尔参数：下拉选 true / false（保存时按真布尔写回，不会是字符串）。</div>' : ''}
          ${i.multiline ? '<div>长文本参数：已用多行输入框，可写占位符也可写固定文本。</div>' : ''}
          <div>该节点全部输入：<code>${esc(sibling || '（无）')}</code></div>
        </div>
      </div>`;
    };

    // 按节点分组：导入的每份工作流拆成节点卡片（中文名可改），卡片内仍是原来的类型化参数行。
    // 组顺序沿用参数行顺序（inputOrder），组内可拖拽 / 上下移；跨组顺序由工作流节点决定。
    const groups = new Map();
    slots.forEach((i) => {
      if (!groups.has(i.node)) groups.set(i.node, []);
      groups.get(i.node).push(i);
    });
    const thHTML = '<div class="mi-row mi-th"><div>节点 · 输入</div><div>当前值</div><div>取值来源</div><div>配置</div><div>顺序</div></div>';
    const groupsHTML = [...groups.entries()].map(([nodeId, items]) => {
      const first = items[0];
      const fallback = first.nodeTitle || first.classType || `节点 ${nodeId}`;
      const configured = items.filter((i) => {
        const r = saved.get(`${i.node}::${i.input}`);
        return r && r.source && r.source !== 'auto';
      }).length;
      const hasKey = configured > 0 || items.some((i) => i.common);
      return `<section class="mi-node${hasKey ? ' open' : ''}" data-node="${esc(nodeId)}">
        <div class="mi-node-head">
          <button class="mi-node-toggle" type="button" data-act="node-toggle" title="展开 / 收起该节点的参数">›</button>
          ${noteLabelHTML('node', nodeId, nodeNotes[nodeId] || '', fallback)}
          <span class="mi-node-cls">${esc(first.classType || '')}</span>
          <span class="mi-node-id">#${esc(nodeId)}</span>
          <span class="mi-node-count" title="已配置 / 该节点可编辑输入数">${configured}/${items.length}</span>
        </div>
        <div class="mi-node-body">${thHTML}${items.map((i, n) => rowHTML(i, n)).join('')}</div>
      </section>`;
    }).join('');
    const chipItems = slots.filter((i) => {
      const r = saved.get(`${i.node}::${i.input}`);
      return i.common || (r && r.source && r.source !== 'auto');
    });
    const chipsHTML = chipItems.map((i) => {
      const key = `${i.node}::${i.input}`;
      return `<button class="mi-chip-btn" type="button" data-goto="${esc(key)}" title="定位到 ${esc(key)}"><span class="mi-chip-btn-text">${esc(inputNotes[key] || key.replace('::', '.'))}</span></button>`;
    }).join('');
    box.innerHTML = `
      <div class="mi-head"><b>⚙ 按节点分类的参数</b> · <span data-scope-count></span>
        <span class="mi-scope">
          <button class="btn xs${inputScope === 'common' ? ' primary' : ''}" type="button" data-scope="common" title="只显示提示词、素材、尺寸、种子等常改的参数">只看常用</button>
          <button class="btn xs${inputScope === 'all' ? ' primary' : ''}" type="button" data-scope="all" title="显示全部可编辑参数（含 seed / steps / cfg 等）">显示全部</button>
        </span>
        <span class="cf-note">导入的 JSON 按节点分组；节点名与参数名都能改中文备注（✎），点 chip 可跳到对应参数。⠿ / ↑↓ 在节点内排序。</span>
        ${linkCount ? `<span class="cf-tag" title="连线由工作流内部节点连接驱动，不需要填写，因此不在下表出现">已隐藏 ${linkCount} 个连线槽位</span>` : ''}</div>
      ${chipItems.length ? `<div class="mi-chips-line"><b>已选</b>${chipsHTML}<span class="cf-note">共 ${chipItems.length} 项常用 / 已配置参数</span></div>` : ''}
      <div class="mi-nodes">${groupsHTML || '<div class="cf-note">这份接口没有需要填写的参数（全部是连线槽位）。</div>'}</div>
      <div class="cf-row mi-actions">
        <button class="btn primary sm" type="button" data-act="save-inputs">保存输入参数与顺序</button>
        <button class="btn sm" type="button" data-act="reset-order" title="恢复到工作流原始扫描顺序">↺ 恢复默认顺序</button>
        <span data-msg class="mi-msg"></span>
      </div>`;
    box.querySelectorAll('.mi-row[data-slot] [data-cell="source"]').forEach((sel) => {
      sel.addEventListener('change', () => {
        syncCfgVisibility(sel.closest('.mi-row'), sel.value);
        applyScope();   // 配置来源变了 → 常用计数、节点「已配置/总数」同步刷新
      });
    });
    // 只看常用 / 显示全部：只切行的显隐，不重渲染（重渲染会丢未保存的编辑）。
    // 不用 data-act：库内联块会被 prefixLibActions 改名成 lib-*，直接绑定不受影响。
    // 「已配置过来源（≠自动识别）」的行即使不常用也不收起 —— 按当前 DOM 判断，运行中的编辑同样生效。
    const scopeBtns = box.querySelectorAll('[data-scope="common"], [data-scope="all"]');
    const applyScope = () => {
      try { localStorage.setItem('cc-inputs-scope', inputScope); } catch { /* 忽略 */ }
      let commonTotal = 0;
      box.querySelectorAll('.mi-row[data-slot]').forEach((row) => {
        const i = slotMap.get(row.dataset.slot);
        if (!i) return;
        const sel = row.querySelector('[data-cell="source"]');
        const isCommonRow = !!i.common || (sel && sel.value !== 'auto');
        if (isCommonRow) commonTotal++;
        row.hidden = inputScope !== 'all' && !isCommonRow;
      });
      // 常用视图下，整组都没有可见行的节点卡片一并收起；计数按当前 DOM 重算
      box.querySelectorAll('.mi-node').forEach((g) => {
        const rows = [...g.querySelectorAll('.mi-row[data-slot]')];
        g.hidden = rows.every((r) => r.hidden);
        const configured = rows.filter((r) => r.querySelector('[data-cell="source"]')?.value !== 'auto').length;
        const c = g.querySelector('.mi-node-count');
        if (c) c.textContent = `${configured}/${rows.length}`;
      });
      const cnt = box.querySelector('[data-scope-count]');
      if (cnt) cnt.textContent = `${slots.length} 项 · 常用 ${commonTotal} 项 · ${groups.size} 个节点`;
      scopeBtns.forEach((b) => { b.classList.toggle('primary', b.dataset.scope === inputScope); });
    };
    applyScope();
    scopeBtns.forEach((btn) => btn.addEventListener('click', () => {
      inputScope = btn.dataset.scope === 'all' ? 'all' : 'common';
      applyScope();
    }));
    // 中文备注 / 节点折叠 / 已选 chip 定位：委托到 box，重绘 innerHTML 不会丢绑定。
    // 这些按钮都不用 data-act —— 库内联块会被 prefixLibActions 改名成 lib-*。
    if (!box.dataset.notesBound) {
      box.dataset.notesBound = '1';
      box.addEventListener('click', (ev) => {
        const edit = ev.target.closest('.wf-note-edit');
        if (edit && box.contains(edit)) {
          ev.preventDefault();
          ev.stopPropagation();
          const label = edit.closest('.wf-note');
          if (label) startNoteEdit(box, label);
          return;
        }
        const toggle = ev.target.closest('.mi-node-toggle');
        if (toggle && box.contains(toggle)) {
          const g = toggle.closest('.mi-node');
          if (!g) return;
          g.classList.toggle('open');
          toggle.textContent = g.classList.contains('open') ? '⌄' : '›';
          return;
        }
        const chip = ev.target.closest('.mi-chip-btn');
        if (chip && box.contains(chip)) {
          const row = [...box.querySelectorAll('.mi-row[data-slot]')]
            .find((r) => r.dataset.slot === chip.dataset.goto);
          if (!row) return;
          const g = row.closest('.mi-node');
          if (g) {
            g.classList.add('open');
            const t = g.querySelector('.mi-node-toggle');
            if (t) t.textContent = '⌄';
          }
          row.hidden = false;
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
          row.classList.add('mi-flash');
          setTimeout(() => row.classList.remove('mi-flash'), 1400);
        }
      });
    }
    bindOrderUI(box);
    bindMediaUI(box);
  }

  /* ---------- 媒体槽位：上传（双写）与资源库复用 ---------- */
  const readAsDataURL = (file) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('读取本地文件失败'));
    fr.readAsDataURL(file);
  });

  /** 把素材写回该行：更新值输入框（collectInputRows 读它）、重绘清单。
   *  switchSource=true 时（上传 / 从资源库选入）把来源切到「固定值」，
   *  否则参数表会写着「自动识别」却悄悄把文件名带进保存 —— 反过来，手动移除素材不能改来源，
   *  否则会得到一个「固定值 = 空」的配置，把工作流原本的素材清掉。 */
  function applyMedia(row, i, files, switchSource = true) {
    const raw = row.querySelector('[data-cell="value"]');
    if (raw) raw.value = filesToValue(i, files);
    const chips = row.querySelector('.mi-chips');
    if (chips) chips.innerHTML = mediaChipsHTML(i, files);
    const sel = row.querySelector('[data-cell="source"]');
    if (switchSource && sel && (sel.value === 'auto' || sel.value === 'builtin')) sel.value = 'fixed';
    if (sel) syncCfgVisibility(row, sel.value);
  }

  /** 上传 / 复用：统一交给后端「本地资源库 + ComfyUI 双写」，拿回 ComfyUI 侧文件名 */
  async function pushMedia(box, row, i, payload) {
    const btns = row.querySelectorAll('[data-act="media-upload"], [data-act="media-pick"]');
    btns.forEach((b) => { b.disabled = true; });
    try {
      const d = await json(`/api/comfyui/interfaces/${encodeURIComponent(box.dataset.eid)}/media`, 'POST', {
        ...payload, media: i.media, node: i.node, input: i.input,
      });
      const cur = mediaFiles(i, row.querySelector('[data-cell="value"]')?.value || '');
      applyMedia(row, i, i.multiple ? [...cur.filter((f) => f !== d.comfyName), d.comfyName] : [d.comfyName]);
      if (d.warning) toast(d.warning, '');
      else toast(`${MEDIA_LABEL[i.media]}已就绪：${d.comfyName}`, 'ok');
    } catch (err) {
      toast(`${MEDIA_LABEL[i.media] || '素材'}设置失败：${err.message}`, 'err');
    } finally {
      btns.forEach((b) => { b.disabled = false; });
    }
  }

  function bindMediaUI(box) {
    if (box.dataset.mediaBound === '1') return;   // 同一容器只绑一次，重绘时 DOM 一起换掉
    box.dataset.mediaBound = '1';
    box.addEventListener('click', async (ev) => {
      const actEl = ev.target.closest('[data-act]');
      if (!actEl || !box.contains(actEl)) return;
      const act = actEl.dataset.act;
      if (!['media-upload', 'media-pick', 'media-drop'].includes(act)) return;
      const row = actEl.closest('.mi-row');
      if (!row) return;
      const data = schemaCache.get(box.dataset.eid);
      const [node, input] = (row.dataset.slot || '').split('::');
      const i = (data?.inputs || []).find((s) => s.node === node && s.input === input);
      if (!i) return;
      if (act === 'media-drop') {
        // 移除只是把值改小：不把来源从「自动识别」拉成「固定值」，否则空固定值会清掉工作流原素材
        const files = mediaFiles(i, row.querySelector('[data-cell="value"]')?.value || '')
          .filter((f) => f !== actEl.dataset.file);
        applyMedia(row, i, files, false);
        return;
      }
      if (act === 'media-upload') {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = MEDIA_ACCEPT[i.media] || '*/*';
        fileInput.onchange = async () => {
          const f = fileInput.files?.[0];
          if (!f) return;
          if (f.size > 32 * 1024 * 1024) { toast(`文件 ${(f.size / 1048576).toFixed(1)}MB，超过 32MB 上限`, 'err'); return; }
          try {
            const dataUrl = await readAsDataURL(f);
            await pushMedia(box, row, i, { dataUrl, name: f.name });
          } catch (err) { toast(err.message, 'err'); }
        };
        fileInput.click();
        return;
      }
      // 资源库选择：动态导入避免 panels ⇄ asset-manager 的循环依赖
      try {
        const mod = await import('./asset-manager.js');
        const accept = i.media === 'image' ? 'image' : i.media === 'video' ? 'video' : 'all';
        mod.openAssetLibrary({
          mode: 'pick', multi: !!i.multiple, accept,
          onPick: async (list) => {
            const items = (Array.isArray(list) ? list : [list]).filter(Boolean);
            const matched = items.filter((a) => (a.type || a.kind) === i.media);
            if (!matched.length) { toast(`所选资源里没有${MEDIA_LABEL[i.media]}文件`, 'err'); return; }
            for (const a of matched) await pushMedia(box, row, i, { asset: a.file });
          },
        });
      } catch (err) {
        toast(`打开资源库失败：${err.message}`, 'err');
      }
    });
  }

  /** 上下移 + 拖拽：两种方式都只改 DOM 顺序，保存时统一读当前可见顺序回写 */
  function bindOrderUI(box) {
    box.querySelectorAll('.mi-row[data-slot] [data-act="move-up"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.mi-row');
        const prev = row.previousElementSibling;
        if (prev && prev.dataset.slot) { row.parentNode.insertBefore(row, prev); syncOrderBtns(box); }
      });
    });
    box.querySelectorAll('.mi-row[data-slot] [data-act="move-down"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.mi-row');
        const next = row.nextElementSibling;
        if (next && next.dataset.slot) { row.parentNode.insertBefore(next, row); syncOrderBtns(box); }
      });
    });
    box.querySelectorAll('.mi-row[data-slot] [data-act="row-info"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const detail = btn.closest('.mi-row').querySelector('.mi-detail');
        if (detail) detail.hidden = !detail.hidden;
      });
    });
    let dragRow = null;
    box.querySelectorAll('.mi-row[data-slot]').forEach((row) => {
      row.addEventListener('dragstart', (ev) => {
        dragRow = row;
        row.classList.add('dragging');
        ev.dataTransfer?.setData('text/plain', row.dataset.slot || '');
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        box.querySelectorAll('.mi-row').forEach((r) => r.classList.remove('drop-target'));
        dragRow = null;
        syncOrderBtns(box);
      });
      row.addEventListener('dragover', (ev) => {
        if (!dragRow || dragRow === row) return;
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
        row.classList.add('drop-target');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
      row.addEventListener('drop', (ev) => {
        ev.preventDefault();
        row.classList.remove('drop-target');
        if (!dragRow || dragRow === row) return;
        // 节点分组视图：只允许组内排序，跨节点顺序由工作流本身决定
        if (dragRow.parentNode !== row.parentNode) {
          toast('参数只在所属节点内排序；跨节点顺序由工作流决定', '');
          return;
        }
        // 按指针落在目标行的上半 / 下半决定插到前面还是后面
        const rect = row.getBoundingClientRect();
        const after = ev.clientY > rect.top + rect.height / 2;
        row.parentNode.insertBefore(dragRow, after ? row.nextElementSibling : row);
        dragRow = null;
        syncOrderBtns(box);
      });
    });
  }

  /** 每个节点组内的首行禁用 ↑、末行禁用 ↓；拖动后重新算一遍 */
  function syncOrderBtns(box) {
    const containers = box.querySelectorAll('.mi-node-body, .mi-table');
    containers.forEach((c) => {
      const rows = [...c.children].filter((el) => el.classList.contains('mi-row') && el.dataset.slot);
      rows.forEach((row, i) => {
        const up = row.querySelector('[data-act="move-up"]');
        const down = row.querySelector('[data-act="move-down"]');
        if (up) up.disabled = i === 0;
        if (down) down.disabled = i === rows.length - 1;
      });
    });
  }

  /** 连线形态：[节点id, 输出序号]，第二项必须是数字 */
  const isLinkShape = (v) => Array.isArray(v) && v.length === 2
    && (typeof v[0] === 'string' || typeof v[0] === 'number') && typeof v[1] === 'number';

  /** 读取参数表当前可见顺序（用户排序后的真实顺序） */
  const collectInputOrder = (box) => [...box.querySelectorAll('.mi-row[data-slot]')]
    .map((row) => row.dataset.slot).filter(Boolean);

  /** 只有非默认来源的行才落盘，省得把整份工作流锁死 */
  const collectInputRows = (box) => [...box.querySelectorAll('.mi-row[data-slot]')].map((row) => {
    const [node, input] = row.dataset.slot.split('::');
    const source = row.querySelector('[data-cell="source"]')?.value || 'auto';
    if (source === 'auto') return null;
    const value = row.querySelector('[data-cell="value"]')?.value ?? '';
    // 媒体槽位选了「固定值」却一个素材都没有 → 视为没配（空字符串会清掉工作流里原本的素材）
    if (row.dataset.media && source === 'fixed' && !String(value).trim()) return null;
    return {
      node, input, source,
      varName: row.querySelector('[data-cell="varName"]')?.value || '',
      value,
      hint: row.querySelector('[data-cell="hint"]')?.value ?? '',
      label: `${node}.${input}`,
    };
  }).filter(Boolean);

  function paramSummary(e) {
    const p = e.params || {};
    const keys = Object.keys(p).filter((k) => k !== 'extra' && p[k] !== '' && p[k] !== undefined && p[k] !== null);
    const bits = keys.slice(0, 5).map((k) => `${k}=${String(p[k]).slice(0, 16)}`);
    if (p.extra && Object.keys(p.extra).length) bits.push(`extra:${Object.keys(p.extra).length}`);
    if (Array.isArray(e.inputSchema) && e.inputSchema.length) bits.push(`参数表:${e.inputSchema.length}`);
    if (!bits.length) return '沿用全局参数';
    return `${bits.join(' · ')}${keys.length > 5 ? ` …+${keys.length - 5}` : ''}`;
  }

  function rowHTML(kind, r = {}) {
    return `<div class="iface-row" data-row="${kind}">
      <input data-cell="node" placeholder="节点 id" value="${esc(r.node || '')}">
      <input data-cell="input" placeholder="输入名" value="${esc(r.input || '')}">
      <input data-cell="value" placeholder="${kind === 'override' ? '值 / {{model}}' : '{{prompt}} / {{negative_prompt}}'}" value="${esc(r.value ?? '')}">
      <button class="wf-del" type="button" data-act="del-row" title="删除这一行">✕</button>
    </div>`;
  }
  const rowsHTML = (kind, list) => `<div data-rows="${kind}">${(Array.isArray(list) ? list : []).map((r) => rowHTML(kind, r)).join('')}</div>`;

  function renderInterfaces() {
    const box = root.querySelector('#iface-lib');
    if (!box) return;
    const list = ifaceData.interfaces || [];
    if (!list.length) {
      box.innerHTML = `<div class="wf-empty">暂无接口档案 · 先在下方工作流库导入「导出(API)」JSON，即可在这里设置参数与板块绑定</div>`;
      return;
    }
    box.innerHTML = list.map((e) => {
      const open = openIfaceIds.has(e.id);
      const bound = (e.boundScopes || []).map((s) => SCOPE_LABELS[s] || s).join('、');
      return `<div class="iface-item ${open ? 'open' : ''}" data-id="${esc(e.id)}">
        <div class="iface-head">
          <div class="iface-meta">
            <button class="iface-toggle" type="button" data-act="toggle" title="展开 / 收起参数">${open ? '▾' : '▸'}</button>
            <b class="iface-name">${esc(e.name)}</b>
            <span class="wf-badge none">${esc(IFACE_KIND_LABEL[e.kind] || e.kind)}</span>
            ${e.active ? '<span class="wf-badge ok">默认</span>' : ''}
            ${e.capability ? `<span class="wf-badge">${esc(e.capability)}</span>` : ''}
            <span class="iface-summary">${e.nodes || 0} 节点 · ${esc(paramSummary(e))}</span>
            ${bound ? `<span class="wf-badge run" title="已绑定到这些板块">用于 ${esc(bound)}</span>` : ''}
          </div>
          <div class="iface-actions">
            <button class="btn sm" type="button" data-act="edit-json" title="直接查看 / 修改导入的接口 JSON 文件">✎ 接口 JSON</button>
            <button class="btn sm" type="button" data-act="inputs" title="从接口 JSON 自动列出输入并可视化配置">⚙ 输入参数</button>
            <button class="wf-test" type="button" data-act="test" title="按该档案的参数真实试跑一次">▶ 测试</button>
            <button class="btn sm" type="button" data-act="save">保存档案</button>
          </div>
        </div>
        <div class="iface-editor" ${open ? '' : 'hidden'}>
          <div class="field"><label>能力标签（文生图 / 图生图 / 多参考生图 …）</label>
            <input data-field="capability" value="${esc(e.capability || '')}" placeholder="文生图"></div>
          <div class="modal-grid">
            ${IFACE_PARAMS.map((f) => `<div class="field" ${f.wide ? 'style="grid-column:1/-1"' : ''}><label>${esc(f.label)}</label>
              <input type="${f.type}" data-param="${f.key}" value="${esc(e.params?.[f.key] ?? '')}" placeholder="留空 = 沿用全局"></div>`).join('')}
          </div>
          <div class="field"><label>自定义占位符 extra（JSON 对象，工作流里可写 {{key}}）</label>
            <textarea class="cf-code" rows="2" data-field="extra" placeholder='{"lora":"myLora.safetensors"}'>${esc(JSON.stringify(e.params?.extra || {}, null, 2))}</textarea></div>
          <div class="field"><label>节点覆盖 nodeOverrides（精确写模型 / LoRA / 采样器槽位，值可写 {{model}}）</label>
            ${rowsHTML('override', e.nodeOverrides)}
            <button class="btn sm" type="button" data-act="add-row" data-row="override">＋ 添加一行</button></div>
          <div class="field"><label>档案级注入点 bindings（指定 {{prompt}} 写到哪个节点，留空则用全局绑定）</label>
            ${rowsHTML('binding', e.bindings)}
            <button class="btn sm" type="button" data-act="add-row" data-row="binding">＋ 添加一行</button></div>
        </div>
        <div class="iface-block" data-block="json" ${openJsonIds.has(e.id) ? '' : 'hidden'}></div>
        <div class="iface-block" data-block="inputs" ${openInputIds.has(e.id) ? '' : 'hidden'}></div>
      </div>`;
    }).join('');
    // 重绘列表后按展开状态恢复两个编辑器（内容来自缓存，未保存的改动以用户最近一次输入为准）
    for (const item of box.querySelectorAll('.iface-item')) {
      const e = ifaceById(item.dataset.id);
      if (!e) continue;
      if (openJsonIds.has(e.id)) paintJsonEditor(item, e);
      if (openInputIds.has(e.id)) paintInputTable(item.querySelector('[data-block="inputs"]'), e);
    }
  }

  function renderBindings() {
    const box = root.querySelector('#iface-bindings');
    if (!box || (bindingsDirty && box.querySelector('select[data-scope]'))) return;
    const scopes = scopeList(ifaceData);
    box.innerHTML = `<h4 style="margin:14px 0 8px; font-size:12px">板块 → 接口绑定 <span class="cf-tag">留空 = 跟随该类别默认</span></h4>
      <div class="modal-grid">${scopes.map((s) => {
        const bound = ifaceData.scopeBindings?.[s.id] || '';
        const list = interfacesForScope(ifaceData, s.id);
        const active = list.find((e) => e.active);
        return `<div class="field"><label>${esc(s.label)} · ${esc(s.kindLabel)}</label>
          <select data-scope="${esc(s.id)}">
            <option value="">${active ? `跟随默认（${esc(active.name)}）` : '跟随默认接口'}</option>
            ${list.map((e) => `<option value="${esc(e.id)}" ${bound === e.id ? 'selected' : ''}>${esc(e.name)}${e.capability ? ` · ${esc(e.capability)}` : ''}</option>`).join('')}
          </select></div>`;
      }).join('')}</div>
      <div class="cf-note">绑定后，该板块的所有生成请求都会用这份接口与它自带的参数；生成入口旁的「本次接口」下拉可临时覆盖。改完点上方「保存板块绑定」。</div>`;
  }

  const collectRows = (item, kind) => [...item.querySelectorAll(`.iface-row[data-row="${kind}"]`)].map((row) => ({
    node: row.querySelector('[data-cell="node"]')?.value.trim() || '',
    input: row.querySelector('[data-cell="input"]')?.value.trim() || '',
    value: row.querySelector('[data-cell="value"]')?.value ?? '',
  })).filter((r) => r.node && r.input);

  async function saveInterface(item, e) {
    let payload;
    try {
      const params = {};
      item.querySelectorAll('[data-param]').forEach((inp) => {
        const v = String(inp.value ?? '').trim();
        params[inp.dataset.param] = v === '' ? '' : (inp.type === 'number' ? Number(v) : v);
      });
      const extraText = item.querySelector('[data-field="extra"]')?.value.trim() || '';
      if (extraText) {
        let extra;
        try { extra = JSON.parse(extraText); } catch { throw new Error('自定义占位符不是合法 JSON'); }
        if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('自定义占位符必须是 JSON 对象');
        params.extra = extra;
      } else params.extra = {};
      payload = {
        capability: item.querySelector('[data-field="capability"]')?.value.trim() || '',
        params,
        nodeOverrides: collectRows(item, 'override'),
        bindings: collectRows(item, 'binding'),
      };
    } catch (err) { toast(`参数填写有误：${err.message}`, 'err'); return; }
    try {
      const d = await json(`/api/comfyui/interfaces/${encodeURIComponent(e.id)}`, 'PUT', payload);
      applySummary(d.summary);
      cfg = d.config || cfg;
      renderInterfaces();
      renderBindings();
      await invalidateInterfaces();
      toast(`接口档案「${e.name}」已保存`, 'ok');
    } catch (err) { toast(`保存失败：${err.message}`, 'err'); }
  }

  /** 展开 / 收起某个档案的接口 JSON 编辑器或输入参数表（按需拉取，不重绘其它档案） */
  const toggleIfaceBlock = async (item, e, kind) => {
    const set = kind === 'json' ? openJsonIds : openInputIds;
    const box = item.querySelector(`[data-block="${kind}"]`);
    if (!box) return;
    if (set.has(e.id)) { set.delete(e.id); box.hidden = true; box.innerHTML = ''; return; }
    set.add(e.id);
    box.hidden = false;
    box.innerHTML = '<div class="cf-note">正在读取接口文件…</div>';
    try {
      await loadSchema(e.id);
      if (!set.has(e.id) || !document.contains(item)) return;
      if (kind === 'json') paintJsonEditor(box, e); else paintInputTable(box, e);
    } catch (err) {
      box.innerHTML = `<b class="err">✕ 读取接口文件失败</b> ${esc(err.message)}`;
    }
  };

  /** 保存接口 JSON 本体；box 为编辑器容器，block 为提示消息所在的块名 */
  const saveInterfaceJson = async (box, e, scopeItem, block = 'json') => {
    const ta = box.querySelector('.mi-json');
    if (!ta) return;
    let wf;
    try { wf = JSON.parse(ta.value); }
    catch (err) { blockMsg(scopeItem, block, `✕ JSON 语法错误：${err.message}`, true); return; }
    blockMsg(scopeItem, block, '正在保存…');
    try {
      const d = await json(`/api/comfyui/interfaces/${encodeURIComponent(e.id)}/workflow`, 'PUT', { workflow: wf });
      const prev = schemaCache.get(e.id) || {};
      schemaCache.set(e.id, { ...prev, workflow: d.workflow, inputs: d.inputs || [] });
      applyConfig(d);
      toast(`接口 JSON「${e.name}」已保存`, 'ok');
      if (Array.isArray(d.warnings) && d.warnings.length) toast(`注意：${d.warnings[0]}`, '');
    } catch (err) {
      blockMsg(scopeItem, block, `✕ ${err.message}`, true);
      toast(`接口 JSON 保存失败：${err.message}`, 'err');
    }
  };

  /**
   * 保存输入参数表：参数来源 + 显示顺序一起提交。
   * box 为参数表容器（接口档案卡与出图工作流库共用），scopeItem 只用于定位提示消息。
   */
  const saveInputSchema = async (box, e, scopeItem, block = 'inputs') => {
    const rows = collectInputRows(box);
    // 全量顺序：即使全是「自动识别」，顺序也要能保存下来
    const inputOrder = collectInputOrder(box);
    blockMsg(scopeItem, block, '正在保存…');
    try {
      const d = await json(`/api/comfyui/interfaces/${encodeURIComponent(e.id)}`, 'PUT', { inputSchema: rows, inputOrder });
      const prev = schemaCache.get(e.id) || {};
      schemaCache.set(e.id, { ...prev, inputSchema: rows, inputOrder });
      applyConfig(d);
      toast(`「${e.name}」输入参数与顺序已保存（${rows.length} 项自定义 / ${inputOrder.length} 项排序）`, 'ok');
    } catch (err) {
      blockMsg(scopeItem, block, `✕ ${err.message}`, true);
      toast(`输入参数保存失败：${err.message}`, 'err');
    }
  };

  /** 恢复默认顺序：清空顺序表后重新渲染（后端按扫描顺序返回） */
  const resetInputOrder = async (box, e, scopeItem, block = 'inputs') => {
    blockMsg(scopeItem, block, '正在恢复默认顺序…');
    try {
      const d = await json(`/api/comfyui/interfaces/${encodeURIComponent(e.id)}`, 'PUT', { inputOrder: [] });
      schemaCache.delete(e.id);
      await loadSchema(e.id, true);
      applyConfig(d);
      paintInputTable(box, e);
      toast(`「${e.name}」已恢复默认顺序`, 'ok');
    } catch (err) {
      blockMsg(scopeItem, block, `✕ ${err.message}`, true);
      toast(`恢复顺序失败：${err.message}`, 'err');
    }
  };

  /**
   * 库内联块的顶部动作改名成 lib- 前缀，避免与档案卡处理器混淆；
   * 行内的排序 / 详情按钮保持不变（它们已由 bindOrderUI 直接绑定，不走事件委托）。
   */
  function prefixLibActions(box) {
    // 行内按钮保持原名：排序 / 详情由 bindOrderUI 绑定，媒体按钮由 bindMediaUI 绑定，都不走事件委托
    const keep = new Set(['move-up', 'move-down', 'row-info', 'media-upload', 'media-pick', 'media-drop']);
    box.querySelectorAll('[data-act]').forEach((el) => {
      const act = el.dataset.act;
      if (keep.has(act) || act.startsWith('lib-')) return;
      el.dataset.act = `lib-${act}`;
    });
    const saveBtn = box.querySelector('[data-act="lib-save-inputs"]');
    if (saveBtn) saveBtn.textContent = '保存输入参数与顺序';
  };

  /** 出图工作流库里的「⚙ 参数 / ✎ JSON」：与接口档案卡共用同一套渲染与保存，
   *  只是容器换成该条目自己的 lib-inputs 块，展开状态记在 openLibIds 里以便重绘后恢复。
   *  force=true 用于导入后自动展开（不因已展开而收起）。 */
  async function libBlock(kind, item, entry, mode, force = false) {
    const box = item.querySelector('[data-block="lib-inputs"]');
    if (!box) return;
    const key = `${kind}:${entry.id}`;
    const closing = mode === 'json' && box.dataset.mode === 'json';
    if (!force && box.dataset.open === '1' && closing) {
      box.hidden = true; box.innerHTML = ''; box.dataset.open = ''; box.dataset.mode = '';
      openLibIds.delete(key);
      item.classList.remove('lib-open');
      return;
    }
    // 已经以同一模式展开时直接复用，避免重复请求与重复渲染
    if (force && box.dataset.open === '1' && box.dataset.mode === mode && schemaCache.has(entry.id)) {
      box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    box.hidden = false; box.dataset.open = '1'; box.dataset.mode = mode;
    openLibIds.add(key);
    item.classList.add('lib-open');
    box.innerHTML = '<div class="cf-note">正在读取接口文件…</div>';
    try {
      const data = await loadSchema(entry.id);
      if (!box.dataset.open) return;
      if (mode === 'json') paintJsonEditor(box, entry);
      else paintInputTable(box, entry);
      prefixLibActions(box);
      if (mode === 'inputs') {
        const saveBtn = box.querySelector('[data-act="lib-save-inputs"]');
        if (saveBtn) saveBtn.textContent = '保存输入参数与顺序';
      }
      void data;
    } catch (err) {
      box.innerHTML = `<b class="err">✕ 读取接口文件失败</b> ${esc(err.message)}`;
    }
  }

  const libSave = (kind, item, entry) => {
    const box = item.querySelector('[data-block="lib-inputs"]');
    if (box) saveInputSchema(box, entry, item, 'lib-inputs');
  };
  const libResetOrder = (kind, item, entry) => {
    const box = item.querySelector('[data-block="lib-inputs"]');
    if (box) resetInputOrder(box, entry, item, 'lib-inputs');
  };
  const libSaveJson = (kind, item, entry) => {
    const box = item.querySelector('[data-block="lib-inputs"]');
    if (box) saveInterfaceJson(box, entry, item, 'lib-inputs');
  };
  const libFormatJson = (item) => {
    const ta = item.querySelector('[data-block="lib-inputs"] .mi-json');
    if (!ta) return;
    try { ta.value = JSON.stringify(JSON.parse(ta.value), null, 2); blockMsg(item, 'lib-inputs', '已格式化'); }
    catch (err) { blockMsg(item, 'lib-inputs', `✕ JSON 语法错误：${err.message}`, true); }
  };

  root.querySelector('#iface-lib')?.addEventListener('click', async (ev) => {
    const item = ev.target.closest('.iface-item');
    if (!item) return;
    const e = ifaceById(item.dataset.id);
    if (!e) return;
    const actEl = ev.target.closest('[data-act]');
    const act = actEl && item.contains(actEl) ? actEl.dataset.act : undefined;
    if (act === 'toggle') {
      if (openIfaceIds.has(e.id)) openIfaceIds.delete(e.id); else openIfaceIds.add(e.id);
      renderInterfaces();
      return;
    }
    if (act === 'edit-json' || act === 'inputs') {
      await toggleIfaceBlock(item, e, act === 'edit-json' ? 'json' : 'inputs');
      return;
    }
    if (act === 'save-json') {
      const box = item.querySelector('[data-block="json"]');
      if (box) await saveInterfaceJson(box, e, item);
      return;
    }
    if (act === 'save-inputs') {
      const box = item.querySelector('[data-block="inputs"]');
      if (box) await saveInputSchema(box, e, item);
      return;
    }
    if (act === 'reset-order') {
      const box = item.querySelector('[data-block="inputs"]');
      if (box) await resetInputOrder(box, e, item);
      return;
    }
    if (act === 'replace-json') {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.json,application/json';
      input.onchange = async () => {
        const f = input.files?.[0];
        if (!f) return;
        const ta = item.querySelector('[data-block="json"] .mi-json');
        if (ta) ta.value = await f.text();
        blockMsg(item, 'json', `已载入「${f.name}」，点「💾 保存 JSON」写回`);
      };
      input.click();
      return;
    }
    if (act === 'format-json') {
      const ta = item.querySelector('[data-block="json"] .mi-json');
      if (!ta) return;
      try { ta.value = JSON.stringify(JSON.parse(ta.value), null, 2); blockMsg(item, 'json', '已格式化'); }
      catch (err) { blockMsg(item, 'json', `✕ JSON 语法错误：${err.message}`, true); }
      return;
    }
    if (act === 'del-row') { actEl.closest('.iface-row')?.remove(); return; }
    if (act === 'add-row') {
      item.querySelector(`[data-rows="${actEl.dataset.row}"]`)?.insertAdjacentHTML('beforeend', rowHTML(actEl.dataset.row));
      return;
    }
    if (act === 'test') { testOne(e.kind, { id: e.id, name: e.name }); return; }
    if (act === 'save') { saveInterface(item, e); }
  });

  root.querySelector('#iface-bindings')?.addEventListener('change', () => { bindingsDirty = true; });
  root.querySelector('#iface-save-bindings')?.addEventListener('click', async () => {
    const bindings = {};
    root.querySelectorAll('#iface-bindings select[data-scope]').forEach((sel) => { bindings[sel.dataset.scope] = sel.value; });
    try {
      const d = await json('/api/comfyui/bindings', 'PUT', { bindings });
      applySummary(d.summary);
      cfg = d.config || cfg;
      bindingsDirty = false;
      renderInterfaces();
      renderBindings();
      await invalidateInterfaces();
      toast('板块绑定已保存', 'ok');
    } catch (err) { toast(`保存绑定失败：${err.message}`, 'err'); }
  });
  root.querySelector('#iface-refresh')?.addEventListener('click', async () => {
    try {
      const data = await invalidateInterfaces();
      ifaceData = { interfaces: data.interfaces, scopeBindings: data.scopeBindings, scopes: data.scopes };
      renderInterfaces();
      renderBindings();
      renderModelIfaceSummary();
      toast('接口档案已刷新', 'ok');
    } catch { toast('刷新失败', 'err'); }
  });

  /** 「模型与运行」Tab 的只读摘要：11 个生图服务各自当前使用的接口 */
  function renderModelIfaceSummary() {
    const box = root.querySelector('#model-iface-summary');
    if (!box) return;
    box.innerHTML = `<div class="mi-services">${scopeList(ifaceData).map((s) => {
      const boundId = ifaceData.scopeBindings?.[s.id] || '';
      const bound = (ifaceData.interfaces || []).find((x) => x.id === boundId);
      const fallback = (ifaceData.interfaces || []).find((x) => x.active && x.kind === s.kind);
      const name = bound?.name || (fallback ? `默认 · ${fallback.name}` : '未配置');
      return `<div class="mi-service"><span>${esc(s.label)}</span><b title="${esc(name)}">${esc(name)}</b></div>`;
    }).join('')}</div>`;
  }

  /** 从「Agent 设置」直接跳到图片服务里的接口档案 / 板块绑定，省得用户找分类 */
  const gotoPane = (pane, selector) => {
    switchPane(pane);
    const el = root.querySelector(selector);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('mi-flash');
    setTimeout(() => el.classList.remove('mi-flash'), 1400);
  };
  root.querySelector('#model-goto-iface')?.addEventListener('click', () => gotoPane('image', '#iface-section'));
  root.querySelector('#model-goto-bindings')?.addEventListener('click', () => gotoPane('image', '#iface-bindings'));
  root.querySelector('#iface-import')?.addEventListener('click', () => importLib('image'));

  renderInterfaces();
  renderBindings();
  renderModelIfaceSummary();
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
      ['右上角「⇦ 退出项目」', '退出本项目，返回项目列表（两处出口之一）'],
      ['项目设置 → 退出项目', '退出本项目，返回项目列表（两处出口之一）'],
      ['N', '新建创作项目（在项目列表页也可使用）'],
      ['◐ / T', '切换外观主题'],
      ['?', '打开本项目操作指引'],
      ['左侧「项目资源」', `只显示「${project.name || '本项目'}」的资源，可筛选 / 预览 / 进资源库`],
      ['左侧「项目设置」', '项目信息 / 创作设定 / 角色 / 封面 / 运行参数 / 导出 / 退出项目'],
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
  showPage({ title, sub,
    body: `<div class="help-grid">${rows.map(([k, v]) => `<kbd>${esc(k)}</kbd><span>${esc(v)}</span>`).join('')}</div>`,
    actions: [{ label: '知道了', primary: true }] });
}

/* ---------- 资产预览 ---------- */
export function openAssetPreview(url, title = '资产预览') {
  const isVideo = /\.(mp4|webm|mov)(\?|$)/i.test(String(url));
  const media = isVideo
    ? `<video src="${esc(url)}" controls autoplay loop style="width:100%;border-radius:10px;border:1px solid var(--border)"></video>`
    : `<img src="${esc(url)}" style="width:100%;border-radius:10px;border:1px solid var(--border)">`;
  showPage({ title, sub: 'Mock 模式下的画面由本地自绘 SVG 生成；接入真实图像模型后会替换为模型输出。',
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
  if (d.script) {
    const sc = d.script;
    const dur = Number(sc.durationSec) || (sc.scenes || []).reduce((n, s) => n + (Number(s.durationSec) || 0), 0);
    extra.push(kv('剧本', `${sc.title || ''} · ${sc.genre || ''}`));
    extra.push(kv('场次 / 角色', `${sc.scenes?.length || 0} 场 · ${sc.characters?.length || 0} 位${dur ? ` · 预估 ${Math.round(dur)}s` : ''}`));
  }
  if (d.shotPlan) extra.push(kv('规划镜头', d.plannedShots || d.shotPlan.reduce((a, s) => a + (s.shots?.length || 0), 0)));
  if (d.shots) extra.push(kv('镜头数', d.shots.length));
  if (d.candidates) extra.push(kv('候选择优', `${(d.selected ?? 0) + 1} / ${d.candidates.length}`));
  if (d.context) extra.push(kv('检索片段', d.context.passages?.length || 0));
  if (d.cameras) extra.push(kv('机位 / 锚点', `${d.cameras.length} / ${d.anchorCount || 0}`));
  if (d.timeline) extra.push(kv('成片时长', `${d.duration}s`));
  if (d.clip) extra.push(kv('片段时长', `${d.duration}s`));

  let details = '';
  if (d.script?.scenes) details = `<div class="insp-card"><h4>统一格式剧本</h4><div class="pre">${esc(d.script.scenes.map((s, i) => {
    const head = [s.interior, s.location].filter(Boolean).join(' · ');
    const meta = [s.time, s.durationSec ? `${s.durationSec}s` : '', `EP${s.episodeNo || 1}`].filter(Boolean).join(' · ');
    const craft = [s.objective ? `目标：${s.objective}` : '', s.turn ? `转折：${s.turn}` : ''].filter(Boolean).join('｜');
    return `${i + 1}. ${head}（${meta}）${craft ? `\n   ${craft}` : ''}\n   ${s.summary || ''}\n   ${(s.script || []).slice(0, 4).join('\n   ')}`;
  }).join('\n\n'))}</div></div>`;
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

