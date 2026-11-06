// 节点类型注册表与 DOM 渲染（画布与检查器共用）
export const NODE_TYPES = {
  idea:       { label: '创意输入', icon: '✦', color: '#a78bfa', agent: 'screenwriter', group: '输入', fields: [{ key: 'text', label: '创意描述', type: 'textarea' }] },
  script:     { label: '剧本', icon: '▤', color: '#818cf8', agent: 'screenwriter', group: '叙事', fields: [{ key: 'text', label: '创作输入', type: 'textarea' }] },
  rag:        { label: 'RAG 上下文', icon: '⌕', color: '#22d3ee', agent: 'rag', group: '叙事', fields: [] },
  plan:       { label: '叙事分解', icon: '⑂', color: '#22d3ee', agent: 'decomposer', group: '叙事', fields: [{ key: 'sceneLimit', label: '场景数', type: 'number' }, { key: 'shotsPerScene', label: '每场镜头数', type: 'number' }] },
  episode:    { label: '分集', icon: '▥', color: '#c084fc', agent: null, group: '分集', fields: [{ key: 'summary', label: '本集梗概', type: 'text' }] },
  event:      { label: '事件', icon: '◈', color: '#38bdf8', agent: 'rag', group: '结构', fields: [{ key: 'summary', label: '摘要', type: 'text' }] },
  scene:      { label: '场景', icon: '▦', color: '#60a5fa', agent: 'storyboard', group: '结构', fields: [{ key: 'shotsPerScene', label: '镜头数', type: 'number' }] },
  shot:       { label: '镜头规格', icon: '▧', color: '#60a5fa', agent: 'keyframe', group: '结构', fields: [] },
  character:  { label: '角色资产', icon: '◉', color: '#f472b6', agent: 'character', group: '资产', fields: [] },
  camera:     { label: '机位依赖图', icon: '⌗', color: '#fbbf24', agent: 'camera-graph', group: '镜头', fields: [] },
  keyframe:   { label: '关键帧', icon: '▣', color: '#34d399', agent: 'keyframe', group: '生成', fields: [] },
  review:     { label: 'VLM 择优', icon: '✓', color: '#34d399', agent: 'review', group: '生成', fields: [] },
  video:      { label: '视频片段', icon: '▶', color: '#fb923c', agent: 'video', group: '生成', fields: [] },
  transition: { label: '转场锚点', icon: '⇄', color: '#fb923c', agent: 'transition', group: '生成', fields: [] },
  final:      { label: '成片时间线', icon: '✦', color: '#facc15', agent: 'composer', group: '交付', fields: [] },
  note:       { label: '便签', icon: '✎', color: '#94a3b8', agent: null, group: '其他', fields: [{ key: 'text', label: '内容', type: 'textarea' }] },
};

export const PALETTE_ORDER = ['idea', 'episode', 'script', 'rag', 'plan', 'character', 'shot', 'keyframe', 'review', 'video', 'transition', 'camera', 'final', 'note'];
export const typeOf = (t) => NODE_TYPES[t] || NODE_TYPES.note;
export const STATUS_LABEL = { idle: '待运行', queued: '排队中', running: '运行中', done: '已完成', error: '失败', skipped: '已跳过' };

const esc = (s = '') => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const img = (url, cls = 'node-thumb') => (url ? `<img class="${cls}" loading="lazy" src="${esc(url)}" alt="预览" onerror="this.style.display='none'">` : '');
const chips = (arr = []) => arr.filter(Boolean).length
  ? `<div class="node-kv">${arr.filter(Boolean).slice(0, 4).map((c) => `<span class="kv-chip">${esc(c)}</span>`).join('')}</div>` : '';
const clip = (s, n = 110) => (String(s || '').length > n ? `${String(s).slice(0, n)}…` : String(s || ''));

function firstImage(d = {}) {
  return d.poster || d.keyframeUrl || d.clip?.poster || d.transition?.url || d.url
    || d.candidates?.[0]?.url || d.characters?.[0]?.portraitUrl || null;
}

export function previewHTML(node) {
  const d = node.data || {};
  const t = node.type;
  if (t === 'keyframe' && d.candidates?.length) {
    const chosen = d.candidates.map((c, i) => img(c.url, `node-thumb${false ? ' chosen' : ''}`)).join('');
    return `<div class="node-thumbs">${chosen}</div>${chips([`${d.candidates.length} 张候选`, `${d.refs?.length || 0} 个锚点`])}`;
  }
  if (t === 'review' && d.candidates?.length) {
    return `<div class="node-thumbs">${d.candidates.slice(0, 2).map((c, i) => img(c.url, `node-thumb${i === d.selected ? ' chosen' : ''}`)).join('')}</div>${chips([`选中 #${(d.selected ?? 0) + 1}`, `分数 ${Math.max(...(d.scores || [0])).toFixed(3)}`])}`;
  }
  if (t === 'character' && d.characters?.length) {
    return `${img(d.characters[0].portraitUrl)}${chips(d.characters.map((c) => c.name))}`;
  }
  const main = firstImage(d);
  if (main) return `${img(main)}${d.summary ? `<div class="node-text" style="margin-top:7px">${esc(clip(d.summary, 70))}</div>` : ''}`;
  if (t === 'episode' && d.episode) {
    return `<div class="node-text">${esc(clip(d.episode.summary, 82))}</div>${chips([`第 ${d.episode.no} 集`, `${d.episode.chars} 字`, d.episode.sourceTitles?.[0] || ''])}`;
  }
  if (t === 'shot' && d.shot) {
    return `<div class="node-text">${esc(clip(d.shot.ffDesc, 92))}</div>${chips([d.shot.size, d.shot.angle, d.shot.movement, `${d.shot.duration}s`])}`;
  }
  if (t === 'plan' && d.shotPlan) {
    return `<div class="node-text">${esc(d.summary || '')}</div>${chips(d.hierarchy || [])}`;
  }
  if (d.script?.scenes) {
    return `<div class="node-text">${esc(`${d.script.title || '剧本'}｜${d.script.genre || ''}\n${d.script.logline || ''}`)}</div>${chips([`${d.script.scenes.length} 场`, `${d.script.characters?.length || 0} 角色`])}`;
  }
  if (d.shots) return `<div class="node-text">${esc(d.summary || `${d.shots.length} 个镜头`)}</div>${chips(d.shots.slice(0, 3).map((s) => s.size))}`;
  if (d.context?.passages) return `<div class="node-text">${esc(d.context.passages[0] || '')}</div>${chips([`${d.context.passages.length} 段上下文`, 'RAG'])}`;
  if (d.cameras) return `<div class="node-text">${esc(d.summary || '')}</div>${chips([`${d.cameras.length} 机位`, `${d.anchorCount || 0} 锚点`])}`;
  if (d.timeline) return `<div class="node-text">${esc(d.summary || '')}</div>${chips([`${d.timeline.length} 镜头`, `${d.duration}s`])}`;
  const text = d.summary || d.text || (d.scene?.summary) || (d.event?.summary) || '等待智能体生成内容…';
  return `<div class="node-text">${esc(clip(text, 150))}</div>`;
}

export function nodeInnerHTML(node) {
  const t = typeOf(node.type);
  return `
    <div class="node-accent"></div>
    <div class="node-head">
      <span class="node-icon">${t.icon}</span>
      <span class="node-title" title="${esc(node.title)}">${esc(node.title)}</span>
      <span class="node-status-dot" title="${STATUS_LABEL[node.status] || node.status}"></span>
    </div>
    <div class="node-body">${previewHTML(node)}</div>
    <div class="node-foot">
      <span>${t.label}</span>
      <span class="nf-agent">${esc(node.agent || '数据节点')}</span>
    </div>
    <div class="port port-in" title="输入端口"></div>
    <div class="port port-out" title="拖出以建立依赖"></div>
    <div class="node-progress"><i style="width:${Math.round((node.progress || 0) * 100)}%"></i></div>`;
}

export function decorateNode(el, node) {
  const t = typeOf(node.type);
  el.dataset.id = node.id;
  el.className = `node status-${node.status || 'idle'}`;
  el.style.setProperty('--ncolor', t.color);
  el.style.left = `${node.x || 0}px`;
  el.style.top = `${node.y || 0}px`;
  el.style.width = `${node.w || 268}px`;
  el.innerHTML = nodeInnerHTML(node);
  return el;
}

export function createNodeEl(node) {
  const el = document.createElement('div');
  return decorateNode(el, node);
}
