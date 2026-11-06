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
| 以指针为中心缩放 | `x' = px - (px - x) · z'/z`，缩放范围 0.2–2.5，滚轮 + 工具栏 + 快捷键 |
| 节点拖拽 | Pointer Events + 坐标反变换，支持多选整体移动、网格吸附（可选） |
| 连线 | 节点右侧输出端口 → 目标左侧输入端口，贝塞尔曲线；`anchor`/`ref` 用不同线型 |
| 框选 / 多选 | 空白拖拽框选（世界坐标矩形相交判定），Shift 追加选择 |
| 小地图 | Canvas 2D 绘制节点缩略与视口框，点击/拖拽跳转 |
| 撤销重做 | 结构化快照栈（30 步），Ctrl/Cmd+Z / Shift+Z |
| 自动布局 | 后端拓扑分层 + 前端平滑过渡（CSS transform transition） |
| 适应视图 | 计算节点包围盒，自动求 zoom 与居中偏移 |
| 节点级操作 | 双击编辑、右键菜单、单独重跑、复制、删除、锁定、聚焦 |
| 状态可视化 | `running` 呼吸描边 + 进度条；`done` 绿点；`error` 红点；边上流动光点表示数据传递 |

**快捷键**：`Space` 平移、`Ctrl/Cmd+Z` 撤销、`Shift+Z` 重做、`Delete` 删除、`Ctrl/Cmd+D` 复制、`Ctrl/Cmd+A` 全选、`F` 适应视图、`L` 自动布局、`R` 运行、`Esc` 取消选择、`+/-` 缩放、`?` 快捷键帮助。

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
