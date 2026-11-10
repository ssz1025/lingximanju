/* ============================================================================
 * 分镜板智能体（项目级业务 Agent，不产出画布节点）
 *
 * 职责边界：
 *   · 读 / 写「分镜画面设置」（版式、画幅、格内信息、构图参考、提示词公式）；
 *   · 按当前设置把每个剧集段落合成为一张分镜板（纯 SVG，不烧 GPU、不动关键帧）；
 *   · 给第⑤步面板 / 路由 / 步骤收尾提供同一份统计口径（几张板、几格、几张真图）。
 *
 * 为什么单独成一个 Agent：宫格图过去散落在 episode-service 的收尾逻辑里，
 * 路由和步骤各自调用、各自算数，换版式时很容易「面板显示 9 格、实际还是 3×3」。
 * 现在业务口径只在这里，路由与 step-runner 都调它。
 * ==========================================================================*/
import { applyManageAction } from '../core/project-steps.mjs';
import { defineAgent } from '../core/agent.mjs';
import {
  resolveStoryboardSettings, describeStoryboardSettings, cellsOf, layoutOf,
  STORYBOARD_LAYOUTS,
} from '../core/storyboard-settings.mjs';
import { regenerateProjectGrids, collectProjectFrames } from '../core/episode-service.mjs';

/** 只读统计：面板、步骤说明、路由 GET 共用（不产生副作用） */
export function planStoryboardSheets(project, m) {
  const settings = resolveStoryboardSettings(project);
  const layout = layoutOf(settings);
  const allCells = (m?.episodes || []).flatMap((ep) => (ep.segments || []).flatMap((s) => s.cells || []));
  const segments = (m?.episodes || []).reduce((a, ep) => a + (ep.segments || []).length, 0);
  const grids = (m?.episodes || []).reduce((a, ep) => a + (ep.segments || []).filter((s) => s.gridUrl).length, 0);
  const stale = (m?.episodes || []).reduce((a, ep) => a + (ep.segments || [])
    .filter((s) => s.gridUrl && (s.gridLayout !== settings.layout || Number(s.gridCells) !== cellsOf(settings))).length, 0);
  return {
    settings,
    layout: { id: layout.id, label: layout.label, cols: layout.cols, rows: layout.rows, cells: layout.cells },
    layouts: STORYBOARD_LAYOUTS,
    frames: collectProjectFrames(project).length,
    segments,
    grids,
    stale,                        // 换过版式但还没重排的分镜板数量
    // 每格视觉物料覆盖：站位图 / 精确提示词 / 角色参考槽位（任务口径：每格多图）
    visuals: {
      cells: allCells.length,
      blockings: allCells.filter((c) => c.blockingUrl).length,
      promptsReady: allCells.filter((c) => c.videoPrompt).length,
      refSlots: allCells.reduce((a, c) => a + (c.visual?.slots?.length || 0), 0),
    },
    description: describeStoryboardSettings(settings),
  };
}

/**
 * 保存设置（可选）并按当前设置重排全部分镜板。
 * 路由层调用后负责 saveProject + 广播；返回的 message 直接给用户看。
 *
 * @param {object} opts { project, m, patch?, log? }
 */
export async function composeStoryboardSheets({ project, m, patch, log = () => {} } = {}) {
  if (patch && typeof patch === 'object' && Object.keys(patch).length) {
    const saved = applyManageAction(project, 'storyboard', patch);
    if (!saved.ok) return { ok: false, message: saved.message, ...planStoryboardSheets(project, m) };
  }
  const plan = planStoryboardSheets(project, m);
  if (!plan.segments) {
    return {
      ok: true, grids: 0, segments: 0, frames: plan.frames,
      settings: plan.settings, description: plan.description,
      message: '还没有分段：先完成第②步分集拆解，再重排分镜板',
    };
  }
  const out = await regenerateProjectGrids(project, m, {
    settings: plan.settings,
    log: (level, message) => log(level, `分镜板 · ${message}`),
  });
  const realNote = plan.frames ? `${plan.frames} 张真实分镜图入板` : '还没有真实分镜图（格内为占位 / 待出图）';
  const v = out.visuals || { blockings: 0, promptsReady: 0, refSlots: 0 };
  return {
    ok: true,
    grids: out.grids,
    segments: out.segments,
    episodes: out.episodes,
    frames: plan.frames,
    cells: out.cells,
    layout: out.layout,
    settings: out.settings,
    description: out.description,
    visuals: {
      blockings: v.blockings, promptsReady: v.promptsReady, refSlots: v.refCount ?? v.refSlots ?? 0,
    },
    message: `已按「${out.description}」重排 ${out.grids} 张分镜板 · ${realNote} · 每格物料：站位图 ${v.blockings} 张、图生视频提示词 ${v.promptsReady} 格、角色参考槽位 ${v.refCount ?? v.refSlots ?? 0} 个`,
  };
}

// 注册为智能体清单里的一等公民（与音色分配 / 导演同口径）：可在画布上作为
// 「分镜板合成」节点运行，也让 /api/bootstrap 的 agents 清单能查到它的能力说明。
// 它仍属于项目级业务 Agent——产物写进 management.episodes[].segments[].gridUrl，
// 不新建画布节点。
defineAgent({
  id: 'storyboard-sheets',
  label: '分镜板智能体',
  group: '镜头',
  icon: '⌗',
  color: '#38bdf8',
  description: '读写分镜画面设置（九宫格 / 六宫格 / 四宫格 / 条漫四联 / 二十五宫格 / 单图），按版式把每段真实分镜图合成一张分镜板，并为每个分镜画面补齐视觉物料包：出场角色的定妆多视图 / 妆照参考、新生成站位图、宫格视图与精确提示词（首帧出图 + 图生视频），纯 SVG 重排不动关键帧。',
  async run(ctx) {
    const m = ctx.project.management || (ctx.project.management = {});
    ctx.progress(0.2);
    ctx.log('info', `正在按「${describeStoryboardSettings(resolveStoryboardSettings(ctx.project))}」重排分镜板，并为每格补齐站位图与精确提示词…`);
    const result = await composeStoryboardSheets({
      project: ctx.project, m, log: (level, message) => ctx.log(level, message),
    });
    ctx.progress(0.95);
    ctx.patch({ grids: result.grids, cells: result.cells, description: result.description, visuals: result.visuals, summary: result.message });
    ctx.log(result.ok ? 'info' : 'warn', result.message);
    return result;
  },
});
