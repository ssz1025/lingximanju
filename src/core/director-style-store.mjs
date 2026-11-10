/* ============================================================================
 * 导演风格持久化（自定义风格 store）· 唯一 IO 层
 *
 * 与 core/director-styles.mjs 的分工：
 *   director-styles.mjs —— 纯逻辑：内置十位档案 + 动态查询（无 IO）
 *   director-style-store.mjs —— 自定义风格的校验、落盘（data/director-styles.json）、
 *     注册注入与技能索引重建（rebuildDirectorSkills）
 *
 * 自定义风格与内置档案同构（同一份美学 schema），因此下游消费方
 * （resolveAesthetic / aestheticPrompt / provider svg 调色板）无需任何改动。
 * ==========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.mjs';
import { registerCustomStyles, allDirectorStyles, styleCard } from './director-styles.mjs';
import { rebuildDirectorSkills } from './director-skills.mjs';

const FILE = path.join(DATA_DIR, 'director-styles.json');
const SCHEMA = 1;
/** 自定义风格容量上限：防止对话刷屏把 JSON 撑爆；超出按最旧淘汰 */
export const CUSTOM_CAPACITY = 40;

let loaded = false;
let cache = [];

/* -------------------------------------------------------------------------- *
 * 校验与归一化：把对话草稿 / 手写 JSON 收敛成与内置档案同构的完整对象
 * -------------------------------------------------------------------------- */
const s = (v, n = 300) => String(v ?? '').trim().slice(0, n);
const HEX = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{1,39}$/;

/** 颜色词 → 色号（对话生成与校验兜底共用） */
export const COLOR_WORDS = {
  '红': '#C81D25', '赤': '#B83227', '橙': '#E2571F', '金': '#C89A4B', '黄': '#D9A441',
  '绿': '#2F4F3A', '青': '#5E8A8C', '蓝': '#1F3B5C', '紫': '#6B3E86', '粉': '#D98BA3',
  '黑': '#12100F', '白': '#DCE0E2', '灰': '#5A6068', '褐': '#8B6B4A', '棕': '#6B5842',
  '银': '#A8B0B8', '墨': '#1C1C1C', '米': '#E8DCC0', '霓虹': '#D99A3C', '青灰': '#8A9A9E',
};

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

function strArray(v, max = 8) {
  const list = Array.isArray(v) ? v : (v ? String(v).split(/[；;\n]/) : []);
  return list.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, max);
}

function paletteList(v) {
  const raw = Array.isArray(v) ? v : [];
  const out = [];
  for (const p of raw.slice(0, 6)) {
    const item = p && typeof p === 'object' ? p : {};
    const hex = String(item.hex || '').trim();
    if (!HEX.test(hex)) continue;
    const name = s(item.name, 12) || '主色';
    out.push({
      key: s(item.key, 24).replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase() || `pal-${out.length + 1}`,
      name, hex,
      mood: s(item.mood, 24),
    });
  }
  return out;
}

/** 内置档案缺失字段时由调色板推导的 Mock 出图配色 */
function svgFromPalettes(palettes) {
  const hex = palettes[0]?.hex || '#C81D25';
  const dim = (h, f) => {
    const n = parseInt(h.slice(1), 16);
    const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * f)));
    const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * f)));
    const b = Math.max(0, Math.min(255, Math.round((n & 255) * f)));
    return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  };
  return {
    sky: [dim(hex, 0.35), dim(hex, 0.6), hex],
    ground: dim(hex, 0.22), fog: '#E8E2D4', accent: hex, text: '#FFF6E8',
  };
}

const PACE_MODES = ['slow', 'fragment', 'kinetic', 'ritual', 'breath', 'contrast', 'silence-burst', 'mixed'];

/**
 * 校验并归一化一份自定义风格。失败抛 Error（路由转 400）。
 * @returns 完整风格对象（与内置 DIRECTOR_STYLES 条目同构 + custom:true）
 */
export function normalizeCustomStyle(input, { existingId = '' } = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const director = s(raw.director, 20);
  const workTitle = s(raw.workTitle, 20);
  const label = s(raw.label, 40) || [workTitle, director].filter(Boolean).join(' · ');
  if (!label) throw new Error('风格名称不能为空（label 或 workTitle + director）');

  const palettes = paletteList(raw.palettes);
  if (!palettes.length) throw new Error('至少需要一个合法主色调（palettes，hex 须为 #RRGGBB）');

  const stylePrompt = s(raw.stylePrompt, 400);
  if (!stylePrompt) throw new Error('stylePrompt（正向风格提示词）不能为空');

  // id：显式提供则沿用（更新场景），否则由名称派生；与内置或其它自定义冲突时加后缀
  let id = s(raw.id, 40).replace(/[^a-zA-Z0-9_-]/g, '-');
  if (!id) id = slugify(raw.id || workTitle || director || label) || `style-${Date.now().toString(36)}`;
  if (!ID_RE.test(id)) id = `style-${id.slice(0, 20)}`.replace(/^-+/, '') || `style-${Date.now().toString(36)}`;
  const taken = new Set(allDirectorStyles().filter((x) => x.id !== existingId).map((x) => x.id));
  if (taken.has(id)) id = `${id}-2`;

  const paceIn = raw.pace && typeof raw.pace === 'object' ? raw.pace : {};
  const mode = PACE_MODES.includes(paceIn.mode) ? paceIn.mode : 'mixed';
  const minShotSec = Math.max(0.5, Math.min(30, Number(paceIn.minShotSec) || 3));
  const maxShotSec = Math.max(minShotSec, Math.min(30, Number(paceIn.maxShotSec) || minShotSec + 5));

  return {
    id,
    icon: s(raw.icon, 4) || '◇',
    label,
    workTitle: workTitle || label,
    director: director || '自定义',
    tagline: s(raw.tagline, 40),
    summary: s(raw.summary, 400),
    palettes,
    defaultPalette: palettes.find((p) => p.key === raw.defaultPalette)?.key || palettes[0].key,
    colorRule: s(raw.colorRule, 200),
    light: s(raw.light, 200),
    composition: s(raw.composition, 200),
    camera: s(raw.camera, 200),
    texture: s(raw.texture, 200),
    taboos: strArray(raw.taboos, 8),
    medium: strArray(raw.medium, 6),
    pace: { minShotSec, maxShotSec, fixedShotRatio: Math.max(0, Math.min(1, Number(paceIn.fixedShotRatio) || 0.5)), mode },
    tone: s(raw.tone, 120),
    visualStyle: s(raw.visualStyle, 300) || stylePrompt,
    pacing: s(raw.pacing, 200),
    shotStrategy: s(raw.shotStrategy, 300),
    audioStrategy: s(raw.audioStrategy, 200),
    continuityRules: strArray(raw.continuityRules, 6),
    risks: strArray(raw.risks, 4),
    stylePrompt,
    negativePrompt: s(raw.negativePrompt, 400)
      || 'washed-out colors, flat lighting, beauty filter, plastic skin, oversaturated rainbow palette, text watermark',
    svg: raw.svg && Array.isArray(raw.svg.sky) && raw.svg.sky.length >= 2
      ? { sky: raw.svg.sky.map((c) => (HEX.test(String(c)) ? String(c) : palettes[0].hex)).slice(0, 3),
        ground: HEX.test(String(raw.svg.ground)) ? String(raw.svg.ground) : svgFromPalettes(palettes).ground,
        fog: HEX.test(String(raw.svg.fog)) ? String(raw.svg.fog) : '#E8E2D4',
        accent: HEX.test(String(raw.svg.accent)) ? String(raw.svg.accent) : palettes[0].hex,
        text: HEX.test(String(raw.svg.text)) ? String(raw.svg.text) : '#FFF6E8' }
      : svgFromPalettes(palettes),
    highlights: strArray(raw.highlights, 4),
    custom: true,
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Date.now(),
  };
}

/* -------------------------------------------------------------------------- *
 * 加载 / 保存 / 删除：每次变更后同步注入注册表并重建技能索引
 * -------------------------------------------------------------------------- */
export function loadCustomStyles() {
  if (loaded) return cache;
  loaded = true;
  cache = [];
  try {
    if (fs.existsSync(FILE)) {
      const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      for (const raw of (Array.isArray(data?.styles) ? data.styles : [])) {
        try { cache.push(normalizeCustomStyle(raw, { existingId: raw?.id })); } catch { /* 单条脏数据不拖垮整体 */ }
      }
    }
  } catch { /* 文件损坏时按空清单处理，保存时会重建 */ }
  registerCustomStyles(cache);
  rebuildDirectorSkills();
  return cache;
}

/** 服务启动后与路由入口各调一次：幂等热加载 */
export function ensureCustomStylesLoaded() {
  return loadCustomStyles();
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, styles: cache }, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

function apply(list) {
  cache = list;
  registerCustomStyles(cache);
  rebuildDirectorSkills();
}

export function listCustomStyles() {
  return loadCustomStyles().map((x) => ({ ...x }));
}

/** 全部风格（内置 + 自定义）的卡片投影，管理页与工作台共用 */
export function listAllStyleCards() {
  loadCustomStyles();
  return allDirectorStyles().map((st) => ({ ...styleCard(st.id), summary: s(st.summary, 160) }));
}

/** 新增 / 更新自定义风格（按 id upsert）。返回 { style, created } */
export function saveCustomStyle(input) {
  loadCustomStyles();
  const existingId = cache.find((x) => x.id === input?.id)?.id || '';
  const style = normalizeCustomStyle(input, { existingId });
  const next = cache.filter((x) => x.id !== style.id);
  next.push(style);
  if (next.length > CUSTOM_CAPACITY) next.splice(0, next.length - CUSTOM_CAPACITY);
  apply(next);
  persist();
  return { style, created: !existingId };
}

/** 删除自定义风格（内置档案不可删）。返回被删对象，不存在返回 null */
export function deleteCustomStyle(id) {
  loadCustomStyles();
  const idx = cache.findIndex((x) => x.id === String(id || ''));
  if (idx < 0) return null;
  const [removed] = cache.splice(idx, 1);
  apply(cache);
  persist();
  return removed;
}
