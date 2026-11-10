// 分镜关键帧的「真实出图」口径
//
// 为什么单独成模块：第⑤步的验收、步骤状态自愈、前端统计必须用同一个判定，
// 否则会出现「界面显示 40/40 已出图，实际全是 mock 自绘 SVG」这种假完成。
// 与角色定妆 isRealShot（characters.mjs）保持一致的语义：
//   provider=mock 的示意图 / .svg 占位文件都不算「已生成」。

/** 单张候选图是否为真实出图（mock 自绘 SVG 不算）
 *  opts.allowMock 仅供离线测试夹具：测试没有 ComfyUI，只能产出 mock 图，
 *  用它验证「流程能跑通」；真实项目永远走默认口径，读不到这个开关。 */
export function isRealImage(img, opts = {}) {
  const url = String(img?.url || '');
  if (!url) return false;
  if (String(img?.provider || '') === 'mock') return opts.allowMock === true;
  return !/\.svg(\?|$)/i.test(url);
}

/** 节点上所有有 url 的候选（含占位图） */
export function keyframeCandidates(node) {
  const list = node?.data?.candidates;
  return (Array.isArray(list) ? list : []).filter((c) => c?.url);
}

/** 节点选中的那张图（review 会写 keyframeUrl，未择优时取第一张候选） */
export function keyframeImage(node) {
  const candidates = keyframeCandidates(node);
  const url = node?.data?.keyframeUrl || candidates[0]?.url || '';
  if (!url) return null;
  const hit = candidates.find((c) => c.url === url) || candidates[0] || {};
  return { url, provider: hit.provider || '', prompt: hit.prompt || '', candidates };
}

/** 关键帧节点是否已有真实出图 */
export function isRealKeyframe(node, opts = {}) {
  const candidates = keyframeCandidates(node);
  if (candidates.some((c) => isRealImage(c, opts))) return true;
  return isRealImage({ url: node?.data?.keyframeUrl, provider: node?.data?.keyframeProvider }, opts);
}

/** 项目是否处于「离线测试夹具」模式：只有测试构造的项目会写 testFlags */
export function allowMockArtifacts(project) {
  return project?.testFlags?.allowMockArtifacts === true;
}

/**
 * 全项目关键帧统计：真实图 / 占位图 / 待出图 三分，界面和验收共用。
 * placeholder 指「有图但是 mock 示意」，不能被算成已出图。
 */
export function keyframeTally(project) {
  const opts = { allowMock: allowMockArtifacts(project) };
  const keyframes = (project?.nodes || []).filter((n) => n.type === 'keyframe');
  let real = 0;
  let placeholder = 0;
  let missing = 0;
  for (const node of keyframes) {
    if (isRealKeyframe(node, opts)) real += 1;
    else if (keyframeCandidates(node).length) placeholder += 1;
    else missing += 1;
  }
  return { total: keyframes.length, real, placeholder, missing };
}
