/* ============================================================================
 * 新建「创作项目」向导 —— 极简版：只有「项目名称」必填
 * 其他一切（小说、分集、角色、风格画幅、交付物、创作设定）都后置到项目工作台，
 * 可逐步补充，也可用「✦ AI 生成」一键补全。
 * 零第三方依赖，原生 ESM。
 * ==========================================================================*/
const $ = (id) => document.getElementById(id);
const esc = (s = '') => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
  return data;
}

/**
 * @param opts { onCreated, toast }
 * 创建成功后由调用方打开项目工作台（路线图 + 项目信息）。
 */
export function openCreationWizard(opts = {}) {
  const toast = opts.toast || (() => {});
  const state = { name: '', idea: '', busy: false, error: '' };
  const root = $('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal wizard-modal wizard-mini" role="dialog" aria-label="新建创作项目">
    <div class="wz-head">
      <div><h2>＋ 新建创作项目</h2><div class="sub">起个名字就开始 · 小说、分集、角色、风格都进项目后再补，也可以交给 AI 生成</div></div>
      <button class="icon-btn" data-act="close" title="关闭">✕</button>
    </div>
    <div class="wz-body">
      <div class="field"><label>项目名称 <em class="req">必填</em></label>
        <input id="wz-name" value="" maxlength="80" placeholder="例如：雨夜来信 · 第一季" autocomplete="off"></div>
      <div class="field"><label>一句话故事构想 <em>选填 · 之后可让 AI 据此补全项目信息、生成小说</em></label>
        <textarea id="wz-idea" rows="2" maxlength="300" placeholder="例如：退役刑警收到一封来自十年前的信，揭开一桩被遗忘的旧案"></textarea></div>
      <div class="wz-next-hint">
        <div class="wz-next-title">创建后，在项目工作台里完成：</div>
        <div class="wz-next-steps">
          <span>① 准备故事 <i>上传 / AI 生成小说</i></span><span>→</span>
          <span>② 分集拆解</span><span>→</span>
          <span>③ 剧本创作</span><span>→</span>
          <span>④ 角色与上下文</span><span>→</span>
          <span>⑤ 分镜与画面</span><span>→</span>
          <span>⑥ 成片交付</span>
        </div>
      </div>
    </div>
    <div class="wz-foot">
      <div class="wz-foot-msg err" id="wz-msg"></div>
      <div class="wz-summary-inline" id="wz-summary">所有数据仅保存在本地 data/</div>
      <button class="btn primary" data-act="create" disabled>＋ 创建并进入项目</button>
    </div>
  </div>`;
  root.appendChild(backdrop);
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onCreate(); }
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-act="close"]').addEventListener('click', close);

  const nameInput = $('wz-name');
  const ideaInput = $('wz-idea');
  const createBtn = backdrop.querySelector('[data-act="create"]');
  const msg = $('wz-msg');
  const summary = $('wz-summary');

  function refresh() {
    const name = state.name.trim();
    createBtn.disabled = state.busy || !name;
    createBtn.textContent = state.busy ? '创建中…' : '＋ 创建并进入项目';
    msg.textContent = state.error;
    if (!state.error) {
      summary.textContent = name
        ? `「${name.length > 22 ? `${name.slice(0, 22)}…` : name}」· 交付物默认 成片视频 + 导演包，进项目后可改`
        : '所有数据仅保存在本地 data/';
    }
  }

  nameInput.addEventListener('input', (e) => { state.name = e.target.value; state.error = ''; refresh(); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onCreate(); } });
  ideaInput.addEventListener('input', (e) => { state.idea = e.target.value; });

  async function onCreate() {
    if (state.busy) return;
    const name = state.name.trim();
    if (!name) { state.error = '项目名称不能为空'; refresh(); nameInput.focus(); return; }
    state.busy = true; state.error = ''; refresh();
    try {
      const project = await api('/api/projects', {
        kind: 'novel', name, idea: state.idea.trim(),
      });
      close();
      toast(`创作项目「${project.name}」已创建 · 从准备故事开始`, 'ok');
      opts.onCreated?.(project);
    } catch (e) {
      state.busy = false; state.error = e.message; refresh();
      toast(e.message, 'err');
    }
  }
  createBtn.addEventListener('click', onCreate);

  refresh();
  setTimeout(() => nameInput.focus(), 40);
  return { close };
}
