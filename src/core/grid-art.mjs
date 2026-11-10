/* ============================================================================
 * 分镜宫格图 SVG 生成器（版式可选：九宫格 / 六宫格 / 四宫格 / 条漫 / 25 格 / 单图）。
 *
 * 「每一段对应一张分镜板」：一段原文切成 N 个叙事格（N 由分镜画面设置决定），
 * 每格带序号、镜头规格 / 动作说明与可选的真实关键帧图。
 * 没有真实图时按设置画确定性剪影占位或留「待出图」空格，保证任何环境都能
 * 立刻看到完整分镜板；纯函数：只返回 SVG 字符串，落盘由 episode-service.mjs 完成。
 * ==========================================================================*/
import { layoutOf, sheetSpec, aspectLabel } from './storyboard-settings.mjs';

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

const clampInt = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n)));

/** 说明条内容：按设置决定显示什么，绝不让一行长文案溢出格子 */
function captionLines(cell, mode, width, fs) {
  if (mode === 'none') return [];
  const perLine = Math.max(8, Math.floor((width - 24) / fs));
  if (mode === 'action') {
    const text = cell?.action || cell?.caption || '';
    return text ? [cut(text, perLine)] : [];
  }
  if (mode === 'prompt') {
    const text = cell?.prompt || cell?.action || cell?.caption || '';
    return text ? [cut(text, perLine)] : [];
  }
  // spec：第一行镜头规格（景别 · 机位 · 运动），第二行动作或原文摘要
  const spec = cut(cell?.spec || '', perLine);
  const action = cut(cell?.action || cell?.caption || '', perLine);
  return [spec, action].filter(Boolean).slice(0, 2);
}

/** 构图参考线：三分线 / 中心十字（画在格内，不遮挡说明条） */
function guideLines(x, y, w, h, mode, accent) {
  if (mode === 'thirds') {
    const xs = [x + w / 3, x + w * 2 / 3];
    const ys = [y + h / 3, y + h * 2 / 3];
    return [
      ...xs.map((v) => `<line x1="${v.toFixed(1)}" y1="${y}" x2="${v.toFixed(1)}" y2="${y + h}" stroke="${accent}" stroke-opacity="0.22" stroke-width="1"/>`),
      ...ys.map((v) => `<line x1="${x}" y1="${v.toFixed(1)}" x2="${x + w}" y2="${v.toFixed(1)}" stroke="${accent}" stroke-opacity="0.22" stroke-width="1"/>`),
    ].join('');
  }
  if (mode === 'center') {
    return `<line x1="${x + w / 2}" y1="${y}" x2="${x + w / 2}" y2="${y + h}" stroke="${accent}" stroke-opacity="0.22" stroke-width="1"/>`
      + `<line x1="${x}" y1="${y + h / 2}" x2="${x + w}" y2="${y + h / 2}" stroke="${accent}" stroke-opacity="0.22" stroke-width="1"/>`;
  }
  return '';
}

/** 单格：真实图铺满，缺图按设置画剪影或留空；说明条 / 序号 / 参考线依次叠加 */
function cellSVG(cell, box, opt) {
  const { colors, seed, index } = opt;
  const [dark, mid, accent, cool] = colors;
  const { x, y, w, h } = box;
  const n = (hash(`${seed}-${index}`) % 100) / 100;
  const r = Math.round(Math.min(w, h) * 0.04);
  const fs = clampInt(w / 32, 11, 17);
  const lineH = Math.round(fs * 1.42);
  const lines = captionLines(cell, opt.captionMode, w, fs);
  const bandH = lines.length ? Math.min(Math.round(h * 0.5), 14 + lines.length * lineH) : 0;
  const horizon = Math.round(y + h * 0.78);
  const headR = Math.round(Math.min(w, h) * 0.1);
  const cx = Math.round(x + w * (0.3 + n * 0.4));
  const hasImage = Boolean(cell?.url) && opt.source !== 'schematic';
  const parts = [];

  parts.push(`<defs><linearGradient id="cg${index}" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="${dark}"/><stop offset="1" stop-color="${mid}"/></linearGradient></defs>`);
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="url(#cg${index})"/>`);

  if (hasImage) {
    parts.push(`<image href="${esc(cell.url)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" opacity="0.94"/>`);
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${dark}" opacity="0.14"/>`);
  } else if (opt.placeholder !== false) {
    // 示意剪影：确定性色块 + 人物轮廓，告诉用户「这里会有一个镜头」
    parts.push(`<path d="M${x} ${horizon} H${x + w}" stroke="${accent}" stroke-opacity="0.3" stroke-width="1"/>`);
    parts.push(`<circle cx="${cx}" cy="${y + h * 0.46}" r="${headR}" fill="${dark}" opacity="0.85"/>`);
    parts.push(`<path d="M${cx - headR * 1.7} ${horizon} Q${cx} ${y + h * 0.54} ${cx + headR * 1.7} ${horizon} Z" fill="${dark}" opacity="0.85"/>`);
    parts.push(`<circle cx="${x + w * (0.2 + n * 0.15)}" cy="${y + h * 0.2}" r="${Math.round(Math.min(w, h) * 0.045)}" fill="${cool}" opacity="0.45"/>`);
  } else {
    parts.push(`<rect x="${x + 6}" y="${y + 6}" width="${w - 12}" height="${h - 12}" rx="${Math.max(2, r - 2)}" fill="none" stroke="${accent}" stroke-opacity="0.5" stroke-dasharray="8 6" stroke-width="1.5"/>`);
    parts.push(`<text x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" font-size="${clampInt(w / 16, 12, 20)}" fill="${accent}" fill-opacity="0.75" font-family="sans-serif">待出图</text>`);
  }

  if (bandH) {
    // 说明条压在画面底部：真实图上也保证文字可读
    parts.push(`<rect x="${x}" y="${y + h - bandH}" width="${w}" height="${bandH}" fill="${dark}" opacity="0.82"/>`);
    lines.forEach((line, i) => {
      const fs2 = i === 0 && opt.captionMode === 'spec' ? fs : clampInt(fs * 0.94, 10, 16);
      parts.push(`<text x="${x + 12}" y="${y + h - bandH + 14 + i * lineH}" font-size="${fs2}" `
        + `fill="${i === 0 && opt.captionMode === 'spec' ? '#eef3fb' : '#c3cede'}" font-family="sans-serif">${esc(line)}</text>`);
    });
  }

  // 站位图缩略（右下角小图）：宫格视图里每格都能直接看到「谁站在哪、机位在哪」，
  // 点开单格的 blockingUrl 才是完整站位图
  if (cell?.blockingUrl) {
    const insetW = clampInt(w * 0.2, 44, 120);
    const insetH = Math.round(insetW * 9 / 16);
    const ix = x + w - insetW - 8;
    const iy = y + h - bandH - insetH - 8;
    parts.push(`<image href="${esc(cell.blockingUrl)}" x="${ix}" y="${iy}" width="${insetW}" height="${insetH}" preserveAspectRatio="xMidYMid slice"/>`);
    parts.push(`<rect x="${ix}" y="${iy}" width="${insetW}" height="${insetH}" fill="none" stroke="${accent}" stroke-opacity="0.7" stroke-width="1"/>`);
    parts.push(`<text x="${ix + insetW / 2}" y="${iy - 3}" text-anchor="middle" font-size="10" fill="${accent}" fill-opacity="0.85" font-family="sans-serif">站位</text>`);
  }

  parts.push(guideLines(x, y, w, h, opt.guides, accent));
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="none" stroke="${accent}" stroke-opacity="0.45" stroke-width="1.5"/>`);

  if (opt.showNo) {
    const chipW = 30;
    const chipH = 24;
    parts.push(`<rect x="${x + 8}" y="${y + 8}" width="${chipW}" height="${chipH}" rx="6" fill="${accent}" opacity="0.92"/>`);
    parts.push(`<text x="${x + 8 + chipW / 2}" y="${y + 8 + 17}" text-anchor="middle" font-size="14" font-weight="700" fill="${dark}">${index + 1}</text>`);
  }
  if (cell?.shotNo !== undefined && cell?.shotNo !== null && cell?.shotNo !== '') {
    const t = `#${cell.shotNo}`;
    parts.push(`<text x="${x + w - 12}" y="${y + 24}" text-anchor="end" font-size="12" fill="#eef3fb" fill-opacity="0.72" font-family="sans-serif">${esc(t)}</text>`);
  }
  return parts.join('');
}

/**
 * @param {Object} o
 * @param {string} o.title     板标题（如「第 2 集 · 第 1 段分镜板」）
 * @param {string} o.subtitle  副标题（字数 / 原文摘要）
 * @param {Array}  o.cells     格子 {no, caption, spec, action, prompt, url, shotNo}
 * @param {string} o.style     画面风格（决定配色）
 * @param {string} o.seed      确定性种子
 * @param {Object} o.settings  分镜画面设置（layout / aspect / captionMode / guides / showNo / watermark）
 * @param {string} o.badge     右上角版式徽标（缺省由设置推导）
 * @returns {string} SVG
 */
export function storyboardGridSVG(o = {}) {
  const settings = o.settings || {};
  const layout = layoutOf(settings);
  // 画幅解析：显式 resolvedAspect > 设置里的具体画幅 > 调用方给的比例 > 横屏兜底
  const explicitAspect = settings.aspect && settings.aspect !== 'inherit' ? settings.aspect : '';
  const spec = sheetSpec({
    ...settings,
    resolvedAspect: settings.resolvedAspect || explicitAspect || o.aspect || '16:9',
  });
  const count = layout.cells;
  const cells = Array.from({ length: count }, (_, i) => (Array.isArray(o.cells) ? o.cells[i] : null)
    || { no: i + 1, caption: `镜头 ${i + 1}`, url: '' });
  const colors = PALETTES[o.style] || PALETTES.cinematic;
  const [dark, mid, accent] = colors;
  const { width: W, height: H, cellW, cellH, pad, gap, head } = spec;
  const seed = o.seed || o.title || 'grid';

  const tiles = cells.map((c, i) => {
    const col = i % layout.cols;
    const row = Math.floor(i / layout.cols);
    return cellSVG(c, {
      x: Math.round(pad + col * (cellW + gap)),
      y: Math.round(head + row * (cellH + gap)),
      w: Math.round(cellW),
      h: Math.round(cellH),
    }, {
      colors, seed, index: i,
      showNo: settings.showNo !== false,
      captionMode: settings.captionMode || 'spec',
      guides: settings.guides || 'none',
      source: settings.source || 'mixed',
      placeholder: (settings.source || 'mixed') !== 'keyframe',
    });
  }).join('');

  const badge = o.badge || `${layout.label} ${layout.cols}×${layout.rows} · ${layout.cells} 格 · ${aspectLabel(spec.aspect)}`;
  const badgeW = clampInt(badge.length * 11 + 26, 120, W - pad * 2 - 260);
  const realN = cells.filter((c) => c?.url).length;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${dark}"/><stop offset="1" stop-color="${mid}"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect x="${pad}" y="20" width="6" height="48" rx="3" fill="${accent}"/>
  <text x="${pad + 20}" y="48" font-size="27" font-weight="700" fill="#eef3fb" font-family="sans-serif">${esc(cut(o.title || '分镜宫格', 40))}</text>
  <text x="${pad + 20}" y="76" font-size="16" fill="#a9b7cc" font-family="sans-serif">${esc(cut(o.subtitle || `${layout.cols} × ${layout.rows} 叙事分镜`, 96))}</text>
  <rect x="${W - pad - badgeW}" y="30" width="${badgeW}" height="30" rx="15" fill="${accent}" opacity="0.16" stroke="${accent}" stroke-opacity="0.45"/>
  <text x="${W - pad - badgeW / 2}" y="50" text-anchor="middle" font-size="13" fill="${accent}" font-family="sans-serif">${esc(badge)}</text>
  ${tiles}
  ${settings.watermark === false ? '' : `<text x="${W - pad}" y="${H - 12}" text-anchor="end" font-size="13" fill="#8fa0b8" font-family="sans-serif">lingximanju · ${layout.label} · 真实分镜图 ${realN}/${count} 格</text>`}
</svg>`;
}

/** 宫格图配套的可读分镜表（导出导演包时用）；每格带上视觉物料与精确提示词 */
export function gridShotList(segment, epNo) {
  return (segment?.cells || []).map((c) => ({
    shotNo: c.shotNo ?? c.no, panelNo: c.no, caption: c.caption,
    spec: c.spec || '', action: c.action || '', prompt: c.prompt || '', url: c.url || '',
    // 分镜画面的多图物料与提示词（第⑤步起每格都有）：
    imagePrompt: c.imagePrompt || '', videoPrompt: c.videoPrompt || '',
    blockingUrl: c.blockingUrl || '', gridUrl: c.gridUrl || '',
    visual: c.visual || null,
    segmentNo: segment?.no || 1, episodeNo: epNo,
  }));
}
