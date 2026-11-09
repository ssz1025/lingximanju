// 角色定妆智能体：把「角色属性 + 全片风格锁」变成一套完整的多视图定妆资产。
//
// 解决的问题（不是新增功能，而是把已有能力接上）：
//   过去定妆图只能从「角色」管理面板逐张点出来，画布节点与导演一键全流程都不产出定妆，
//   于是「面板里修好了定妆图 → 视频里还是拿早期草图」这条断裂一直存在。
//   这里把它注册成一等公民：画布节点、导演能力、路由共用 core/character-portrait.mjs
//   同一条链路，字段口径完全一致。
//
// 与 ViMax CharacterPortraitsGenerator 对齐的部分：
//   1) 正面图作为身份基准，其余视图以它为参考图（不是「同一个文字描述」而是「同一张脸」）
//   2) static / dynamic 特征二分：跨镜头恒定的脸型发型体型写进每条提示词，
//      服饰配饰只在正面基准里定型，后续视图只描述朝向，避免多视图各自漂移
//   3) 每张图记录用了哪些参考图与哪份风格锁，可回溯、可复现
import { defineAgent } from '../core/agent.mjs';
import {
  ALL_VIEW_KEYS, CORE_VIEW_KEYS, characterViewStatus, projectPortraitStatus, viewDef,
} from '../core/characters.mjs';
import { buildStyleLock } from '../core/character-style.mjs';
import {
  characterReadyForVideo, emitPortraitProgress, ensureCharacterPortraits,
} from '../core/character-portrait.mjs';

/** 智能体默认参数：core = 正面 / 3-4 侧 / 侧面 / 背面（全身组），另加面部特写 */
export const DEFAULT_PORTRAIT_SCOPE = 'all';

/**
 * 核心业务：为一个项目批量补全角色定妆（含定妆板）。
 * 纯业务层：落盘交给调用方（编排器 / 路由），本函数只负责生成与状态汇报。
 *
 * @param {object} opts
 * @param {'core'|'all'|'face'|string[]} [opts.scope]   要生成哪些视图
 * @param {boolean} [opts.onlyMissing]                  true = 只补缺失（省钱、可断点续跑）
 * @param {boolean} [opts.sheet]                        是否同时生成定妆板
 * @param {string[]} [opts.characterIds]                只处理指定角色（空 = 全部）
 * @returns {Promise<object>} ensureCharacterPortraits 的返回 + 风格锁与完整度摘要
 */
export async function ensureProjectPortraits({
  project, m, scope = DEFAULT_PORTRAIT_SCOPE, onlyMissing = true, sheet = true,
  characterIds = null, modelId = '', onProgress = () => {}, log = () => {}, save = () => {}, signal,
} = {}) {
  const result = await ensureCharacterPortraits({
    project, m, scope, onlyMissing, sheet, characterIds, modelId, onProgress, log, save, signal,
  });
  const characters = Array.isArray(m?.characters) ? m.characters : [];
  const status = projectPortraitStatus(characters, { scope, requireSheet: sheet });
  const ready = Object.fromEntries(characters.map((c) => [c.id, characterReadyForVideo(c)]));
  const blocked = characters.filter((c) => !ready[c.id]?.ok).map((c) => `${c.name}（缺 ${ready[c.id].missing.join('、')}）`);
  return {
    ...result,
    // 项目级完整度：多少角色「真的可以进视频」，多少还缺基准图
    portraitStatus: status,
    videoReady: {
      total: characters.length,
      ready: characters.filter((c) => ready[c.id]?.ok).length,
      blocked,
      label: blocked.length
        ? `${characters.length - blocked.length}/${characters.length} 位角色可进入视频，${blocked.length} 位缺基准图`
        : `${characters.length} 位角色均可进入视频生成`,
    },
    characters,
  };
}

defineAgent({
  id: 'character-portrait',
  label: '角色定妆智能体',
  group: '资产',
  icon: '🎭',
  color: '#f59e0b',
  description:
    '按全片风格锁为每位角色生成完整多视图定妆（正面 / 3/4 侧 / 侧面 / 背面 / 面部特写）与定妆板，'
    + '以正面图为身份基准逐张回引参考，保证跨视图与跨镜头造型一致；生成的定妆图会进入关键帧、'
    + '镜头片段与导演包的参考图链路。',
  async run(ctx) {
    const m = ctx.project.management || (ctx.project.management = {});
    const characters = Array.isArray(m.characters) ? m.characters : [];
    if (!characters.length) {
      const msg = '还没有角色：请先在「角色」页从原著提取或手动新增，再生成定妆';
      ctx.log('warn', msg);
      ctx.patch({ summary: msg, source: 'empty' });
      return { ok: false, error: msg };
    }

    // 画布节点参数：scope / onlyMissing / includeSheet，未指定时按「完整多视图 + 定妆板」跑
    const data = ctx.node?.data || {};
    const scope = data.scope || DEFAULT_PORTRAIT_SCOPE;
    const onlyMissing = data.onlyMissing !== false;
    const sheet = data.includeSheet !== false;

    const lock = buildStyleLock({ project: ctx.project, management: m });
    ctx.progress(0.05);
    ctx.log('info', `角色定妆 · 风格锁来源 ${lock.source}：${lock.label}`);
    ctx.patch({ styleLock: lock, scope, onlyMissing, includeSheet: sheet });

    const views = scope === 'all' ? ALL_VIEW_KEYS : (Array.isArray(scope) ? scope : CORE_VIEW_KEYS);
    ctx.log('info', `角色定妆 · 目标 ${characters.length} 位角色 × ${views.length} 视图${sheet ? ' + 定妆板' : ''}`);

    const result = await ensureProjectPortraits({
      project: ctx.project, m, scope, onlyMissing, sheet,
      characterIds: Array.isArray(data.characterIds) && data.characterIds.length ? data.characterIds : null,
      modelId: data.modelId || '',
      signal: ctx.signal,
      log: (level, msg) => ctx.log(level, msg),
      // 编排器统一落盘：这里不重复写，避免一次运行内多次全量覆盖项目 JSON
      save: () => {},
      onProgress: (evt) => {
        // 逐张进度：画布节点进度条 + SSE 广播（管理面板同时能看到）
        const ratio = evt.total ? Math.max(0.05, Math.min(0.98, evt.done / evt.total)) : 0.5;
        ctx.progress(ratio);
        ctx.patch({
          done: evt.done, total: evt.total,
          current: evt.name ? `${evt.name}·${evt.label}` : '',
          summary: `定妆进度 ${evt.done}/${evt.total}${evt.name ? ` · ${evt.name}·${evt.label}` : ''}`,
        });
        emitPortraitProgress(ctx.project.id, evt);
      },
    });

    ctx.progress(1);
    ctx.patch({
      generated: result.generated,
      skipped: result.skipped,
      sheets: result.sheets,
      failed: result.failed,
      styleLock: result.styleLock || lock,
      portraitStatus: result.portraitStatus,
      videoReady: result.videoReady,
      characters: m.characters,
      summary: result.message || result.error || '',
    });

    if (result.failed?.length) {
      ctx.log('warn', `定妆失败 ${result.failed.length} 张：${result.failed.slice(0, 3).join('；')}`);
    }
    ctx.log('info', result.message || result.error || '');
    ctx.log('info', `角色定妆 · ${result.videoReady?.label || ''}`);
    if (result.videoReady?.blocked?.length) {
      ctx.log('warn', `以下角色仍缺视频基准图：${result.videoReady.blocked.join('；')}`);
    }
    return result;
  },
});

export { characterViewStatus, projectPortraitStatus, characterReadyForVideo, viewDef };
