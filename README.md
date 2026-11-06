# lingximanju · 无限画布 × 智能体制片流水线

> 一个**全量自主编写**、零第三方依赖、可本地独立运行的 AI 影像创作工作台。
> 参考 ViMax 论文（[arXiv:2606.07649v2](https://arxiv.org/abs/2606.07649)；英文原文 PDF、中英全文、导读与配图均已归档在 [`docs/paper/`](docs/paper/README.md)）的方法思想与本地 `ViMax/` 仓库的功能划分，交互范式参考 Toonflow 的无限画布；**未复制任何一方源码**。

![运行形态](https://img.shields.io/badge/Node.js-%3E%3D18-339933) ![依赖](https://img.shields.io/badge/dependencies-0-orange) ![构建](https://img.shields.io/badge/build-none-blue)

---

## 快速开始

```bash
cd lingximanju
./start.sh          # 或： node server.mjs
# 打开 http://127.0.0.1:45367
```

无需 `npm install`、无需构建、无需 API Key。首次打开会自动载入示例项目「雨夜侦探」，点击顶栏 **▶ 运行完整流水线**，即可看到画布随智能体执行自动生长：8 个骨架节点 → 40 个节点（事件、场景、镜头规格、关键帧、VLM 择优、视频片段、转场锚点）。

默认端口 **45367**，刻意避开 3000 / 4173 / 4174 / 5000 / 5173 / 8000 / 8080 / 8188 等常见开发端口，也避开操作系统临时端口段（49152–65535），降低与其他服务冲突的概率。

- 自定义端口：`PORT=8080 node server.mjs`（或 `PORT=8080 ./start.sh`）。
- 端口被占用时默认**自动向后顺延**最多 10 个端口，控制台会打印真实地址，同时写入 `data/.port`；`STRICT_PORT=1` 可关闭顺延（占用即报错退出），`PORT_SCAN=20` 可调整尝试次数。
- `HOST=0.0.0.0` 可允许局域网访问（默认仅 `127.0.0.1`）。

### 两个内置演示项目

| 侧栏名称 | 内容 | 用途 |
|---|---|---|
| `雨夜侦探 · 待运行骨架` | 8 节点 / 6 连线，2 个已就绪 | **默认打开**。点顶栏 ▶ 运行完整流水线，看画布从 8 节点自动长成 40 节点 |
| `雨夜侦探 · 完成示例` | 40 节点 / 60 连线，全部完成，带分镜图与可下载导演包 | 直接查看最终产物与检查器内容，无需运行 |

大图默认以「一屏可见约 39/40 节点」的缩放打开；画布右下角 **⤢ 适应视图** 可缩到全图，滚轮可放大看细节，小地图可拖动导航。若节点全部被移到视口外，画布中央会出现「节点在视口外 · 点击回到内容」按钮，一键找回。侧栏对全部完成的项目显示「全完成」标记。

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| **无限画布** | 自研视口引擎：平移、以指针为中心缩放、节点拖拽、端口连线、框选多选、小地图导航、适应视图、自动布局、撤销重做、右键菜单、拖入式节点库；拖拽松手弹出可选节点 / 连接关系浮层，选完直接连线 |
| **节点化创作流** | 文本 / 剧本 / 事件 / 场景 / 镜头 / 角色 / 关键帧 / 择优 / 视频 / 转场 / 机位图 / 成片 15 类节点，三类连线：数据流 `flow`、视觉锚点 `anchor`、资产引用 `ref` |
| **智能体编排** | 11 个专职智能体 + 1 个画布协作者，DAG 拓扑分层、同层并发、状态机、SSE 实时事件、取消、失败隔离、断点续跑、单节点重跑 |
| **论文机制复刻** | 层次化叙事分解（事件→场景→镜头）、RAG 全局上下文、机位依赖图与视觉锚点传播、转场视频空间锚点、VLM best-of-k 择优、依赖图并行调度 |
| **三条流水线模板** | 一句话→成片、剧本→成片、小说→分集；模板只生成初始节点图，用户可任意改写 |
| **画布 Agent** | 读整张图回答进度、解释依赖、检查一致性、整理画布、真正长出镜头链；支持 `@节点ID` 引用 |
| **可预览产物** | Mock 模式自绘电影分镜 SVG（构图、光影、人物剪影、镜头信息条）、角色三视图、转场图、成片海报；检查器内可直接放大查看 |
| **本地 ComfyUI 主路径** | 图片 / 视频直接提交 ComfyUI「导出(API)」工作流；自动识别节点并注入提示词、种子、尺寸、帧数与首帧，走 `/prompt → /history → /view` 全链路；失败可回退 Mock |
| **两种最终产物** | ① 本地 ComfyUI 片段经 ffmpeg 拼成成片 MP4；② 导演包 `*.mmxpack.zip`，可被 MiniMax H3 Director 等 ComfyUI 导演工作台「Import pack」直接读取 |
| **真实模型可插拔** | LLM 设置页填 Base URL / API Key / Model 即切换 OpenAI 兼容端点；支持自定义图像接口；调用失败自动回退 Mock 并在日志标注 |
| **本地优先** | 项目与资产全部落在 `data/`，支持导出 / 导入 JSON；无账号、无云端存储 |

---

## 界面与交互

```
┌──────────┬────────────────────────────────────────┬─────────────┐
│ 侧栏      │ 顶栏：项目名 / 运行状态 / 运行·布局·设置  │             │
│ 项目列表  ├────────────────────────────────────────┤ 检查器      │
│ 模板      │            无限画布                     │ 节点属性    │
│ 节点库    │   点阵网格 · 节点卡片 · 贝塞尔连线       │ / Agent对话 │
│ 智能体    │   缩放工具栏 · 导航小地图 · 框选          │             │
├──────────┴────────────────────────────────────────┴─────────────┤
│ 状态栏：实时运行日志 · 节点数 · 连线数 · Provider · 缩放比例        │
└──────────────────────────────────────────────────────────────────┘
```

**常用快捷键**：`空格+拖拽/中键` 平移 · `滚轮` 缩放 · `空白处拖拽` 框选 · `右侧端口拖出并松手` 弹出连线选择器 · `双击` 编辑 · `右键` 单节点重跑 · `Ctrl/Cmd+Z` 撤销 · `Ctrl/Cmd+D` 复制 · `Delete` 删除 · `F` 适应视图 · `L` 自动布局 · `R` 运行 · `?` 帮助。

### 拖拽后的连线选择器

拖线松手不再「静默连线或什么都不发生」，而是先给出可选选项，选完立即建立连接：

| 触发动作 | 弹出的选项 | 选择后的结果 |
| --- | --- | --- |
| 从节点右侧端口拖出，**松手在画布空白处** | ① 推荐后继（按 ViMax 流水线顺序）② 全部节点类型 ③ 画布已有节点 | 选类型 → 在松手处新建节点并连一条 `flow`；选已有节点 → 直接连到该节点 |
| 从端口拖出，**松手在另一个节点上** | `flow` 流程依赖 / `anchor` 空间锚点 / `ref` 资产引用 | 按所选关系直接连线；`Enter` 默认是 `flow` |
| 从左侧节点库**拖入画布** | 画布已有节点（按离落点距离排序） | 把新节点接在所选节点之后，`Esc` 可跳过保持独立 |

浮层支持搜索（输入关键词时展开全部分组）、`↑↓` 选择、`Enter` 确认、`Esc` / 点击外部关闭；已有节点默认只显示离鼠标最近的 8 个，避免大图里列表过长。按住 `Alt` / `Shift` 拖线到节点仍可跳过弹窗，直接连 `anchor` / `ref`。实现见 `public/link-picker.js` 与 `app.js` 的 `showNextNodePicker` / `showRelationPicker` / `showAttachPicker`；画布引擎只通过 `onConnectDrop` 上报落点，保持渲染与业务解耦。

**设计取向**：深色优先（可切浅色）、节点按语义着色、运行中的节点呼吸光晕 + 进度条、连线上流动光点表示数据传递、所有状态变化有 160–240ms 过渡、破坏性操作可撤销、首次进入有示例项目与引导便签。

---

## 目录结构

```
lingximanju/
├── server.mjs                  # 单进程入口：静态托管 + REST + SSE
├── start.sh / package.json
├── docs/
│   ├── ARCHITECTURE.md         # 完整架构设计（分层、数据契约、API、画布、体验、扩展点）
│   ├── AGENTS.md               # 智能体编排设计（角色、DAG 算法、事件协议、失败恢复）
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
│   │   ├── store.mjs           # JSON 原子持久化 + 资产落盘
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
│   ├── pipelines/templates.mjs # 三套流水线 → 初始画布图
│   └── api/routes.mjs          # REST + SSE + ComfyUI 配置 + 产物下载
├── examples/workflows/         # 两份可直接改造的「导出(API)」工作流示例
├── public/
│   ├── index.html              # 页面骨架
│   ├── styles.css              # 设计系统
│   ├── canvas.js               # 无限画布引擎（自研）
│   ├── nodes.js                # 节点类型与渲染
│   ├── link-picker.js          # 拖拽松手后的「选择下一个节点 / 连接关系」浮层
│   ├── panels.js               # 检查器 / 对话 / 双 Tab 设置 / 弹窗 / 产物卡片
│   └── app.js                  # 状态机 / API / SSE / 快捷键 / 连线选择器编排
└── data/                       # 运行时：projects/*.json、assets/*、comfyui.json
```

---

## 接入本地 ComfyUI（图片 / 视频主路径）

### 1. 准备

以监听模式启动本机 ComfyUI：`python main.py --listen 127.0.0.1 --port 8188`。在 ComfyUI 里把出图、图生视频工作流各跑通一次，然后用工作流菜单的 **「导出(API) / Export (API)」** 保存 JSON —— 必须是 API 格式（`{节点ID: {class_type, inputs}}`），普通「保存」的界面格式会被明确拒绝。仓库 `examples/workflows/` 下有两份可直接改造的示例。

### 2. 配置

顶栏 ⚙ 设置 → 第二个 Tab「本地 ComfyUI / 最终产物」：填地址 → 分别「导入 JSON」两份工作流 → 「测试连接」→ 需要时点「⌗ 分析」查看自动识别到的注入点 → 设置尺寸 / 帧率 / 采样 / 产物模式 → 保存。配置写入 `data/comfyui.json`（全局复用，不随项目 JSON 走）。

**参数注入分三层，优先级从高到低**：

| 层 | 用法 | 适用 |
|---|---|---|
| 显式绑定 | `settings.bindings.image/video = [{node:'6', input:'text', value:'{{prompt}}'}]` | 节点 ID 不常规、需要精确控制 |
| 占位符 | 在工作流任意字符串输入里写 `{{prompt}}` `{{negative_prompt}}` `{{seed}}` `{{width}}` `{{height}}` `{{frames}}` `{{fps}}` `{{duration}}` `{{filename_prefix}}` `{{title}}` `{{shot_no}}` | 最直观，推荐 |
| 自动识别 | 按 `class_type` 定位：第一个/第二个 `CLIPTextEncode.text` → 正/负提示词；`seed/noise_seed` → 每次随机（避开 ComfyUI 缓存）；`width/height`；`num_frames/frame_count/length` → 镜头时长 × fps；`fps`；`filename_prefix`；`LoadImage.image`；`SaveImage`/`VHS_VideoCombine` 等输出节点 | 不想改工作流时 |

运行时链路：`POST /upload/image`（上传首帧 / 角色参考，SVG 自动渲染成 PNG）→ `POST /prompt` → 轮询 `GET /history/{prompt_id}` → `GET /view` 下载产物到 `data/assets/` → 回填到画布节点。支持超时、取消、`node_errors` 可读化；`strict=false`（默认）时失败自动回退 Mock 并在日志标注。

### 3. 两种最终产物

在设置里把「产物模式」选为 `两种都要` / `只生成成片视频` / `只导出导演包`。成片节点（检查器）与顶栏「▤ 导演包」都可下载。

**① 成片视频**：各镜头由 ComfyUI 视频工作流产出真实片段，若本机有 ffmpeg，则按时间线 concat 成一条 MP4（优先流复制，编码不一致时自动重编码）。没有真实片段时保留逐镜头预览，不会伪造视频文件。

**② 导演包**：默认输出 `*.mmxpack.zip`，遵循 [ComfyUI_MiniMaxH3_Director](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director) 的导入规范，工具栏「Import pack」即可还原时间线：

```
pack.json                          format=minimax-h3-director-pack, formatVersion=1, taskType=fl2v, widgets, output
shared_params/shared_params.json   公共参数：角色一致性提示词 + 参考图槽位
shared_params/Picture1..3.png      角色定妆图（公共槽位）
asset_groups/NN/group.json         逐镜头：提示词、负向词、时长、帧数、首帧、连续性
asset_groups/NN/start.png          镜头首帧（SVG 自动转合法 PNG 占位）
asset_groups/NN/Picture4.png       跨机位空间锚点（组内槽位从 4 续编）
timeline.json                      version 5 完整时间线，导入无损
extra/shots.json                   中文分镜表（人可读）
extra/comfyui_*_workflow_api.json  原始 API 工作流，可直接拖进 ComfyUI
extra/manifest.json / README.md    来源信息与导入步骤
```

路径全部 ASCII、不含模型权重；也可切换「通用 ComfyUI 包」，输出 `manifest.json + shots.json + images/ + workflows/*.json`。

### 4. 相关接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET / PUT | `/api/comfyui/config` | 读取 / 保存全局连接与工作流配置 |
| POST | `/api/comfyui/test` | 探测 `/system_stats`，返回版本与设备 |
| POST | `/api/comfyui/analyze` | 分析一份工作流，返回可注入节点清单 |
| POST | `/api/comfyui/run-test` | 用当前配置试跑一次工作流 |
| GET / POST | `/api/projects/:id/director-pack` | 下载 / 重新生成导演包 |
| GET | `/api/projects/:id/film` | 下载拼接后的成片 MP4 |

LLM 仍可独立配置：设置第一个 Tab 选「OpenAI 兼容接口」并填 Base URL / Key / Model，剧本与分镜规划改走 `/chat/completions`，解析失败自动回退 Mock。密钥只写本地 `data/projects/<id>.json`，不上传第三方。

---

## 边界说明

- **Mock 模式**产出的是可预览的分镜 SVG 与关键帧序列预览，用于完整演示编排、依赖传播与一致性机制，**不是真实视频文件**；产品内也明确标注了这一点。
- **图片 / 视频主路径依赖本机 ComfyUI**：未导入工作流时自动回退 Mock；导演包内的 SVG 槽位图会渲染成合法 PNG 占位，并在 `manifest.json` 与界面中标注，接入出图工作流后自动替换为真实画面。
- **导演包是交接格式，不是渲染器**：它把分镜、首帧、角色参考与完整时间线交给 ComfyUI 导演工作台，视频由对方生成；本项目不内置 MiniMax H3 模型权重与自定义节点。
- ffmpeg 拼接为可选增强，本机缺少 ffmpeg 时保留逐镜头片段与下载入口。
- 未实现 3D 导演台、插件市场、MCP、移动端、多用户协作——这些不属于本次「功能复刻 + 无限画布」的范围。
- 真实出片质量取决于接入的图像/视频模型；框架负责编排、一致性与效率，不提升底座模型本身的画质。

详细设计见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 与 [`docs/AGENTS.md`](docs/AGENTS.md)；论文参考依据与「论文 ↔ 代码」对照表见 [`docs/paper/README.md`](docs/paper/README.md)。

---

## 论文参考资料 · 在其他 IDE 中继续开发

`docs/paper/` 已随仓库归档 ViMax 论文的**英文原版（PDF / 离线 HTML / 可检索 Markdown）、中文全文翻译、核心要点导读、带图阅读版与 16 张配图**，不依赖本工作区外的任何路径，用 VS Code / Cursor / Windsurf / JetBrains 等打开 `lingximanju/` 即可直接阅读；两个 HTML 版均已把图片与样式本地化，断网也能看。

| 场景 | 入口 |
|---|---|
| 了解项目能做什么、怎么跑 | 本文件 `README.md` |
| 改分层 / 数据契约 / API | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| 改智能体 / DAG 调度 / 失败恢复 | [`docs/AGENTS.md`](docs/AGENTS.md) |
| 确认某个机制出自论文哪一节、对应本仓库哪个文件 | [`docs/paper/README.md`](docs/paper/README.md) §4 对照表 |
| 查公式、指标、消融结论 | [`docs/paper/ViMax_论文中文版.md`](docs/paper/ViMax_论文中文版.md) §2–§3 |
| 核对英文原文措辞 / 权威引用 | [`docs/paper/ViMax_原文_EN.md`](docs/paper/ViMax_原文_EN.md)（检索）· [`ViMax_原文_arXiv2606.07649v2.pdf`](docs/paper/ViMax_原文_arXiv2606.07649v2.pdf)（定稿） |

给 AI 助手的上下文建议：先让它读 `README.md` → `docs/ARCHITECTURE.md` → `docs/AGENTS.md`，涉及论文机制时再 `@` 引用 `docs/paper/ViMax_核心要点导读.md` 或全文版。运行只需 `node server.mjs`（Node.js ≥ 18，零依赖、零构建、无需 API Key）。

---

## 验证记录（2026-11-05）

| 项目 | 结果 |
|---|---|
| 后端模块语法 / 智能体注册 | 全部通过，11 个 Agent 注册成功 |
| 完整流水线（Mock） | 8 个骨架节点 → 40 节点 / 60 连线 / 16 波调度 / 约 9.6s / 0 失败 |
| 产物完整性 | 6 个视频片段、30s 时间线、8 条视觉锚点、12 条资产引用、3 个机位、40 个 SVG 资产 |
| 前端运行时 | DOM 模拟环境验证：40 节点、60 连线、13 项节点库、11 个智能体、检查器 / 弹窗 / SSE 状态更新均正常，无运行时错误 |
| 前后端闭环 | 模拟点击「运行完整流水线」→ 真实 SSE 推送 → 画布 8→40 节点实时生长，11.3s 完成，0 错误 |
| 接口 | 项目 CRUD、模板应用、自动布局、导出/导入、Agent 对话、SSE、单节点重跑、取消 均已验证 |
| **ComfyUI 端到端** | mock ComfyUI（`/system_stats` `/upload/image` `/prompt` `/history` `/view`）→ 40 节点 / 16 波 / 8.9s / 0 失败；20 次出图 seed 全唯一、6 段视频、ffmpeg 拼成 h264 MP4、导演包 27 文件 CRC 通过 |
| **双产物切换** | `只导出导演包` 模式跳过本地视频渲染（ComfyUI 视频提交 0 次），产出通用 ComfyUI 包 14 文件；配置与演示数据均已复位 |
| **前端设置 / 产物 UI** | DOM 模拟验证双 Tab 设置、8 个 ComfyUI 字段、Tab 切换、测试连接/保存按钮、成片节点产物卡片与三个下载动作，无运行时错误 |

> 说明：本机沙箱下无头 Chrome 会被系统终止（SIGKILL），因此前端采用 DOM 模拟 + 真实 SSE 通道做运行时验证；页面视觉在常规浏览器中可直接查看。
