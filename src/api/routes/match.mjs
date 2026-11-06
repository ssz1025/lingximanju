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
  // 封面对话式创作：对话历史 + 参考图 → AI 回复 + 提示词 + 下一步建议
  coverChat: /^\/api\/projects\/([^/]+)\/cover\/chat$/,
  // 角色管理：从小说提取角色 / 生成角色多视图（字面尾段，先于通用模式）
  charExtract: /^\/api\/projects\/([^/]+)\/characters\/extract$/,
  charViews: /^\/api\/projects\/([^/]+)\/characters\/views$/,
  // AI 生成小说（大纲 / 整本注入）与 AI 补全项目信息（创作设定）
  novelAi: /^\/api\/projects\/([^/]+)\/novel\/ai$/,
  bibleAi: /^\/api\/projects\/([^/]+)\/bible\/ai$/,
  assets: /^\/api\/assets\/?$/,
  // 字面路径优先于下面的 :file 模式匹配（reindex 本身也匹配 [a-zA-Z0-9_.-]+）
  assetReindex: /^\/api\/assets\/reindex$/,
  assetOrphans: /^\/api\/assets\/orphans$/,
  assetBatch: /^\/api\/assets\/batch-delete$/,
  asset: /^\/api\/assets\/([a-zA-Z0-9_.-]+)$/,
  libItem: /^\/api\/comfyui\/library\/(image|video)\/([^/]+)$/,
};
