# lingximanju 架构设计

> 版本 1.0 · 2026-11-05 · 全量代码自主编写，未复制 ViMax / Toonflow 任何源码
> 参考来源：ViMax 论文（arXiv:2606.07649v2）的方法思想、本地 `ViMax/` 仓库的功能划分、Toonflow 无限画布的交互范式

---

## 1. 产品定位

**lingximanju = 无限画布 × 智能体制片流水线。**

把 ViMax 论文里那条「创意 → 剧本 → 分层叙事规划 → 分镜 → 关键帧 → 视频 → 成片」的自动化流水线，拆成**画布上可见、可编辑、可单独重跑的节点图**；同时引入 Toonflow 式的无限画布工作范式：文本、角色、场景、分镜、图像、视频、Agent 全部是节点，用连线表达依赖与视觉锚点，画布侧有一个能读图、能改图、能解释的 Agent 助手。

与参考对象的关系：

| 参考对象 | 借鉴 | 本项目自己的做法 |
|---|---|---|
| ViMax 论文 | 分层叙事分解 + RAG、机位依赖图 + 视觉锚点、转场视频空间锚点、VLM best-of-k、依赖图并行调度 | 全部以自研 DAG 编排器 + 节点数据模型重新实现；把「机位树」显式画成 `camera`/`anchor` 连线 |
| `ViMax/` 仓库 | 三条入口流水线、角色三视图、参考图选择、Provider 协议、断点续跑思想 | 代码零复用；用 Node 单进程重写，产物改为画布节点 + JSON 快照 |
| Toonflow | 无限画布、文本/图像/视频节点、引用式连线、资产复用、浮动 Agent、节点级重生成、自动整理 | 自研画布引擎（不依赖 Vue Flow / React Flow），自研节点渲染与 Agent 面板 |

**明确不做**：不训练/托管任何生成模型；不实现 3D 导演台、插件市场、MCP、移动端。模型能力通过 Provider 接口接入，默认提供确定性 Mock 实现，保证「零 Key 也能完整跑通流程」。

---

## 2. 技术选型与理由

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node.js ≥ 18（原生 ESM） | 前后端同语言，零 `npm install`，一条命令启动；原生 `fetch` 便于接 OpenAI 兼容接口 |
| 服务端 | 原生 `node:http` 自研路由 | 不引入 Express/FastAPI，代码完全自主；SSE 用原生 `res.write` 即可 |
| 前端 | 原生 HTML + CSS + ES Modules | 无构建、无框架、无虚拟 DOM；画布直接操作 DOM/SVG，性能与可控性最好 |
| 画布 | 自研 `CanvasController` | 平移/缩放/拖拽/连线/框选/小地图/撤销重做全部自主实现，不依赖 React Flow |
| 存储 | 本地 JSON 文件 + 静态资产目录 | 本地优先、可备份、可导出；`data/projects/*.json`、`data/assets/*` |
| 实时通道 | SSE（Server-Sent Events） | 单向流式、断线自动重连，比 WebSocket 更适合「运行日志 + 节点状态」 |
| 模型接入 | Provider 抽象（mock / openai / **comfyui**） | LLM 走 OpenAI 兼容端点；图片与视频主路径为本地 ComfyUI「导出(API)」工作流，失败自动回退 mock |
| 媒体封装 | 自研 PNG 编码、ZIP 写入、ffmpeg 拼接 | 导演工作台只接受 png/jpg 槽位图与 zip 包；保持零第三方依赖，不引入 sharp / archiver / fluent-ffmpeg |

启动：`node server.mjs` → 同时提供静态页面、REST API、SSE 事件流、生成资产，默认 `http://127.0.0.1:45367`。端口刻意选在冷门区间（避开 3000/4173/4174/5000/5173/8000/8080/8188 与系统临时端口段 49152–65535）；`PORT` / `HOST` 环境变量可覆盖，`EADDRINUSE` 时自动向后顺延并把真实端口写入 `data/.port`，`STRICT_PORT=1` 可关闭顺延。

---

## 3. 分层架构

```
┌──────────────────────────────────────────────────────────────┐
│  表现层  public/                                              │
│  index.html  页面骨架 / 侧栏 / 顶栏 / 检查器 / 状态栏           │
│  canvas.js   无限画布引擎（视口变换、交互、小地图、撤销）        │
│  nodes.js    节点类型注册表与 DOM 渲染                         │
│  panels.js   检查器、Agent 对话、设置、资产预览、Toast           │
│  app.js      应用状态机、API 客户端、SSE 订阅、事件绑定          │
│  styles.css  设计系统（深色优先、节点语义色、动效、响应式）      │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTP JSON + SSE（/api/*）
┌───────────────────────────▼──────────────────────────────────┐
│  接口层  src/api/routes.mjs                                   │
│  REST：项目 / 节点 / 连线 / 运行 / 模板 / 设置 / 导出 / 对话     │
│  SSE ：/api/events  广播 node:status、node:data、log、graph     │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│  编排层  src/core/ + src/agents/ + src/pipelines/              │
│  orchestrator  拓扑分层 → 同层并发 → 状态机 → 事件 → 取消       │
│  agent         Agent 基类 / Registry / 执行上下文                │
│  graph         DAG 校验、拓扑排序、下游子图、自动布局数据          │
│  events        事件总线 + SSE 订阅管理                          │
│  store         JSON 持久化、原子写入、撤销无关的服务端快照         │
│  providers     LLM / Image / Video / Judge 四类能力适配器         │
│  comfyui       API 工作流解析、参数注入、提交、轮询、产物下载       │
│  comfy-config  全局 ComfyUI 连接 / 工作流 / 产物配置                │
│  raster / zip  自研 PNG 编码器与 ZIP 写入器                        │
│  film          ffmpeg 片段拼接 → 成片 MP4                          │
│  director-pack mmxpack / 通用 ComfyUI 导演包组装                   │
│  agents/*      11 个专职智能体（见 AGENTS.md）                   │
│  pipelines/*   idea2video / script2video / novel2video 模板      │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│  存储层  data/                                                │
│  projects/<id>.json   画布快照（节点、连线、视口、设置、运行记录） │
│  assets/*             SVG 分镜 / PNG 首帧 / MP4 片段 / ZIP 导演包   │
│  comfyui.json         全局 ComfyUI 连接、工作流模板、产物模式        │
└──────────────────────────────────────────────────────────────┘
                            │ HTTP：/prompt /history /view /upload
┌───────────────────────────▼──────────────────────────────────┐
│  外部（可选）本机 ComfyUI 127.0.0.1:8188                        │
│  出图工作流 / 图生视频工作流 / MiniMax H3 Director 导演工作台     │
└──────────────────────────────────────────────────────────────┘
```

**依赖方向严格单向**：表现层不认识 Agent 内部实现；编排层不认识 HTTP 与 DOM；存储层只做读写。任何一层都可以独立替换（例如把 JSON 换成 SQLite、把 Mock 换成真实模型、把 SSE 换成 WebSocket）。

---

## 4. 核心数据契约

### 4.1 Project

```jsonc
{
  "id": "prj_xxx", "name": "雨夜侦探", "mode": "idea2video",
  "createdAt": 0, "updatedAt": 0,
  "viewport": { "x": 120, "y": 80, "zoom": 0.9 },
  "settings": {
    "provider": "mock",           // mock | openai
    "baseUrl": "", "apiKey": "", "model": "",
    "k": 2,                       // best-of-k，与论文 RQ6 结论一致
    "concurrency": 3,             // 同层最大并发
    "style": "cinematic",         // cinematic | anime | noir | watercolor
    "aspect": "16:9"
  },
  "nodes": [Node], "edges": [Edge],
  "runs": [ { "id": "run_x", "startedAt": 0, "finishedAt": 0, "status": "done", "nodeCount": 12 } ]
}
```

### 4.2 Node

```jsonc
{
  "id": "n_1", "type": "idea", "agent": "screenwriter",
  "title": "创意", "x": 0, "y": 0, "w": 268,
  "status": "idle",            // idle | queued | running | done | error | skipped
  "progress": 0, "error": "",
  "data": { "text": "……", "...": "按节点类型不同" },
  "meta": { "layer": 0, "cost": 0.02, "durationMs": 820, "runId": "run_x" }
}
```

节点类型与语义色：`idea` 紫、`script` 靛、`event` 青、`scene` 蓝、`storyboard` 蓝、`shot` 蓝、`character` 玫红、`camera` 琥珀、`keyframe` 绿、`review` 绿、`video` 橙、`transition` 橙、`final` 金、`note` 灰。

### 4.3 Edge

```jsonc
{ "id": "e_1", "from": "n_1", "to": "n_2",
  "kind": "flow" }   // flow 数据流 | anchor 视觉锚点（虚线） | ref 资产引用（点线）
```

`anchor` 边是论文「机位依赖图 / 视觉锚点传播」在画布上的可视化；`ref` 边表示角色/场景资产被某个镜头引用。

### 4.4 SSE 事件

| type | 关键字段 | 用途 |
|---|---|---|
| `hello` | `clients` | 连接建立 |
| `run:start` / `run:done` / `run:error` | `runId`, `projectId` | 运行生命周期 |
| `node:status` | `nodeId`, `status`, `progress` | 节点状态机，驱动呼吸动画与进度条 |
| `node:data` | `nodeId`, `data`(完整替换), `patch`(局部合并) | 产物写回画布节点 |
| `node:add` / `node:remove` / `edge:add` | 节点/边对象 | 编排器动态展开镜头图 |
| `log` | `level`, `agent`, `message` | 运行日志流与 Agent 思考过程 |
| `chat` | `role`, `content` | 画布 Agent 回复（逐段流式） |
| `state` | `project` | 全量刷新（导入/模板/重置时） |

所有事件带 `ts` 与 `projectId`；前端只处理当前项目的事件。

---

## 5. REST API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/bootstrap` | 项目列表 + 最近项目 + 节点类型注册表 + 模板列表 |
| POST | `/api/projects` | 新建项目（可带 `template`） |
| GET / PUT / DELETE | `/api/projects/:id` | 读取 / 保存画布快照 / 删除项目 |
| POST | `/api/projects/:id/template` | 应用流水线模板，重建节点图 |
| POST | `/api/projects/:id/run` | 启动编排，body 可带 `nodeId`（单节点及下游重跑） |
| POST | `/api/projects/:id/stop` | 取消当前运行 |
| POST | `/api/projects/:id/chat` | 画布 Agent 对话，支持 `@节点ID` 引用 |
| POST | `/api/projects/:id/arrange` | 自动布局（拓扑分层） |
| GET | `/api/projects/:id/export` | 导出完整 JSON |
| POST | `/api/import` | 导入 JSON |
| GET / POST | `/api/projects/:id/director-pack` | 下载 / 重新生成导演包 zip（`Content-Disposition: attachment`） |
| GET | `/api/projects/:id/film` | 下载拼接后的成片 MP4 |
| GET / PUT | `/api/comfyui/config` | 全局 ComfyUI 连接、工作流模板与产物配置 |
| POST | `/api/comfyui/test` | 探测本地 ComfyUI `/system_stats` |
| POST | `/api/comfyui/analyze` | 分析 API 工作流并列出可注入节点 |
| POST | `/api/comfyui/run-test` | 试跑一次工作流并返回下载到的资产 |
| GET | `/api/events` | SSE 事件流 |
| GET | `/assets/*` | 生成的 SVG / PNG / MP4 / ZIP 资产 |

设计原则：**画布是唯一事实来源**。前端编辑节点/连线后 PUT 全量快照；后端编排时改动通过 SSE 增量推送，前端合并后再 PUT 落盘，避免双写冲突。

---

## 6. 运行态与状态机

```
             ┌──────── run ────────┐
   idle ────► queued ───► running ─┼──► done ────►（可再次运行，强制重跑）
     ▲                            └──► error ──►（重试该节点及下游）
     └────────────── skipped（上游失败时下游跳过）
```

- **拓扑分层**：`graph.mjs` 用 Kahn 算法计算层号，同层节点并发执行（上限 `settings.concurrency`），对应论文 3.5 的「依赖图暴露镜头级并行性」。
- **幂等与断点续跑**：默认只跑 `idle/error` 节点；`done` 节点作为上游输入直接复用，不重复计费/生成。
- **取消**：`AbortController` 逐节点传播，队列中节点标记为 `idle`，已完成节点保留。
- **失败隔离**：单节点失败不阻塞同层其他分支；其下游标记 `skipped`，错误原因写入 `node.error` 与日志。
- **动态建图**：`narrative` 与 `camera` 类 Agent 可以在运行中调用 `ctx.addNodes()` 生成镜头/机位节点并连线，前端实时长出画布——这是「长视频规划」可视化的关键。

---

## 7. Provider 设计（模型无关）

```js
providers.llm({ system, prompt, json, signal })   -> string | object
providers.image({ prompt, refs, style, seed })    -> { url, width, height }
providers.video({ prompt, frames, duration })     -> { url, poster, duration }
providers.judge({ candidates, criteria })         -> { index, scores, reason }
```

- `mock`：确定性实现。LLM 返回结构化中文剧本/事件/分镜；Image 用自绘 SVG（构图、景别、色调、角色剪影、镜头编号）产出可预览资产；Video 返回关键帧序列供前端做幻灯片式预览；Judge 用启发式打分模拟 VLM 择优。
- `openai`：任意 OpenAI 兼容 `/chat/completions` 端点，要求模型返回 JSON；解析失败或网络异常自动回退 mock，并在日志里标注 `fallback`。
- **`comfyui`（图片 / 视频主路径）**：`createProviders()` 收到 `settings.comfy`（由编排器合并全局 `comfyui.json` 注入），只要配置了对应工作流，`image()` / `video()` 就走 `comfyui.mjs::runWorkflow()`。工作流是用户从 ComfyUI **「导出(API)」** 原样导入的 JSON，不改节点图；参数通过「显式绑定 > `{{占位符}}` > 按 `class_type` 自动识别」三层注入。全局配置 `strict=false` 时任何环节失败自动回退 Mock，流水线不中断。
- 兼容保留 `imageEndpoint` 扩展点（OpenAI 风格图像接口），优先级低于 ComfyUI。
- 编排器在 `buildContext({ settings })` 里传入合并后的配置，因此 `composer` 等交付型 Agent 也能读到 `outputMode` / `packTarget`，而不需要把全局配置写进项目快照。

**生成后端与画布解耦**：Agent 只调用 `providers.image/video()` 并拿到 `{url, provider, file}`；产物 URL 是本地 `/assets/*`，真实视频额外带 `file`，供 `film.mjs` 用 ffmpeg 拼接与 `director-pack.mjs` 引用。详见第 12 章。

---

## 8. 无限画布设计（对标 Toonflow）

| 能力 | 实现方式 |
|---|---|
| 无限平移 | 视口 `transform: translate(x,y) scale(z)`；空白拖拽/空格+拖拽/中键拖拽；网格背景随视口偏移 |
| 以指针为中心缩放 | `x' = px - (px - x) · z'/z`，缩放范围 0.1–2.5，滚轮 + 工具栏 + 快捷键 |
| 节点拖拽 | Pointer Events + 坐标反变换，支持多选整体移动、网格吸附（可选） |
| 连线 | 节点右侧输出端口 → 目标节点，贝塞尔曲线；`anchor`/`ref` 用不同线型 |
| 拖拽后选项浮层 | `onConnectDrop` 上报落点 → `link-picker.js` 弹出分组选择器 → 选完由业务层创建节点 / 建立连线 |
| 框选 / 多选 | 空白拖拽框选（世界坐标矩形相交判定），Shift 追加选择 |
| 小地图 | Canvas 2D 绘制节点缩略与视口框，点击/拖拽跳转 |
| 撤销重做 | 结构化快照栈（30 步），Ctrl/Cmd+Z / Shift+Z |
| 自动布局 | 后端拓扑分层 + 前端平滑过渡（CSS transform transition） |
| 适应视图 | 计算节点包围盒，自动求 zoom 与居中偏移 |
| 节点级操作 | 双击编辑、右键菜单、单独重跑、复制、删除、锁定、聚焦 |
| 状态可视化 | `running` 呼吸描边 + 进度条；`done` 绿点；`error` 红点；边上流动光点表示数据传递 |

**快捷键**：`Space` 平移、`Ctrl/Cmd+Z` 撤销、`Shift+Z` 重做、`Delete` 删除、`Ctrl/Cmd+D` 复制、`Ctrl/Cmd+A` 全选、`F` 适应视图、`L` 自动布局、`R` 运行、`Esc` 取消选择、`+/-` 缩放、`?` 快捷键帮助。

**拖拽连线选择器（渲染层 / 业务层解耦）**：`CanvasController` 只负责把拖线松手的落点信息 `{from, to, world, clientX/Y, overCanvas, 修饰键}` 通过 `onConnectDrop` 回调交给 `app.js`，自身不决定连什么；未挂回调时降级为旧的直接连线。业务层按落点分派三种浮层：空白处 → `showNextNodePicker`（推荐后继 / 全部节点类型 / 已有节点，选完 `addNodeAt` + `addEdge`）；节点上 → `showRelationPicker`（`flow`/`anchor`/`ref`，`Enter` 默认 `flow`）；节点库拖入 → `showAttachPicker`（选上游，把新节点接在其后，`Esc` 跳过）。浮层支持搜索、键盘导航、点击外部关闭；已有节点按离落点距离排序并默认只显示 8 项，搜索时展开全部。`Alt`/`Shift` + 拖线到节点保留跳过弹窗的快捷直连。

---

## 9. 页面与体验设计

布局：左侧**资源栏**（项目列表 / 节点库 / 流水线模板）、中间**无限画布**、右侧**检查器**（节点属性 ↔ Agent 对话切换）、顶部**工具栏**（项目名、运行态、运行/停止、Provider、主题、导出）、底部**状态栏**（实时日志流、节点统计、快捷键提示）。

设计系统：深色优先（与 IDE 一致），提供浅色切换；背景 `#0d1016`、面板 `#151a23`、描边 `#252c39`、主色橙 `#ff8a4c`；节点按类型语义着色；圆角 12–16px；字重层级清晰；所有状态变化有 160–240ms 过渡；`running` 用呼吸光晕，`done` 用一次性扫光。

体验细节：首次打开自动载入示例项目「雨夜侦探」并提供「一键运行完整流水线」；空状态有引导卡片；节点库可拖入画布；运行日志逐条流入状态栏；节点产物（剧本、分镜表、SVG 关键帧）在检查器内直接预览；Agent 面板支持 `@节点` 引用并可执行「整理画布 / 解释依赖 / 生成分镜 / 找不一致」；所有破坏性操作可撤销；导出 JSON 便于备份。

---

## 10. 与论文机制的映射

| 论文 | lingximanju 实现 |
|---|---|
| 式(1) ScreenWriting | `screenwriter` Agent，输入分类路由 + 统一格式剧本 |
| 式(2) ShotPlanning | `storyboard` Agent，输出机位/景别/运镜/时长结构化分镜 |
| 式(3) ImageGen / VideoGen | `keyframe` + `video` Agent，两步式生成 |
| 式(4) best-of-k 择优 | `review` Agent + `providers.judge`，默认 k=2 |
| 式(5) 层次化分解 | `decomposer` Agent：事件 → 场景 → 镜头，运行中动态建节点 |
| 式(6) RAG 上下文 | `rag` Agent：索引原文 → 按节点描述检索 → 增强描述 |
| 式(7) 机位依赖图 | `camera-graph` Agent：构建 `anchor` 边，编排器按拓扑并发 |
| 式(8) 转场视频 | `transition` Agent：为跨机位镜头生成空间锚点 |
| ViMax-Bench 一致性类型 | 示例项目内置「角色持久 / 背景持久 / 多人交互」三类标签 |
| 3.5 并行效率 | 编排器同层并发 + 运行统计展示耗时对比 |

---

## 11. 部署与扩展

- **本地**：`node server.mjs`（或 `./start.sh`），无依赖、无构建、无外网也可运行 mock 模式。
- **真实模型**：设置页填 Base URL / API Key / Model → 保存即切换；密钥只存本地 `data/projects/*.json` 的 settings 字段，不上传。
- **扩展新 Agent**：在 `src/agents/` 增加一个 `defineAgent({ id, label, run })`，在 `index.mjs` 注册即可，编排器与 UI 自动识别。
- **扩展节点类型**：在 `public/nodes.js` 的 `NODE_TYPES` 增加一项（颜色、图标、字段、渲染器），前后端无需其他改动。
- **替换存储**：实现 `store.mjs` 的 `load/save/list/remove` 四个方法即可切到 SQLite/对象存储。
- **已知边界**：Mock 模式产出可预览的 SVG 分镜与帧序列；真实视频需导入本地 ComfyUI 视频工作流；导演包是交给 ComfyUI 导演工作台的交接格式，本项目不内置其模型权重与节点。

---

## 12. 本地 ComfyUI 接入与双产物链路

> 需求：图片与视频生成主要对接本机 ComfyUI，可直接使用其「导出(API)」工作流；最终产物既可以是本地生成的成片，也可以是便于导入 ComfyUI 导演工作台（如 MiniMax H3 Director）的导演包。

### 12.1 设计原则

1. **不改用户的工作流**：API 格式 JSON 原样导入、原样提交，只做「值注入」；节点 ID、连线、自定义节点全部保留。
2. **零第三方依赖**：multipart 上传、PNG 编码、ZIP 打包全部手写；ffmpeg 仅作为可选外部加速。
3. **失败不阻断编排**：ComfyUI 未启动 / 工作流报错 / 超时，默认回退 Mock 并写日志；`strict=true` 才让节点失败。
4. **产物可交接**：导演包是开放格式，不绑定本项目；导入方只需按其规范读取，不需要安装 lingximanju。

### 12.2 ComfyUI 调用状态机

```
image()/video()  ──► injectWorkflow(workflow, vars, bindings)
                       │  占位符 → 自动识别 → 显式绑定
                       ▼
             有 LoadImage 节点？──是──► POST /upload/image（multipart）
                       │                  返回 name → 写回 LoadImage.image
                       ▼
                 POST /prompt {prompt, client_id}
                       │  非 200 → 解析 error / node_errors
                       ▼
             轮询 GET /history/{prompt_id}
                       │  status_str=error → 抛错；有 outputs → 继续
                       ▼
                 GET /view?filename&subfolder&type
                       ▼
             writeAssetBinary → /assets/* → 回填节点
```

轮询间隔、总超时、`AbortSignal` 取消均可配置；`history` 中任意 `images/gifs/videos/audio/files` 输出都会被收集，视频优先作为 `primary`。

### 12.3 注入契约

| 变量 | 来源 | 注入目标 |
|---|---|---|
| `prompt` / `negative_prompt` | 镜头规格、运动描述、全局负向词 | `{{}}` 或第 1/2 个 `CLIPTextEncode.text` |
| `seed` | 节点 ID + 候选序号 + 时间，逐次唯一 | `seed` / `noise_seed` / `rand_seed` |
| `width` / `height` / `fps` / `frames` | `comfyui.json` 与镜头时长 × fps | 同名输入、`num_frames` / `frame_count` / `length` |
| `filename_prefix` | `lingximanju_<kind>_<shotNo>` | 输出节点前缀，便于在 ComfyUI output 里归档 |
| 首帧 / 角色参考 | 画布 `/assets/*` | `LoadImage.image`；SVG 由 `raster.mjs` 渲染为合法 PNG 后上传 |

顶层 `_comment` 等元数据键在解析时剔除，避免被当成节点提交。

### 12.4 双产物数据流

```
video 节点 (clip.file, provider=comfyui)
        │
        ├── outputMode ∈ {both, video} ──► film.mjs::stitchClips()
        │                                      └─ ffmpeg concat → /assets/film_*.mp4
        │
        └── outputMode ∈ {both, director-pack} ──► director-pack.mjs
                                                       ├─ collectShotPackages(project)
                                                       ├─ collectCharacters(project)
                                                       ├─ media() 处理 PNG / SVG→PNG
                                                       └─ createZip() → /assets/pack_*.zip
        │
        ▼
final 节点 data: { film, directorPack, deliverables, outputMode }
        │
        ▼  检查器产物卡片 / 顶栏「▤ 导演包」/ REST 下载
```

`outputMode=director-pack` 时 `providers.video()` 跳过 ComfyUI 视频渲染（成片由导演工作台生成），避免无谓占用 GPU。

### 12.5 导演包格式映射

| 画布概念 | mmxpack 位置 |
|---|---|
| 角色资产库（≤3 人） | `shared_params/Picture1..3.png` + `shared_params.json.refs` |
| 风格 / 角色一致性约束 | `shared_params.json.prompt` + `pack.json.output` |
| 每个视频节点 | `asset_groups/NN/group.json`（prompt、durationSec、frameCount、start、continuityFromPrev） |
| 选中的关键帧 | `asset_groups/NN/start.png` + `group.json.startImage` |
| 转场空间锚点 | `asset_groups/NN/Picture4.png`（公共槽位占 1–3，组内从 4 续编） |
| 全部镜头顺序 | `timeline.json`（version 5 / timelineMode `fl2v` / segments + shots） |
| 采样与画幅 | `pack.json.widgets` 与 `pack.json.output` |
| 人可读分镜、原始工作流 | `extra/shots.json`、`extra/comfyui_*_workflow_api.json`、`extra/README.md` |

格式常量 `format="minimax-h3-director-pack"`、`formatVersion=1`；导入端在缺少 `timeline.json` 时也能由 pack + groups 自动组装，本项目两者都写以保证无损。`generic` 目标改为 `manifest.json + shots.json + images/ + workflows/`。

### 12.6 降级矩阵

| 情况 | 行为 |
|---|---|
| 未导入出图 / 视频工作流 | 对应环节使用 Mock 自绘 SVG 与帧序列，流水线照常完成 |
| ComfyUI 连不上 / 工作流校验失败 | 日志告警 → 回退 Mock（`strict=false`）；`strict=true` 则节点标 error |
| 无真实视频片段 | 不拼接、不伪造 MP4；导演包仍可导出（含占位首帧） |
| 无 ffmpeg | 保留逐镜头片段与下载入口 |
| 资产是 SVG | 用自研 PNG 编码器渲染占位图，并在 `manifest.json.note` 明确标注 |
| 只导出导演包 | 跳过本地视频工作流提交，节省 GPU |

### 12.7 验证

以本地 mock ComfyUI（完整实现 `/system_stats`、`/upload/image`、`/prompt`、`/history`、`/view`）跑通：40 节点 / 16 波 / 0 失败；20 次出图 seed 全唯一，尺寸 864×480、帧数 96/120/144 按镜头时长注入，零残留占位符；6 段真实片段经 ffmpeg 拼成 h264 MP4（144 帧 / 6s）；`mmxpack.zip` 27 个 ASCII 路径条目、CRC 全部通过；`generic` 包 14 条目。前端 DOM 验证双 Tab 设置、产物卡片与下载动作均正常。

---

## 13. 画布布局与可见性约束

大图「看起来是空的」曾是一个真实缺陷，涉及三处，现均已约束：

| 层次 | 约束 |
|---|---|
| 运行时布局 | `AgentContext.addNodeAndEdge()` 只按「同一父节点已有的子节点数」计算 y 偏移，兄弟节点在父节点下方整齐排开；旧实现统计同一 x 列的全图节点数，导致 y 随每次生成不断累加，40 节点图被拉成 3300×5300 的对角长龙 |
| 拓扑整理 | `autoLayout()` 只用 `flow` 依赖边分层（`anchor` / `ref` 是视觉锚点与资产引用，不是执行依赖），间距 300×190；若把视觉边算进 DAG，11 层会被误算成 18 层 |
| 视图 | `fitView()` 最小缩放从 0.2 放宽到 0.1；`loadProject` 尊重项目存档视口，不再无条件 fit-all；`applyTransform()` 检测「有节点但一个都不可见」并在画布中央给出可点击的回到内容按钮 |

验证：完成示例重排后边界 60–3328 × 60–1160，默认视口一屏可见 39/40 节点，⤢ 适应视图 40/40；新跑一条流水线生成的 40 节点 y 范围由 60–5130 收敛到 60–820。

---

## 14. 创作项目管理层（小说分集 → 视频 / 导演包）

> 新增于 2026-11-06。目标是把「上传小说 → 分集 → 成片视频 / 导演包」变成 **lingximanju 内部的一类创作项目**，而不是另起一个应用；**无限画布引擎 `public/canvas.js` 未改动**，所有新节点仍画在同一张图上。
> 理论依据逐条见 [`THEORY.md`](THEORY.md)。

### 14.1 分层与文件职责

| 层 | 文件 | 职责 |
|---|---|---|
| 纯逻辑 | `src/core/novel.mjs` | 解析小说（书名 / 章节 / 段落 / 字数）、三种分集策略、角色频次抽取、轻量预览与输入校验；无 DOM、无副作用 |
| 纯逻辑 | `src/core/project-steps.mjs` | `STEPS` 六步定义（含 `scope` 与论文依据）、`management` 元数据（含 `cover`）、步骤状态机、管理动作、统计与索引 |
| 纯逻辑 | `src/core/knowledge.mjs` | 式(6) 本地知识库：`chunkNovel(512,128)` 分块、BM25 `KnowledgeBase`、`retrieveRelevantChunks()` 归一化重排 / 0.7 阈值 / `processChain` 分数累加、磁盘缓存、`formatFragments()` FRAGMENT 标签 |
| 构建 | `src/pipelines/novel-project.mjs` | `buildNovelProject()` 复用 `buildTemplate('novel2video')` 的完整 DAG，插入 `episode` 节点并注入原著 / 分集 / 交付设置；`refreshEpisodes()` 重算第 ② 步 |
| 持久化 | `src/core/store.mjs` | 项目索引字段（`projectIndex`）、快照写入 / 列举 / 读取（`data/snapshots/<id>/<ts>.json`） |
| 编排 | `src/core/orchestrator.mjs` | `runProject(id, { scope })` 按节点类型白名单分阶段调度；不传 `scope` 时行为不变 |
| 智能体 | `src/agents/narrative.mjs`、`src/core/providers.mjs` | 编剧读取 `novelEpisodes / characters`；`rag` 用整本原著分块建库并落盘；`decomposer` 按事件 `processChain` 逐条检索并把 FRAGMENT 片段下发到 event / scene / shots；`generate('context')` 走本地 BM25 确定性检索 |
| API | `src/api/routes.mjs` | 向导预览 / 示例、创建创作项目、`manage / duplicate / snapshots / restore / step`、`broadcastMeta()`；封面 `POST / DELETE /api/projects/:id/cover` 与 `POST /api/projects/:id/cover/generate`；工作流库 `/api/comfyui/library` |
| 前端 | `public/wizard.js` | 三阶段新建向导 + 创建后的六步任务引导卡 |
| 前端 | `public/project-manager.js` | 侧栏项目列表（最近 / 更多、筛选、封面缩略图与名称封面兜底）、六步任务面板、画布步骤条、四 Tab 管理面板、`openCoverDialog()` 封面设置弹窗 |
| 前端 | `public/app.js` | 状态同步、步骤执行、SSE `project:meta`、顶栏进度与快捷键 |
| 样式 | `public/styles.css` | 四态视觉、进度条、向导、步骤面板、管理面板；项目卡片缩略图 / 名称封面 / 封面弹窗样式；沿用现有 CSS 变量兼容深浅主题 |
| 节点 | `public/nodes.js` | 新增 `episode` 类型（`▥` 分集，紫色，无默认智能体） |
| 测试 | `tests/novel.test.mjs` | 解析 / 分集策略 / 校验 / 角色抽取 / 预览不泄漏全文（16 项） |
| 测试 | `tests/project-steps.test.mjs` | 六步定义与论文映射 / 步骤状态机 / 管理动作（含 `cover`）/ 统计与索引（27 项） |
| 测试 | `tests/novel-project.test.mjs` | 项目骨架构建 / 分集节点对齐 / 连线完整性 / 刷新分集同步（11 项） |
| 测试 | `tests/knowledge.test.mjs` | 式(6)：512/128 分块与重叠、BM25 召回、`processChain` 阈值聚合与分数累加、单命中保底、缓存往返、FRAGMENT 标签（11 项） |
| 测试 | `tests/comfy-lib*.test.mjs` | 工作流库数据模型、批量导入去重、REST 切换 / 重命名 / 删除 / 批量真实试跑（13 项） |
| 门户 | `../server.py`、`../lingximanju.html` | 工作区门户新增 `lingximanju` 项目项与详情页，支持一键启停 |

### 14.2 数据契约：`project.management`

标准项目通过 `ensureManagement()` 惰性补齐（`kind:'standard'`，`steps: []`），保证收藏 / 归档 / 快照对所有项目可用；创作项目结构如下（写入 `data/projects/<id>.json`）：

```jsonc
{
  "schema": 1, "kind": "novel", "title": "雨夜来信 · 示例",
  "status": "draft | running | done | error",
  "favorite": false, "archived": false, "tags": [], "note": "",
  "createdAt": 0, "updatedAt": 0, "version": 1,
  "deliverables": { "video": true, "pack": true },      // → settings.comfy.outputMode
  "split": { "strategy": "chapter|fixed|scene", "targetChars": 1200, "maxEpisodes": 4 },
  "source": { "filename": "", "title": "", "totalChars": 0, "chapterCount": 0, "uploadedAt": 0, "text": "原著全文" },
  "episodes": [{ "no": 1, "title": "", "chars": 0, "summary": "", "hook": "", "sourceTitles": [] }],
  "steps": [{ "id": "script", "no": 3, "status": "pending|running|done|error", "startedAt": 0, "finishedAt": 0, "durationMs": 0, "note": "", "runs": 0 }],
  "currentStep": 3,
  "history": [{ "id": "", "at": 0, "action": "", "detail": "" }],
  "theory": { "paper": "ViMax · arXiv:2606.07649v2", "doc": "docs/THEORY.md", "defaults": { "k": 2 } },
  "cover": { "url": "", "source": "name|upload|comfyui", "prompt": "", "updatedAt": 0 }
}
```

- 原著全文只存 `management.source.text`（画布节点仅存摘要）。`rag` 节点用 `originalCorpus` 调 `chunkNovel(512,128)` 分块，缓存在 `data/knowledge/<projectId>.json`；分集节点用 `ref` 边把梗概传给 `script`，不参与 DAG 执行分层。
- `cover` 由 `ensureManagement()` 为老项目惰性补齐；`projectIndex()` 同步下发到侧栏索引。`source:'name'` 表示使用项目名称封面（前端按项目名哈希生成稳定渐变色块 + 首字），`url` 非空时指向 `/assets/cover_*.png` 静态资源。

### 14.3 六步状态机与分阶段执行

```
① upload    [auto·done] ─ 创建向导完成
② episodes  [auto·done] ─ 服务端解析分集；可由管理面板按新参数重算
③ script    scope=['script']                          式(1)
④ context   scope=['rag','character','plan','event','scene','shot']   式(5)(6)
⑤ storyboard scope=['keyframe','review','video','transition','camera'] 式(2)(3)(4)(7)(8)
⑥ deliver   scope=['final'] + 交付物兜底（缺导演包则补生成）
```

- `POST /api/projects/:id/step` 支持 `{ stepId }` 单步、`{ all:true }` 连续执行、`{ action:'reset', stepId? }` 重置状态；已完成步骤在 `all` 模式下跳过。
- `executeSteps()` 每步 `startStep → runProject(scope) → finishStep`，每步前后 `saveProject` 并 `broadcastMeta()`；失败步骤标 `error` 并中断后续步骤，界面提供重试。
- 第 ⑥ 步在 `deliverables.pack` 为真且 `final.data.directorPack` 缺失时主动调用 `exportDirectorPack()`，保证「只导出导演包」与「两者都要」都能交付。
- `runProject` 的 `scope` 只影响目标集合与动态展开节点的加入，不改 DAG 拓扑、join 汇聚、取消与断点续跑逻辑。

### 14.4 REST / SSE 补充

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/novel/sample` | 向导「载入示例小说」（`examples/sample-novel.txt`） |
| POST | `/api/novel/preview` | 实时分集预览，不落盘 |
| GET | `/api/bootstrap` | 额外返回 `steps: STEPS`、`stats`（全部 / 创作 / 完成 / 进行中 / 归档 / 收藏）与扩展后的项目索引 |
| POST | `/api/projects` | `kind:'novel'` 时走 `buildNovelProject()`；否则保持原模板创建 |
| GET / POST | `/api/projects/:id/manage` | 读取管理详情 / 执行 `rename · favorite · archive · tags · note · deliverables · split · reset-steps` |
| POST | `/api/projects/:id/duplicate` | 深拷贝副本（重置运行态、保留产物引用） |
| GET / POST | `/api/projects/:id/snapshots` | 列举 / 创建快照 |
| POST | `/api/projects/:id/restore` | 恢复快照（恢复前自动为当前状态留安全点） |
| POST | `/api/projects/:id/step` | 六步执行 / 重置 |
| POST | `/api/projects/:id/cover` | 上传本地封面（`{ dataUrl }` base64，校验格式 + 文件头 + 大小），写入 `data/assets` |
| DELETE | `/api/projects/:id/cover` | 清除封面 → 回退「项目名称封面」 |
| POST | `/api/projects/:id/cover/generate` | 用已配置的 ComfyUI 出图工作流生成封面，返回 `cover / url / durationMs` |
| POST / PUT | `/api/comfyui/library` | 批量导入工作流库 / 切换选中项 |
| DELETE | `/api/comfyui/library/:kind/:id` | 删除工作流库条目 |

SSE 新增 `project:meta` 事件：`{ projectId, management, stats, progress }`。前端 `handleEvent` 用它刷新步骤面板、画布步骤条、顶栏胶囊与侧栏项目列表；`state.stats`（全局）与 `state.projectStats`（单项目）严格分离。

### 14.5 视觉规范（明确的四态提示）

| 状态 | 颜色 | 表现 |
|---|---|---|
| 待执行 | 灰 | 灰边卡片、空心编号、进度条空 |
| 进行中 | 橙 + 呼吸光晕 | `spGlow` 动画、状态胶囊脉冲、画布节点原有 `status-running` 光晕、连线流光 |
| 已完成 | 绿 ✓ | 编号变 ✓、耗时徽标、进度条填充、侧栏「全完成」 |
| 失败 | 红 | 红边、失败原因、`重试本步` 按钮，可重置 |

统一提示面：向导三阶段指示、创建后的六步任务引导卡、检查器「任务步骤」Tab（`x/6` + 进度条 + 四色图例 + 每步检查清单 + 论文依据卡）、顶栏状态胶囊与 2px 进度条、画布上方六步导航条（点击定位相关节点）、Toast、运行日志、侧栏项目卡进度条。

### 14.6 画布保留约束

- `public/canvas.js` 一行未改：平移 / 指针缩放 / 拖拽 / 框选 / 端口连线 / 小地图 / 适应视图 / 自动布局 / 撤销重做 / 视口外回到内容全部保留。
- 创作项目初始图 = 原 `novel2video` DAG（8 节点）+ 每集一个 `episode` 节点；后续智能体动态展开的节点照旧画在同一画布。
- 画布顶部在创作项目下由步骤导航条占据，`canvas-hint` 自动隐藏，避免两层提示重叠；`[hidden]` 兜底规则已覆盖新增组件。
- 「查看画布节点」按步骤 `scope` 选中并聚焦对应节点；「⤢ 适应视图」「⌗ 布局」「F」「L」仍可随时使用。

### 14.7 验证结论（2026-11-06）

| 项目 | 结果 |
|---|---|
| 单元测试 | `npm test` → **92 项全部通过**（`novel` 16 / `project-steps` 27 / `novel-project` 11 / `knowledge` 11 / `comfy-lib` 8 / `comfy-lib-api` 5 / `graph` 6 / `store` 4 / `orchestrator` 4），零依赖、毫秒级 |
| 后端 HTTP 闭环 | 新建创作项目 → 第 ③ 步 → 全部执行：`6/6` 步、42 节点 / 64 连线（2 集）、6 镜头、8 条 anchor、14 条 ref、0 失败，导演包 25 文件 CRC 全通过 |
| 上传内容生效 | 剧本场景来自原著章节（「第一章 没有署名的信」/「第四章 回到码头」），角色抽取为沈砚 / 林夏等原著人物 |
| 项目管理 | 重命名 / 收藏 / 标签 / 备注 / 归档 / 交付设置 / 复制 / 快照 / 恢复 / 删除全部通过，原有 4 个示例项目未受影响 |
| 前端运行时 | jsdom + 原生 ESM 真实服务验证：向导三阶段、实时分集预览、创建后六步引导、步骤面板四态、`2/6 → 3/6 → 6/6`、管理面板四 Tab、侧栏筛选与更多菜单，**0 运行时错误** |
| 知识库（式 6）HTTP 闭环 | 新建创作项目 → 第 ③④ 步：`rag` 节点 `knowledgeId / cacheFile / chunkCount=2`；`event` / `scene` 节点均带 `relevantChunks` 与 `<FRAGMENT_i>` 片段；`plan` 节点 `knowledgeChunks=2 / fragmentsPerEvent=[2]`；`data/knowledge/<id>.json` 落盘，15/15 检查通过 |
| 项目封面 | jsdom 36/36（名称封面 / 图片封面 / 齿轮菜单 / 弹窗三操作 / 管理面板入口）；HTTP 14/14（上传合法 PNG → 静态资源字节一致 → bootstrap 索引同步 → 三种非法输入 400 → DELETE 回退名称封面）；ComfyUI 真实生成 200 / 42.4s / 1032×1832 PNG |
| 工作区门户 | `server.py` 新增 `lingximanju` 项目项，门户卡片与 `lingximanju.html` 详情页已接入；实测一键启动（`api_up: true`）→ 应用 200 → 一键停止（端口释放）全链路通过，四个门户页面均 200 |
| 修复的真实缺陷 | ① 步骤请求体未按 `api()` 约定包装导致 GET 404；② 管理面板误用全局统计、`project:meta` 覆盖侧栏统计；③ 顶栏进度与步骤面板状态刷新时机不同步；④ **「按字数」分集双重切分**：先按目标字数切块又以同一阈值二次聚合，实测 400 字目标产出 794 字/集，已改为 fixed 策略直接成集（实测 399/393）；⑤ 门户启动提示文案对单进程项目错误复用了 DramaClaw 的端口描述；⑥ 门户停止兜底只覆盖 DramaClaw 启动脚本，已按项目配置 `stop_pattern` |

### 14.8 自动化测试分层

单元测试只覆盖**纯逻辑层**（无 DOM、无副作用），与浏览器运行时验证互补：

| 层 | 位置 | 覆盖 |
|---|---|---|
| 纯逻辑单测 | `tests/*.test.mjs`（`node --test`） | 小说解析 / 分集策略 / 六步状态机 / 管理动作 / 项目骨架构建 / 知识库检索 / 工作流库 |
| 接口闭环 | 真实 HTTP（临时端口） | 创建 → 分步 → 全量执行 → 管理 → 快照 → 复制 → 导演包下载 → 封面上传 / 生成 / 重置 → 清理 |
| 前端运行时 | jsdom + 原生 ESM 转译 | 向导 / 步骤面板 / 管理面板 / 侧栏筛选 / 封面缩略图与弹窗 / 零运行时错误断言 |
| 产物有效性 | Python `zipfile.testzip()` | 导演包逐条 CRC 校验 |

分集策略的参数边界是**实现约定而非随意取值**：`targetChars` 被钳制在 `[300, 8000]`、`maxEpisodes` 钳制在 `[1, 12]`，避免切出过碎或过粗的集；单元测试以此为基准断言。

### 14.9 式(6) 知识库与检索链

参考 `ViMax/pipelines/novel2movie_pipeline.py`（FAISS + `BAAI/bge-reranker-v2-m3`）补齐论文式(6) 的完整链路，实现为纯 JS / 零外部依赖：

```
management.source.text (原著全文)
  └─ rag agent
       ├─ chunkNovel(512,128) → data/knowledge/<projectId>.json
       ├─ new KnowledgeBase(chunks)  // df / avgLen / BM25(K1=1.5, B=0.75)
       ├─ retrieveRelevantChunks(概览 query, topK=6, threshold=0)
       └─ ctx.patch → knowledgeId / cacheFile / chunkCount / passages
  └─ decomposer agent
       ├─ loadKnowledgeCache(knowledgeId)（缺失时用 originalCorpus 兜底重建）
       ├─ 对每个 event.processChain 逐条：
       │    retrieveRelevantChunks(kb, chain, {topK:10, threshold:0.7})
       │    → BM25 宽召回 → min-max 归一化重排 → 0.7 过滤 → 同块分数累加
       ├─ 命中为空 → 用「事件标题 + 梗概」threshold:0 兜底召回
       └─ event / scene 节点写入 relevantChunks + formatFragments(..., 4)
            → shots 生成时把 fragments 传给 providers.generate('shots')
```

- `src/core/providers.mjs` 的 `generate('context')` 短路为本地 BM25 检索，不再把整本原著塞给 LLM；LLM 的 system prompt 增加「必须与 FRAGMENT 片段的人物 / 道具 / 环境 / 光线一致」的约束。
- `normalizeScores()` 对「单命中 / 全部同分」的边界置 1，避免 0.7 阈值把唯一召回误杀。
- 与 ViMax 的差异（FAISS 向量召回 + 外部 bge reranker vs BM25 + 归一化重排）见 [`THEORY.md`](THEORY.md) §5.1：**方法层对齐，实现技术不同**，保证零 Key / Mock 模式也能跑通式(6)。

### 14.10 项目封面（三种来源）

`management.cover = { url, source: 'name'|'upload'|'comfyui', prompt, updatedAt }`，由 `projectIndex()` 下发到侧栏卡片。

| 来源 | 入口 | 实现 |
|---|---|---|
| 项目名称封面（默认） | 无封面 / `DELETE /api/projects/:id/cover` | `public/project-manager.js · nameCoverHTML()` 按项目名字符和取 `hue % 360`，生成稳定渐变色块 + 首字，无需任何资源 |
| 本地上传 | 卡片齿轮「设置项目封面」→「⇧ 上传本地图片」，或管理面板「概览」→「设置项目封面」 | 前端 `FileReader.readAsDataURL()` → `POST /api/projects/:id/cover { dataUrl }` → 后端正则校验 `png/jpeg/webp/gif`、base64 解码、文件头魔数校验、≤6 MB → `writeAssetBinary()` 写入 `data/assets` |
| ComfyUI 生成 | 弹窗「✦ 用 ComfyUI 生成封面」 | `buildCoverPrompt()` 用片名 + 剧本梗概 + 首集摘要 + 可选画面要求拼提示词；复用 `imageWorkflow` 走 `parseWorkflow() → runWorkflow()`，产物 URL 写入 `cover.url` |

- 三个入口统一走 `applyManageAction(project, 'cover', value)` → `saveProject()` → `broadcastMeta()` → SSE `state`，并写入 `management.history`。
- 前端 `openCoverDialog()` 同时兼容「列表索引对象（顶层 `cover`）」与「完整项目对象（`management.cover`）」两种数据源；成功后 `onChanged()` 触发项目列表与统计刷新。
- 卡片缩略图 46×62，`✦ AI` / `⇧ 上传` 角标区分来源；弹窗预览 3:4，生成期间显示忙碌遮罩并禁用关闭，避免重复提交。


