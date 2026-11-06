// 自绘 SVG 资产生成器：Mock 模式下产出可预览的分镜图 / 角色三视图 / 转场图 / 海报
// 不依赖任何图像库，全部用确定性字符串绘制，保证同一输入永远得到同一画面。

export function hash(str = '') {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}

const PALETTES = {
  cinematic: { sky: ['#1c2a41', '#3a506b', '#e0a06a'], ground: '#101722', fog: '#8fa9c4', accent: '#ff9a5c', text: '#eef3fa' },
  noir:      { sky: ['#0d1118', '#25313d', '#8b98a5'], ground: '#090c11', fog: '#aab6c2', accent: '#d8e2ec', text: '#f2f5f8' },
  anime:     { sky: ['#2b3f7a', '#7a6fc4', '#ffb3a7'], ground: '#1b2447', fog: '#c9c6f2', accent: '#ffd76e', text: '#ffffff' },
  watercolor:{ sky: ['#dfe9e3', '#b9d3cf', '#f2c9a0'], ground: '#788f86', fog: '#ffffff', accent: '#c97b5a', text: '#2a3b3a' },
};

export function palette(style = 'cinematic') {
  return PALETTES[style] || PALETTES.cinematic;
}

function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function svgFrame({ w = 640, h = 360, inner, defs = '' }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
<defs>${defs}
<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="0.06"/></feComponentTransfer></filter>
<filter id="glow"><feGaussianBlur stdDeviation="16"/></filter>
</defs>${inner}
<rect width="${w}" height="${h}" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="2"/>
<rect width="${w}" height="${h}" filter="url(#grain)" opacity=".5"/>
</svg>`;
}

/** 电影分镜画面：远景层次 + 人物剪影 + 光影 + 镜头信息条 */
export function storyboardSVG(opts = {}) {
  const {
    title = '未命名镜头', shotNo = 1, size = '中景', angle = '平视',
    movement = '固定', prompt = '', style = 'cinematic', characters = [],
    seed = '', kind = 'keyframe',
  } = opts;
  const p = palette(style);
  const seedNum = hash(`${seed}|${prompt}|${shotNo}|${kind}`);
  const rnd = (n, min = 0, max = 1) => min + ((seedNum >> n) % 1000) / 1000 * (max - min);
  const w = 640, h = 360;
  const horizon = 214 + Math.round(rnd(3, -26, 26));
  const sunX = 90 + Math.round(rnd(5, 0, 460));
  const sunY = 70 + Math.round(rnd(7, 0, 80));
  const people = Math.max(1, Math.min(3, characters.length || 1 + Math.round(rnd(9, 0, 1.4))));

  const hills = [0, 1, 2].map((i) => {
    const y = horizon - 18 - i * 26;
    const amp = 18 + rnd(11 + i, 0, 26);
    return `<path d="M0 ${y + 40} Q ${160 + i * 30} ${y - amp} 320 ${y + 8} T 640 ${y + 34} L640 360 L0 360 Z" fill="${p.ground}" opacity="${0.36 + i * 0.22}"/>`;
  }).join('');

  const buildings = Array.from({ length: 7 }, (_, i) => {
    const bw = 26 + rnd(i + 20, 0, 40);
    const bh = 30 + rnd(i + 30, 0, 96);
    const bx = i * 96 + rnd(i + 40, -18, 18);
    return `<rect x="${bx.toFixed(0)}" y="${(horizon - bh).toFixed(0)}" width="${bw.toFixed(0)}" height="${bh.toFixed(0)}" fill="${p.ground}" opacity=".72"/>
      <rect x="${(bx + 5).toFixed(0)}" y="${(horizon - bh + 9).toFixed(0)}" width="4" height="6" fill="${p.accent}" opacity=".5"/>`;
  }).join('');

  const silhouettes = Array.from({ length: people }, (_, i) => {
    const cx = 190 + i * 128 + rnd(i + 50, -30, 30);
    const scale = 0.85 + rnd(i + 60, 0, 0.5);
    const bodyH = (96 + rnd(i + 70, 0, 26)) * scale;
    const headR = 13 * scale;
    const baseY = horizon + 116;
    const fill = i === 0 ? '#070b12' : '#0b111c';
    return `<g opacity=".92" fill="${fill}">
      <circle cx="${cx.toFixed(0)}" cy="${(baseY - bodyH - headR * 2).toFixed(0)}" r="${headR.toFixed(1)}"/>
      <path d="M ${(cx - 19 * scale).toFixed(0)} ${(baseY - bodyH).toFixed(0)}
        Q ${cx.toFixed(0)} ${(baseY - bodyH - 12).toFixed(0)} ${(cx + 19 * scale).toFixed(0)} ${(baseY - bodyH).toFixed(0)}
        L ${(cx + 24 * scale).toFixed(0)} ${baseY} L ${(cx - 24 * scale).toFixed(0)} ${baseY} Z"/>
      </g>`;
  }).join('');

  const bar = `<g>
    <rect x="0" y="0" width="640" height="42" fill="#080b12" opacity=".82"/>
    <rect x="0" y="318" width="640" height="42" fill="#080b12" opacity=".86"/>
    <text x="18" y="27" fill="${p.accent}" font-family="ui-monospace,Menlo,monospace" font-size="14" font-weight="700">SHOT ${String(shotNo).padStart(2, '0')}</text>
    <text x="104" y="27" fill="${p.text}" font-family="PingFang SC,Microsoft YaHei,sans-serif" font-size="14" font-weight="600">${esc(title)}</text>
    <text x="18" y="344" fill="${p.text}" opacity=".82" font-family="PingFang SC,Microsoft YaHei,sans-serif" font-size="12">${esc(size)} · ${esc(angle)} · ${esc(movement)}</text>
    <text x="622" y="344" text-anchor="end" fill="${p.accent}" opacity=".9" font-family="ui-monospace,Menlo,monospace" font-size="11">LINGXIMANJU / ${esc(kind.toUpperCase())}</text>
  </g>`;

  const defs = `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${p.sky[0]}"/><stop offset="58%" stop-color="${p.sky[1]}"/><stop offset="100%" stop-color="${p.sky[2]}"/>
    </linearGradient>
    <radialGradient id="sun"><stop offset="0%" stop-color="${p.accent}" stop-opacity=".85"/><stop offset="100%" stop-color="${p.accent}" stop-opacity="0"/></radialGradient>`;

  const inner = `
    <rect width="640" height="360" fill="url(#sky)"/>
    <circle cx="${sunX}" cy="${sunY}" r="130" fill="url(#sun)"/>
    <circle cx="${sunX}" cy="${sunY}" r="26" fill="${p.accent}" opacity=".55" filter="url(#glow)"/>
    <rect x="0" y="${horizon}" width="640" height="${360 - horizon}" fill="${p.ground}" opacity=".55"/>
    ${buildings}${hills}
    <rect x="0" y="${horizon - 4}" width="640" height="10" fill="${p.fog}" opacity=".10"/>
    ${silhouettes}
    <rect x="0" y="0" width="640" height="360" fill="${p.sky[0]}" opacity=".08"/>
    ${bar}`;
  return svgFrame({ w, h, inner, defs });
}

/** 角色三视图：正面 / 侧面 / 背面 + 色板 */
export function characterSVG(opts = {}) {
  const { name = '角色', appearance = '', style = 'cinematic', seed = '' } = opts;
  const p = palette(style);
  const w = 640, h = 360;
  const figure = (cx, flip = 1) => `<g transform="translate(${cx} 0) scale(${flip} 1)" fill="#0b111c" opacity=".9">
      <circle cx="0" cy="106" r="22"/>
      <path d="M-30 132 Q0 120 30 132 L38 258 L-38 258 Z"/>
      <path d="M-38 258 L-24 320 L-8 320 L-6 258 Z M38 258 L24 320 L8 320 L6 258 Z"/>
      <rect x="-34" y="136" width="68" height="10" fill="${p.accent}" opacity=".55"/>
    </g>`;
  const inner = `<rect width="640" height="360" fill="${p.sky[0]}"/>
    <rect x="0" y="0" width="640" height="46" fill="#080b12" opacity=".85"/>
    <text x="20" y="30" fill="${p.accent}" font-family="PingFang SC,Microsoft YaHei,sans-serif" font-size="17" font-weight="700">${esc(name)} · 角色定妆三视图</text>
    ${[130, 320, 510].map((x, i) => `<g>
      <rect x="${x - 78}" y="60" width="156" height="250" rx="10" fill="${p.sky[1]}" opacity=".28" stroke="rgba(255,255,255,.12)"/>
      ${figure(x, i === 1 ? -1 : 1)}
      <text x="${x}" y="302" text-anchor="middle" fill="${p.text}" font-size="12" font-family="PingFang SC,sans-serif" opacity=".8">${['正面', '侧面', '背面'][i]}</text>
    </g>`).join('')}
    <text x="20" y="340" fill="${p.text}" opacity=".72" font-size="12" font-family="PingFang SC,sans-serif">${esc(appearance || '造型设定由角色智能体生成')}</text>
    <g transform="translate(560 330)">${['#0b111c', p.sky[1], p.accent, p.fog].map((c, i) => `<circle cx="${i * 18}" cy="0" r="7" fill="${c}"/>`).join('')}</g>`;
  return svgFrame({ w, h, inner });
}

/** 转场/空间锚点图：左右机位 + 中间平滑过渡带 */
export function transitionSVG(opts = {}) {
  const { from = '机位 A', to = '机位 B', style = 'cinematic', seed = '' } = opts;
  const p = palette(style);
  const inner = `<rect width="640" height="360" fill="${p.sky[0]}"/>
    <rect x="0" y="0" width="300" height="360" fill="${p.sky[1]}" opacity=".55"/>
    <rect x="340" y="0" width="300" height="360" fill="${p.sky[2]}" opacity=".30"/>
    <rect x="290" y="0" width="60" height="360" fill="${p.accent}" opacity=".18"/>
    <g stroke="${p.accent}" stroke-width="2" fill="none" opacity=".8">
      <path d="M60 200 Q 320 80 580 200" stroke-dasharray="8 8"/>
      <circle cx="60" cy="200" r="7" fill="${p.accent}"/><circle cx="580" cy="200" r="7" fill="${p.accent}"/>
    </g>
    <text x="30" y="40" fill="${p.text}" font-size="14" font-family="PingFang SC,sans-serif">${esc(from)}</text>
    <text x="610" y="40" text-anchor="end" fill="${p.text}" font-size="14" font-family="PingFang SC,sans-serif">${esc(to)}</text>
    <text x="320" y="330" text-anchor="middle" fill="${p.accent}" font-size="13" font-family="ui-monospace,monospace">SPATIAL ANCHOR · TRANSITION</text>`;
  return svgFrame({ inner });
}

/** 成片海报 */
export function posterSVG(opts = {}) {
  const { title = '未命名影片', shotCount = 0, duration = 0, style = 'cinematic' } = opts;
  const p = palette(style);
  const inner = `<rect width="640" height="360" fill="${p.sky[0]}"/>
    <circle cx="500" cy="90" r="150" fill="${p.accent}" opacity=".18" filter="url(#glow)"/>
    <rect x="0" y="230" width="640" height="130" fill="${p.ground}" opacity=".8"/>
    <text x="44" y="150" fill="${p.text}" font-size="38" font-weight="800" font-family="PingFang SC,Microsoft YaHei,sans-serif">${esc(title)}</text>
    <rect x="44" y="168" width="52" height="4" fill="${p.accent}"/>
    <text x="44" y="286" fill="${p.text}" opacity=".85" font-size="14" font-family="ui-monospace,monospace">${shotCount} SHOTS · ${duration.toFixed(1)}s · LINGXIMANJU PREVIEW</text>
    <text x="44" y="316" fill="${p.fog}" opacity=".7" font-size="12" font-family="PingFang SC,sans-serif">预览由 Mock 生成器绘制 · 接入真实模型后可导出成片</text>`;
  return svgFrame({ inner, defs: '' });
}
