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
  // 一键生成全部角色（三视图批量，带进度事件）
  charViewsAll: /^\/api\/projects\/([^/]+)\/characters\/views\/all$/,
  // 剧集详情域：scripts 批量剧本在前，避免被 :no 分支误吞
  episodeScripts: /^\/api\/projects\/([^/]+)\/episodes\/scripts$/,
  episodeItem: /^\/api\/projects\/([^/]+)\/episodes\/(\d+)$/,
  episodeAction: /^\/api\/projects\/([^/]+)\/episodes\/(\d+)\/(script|grids|characters|director-pack|video)$/,
  // AI 生成小说（大纲 / 整本注入）与 AI 补全项目信息（创作设定）
  novelAi: /^\/api\/projects\/([^/]+)\/novel\/ai$/,
  bibleAi: /^\/api\/projects\/([^/]+)\/bible\/ai$/,
  assets: /^\/api\/assets\/?$/,
  // 字面路径优先于下面的 :file 模式匹配（reindex 本身也匹配 [a-zA-Z0-9_.-]+）
  assetReindex: /^\/api\/assets\/reindex$/,
  assetOrphans: /^\/api\/assets\/orphans$/,
  assetBatch: /^\/api\/assets\/batch-delete$/,
  asset: /^\/api\/assets\/([a-zA-Z0-9_.-]+)$/,
  libItem: /^\/api\/comfyui\/library\/(image|video|audio)\/([^/]+)$/,
  // 音色库（全局，多项目共享）：字面动作优先于 :id 模式
  voicesSeed: /^\/api\/voices\/seed$/,
  voicesSample: /^\/api\/voices\/sample$/,
  // 音色抽卡：抽取候选（ComfyUI TTS 工作流跑 N 次）/ 候选池 / 候选转正 / 丢弃
  voiceDraw: /^\/api\/voices\/draw$/,
  voiceDrafts: /^\/api\/voices\/drafts$/,
  voiceDraftSave: /^\/api\/voices\/drafts\/([a-zA-Z0-9_-]+)\/save$/,
  voiceDraftItem: /^\/api\/voices\/drafts\/([a-zA-Z0-9_-]+)$/,
  voiceItem: /^\/api\/voices\/([a-zA-Z0-9_-]+)$/,
  voices: /^\/api\/voices\/?$/,
  // 项目级音色分配：给本项目角色分配 / 查询 / 手动指定
  projectVoiceAssign: /^\/api\/projects\/([^/]+)\/voices\/assign$/,
  projectVoiceStatus: /^\/api\/projects\/([^/]+)\/voices\/status$/,
  projectVoiceSet: /^\/api\/projects\/([^/]+)\/voices\/set$/,
  // 项目级抽卡：按角色条件抽，候选自动挂到该项目
  projectVoiceDraw: /^\/api\/projects\/([^/]+)\/voices\/draw$/,
  // 导演 Agent：技能清单 / 选择 / 一键跑完最终产物全流程
  directorSkills: /^\/api\/projects\/([^/]+)\/director\/skills$/,
  directorRun: /^\/api\/projects\/([^/]+)\/director\/run$/,
  // 短剧成片规格：总时长 / 每片段时长 → 片段数 → 镜头预算与验收
  runtime: /^\/api\/projects\/([^/]+)\/runtime$/,
  // AI 制片对话：对话框驱动全流程（每步记录等价 HTTP 请求，可导出复刻）
  productionChat: /^\/api\/projects\/([^/]+)\/production\/chat$/,
  productionChatExport: /^\/api\/projects\/([^/]+)\/production\/chat\/export$/,
  // 工作台分步对话：每一步独立的会话（历史 / 发送 / 导出 / 清空）+ 每步 token 明细。
  // chat/export 与 chat/clear 必须先于 chat 匹配，否则会被当成普通发送。
  stepChatExport: /^\/api\/projects\/([^/]+)\/steps\/([a-z]+)\/chat\/export$/,
  stepChatClear: /^\/api\/projects\/([^/]+)\/steps\/([a-z]+)\/chat\/clear$/,
  stepChat: /^\/api\/projects\/([^/]+)\/steps\/([a-z]+)\/chat$/,
  stepChatIndex: /^\/api\/projects\/([^/]+)\/steps\/chats$/,
  stepTokens: /^\/api\/projects\/([^/]+)\/steps\/tokens$/,
};
