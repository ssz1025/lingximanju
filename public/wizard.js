/* ============================================================================
 * 新建「创作项目」向导 —— 单屏极简版
 * 默认只要「项目名 + 交付物」就能创建；小说上传、分集策略、画幅风格全部
 * 后置：可折叠现在填，也可跳过，之后在六步任务的第 ① 步随时补传
 * （骨架项目 + POST /api/projects/:id/source 延迟注入）。
 * 零第三方依赖，原生 ESM。
 * ==========================================================================*/
const $ = (id) => document.getElementById(id);
const esc = (s = '') => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cut = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };

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

const STRATEGIES = [
  { id: 'chapter', icon: '▤', name: '按章节', hint: '识别「第X章 / Chapter N」，合并短章节' },
  { id: 'fixed', icon: '≡', name: '按字数', hint: '按固定字数均分，适合无章节标记' },
  { id: 'scene', icon: '▦', name: '按场景段落', hint: '以空行分段聚合，保留场景边界' },
];

/**
 * @param opts { steps, onCreated, onStart, onOpenPanel, toast }
 */
export function openCreationWizard(opts = {}) {
  const steps = opts.steps || [];
  const toast = opts.toast || (() => {});
  const state = {
    text: '', filename: '', name: '',
    showSource: false, showAdvanced: false,
    split: { strategy: 'chapter', targetChars: 1200, maxEpisodes: 4 },
    deliverables: { video: true, pack: true },
    style: 'cinematic', aspect: '16:9',
    busy: false, error: '',
  };
  const MIN_CHARS = 40;
  const hasText = () => state.text.trim().length >= MIN_CHARS;
  const root = $('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal wizard-modal" role="dialog" aria-label="新建创作项目">
    <div class="wz-head">
      <div><h2>＋ 新建创作项目</h2><div class="sub">起个名字就能创建 · 小说上传与分集设置可之后在第 ① 步补做 · 无限画布全程保留</div></div>
      <button class="icon-btn" data-act="close" title="关闭">✕</button>
    </div>
    <div class="wz-body" id="wz-body"></div>
    <div class="wz-foot" id="wz-foot"></div>
  </div>`;
  root.appendChild(backdrop);
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(); });

  function setError(msg) { state.error = msg; renderFoot(); }
  function summaryText() {
    const d = state.deliverables;
    const src = hasText() ? `${state.text.trim().length} 字 · 将直接完成 ①②` : '小说稍后在第 ① 步上传';
    return `${state.name.trim() || '自动命名'} · ${src} · ${d.video && d.pack ? '视频 + 导演包' : d.video ? '仅成片视频' : d.pack ? '仅导演包' : '未选择交付物'}`;
  }

  function renderFoot() {
    const foot = $('wz-foot');
    const noDel = !state.deliverables.video && !state.deliverables.pack;
    const shortText = state.text.trim().length > 0 && !hasText();
    let msg = state.error;
    if (!msg) {
      if (noDel) msg = '至少要选择一种交付物';
      else if (shortText) msg = `正文只有 ${state.text.trim().length} 字（需 ≥${MIN_CHARS}）· 将创建空项目，稍后在第 ① 步重新上传`;
      else msg = hasText() ? '创建后直接进入第 ③ 步 · 小说已在本次一并解析分集' : '创建后从第 ① 步上传小说开始 · 所有数据仅保存在本地 data/';
    }
    foot.innerHTML = `
      <div class="wz-foot-msg ${state.error || noDel ? 'err' : ''}">${esc(msg)}</div>
      <div class="wz-summary-inline">${esc(summaryText())}</div>
      <button class="btn primary" data-act="create" ${(noDel || state.busy) ? 'disabled' : ''}>${state.busy ? '创建中…' : '＋ 创建创作项目'}</button>`;
    foot.querySelector('[data-act="create"]').addEventListener('click', onCreate);
  }

  function renderBody() {
    const body = $('wz-body');
    body.innerHTML = `
      <div class="field"><label>项目名称（可留空）</label>
        <input id="wz-name" value="${esc(state.name)}" placeholder="例如：雨夜来信 · 第一季 · 留空自动命名"></div>

      <div class="wz-label">最终交付物（至少一项）</div>
      <div class="wz-cards two" id="wz-deliver">
        <button class="wz-card ${state.deliverables.video ? 'selected' : ''}" data-del="video"><span class="wz-card-icon">▶</span><strong>成片视频</strong><small>ComfyUI 真实片段 → ffmpeg 拼接 MP4；Mock 为帧序列预览</small></button>
        <button class="wz-card ${state.deliverables.pack ? 'selected' : ''}" data-del="pack"><span class="wz-card-icon">▤</span><strong>导演包</strong><small>*.mmxpack.zip · 可导入 ComfyUI MiniMax H3 Director</small></button>
      </div>

      <details class="wz-fold" id="wz-fold-source" ${state.showSource ? 'open' : ''}>
        <summary>⇧ 现在上传小说 <em>可跳过 · 之后在第 ① 步也能传</em></summary>
        <div class="wz-fold-body">
          <div class="wz-drop" id="wz-drop">
            <div class="wz-drop-icon">⇧</div>
            <strong>拖拽 .txt / .md 到这里，或点击选择文件</strong>
            <span>也支持直接粘贴正文 · 至少 ${MIN_CHARS} 字</span>
            <div class="wz-drop-actions">
              <button class="btn" data-act="file">选择文件</button>
              <button class="btn" data-act="sample">载入示例小说</button>
            </div>
          </div>
          <div class="field"><label>或粘贴小说正文</label><textarea id="wz-text" rows="5" placeholder="雨夜来信&#10;&#10;第一章 没有署名的信&#10;雨下了整夜……">${esc(state.text)}</textarea></div>
          <div class="wz-meta" id="wz-meta"></div>
        </div>
      </details>

      <details class="wz-fold" id="wz-fold-adv" ${state.showAdvanced ? 'open' : ''}>
        <summary>⚙ 高级选项 <em>分集策略 · 画幅 · 风格</em></summary>
        <div class="wz-fold-body">
          <div class="wz-label">分集策略（上传后生效）</div>
          <div class="wz-cards" id="wz-strategies">${STRATEGIES.map((s) => `
            <button class="wz-card ${state.split.strategy === s.id ? 'selected' : ''}" data-strategy="${s.id}">
              <span class="wz-card-icon">${s.icon}</span><strong>${s.name}</strong><small>${s.hint}</small>
            </button>`).join('')}</div>
          <div class="modal-grid" style="margin-top:10px">
            <div class="field"><label>每集目标字数（300–8000）</label><input id="wz-target" type="number" min="300" max="8000" step="100" value="${state.split.targetChars}"></div>
            <div class="field"><label>最多集数（1–12）</label><input id="wz-max" type="number" min="1" max="12" value="${state.split.maxEpisodes}"></div>
          </div>
          <div class="modal-grid" style="margin-top:10px">
            <div class="field"><label>画幅</label><select id="wz-aspect"><option value="16:9" ${state.aspect === '16:9' ? 'selected' : ''}>16:9 横屏</option><option value="9:16" ${state.aspect === '9:16' ? 'selected' : ''}>9:16 竖屏</option></select></div>
            <div class="field"><label>画面风格</label><select id="wz-style">${['cinematic', 'noir', 'anime', 'watercolor'].map((v) => `<option value="${v}" ${state.style === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
          </div>
        </div>
      </details>`;

    $('wz-name').addEventListener('input', (e) => { state.name = e.target.value; renderFoot(); });

    body.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.del;
      state.deliverables[k] = !state.deliverables[k];
      b.classList.toggle('selected', state.deliverables[k]);
      state.error = '';
      renderFoot();
    }));

    // 折叠区状态记下来，重绘时不丢
    $('wz-fold-source').addEventListener('toggle', (e) => { state.showSource = e.target.open; });
    $('wz-fold-adv').addEventListener('toggle', (e) => { state.showAdvanced = e.target.open; });

    // —— 可选的小说上传区 ——
    const drop = $('wz-drop');
    const readFile = (file) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        state.text = String(reader.result || ''); state.filename = file.name;
        if (!state.name) { state.name = file.name.replace(/\.(txt|md|markdown)$/i, ''); $('wz-name').value = state.name; }
        state.error = '';
        $('wz-text').value = state.text;
        renderMeta(); renderFoot(); toast(`已载入「${file.name}」`, 'ok');
      };
      reader.readAsText(file, 'utf-8');
    };
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); readFile(e.dataTransfer.files?.[0]); });
    $('wz-text').addEventListener('input', (e) => { state.text = e.target.value; state.error = ''; renderMeta(); renderFoot(); });
    body.querySelectorAll('[data-act="file"]').forEach((b) => b.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.txt,.md,.markdown,text/plain,text/markdown';
      input.onchange = () => readFile(input.files?.[0]);
      input.click();
    }));
    body.querySelectorAll('[data-act="sample"]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const d = await api('/api/novel/sample');
        state.text = d.text; state.filename = d.filename;
        if (!state.name) { state.name = '雨夜来信 · 示例'; $('wz-name').value = state.name; }
        state.error = '';
        $('wz-text').value = state.text;
        renderMeta(); renderFoot(); toast('示例小说已载入', 'ok');
      } catch (e) { setError(e.message); }
    }));
    renderMeta();

    // —— 高级选项 ——
    body.querySelectorAll('[data-strategy]').forEach((b) => b.addEventListener('click', () => {
      state.split.strategy = b.dataset.strategy;
      body.querySelectorAll('[data-strategy]').forEach((x) => x.classList.toggle('selected', x === b));
    }));
    $('wz-target').addEventListener('input', (e) => { state.split.targetChars = Number(e.target.value) || 1200; });
    $('wz-max').addEventListener('input', (e) => { state.split.maxEpisodes = Number(e.target.value) || 4; });
    $('wz-aspect').addEventListener('change', (e) => { state.aspect = e.target.value; });
    $('wz-style').addEventListener('change', (e) => { state.style = e.target.value; });

    renderFoot();
  }

  function renderMeta() {
    const el = $('wz-meta');
    if (!el) return;
    const chars = state.text.trim().length;
    const ok = chars >= MIN_CHARS;
    el.innerHTML = `<span class="wz-k ${ok ? 'ok' : chars > 0 ? 'warn' : ''}">${ok ? '✓' : chars > 0 ? '!' : '·'} ${chars} 字</span>
      ${state.filename ? `<span class="wz-k">${esc(cut(state.filename, 26))}</span>` : ''}
      <span class="wz-k">${ok ? '创建时一并解析分集' : '留空则创建后在第 ① 步上传'}</span>`;
  }

  async function onCreate() {
    if (state.busy) return;
    if (!state.deliverables.video && !state.deliverables.pack) return setError('至少要选择一种交付物');
    state.busy = true; state.error = ''; renderFoot();
    try {
      // 正文不足阈值时按空处理 → 创建骨架，第 ① 步重新上传（后端会再次校验）
      const text = hasText() ? state.text : '';
      const project = await api('/api/projects', {
        kind: 'novel', text, filename: text ? state.filename : '',
        name: state.name.trim(), split: state.split, deliverables: state.deliverables,
        style: state.style, aspect: state.aspect,
      });
      close();
      const skeleton = !project.management?.source?.text;
      toast(skeleton
        ? `创作项目「${project.name}」已创建 · 下一步上传小说`
        : `创作项目「${project.name}」已创建 · ${project.management?.episodes?.length || 0} 集`, 'ok');
      opts.onCreated?.(project);
      openStepsGuide({ project, steps, toast, onStart: opts.onStart, onOpenPanel: opts.onOpenPanel });
    } catch (e) {
      state.busy = false; setError(e.message); toast(e.message, 'err');
    }
  }

  backdrop.querySelector('[data-act="close"]').addEventListener('click', close);
  renderBody();
  return { close };
}

/** 创建后的「任务执行步骤」引导：骨架项目引导去第 ① 步上传小说 */
export function openStepsGuide({ project, steps = [], toast = () => {}, onStart, onOpenPanel } = {}) {
  const root = $('modal-root');
  const m = project.management || {};
  const skeleton = !m.source?.text;
  const done = (m.steps || []).filter((s) => s.status === 'done').length;
  const next = (m.steps || []).find((s) => s.status !== 'done') || null;
  const deliverTxt = m.deliverables?.video && m.deliverables?.pack ? '成片视频 + 导演包' : m.deliverables?.pack ? '仅导演包' : '仅成片视频';
  const sub = skeleton
    ? `尚未上传小说 · 六步任务全部待执行 · ${deliverTxt} · 无限画布已生成初始节点`
    : `${m.episodes?.length || 0} 集 · ${(m.source?.totalChars || 0).toLocaleString()} 字 · ${deliverTxt} · 无限画布已生成初始节点`;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal guide-modal" role="dialog" aria-label="任务执行步骤">
    <div class="guide-head"><span class="guide-badge ok">✓ 已创建</span><h2>${esc(project.name)}</h2>
      <div class="sub">${esc(sub)}</div></div>
    <div class="guide-progress"><div class="guide-progress-bar"><i style="width:${Math.round(done / Math.max(1, steps.length) * 100)}%"></i></div><span>${done}/${steps.length} 步已完成</span></div>
    <div class="guide-list">${steps.map((s, i) => {
      const st = (m.steps || []).find((x) => x.id === s.id)?.status || 'pending';
      const isNext = next && st !== 'done' && s.id === next.id;
      const stateTxt = st === 'done' ? (i < 2 ? '创建时已完成' : '已完成')
        : isNext ? (s.id === 'upload' ? '下一步 · 上传小说' : '下一步') : '待执行';
      return `<div class="guide-row ${st} ${isNext ? 'next' : ''}">
        <span class="guide-no">${st === 'done' ? '✓' : s.no}</span>
        <span class="guide-main"><strong>${esc(s.title)}</strong><small>${esc(s.short)} · ${esc(s.theory?.ref || '')}</small></span>
        <span class="guide-state">${esc(stateTxt)}</span></div>`;
    }).join('')}</div>
    <div class="guide-tip">状态图例：<span class="lg pending">灰 · 待执行</span><span class="lg running">橙 + 呼吸 · 进行中</span><span class="lg done">绿 ✓ · 已完成</span><span class="lg error">红 · 失败可重试</span>。右侧「任务步骤」Tab 可逐步执行，画布节点同步高亮。</div>
    <div class="modal-actions">
      <button class="btn" data-act="later">稍后再说</button>
      <button class="btn" data-act="panel">查看任务面板</button>
      <button class="btn primary" data-act="start">${skeleton ? '⇧ 上传小说' : `▶ 执行第 ${next?.no || 3} 步`}</button>
    </div>
  </div>`;
  const close = () => backdrop.remove();
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-act="later"]').addEventListener('click', close);
  backdrop.querySelector('[data-act="panel"]').addEventListener('click', () => { close(); onOpenPanel?.(next?.id); });
  backdrop.querySelector('[data-act="start"]').addEventListener('click', () => {
    close();
    if (skeleton) onOpenPanel?.(next?.id || 'upload');
    else onStart?.(next?.id);
  });
  root.appendChild(backdrop);
  return { close };
}
