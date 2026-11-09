/* ============================================================================
 * 项目列表页（应用落地页）
 *
 * 上方是「图文结合」的漫剧创作完整主流程：六张带插图的步骤卡，点击可直接
 * 跳到对应操作台；下方是项目列表（搜索 / 筛选 / 卡片操作 / 继续创作）。
 * 纯原生 ESM，数据来自 /api/bootstrap 的 projects / steps / settings / comfy。
 * ==========================================================================*/
import { llmReady, llmReadyLabel } from './startup-check.js';
import { esc, cut } from './utils.js';


/** 六步流程说明：图文结合，id 与后端 STEPS / 工作台路线图一致 */
const GUIDE = [
  { id: 'upload', no: '01', name: '准备故事', desc: '上传 1 个或多个小说文件，或粘贴正文；也可以让 AI 按一句话构想生成整本小说。', icon: 'M8 34h32v10H8z M14 34V16l10-6 10 6v18 M20 24h8' },
  { id: 'episodes', no: '02', name: '分集拆解', desc: '按章节 / 字数 / 场景段落自动划分剧集，系统把每一章关联到对应剧集。', icon: 'M8 14h14v10H8z M26 14h14v10H26z M8 30h14v10H8z M26 30h14v10H26z' },
  { id: 'script', no: '03', name: '剧本创作', desc: '逐集生成统一格式剧本：场景、人物、对白与情绪节拍，随时可重生成。', icon: 'M10 10h28v28H10z M15 18h18 M15 24h18 M15 30h12' },
  { id: 'context', no: '04', name: '角色与上下文', desc: '大模型自动提取角色；可手动修改人设，并一键生成全部角色定妆图。', icon: 'M24 23a7 7 0 100-14 7 7 0 000 14z M10 40c0-8 6-12 14-12s14 4 14 12' },
  { id: 'storyboard', no: '05', name: '分镜与画面', desc: '每一段生成一张 3×3 宫格分镜图，并在无限画布里查看资源链接关系。', icon: 'M8 8h32v32H8z M8 19h32 M8 30h32 M19 8v32 M30 8v32' },
  { id: 'deliver', no: '06', name: '导出与生成', desc: '每集单独导出导演包，或直接调用本地 ComfyUI 生成这一集的视频片段。', icon: 'M24 8v22 M16 22l8 8 8-8 M10 38h28' },
];

const ICON = (path) => `<svg viewBox="0 0 48 48" width="42" height="42" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;

const COVER_COLORS = ['#ff8a4c', '#8b9bff', '#34d399', '#fbbf24', '#f472b6', '#38bdf8'];
function coverHTML(p) {
  const url = p.cover?.url;
  if (url && p.cover?.source !== 'name') return `<img src="${esc(url)}" alt="">`;
  const name = String(p.name || '?');
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const c = COVER_COLORS[h % COVER_COLORS.length];
  return `<div class="hv-cover-name" style="--cv:${c}"><span>${esc(name.slice(0, 1))}</span></div>`;
}

function statusOf(p) {
  if (p.archived) return { text: '已归档', cls: 'muted' };
  if (p.status === 'done') return { text: '全部完成', cls: 'ok' };
  if (p.status === 'running') return { text: '执行中', cls: 'run' };
  if (p.status === 'error') return { text: '有失败步骤', cls: 'err' };
  if (p.kind === 'standard') return { text: '标准流水线', cls: 'muted' };
  return { text: '创作中', cls: '' };
}

const local = { q: '', filter: 'all', sort: 'updated' };

function visible(projects) {
  const q = local.q.trim().toLowerCase();
  let list = projects.filter((p) => {
    if (local.filter === 'favorite' && !p.favorite) return false;
    if (local.filter === 'active' && (p.archived || p.status === 'done')) return false;
    if (local.filter === 'done' && p.status !== 'done') return false;
    if (local.filter === 'novel' && p.kind !== 'novel') return false;
    if (q && !`${p.name} ${(p.tags || []).join(' ')}`.toLowerCase().includes(q)) return false;
    return true;
  });
  if (local.sort === 'name') list = list.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  else if (local.sort === 'progress') list = list.slice().sort((a, b) => (b.progress || 0) - (a.progress || 0));
  else list = list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return list;
}

function projectCardHTML(p, currentId) {
  const st = statusOf(p);
  const pct = Number(p.progress) || 0;
  const active = p.id === currentId;
  return `<article class="hv-card ${active ? 'active' : ''}" data-id="${esc(p.id)}">
    <div class="hv-card-cover">${coverHTML(p)}
      ${p.favorite ? '<span class="hv-fav" title="已收藏">★</span>' : ''}
      <span class="hv-card-kind">${p.kind === 'novel' ? '漫剧创作' : '流水线'}</span>
    </div>
    <div class="hv-card-body">
      <div class="hv-card-top"><strong title="${esc(p.name)}">${esc(p.name)}</strong><span class="hv-status ${st.cls}">${st.text}</span></div>
      <div class="hv-card-meta">${p.kind === 'novel' ? `${p.episodeCount || 0} 集 · 六步 ${p.stepDone || 0}/${p.stepTotal || 6}` : `${p.nodeCount || 0} 节点`} · ${p.doneCount || 0} 个节点完成</div>
      <div class="hv-bar"><i style="width:${pct}%"></i></div>
      <div class="hv-card-foot">
        <button class="btn sm primary" data-op="open" data-id="${esc(p.id)}">${active ? '继续创作' : '打开项目'} →</button>
        <span class="hv-date">${p.updatedAt ? new Date(p.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''}</span>
      </div>
      <div class="hv-card-ops">
        <button class="mini-btn" data-op="duplicate" data-id="${esc(p.id)}" title="复制项目">⧉ 复制</button>
        <button class="mini-btn" data-op="export" data-id="${esc(p.id)}" title="导出项目 JSON">⇩ 导出</button>
        <button class="mini-btn danger-mini" data-op="delete" data-id="${esc(p.id)}" title="删除项目">✕ 删除</button>
      </div>
    </div>
  </article>`;
}

function flowHTML() {
  return `<section class="hv-flow">
    <div class="hv-flow-head">
      <div><h2>从小说到成片 · 六步走完一部漫剧</h2>
        <p>按顺序点击任意步骤即可直达对应操作台；每一步的产物都会自动流向下一步。</p></div>
      <span class="hv-flow-badge">新手引导</span>
    </div>
    <div class="hv-flow-grid">${GUIDE.map((g) => `
      <button class="hv-step" data-guide="${g.id}">
        <span class="hv-step-no">${g.no}</span>
        <span class="hv-step-ico">${ICON(g.icon)}</span>
        <strong>${g.name}</strong>
        <small>${g.desc}</small>
        <span class="hv-step-go">进入这一步 →</span>
      </button>`).join('')}</div>
    <div class="hv-flow-foot"><span>① 导入</span><i></i><span>② 拆分</span><i></i><span>③ 剧本</span><i></i><span>④ 角色</span><i></i><span>⑤ 分镜</span><i></i><span>⑥ 交付</span></div>
  </section>`;
}

function configStripHTML(settings, comfy) {
  const llmOk = llmReady(settings);
  const videoOk = Boolean(comfy?.videoWorkflow);
  const imageOk = Boolean(comfy?.imageWorkflow);
  // 音色抽卡工作流是可选项：没有它预设音色照样能分配、能试听，所以不计入「未就绪」
  const audioOk = Boolean(comfy?.audioWorkflow);
  const allOk = llmOk && videoOk && imageOk;
  const label = llmOk ? llmReadyLabel(settings) : null;
  return `<div class="hv-config ${allOk ? 'ok' : 'warn'}">
    <span class="hv-config-ico">${allOk ? '✓' : '⚠'}</span>
    <div class="hv-config-text"><strong>${allOk ? '模型已就绪' : '模型尚未配置完整'}</strong>
      <small>${allOk
      ? `文本模型 ${esc(label.name)} · 本地 ComfyUI 出图与视频工作流均已导入${audioOk ? ' · 音色抽卡已就绪' : ' · 音色抽卡未配置（可选）'}`
      : `文本大模型${llmOk ? '已配置' : '未配置（用内置模板）'} · ComfyUI 出图${imageOk ? '已导入' : '未导入'} / 视频${videoOk ? '已导入' : '未导入'} · 音色抽卡${audioOk ? '已导入' : '未导入'}（可选） · 不配置也能完整体验流程`}</small></div>
    <button class="btn sm" data-act="settings">⚙ ${allOk ? '查看模型设置' : '去配置模型'}</button>
  </div>`;
}

/**
 * @param {HTMLElement} host #home-view
 * @param {Object} ctx {projects, stats, steps, settings, comfy, recentId, currentId, toast,
 *   onOpen, onCreate, onImport, onSettings, onGuide, onDuplicate, onDelete, onExport, onRefresh}
 */
export function renderHomeView(host, ctx = {}) {
  if (!host) return;
  const projects = ctx.projects || [];
  const stats = ctx.stats || {};
  const recent = projects.find((p) => p.id === ctx.recentId) || projects[0] || null;
  const list = visible(projects);
  host.innerHTML = `<div class="hv">
    <section class="hv-hero">
      <div class="hv-hero-main">
        <span class="hv-eyebrow">◈ 无限画布 · 智能体制片流水线</span>
        <h1>把一部小说，做成一整部漫剧</h1>
        <p>导入原著 → 自动分集 → 提取角色 → 生成剧本与宫格分镜 → 每集导出导演包或调用本地 ComfyUI 生成视频。</p>
        <div class="hv-hero-acts">
          <button class="btn primary" data-act="create">＋ 新建漫剧项目</button>
          ${recent ? `<button class="btn" data-act="resume" data-id="${esc(recent.id)}">↩ 继续「${esc(cut(recent.name, 12))}」</button>` : ''}
          <button class="btn" data-act="import">⇧ 导入项目 JSON</button>
        </div>
      </div>
      <div class="hv-hero-stats">
        <div><b>${stats.total ?? projects.length}</b><span>个项目</span></div>
        <div><b>${stats.active ?? projects.filter((p) => !p.archived).length}</b><span>进行中</span></div>
        <div><b>${stats.done ?? 0}</b><span>已完成</span></div>
        <div><b>${stats.total ? Math.round(((stats.done || 0) / stats.total) * 100) : 0}%</b><span>完成率</span></div>
      </div>
    </section>
    ${configStripHTML(ctx.settings, ctx.comfy)}
    ${flowHTML()}
    <section class="hv-projects">
      <div class="hv-sec-head"><div><h2>我的项目</h2><span>共 ${projects.length} 个 · 显示 ${list.length} 个</span></div>
        <button class="btn sm primary" data-act="create">＋ 新建</button></div>
      <div class="hv-toolbar">
        <input id="hv-search" type="search" placeholder="搜索项目名或标签…" value="${esc(local.q)}">
        <div class="hv-chips">${[['all', '全部'], ['active', '进行中'], ['done', '已完成'], ['favorite', '收藏'], ['novel', '漫剧创作']].map(([k, label]) => `<button class="hv-chip ${local.filter === k ? 'active' : ''}" data-filter="${k}">${label}</button>`).join('')}</div>
        <select id="hv-sort" title="排序"><option value="updated" ${local.sort === 'updated' ? 'selected' : ''}>最近更新</option><option value="name" ${local.sort === 'name' ? 'selected' : ''}>名称</option><option value="progress" ${local.sort === 'progress' ? 'selected' : ''}>进度</option></select>
        <button class="btn sm" data-act="refresh" title="刷新项目列表">↻</button>
      </div>
      ${list.length
    ? `<div class="hv-grid">${list.map((p) => projectCardHTML(p, ctx.currentId)).join('')}</div>`
    : `<div class="hv-empty"><div class="hv-empty-ico">◈</div><h3>${projects.length ? '没有符合条件的项目' : '还没有项目'}</h3><p>${projects.length ? '换个关键词或筛选条件试试。' : '点「新建漫剧项目」，只需填一个名字就能开始。'}</p><button class="btn primary" data-act="create">＋ 新建漫剧项目</button></div>`}
    </section>
  </div>`;

  const q = (sel) => host.querySelector(sel);
  q('#hv-search')?.addEventListener('input', (e) => {
    local.q = e.target.value;
    const pos = e.target.selectionStart;
    renderHomeView(host, ctx);
    const next = host.querySelector('#hv-search');
    if (next) { next.focus(); next.setSelectionRange(pos, pos); }
  });
  q('#hv-sort')?.addEventListener('change', (e) => { local.sort = e.target.value; renderHomeView(host, ctx); });
  host.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { local.filter = b.dataset.filter; renderHomeView(host, ctx); }));
  host.querySelectorAll('[data-guide]').forEach((b) => b.addEventListener('click', () => ctx.onGuide?.(b.dataset.guide)));
  host.querySelectorAll('[data-op]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const op = b.dataset.op, id = b.dataset.id;
    if (op === 'open') ctx.onOpen?.(id);
    if (op === 'duplicate') ctx.onDuplicate?.(id);
    if (op === 'export') ctx.onExport?.(id);
    if (op === 'delete') ctx.onDelete?.(id);
  }));
  host.querySelectorAll('.hv-card').forEach((el) => el.addEventListener('dblclick', () => ctx.onOpen?.(el.dataset.id)));
  host.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
    const act = b.dataset.act;
    if (act === 'create') ctx.onCreate?.();
    if (act === 'import') ctx.onImport?.();
    if (act === 'settings') ctx.onSettings?.();
    if (act === 'refresh') ctx.onRefresh?.();
    if (act === 'resume') ctx.onOpen?.(b.dataset.id);
  }));
}
