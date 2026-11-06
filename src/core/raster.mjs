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
