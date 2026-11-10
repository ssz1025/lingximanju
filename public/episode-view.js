/* ============================================================================
 * 剧集详情页：从项目工作台 / 分集管理点进某一集后的完整视图。
 *
 * 六个标签页：原始拆分内容 · 剧本 · 本集角色 · 每段分镜板 · 资源无限画布 · 导出与生成
 * 所有动作都打到 /api/projects/:id/episodes/:no/*，成功后重新拉详情，状态自动联动。
 * ==========================================================================*/
import { mountEpisodeCanvas } from './episode-canvas.js';
import { ensureModelPicker, withModelId } from './model-picker.js';
import { ensureInterfacePicker, withInterfaceId } from './interface-picker.js';
import { storyboardDescription } from './project-options.js';
import { esc, cut } from './utils.js';
import * as PMODEL from './project-model.js';

const q = (host, sel) => host.querySelector(sel);

const TABS = [
  ['source', '▤ 拆分原文'], ['script', '✎ 本集剧本'], ['characters', '👤 出场角色'],
  ['grids', '▦ 分镜板'], ['graph', '⬡ 资源画布'], ['export', '⇩ 导出与生成'],
];

const ui = {
  host: null, ctx: null, projectId: null, no: null,
  tab: 'source', data: null, busy: '', msg: '', msgErr: false,
  charEdit: false, selected: [], lightbox: null,
  scriptEdit: false, scriptDraft: null,
};

async function get(path) {
  const r = await fetch(path);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}
async function post(path, body = {}, method = 'POST') {
  const r = await fetch(path, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

/* ------------------------------------------------------------------ 各标签页 */
function headerHTML(d) {
  const ep = d.episode;
  return `<header class="ev-head">
    <div class="ev-head-left">
      <button class="btn sm" data-act="back">← 返回工作台</button>
      <div class="ev-title"><span class="ev-no">${PMODEL.episodeLabelFull(PMODEL.seasonOf(ep), ep.no)}</span>
        <div><h1>${esc(ep.title)}</h1><small>${esc(d.project.name)} · ${(ep.chars || 0).toLocaleString()} 字 · ${(ep.chapters || []).length} 章 · ${(ep.segments || []).length} 段</small></div></div>
    </div>
    <div class="ev-head-right">
      <button class="btn sm primary" data-act="open-ep-canvas" title="打开这一集自己的无限画布">⬡ 本集画布</button>
      <button class="btn sm" data-act="prev" ${d.neighbors?.prev ? '' : 'disabled'}>← 上一集</button>
      <span class="ev-pager">${ep.no} / ${d.episodeCount}</span>
      <button class="btn sm" data-act="next" ${d.neighbors?.next ? '' : 'disabled'}>下一集 →</button>
    </div>
  </header>
  <div class="ev-chips">
    <span class="ev-chip ${ep.script ? 'ok' : ''}">剧本 ${ep.script ? `${(ep.script.stats?.sceneCount || (ep.script.scenes || []).length)} 场` : '未生成'}</span>
    <span class="ev-chip ${(ep.segments || []).some((s) => s.gridUrl) ? 'ok' : ''}">分镜板 ${(ep.segments || []).filter((s) => s.gridUrl).length}/${(ep.segments || []).length}</span>
    <span class="ev-chip ${(d.involvedCharacterIds || []).length ? 'ok' : ''}">角色 ${(d.involvedCharacterIds || []).length} 位</span>
    <span class="ev-chip ${ep.pack ? 'ok' : ''}">导演包 ${ep.pack ? '已导出' : '未导出'}</span>
    <span class="ev-chip ${ep.film ? 'ok' : ''}">成片 ${ep.film ? `${ep.film.duration}s` : '未拼接'}</span>
    <span class="ev-chip ${ep.video ? 'ok' : ''}">预览片段 ${ep.video ? '已生成' : '未生成'}</span>
  </div>`;
}

function sourceHTML(d) {
  const ep = d.episode;
  const chapters = d.chapters || [];
  return `<div class="ev-grid-two">
    <div class="ev-card ev-source">
      <div class="ev-card-head"><strong>📖 本集拆分原文</strong><span>${(ep.text || '').length} 字 · ${esc(ep.strategy || '自动拆分')}</span></div>
      <div class="ev-source-text">${esc(ep.text || '（本集暂无原文，请先在项目工作台上传或重新分集）')}</div>
      <div class="ev-card-foot"><button class="btn sm" data-act="copy-text">⧉ 复制原文</button>
        <span>摘要：${esc(cut(ep.summary, 70))}</span></div>
    </div>
    <div class="ev-card">
      <div class="ev-card-head"><strong>🔗 章节与来源</strong><span>${chapters.length} 章归属本集</span></div>
      ${chapters.length ? `<div class="ev-chapter-list">${chapters.map((c) => `<div class="ev-chapter">
          <span class="ev-ch-no">${c.no}</span><div><strong>${esc(c.title)}</strong><small>${esc(c.sourceName || '原著')} · ${c.chars} 字</small></div>
          <span class="ev-ch-badge">第 ${c.episodeNo} 集</span></div>`).join('')}</div>`
    : '<div class="ev-empty-inline">本项目创建时未记录章节（可能按段落 / 字数拆分）。重新上传小说后，章节会自动关联到对应剧集。</div>'}
      <div class="ev-card-head" style="margin-top:16px"><strong>📄 导入文件</strong><span>${(d.sources || []).length} 个</span></div>
      <div class="ev-source-list">${(d.sources || []).map((f) => `<div class="ev-source-row">📄 <strong>${esc(f.name)}</strong><small>${(f.chars || 0).toLocaleString()} 字 · ${(f.chapterTitles || []).length} 章</small></div>`).join('') || '<div class="ev-empty-inline">历史项目未记录文件出处 · 在项目工作台重新上传小说后会自动生成文件与章节关联</div>'}</div>
      <div class="ev-note">结尾钩子：${esc(ep.hook || '—')}</div>
    </div>
  </div>`;
}

const SCRIPT_SOURCE_LABEL = { llm: '大模型', mock: '内置模板', manual: '人工编辑', heuristic: '启发式' };

/** 时长：95 → 1′35″（与后端 screenplay.formatDuration 同口径） */
function fmtDur(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  return n < 60 ? `${n}″` : `${Math.floor(n / 60)}′${String(n % 60).padStart(2, '0')}″`;
}

/** 一行正文的类型：对白 / 动作画面 / 旁白音效 / 场次头 */
function lineKind(line) {
  const t = String(line || '').trim();
  if (/^【.*】$/.test(t)) return 'head';
  if (/^(动作|画面|镜头)[:：]/.test(t)) return 'act';
  if (/^(旁白|画外音|音效|声音)[:：]/.test(t)) return 'vo';
  if (/^[^：:\s【】]{1,12}\s*[：:]/.test(t)) return 'dlg';
  return '';
}

/** 场景的戏剧结构（v2 字段）：有就展示，没有就不占位 */
function sceneCraftHTML(s) {
  const rows = [
    ['目标', s.objective], ['冲突', s.conflict], ['转折', s.turn],
  ].filter(([, v]) => String(v || '').trim());
  const tags = [s.beat ? `节拍 · ${s.beat}` : '', s.keyProp ? `道具 · ${s.keyProp}` : '', s.transition ? `转场 · ${s.transition}` : ''].filter(Boolean);
  if (!rows.length && !tags.length) return '';
  return `${rows.length ? `<div class="ev-scene-craft">${rows.map(([k, v]) => `<span><b>${k}</b>${esc(v)}</span>`).join('')}</div>` : ''}
    ${tags.length ? `<div class="ev-scene-tags">${tags.map((t) => `<em>${esc(t)}</em>`).join('')}</div>` : ''}`;
}

/** 剧本统计（与后端 episode-script.mjs 同口径的轻量前端版，用于展示） */
function scriptStats(sc = {}) {
  const scenes = Array.isArray(sc.scenes) ? sc.scenes : [];
  let lines = 0;
  let dialogue = 0;
  let chars = 0;
  for (const s of scenes) {
    chars += String(s?.location || '').length + String(s?.time || '').length + String(s?.summary || '').length;
    for (const raw of (Array.isArray(s?.script) ? s.script : [])) {
      const line = String(raw || '').trim();
      if (!line) continue;
      lines += 1;
      chars += line.length;
      const m = line.match(/^([^：:\s【】]{1,12})(?:（[^）]*）|\([^)]*\))?\s*[：:]/);
      if (m && !/^(动作|画面|镜头|字幕|备注|场景|时间|地点|注|旁白|画外音|音效|声音)$/.test(m[1])) dialogue += 1;
    }
  }
  return { scenes: scenes.length, lines, dialogue, chars, characters: (sc.characters || []).length };
}

/** 从剧本编辑器读回草稿（SSE 刷新时保住用户正在改的内容） */
function readScriptDraft() {
  const root = ui.host?.querySelector('#ev-script-editor');
  if (!root) return null;
  const val = (sel) => root.querySelector(sel)?.value ?? '';
  return {
    title: val('[data-scr="title"]'),
    logline: val('[data-scr="logline"]'),
    scenes: [...root.querySelectorAll('[data-scr-scene]')].map((el) => ({
      id: el.dataset.scrScene || '',
      location: el.querySelector('[data-scr-loc]')?.value || '',
      time: el.querySelector('[data-scr-time]')?.value || '',
      summary: el.querySelector('[data-scr-sum]')?.value || '',
      script: String(el.querySelector('[data-scr-lines]')?.value || '').split('\n').map((s) => s.trim()).filter(Boolean),
    })),
  };
}

function scriptEditorHTML(sc) {
  return `<div class="ev-script-editor" id="ev-script-editor">
    <div class="ev-editor-tip">每行一句：对白写「角色：「台词」」，动作写「动作：…」。保存后来源标记为「人工编辑」，分镜 / 导演包读取最新版本。</div>
    <label class="ev-edit-wide">片名<input data-scr="title" value="${esc(sc.title || '')}"></label>
    <label class="ev-edit-wide">梗概<textarea data-scr="logline" rows="2">${esc(sc.logline || '')}</textarea></label>
    ${(sc.scenes || []).map((s, i) => `<section class="ev-edit-scene" data-scr-scene="${esc(s.id || `S${i + 1}`)}">
      <div class="ev-edit-row">
        <label>第 ${i + 1} 场 · 地点<input data-scr-loc value="${esc(s.location || '')}"></label>
        <label>时间<input data-scr-time value="${esc(s.time || '')}"></label>
      </div>
      <label class="ev-edit-wide">场次概述<textarea data-scr-sum rows="2">${esc(s.summary || '')}</textarea></label>
      ${(s.objective || s.conflict || s.turn || s.beat) ? `<div class="ev-edit-craft">
        ${[['目标', s.objective], ['冲突', s.conflict], ['转折', s.turn], ['节拍', s.beat]].filter(([, v]) => String(v || '').trim()).map(([k, v]) => `<span><b>${k}</b>${esc(v)}</span>`).join('')}
        <small>以上为剧本结构化字段，保存时原样保留（要改写请重新生成）</small></div>` : ''}
      <label class="ev-edit-wide">正文 / 对白<textarea data-scr-lines rows="6">${esc((s.script || []).join('\n'))}</textarea></label>
    </section>`).join('')}
    <div class="ev-edit-acts">
      <button class="btn primary" data-act="save-script">✓ 保存剧本</button>
      <button class="btn" data-act="cancel-script">取消</button>
      <span class="ev-note-inline">保存会重新统计场次 / 对白 / 字数</span>
    </div>
  </div>`;
}

function scriptHTML(d) {
  const ep = d.episode;
  const sc = ep.script;
  if (!sc) {
    const prev = d.neighbors?.prev;
    const next = d.neighbors?.next;
    return `<div class="ev-card ev-blank">
    <div class="ev-blank-ico">✎</div><h3>这一集还没有剧本</h3>
    <p>调用大模型把本集拆分原文写成统一格式剧本（场景 / 人物 / 对白）。生成时会带上上一集结尾与本集钩子，避免每集都像第一集。未配置模型时使用内置模板，内容仍取自本集原文与真实角色。</p>
    <div class="ev-blank-acts"><button class="btn primary" data-act="gen-script">✦ 生成本集剧本</button>
      <button class="btn" data-act="gen-all-scripts">✦ 生成全部缺失剧本</button></div>
    ${prev?.hasScript || next?.hasScript ? `<div class="ev-note">相邻集：${prev ? `第 ${prev.no} 集${prev.hasScript ? ' 已有剧本' : ' 无剧本'} · ` : ''}${next ? `第 ${next.no} 集${next.hasScript ? ' 已有剧本' : ' 无剧本'}` : ''}${next?.hasScript ? ' — 可先读下一集保持衔接' : ''}</div>` : ''}
    ${d.config?.llmConfigured ? '' : '<div class="ev-warn">⚠ 文本大模型未配置，将使用内置模板。<button class="btn sm" data-act="settings">去配置模型</button></div>'}
  </div>`;
  }
  const st = scriptStats(sc);
  const editing = ui.scriptEdit;
  const view = editing && ui.scriptDraft ? ui.scriptDraft : sc;
  const issues = Array.isArray(sc.issues) ? sc.issues : [];
  // 剧本层时长：优先用后端算好的 durationSec，老数据按场次时长求和
  const totalSec = Number(sc.durationSec) || (sc.scenes || []).reduce((n, s) => n + (Number(s.durationSec) || 0), 0);
  return `<div class="ev-card ev-script">
    <div class="ev-card-head"><strong>《${esc(sc.title)}》</strong>
      <span>${esc(sc.genre || '')} · 来源 ${SCRIPT_SOURCE_LABEL[sc.source] || sc.source || '—'}${sc.editedAt ? ' · 已人工编辑' : ''}
        <a class="btn sm" href="/api/projects/${esc(d.project.id)}/episodes/${ep.no}/script/export" download>⇩ 导出 .md</a>
        <button class="btn sm" data-act="${editing ? 'cancel-script' : 'edit-script'}">${editing ? '取消编辑' : '✎ 编辑'}</button>
        <button class="btn sm" data-act="gen-script">↻ 重新生成</button></span></div>
    <div class="ev-script-stats">
      <span><b>${st.scenes}</b>场</span><span><b>${st.lines}</b>行</span><span><b>${st.dialogue}</b>句对白</span>
      <span><b>${st.chars.toLocaleString()}</b>字</span><span><b>${st.characters}</b>角色</span>
      ${totalSec ? `<span><b>${fmtDur(totalSec)}</b>预估</span>` : ''}
      ${sc.continuity?.prevRecap ? `<span class="ev-script-cont">承接第 ${sc.continuity.prevNo || ep.no - 1} 集结尾</span>` : ''}
    </div>
    ${editing ? scriptEditorHTML(view) : `<p class="ev-logline">${esc(sc.logline || '')}</p>
      ${(sc.characters || []).length ? `<div class="ev-script-chars">角色：${sc.characters.map((c) => esc(c.name) + (c.role ? `（${esc(c.role)}）` : '')).join('、')}</div>` : ''}
      ${issues.length ? `<div class="ev-script-issues">${issues.slice(0, 6).map((x) => `<span class="${x.level}">${x.level === 'error' ? '✕' : x.level === 'warn' ? '⚠' : 'ⓘ'} ${esc(x.message)}</span>`).join('')}</div>` : ''}
      <div class="ev-scenes">${(sc.scenes || []).map((s, i) => {
        const interior = /^(内景|外景|内外景)$/.test(String(s.interior || '')) ? s.interior : '';
        const head = [interior, s.location || '未指定场景'].filter(Boolean).join(' · ');
        const dur = Number(s.durationSec) || 0;
        return `<div class="ev-scene">
        <div class="ev-scene-head"><span>${String(i + 1).padStart(2, '0')}</span><strong>${esc(head)}</strong>
          <small>${esc([s.time, dur ? fmtDur(dur) : '', (s.characters || []).length ? (s.characters || []).join('、') : ''].filter(Boolean).join(' · '))}</small></div>
        <p>${esc(s.summary || '')}</p>
        ${sceneCraftHTML(s)}
        ${(s.script || []).map((line) => `<div class="ev-line ${lineKind(line)}">${esc(line)}</div>`).join('')}
      </div>`;
      }).join('')}</div>`}
  </div>`;
}

/** 剧本区的模型下拉（空态与重新生成两处都可能挂；库为空 / 已挂过则跳过） */
function mountScriptPicker(host) {
  const blank = host.querySelector('.ev-blank-acts');
  if (blank && !blank.querySelector('[data-model-pick]')) {
    ensureModelPicker('episode', blank, blank.firstElementChild);
    return;
  }
  const head = host.querySelector('.ev-card-head span');
  if (head && !head.querySelector('[data-model-pick]')) ensureModelPicker('episode', head, head.firstElementChild);
}

function charactersHTML(d) {
  const all = d.characters || [];
  const ids = d.involvedCharacterIds || [];
  const picked = all.filter((c) => ids.includes(c.id));
  return `<div class="ev-card">
    <div class="ev-card-head"><strong>👤 本集出场角色</strong><span>${picked.length} 位 · 按姓名 / 别名在本集原文中自动识别</span></div>
    <div class="ev-card-acts">
      <button class="btn sm" data-act="redetect-chars">↻ 重新识别</button>
      <button class="btn sm" data-act="toggle-char-edit">${ui.charEdit ? '✓ 完成关联' : '✎ 手动关联角色'}</button>
      <button class="btn sm" data-act="open-char-manager">▦ 打开角色管理</button>
    </div>
    ${ui.charEdit ? `<div class="ev-char-picker">${all.length ? all.map((c) => `<label class="ev-char-check">
        <input type="checkbox" data-char="${esc(c.id)}" ${ids.includes(c.id) ? 'checked' : ''}>
        <span><strong>${esc(c.name)}</strong><small>${esc(c.role || '未设定')}</small></span></label>`).join('') : '<div class="ev-empty-inline">项目还没有角色，先到角色管理里提取。</div>'}
      </div><button class="btn primary sm" data-act="save-chars">保存本集角色关联</button>`
    : (picked.length ? `<div class="ev-char-grid">${picked.map((c) => `<div class="ev-char-card">
        <div class="ev-char-portrait">${c.views?.front?.url ? `<img src="${esc(c.views.front.url)}" alt="">` : '<span>◈</span>'}</div>
        <div><strong>${esc(c.name)}</strong><small>${esc(c.role || '未设定角色')}</small>
          <p>${esc(cut(c.appearance || c.personality || '暂无外貌描述', 60))}</p>
          <span class="ev-char-tag">${{ llm: 'LLM 提取', heuristic: '启发式', manual: '手动新增' }[c.source] || '手动'}</span></div>
      </div>`).join('')}</div>`
    : '<div class="ev-empty-inline">本集原文里未识别到已登记的角色。可从原著提取角色，或点「手动关联角色」指定。</div>')}
    <div class="ev-note">角色信息与定妆图在项目级「角色管理」里统一维护；这里只决定本集出场名单，导演包会带上这些角色作为一致性参考图。</div>
  </div>`;
}

function gridsHTML(d) {
  const ep = d.episode;
  const segs = ep.segments || [];
  const done = segs.filter((s) => s.gridUrl).length;
  const sb = d.project?.management?.storyboard || {};
  const desc = storyboardDescription(sb, d.project?.settings?.aspect || '16:9');
  const cells = Number(sb.cells) || 9;
  return `<div class="ev-card">
    <div class="ev-card-head"><strong>▦ 每段一张分镜板</strong><span>${done}/${segs.length} 张已生成 · ${esc(desc)}</span></div>
    <div class="ev-card-acts">
      <button class="btn primary sm" data-act="gen-grids">✦ 一键生成本集全部分镜板</button>
      <span class="ev-note-inline">${d.config?.keyframes ? `画布已有 ${d.config.keyframes} 张关键帧，将按序复用为真实画面` : '未接入真实关键帧时按设置画示意占位 / 待出图，接入 ComfyUI 后可替换'} · 版式在⑤步「分镜画面设置」里改</span>
    </div>
    ${segs.length ? `<div class="ev-grids">${segs.map((s) => `<div class="ev-grid-item">
      <div class="ev-grid-head"><strong>${esc(s.title)}</strong><span>${s.chars} 字 · ${s.gridCells || cells} 格</span>
        <div><button class="btn sm" data-act="gen-grid-one" data-seg="${s.no}">${s.gridUrl ? '↻ 重排' : '✦ 生成'}</button>
        <button class="btn sm" data-act="gen-grid-comfy" data-seg="${s.no}" title="调用本地 ComfyUI 逐格出图（较慢）">⚙ ComfyUI</button></div></div>
      ${s.gridUrl ? `<img class="ev-grid-img" src="${esc(s.gridUrl)}" alt="${esc(s.title)}" data-grid="${s.no}">`
    : `<div class="ev-grid-placeholder"><span>▦</span><small>尚未生成分镜板</small></div>`}
      <p class="ev-grid-text">${esc(cut(s.text, 110))}</p>
      <div class="ev-cells">${(s.cells || []).map((c) => `<button class="ev-cell" data-cell="${s.no}:${c.no}" title="${esc(c.caption)}"><b>${c.no}</b><span>${esc(c.caption)}</span></button>`).join('')}</div>
    </div>`).join('')}</div>`
    : '<div class="ev-empty-inline">本集没有分段，请先在项目工作台重新上传 / 重新分集。</div>'}
  </div>`;
}

function graphHTML(d) {
  return `<div class="ev-card ev-graph-card">
    <div class="ev-card-head"><strong>⬡ 资源链接无限画布</strong><span>章节 → 本集 → 段落 → 分镜板 / 角色 / 剧本 / 产物 / 项目画布</span></div>
    <div id="ev-graph" class="ev-graph"></div>
    <div class="ev-note">节点可拖动重排，滚轮缩放，空白处拖拽平移；点击节点查看资源详情，画布节点可一键回项目画布定位。</div>
  </div>`;
}

/** 本集「可出视频的格」统计：真实首帧图（.svg 占位不算）与已有 ComfyUI 片段 */
function filmTally(ep) {
  let frames = 0;
  let videos = 0;
  for (const seg of (ep.segments || [])) {
    for (const c of (seg.cells || [])) {
      if (c.url && !/\.svg(\?|$)/i.test(String(c.url))) frames += 1;
      if (c.video?.provider === 'comfyui' && c.video?.file) videos += 1;
    }
  }
  return { frames, videos };
}

function exportHTML(d) {
  const ep = d.episode;
  const cfg = d.config || {};
  const tally = filmTally(ep);
  const film = ep.film && ep.film.file ? ep.film : null;
  return `<div class="ev-export-grid">
    <div class="ev-card ev-export-card ev-film-card">
      <div class="ev-export-ico">🎬</div><h3>本集成片（分集制作 · 逐格出视频）</h3>
      <p>以本集分镜格为镜头单元：每格用首帧图 + 精确图生视频提示词提交本地 ComfyUI，片段按段序拼接成这一集自己的成片 MP4，再打包单集导演包。</p>
      <div class="ev-export-status ${film ? 'ok' : cfg.comfyVideo ? 'warn' : 'warn'}">${film
    ? `✓ 成片已生成 · ${film.duration}s · ${film.clips} 段 · ${film.width}×${film.height} · ${(film.bytes / 1048576).toFixed(1)} MB`
    : `片段 ${tally.videos}/${tally.frames} 格已生成（可出视频 ${tally.frames} 格）${cfg.comfyVideo ? '' : ' · ⚠ 视频工作流未就绪'}`}</div>
      <div class="ev-export-acts">
        <button class="btn primary" data-act="gen-cell-videos" ${cfg.comfyVideo && tally.frames ? '' : 'disabled'} title="逐格提交 ComfyUI 视频工作流，已有片段自动跳过">▶ ${tally.videos ? '补齐缺失片段' : '逐格生成视频'}</button>
        <button class="btn" data-act="stitch-film" ${tally.videos ? '' : 'disabled'}>⊞ 拼接本集成片</button>
        <button class="btn" data-act="run-ep-deliver" ${cfg.comfyVideo ? '' : 'disabled'} title="一键执行本集「视频与交付」：逐格视频 → 成片 → 导演包">⚡ 一键交付本集</button>
        <button class="btn" data-act="settings">⚙ 模型与工作流设置</button>
      </div>
      ${film ? `<div class="ev-video-box"><video src="${esc(film.url)}" controls preload="metadata"></video>
        <div><strong>第 ${ep.no} 集成片</strong><small>${esc(film.method || '')} · ${new Date(film.at).toLocaleString('zh-CN')}</small>
        <a class="btn sm" href="/api/projects/${esc(d.project.id)}/episodes/${ep.no}/film">⇩ 下载 MP4</a></div></div>`
    : '<div class="ev-empty-inline">还没有本集成片。逐格生成片段后点「拼接本集成片」；耗时取决于本地 GPU 与格数，期间请勿关闭本页。</div>'}
    </div>
    <div class="ev-card ev-export-card">
      <div class="ev-export-ico">▤</div><h3>导出本集导演包</h3>
      <p>只包含第 ${ep.no} 集：${(ep.segments || []).length} 张分镜板、本集原文与剧本、出场角色参考图、时间线。可在 ComfyUI 导演工作台「Import pack」直接导入。</p>
      <div class="ev-export-status ${ep.pack ? 'ok' : ''}">${ep.pack ? `✓ 已生成 · ${(ep.pack.bytes / 1024).toFixed(0)} KB · ${new Date(ep.pack.at).toLocaleString('zh-CN')}` : '尚未导出'}</div>
      <div class="ev-export-acts"><button class="btn primary" data-act="gen-pack">▤ ${ep.pack ? '重新生成并下载' : '生成并下载导演包'}</button>
        ${ep.pack ? `<a class="btn" href="/api/projects/${esc(d.project.id)}/episodes/${ep.no}/director-pack">⇩ 仅下载</a>` : ''}</div>
    </div>
    <div class="ev-card ev-export-card">
      <div class="ev-export-ico">▶</div><h3>快速预览片段（单段）</h3>
      <p>以本集第一张分镜板为首帧、集摘要为运动提示词，生成一段 3–10 秒的预览视频。要看完整成片请用上方「本集成片」。</p>
      <div class="ev-export-status ${cfg.comfyVideo ? 'ok' : 'warn'}">${cfg.comfyVideo
    ? `✓ 视频工作流已就绪 · ${esc(cfg.comfyBaseUrl || '')}`
    : '⚠ 尚未导入视频工作流，去设置里导入「导出(API)」格式的工作流 JSON'}</div>
      <div class="ev-export-acts"><button class="btn primary" data-act="gen-video">▶ 调用本地 ComfyUI 生成</button></div>
      ${ep.video ? `<div class="ev-video-box"><video src="${esc(ep.video.url)}" controls preload="metadata"></video>
        <div><strong>第 ${ep.no} 集预览片段</strong><small>${esc(ep.video.provider || '')} · ${new Date(ep.video.at).toLocaleString('zh-CN')}</small>
        <a class="btn sm" href="/api/projects/${esc(d.project.id)}/episodes/${ep.no}/video">⇩ 下载 MP4</a></div></div>`
    : '<div class="ev-empty-inline">还没有预览片段。</div>'}
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ 主渲染 */
function paint() {
  const host = ui.host, ctx = ui.ctx, d = ui.data;
  if (!host || !d) return;
  // SSE 静默刷新 / 切标签前，把正在编辑的剧本草稿收进 ui，避免重绘吃掉输入
  if (ui.scriptEdit) {
    const draft = readScriptDraft();
    if (draft) ui.scriptDraft = draft;
  }
  const tab = ui.tab;
  let body = '';
  if (tab === 'source') body = sourceHTML(d);
  else if (tab === 'script') body = scriptHTML(d);
  else if (tab === 'characters') body = charactersHTML(d);
  else if (tab === 'grids') body = gridsHTML(d);
  else if (tab === 'graph') body = graphHTML(d);
  else body = exportHTML(d);

  host.innerHTML = `<div class="ev">
    ${headerHTML(d)}
    <nav class="ev-tabs">${TABS.map(([k, label]) => `<button class="ev-tab ${tab === k ? 'active' : ''}" data-tab="${k}">${label}</button>`).join('')}</nav>
    ${ui.busy ? `<div class="ev-busy"><span class="ev-spinner"></span>${esc(ui.busy)}</div>` : ''}
    ${ui.msg ? `<div class="ev-msg ${ui.msgErr ? 'err' : 'ok'}">${esc(ui.msg)}</div>` : ''}
    <div class="cf-row ev-iface-bar" id="ev-iface-bar"></div>
    <div class="ev-body">${body}</div>
  </div>`;

  bind(d, ctx);
  if (tab === 'graph') {
    mountEpisodeCanvas(q(host, '#ev-graph'), d.graph, {
      onOpenNodeInCanvas: (nodeId) => ctx.onLocateCanvasNode?.(nodeId),
    });
  }
}

function bind(d, ctx) {
  const host = ui.host;
  const ep = d.episode;
  const base = `/api/projects/${d.project.id}/episodes/${ep.no}`;
  const toast = ctx.toast || (() => {});

  // 本次使用的 ComfyUI 接口：分镜出图 / 视频生成按板块临时覆盖（同类档案少于 2 份时不出现）
  const ifaceBar = host.querySelector('#ev-iface-bar');
  if (ifaceBar) {
    if (ui.tab === 'grids') ensureInterfacePicker('grid', ifaceBar);
    if (ui.tab === 'export') {
      ensureInterfacePicker('video', ifaceBar);
      ensureInterfacePicker('grid', ifaceBar);
    }
  }

  host.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { ui.tab = b.dataset.tab; ui.charEdit = false; paint(); }));
  if (ui.tab === 'script') mountScriptPicker(host);
  const nav = {
    back: () => ctx.onBack?.(),
    prev: () => d.neighbors?.prev && ctx.onNavigate?.(d.neighbors.prev.no),
    next: () => d.neighbors?.next && ctx.onNavigate?.(d.neighbors.next.no),
    settings: () => ctx.onSettings?.(),
    'open-ep-canvas': () => ctx.onOpenEpisodeCanvas?.(ep.no),
    'open-overall-canvas': () => ctx.onOpenOverallCanvas?.(),
    'open-char-manager': () => ctx.onManageCharacters?.(),
  };
  host.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
    const act = b.dataset.act;
    if (nav[act]) return nav[act]();

    if (act === 'copy-text') {
      try { await navigator.clipboard.writeText(ep.text || ''); toast('本集原文已复制', 'ok'); }
      catch { toast('复制失败，请手动选中文本', 'err'); }
      return;
    }
    if (act === 'toggle-char-edit') { ui.charEdit = !ui.charEdit; paint(); return; }
    if (act === 'edit-script') {
      ui.scriptEdit = true;
      ui.scriptDraft = ep.script ? JSON.parse(JSON.stringify(ep.script)) : null;
      paint();
      return;
    }
    if (act === 'cancel-script') { ui.scriptEdit = false; ui.scriptDraft = null; paint(); return; }
    if (act === 'save-script') {
      const payload = readScriptDraft();
      if (!payload) return;
      b.disabled = true;
      b.textContent = '保存中…';
      try {
        const out = await post(`${base}/script`, { script: payload }, 'PUT');
        ui.scriptEdit = false;
        ui.scriptDraft = null;
        ui.msg = out.message || '剧本已保存';
        ui.msgErr = false;
        toast(ui.msg, 'ok');
        await load(true);
      } catch (err) {
        b.disabled = false;
        b.textContent = '✓ 保存剧本';
        ui.msg = err.message;
        ui.msgErr = true;
        toast(err.message, 'err');
      }
      return;
    }
    if (act === 'save-chars') {
      const ids = [...host.querySelectorAll('[data-char]:checked')].map((el) => el.dataset.char);
      await run(() => post(`${base}/characters`, { characterIds: ids }), '保存角色关联…');
      ui.charEdit = false;
      return;
    }
    if (act === 'gen-grid-comfy' && !d.config?.comfyImage) {
      toast('尚未导入本地 ComfyUI 出图工作流，请先在设置里导入', 'err');
      return;
    }

    const calls = {
      'gen-script': [() => post(`${base}/script`, withModelId('episode', {})), '正在生成本集剧本…'],
      'gen-all-scripts': [() => post(`/api/projects/${d.project.id}/episodes/scripts`, withModelId('episode', { onlyMissing: true })), '正在补齐缺失剧集剧本…'],
      'redetect-chars': [() => post(`${base}/characters`, {}), '正在重新识别本集角色…'],
      'gen-grids': [() => post(`${base}/grids`, withInterfaceId('grid', {})), '正在生成分镜板…'],
      'gen-grid-one': [() => post(`${base}/grids`, withInterfaceId('grid', { segmentNo: Number(b.dataset.seg) })), '正在生成该段分镜板…'],
      'gen-grid-comfy': [() => post(`${base}/grids`, withInterfaceId('grid', { segmentNo: Number(b.dataset.seg), mode: 'comfy' })), '正在调用 ComfyUI 逐格出图（可能数分钟）…'],
      'gen-pack': [() => post(`${base}/director-pack`, {}), '正在打包本集导演包…'],
      'gen-video': [() => post(`${base}/video`, withInterfaceId('video', {})), '正在提交本地 ComfyUI 视频工作流，可能需要数分钟…'],
      'gen-cell-videos': [() => post(`${base}/step`, withInterfaceId('video', { stepId: 'deliver', force: false })), '正在逐格生成视频片段（已有片段自动跳过），可能需要较长时间…'],
      'stitch-film': [() => post(`${base}/step`, withInterfaceId('video', { stepId: 'deliver', force: false, stitchOnly: true })), '正在拼接本集成片…'],
      'run-ep-deliver': [() => post(`${base}/step`, withInterfaceId('video', { stepId: 'deliver', force: false })), '正在执行本集「视频与交付」…'],
    };
    const hit = calls[act];
    if (!hit) return;
    b.disabled = true;
    const out = await run(hit[0], hit[1]);
    b.disabled = false;
    if (act === 'gen-pack' && out?.ok) {
      window.location.href = `${base}/director-pack`;
    }
  }));

  // 分镜板：点击整张图或单个格子放大查看
  host.querySelectorAll('[data-grid], [data-cell]').forEach((el) => el.addEventListener('click', () => {
    const segNo = Number(el.dataset.grid || String(el.dataset.cell || '').split(':')[0]);
    const cellNo = el.dataset.cell ? Number(String(el.dataset.cell).split(':')[1]) : 0;
    const seg = (ep.segments || []).find((s) => Number(s.no) === segNo);
    if (!seg) return;
    const cell = cellNo ? (seg.cells || [])[cellNo - 1] : null;
    ui.lightbox = { url: seg.gridUrl, title: `${seg.title}${cell ? ` · 第 ${cell.no} 格` : ''}`, caption: cell?.caption || seg.text.slice(0, 160) };
    showLightbox();
  }));
}

function showLightbox() {
  const box = ui.lightbox;
  if (!box || !ui.host) return;
  let wrap = document.getElementById('ev-lightbox');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'ev-lightbox';
    wrap.className = 'ev-lightbox';
    document.body.appendChild(wrap);
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-lb-close]')) wrap.hidden = true; });
  }
  wrap.hidden = false;
  wrap.innerHTML = `<div class="ev-lb-inner"><div class="ev-lb-head"><strong>${esc(box.title)}</strong><button class="icon-btn" data-lb-close>✕</button></div>
    ${box.url ? `<img src="${esc(box.url)}" alt="">` : '<div class="ev-lb-empty">这一段还没有分镜板</div>'}
    <p>${esc(box.caption || '')}</p></div>`;
}

async function run(fn, busyText) {
  ui.busy = busyText;
  ui.msg = '';
  paint();
  try {
    const out = await fn();
    ui.msg = out?.message || '操作完成';
    ui.msgErr = false;
    ui.ctx?.toast?.(ui.msg, 'ok');
    await load(true);
    return out;
  } catch (err) {
    ui.busy = '';
    ui.msg = err.message;
    ui.msgErr = true;
    ui.ctx?.toast?.(err.message, 'err');
    paint();
    return null;
  }
}

async function load(force = false) {
  if (!ui.ctx || !ui.projectId || !ui.no) return;
  if (!force && ui.data) { paint(); return; }
  try {
    ui.data = await get(`/api/projects/${ui.projectId}/episodes/${ui.no}`);
    ui.busy = '';
    paint();
  } catch (err) {
    ui.busy = '';
    ui.msg = `加载剧集失败：${err.message}`;
    ui.msgErr = true;
    if (ui.host) ui.host.innerHTML = `<div class="ev-load-error"><h3>${esc(err.message)}</h3>
      <button class="btn" id="ev-retry">↻ 重试</button> <button class="btn" id="ev-back">← 返回工作台</button></div>`;
    ui.host?.querySelector('#ev-retry')?.addEventListener('click', () => load(true));
    ui.host?.querySelector('#ev-back')?.addEventListener('click', () => ui.ctx?.onBack?.());
  }
}

/**
 * @param {HTMLElement} host #episode-view
 * @param {Object} ctx {projectId, no, toast, onBack, onNavigate, onSettings,
 *   onManageCharacters, onLocateCanvasNode, onOpenEpisodeCanvas, onOpenOverallCanvas}
 * @param {boolean} force 强制重新拉取（SSE 状态变更时用）
 */
export async function renderEpisodeView(host, ctx = {}, force = false) {
  if (!host) return;
  const changed = ui.projectId !== ctx.projectId || ui.no !== Number(ctx.no);
  ui.host = host;
  ui.ctx = ctx;
  ui.projectId = ctx.projectId;
  ui.no = Number(ctx.no);
  if (changed) { ui.tab = 'source'; ui.charEdit = false; ui.msg = ''; ui.data = null; ui.scriptEdit = false; ui.scriptDraft = null; }
  await load(force || changed || !ui.data);
}

/** SSE `episode:update` 到达时由 app.js 调用：静默刷新，不打断当前标签页 */
export function refreshEpisodeView() {
  if (!ui.host || !ui.data) return;
  load(true);
}
