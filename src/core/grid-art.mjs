/* ============================================================================
 * 分镜宫格图（3×3）零依赖 SVG 生成器。
 *
 * 「每一段对应一张宫格图」：一段原文切成 9 个叙事格，每格带序号、说明与
 * 可选的真实关键帧图（来自画布 review / keyframe 节点或 ComfyUI 产物）。
 * 没有真实图时用确定性色块 + 剪影占位，保证任何环境都能立刻看到完整分镜板。
 * 纯函数：只返回 SVG 字符串，落盘由 episode-service.mjs 完成。
 * ==========================================================================*/
const esc = (s = '') => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const cut = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

const PALETTES = {
  cinematic: ['#0c1420', '#274a63', '#f4b268', '#8b9bff'],
  noir: ['#0d1118', '#26344a', '#ff9a5c', '#7c8aa5'],
  anime: ['#181c30', '#5c6ca8', '#ffb2c4', '#9fc7ff'],
  watercolor: ['#20262a', '#688480', '#e2cea4', '#b7d3c4'],
};

function hash(str = '') {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** 单格：有真实图就铺图，否则画一个确定性的分镜剪影 */
function cellSVG(cell, x, y, w, h, colors, seed, i) {
  const [dark, mid, accent, cool] = colors;
  const n = (hash(`${seed}-${i}`) % 100) / 100;
  const cx = Math.round(x + w * (0.3 + n * 0.4));
  const headR = Math.round(h * 0.11);
  const horizon = Math.round(y + h * 0.78);
  const parts = [
    `<defs><linearGradient id="g${i}" x1="0" y1="0" x2="0" y2="1">`,
    `<stop offset="0" stop-color="${dark}"/><stop offset="1" stop-color="${mid}"/></linearGradient></defs>`,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#g${i})"/>`,
  ];
  if (cell?.url) {
    parts.push(`<image href="${esc(cell.url)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" opacity="0.82"/>`);
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${dark}" opacity="0.18"/>`);
  } else {
    parts.push(`<path d="M${x} ${horizon} H${x + w}" stroke="${accent}" stroke-opacity="0.35" stroke-width="1"/>`);
    parts.push(`<circle cx="${cx}" cy="${y + h * 0.48}" r="${headR}" fill="${dark}" opacity="0.85"/>`);
    parts.push(`<path d="M${cx - headR * 1.7} ${horizon} Q${cx} ${y + h * 0.56} ${cx + headR * 1.7} ${horizon} Z" fill="${dark}" opacity="0.85"/>`);
    parts.push(`<circle cx="${x + w * (0.2 + n * 0.15)}" cy="${y + h * 0.24}" r="${Math.round(h * 0.05)}" fill="${cool}" opacity="0.5"/>`);
  }
  // 序号角标 + 取景框
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${accent}" stroke-opacity="0.45" stroke-width="1.5"/>`);
  parts.push(`<rect x="${x + 8}" y="${y + 8}" width="30" height="24" rx="6" fill="${accent}" opacity="0.92"/>`);
  parts.push(`<text x="${x + 23}" y="${y + 25}" text-anchor="middle" font-size="14" font-weight="700" fill="${dark}">${i + 1}</text>`);
  // 底部说明条（两行，避免长句溢出）
  const caption = cut(cell?.caption || `镜头 ${i + 1}`, 30);
  parts.push(`<rect x="${x}" y="${y + h - 42}" width="${w}" height="42" fill="${dark}" opacity="0.86"/>`);
  parts.push(`<text x="${x + 12}" y="${y + h - 17}" font-size="15" fill="#e9edf5" font-family="sans-serif">${esc(caption)}</text>`);
  return parts.join('');
}

/**
 * @param {Object} o
 * @param {string} o.title     宫格标题（如「第 2 集 · 第 1 段」）
 * @param {string} o.subtitle  副标题（字数 / 原文摘要）
 * @param {Array}  o.cells     9 个格 {no, caption, url}
 * @param {string} o.style     画面风格
 * @param {string} o.seed      确定性种子
 * @returns {string} SVG
 */
export function storyboardGridSVG(o = {}) {
  const cells = Array.from({ length: 9 }, (_, i) => (Array.isArray(o.cells) ? o.cells[i] : null) || { no: i + 1, caption: `镜头 ${i + 1}`, url: '' });
  const colors = PALETTES[o.style] || PALETTES.cinematic;
  const [dark, mid, accent] = colors;
  const W = 1200, H = 820;
  const pad = 28, gap = 14, head = 92;
  const cw = (W - pad * 2 - gap * 2) / 3;
  const ch = (H - head - pad - gap * 2 - 34) / 3;
  const seed = o.seed || o.title || 'grid';
  const tiles = cells.map((c, i) => {
    const x = pad + (i % 3) * (cw + gap);
    const y = head + Math.floor(i / 3) * (ch + gap);
    return cellSVG(c, Math.round(x), Math.round(y), Math.round(cw), Math.round(ch), colors, seed, i);
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${dark}"/><stop offset="1" stop-color="${mid}"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect x="${pad}" y="20" width="6" height="48" rx="3" fill="${accent}"/>
  <text x="${pad + 20}" y="48" font-size="27" font-weight="700" fill="#eef3fb" font-family="sans-serif">${esc(cut(o.title || '分镜宫格', 40))}</text>
  <text x="${pad + 20}" y="76" font-size="16" fill="#a9b7cc" font-family="sans-serif">${esc(cut(o.subtitle || '3 × 3 叙事分镜', 96))}</text>
  ${tiles}
  <text x="${W - pad}" y="${H - 12}" text-anchor="end" font-size="13" fill="#8fa0b8" font-family="sans-serif">lingximanju · 每段一图 · 点击格子可替换真实关键帧</text>
</svg>`;
}

/** 宫格图配套的可读分镜表（导出导演包时用） */
export function gridShotList(segment, epNo) {
  return (segment?.cells || []).map((c) => ({
    shotNo: c.no, caption: c.caption, prompt: c.prompt || '', url: c.url || '',
    segmentNo: segment?.no || 1, episodeNo: epNo,
  }));
}
