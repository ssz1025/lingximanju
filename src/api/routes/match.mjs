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
  // AI 一键生成封面：不依赖 ComfyUI（有图像接口/工作流时真实出图，否则内置海报占位）
  coverAi: /^\/api\/projects\/([^/]+)\/cover\/ai$/,
  // 角色管理：从小说提取角色 / 生成角色多视图（字面尾段，先于通用模式）
  charExtract: /^\/api\/projects\/([^/]+)\/characters\/extract$/,
  charViews: /^\/api\/projects\/([^/]+)\/characters\/views$/,
  // 一键生成全部角色（三视图批量，带进度事件）
  charViewsAll: /^\/api\/projects\/([^/]+)\/characters\/views\/all$/,
  // 单镜头重出分镜图：只复位这一镜的关键帧 + 择优，不影响其它已出图的镜头
  shotRegen: /^\/api\/projects\/([^/]+)\/storyboard\/shots\/([^/]+)\/regen$/,
  // ComfyUI 任务对账：把 ComfyUI 已完成但页面还显示排队中的任务取回，
  // 仍在队列的保留状态（不重发），查无结果的才在 resubmit=true 时重新发送
  comfyReconcile: /^\/api\/projects\/([^/]+)\/comfy\/reconcile$/,
  // 分镜画面设置与分镜板：GET 读取设置 + 统计，POST 保存设置并按版式重排分镜板
  // （纯 SVG 合成，不烧 GPU，也不动已出的关键帧）
  storyboardSheets: /^\/api\/projects\/([^/]+)\/storyboard\/sheets$/,
  // 角色定妆后台任务：列表（项目最近一次）/ 单个任务查询（含进度，刷新页面可恢复）
  charJobs: /^\/api\/projects\/([^/]+)\/characters\/jobs$/,
  charJob: /^\/api\/projects\/([^/]+)\/characters\/jobs\/([a-zA-Z0-9_-]+)$/,
  // 剧集详情域：scripts 批量剧本在前，避免被 :no 分支误吞
  episodeScripts: /^\/api\/projects\/([^/]+)\/episodes\/scripts$/,
  // 分集制作批量执行（第⑤⑥⑦步按集）：POST /episodes/steps {stepId, nos[], force, comfy}
  episodeStepBatch: /^\/api\/projects\/([^/]+)\/episodes\/steps$/,
  // 单集剧本导出 / 全项目剧本导出（必须在 script 动作与 :no 之前理解，路径多一层）
  episodeScriptExport: /^\/api\/projects\/([^/]+)\/episodes\/(\d+)\/script\/export$/,
  projectScriptExport: /^\/api\/projects\/([^/]+)\/scripts\/export$/,
  episodeItem: /^\/api\/projects\/([^/]+)\/episodes\/(\d+)$/,
  // step = 分集制作单集执行（④角色和上下文 / ⑤分镜与画面 / ⑥视频与交付）
  // film = 本集成片下载（GET）
  episodeAction: /^\/api\/projects\/([^/]+)\/episodes\/(\d+)\/(script|grids|characters|director-pack|video|film|step)$/,
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
  // 媒体生成接口档案：单个档案的改参数 / 删除（列表与导入走字面路径）
  interfaceItem: /^\/api\/comfyui\/interfaces\/([^/]+)$/,
  // 接口输入参数清单（含工作流本体，供设置页可视化编辑）与接口 JSON 替换
  interfaceSchema: /^\/api\/comfyui\/interfaces\/([^/]+)\/schema$/,
  interfaceWorkflow: /^\/api\/comfyui\/interfaces\/([^/]+)\/workflow$/,
  // 参数表媒体槽位（图片 / 视频 / 音频）的上传与资源库复用：一次上传双写本地资源库与 ComfyUI 输入目录
  interfaceMedia: /^\/api\/comfyui\/interfaces\/([^/]+)\/media$/,
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
  // 导演风格统一管理（项目无关）：清单 / 保存 / 删除 / AI 对话生成。
  // chat 必须先于 :id 匹配，否则 "chat" 会被当成风格 id。
  directorStyleChat: /^\/api\/director-styles\/chat$/,
  directorStyleItem: /^\/api\/director-styles\/([A-Za-z0-9_-]+)$/,
  directorStylesRoot: /^\/api\/director-styles$/,
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
