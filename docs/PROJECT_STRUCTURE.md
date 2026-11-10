# 目录结构

```
lingximanju/
├── server.mjs                  # 单进程入口：静态托管 + REST + SSE
├── start.sh / package.json
├── docs/
│   ├── ARCHITECTURE.md         # 完整架构设计（§14 创作项目管理层）
│   ├── THEORY.md               # 论文理论依据：式(1)–(8) → 六步 → 代码 / 默认值 / 消融数据
│   ├── AGENTS.md               # 智能体编排设计（角色、DAG 算法、事件协议、失败恢复）
│   ├── INTERFACE.md            # 界面与交互细节（连线选择器、设计取向）
│   ├── COMFYUI.md              # 接入本地 ComfyUI 完整指南
│   ├── PROJECT_STRUCTURE.md    # 本文件：目录结构
│   ├── VERIFICATION.md         # 历次验证记录
│   └── paper/                  # ViMax 论文参考依据（随仓库自包含，其他 IDE 可直接读）
│       ├── README.md           # 索引 + 论文↔代码对照表 + 跨 IDE 开发说明
│       ├── ViMax_核心要点导读.md / ViMax_论文中文版.md
│       ├── ViMax_论文中文阅读版.html     # 中文带图阅读版
│       ├── ViMax_原文_arXiv2606.07649v2.pdf  # 英文原版 PDF（v2）
│       ├── ViMax_原文_官方HTML版.html    # 英文原文离线 HTML（图/样式本地化）
│       ├── ViMax_原文_EN.md              # 英文结构化全文（供 IDE / AI 检索）
│       ├── vimax_paper_figures/          # 16 张配图（各版共用，勿改名）
│       └── assets/                       # 英文 HTML 版离线样式表
├── src/
│   ├── core/
│   │   ├── events.mjs          # 事件总线 + SSE 订阅
│   │   ├── store.mjs           # JSON 原子持久化 + 资产落盘 + 项目快照
│   │   ├── novel.mjs           # 小说解析 / 三种分集策略 / 角色抽取 / 预览校验
│   │   ├── source-view.mjs     # 原著统计纯函数 buildSourceView()：从 source.text 汇总字数/章节/段落/集/季/角色，惰性重建章节与来源关联
│   │   ├── characters.mjs      # 角色域模型：属性归一（含静态/动态特征二分）/ 造型与多视图提示词 / 式(6) 角色召回 / 提取输入组装 / 结果合并
│   │   ├── bm25.mjs            # 检索算法层（零 I/O）：中文 bigram 分词 / 512-128 分块 / BM25 召回 / 归一化重排与阈值过滤 / 近重复去重
│   │   ├── knowledge.mjs       # 式(6) 知识库的磁盘缓存层（data/knowledge/*.json）；算法部分转出 bm25.mjs
│   │   ├── assets.mjs          # 资源索引（index.json 打标签/改名/类型）+ 跨项目角色优先匹配
│   │   ├── project-steps.mjs   # 六步定义（含 scope 与论文依据）/ management / 状态机 / 管理动作；含 director-skill 与 director-palette 动作
│   │   ├── director-skills.mjs # 导演技能单一事实来源：技能清单（4 流程策略 + 10 内置导演风格 + 自定义）/ rebuildDirectorSkills 动态重建 / DIRECTOR_SKILL_GROUPS 分组 / 5 项能力 / planDirectorRun / verifyDirectorDeliverables
│   │   ├── director-styles.mjs # 十位导演美学档案 + 消费函数：DIRECTOR_STYLES / 调色板 / resolveAesthetic / aestheticPrompt / aestheticShotSuffix / aestheticTreatment / resolveProjectAesthetic / 自定义风格注册表（registerCustomStyles，纯内存无 IO）
│   │   ├── director-style-store.mjs # 自定义导演风格持久化（data/director-styles.json）：normalizeCustomStyle 校验归一（与内置同构）/ save·delete upsert / 注册注入 + 技能索引重建
│   │   ├── style-forge-chat.mjs # AI 导演风格设计师对话（无状态草稿回传协议）：styleForgeChat / draftToStyle，产出与 DIRECTOR_STYLES 同构的风格档案
│   │   ├── graph.mjs           # DAG 拓扑分层 / 上下游 / 自动布局
│   │   ├── agent.mjs           # Agent 注册表 + 执行上下文
│   │   ├── orchestrator.mjs    # 分层并发调度、join 汇聚、取消、断点续跑
│   │   ├── providers.mjs       # Mock / OpenAI / ComfyUI Provider + 内容生成模板
│   │   ├── artwork.mjs         # 自绘 SVG 分镜 / 三视图 / 转场 / 海报
│   │   ├── comfy-config.mjs    # 全局 ComfyUI 连接与产物配置（data/comfyui.json）；三类工作流库 image/video/audio + kindOf 归一 + WORKFLOW_KINDS
│   │   ├── comfyui.mjs         # API 工作流解析 / 沿图提示词注入 / 提交 / 轮询 / 下载；另含 TTS 语义自检 describeAudioWorkflow() 与抽卡执行 drawVoiceCandidates()
│   │   ├── voices.mjs          # 全局音色库（data/voices.json）：三种来源 seed/manual/draw，归一 + 打分匹配 + 音频样本 audio + 复现参数 draw
│   │   ├── voice-drafts.mjs    # 音色抽卡候选池（data/voice-drafts.json）：vdr_ 前缀 / 24h TTL / 40 条·单项目 24 条上限 / 淘汰回收音频 / draftToVoice() 转正
│   │   ├── raster.mjs          # 零依赖 PNG 编码器 + 分镜占位帧栅格化
│   │   ├── zip.mjs             # 零依赖 ZIP 写入器（导演包）
│   │   ├── film.mjs            # ffmpeg 片段拼接 → 成片 MP4
│   │   ├── film-policy.mjs     # 成片策略 real / preview：real 下缺真实 AI 片段判 missing，preview 下如实标 degraded
│   │   ├── preview-film.mjs    # 零 Key 关键帧预览成片：本机 ffmpeg 把关键帧渲染成片段拼成 MP4，标 source: 'preview-frames'
│   │   ├── runtime-spec.mjs    # 短剧成片规格单一事实来源：30s / 每片段 3s → 片段数推导、allocateShots 镜头预算、verifyRuntime 时长验收
│   │   ├── episode-script.mjs  # 分集剧本纯函数层：buildScriptVars（上集结尾/钩子/场次预算）/ normalizeEpisodeScript（归一+stats+issues）/ mergeScriptEdit（人工编辑）/ Markdown 导出 / scriptsCoverage
│   │   └── director-pack.mjs   # mmxpack / 通用 ComfyUI 导演包生成
│   ├── agents/
│   │   ├── narrative.mjs       # 编剧 / RAG / 分解 / 角色 / 分镜 / 机位图
│   │   ├── visual.mjs          # 关键帧 / 择优 / 视频 / 转场 / 双产物交付
│   │   ├── character-agent.mjs # 角色提取（原文证据驱动的候选与占位设定）
│   │   ├── character-portrait-agent.mjs # 角色定妆多视图 + 定妆板
│   │   ├── voice-agent.mjs     # 音色分配（启发式匹配，零 Key 标 heuristic）
│   │   ├── director-agent.mjs  # 流程型导演 Agent：原著前置保障 → 能力调度 → executeSteps → 导演包 → 验收报告
│   │   ├── canvas-agent.mjs    # 画布协作者
│   │   └── index.mjs
│   ├── pipelines/
│   │   ├── templates.mjs       # 三套流水线 → 初始画布图
│   │   └── novel-project.mjs   # 创作项目构建 / 重新分集（复用 novel2video 的 DAG）
│   └── api/
│       ├── routes.mjs          # 路由聚合器：跨源访问硬化 + 按域分发
│       ├── http.mjs            # json / readBody 等共用件
│       └── routes/             # system / comfy / management / media / projects / assets / match / director / runtime 各域实现
│                               #   projects.mjs 另含 GET /api/projects/:id/source（原著统计与全文）
│                               #   director.mjs：GET/POST /director/skills（清单 / 选技能 / 切主色调 / 计划 / 验收快照）+ POST /director/run
│                               #   runtime.mjs：GET/POST /runtime（30s·3s 规格快照 / 保存 / 片段时间线 / 验收）
├── electron/                   # Electron 主进程（多端打包入口，见 README「桌面版安装与分发」）
├── examples/                   # workflows/ 两份 API 工作流 + sample-novel.txt 示例小说
├── public/
│   │                           # ── 共享层（零依赖 / 无 DOM 副作用，可被 node:test 直接导入）──
│   ├── utils.js                # 前端唯一一份通用纯工具：esc/escapeHTML、cut、num、fmtNum、fmt、clamp、uid、str、escapeRegExp、$；所有视图与画布引擎统一从这里导入
│   ├── canvas-scope.js         # 画布范围 UI 规则：EMPTY_CANVAS_PROJECT、groupScopeOptions（按季 optgroup）、scopeOptionsSignature、scopeHint、isScopeReadOnly；app.js 只负责把结果写进 DOM
│   │                           # ── 入口与视图 ──
│   ├── index.html              # 页面骨架（项目侧栏 / 首页 / 工作台 / 剧集 / 三 Tab 检查器 / 画布步骤条）；应用级入口统一 .app-only；新增 ··· 更多菜单（#btn-more / #more-menu）与画布范围条（#canvas-scopebar / #canvas-scope）；顶栏右上角 #btn-close-project 是两处退出出口之一（不再有 #btn-home / 项目卡 ✕ / 面包屑关闭）
│   ├── styles.css              # 设计系统（文件头有分区目录与命名约定）+ 四态视觉提示 + 项目侧栏 .ps-* + 项目会话视图显隐；.more-menu / .cs-* 范围条 / .pv-* 工作台 Tab / .sv-* 原著阅读器 / .sx-* 分季分集 / .ax-* 资源归纳；.exit-project（右上角退出）与 .ps-settings .ps-exit（设置区退出）为两处出口的专门样式
│   ├── canvas.js               # 无限画布引擎（自研）；setProject(project, { keepViewport, resetHistory }) 支持切换画布范围时清空撤销栈；clamp / uid 改由 utils.js 提供
│   ├── project-model.js        # 季/集与画布范围的纯函数模型：seasonOf / seasonGroups / assignEpisodeSeason / addSeason / removeSeason / scopeKeyOf / parseScopeKey / localSourceView（后端 /source 不可达时的前端等价回退）
│   ├── source-view.js          # 原著阅读视图：renderSourceView() + sourceStatCards()；六项统计、章节目录、全文/按章阅读、搜索高亮、复制/下载/重新导入
│   ├── canvas-compose.js       # 画布派生纯函数：seedEpisodeCanvas() 播种单集画布、composeOverallCanvas() 按季/集组合总览、canvasScopeLabel() / canvasScopeOptions()
│   ├── nodes.js                # 节点类型与渲染（新增 episode 分集节点）
│   ├── wizard.js               # 新建创作项目向导（只有「项目名称」必填 + 可选一句话构想，其余进项目后补）
│   ├── project-view.js         # 项目工作台（四 Tab）：概览（路线图 / 故事来源 / 项目信息 / 当前步骤）、原著（挂 source-view.js）、分季分集（seasonsHTML：季卡片 / 每集卡片 / 跨季移动 / 本集画布）、资源（assetsHTML：按类型归纳）；setWorkshopTab() 供外部深链
│   ├── director-panel.js       # 导演 Agent 技能面板：按 group 分「制片流程策略 / 导演风格」两栏渲染 14 张卡、风格卡带主色竖条与节奏、选中风格后出现主色调色板（data-dir="palette"）；纯函数导出，无 DOM 副作用
│   ├── project-sidebar.js      # 项目内左侧栏：项目卡与进度（不再放 ✕）/ .ps-links 四快捷入口 / 按季分组的剧集树（每集带 data-ep-canvas）/ 本项目资源列表 / 项目设置（末行 data-act="exit-project" 是两处退出出口之一，回调 onExitProject）；collectProjectAssets（资源归属）、projectChrome（会话外壳与标签标题，页脚含季数）、collectToolStats 为可单测纯函数
│   ├── project-manager.js      # 六步面板（第 ① 步内嵌上传小说入口）/ 画布步骤条 / 管理面板（支持指定 Tab）/ 历史项目列表渲染器
│   ├── asset-manager.js        # 资源库：类型/标签/来源项目筛选 · 搜索 · 改名打标 · 复用选择；支持 files 白名单与 project 动态范围（项目会话内默认「仅本项目」，可一键退出）
│   ├── link-picker.js          # 拖拽松手后的「选择下一个节点 / 连接关系」浮层
│   ├── panels.js               # 检查器 / 对话 / 双 Tab 设置 / 弹窗 / 产物卡片；openSettings / openHelp 接收当前项目，标题与快捷键随项目切换
│   ├── model-picker.js         # AI 入口模型下拉：按「项目 + 入口」隔离记忆（modelScopeKey / setModelProjectScope），项目会话内显示「本项目默认模型」
│   └── app.js                  # 状态机 / API / SSE / 六步执行 / 快捷键；项目会话 requestExitProject（唯一用户出口，两处 UI 共用）→ closeProject、updateChrome、openProjectAssetLibrary、renderCanvasTools、toggleTheme；新增画布范围 activeCanvasGraph / composeGraph / setCanvasScope / updateCanvasScopeUI / openOverallCanvas / openEpisodeCanvas、ensureSourceView（带 localSourceView 回退）、applySeasonMutation、openWorkshopTab、更多菜单绑定与组合画布只读保护 scopeReadOnly()
├── tests/                      # node:test 单元与 HTTP 闭环验证（npm test，304 项）；结构整理新增 utils(8) / canvas-scope(7)，退出出口收敛新增 project-exit(5) 结构契约测试
└── data/                       # 运行时：projects/*.json、assets/*、snapshots/*、comfyui.json
```
