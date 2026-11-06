/* ============================================================================
 * 新建「创作项目」向导：上传小说 → 分集参数 → 交付物 → 六步任务引导
 * 三个阶段都有明确的视觉状态；创建成功后立刻列出任务执行步骤。
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
    stage: 1, text: '', filename: '', name: '',
    split: { strategy: 'chapter', targetChars: 1200, maxEpisodes: 4 },
    deliverables: { video: true, pack: true },
    style: 'cinematic', aspect: '16:9',
    preview: null, busy: false, error: '',
  };
  const root = $('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal wizard-modal" role="dialog" aria-label="新建创作项目">
    <div class="wz-head">
      <div><h2>＋ 新建创作项目</h2><div class="sub">上传小说 → 分集 → 制作视频 / 导出导演包 · 无限画布全程保留</div></div>
      <button class="icon-btn" data-act="close" title="关闭">✕</button>
    </div>
    <div class="wz-stages" id="wz-stages"></div>
    <div class="wz-body" id="wz-body"></div>
    <div class="wz-foot" id="wz-foot"></div>
  </div>`;
  root.appendChild(backdrop);
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(); });

  function setError(msg) { state.error = msg; renderStages(); renderFoot(); renderMeta(); }
  function summaryText() {
    const d = state.deliverables;
    return `${state.name.trim() || '自动命名'} · ${state.text.trim().length} 字 · ${state.preview?.episodeCount || 0} 集 · ${d.video && d.pack ? '视频 + 导演包' : d.video ? '仅成片视频' : d.pack ? '仅导演包' : '未选择交付物'}`;
  }

  function renderStages() {
    const labels = [
      ['①', '上传小说', '解析原文与章节'],
      ['②', '分集拆解', '策略与实时预览'],
      ['③', '交付设置', '确认六步任务'],
    ];
    $('wz-stages').innerHTML = labels.map(([no, name, hint], i) => {
      const n = i + 1;
      const cls = n === state.stage ? 'active' : n < state.stage ? 'done' : '';
      return `<div class="wz-stage ${cls}"><span class="wz-stage-no">${n < state.stage ? '✓' : no}</span>
        <span><strong>${name}</strong><small>${hint}</small></span></div>${i < 2 ? '<div class="wz-stage-line"></div>' : ''}`;
    }).join('');
  }

  function renderFoot() {
    const foot = $('wz-foot');
    const valid1 = state.text.trim().length >= 40;
    const valid2 = valid1 && !!state.preview?.episodeCount;
    const valid3 = valid2 && (state.deliverables.video || state.deliverables.pack);
    const nextDisabled = (state.stage === 1 && !valid1) || (state.stage === 2 && !valid2);
    foot.innerHTML = `
      <div class="wz-foot-msg ${state.error ? 'err' : ''}">${esc(state.error || (state.stage === 3 ? '创建后将立即显示 6 步任务执行清单' : '所有数据仅保存在本地 data/'))}</div>
      ${state.stage > 1 ? '<button class="btn" data-act="prev">← 上一步</button>' : ''}
      ${state.stage < 3
        ? `<button class="btn primary" data-act="next" ${nextDisabled ? 'disabled' : ''}>下一步 →</button>`
        : `<button class="btn primary" data-act="create" ${(!valid3 || state.busy) ? 'disabled' : ''}>${state.busy ? '创建中…' : '＋ 创建创作项目'}</button>`}`;
    foot.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => onFoot(b.dataset.act)));
  }

  function renderMeta() {
    const el = $('wz-meta');
    if (!el) return;
    const chars = state.text.trim().length;
    const ok = chars >= 40;
    el.innerHTML = `<span class="wz-k ${ok ? 'ok' : 'warn'}">${ok ? '✓' : '!'} ${chars} 字</span>
      ${state.filename ? `<span class="wz-k">${esc(cut(state.filename, 26))}</span>` : ''}
      ${state.preview ? `<span class="wz-k ok">✓ ${state.preview.chapterCount} 章 → ${state.preview.episodeCount} 集</span>` : ''}
      <span class="wz-k">本地优先</span>`;
  }

  function renderBody() {
    const body = $('wz-body');
    if (state.stage === 1) {
      body.innerHTML = `
        <div class="wz-lead"><strong>第 ① 步 · 上传小说与交付设置</strong><span>对应论文式(1) 的输入归一：把长文本整理为可索引的原著语料</span></div>
        <div class="wz-drop" id="wz-drop">
          <div class="wz-drop-icon">⇧</div>
          <strong>拖拽 .txt / .md 到这里，或点击选择文件</strong>
          <span>也支持直接粘贴正文 · 至少 40 字</span>
          <div class="wz-drop-actions">
            <button class="btn" data-act="file">选择文件</button>
            <button class="btn" data-act="sample">载入示例小说</button>
          </div>
        </div>
        <div class="field"><label>或粘贴小说正文</label><textarea id="wz-text" rows="6" placeholder="雨夜来信&#10;&#10;第一章 没有署名的信&#10;雨下了整夜……">${esc(state.text)}</textarea></div>
        <div class="field"><label>项目名称（留空自动用书名）</label><input id="wz-name" value="${esc(state.name)}" placeholder="例如：雨夜来信 · 第一季"></div>
        <div class="wz-meta" id="wz-meta"></div>`;
      const drop = $('wz-drop');
      const readFile = (file) => {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          state.text = String(reader.result || ''); state.filename = file.name;
          if (!state.name) state.name = file.name.replace(/\.(txt|md|markdown)$/i, '');
          state.preview = null; state.error = '';
          $('wz-text').value = state.text; $('wz-name').value = state.name;
          renderMeta(); renderFoot(); toast(`已载入「${file.name}」`, 'ok');
        };
        reader.readAsText(file, 'utf-8');
      };
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); readFile(e.dataTransfer.files?.[0]); });
      $('wz-text').addEventListener('input', (e) => { state.text = e.target.value; state.preview = null; state.error = ''; renderMeta(); renderFoot(); });
      $('wz-name').addEventListener('input', (e) => { state.name = e.target.value; });
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
          if (!state.name) state.name = '雨夜来信 · 示例';
          state.preview = null; state.error = '';
          $('wz-text').value = state.text; $('wz-name').value = state.name;
          renderMeta(); renderFoot(); toast('示例小说已载入，点「下一步」看分集预览', 'ok');
        } catch (e) { setError(e.message); }
      }));
      renderMeta();
    } else if (state.stage === 2) {
      body.innerHTML = `
        <div class="wz-lead"><strong>第 ② 步 · 分集拆解</strong><span>长篇先压成「集」这一中间粒度，事件→场景→镜头每层只处理合适规模的上下文（式(5) 前置扩展层）</span></div>
        <div class="wz-label">分集策略</div>
        <div class="wz-cards" id="wz-strategies">${STRATEGIES.map((s) => `
          <button class="wz-card ${state.split.strategy === s.id ? 'selected' : ''}" data-strategy="${s.id}">
            <span class="wz-card-icon">${s.icon}</span><strong>${s.name}</strong><small>${s.hint}</small>
          </button>`).join('')}</div>
        <div class="modal-grid" style="margin-top:12px">
          <div class="field"><label>每集目标字数（300–8000）</label><input id="wz-target" type="number" min="300" max="8000" step="100" value="${state.split.targetChars}"></div>
          <div class="field"><label>最多集数（1–12）</label><input id="wz-max" type="number" min="1" max="12" value="${state.split.maxEpisodes}"></div>
        </div>
        <div class="wz-preview-head"><span>实时分集预览</span><button class="mini-btn" data-act="refresh">↻ 重新计算</button></div>
        <div class="wz-preview" id="wz-preview"><div class="wz-loading">正在计算分集…</div></div>`;
      body.querySelectorAll('[data-strategy]').forEach((b) => b.addEventListener('click', () => {
        state.split.strategy = b.dataset.strategy;
        body.querySelectorAll('[data-strategy]').forEach((x) => x.classList.toggle('selected', x === b));
        schedulePreview();
      }));
      $('wz-target').addEventListener('input', (e) => { state.split.targetChars = Number(e.target.value) || 1200; schedulePreview(); });
      $('wz-max').addEventListener('input', (e) => { state.split.maxEpisodes = Number(e.target.value) || 4; schedulePreview(); });
      body.querySelectorAll('[data-act="refresh"]').forEach((b) => b.addEventListener('click', () => loadPreview(true)));
      loadPreview();
    } else {
      body.innerHTML = `
        <div class="wz-lead"><strong>第 ③ 步 · 交付物与任务确认</strong><span>创建后在右侧「任务步骤」Tab 逐步执行六步，画布随每一步生长</span></div>
        <div class="wz-label">最终交付物（至少选一项）</div>
        <div class="wz-cards two" id="wz-deliver">
          <button class="wz-card ${state.deliverables.video ? 'selected' : ''}" data-del="video"><span class="wz-card-icon">▶</span><strong>成片视频</strong><small>ComfyUI 真实片段 → ffmpeg 拼接 MP4；Mock 为帧序列预览</small></button>
          <button class="wz-card ${state.deliverables.pack ? 'selected' : ''}" data-del="pack"><span class="wz-card-icon">▤</span><strong>导演包</strong><small>*.mmxpack.zip · 可导入 ComfyUI MiniMax H3 Director</small></button>
        </div>
        <div class="modal-grid" style="margin-top:12px">
          <div class="field"><label>画幅</label><select id="wz-aspect"><option value="16:9" ${state.aspect === '16:9' ? 'selected' : ''}>16:9 横屏</option><option value="9:16" ${state.aspect === '9:16' ? 'selected' : ''}>9:16 竖屏</option></select></div>
          <div class="field"><label>画面风格</label><select id="wz-style">${['cinematic', 'noir', 'anime', 'watercolor'].map((v) => `<option value="${v}" ${state.style === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        </div>
        <div class="wz-label" style="margin-top:14px">创建后立即显示的六步任务</div>
        <div class="wz-steps">${steps.map((s, i) => `<div class="wz-step-row ${i < 2 ? 'done' : ''}"><span class="wz-step-no">${i < 2 ? '✓' : s.no}</span><span><strong>${esc(s.title)}</strong><small>${esc(s.short)} · ${esc(s.theory?.ref || '')}</small></span><span class="wz-step-state">${i < 2 ? '创建时完成' : '待执行'}</span></div>`).join('')}</div>
        <div class="wz-summary" id="wz-summary">${esc(summaryText())}</div>`;
      body.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
        const k = b.dataset.del;
        state.deliverables[k] = !state.deliverables[k];
        if (!state.deliverables.video && !state.deliverables.pack) setError('至少要选择一种交付物');
        else state.error = '';
        b.classList.toggle('selected', state.deliverables[k]);
        const sum = $('wz-summary'); if (sum) sum.textContent = summaryText();
        renderFoot();
      }));
      $('wz-aspect').addEventListener('change', (e) => { state.aspect = e.target.value; });
      $('wz-style').addEventListener('change', (e) => { state.style = e.target.value; });
    }
    renderStages(); renderFoot();
  }

  let previewTimer = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => loadPreview(), 320);
  }
  async function loadPreview(force = false) {
    if (state.stage !== 2) return;
    if (state.text.trim().length < 40) { setError('正文至少需要 40 字'); return; }
    const box = $('wz-preview');
    if (box) box.innerHTML = '<div class="wz-loading">正在计算分集…</div>';
    try {
      const d = await api('/api/novel/preview', {
        text: state.text, filename: state.filename, split: state.split,
      });
      if (!d.ok) { setError(d.message); if (box) box.innerHTML = `<div class="wz-err">${esc(d.message)}</div>`; return; }
      state.preview = d.preview; state.error = '';
      if (box) box.innerHTML = `
        <div class="wz-preview-stat"><span class="ok">✓ ${esc(d.message)}</span><span>章节：${esc(d.preview.chapterTitles.slice(0, 3).join(' / '))}${d.preview.chapterTitles.length > 3 ? ' …' : ''}</span></div>
        ${d.preview.episodes.map((e) => `<div class="wz-ep"><span class="wz-ep-no">${e.no}</span><span class="wz-ep-main"><strong>${esc(e.title)}</strong><small>${esc(e.summary)}</small><em>钩子：${esc(e.hook)}</em></span><span class="wz-ep-chars">${e.chars} 字</span></div>`).join('')}`;
      renderFoot(); renderMeta();
      if (force) toast(`已按「${STRATEGIES.find((s) => s.id === state.split.strategy)?.name}」重算 ${d.preview.episodeCount} 集`, 'ok');
    } catch (e) {
      setError(e.message);
      if (box) box.innerHTML = `<div class="wz-err">${esc(e.message)}</div>`;
    }
  }

  async function onFoot(act) {
    if (act === 'close') return close();
    if (act === 'prev') { state.stage = Math.max(1, state.stage - 1); state.error = ''; renderBody(); return; }
    if (act === 'next') {
      if (state.stage === 1 && state.text.trim().length < 40) return setError('正文至少需要 40 字');
      state.stage = Math.min(3, state.stage + 1); state.error = ''; renderBody(); return;
    }
    if (act === 'create') {
      state.busy = true; renderFoot();
      try {
        const project = await api('/api/projects', {
          kind: 'novel', text: state.text, filename: state.filename,
          name: state.name.trim(), split: state.split, deliverables: state.deliverables,
          style: state.style, aspect: state.aspect,
        });
        close();
        toast(`创作项目「${project.name}」已创建 · ${project.management.episodes.length} 集`, 'ok');
        opts.onCreated?.(project);
        openStepsGuide({ project, steps, toast, onStart: opts.onStart, onOpenPanel: opts.onOpenPanel });
      } catch (e) {
        state.busy = false; setError(e.message); toast(e.message, 'err');
      }
    }
  }
  backdrop.querySelector('[data-act="close"]').addEventListener('click', close);
  renderBody();
  return { close };
}

/** 创建后的「任务执行步骤」引导：明确列出六步、当前状态与下一步动作 */
export function openStepsGuide({ project, steps = [], toast = () => {}, onStart, onOpenPanel } = {}) {
  const root = $('modal-root');
  const m = project.management || {};
  const done = (m.steps || []).filter((s) => s.status === 'done').length;
  const next = (m.steps || []).find((s) => s.status === 'pending') || null;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal guide-modal" role="dialog" aria-label="任务执行步骤">
    <div class="guide-head"><span class="guide-badge ok">✓ 已创建</span><h2>${esc(project.name)}</h2>
      <div class="sub">${m.episodes?.length || 0} 集 · ${(m.source?.totalChars || 0).toLocaleString()} 字 · ${m.deliverables?.video && m.deliverables?.pack ? '成片视频 + 导演包' : m.deliverables?.pack ? '仅导演包' : '仅成片视频'} · 无限画布已生成初始节点</div></div>
    <div class="guide-progress"><div class="guide-progress-bar"><i style="width:${Math.round(done / Math.max(1, steps.length) * 100)}%"></i></div><span>${done}/${steps.length} 步已完成</span></div>
    <div class="guide-list">${steps.map((s, i) => {
      const st = (m.steps || []).find((x) => x.id === s.id)?.status || (i < 2 ? 'done' : 'pending');
      const isNext = next && st !== 'done' && s.id === next.id;
      return `<div class="guide-row ${st} ${isNext ? 'next' : ''}">
        <span class="guide-no">${st === 'done' ? '✓' : s.no}</span>
        <span class="guide-main"><strong>${esc(s.title)}</strong><small>${esc(s.short)} · ${esc(s.theory?.ref || '')}</small></span>
        <span class="guide-state">${st === 'done' ? '创建时已完成' : isNext ? '下一步' : '待执行'}</span></div>`;
    }).join('')}</div>
    <div class="guide-tip">状态图例：<span class="lg pending">灰 · 待执行</span><span class="lg running">橙 + 呼吸 · 进行中</span><span class="lg done">绿 ✓ · 已完成</span><span class="lg error">红 · 失败可重试</span>。右侧「任务步骤」Tab 可逐步执行，画布节点同步高亮。</div>
    <div class="modal-actions">
      <button class="btn" data-act="later">稍后再说</button>
      <button class="btn" data-act="panel">查看任务面板</button>
      <button class="btn primary" data-act="start">▶ 执行第 ${next?.no || 3} 步</button>
    </div>
  </div>`;
  const close = () => backdrop.remove();
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-act="later"]').addEventListener('click', close);
  backdrop.querySelector('[data-act="panel"]').addEventListener('click', () => { close(); onOpenPanel?.(); });
  backdrop.querySelector('[data-act="start"]').addEventListener('click', () => { close(); onStart?.(next?.id); });
  root.appendChild(backdrop);
  return { close };
}
