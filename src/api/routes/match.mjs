// 各域路由共用的路径正则。集合互斥（尾段 / 段结构各不相同），域间分发顺序不影响匹配结果。
export const MATCH = {
  project: /^\/api\/projects\/([^/]+)$/,
  projectAction: /^\/api\/projects\/([^/]+)\/(template|run|stop|chat|arrange|export)$/,
  // 极简创建后延迟上传小说：解析 + 分集 + 完成 ①② 步
  source: /^\/api\/projects\/([^/]+)\/source$/,
  manageAction: /^\/api\/projects\/([^/]+)\/(manage|duplicate|snapshots|restore|step)$/,
  deliverable: /^\/api\/projects\/([^/]+)\/(director-pack|film)$/,
  cover: /^\/api\/projects\/([^/]+)\/cover$/,
  coverGenerate: /^\/api\/projects\/([^/]+)\/cover\/generate$/,
  assets: /^\/api\/assets\/?$/,
  // 字面路径优先于下面的 :file 模式匹配（reindex 本身也匹配 [a-zA-Z0-9_.-]+）
  assetReindex: /^\/api\/assets\/reindex$/,
  assetOrphans: /^\/api\/assets\/orphans$/,
  assetBatch: /^\/api\/assets\/batch-delete$/,
  asset: /^\/api\/assets\/([a-zA-Z0-9_.-]+)$/,
  libItem: /^\/api\/comfyui\/library\/(image|video)\/([^/]+)$/,
};
