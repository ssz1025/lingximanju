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
│   │   ├── project-steps.mjs   # 六步定义（含 scope 与论文依据）/ management / 状态机 / 管理动作
│   │   ├── graph.mjs           # DAG 拓扑分层 / 上下游 / 自动布局
│   │   ├── agent.mjs           # Agent 注册表 + 执行上下文
│   │   ├── orchestrator.mjs    # 分层并发调度、join 汇聚、取消、断点续跑
│   │   ├── providers.mjs       # Mock / OpenAI / ComfyUI Provider + 内容生成模板
│   │   ├── artwork.mjs         # 自绘 SVG 分镜 / 三视图 / 转场 / 海报
│   │   ├── comfy-config.mjs    # 全局 ComfyUI 连接与产物配置（data/comfyui.json）
│   │   ├── comfyui.mjs         # API 工作流解析 / 参数注入 / 提交 / 轮询 / 下载
│   │   ├── raster.mjs          # 零依赖 PNG 编码器 + 分镜占位帧栅格化
│   │   ├── zip.mjs             # 零依赖 ZIP 写入器（导演包）
│   │   ├── film.mjs            # ffmpeg 片段拼接 → 成片 MP4
│   │   └── director-pack.mjs   # mmxpack / 通用 ComfyUI 导演包生成
│   ├── agents/
│   │   ├── narrative.mjs       # 编剧 / RAG / 分解 / 角色 / 分镜 / 机位图
│   │   ├── visual.mjs          # 关键帧 / 择优 / 视频 / 转场 / 双产物交付
│   │   ├── canvas-agent.mjs    # 画布协作者
│   │   └── index.mjs
│   ├── pipelines/
│   │   ├── templates.mjs       # 三套流水线 → 初始画布图
│   │   └── novel-project.mjs   # 创作项目构建 / 重新分集（复用 novel2video 的 DAG）
│   └── api/routes.mjs          # REST + SSE + 项目管理 + 六步执行 + ComfyUI 配置 + 产物下载
├── electron/                   # Electron 主进程（多端打包入口，见 README「桌面版安装与分发」）
├── examples/                   # workflows/ 两份 API 工作流 + sample-novel.txt 示例小说
├── public/
│   ├── index.html              # 页面骨架（侧栏 / 三 Tab 检查器 / 画布步骤条）
│   ├── styles.css              # 设计系统 + 四态视觉提示
│   ├── canvas.js               # 无限画布引擎（自研，创作项目层未改动）
│   ├── nodes.js                # 节点类型与渲染（新增 episode 分集节点）
│   ├── wizard.js               # 新建创作项目向导 + 创建后六步引导
│   ├── project-manager.js      # 项目列表 / 六步面板 / 画布步骤条 / 管理面板
│   ├── link-picker.js          # 拖拽松手后的「选择下一个节点 / 连接关系」浮层
│   ├── panels.js               # 检查器 / 对话 / 双 Tab 设置 / 弹窗 / 产物卡片
│   └── app.js                  # 状态机 / API / SSE / 六步执行 / 快捷键
├── tests/                      # node:test 单元与 HTTP 闭环验证（npm test）
└── data/                       # 运行时：projects/*.json、assets/*、snapshots/*、comfyui.json
```
