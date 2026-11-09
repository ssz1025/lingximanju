// 零依赖 PNG 编码器 + 分镜占位帧栅格化
// 用途：MiniMax H3 Director 的素材槽位只接受 png/jpg/webp，不接受 SVG。
// Mock 模式下把分镜草图渲染成合法 PNG；接入 ComfyUI 出图后会直接使用模型返回的真实 PNG/JPG。
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

/** rgba: Buffer(width*height*4)，每行前置 filter byte 0 */
export function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PALETTES = {
  noir: [[13, 17, 24], [38, 52, 74], [255, 154, 92]],
  cinematic: [[12, 18, 28], [49, 76, 96], [244, 178, 104]],
  anime: [[24, 28, 48], [92, 108, 168], [255, 178, 196]],
  watercolor: [[32, 38, 42], [104, 132, 128], [226, 206, 164]],
};

function hash(str = '') {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const STYLE_KEYS = new Set(['noir', 'cinematic', 'anime', 'watercolor']);

function resolvePalette(style) {
  return PALETTES[STYLE_KEYS.has(style) ? style : 'cinematic'];
}

/** 构造画布：返回 {set, blend, rect, ellipse, fill, buffer} */
function canvas(width, height) {
  const img = Buffer.alloc(width * height * 4);
  const set = (x, y, r, g, b, a = 255) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = a;
  };
  const blend = (x, y, r, g, b, alpha) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const a = Math.max(0, Math.min(1, alpha));
    const i = (y * width + x) * 4;
    img[i] = Math.round(img[i] * (1 - a) + r * a);
    img[i + 1] = Math.round(img[i + 1] * (1 - a) + g * a);
    img[i + 2] = Math.round(img[i + 2] * (1 - a) + b * a);
    img[i + 3] = 255;
  };
  const fill = (x0, y0, w, h, color, alpha = 1) => {
    for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) blend(x, y, color[0], color[1], color[2], alpha);
  };
  const ellipse = (cx, cy, rx, ry, color, alpha = 1) => {
    for (let y = -ry; y <= ry; y += 1) {
      const half = rx * Math.sqrt(Math.max(0, 1 - (y / ry) ** 2));
      for (let x = -half; x <= half; x += 1) blend(cx + x, cy + y, color[0], color[1], color[2], alpha);
    }
  };
  return { img, set, blend, fill, ellipse };
}

/** 颜色字符串（#rrggbb）→ [r,g,b]，无法解析时回退默认色 */
function hexRGB(value, fallback) {
  const m = String(value || '').trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 角色视图占位帧（PNG）。
 *
 * 为什么需要它：Mock 模式下角色定妆图是 SVG，而导演台 / ComfyUI 的素材槽位只接受位图。
 * 旧实现把 SVG 一律换成「渐变夜景 + 建筑」的分镜占位图，于是交给下游的角色参考图
 * 是一张与角色毫无关系的风景 —— 比没有参考图更糟，会误导参考强度。
 *
 * 这里按视图语义绘制：全身（正面 / 3-4 侧 / 侧面 / 背面，横向压缩模拟转身幅度）
 * 或头肩（面部特写），叠角色配色色板，让「这是谁的哪个角度」在下游仍然可辨认。
 *
 * @param {object} opts
 * @param {'front'|'threeQuarter'|'side'|'back'|'closeup'} [opts.view]
 * @param {string[]} [opts.palette] 角色主配色（#rrggbb），最多取 5 个
 * @param {string} [opts.style]     项目画风（决定背景基调）
 * @param {string} [opts.label]     角色名（仅用于确定性抖动，不绘制文字）
 */
export function characterViewFrame(opts = {}) {
  const width = Math.max(64, Math.min(1920, Number(opts.width) || 640));
  const height = Math.max(64, Math.min(1080, Number(opts.height) || 360));
  const view = ['front', 'threeQuarter', 'side', 'back', 'closeup'].includes(opts.view) ? opts.view : 'front';
  const [dark, mid, accent] = resolvePalette(opts.style);
  const c = canvas(width, height);
  const h = hash(`${opts.label || ''}|${view}|${opts.seed || ''}`);

  // 背景：同画风基调的竖直渐变 + 极轻的侧向压暗，保持「设定图纯色背景」观感
  for (let y = 0; y < height; y += 1) {
    const t = y / height;
    for (let x = 0; x < width; x += 1) {
      const side = 1 - Math.abs(x / width - 0.5) * 0.55;
      c.set(x, y,
        Math.round((dark[0] + (mid[0] - dark[0]) * t * 0.55) * side),
        Math.round((dark[1] + (mid[1] - dark[1]) * t * 0.55) * side),
        Math.round((dark[2] + (mid[2] - dark[2]) * t * 0.55) * side));
    }
  }

  // 顶部深色条 + 底部条：留出文字位（占位帧不绘制文字，靠色条位置保持版式一致）
  // 先画版式条，再画人形与色板，避免底部条把色板压暗
  c.fill(0, 0, width, Math.max(6, Math.round(height * 0.12)), dark, 0.85);
  c.fill(0, height - Math.max(4, Math.round(height * 0.10)), width, Math.max(4, Math.round(height * 0.10)), dark, 0.85);
  // 顶部左侧 accent 短横：指示「此处是角色名」，让占位图不至于完全无标签感
  c.fill(Math.round(width * 0.03), Math.round(height * 0.05), Math.round(width * 0.10), Math.max(2, Math.round(height * 0.018)), accent, 0.75);

  // 取景框：中央竖幅画框，和 SVG 设定图同一版式
  const boxW = Math.round(width * 0.26);
  const boxX = Math.round(width / 2 - boxW / 2);
  const boxY = Math.round(height * 0.16);
  const boxH = Math.round(height * 0.70);
  c.fill(boxX, boxY, boxW, boxH, mid, 0.24);
  // 画框描边（亮线，1~2px）
  const edge = [200, 205, 215];
  c.fill(boxX, boxY, boxW, 1, edge, 0.28);
  c.fill(boxX, boxY + boxH - 1, boxW, 1, edge, 0.28);
  c.fill(boxX, boxY, 1, boxH, edge, 0.28);
  c.fill(boxX + boxW - 1, boxY, 1, boxH, edge, 0.28);

  const figure = dark.map((v) => Math.min(255, v + 4));
  const cx = width / 2;
  // 转身幅度：正面 1、3/4 侧 0.84、侧面 0.62、背面 1（背面靠「无色带」区分）
  const narrow = { side: 0.62, threeQuarter: 0.84 }[view] || 1;

  if (view === 'closeup') {
    // 头肩特写：只到大肩线，交代「这是近景对齐用的脸」
    const headRy = Math.round(boxH * 0.30);
    const headCy = Math.round(boxY + boxH * 0.42);
    c.ellipse(cx, headCy, Math.round(headRy * 0.78), headRy, figure, 0.92);
    // 肩线
    const shoulderTop = headCy + headRy - Math.round(headRy * 0.2);
    for (let y = shoulderTop; y < boxY + boxH; y += 1) {
      const spread = Math.round((y - shoulderTop) * 1.15 + headRy * 0.55);
      c.fill(cx - spread, y, spread * 2, 1, figure, 0.92);
    }
    // 眼睛与鼻梁：最小笔画，避免看起来只是色块
    c.ellipse(cx - Math.round(headRy * 0.32), headCy - Math.round(headRy * 0.1), 3, 3, accent, 0.85);
    c.ellipse(cx + Math.round(headRy * 0.32), headCy - Math.round(headRy * 0.1), 3, 3, accent, 0.85);
    c.fill(cx - 1, headCy, 2, Math.round(headRy * 0.5), accent, 0.35);
  } else {
    // 全身：头 + 躯干 + 双腿
    const headR = Math.round(boxH * 0.085);
    const headCy = Math.round(boxY + boxH * 0.14);
    c.ellipse(cx, headCy, headR * narrow, headR, figure, 0.9);
    const shoulderY = headCy + headR;
    const hipY = Math.round(boxY + boxH * 0.58);
    const shoulderW = Math.round(headR * 1.35 * narrow);
    const hipW = Math.round(headR * 1.1 * narrow);
    for (let y = shoulderY; y < hipY; y += 1) {
      const t = (y - shoulderY) / Math.max(1, hipY - shoulderY);
      const half = Math.round(shoulderW + (hipW - shoulderW) * t);
      c.fill(cx - half, y, half * 2, 1, figure, 0.9);
    }
    // 双腿：留一条中缝，避免变成一个色块
    const footY = Math.round(boxY + boxH * 0.96);
    for (let y = hipY; y < footY; y += 1) {
      const t = (y - hipY) / Math.max(1, footY - hipY);
      const half = Math.round(hipW * (1 - t * 0.18));
      const gap = Math.max(1, Math.round(half * 0.14));
      c.fill(cx - half, y, half - gap, 1, figure, 0.9);
      c.fill(cx + gap, y, half - gap, 1, figure, 0.9);
    }
    // 胸前色带（背面不画，正面与侧身才有；这是观众区分正背的直观信号）
    if (view !== 'back') {
      const bandY = Math.round(shoulderY + (hipY - shoulderY) * 0.18);
      c.fill(cx - Math.round(shoulderW * 0.9), bandY, Math.round(shoulderW * 1.8), Math.max(3, Math.round(boxH * 0.014)), accent, 0.5);
    }
  }

  // 顶部深色条 + 底部条：留出文字位（占位帧不绘制文字，靠色条位置保持版式一致）
  c.fill(0, 0, width, Math.max(6, Math.round(height * 0.12)), dark, 0.85);
  c.fill(0, height - Math.max(4, Math.round(height * 0.10)), width, Math.max(4, Math.round(height * 0.10)), dark, 0.85);
  // 顶部左侧 accent 短横：指示「此处是角色名」，让占位图不至于完全无标签感
  c.fill(Math.round(width * 0.03), Math.round(height * 0.05), Math.round(width * 0.10), Math.max(2, Math.round(height * 0.018)), accent, 0.75);

  // 角色配色色板：右下角圆点，与 SVG 设定图同位（画在版式条之上，保证可辨）
  const hexOf = (rgb) => `#${rgb.map((v) => (Math.max(0, Math.min(255, v)) | 0).toString(16).padStart(2, '0')).join('')}`;
  const colors = (Array.isArray(opts.palette) ? opts.palette : []).filter((x) => hexRGB(x, null)).slice(0, 5);
  const swatch = colors.length ? colors : [hexOf(figure), hexOf(mid), hexOf(accent)];
  const dotY = Math.round(height * 0.92);
  const dotR = Math.max(3, Math.round(height * 0.018));
  swatch.forEach((col, i) => {
    const rgb = hexRGB(col, accent);
    const dx = width - Math.round(width * 0.05) - (swatch.length - 1 - i) * dotR * 3;
    c.ellipse(dx, dotY, dotR, dotR, rgb, 0.95);
  });

  // 极轻的确定性抖动，避免同视图多角色完全一样
  if (h % 3) c.blend(Math.round(width * 0.1), Math.round(height * 0.4), accent[0], accent[1], accent[2], 0.06);

  return encodePNG(width, height, c.img);
}

/**
 * 生成一张确定性的分镜占位帧：渐变夜景 + 建筑剪影 + 主体轮廓 + 取景框。
 * 不是 AI 出图，但足以作为导演工作台里可识别、可替换的首帧槽位素材。
 */
export function placeholderFrame(opts = {}) {
  const width = Math.max(64, Math.min(1920, Number(opts.width) || 640));
  const height = Math.max(64, Math.min(1080, Number(opts.height) || 360));
  const [dark, mid, accent] = PALETTES[opts.style] || PALETTES.cinematic;
  const h = hash(`${opts.seed || ''}|${opts.shotNo || 1}|${opts.kind || 'frame'}`);
  const img = Buffer.alloc(width * height * 4);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = a;
  };
  const blend = (x, y, r, g, b, alpha) => {
    const i = (y * width + x) * 4;
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const a = Math.max(0, Math.min(1, alpha));
    img[i] = Math.round(img[i] * (1 - a) + r * a);
    img[i + 1] = Math.round(img[i + 1] * (1 - a) + g * a);
    img[i + 2] = Math.round(img[i + 2] * (1 - a) + b * a);
    img[i + 3] = 255;
  };
  const lerp = (a, b, t) => a + (b - a) * t;

  // 背景渐变
  for (let y = 0; y < height; y += 1) {
    const t = y / height;
    for (let x = 0; x < width; x += 1) {
      const side = 1 - Math.abs(x / width - 0.5) * 0.7;
      set(x, y,
        Math.round(lerp(dark[0], mid[0], t * 0.75) * side),
        Math.round(lerp(dark[1], mid[1], t * 0.75) * side),
        Math.round(lerp(dark[2], mid[2], t * 0.75) * side));
    }
  }
  // 远处光源
  const lx = width * (0.2 + (h % 60) / 100);
  const ly = height * (0.28 + ((h >> 6) % 20) / 100);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const d = Math.hypot((x - lx) / width, (y - ly) / height);
      if (d < 0.42) blend(x, y, accent[0], accent[1], accent[2], (1 - d / 0.42) ** 2 * 0.32);
    }
  }
  // 地平线与建筑剪影
  const horizon = Math.round(height * 0.68);
  for (let x = 0; x < width; x += 1) set(x, horizon, dark[0], dark[1], dark[2]);
  for (let b = 0; b < 9; b += 1) {
    const bw = Math.round(width * (0.06 + ((h >> (b + 3)) % 8) / 100));
    const bx = Math.round((b / 9) * width + ((h >> b) % 17));
    const bh = Math.round(height * (0.1 + ((h >> (b + 1)) % 22) / 100));
    for (let y = horizon - bh; y < horizon; y += 1) {
      for (let x = bx; x < Math.min(width, bx + bw); x += 1) blend(x, y, dark[0], dark[1], dark[2], 0.72);
    }
  }
  // 主体轮廓（头 + 肩），位置随镜头号变化
  const cx = Math.round(width * [0.33, 0.5, 0.67][(Number(opts.shotNo) || 1) % 3]);
  const cy = Math.round(height * 0.52);
  const rr = Math.round(height * 0.075);
  for (let y = -rr; y <= rr; y += 1) {
    const half = Math.round(Math.sqrt(Math.max(0, rr * rr - y * y)));
    for (let x = -half; x <= half; x += 1) blend(cx + x, cy + y, dark[0] + 4, dark[1] + 4, dark[2] + 6, 0.9);
  }
  for (let y = cy + rr; y < Math.min(height, cy + rr + Math.round(height * 0.26)); y += 1) {
    const spread = Math.round((y - cy - rr) * 0.9 + rr * 0.7);
    for (let x = cx - spread; x <= cx + spread; x += 1) blend(x, y, dark[0] + 4, dark[1] + 4, dark[2] + 6, 0.9);
  }
  // 轮廓光
  for (let y = cy - rr; y < cy + rr; y += 1) {
    blend(cx - rr - 1, y, accent[0], accent[1], accent[2], 0.5);
    blend(cx + rr + 1, y, accent[0], accent[1], accent[2], 0.25);
  }
  // 取景框与角标
  const pad = Math.round(Math.min(width, height) * 0.035);
  for (let x = pad; x < width - pad; x += 1) {
    blend(x, pad, accent[0], accent[1], accent[2], 0.35);
    blend(x, height - pad, accent[0], accent[1], accent[2], 0.35);
  }
  for (let y = pad; y < height - pad; y += 1) {
    blend(pad, y, accent[0], accent[1], accent[2], 0.35);
    blend(width - pad, y, accent[0], accent[1], accent[2], 0.35);
  }
  return encodePNG(width, height, img);
}
