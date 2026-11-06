/* ============================================================================
 * 项目工作台（Project Workshop）—— 进入创作项目后的默认全屏视图
 *
 * 布局：左侧 = 漫剧路线图（六步友好外壳，映射现有 STEPS 状态机）
 *            + 故事来源入口（上传小说 / AI 生成小说）
 *            + 项目资源（角色 / 分集 / 产物统计与入口）
 *      右侧 = 项目信息卡（封面 / 名称 / 简介与创作设定，✦ AI 一键补全）
 *            + 当前步骤操作台（上传、AI 生成、分集参数、提取角色、执行、下载）
 *            + 分集列表
 * 画布视图仍保留，顶栏一键切换（高级编辑）。
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

/** 六步 → 友好路线图文案（底层仍是 project-steps.mjs 的 STEPS 状态机） */
const ROADMAP = {
  upload: { name: '准备故事', hint: '上传小说，或让 AI 按构想生成', icon: '⇧' },
  episodes: { name: '分集拆解', hint: '把长篇切成可拍摄的集', icon: '▥' },
  script: { name: '剧本创作', hint: '分集梗概写成统一格式剧本', icon: '▤' },
  context: { name: '角色与上下文', hint: '提取角色 · 原著索引 · 层次分解', icon: '⑂' },
  storyboard: { name: '分镜与画面', hint: '关键帧 · 择优 · 视频片段', icon: '⌗' },
  deliver: { name: '成片交付', hint: '成片视频 / 导演包', icon: '✦' },
};
const STATUS_TEXT = { pending: '待执行', running: '进行中', done: '已完成', error: '失败 · 可重试', skipped: '已跳过' };
const STYLES = ['cinematic', 'noir', 'anime', 'watercolor'];
const STYLE_NAMES = { cinematic: '电影感', noir: '黑色电影', anime: '日系动画', watercolor: '水彩' };
const SPLIT_STRATEGIES = [
  { id: 'chapter', name: '按章节', hint: '识别「第X章 / Chapter N」' },
  { id: 'fixed', name: '按字数', hint: '固定字数均分' },
  { id: 'scene', name: '按场景段落', hint: '空行分段聚合' },
];

/* 工作台 UI 状态（跨渲染保留：AI 大纲草稿、上传草稿、项目信息编辑稿） */
const ui = {
  projectId: null,
  stepId: null,
  info: {},                       // 项目信息编辑稿（bible 字段）
  skipCapture: false,             // AI 补全等服务端改写场景：跳过一次 DOM 捕获，避免旧输入框值盖回新数据
  upload: { open: false, filename: '', text: '', msg: '', err: false },
  ai: { open: false, idea: '', chapterCount: 3, chapterChars: 800, outline: null, source: '', message: '', busy: false, busyText: '' },
};

function resetUi(p) {
  const m = p.management || {};
  ui.projectId = p.id;
  ui.stepId = null;
  ui.info = {};
  ui.upload = { open: false, filename: '', text: '', msg: '', err: false };
  ui.ai = { open: false, idea: String(m.bible?.logline || ''), chapterCount: 3, chapterChars: 800, outline: null, source: '', message: '', busy: false, busyText: '' };
}

/** 重绘前把用户正在编辑的 DOM 值收进 ui，避免 SSE 刷新吃掉输入 */
function captureState(host) {
  if (!host || !host.isConnected) return;
  const q = (sel) => host.querySelector(sel);
  if (q('#pv-up-text')) ui.upload.text = q('#pv-up-text').value;
  if (q('#pv-ai-idea')) ui.ai.idea = q('#pv-ai-idea').value;
  if (q('#pv-ai-count')) ui.ai.chapterCount = Number(q('#pv-ai-count').value) || 3;
  if (q('#pv-ai-charsel')) ui.ai.chapterChars = Number(q('#pv-ai-charsel').value) || 800;
  if (ui.ai.outline) {
    host.querySelectorAll('[data-olf]').forEach((el) => {
      const i = Number(el.dataset.i);
      const f = el.dataset.olf;
      if (ui.ai.outline.chapters?.[i]) ui.ai.outline.chapters[i][f] = el.value;
    });
    const t = q('#pv-ol-title');
    if (t) ui.ai.outline.title = t.value;
  }
  host.querySelectorAll('[data-bi]').forEach((el) => { ui.info[el.dataset.bi] = el.value; });
}

const fmtTok = (n) => (Number(n) || 0) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Number(n) || 0);
const fmtTime = (ts) => ts ? new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '';

function stepStateOf(m, id) {
  return (m.steps || []).find((s) => s.id === id) || { status: 'pending' };
}

/* ------------------------------------------------------------------ 左侧：路线图 */
function roadmapHTML(m, steps, busy) {
  const list = steps.length ? steps : Object.keys(ROADMAP).map((id, i) => ({ id, no: i + 1 }));
  const done = (m.steps || []).filter((s) => s.status === 'done').length;
  const total = list.length;
  const current = (m.steps || []).find((s) => s.status === 'running') || (m.steps || []).find((s) => s.status === 'pending');
  const allDone = total > 0 && done === total;
  return `<div class="pv-card pv-roadmap">
    <div class="pv-card-head"><span>🗺 漫剧路线图</span><span class="pv-progress-pill">${done}/${total}</span></div>
    <div class="pv-progress"><i style="width:${total ? Math.round(done / total * 100) : 0}%"></i></div>
    <div class="pv-steps">${list.map((def) => {
      const st = stepStateOf(m, def.id);
      const rm = ROADMAP[def.id] || { name: def.title || def.id, hint: def.short || '', icon: '·' };
      const isCur = current?.id === def.id && st.status !== 'done';
      return `<button class="pv-step st-${st.status} ${ui.stepId === def.id ? 'selected' : ''}" data-step="${def.id}">
        <span class="pv-step-no">${st.status === 'done' ? '✓' : def.no}</span>
        <span class="pv-step-main"><strong>${esc(rm.name)}</strong><small>${esc(rm.hint)}</small></span>
        <span class="pv-step-state">${st.status === 'running' ? '<i class="pv-pulse"></i>' : ''}${isCur && st.status === 'pending' ? '下一步' : STATUS_TEXT[st.status] || ''}</span>
      </button>`;
    }).join('')}</div>
    <div class="pv-roadmap-foot">
      <button class="btn primary sm" data-act="run-next" ${busy || allDone ? 'disabled' : ''}>${busy ? '执行中…' : allDone ? '✓ 全部完成' : '▶ 执行下一步'}</button>
      <button class="btn sm" data-act="run-all" ${busy || allDone ? 'disabled' : ''}>⏩ 全部执行</button>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ 左侧：故事来源 */
function sourceCardHTML(m) {
  const s = m.source || {};
  return `<div class="pv-card pv-source">
    <div class="pv-card-head"><span>📖 故事来源</span></div>
    ${s.text
      ? `<div class="pv-source-info">
          <strong>《${esc(cut(s.title || '未命名', 18))}》</strong>
          <span>${s.chapterCount || 0} 章 · ${(s.totalChars || 0).toLocaleString()} 字 · ${(m.episodes || []).length} 集</span>
        </div>`
      : `<div class="pv-source-empty">还没有故事。上传你的小说，或让 AI 按一句话构想生成一部。</div>`}
    <div class="pv-source-acts">
      <button class="btn sm" data-act="goto-upload">⇧ 上传小说</button>
      <button class="btn sm accent-mini" data-act="goto-ai">✦ AI 生成小说</button>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ 左侧：项目资源 */
function resourceCardHTML(p, m, stats) {
  const chars = Array.isArray(m.characters) ? m.characters : [];
  return `<div class="pv-card pv-res">
    <div class="pv-card-head"><span>▣ 项目资源</span></div>
    <div class="pv-res-grid">
      <div><b>${chars.length}</b><span>角色</span></div>
      <div><b>${(m.episodes || []).length}</b><span>分集</span></div>
      <div><b>${stats.shotCount ?? p.nodes.filter((n) => n.type === 'shot').length}</b><span>镜头</span></div>
      <div><b>${stats.videoCount ?? p.nodes.filter((n) => n.type === 'video').length}</b><span>片段</span></div>
    </div>
    ${chars.length ? `<div class="pv-res-chars">${chars.slice(0, 5).map((c) => {
      const img = c.views?.front?.url;
      return `<span class="pv-char-chip" title="${esc(c.role || c.name)}">${img ? `<img src="${esc(img)}" alt="">` : '<i></i>'}${esc(c.name)}</span>`;
    }).join('')}${chars.length > 5 ? `<span class="pv-char-chip">+${chars.length - 5}</span>` : ''}</div>` : ''}
    <div class="pv-res-acts">
      <button class="btn sm" data-act="assets">▣ 资源库</button>
      <button class="btn sm" data-act="chars">👤 角色管理</button>
      <button class="btn sm" data-act="manage">▦ 项目管理</button>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ 右侧：项目信息卡 */
function infoCardHTML(p, m) {
  const b = m.bible || {};
  const v = (k) => esc(ui.info[k] !== undefined ? ui.info[k] : (b[k] || ''));
  const cover = m.cover || {};
  const settings = p.settings || {};
  const d = m.deliverables || { video: true, pack: true };
  const coverHtml = cover.url
    ? `<img src="${esc(cover.url)}" alt="封面">`
    : `<span class="pv-cover-name">${esc((p.name || '未')[0])}</span>`;
  return `<div class="pv-card pv-hero">
    <button class="pv-cover" data-act="cover" title="设置项目封面">${coverHtml}<span class="pv-cover-edit">🖼 封面</span></button>
    <div class="pv-hero-main">
      <div class="pv-hero-title">
        <h1>${esc(p.name)}</h1>
        <span class="pv-tag">${m.kind === 'novel' ? '小说分集创作' : '标准流水线'}</span>
        <span class="pv-tag">${esc(STYLE_NAMES[settings.style] || settings.style || '电影感')}</span>
        <span class="pv-tag">${esc(settings.aspect || '16:9')}</span>
        <span class="pv-tag">${d.video && d.pack ? '视频 + 导演包' : d.video ? '成片视频' : '导演包'}</span>
      </div>
      <div class="pv-hero-sub">创建于 ${fmtTime(m.createdAt)} · 项目信息可逐步补充，也可以让 AI 按构想一次补全</div>
      <div class="pv-ai-fill">
        <input id="pv-bi-idea" placeholder="一句话故事构想（AI 补全与 AI 生成小说的依据）" value="${esc(ui.ai.idea || b.logline || '')}">
        <button class="btn sm" data-act="ai-fill">✦ AI 补全信息</button>
      </div>
      <div class="pv-info-grid">
        <div class="field"><label>一句话简介</label><textarea data-bi="logline" rows="2" placeholder="这个故事讲了什么…">${v('logline')}</textarea></div>
        <div class="pv-info-row">
          <div class="field"><label>类型</label><input data-bi="genre" value="${v('genre')}" placeholder="悬疑 / 青春 / 科幻…"></div>
          <div class="field"><label>受众</label><input data-bi="audience" value="${v('audience')}" placeholder="目标观众"></div>
          <div class="field"><label>基调</label><input data-bi="tone" value="${v('tone')}" placeholder="治愈 / 紧张…"></div>
        </div>
        <div class="pv-info-row">
          <div class="field"><label>画面风格</label><select data-set="style">${STYLES.map((s) => `<option value="${s}" ${(settings.style || 'cinematic') === s ? 'selected' : ''}>${STYLE_NAMES[s]}（${s}）</option>`).join('')}</select></div>
          <div class="field"><label>画幅</label><select data-set="aspect"><option value="16:9" ${(settings.aspect || '16:9') === '16:9' ? 'selected' : ''}>16:9 横屏</option><option value="9:16" ${settings.aspect === '9:16' ? 'selected' : ''}>9:16 竖屏</option></select></div>
          <div class="field"><label>美术风格关键词</label><input data-bi="artStyle" value="${v('artStyle')}" placeholder="如：赛博朋克霓虹"></div>
        </div>
      </div>
      <div class="pv-hero-acts">
        <button class="btn sm primary" data-act="save-info">保存项目信息</button>
        <span class="pv-hero-msg" id="pv-info-msg"></span>
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ 右侧：步骤操作台 */
function consoleHeadHTML(def, st, busy) {
  const rm = ROADMAP[def.id] || { name: def.title, hint: def.short };
  return `<div class="pv-console-head">
    <span class="pv-console-icon">${rm.icon}</span>
    <div class="pv-console-title"><strong>第 ${def.no} 步 · ${esc(rm.name)}</strong><small>${esc(def.desc || rm.hint)}</small></div>
    <span class="pv-pill st-${st.status}">${STATUS_TEXT[st.status] || st.status}</span>
  </div>
  ${st.note ? `<div class="pv-console-note">${esc(st.note)}${st.durationMs ? ` · ${(st.durationMs / 1000).toFixed(1)}s` : ''}</div>` : ''}
  ${def.auto ? '' : `<div class="pv-console-acts">
    <button class="btn primary sm" data-act="run-step" data-id="${def.id}" ${busy ? 'disabled' : ''}>${st.status === 'error' ? '↻ 重试本步' : st.status === 'done' ? '↻ 重新执行' : '▶ 执行本步'}</button>
  </div>`}`;
}

/** ① 准备故事：上传 / AI 生成双入口 */
function uploadConsoleHTML(m) {
  const s = m.source || {};
  const has = !!s.text;
  return `
  ${has ? `<div class="pv-src-card">
      <div class="pv-src-badge ok">✓ 故事已就绪</div>
      <strong>《${esc(s.title || '未命名')}》</strong>
      <span>${s.chapterCount || 0} 章 · ${(s.totalChars || 0).toLocaleString()} 字 · 已拆为 ${(m.episodes || []).length} 集${s.filename ? ` · ${esc(cut(s.filename, 24))}` : ''}</span>
      <div class="pv-src-acts">
        <button class="btn sm" data-act="toggle-upload">⇧ 重新上传</button>
        <button class="btn sm" data-act="toggle-ai">✦ AI 重新生成</button>
      </div>
    </div>` : ''}
  ${!has || ui.upload.open ? `<div class="pv-sub-card" id="pv-upload-card">
      <div class="pv-sub-head"><strong>⇧ 上传小说</strong><span>.txt / .md · 或直接粘贴正文 · 至少 40 字 · 上传后自动完成 ①②</span></div>
      <div class="pv-up-actions">
        <button class="btn sm" data-up="file">选择文件</button>
        <button class="btn sm" data-up="sample">载入示例小说</button>
      </div>
      <textarea id="pv-up-text" rows="5" placeholder="雨夜来信&#10;&#10;第一章 没有署名的信&#10;雨下了整夜……">${esc(ui.upload.text)}</textarea>
      <div class="pv-up-foot">
        <span class="pv-up-msg ${ui.upload.err ? 'err' : ''}">${esc(ui.upload.msg || '上传后自动解析章节并分集，可在第 ② 步调整')}</span>
        <button class="btn primary sm" data-up="submit">⇧ 上传并自动分集</button>
      </div>
    </div>` : ''}
  ${!has || ui.ai.open ? `<div class="pv-sub-card" id="pv-ai-card">
      <div class="pv-sub-head"><strong>✦ AI 生成小说</strong><span>一句话构想 → 分章大纲 → 整本正文 → 自动分集 · 未配置模型时用内置模板演示</span></div>
      <div class="pv-ai-form">
        <textarea id="pv-ai-idea" rows="2" placeholder="例如：退役刑警收到一封来自十年前的信，揭开一桩被遗忘的旧案">${esc(ui.ai.idea)}</textarea>
        <div class="pv-ai-opts">
          <label>章节数 <select id="pv-ai-count">${[2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${ui.ai.chapterCount === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <label>每章约 <select id="pv-ai-charsel">${[600, 800, 1200, 1500].map((n) => `<option value="${n}" ${ui.ai.chapterChars === n ? 'selected' : ''}>${n}</option>`).join('')}</select> 字</label>
          <button class="btn sm" data-ai="outline" ${ui.ai.busy ? 'disabled' : ''}>${ui.ai.outline ? '↻ 重新生成大纲' : '① 生成大纲'}</button>
        </div>
      </div>
      ${ui.ai.outline ? `<div class="pv-ai-outline">
        <div class="field"><label>书名</label><input id="pv-ol-title" value="${esc(ui.ai.outline.title)}"></div>
        ${ui.ai.outline.chapters.map((c, i) => `<div class="pv-ol-ch">
          <input data-olf="title" data-i="${i}" value="${esc(c.title)}" title="章节标题">
          <textarea data-olf="summary" data-i="${i}" rows="2" placeholder="本章梗概">${esc(c.summary)}</textarea>
          <input data-olf="hook" data-i="${i}" value="${esc(c.hook)}" placeholder="结尾钩子（可选）">
        </div>`).join('')}
        <div class="pv-ai-foot">
          <span class="pv-up-msg">${esc(ui.ai.message || '')}</span>
          <button class="btn primary sm" data-ai="full" ${ui.ai.busy ? 'disabled' : ''}>${ui.ai.busy ? esc(ui.ai.busyText || '生成中…') : '② 生成全文并注入项目'}</button>
        </div>
      </div>` : `<div class="pv-ai-foot"><span class="pv-up-msg">${esc(ui.ai.message || '先生成大纲，确认或编辑后再生成全文')}</span></div>`}
    </div>` : ''}`;
}

/** ② 分集拆解 */
function episodesConsoleHTML(m, st, busy) {
  const has = !!m.source?.text;
  const sp = m.split || { strategy: 'chapter', targetChars: 1200, maxEpisodes: 4 };
  if (!has) return `<div class="pv-hint">先在第 ① 步上传或生成小说，再回来调整分集。</div>`;
  return `<div class="pv-split">
    <div class="pv-split-cards">${SPLIT_STRATEGIES.map((s) => `
      <button class="pv-split-card ${sp.strategy === s.id ? 'selected' : ''}" data-split="${s.id}">
        <strong>${s.name}</strong><small>${s.hint}</small>
      </button>`).join('')}</div>
    <div class="pv-split-opts">
      <label>每集目标字数 <input type="number" id="pv-sp-target" min="300" max="8000" step="100" value="${sp.targetChars}"></label>
      <label>最多集数 <input type="number" id="pv-sp-max" min="1" max="12" value="${sp.maxEpisodes}"></label>
      <button class="btn sm primary" data-act="re-split" ${busy ? 'disabled' : ''}>▥ 按新参数重新分集</button>
    </div>
    <div class="pv-hint">当前 ${(m.episodes || []).length} 集 · 重新分集会替换画板上的分集节点，原著全文保留。</div>
  </div>`;
}

/** ③ 剧本创作 */
function scriptConsoleHTML(p, st) {
  const script = p.nodes.find((n) => n.type === 'script');
  const sc = script?.data?.script;
  return `${sc
    ? `<div class="pv-src-card"><div class="pv-src-badge ok">✓ 剧本已生成</div>
        <strong>《${esc(cut(sc.title || p.name, 20))}》</strong>
        <span>${esc(sc.genre || '')} · ${(sc.scenes || []).length} 场 · ${(sc.characters || []).length} 角色</span>
        <p class="pv-logline">${esc(cut(sc.logline || '', 120))}</p></div>`
    : `<div class="pv-hint">编剧智能体将把 ${(p.management?.episodes || []).length || '…'} 集梗概写成统一格式剧本（片名 / 类型 / 梗概 / 角色 / 场景表 / 对白）。</div>`}`;
}

/** ④ 角色与上下文 */
function contextConsoleHTML(p, m, st, busy) {
  const chars = Array.isArray(m.characters) ? m.characters : [];
  const has = !!m.source?.text;
  return `<div class="pv-char-acts">
      <button class="btn sm primary" data-act="char-extract" data-mode="llm" ${!has || busy ? 'disabled' : ''}>✦ 从原著提取角色（LLM）</button>
      <button class="btn sm" data-act="char-extract" data-mode="heuristic" ${!has || busy ? 'disabled' : ''}>⚙ 启发式提取</button>
      <button class="btn sm" data-act="chars">👤 角色管理（多视图定妆）</button>
    </div>
    ${!has ? '<div class="pv-hint">先在第 ① 步准备故事，才能提取角色。</div>' : ''}
    ${chars.length ? `<div class="pv-char-list">${chars.map((c) => `
      <div class="pv-char-item">
        ${c.views?.front?.url ? `<img src="${esc(c.views.front.url)}" alt="">` : '<i class="pv-char-ph"></i>'}
        <div><strong>${esc(c.name)}</strong><small>${esc(c.role || '')}${c.gender ? ` · ${esc(c.gender)}` : ''}${c.age ? ` · ${esc(c.age)}` : ''}</small></div>
        <span class="pv-chip">${{ llm: 'LLM', heuristic: '启发式', manual: '手动' }[c.source] || '手动'}</span>
      </div>`).join('')}</div>`
    : '<div class="pv-hint">还没有角色。提取后可到「角色管理」编辑属性、生成三视图定妆。</div>'}`;
}

/** ⑤ 分镜与画面 */
function storyboardConsoleHTML(p, stats) {
  const count = (t) => p.nodes.filter((n) => n.type === t).length;
  const cells = [['镜头', count('shot')], ['关键帧', count('keyframe')], ['择优', count('review')], ['视频片段', count('video')], ['转场', count('transition')]];
  return `<div class="pv-res-grid five">${cells.map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join('')}</div>
    <div class="pv-hint">按镜头规格 best-of-2 择优、机位依赖图传播视觉锚点；画布视图可查看每个节点的产物与连线。</div>
    <div class="pv-console-acts"><button class="btn sm" data-act="open-canvas">⬡ 在画布中查看分镜链</button></div>`;
}

/** ⑥ 成片交付 */
function deliverConsoleHTML(p, m, stats, busy) {
  const d = m.deliverables || { video: true, pack: true };
  const final = p.nodes.find((n) => n.type === 'final');
  const film = stats.film || final?.data?.film;
  const pack = stats.pack || final?.data?.directorPack;
  return `<div class="pv-deliver-opts">
      <label class="pv-check"><input type="checkbox" data-del="video" ${d.video ? 'checked' : ''}> 成片视频 <small>ComfyUI 片段 → ffmpeg 拼接 MP4</small></label>
      <label class="pv-check"><input type="checkbox" data-del="pack" ${d.pack ? 'checked' : ''}> 导演包 <small>*.mmxpack.zip · 可导入导演工作台</small></label>
    </div>
    <div class="pv-deliver-outs">
      <div class="pv-out ${film?.file ? 'ok' : ''}"><strong>成片视频</strong><span>${film?.file ? `已生成 · ${(film.bytes / 1024 / 1024).toFixed(1)} MB` : '未生成 · Mock 模式为帧序列预览'}</span>
        ${film?.file ? `<button class="btn sm primary" data-act="dl-film">⇩ 下载 MP4</button>` : ''}</div>
      <div class="pv-out ${pack?.file ? 'ok' : ''}"><strong>导演包</strong><span>${pack?.file ? `已生成 · ${pack.fileCount || 0} 个文件` : '执行本步后生成'}</span>
        <button class="btn sm" data-act="dl-pack">▤ ${pack?.file ? '下载导演包' : '生成并下载'}</button></div>
    </div>`;
}

/* ------------------------------------------------------------------ 分集列表 */
function episodesListHTML(m) {
  const eps = m.episodes || [];
  if (!eps.length) return '';
  return `<div class="pv-card pv-eps">
    <div class="pv-card-head"><span>▥ 分集 · ${eps.length} 集</span><span class="pv-hint-inline">摘要与结尾钩子由拆解自动生成</span></div>
    <div class="pv-eps-list">${eps.map((e) => `
      <div class="pv-ep">
        <span class="pv-ep-no">${e.no}</span>
        <div class="pv-ep-main"><strong>${esc(e.title)}</strong>
          <p>${esc(e.summary || '')}</p>
          ${e.hook ? `<small>钩子：${esc(e.hook)}</small>` : ''}</div>
        <span class="pv-ep-chars">${(e.chars || 0).toLocaleString()} 字</span>
      </div>`).join('')}</div>
  </div>`;
}

/* ================================================================== 主渲染 */
export function renderProjectView(host, ctx = {}) {
  if (!host) return;
  if (ui.skipCapture) ui.skipCapture = false;
  else captureState(host);
  const p = ctx.project;
  if (!p) {
    host.innerHTML = '<div class="pv-empty"><span class="big">◈</span>从左侧选择一个项目，或 ＋ 新建创作项目</div>';
    return;
  }
  const m = p.management || {};
  if (m.kind !== 'novel') {
    host.innerHTML = `<div class="pv-empty"><span class="big">⬡</span>
      这是标准流水线项目，画布是它的主战场。<br>
      <button class="btn primary" data-act="open-canvas" style="margin-top:14px">⬡ 打开画布视图</button></div>`;
    host.querySelector('[data-act="open-canvas"]')?.addEventListener('click', () => ctx.onOpenCanvas?.());
    return;
  }
  if (ui.projectId !== p.id) resetUi(p);

  const steps = ctx.steps || [];
  const stats = ctx.stats || {};
  const busy = !!ctx.busy;
  const current = (m.steps || []).find((s) => s.status === 'running') || (m.steps || []).find((s) => s.status === 'pending');
  if (!ui.stepId || !steps.some((s) => s.id === ui.stepId)) ui.stepId = current?.id || 'upload';
  const def = steps.find((s) => s.id === ui.stepId) || steps[0] || { id: 'upload', no: 1 };
  const st = stepStateOf(m, def.id);

  let consoleBody = '';
  if (def.id === 'upload') consoleBody = uploadConsoleHTML(m);
  else if (def.id === 'episodes') consoleBody = episodesConsoleHTML(m, st, busy);
  else if (def.id === 'script') consoleBody = scriptConsoleHTML(p, st);
  else if (def.id === 'context') consoleBody = contextConsoleHTML(p, m, st, busy);
  else if (def.id === 'storyboard') consoleBody = storyboardConsoleHTML(p, stats);
  else if (def.id === 'deliver') consoleBody = deliverConsoleHTML(p, m, stats, busy);

  host.innerHTML = `<div class="pv">
    <aside class="pv-side">
      ${roadmapHTML(m, steps, busy)}
      ${sourceCardHTML(m)}
      ${resourceCardHTML(p, m, stats)}
    </aside>
    <section class="pv-main">
      ${infoCardHTML(p, m)}
      <div class="pv-card pv-console" id="pv-console">
        ${consoleHeadHTML(def, st, busy)}
        ${consoleBody}
      </div>
      ${episodesListHTML(m)}
    </section>
  </div>`;
  bindEvents(host, ctx, { def, m });
}

/* ================================================================== 事件绑定 */
function bindEvents(host, ctx, { def, m }) {
  const p = ctx.project;
  const toast = ctx.toast || (() => {});
  const q = (sel) => host.querySelector(sel);
  const rerender = () => renderProjectView(host, ctx);
  const manage = async (action, value, silent = false) => {
    try {
      const d = await api(`/api/projects/${p.id}/manage`, { action, value });
      if (!silent) toast(d.message || '已更新', 'ok');
      p.management = d.management || p.management;
      await ctx.onChanged?.();
      rerender();
      return d;
    } catch (e) { toast(e.message, 'err'); return null; }
  };
  const gotoStep = (id) => { ui.stepId = id; rerender(); };

  // 路线图
  host.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => gotoStep(b.dataset.step)));
  q('[data-act="run-next"]')?.addEventListener('click', () => ctx.onRunStep?.(null, false));
  q('[data-act="run-all"]')?.addEventListener('click', () => ctx.onRunStep?.(null, true));
  q('[data-act="run-step"]')?.addEventListener('click', (e) => ctx.onRunStep?.(e.target.dataset.id, false, true));

  // 资源 / 管理入口
  q('[data-act="assets"]')?.addEventListener('click', () => ctx.onOpenAssets?.());
  q('[data-act="chars"]')?.addEventListener('click', () => ctx.onManage?.('characters'));
  q('[data-act="manage"]')?.addEventListener('click', () => ctx.onManage?.());
  q('[data-act="cover"]')?.addEventListener('click', () => ctx.onOpenCover?.());
  q('[data-act="open-canvas"]')?.addEventListener('click', () => ctx.onOpenCanvas?.());
  q('[data-act="goto-upload"]')?.addEventListener('click', () => { ui.upload.open = true; gotoStep('upload'); });
  q('[data-act="goto-ai"]')?.addEventListener('click', () => { ui.ai.open = true; gotoStep('upload'); });
  q('[data-act="toggle-upload"]')?.addEventListener('click', () => { ui.upload.open = !ui.upload.open; rerender(); });
  q('[data-act="toggle-ai"]')?.addEventListener('click', () => { ui.ai.open = !ui.ai.open; rerender(); });

  // 项目信息：保存 + AI 补全
  q('[data-act="save-info"]')?.addEventListener('click', async () => {
    captureState(host);
    const idea = String(q('#pv-bi-idea')?.value || '').trim();
    const value = { ...ui.info };
    if (idea && !value.logline) value.logline = idea.slice(0, 300);
    if (!Object.keys(value).length) { $('pv-info-msg') && (q('#pv-info-msg').textContent = '没有需要保存的修改'); return; }
    const d = await manage('bible', value);
    if (d?.ok) { ui.info = {}; q('#pv-info-msg') && (q('#pv-info-msg').textContent = '✓ 已保存'); }
  });
  q('[data-act="ai-fill"]')?.addEventListener('click', async (e) => {
    const idea = String(q('#pv-bi-idea')?.value || '').trim();
    if (!idea) { toast('先填一句故事构想，AI 才有依据', 'err'); q('#pv-bi-idea')?.focus(); return; }
    e.target.disabled = true; e.target.textContent = 'AI 补全中…';
    try {
      const d = await api(`/api/projects/${p.id}/bible/ai`, { idea });
      toast(d.message || '已补全', 'ok');
      ui.info = {};
      ui.skipCapture = true;   // 服务端已改写 bible：丢弃 DOM 里的旧编辑稿，直接渲染新数据
      await ctx.onChanged?.();
      rerender();
    } catch (err) { toast(err.message, 'err'); e.target.disabled = false; e.target.textContent = '✦ AI 补全信息'; }
  });
  host.querySelectorAll('[data-set]').forEach((el) => el.addEventListener('change', () => {
    manage('settings', { [el.dataset.set]: el.value });
  }));

  // ① 上传小说
  const readFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      ui.upload.text = String(reader.result || ''); ui.upload.filename = file.name;
      const ta = q('#pv-up-text'); if (ta) ta.value = ui.upload.text;
      ui.upload.msg = `已载入「${file.name}」· ${ui.upload.text.trim().length} 字`; ui.upload.err = false;
      const msgEl = q('.pv-up-msg'); if (msgEl) { msgEl.textContent = ui.upload.msg; msgEl.classList.remove('err'); }
    };
    reader.readAsText(file, 'utf-8');
  };
  host.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', async () => {
    const act = b.dataset.up;
    if (act === 'file') {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.txt,.md,.markdown,text/plain,text/markdown';
      input.onchange = () => readFile(input.files?.[0]);
      input.click();
    } else if (act === 'sample') {
      try {
        const d = await api('/api/novel/sample');
        ui.upload.text = d.text; ui.upload.filename = d.filename;
        const ta = q('#pv-up-text'); if (ta) ta.value = d.text;
        ui.upload.msg = `示例已载入 · ${d.text.trim().length} 字`; ui.upload.err = false;
        const msgEl = q('.pv-up-msg'); if (msgEl) msgEl.textContent = ui.upload.msg;
      } catch (e2) { ui.upload.msg = e2.message; ui.upload.err = true; }
    } else if (act === 'submit') {
      const text = String(q('#pv-up-text')?.value || '').trim();
      if (text.length < 40) {
        ui.upload.msg = `正文至少需要 40 字（当前 ${text.length} 字）`; ui.upload.err = true;
        const msgEl = q('.pv-up-msg'); if (msgEl) { msgEl.textContent = ui.upload.msg; msgEl.classList.add('err'); }
        return;
      }
      b.disabled = true;
      ui.upload.msg = '正在解析与分集…'; ui.upload.err = false;
      try {
        const out = await api(`/api/projects/${p.id}/source`, { text, filename: ui.upload.filename, split: m.split });
        ui.upload = { open: false, filename: '', text: '', msg: '', err: false };
        ui.stepId = 'episodes';
        await ctx.onSourceUploaded?.(out);
      } catch (e2) {
        b.disabled = false;
        ui.upload.msg = e2.message; ui.upload.err = true;
        rerender();
      }
    }
  }));

  // ① AI 生成小说
  host.querySelectorAll('[data-ai]').forEach((b) => b.addEventListener('click', async () => {
    if (ui.ai.busy) return;
    captureState(host);
    ui.ai.idea = String(q('#pv-ai-idea')?.value || ui.ai.idea).trim();
    if (!ui.ai.idea) { toast('先写一句故事构想，AI 才有创作方向', 'err'); q('#pv-ai-idea')?.focus(); return; }
    const act = b.dataset.ai;
    if (act === 'outline') {
      ui.ai.busy = true; ui.ai.busyText = '生成大纲中…'; ui.ai.message = '正在生成大纲…'; rerender();
      try {
        const d = await api(`/api/projects/${p.id}/novel/ai`, {
          mode: 'outline', idea: ui.ai.idea, chapterCount: ui.ai.chapterCount,
        });
        ui.ai.outline = d.outline; ui.ai.source = d.source; ui.ai.message = d.message || '';
      } catch (e2) { ui.ai.message = e2.message; toast(e2.message, 'err'); }
      ui.ai.busy = false; ui.ai.busyText = ''; rerender();
    } else if (act === 'full') {
      captureState(host);
      ui.ai.busy = true; ui.ai.busyText = '逐章生成正文中…'; ui.ai.message = '正在逐章生成正文，LLM 模式下可能需要几分钟…'; rerender();
      try {
        const out = await api(`/api/projects/${p.id}/novel/ai`, {
          mode: 'full', idea: ui.ai.idea, outline: ui.ai.outline,
          chapterCount: ui.ai.chapterCount, chapterChars: ui.ai.chapterChars, split: m.split,
        });
        toast(`✦ ${out.message}`, 'ok');
        ui.ai = { open: false, idea: ui.ai.idea, chapterCount: ui.ai.chapterCount, chapterChars: ui.ai.chapterChars, outline: null, source: '', message: '', busy: false, busyText: '' };
        ui.stepId = 'episodes';
        await ctx.onSourceUploaded?.(out);
      } catch (e2) {
        ui.ai.busy = false; ui.ai.busyText = ''; ui.ai.message = e2.message;
        toast(e2.message, 'err'); rerender();
      }
    }
  }));

  // ② 分集
  host.querySelectorAll('[data-split]').forEach((b) => b.addEventListener('click', () => {
    host.querySelectorAll('[data-split]').forEach((x) => x.classList.toggle('selected', x === b));
  }));
  q('[data-act="re-split"]')?.addEventListener('click', async () => {
    const strategy = host.querySelector('[data-split].selected')?.dataset.split || m.split?.strategy;
    const targetChars = Number(q('#pv-sp-target')?.value) || m.split?.targetChars;
    const maxEpisodes = Number(q('#pv-sp-max')?.value) || m.split?.maxEpisodes;
    const d = await manage('split', { strategy, targetChars, maxEpisodes }, true);
    if (d?.ok) ctx.onRunStep?.('episodes', false, true);
  });

  // ④ 角色提取
  host.querySelectorAll('[data-act="char-extract"]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = '提取中…';
    try {
      const d = await api(`/api/projects/${p.id}/characters/extract`, { mode: b.dataset.mode });
      toast(d.message || `新增 ${d.added || 0} · 合并 ${d.merged || 0}`, d.fellBack ? 'err' : 'ok');
      await ctx.onChanged?.();
      rerender();
    } catch (e2) { toast(e2.message, 'err'); b.disabled = false; b.textContent = b.dataset.mode === 'llm' ? '✦ 从原著提取角色（LLM）' : '⚙ 启发式提取'; }
  }));

  // ⑥ 交付
  host.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('change', () => {
    manage('deliverables', { [el.dataset.del]: el.checked });
  }));
  q('[data-act="dl-film"]')?.addEventListener('click', () => { window.location.href = `/api/projects/${p.id}/film`; });
  q('[data-act="dl-pack"]')?.addEventListener('click', () => ctx.onDownloadPack?.());
}
