/* ============================================================================
 * 角色定妆业务层（Character Portrait Service）
 *
 * 职责：把「角色属性 + 全片风格锁 + 已生成视图」变成一组可落盘的定妆资产，
 * 并提供「批量补全 / 完整度报告 / 视频参考图解析」三个上层真正需要的入口。
 *
 * 为什么从 management.mjs 里抽出来：
 *   原来 generateCharacterView 内联在 HTTP 路由里，只有路由能调用。结果画布上的
 *   角色智能体、导演 Agent 一键全流程、剧集导演包全都没法复用同一条定妆链路，
 *   「管理面板里生成的定妆图」与「视频里实际用的参考图」是两套互不相干的数据。
 *   抽成业务层之后，路由只是薄壳，所有路径共用同一口径。
 *
 * 一致性的三层保证：
 *   1) 风格锁：每条提示词都拼同一份全片风格（bible.stylePrompt → artStyle/tone → settings.style）
 *   2) 参考图链：3/4 侧 / 侧面 / 背面 / 面部特写全部以正面图为外观依据，
 *      面部特写额外把正面图作为参考，保证「同一张脸」而不是「同一个描述」
 *   3) 参考图记录：每张图落盘时记录用了哪些参考图与哪份风格锁，可回溯、可复现
 * ==========================================================================*/
import { registerAsset } from './assets.mjs';
import { emit } from './events.mjs';
import { createProviders } from './providers.mjs';
import { resolveModelSettings } from './app-settings.mjs';
import { resolveComfyConfig } from './comfy-config.mjs';
import { buildStyleLock } from './character-style.mjs';
import {
  ALL_VIEW_KEYS, CORE_VIEW_KEYS, DEFAULT_VIEW_KEYS, CHARACTER_VIEWS,
  buildSheetPrompt, buildViewPrompt, characterViewStatus, projectPortraitStatus,
  resolveViewKeys, viewDef, isRealShot,
} from './characters.mjs';

/** 视频 / 关键帧侧最多消费几张参考图：与 ComfyUI 多 LoadImage 插槽上限（8）留余量 */
export const MAX_REFS_PER_CHARACTER = 4;

/** 生成参考图时的默认参考链：正面是身份基准，其余视图一律回引它 */
function refChainFor(character, viewKey) {
  const out = [];
  const front = character?.views?.front?.url;
  if (front && viewKey !== 'front') out.push({ view: 'front', url: front });
  // 3/4 侧既能补「转身中间态」也能补侧脸轮廓，作为第二参考（不参与自身生成）
  const threeQ = character?.views?.threeQuarter?.url;
  if (threeQ && viewKey !== 'threeQuarter' && viewKey !== 'front') {
    out.push({ view: 'threeQuarter', url: threeQ });
  }
  return out.slice(0, 2);
}

/** 角色定妆专用 provider 设置：模型走模型库，ComfyUI 连接与工作流是全局配置（与编排器同口径）。
 *  过去这里漏注入 comfy —— 配了 ComfyUI 也永远走不到真实出图，全部静默回退 Mock 自绘占位图。 */
function portraitProviders(project, modelId, log, interfaceId = '') {
  const cfg = resolveComfyConfig(project);
  return createProviders({
    ...resolveModelSettings(project, modelId),
    // 请求级「本次接口」挂到 config：runComfy 未显式指定时按它解析档案
    comfy: interfaceId ? { ...cfg, requestInterfaceId: String(interfaceId).slice(0, 60) } : cfg,
  }, log);
}

/**
 * 生成单个角色的单个视图，并写回 character.views + 资源库。
 * 单视图路由 / 批量补全 / 定妆智能体 / 导演能力全部走这里，字段口径完全一致。
 *
 * @param {object} o { project, m, character, viewKey, modelId?, styleLock?, requireReal?, log?, signal? }
 * @returns {Promise<{view:string, url:string, provider:string, prompt:string,
 *                    refs:string[], styleLock:string, character:object}>}
 */
export async function generateCharacterView({
  project, m, character, viewKey, modelId = '', styleLock = null, requireReal = false,
  interfaceId = '', log = () => {}, signal,
} = {}) {
  const view = viewDef(viewKey);
  if (!view) throw new Error(`未知视图：${viewKey}（可用：${ALL_VIEW_KEYS.join(' / ')}）`);

  const lock = styleLock || buildStyleLock({ project, management: m });
  const chain = refChainFor(character, view.key);
  const prompt = buildViewPrompt(character, view.key, { styleLock: lock, refs: chain });
  const refs = chain.map((r) => r.url);

  if (view.key !== 'front' && !refs.length) {
    log('warn', `角色定妆 · ${character.name} 缺正面基准图，${view.label}将仅依据文字特征生成，一致性会下降`);
  }

  const providers = portraitProviders(project, modelId, log, interfaceId);
  const img = await providers.image({
    kind: 'character-view', view: view.key, interfaceId,
    label: `${character.name}·${view.label}`,
    prompt, palette: character.palette, views: DEFAULT_VIEW_KEYS,
    style: project.settings?.style || 'cinematic',
    seed: `${project.id}-${character.id}-${view.key}`,
    refs,
    requireReal,
  }, signal);

  const file = String(img.url || '').split('/').pop();
  registerAsset({
    file, kind: 'character', name: `${character.name}·${view.label}`,
    tags: ['角色', '定妆', character.name, view.label, ...(character.aliases || [])].filter(Boolean),
    sourceProjectId: project.id, sourceProjectName: project.name,
  });

  character.views = {
    ...Object.fromEntries(ALL_VIEW_KEYS.map((k) => [k, null])),
    ...character.views,
    [view.key]: {
      file, url: img.url, prompt, provider: img.provider,
      angle: view.angle, refs, styleLock: lock.source, at: Date.now(),
    },
  };
  character.styleLock = `${lock.label} · ${lock.source}`.slice(0, 120);
  character.updatedAt = Date.now();
  m.updatedAt = Date.now();

  return {
    view: view.key, label: view.label, url: img.url, provider: img.provider,
    prompt, refs, styleLock: lock.source,
    refsUsed: img.refsUsed ?? null, refsRequested: img.refsRequested ?? refs.length,
    note: img.note || '', character,
  };
}

/**
 * 生成角色定妆板：多视图并排在一张图里，是视频模型最吃的「角色设定」输入。
 * 已有视图作为参考图逐张传入，没有视图时纯文本生成（并如实标注降级）。
 */
export async function generateCharacterSheet({
  project, m, character, modelId = '', styleLock = null, views = null, requireReal = false,
  interfaceId = '', log = () => {}, signal,
} = {}) {
  const lock = styleLock || buildStyleLock({ project, management: m });
  const keys = (Array.isArray(views) && views.length ? views : DEFAULT_VIEW_KEYS)
    .filter((k) => ALL_VIEW_KEYS.includes(k));
  const refs = keys.map((k) => character.views?.[k]?.url).filter(Boolean).slice(0, MAX_REFS_PER_CHARACTER);
  if (!refs.length) {
    log('warn', `角色定妆板 · ${character.name} 尚无任何视图，将仅按文字描述生成设定板`);
  }
  const prompt = buildSheetPrompt(character, { styleLock: lock, views: keys });

  const providers = portraitProviders(project, modelId, log, interfaceId);
  const img = await providers.image({
    kind: 'character-sheet', label: `${character.name}·设定板`, interfaceId,
    prompt, palette: character.palette, views: keys,
    style: project.settings?.style || 'cinematic',
    seed: `${project.id}-${character.id}-sheet`,
    refs,
    requireReal,
  }, signal);

  const file = String(img.url || '').split('/').pop();
  registerAsset({
    file, kind: 'character', name: `${character.name}·定妆板`,
    tags: ['角色', '定妆', '设定板', character.name, ...(character.aliases || [])].filter(Boolean),
    sourceProjectId: project.id, sourceProjectName: project.name,
  });

  character.sheet = {
    file, url: img.url, prompt, provider: img.provider,
    views: keys, refs, styleLock: lock.source, at: Date.now(),
  };
  character.updatedAt = Date.now();
  m.updatedAt = Date.now();
  return {
    url: img.url, provider: img.provider, prompt, refs, views: keys, styleLock: lock.source,
    note: img.note || '', character,
  };
}

/**
 * 批量补全角色定妆（含定妆板）。
 *
 * @param {object} o
 * @param {object} o.project
 * @param {object} o.m
 * @param {string} o.scope      'core' | 'all' | 显式 key 数组
 * @param {boolean} o.onlyMissing 默认 true：只补缺失的图，已生成的不动（省钱、可断点续跑）
 * @param {boolean} o.regenerateMock 占位图（provider=mock）视为未生成并重出；false 时占位图与真实图同样跳过
 * @param {boolean} o.requireReal 只认本地 ComfyUI 真实出图：工作流未配置 / 调用失败直接报错，绝不回退占位图
 * @param {boolean} o.sheet     是否同时生成定妆板
 * @param {Array} o.characterIds 只处理这些角色（空 = 全部）
 * @param {Function} o.onProgress (evt) => void  逐张回调，供 SSE / 节点进度使用
 * @param {Function} o.log
 * @param {Function} o.save     每张落盘回调（路由传 saveProject，智能体传空以走编排器统一落盘）
 * @returns {Promise<{ok:boolean, total:number, generated:number, skipped:number,
 *                    failed:Array, sheets:number, styleLock:object, status:object, message:string}>}
 */
export async function ensureCharacterPortraits({
  project, m, scope = 'core', onlyMissing = true, sheet = false, characterIds = null,
  regenerateMock = false, requireReal = false, interfaceId = '',
  concurrency = 1, shouldStop = () => false,
  modelId = '', onProgress = () => {}, log = () => {}, save = () => {}, signal,
} = {}) {
  const all = Array.isArray(m?.characters) ? m.characters : [];
  if (!all.length) {
    return {
      ok: false, error: '还没有角色：请先在「角色」页从原著提取或手动新增',
      total: 0, generated: 0, skipped: 0, failed: [], sheets: 0,
      styleLock: buildStyleLock({ project, management: m }),
      status: projectPortraitStatus([], { scope, requireSheet: sheet }),
      message: '没有可生成的角色',
    };
  }

  const wantedIds = Array.isArray(characterIds) && characterIds.length
    ? new Set(characterIds.map(String)) : null;
  const targets = wantedIds ? all.filter((c) => wantedIds.has(String(c.id))) : all;
  if (!targets.length) {
    return {
      ok: false, error: '指定的角色不存在', total: 0, generated: 0, skipped: 0, failed: [], sheets: 0,
      styleLock: buildStyleLock({ project, management: m }),
      status: projectPortraitStatus(all, { scope, requireSheet: sheet }),
      message: '指定的角色不存在',
    };
  }

  const views = resolveViewKeys(scope);
  const lock = buildStyleLock({ project, management: m });
  log('info', `角色定妆 · 风格锁来自 ${lock.source}：${lock.label} · 目标 ${targets.length} 位角色 × ${views.length} 视图${sheet ? ' + 定妆板' : ''}${requireReal ? ' · 只认 ComfyUI 真实出图' : ''}`);

  /** 「只补缺失」时该视图是否真的可以跳过：占位图在 regenerateMock 模式下视同未生成 */
  const skippable = (shot) => onlyMissing && Boolean(shot?.url)
    && !(regenerateMock && !isRealShot(shot));

  const total = targets.length * views.length + (sheet ? targets.length : 0);
  let done = 0;
  let generated = 0;
  let skipped = 0;
  let sheets = 0;
  let cancelled = false;
  const failed = [];

  const tick = (evt) => {
    done += 1;
    onProgress({ done, total, ...evt });
  };

  /** 单个角色内的视图必须按顺序生成（正面是其余视图的身份基准），
   *  跨角色可以并行：ComfyUI 是队列制，2~3 路并行能把 12 位角色的总时长从 40min 压到十几分钟。 */
  const runCharacter = async (c) => {
    for (const key of views) {
      if (shouldStop()) { cancelled = true; return; }
      const label = viewDef(key)?.label || key;
      if (skippable(c.views?.[key])) {
        skipped += 1;
        tick({ characterId: c.id, name: c.name, view: key, label, status: 'skip' });
        continue;
      }
      onProgress({ done, total, characterId: c.id, name: c.name, view: key, label, status: 'running' });
      try {
        const r = await generateCharacterView({
          project, m, character: c, viewKey: key, modelId, styleLock: lock, requireReal,
          interfaceId, log, signal,
        });
        generated += 1;
        // 每张都落盘：中途失败 / 关闭页面也不丢已完成的定妆图
        save();
        tick({ characterId: c.id, name: c.name, view: key, label, status: 'done', provider: r.provider, url: r.url });
      } catch (err) {
        failed.push(`${c.name}·${label}：${err.message}`);
        tick({ characterId: c.id, name: c.name, view: key, label, status: 'error', error: err.message });
      }
    }
    if (sheet) {
      if (shouldStop()) { cancelled = true; return; }
      onProgress({ done, total, characterId: c.id, name: c.name, view: 'sheet', label: '定妆板', status: 'running' });
      if (skippable(c.sheet)) {
        skipped += 1;
        tick({ characterId: c.id, name: c.name, view: 'sheet', label: '定妆板', status: 'skip' });
        return;
      }
      try {
        const sh = await generateCharacterSheet({
          project, m, character: c, modelId, styleLock: lock, views, requireReal,
          interfaceId, log, signal,
        });
        sheets += 1;
        save();
        tick({ characterId: c.id, name: c.name, view: 'sheet', label: '定妆板', status: 'done', provider: sh.provider, url: sh.url });
      } catch (err) {
        failed.push(`${c.name}·定妆板：${err.message}`);
        tick({ characterId: c.id, name: c.name, view: 'sheet', label: '定妆板', status: 'error', error: err.message });
      }
    }
  };

  const lanes = Math.max(1, Math.min(3, Number(concurrency) || 1));
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(lanes, targets.length) }, async () => {
    while (!cancelled && !shouldStop()) {
      const i = cursor;
      cursor += 1;
      if (i >= targets.length) return;
      await runCharacter(targets[i]);
    }
  }));

  const status = projectPortraitStatus(all, { scope, requireSheet: sheet });
  const message = cancelled
    ? `已暂停角色定妆：${targets.length} 位角色 · 新生成 ${generated} 张`
    : `角色定妆完成：${targets.length} 位角色 · 新生成 ${generated} 张`
      + `${sheets ? ` / 定妆板 ${sheets}` : ''}${skipped ? ` · 跳过 ${skipped}` : ''}`
      + `${failed.length ? ` · 失败 ${failed.length}` : ''}`;
  return { ok: failed.length === 0 && !cancelled, cancelled, total, generated, skipped, failed, sheets, styleLock: lock, status, message };
}

/**
 * 判断某个角色是否「足以进入视频生成」。
 * 视频需要的是：至少一张身份基准（正面）+ 一个能对齐脸的近景参考（面部特写或正面）。
 * 真实口径：provider=mock 的占位图不算已生成——「没有真实出图」不能标记为可用。
 * 不满足时返回缺什么，供上层如实提示而不是静默降级。
 */
export function characterReadyForVideo(character = {}) {
  const s = characterViewStatus(character, { scope: 'core' });
  const face = isRealShot(character.views?.closeup) || isRealShot(character.views?.front);
  const body = isRealShot(character.views?.front);
  const missing = [];
  if (!body) missing.push('正面全身基准图');
  if (!face) missing.push('面部参考（正面或面部特写）');
  const hasPlaceholders = s.placeholders.length > 0;
  return {
    ok: missing.length === 0,
    missing,
    placeholders: s.placeholders,
    hasPlaceholders,
    coreComplete: s.coreComplete,
    allComplete: s.allComplete,
    realComplete: s.realComplete,
    hasSheet: s.hasSheet,
    // 推荐但非必需：3/4 侧是大多数叙事机位的实际角度
    recommended: !isRealShot(character.views?.threeQuarter) ? ['3/4 侧'] : [],
    label: missing.length ? `不可用（缺 ${missing.join('、')}）`
      : !s.coreComplete ? (hasPlaceholders
        ? `可进入视频（含 ${s.placeholders.length} 张占位图，建议用 ComfyUI 重新生成）`
        : '可进入视频（缺非必要视图）')
      : hasPlaceholders ? `可进入视频（${s.placeholders.length} 张视图为占位图，建议用 ComfyUI 重新生成）`
      : '可进入视频（基础定妆组齐全）',
  };
}

/** SSE 广播：角色定妆逐张进度，前端据此刷新资源列表与卡片完整度 */
export function emitPortraitProgress(projectId, evt = {}) {
  emit('character:batch', {
    projectId,
    done: evt.done ?? 0,
    total: evt.total ?? 0,
    characterId: evt.characterId || '',
    name: evt.name || '',
    view: evt.view || '',
    label: evt.label || '',
    status: evt.status || 'running',
  });
}

export { CORE_VIEW_KEYS, ALL_VIEW_KEYS, CHARACTER_VIEWS };
