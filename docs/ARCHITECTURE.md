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
│  comfyui       API 工作流解析、沿图提示词注入 / 参数注入、提交、轮询│
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

### 4.5 季 / 集 / 画布范围（2026-11-08 扩展）

季是**轻量分组**，不引入二级集号：全局唯一集号 `no` 保持不变，`ep.season` 缺省为 `1`，季标题只存在 `management.seasons[]`；老项目读入即归「第 1 季」，无需迁移。

```jsonc
management.seasons = [{ "no": 2, "title": "第二季" }]
management.episodes[n].season = 2            // 缺省 1
management.episodes[n].canvas = {            // 该集独立无限画布，首次进入时播种落盘
  "nodes": [Node], "edges": [Edge],
  "viewport": { "x": 40, "y": 30, "zoom": 0.72 }
}
```

画布范围键由 `public/project-model.js` 的 `scopeKeyOf() / parseScopeKey()` 统一管理：

| key | 数据来源 | 可写 |
|---|---|---|
| `overall` | `composeOverallCanvas(project)` 从所有季 / 集画布派生的组合总览 | **否**（只读派生视图） |
| `main` | `project.nodes / edges / viewport` | 是 |
| `ep:<no>` | `management.episodes[n].canvas` | 是 |

组合图节点 id 加 `cp_<集号>_` 前缀并携带 `data.scopeRef / data.sourceNodeId`，季分行、集按列，跨集用 `ref` 连线；它**不写回项目主画布**，双击节点按 `scopeRef` 跳回单集画布。切换范围时 `CanvasController.setProject(project, { resetHistory: true })` 清空 `history/future`，保证 A 画布的 undo 快照不会写回 B 画布；组合范围下 `scopeReadOnly()` 禁用运行 / 布局 / 删除 / 撤销等写操作。

---

## 5. REST API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/bootstrap` | 项目列表 + 最近项目 + 节点类型注册表 + 模板列表 |
| POST | `/api/projects` | 新建项目（可带 `template`）；`kind:'novel'` 且不带 `text` 时创建**极简骨架**（六步全 pending，小说延后到第 ① 步） |
| POST | `/api/projects/:id/source` | **延迟上传小说**：解析 + 分集 + 注入节点 + 完成 ①② 步（骨架项目的第 ① 步入口） |
| GET | `/api/projects/:id/source` | **原著统计与全文**：`buildSourceView(project)` 返回 `{ ok, stats, chapters, sources, episodes, text }`；只读、不落盘、不改入参，历史项目惰性重建章节 |
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
| GET | `/api/assets` | 资源库全量索引（`index.json` 元数据：类型 / 名称 / 标签 / 来源项目）+ 统计 |
| PATCH / DELETE | `/api/assets/:file` | 改名 / 打标签 / 改类型；删除（被项目引用时 409 拒绝） |
| POST | `/api/assets/reindex` | 重扫 `data/assets/`：收录新文件、剔除已删除文件 |
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

布局：应用按 `home / workshop / canvas / episode` 四视图切换，并用「项目会话」区分是否打开了项目。`home` 项目列表页全宽展示（侧栏隐藏、顶栏只显示 `⌂ 项目列表`、状态栏显示项目总数）；打开项目后整页项目化：左侧是**项目侧栏**（项目卡与六步进度、项目导航与剧集快捷入口、本项目资源列表、项目设置入口；画布工具「模板 / 节点库 / 智能体」仅在 `canvas` 视图追加显示），中间是**无限画布**或**项目工作台 / 剧集详情**，右侧**检查器**（节点属性 ↔ Agent 对话切换，仅画布视图），顶部**工具栏**（项目封面 + 可编辑项目名 + 步骤胶囊 + 右上角「⇦ 退出项目」、运行态、运行/停止、本项目模型、Provider、导出；不出现应用级按钮，工作台 / 画布不再重复面包屑），底部**状态栏**（本项目日志、节点 / 连线 / Provider / 缩放）。侧栏品牌与页脚、资源库入口文案也随会话切换。**退出出口统一为两处**：顶栏右上角「⇦ 退出项目」（`#btn-close-project`）与左侧「项目设置 → 退出项目」（`[data-act="exit-project"]`），二者都调 `app.js` 的 `requestExitProject() → closeProject()`：清空 `state.project`、画布、项目级浮层、日志与 Agent 对话，再刷新并回到项目列表；列表提供「↩ 继续上次项目」。侧栏项目卡 ✕、`⌂ 项目列表`、剧集面包屑「✕ 关闭项目」、`H` 快捷键等旧出口已全部移除，避免误触退出；剧集面包屑只保留回工作台 / 画布的链接。项目被删除或被外部移除时的自动收尾仍直接走 `closeProject({ silent: true })`，属内部清理而非用户出口。详见 §14.13。项目列表、新建、导入以及应用级入口（`⌂ 项目列表` / `⚙` 设置 / `☀` 主题 / `?` 帮助 / `⚠ 模型未配置`，统一 class `.app-only`，由 `body:not(.view-home) .app-only` 隐藏）只在 `home` 页出现；项目内打开资源库默认「仅本项目」，弹窗内可退出范围看全库。**项目会话内全部内容绑定当前项目**：浏览器标签标题、状态栏 Provider（`本项目 · …`）、画布空态引导与剧集面包屑都带项目名；所有 AI 入口的模型下拉按「项目 + 入口」隔离记忆并显示「本项目默认模型」，切项目 / 关闭自动恢复；设置弹窗标题带项目名、帮助弹窗给出本项目 `x/6 步 · N 集 · M 节点` 与项目内快捷键；画布工具区标注当前模板、各类型节点数与只列本项目在用的智能体。项目内 `T` 切换主题（侧栏项目设置 `◐`）、`?` 打开本项目指引。

**工作台降密度（2026-11-08）**：项目工作台改为四 Tab（`▦ 概览 / 📖 原著 / ▥ 分季分集 / ▣ 资源`），首屏只渲染概览，其余按需加载；`project-view.js` 的 `ui.tab` 与 `setWorkshopTab()` 支持顶栏「··· 更多」菜单深链直达。项目内次要按钮（项目管理 / 布局 / 导演包 / 导出 / 资源库）加 `.in-more`，由 `body:not(.view-home) .in-more` 隐藏，统一收进 `#more-menu`（`data-more` 或 `data-target` 触发）。项目侧栏增加 `.ps-links` 四个快捷入口与按季分组的剧集树。画布视图顶部新增范围条 `#canvas-scopebar`：`overall / main / ep:<no>` 三类，按季生成 `optgroup`，`⤢` 只适应当前范围。资源统一以 `collectProjectAssets()` 口径归属，在「资源」Tab 按类型归纳展示，与侧栏列表、资源库「仅本项目」一致。

设计系统：深色优先（与 IDE 一致），提供浅色切换；背景 `#0d1016`、面板 `#151a23`、描边 `#252c39`、主色橙 `#ff8a4c`；节点按类型语义着色；圆角 12–16px；字重层级清晰；所有状态变化有 160–240ms 过渡；`running` 用呼吸光晕，`done` 用一次性扫光。

体验细节：首次打开落在项目列表页（六步图文流程 + 项目卡），点项目进入工作台 / 画布并提供「一键运行完整流水线」；空状态有引导卡片；节点库可拖入画布；运行日志逐条流入状态栏；节点产物（剧本、分镜表、SVG 关键帧）在检查器内直接预览；Agent 面板支持 `@节点` 引用并可执行「整理画布 / 解释依赖 / 生成分镜 / 找不一致」；所有破坏性操作可撤销；导出 JSON 便于备份。

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
                       │  显式绑定 > {{占位符}} > 沿图自动识别
                       │  （KSampler → CLIPTextEncode → 上游文本源节点）
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
| `prompt` / `negative_prompt` | 镜头规格、运动描述、全局负向词 | `{{}}` / 显式绑定 / `CLIPTextEncode.text` / **沿正、负向连线回溯到的字符串源节点**（`PrimitiveStringMultiline.value`、`StringConcatenate.string_*` 等）；系统提示词、LoRA 触发词与负向链路会被排除 |
| `seed` | 节点 ID + 候选序号 + 时间，逐次唯一 | `seed` / `noise_seed` / `rand_seed` / `sampling_mode.seed` |
| `width` / `height` / `fps` / `frames` | `comfyui.json` 与镜头时长 × fps | 同名输入、`num_frames` / `frame_count` / `length` |
| `filename_prefix` | `lingximanju_<kind>_<shotNo>_<seed>` | 输出节点前缀，逐次唯一，避免同名文件被复用 |
| 首帧 / 角色参考 | 画布 `/assets/*` | `LoadImage.image`；SVG 由 `raster.mjs` 渲染为合法 PNG 后上传 |

顶层 `_comment` 等元数据键在解析时剔除，避免被当成节点提交。

**提示词沿图回溯（修复「所有镜头都是同一张图」）**：Krea2 / Qwen-Image 等现代工作流把提示词写在 `PrimitiveStringMultiline` 上，经 `StringConcatenate` / `TextGenerate` 润色 / `ComfySwitchNode` 才连到 `CLIPTextEncode.text`。若只扫描「`CLIPTextEncode.text` 是字符串」的节点，注入列表里一个提示词都没有，每次都提交工作流里写死的那句话，画面只有随机种子带来的细微差别。`injectWorkflow()` 现在以 `KSampler.positive / negative` 反查 CLIP 节点，再沿输入连线 BFS 回溯（自动防环），对可达的字符串输入按节点标题 / 类型 / 长度 / 链路极性打分，选出最佳的用户提示词槽位；完全找不到文本源时兜底把 `CLIPTextEncode.text` 从连线改为字面量（会绕过润色链路并告警）。返回的 `promptInjection` 记录注入节点、策略与告警，运行日志与设置页「提示词注入自检」（`POST /api/comfyui/inject-check`，纯本地干跑）都可见，避免再次静默退化。

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
| 纯逻辑 | `src/core/novel.mjs` | 解析小说（书名 / 章节 / 段落 / 字数）、三种分集策略、角色频次抽取（动词邻接 + `mineFrequentNames()` 全书频次挖掘，配合 `character-names.mjs` 的人名可信度判定）、轻量预览与输入校验；无 DOM、无副作用 |
| 纯逻辑 | `src/core/source-view.mjs` | `buildSourceView(project)`：以 `management.source.text` 为准汇总六项统计，优先用 `management.chapters`，为空时调 `parseNovel()` 惰性重建；只读、不落盘、不改入参；供 `GET /api/projects/:id/source` 使用 |
| 纯逻辑 | `src/core/project-steps.mjs` | `STEPS` 六步定义（含 `scope` 与论文依据）、`management` 元数据（含 `cover`）、步骤状态机、管理动作、统计与索引 |
| 纯逻辑 | `src/core/bm25.mjs` | 检索算法层（零 I/O、零依赖）：中文 bigram 分词与停用词、`chunkNovel(512,128)` 分块、BM25 `KnowledgeBase`、`retrieveRelevantChunks()` 归一化重排 / 阈值过滤 / 分数累加 / 近重复去重、`formatFragments()` FRAGMENT 标签 |
| 纯逻辑 | `src/core/knowledge.mjs` | 式(6) 本地知识库的**磁盘缓存层**：`saveKnowledgeCache()` / `loadKnowledgeCache()` → `data/knowledge/<projectId>.json`；算法部分从 `bm25.mjs` 转出（拆层是为避免 `characters → knowledge → store → project-steps → characters` 循环依赖） |
| 纯逻辑 | `src/core/characters.mjs` | 角色域模型：属性归一（含静态/动态特征二分与派生兜底）、造型与多视图提示词拼装、论文式(6) 角色召回 `buildCharacterPassages()`、提取输入组装 `buildExtractVars()`（候选池按上限 2 倍放宽，最多 40）、主角兜底 `supplementMainCharacters()`（按全书出场频次补回被漏角色，名额已满时仅强主线 ≥20 次可挤掉末尾）、提取结果合并 `mergeExtracted()` |
| 构建 | `src/pipelines/novel-project.mjs` | `buildNovelProject()` 复用 `buildTemplate('novel2video')` 的完整 DAG，插入 `episode` 节点并注入原著 / 分集 / 交付设置；`refreshEpisodes()` 重算第 ② 步 |
| 持久化 | `src/core/store.mjs` | 项目索引字段（`projectIndex`）、快照写入 / 列举 / 读取（`data/snapshots/<id>/<ts>.json`） |
| 编排 | `src/core/orchestrator.mjs` | `runProject(id, { scope })` 按节点类型白名单分阶段调度；不传 `scope` 时行为不变 |
| 智能体 | `src/agents/narrative.mjs`、`src/core/providers.mjs` | 编剧读取 `novelEpisodes / characters`；`rag` 用整本原著分块建库并落盘；`decomposer` 按事件 `processChain` 逐条检索并把 FRAGMENT 片段下发到 event / scene / shots；`generate('context')` 走本地 BM25 确定性检索 |
| API | `src/api/routes.mjs`、`src/api/routes/management.mjs` | 向导预览 / 示例、创建创作项目、`manage / duplicate / snapshots / restore / step`、`broadcastMeta()`；封面 `POST / DELETE /api/projects/:id/cover`、`POST /api/projects/:id/cover/chat`（对话式创作）与 `POST /api/projects/:id/cover/generate`（生成入资源库 + 调用记录 `management.coverCalls`）；角色 `POST /api/projects/:id/characters/extract`（式(6) 召回证据 → LLM 抽取，失败回退启发式）、`POST /api/projects/:id/characters/views`（单视图，侧面/背面以正面图为 `refs`）、`POST /api/projects/:id/characters/views/all`（批量 + SSE 进度）；工作流库 `/api/comfyui/library` |
| 前端 | `public/wizard.js` | 极简新建向导：只有项目名称必填 + 可选一句话构想 |
| 前端 | `public/project-view.js` | 项目工作台四 Tab：概览（路线图 / 故事来源 / 项目信息 / 当前步骤）、原著（挂 `source-view.js`）、分季分集（`seasonsHTML()`：季卡片 / 每集卡片 / 跨季移动 / 本集画布）、资源（`assetsHTML()`：按类型归纳）；`setWorkshopTab()` 支持外部深链 |
| 前端 | `public/project-model.js` | 季 / 集 / 画布范围的纯函数模型（`seasonGroups / assignEpisodeSeason / addSeason / removeSeason / scopeKeyOf / parseScopeKey`）与 `localSourceView()`（旧服务无 `/source` 时的前端等价统计与章节重建回退） |
| 前端 | `public/source-view.js` | 原著阅读器 `renderSourceView()` + `sourceStatCards()`：六项统计卡、章节目录、全文 / 按章阅读、搜索高亮、复制 / 下载 / 重新导入；默认全文 |
| 前端 | `public/canvas-compose.js` | `seedEpisodeCanvas()` 播种单集画布、`composeOverallCanvas()` 派生全部组合总览（id 加 `cp_<no>_` 前缀、跨集 `ref`、600 节点裁剪）、`canvasScopeLabel()` / `canvasScopeOptions()` |
| 前端 | `public/canvas.js` | `setProject(project, { keepViewport, resetHistory })` 新增撤销栈隔离，供三种画布范围安全切换；其余自研画布引擎行为不变 |
| 前端 | `public/index.html` | `··· 更多` 菜单（`.in-more` 收口）与画布范围条 `#canvas-scopebar`；`public/app.js` 负责 `activeCanvasGraph / setCanvasScope / scopeReadOnly / openEpisodeCanvas / openOverallCanvas` 与更多菜单接线 |
| 前端 | `public/project-sidebar.js` | 项目内左侧栏：项目卡与进度、导航与剧集快捷入口、本项目资源列表（递归扫描项目 JSON 的 `/assets/` 引用 + 索引 `sourceProjectId` 补充归属、类型筛选、预览弹窗、进资源库 `files` 白名单）、项目设置入口（含 `◐` / `?`）；`collectProjectAssets()`（资源归属）、`projectChrome()`（会话外壳与标签标题）、`collectToolStats()`（本项目模板 / 节点 / 智能体统计）均为纯函数，可单测 |
| 前端 | `public/project-manager.js`、`public/ai-chat.js` | 六步任务面板、画布步骤条、四 Tab 管理面板、对话式封面创作（`openAIChat()` 复用对话弹窗：生成 → 大图预览确认 → 保存）与封面生成调用记录展示；`renderProjectList()` 为历史侧栏渲染器（现由 `home-view.js` 承担） |
| 前端 | `public/app.js` | 四视图状态机、**项目会话**（`closeProject()` 清空项目态回列表、`updateChrome()` 整页项目化含标签标题与画布空态、`openProjectAssetLibrary()` 默认本项目范围）、`renderCanvasTools()` 按本项目节点图统计工具区、`toggleTheme()`（`T` / 侧栏 `◐`）、`setModelProjectScope()` 接线、项目侧栏 ctx 组装、状态同步、步骤执行、SSE `project:meta` / `episode:update` 防抖刷新、顶栏进度与快捷键 |
| 前端 | `public/model-picker.js` | AI 入口模型下拉：`modelScopeKey(entry, projectId)` 纯函数生成隔离键、`setModelProjectScope(id, name)` 同步页面上所有下拉到该项目的记忆值；项目内首项显示「本项目默认模型」，关闭项目回应用级默认，不写全局 `lm.model.*` |
| 样式 | `public/styles.css` | 四态视觉、进度条、向导、步骤面板、管理面板、项目侧栏 `.ps-*`；项目卡片缩略图 / 名称封面 / 封面弹窗样式；沿用现有 CSS 变量兼容深浅主题 |
| 节点 | `public/nodes.js` | 新增 `episode` 类型（`▥` 分集，紫色，无默认智能体） |
| 测试 | `tests/novel.test.mjs` | 解析 / 分集策略 / 校验 / 角色抽取 / 预览不泄漏全文（16 项） |
| 测试 | `tests/project-steps.test.mjs` | 六步定义与论文映射 / 步骤状态机 / 管理动作（含 `cover`，提示词完整保存不截断）/ 统计与索引（38 项） |
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
  "seasons": [{ "no": 1, "title": "第 1 季" }],        // 轻量分组；缺省时老项目自动归入第 1 季
  "episodes": [{ "no": 1, "season": 1, "title": "", "chars": 0, "summary": "", "hook": "", "sourceTitles": [],
                 "canvas": { "nodes": [], "edges": [], "viewport": {} } }],   // 每集独立画布，首次进入播种落盘
  "steps": [{ "id": "script", "no": 3, "status": "pending|running|done|error", "startedAt": 0, "finishedAt": 0, "durationMs": 0, "note": "", "runs": 0 }],
  "currentStep": 3,
  "history": [{ "id": "", "at": 0, "action": "", "detail": "" }],
  "theory": { "paper": "ViMax · arXiv:2606.07649v2", "doc": "docs/THEORY.md", "defaults": { "k": 2 } },
  "cover": { "url": "", "source": "name|upload|comfyui", "prompt": "", "updatedAt": 0 },
  "coverCalls": [{ "id": "", "at": 0, "ok": true, "promptId": "", "durationMs": 0, "prompt": "", "negative": "", "refs": [], "refCount": 0, "promptInjection": { "positive": null, "negative": null, "warnings": [] }, "applied": [], "logs": [], "error": "" }]
}
```

- 原著全文只存 `management.source.text`（画布节点仅存摘要）。`rag` 节点用 `originalCorpus` 调 `chunkNovel(512,128)` 分块，缓存在 `data/knowledge/<projectId>.json`；分集节点用 `ref` 边把梗概传给 `script`，不参与 DAG 执行分层。
- `cover` 由 `ensureManagement()` 为老项目惰性补齐；`projectIndex()` 同步下发到侧栏索引。`source:'name'` 表示使用项目名称封面（前端按项目名哈希生成稳定渐变色块 + 首字），`url` 非空时指向 `/assets/cover_*.png` 静态资源。`cover.prompt` **完整保存生成时实际使用的提示词（不截断）**——文本框内容即完整提示词，截断会破坏可复现性。
- `coverCalls` 为封面生成调用记录（上限 20 条，成功 / 失败均留档）：记录 `promptId`、耗时、完整提示词、负向提示词、参考图列表、提示词注入结果（`promptInjection` 即 plan：注入节点 / 策略 / 告警）与 `runWorkflow` 过程日志（`logs`，上限 60 行），供「版本 / 记录」Tab 回溯每次调用。

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
| GET | `/api/projects/:id/source` | 原著统计与全文（`buildSourceView()`）：`{ ok, stats, chapters, sources, episodes, text }`；前端在 404 时用 `localSourceView()` 等价回退 |
| GET | `/api/novel/sample` | 向导「载入示例小说」（`examples/sample-novel.txt`） |
| POST | `/api/novel/preview` | 实时分集预览，不落盘 |
| GET | `/api/bootstrap` | 额外返回 `steps: STEPS`、`stats`（全部 / 创作 / 完成 / 进行中 / 归档 / 收藏）与扩展后的项目索引 |
| POST | `/api/projects` | `kind:'novel'` 时走 `buildNovelProject()`；否则保持原模板创建 |
| GET / POST | `/api/projects/:id/manage` | 读取管理详情 / 执行 `rename · favorite · archive · tags · note · deliverables · split · reset-steps` |
| POST | `/api/projects/:id/duplicate` | 深拷贝副本（重置运行态、保留产物引用） |
| GET / POST | `/api/projects/:id/snapshots` | 列举 / 创建快照 |
| POST | `/api/projects/:id/restore` | 恢复快照（恢复前自动为当前状态留安全点） |
| POST | `/api/projects/:id/step` | 六步执行 / 重置 |
| POST | `/api/projects/:id/cover` | 上传本地封面（`{ dataUrl }` base64，校验格式 + 文件头 + 大小），写入 `data/assets`；可随带 `prompt` 完整落盘 |
| DELETE | `/api/projects/:id/cover` | 清除封面 → 回退「项目名称封面」 |
| POST | `/api/projects/:id/cover/chat` | 对话式封面创作：需求 + 参考图 → `designCoverPrompt`（`coverPromptDesign` intent，VLM 看参考图）产出 40~120 字完整中文描述句 |
| POST | `/api/projects/:id/cover/generate` | 用已配置的 ComfyUI 出图工作流生成封面：`rawPrompt` 原样直用（≤2000 字，不套模板），空则走 `designCoverPrompt`；多参考图逐 `LoadImage` 插槽注入。生成图只入资源库，返回 `generated{file,url} / prompt / promptId / durationMs`；确认后经 `POST /cover { asset, prompt }` 落定封面并**完整保存提示词**。每次调用（成功 / 失败）写入 `management.coverCalls` 调用记录（promptId / 耗时 / 提示词 / 参考图 / 注入结果 / 过程日志） |
| POST / PUT | `/api/comfyui/library` | 批量导入工作流库 / 切换选中项 |
| DELETE | `/api/comfyui/library/:kind/:id` | 删除工作流库条目 |

SSE `project:meta` 事件：`{ projectId, management, stats, progress }`。前端 `handleEvent` 用它刷新步骤面板、画布步骤条、顶栏胶囊与项目侧栏进度；`episode:update` / `character:batch` 另外防抖触发项目侧栏资源重扫（强制重取 `/api/assets` 索引）。`state.stats`（全局）与 `state.projectStats`（单项目）严格分离。

### 14.5 视觉规范（明确的四态提示）

| 状态 | 颜色 | 表现 |
|---|---|---|
| 待执行 | 灰 | 灰边卡片、空心编号、进度条空 |
| 进行中 | 橙 + 呼吸光晕 | `spGlow` 动画、状态胶囊脉冲、画布节点原有 `status-running` 光晕、连线流光 |
| 已完成 | 绿 ✓ | 编号变 ✓、耗时徽标、进度条填充、项目列表卡片「全完成」 |
| 失败 | 红 | 红边、失败原因、`重试本步` 按钮，可重置 |

统一提示面：向导三阶段指示、创建后的六步任务引导卡、检查器「任务步骤」Tab（`x/6` + 进度条 + 四色图例 + 每步检查清单 + 论文依据卡）、顶栏状态胶囊与 2px 进度条、画布上方六步导航条（点击定位相关节点）、Toast、运行日志、项目侧栏进度条。

### 14.6 画布保留约束

- 2026-11-06 时 `public/canvas.js` 一行未改；2026-11-08 为支持「每集独立画布 / 全部组合画布」仅给 `setProject()` 增加了 `resetHistory` 参数（切换范围时清空撤销栈）。平移 / 指针缩放 / 拖拽 / 框选 / 端口连线 / 小地图 / 适应视图 / 自动布局 / 撤销重做 / 视口外回到内容全部保留。
- 创作项目初始图 = 原 `novel2video` DAG（8 节点）+ 每集一个 `episode` 节点；后续智能体动态展开的节点照旧画在同一画布。
- 画布顶部在创作项目下由步骤导航条占据，`canvas-hint` 自动隐藏，避免两层提示重叠；`[hidden]` 兜底规则已覆盖新增组件。
- 「查看画布节点」按步骤 `scope` 选中并聚焦对应节点；「⤢ 适应视图」「⌗ 布局」「F」「L」仍可随时使用。

### 14.7 验证结论（2026-11-06）

| 项目 | 结果 |
|---|---|
| 单元测试 | `npm test` → **186 项全部通过**（`novel` 17 / `project-steps` 38 / `novel-project` 13 / `novel-ai` 6 / `knowledge` 13 / `comfy-lib` 8 / `comfy-lib-api` 5 / **`comfy-prompt` 8** / **`cover` 16** / **`cover-dialog` 5** / `asset-routes` 8 / `characters` 12 / `graph` 6 / `store` 4 / `assets` 8 / `orchestrator` 8 / `providers` 11），零依赖、毫秒级 |
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
| ComfyUI 生成 | 卡片齿轮「✦ 用 ComfyUI 生成封面」→ 对话式创作 | `POST /cover/chat` 对话式收集需求（`designCoverPrompt` 走 `coverPromptDesign` intent，VLM 看参考图产出 40~120 字完整中文描述句）→ 文本框内容**原样直用**（`rawPrompt` ≤2000，不套片名 / 风格模板），空则由 refs 感知的 `designCoverPrompt` 设计；多参考图逐 `LoadImage` 插槽注入，复用 `imageWorkflow` 走 `parseWorkflow() → runWorkflow()`（提示词注入三层优先级：显式绑定 > `{{占位符}}` > 沿图 BFS）→ 生成图只入资源库返回 `generated{file,url}` + `prompt / promptId / durationMs` → **大图预览确认后**才经 `POST /cover { asset, prompt }` 落定封面 |

- 三个入口统一走 `applyManageAction(project, 'cover', value)` → `saveProject()` → `broadcastMeta()` → SSE `state`，并写入 `management.history`；确认保存时随带生成实际使用的完整提示词（`prompt`）落盘**不截断**。
- 每次 `/cover/generate`（成功 / 失败）写入 `management.coverCalls` 调用记录（上限 20 条）：`promptId`、耗时、完整提示词、负向、参考图、提示词注入结果（注入节点 / 策略 / 告警）、`applied` 绑定明细与 `runWorkflow` 过程日志；管理面板「版本 / 记录」Tab 以折叠 `<details>` 展示过程日志，生成消息中显示调用号。
- 前端 `openAIChat()` 复用对话弹窗组件（消息气泡 / promptBlock / 建议 chips / 动作按钮 / 忙等）；`openGeneratedConfirm` 放大预览 3:4，生成期间显示忙碌遮罩并禁用关闭，避免重复提交。

### 14.11 项目重组：原著 / 分季分集 / 画布范围 / 资源归纳（2026-11-08）

> 目标：降低项目内信息密度、把资源按类型归纳，并让「导入的小说」与「分集」都有可查看、可操作的落点。

#### 14.11.1 数据落点

| 能力 | 权威数据 | 派生 / 只读 |
|---|---|---|
| 原著全文 | `management.source.text` | `buildSourceView()` 统计与章节目录；旧服务由 `localSourceView()` 前端重建 |
| 季 | `management.seasons[]`（`{no, title}`） | `seasonGroups(project)` 按季分组，含声明但未分配的空季 |
| 集 | `management.episodes[]`（全局唯一 `no` + `season`） | 季标题、侧栏季树、范围下拉 `optgroup` |
| 单集画布 | `management.episodes[n].canvas` | 首次进入 `seedEpisodeCanvas()` 播种并 `persist(true)` |
| 组合画布 | — | `composeOverallCanvas()` 派生，不落盘、不写回主画布 |
| 资源 | 项目 JSON 内 `/assets/` 引用 + 索引 `sourceProjectId` | `collectProjectAssets()` 统一口径，工作台 / 侧栏 / 资源库共用 |

**兼容性**：季字段全部缺省可读，老项目视为第 1 季；`chapters=[]` / `sources=[]` / `episodes[].text=''` 的历史数据在统计时惰性重建；`GET /source` 404 时前端不报错而是走等价回退。所有新增纯函数不改入参。

#### 14.11.2 范围切换与只读保护

```
#canvas-scope (change) ─► setCanvasScope(key)
   ├─ activeCanvasGraph()  ─ overall → composeGraph()（派生）
   │                        ├─ main   → project
   │                        └─ ep:N   → episodes[n].canvas（缺失则 seed + persist）
   ├─ canvas.setProject(graph, { keepViewport, resetHistory:true })
   ├─ updateCanvasScopeUI()  ─ 按季生成 optgroup + hint
   └─ scopeReadOnly()        ─ overall 时禁用运行/布局/删除/撤销与字段写回
```

检查器 `renderInspector()` 与 `activeNodeList()` 改为面向**当前范围**的图；`onFieldChange()` 在组合范围下不触发 `persist()`。SSE `state` / `syncProject()` 刷新时统一经过 `syncCanvasScope()`，避免把主画布快照覆盖到单集 / 组合视图。

#### 14.11.3 交互收口

- 项目会话内 `.app-only` 隐藏应用级入口、`.in-more` 隐藏次要项目按钮；`#more-menu` 通过 `data-more="source|seasons|assets|overall"` 直达工作台 Tab 或组合画布，`data-target` 复用既有按钮。
- 侧栏 `.ps-links` 四个快捷入口与按季分组的剧集树，每集带 `data-ep-canvas` 直达本集画布；页脚显示 `N 季 M 集`。
- 剧集详情头部增加「⬡ 本集画布」与「🌐 全部组合画布」入口。
- 工作台首屏只渲染概览 Tab；原著 Tab 默认全文阅读（不截成第一章），分集 Tab 提供季下拉与跨季移动，资源 Tab 按类型给出统计卡与缩略图网格。

#### 14.11.4 验证

`npm run check` 93 文件通过；`npm test` **284/284**（本轮新增 `source-view` 6 / `canvas-compose` 6 / `project-model` 9 共 21 项）。Electron 33 offscreen 连隔离服务 `LINGXIMANJU_DATA_DIR=/tmp/lxm-e2e-data-4 PORT=45423` 真机 E2E **35/35 断言通过、0 JS 运行时错误**，覆盖四 Tab、原著统计与全文、新增 / 重命名 / 跨季移动与刷新持久化、资源归纳、单集画布、组合画布（250 节点 / 417 连线）、主画布、更多菜单与关闭返回列表。真实 `data/projects/*.json` 未被写入。详见 [`VERIFICATION.md`](VERIFICATION.md)。

### 14.12 代码结构整理：共享层与纯函数边界（2026-11-08）

> 目标：在不改变任何现有文件路径、不改动业务行为的前提下，消除重复实现、明确依赖方向，让规则类逻辑可被单测直接覆盖。

#### 14.12.1 整理前的问题

| 现象 | 影响 |
|---|---|
| `esc` / `escapeHTML` 在 14 个前端模块各写一份 | 存在两种转义强度：多数只转 `& < > "`，少数还转 `'`；单引号属性值有注入风险，且修复一处不会同步到其他模块 |
| `cut` 在 9 个模块各写一份 | 两种语义并存：`slice(0, n) + '…'`（输出 n+1 长度）与 `slice(0, n - 1) + '…'`（输出 ≤ n），同一文案在不同视图被截成不同长度 |
| `num` / `clamp` / `uid` / `fmt` / `str` / `escapeRegExp` 各有 2–3 份 | 口径漂移，无法统一加固 |
| 画布范围的「分组 / 签名 / 提示 / 只读」规则散在 `app.js` 的 `updateCanvasScopeUI()` 等函数里 | 与 DOM 写入混在一起，无法单测；规则改动只能靠真机点测 |
| `styles.css` 单文件 1700+ 行 | 只有零散分节注释，缺少全局导航与命名约定 |

#### 14.12.2 分层与依赖方向

```
public/utils.js          零依赖 · 无 DOM 副作用 · 唯一一份通用纯工具
   ▲          ▲
   │          │
纯函数层      视图 / 引擎层（nodes / canvas / 各 *-view / panels / ...）
project-model.js            │
canvas-compose.js           │
canvas-scope.js ────────────┘
   ▲
   └── public/app.js（只做编排：把纯函数结果写进 DOM、绑定事件、驱动画布）
```

- `utils.js` **不 import 任何业务模块**，因此 `nodes.js → utils.js`、`canvas.js → utils.js` 等不会形成环。
- `canvas-scope.js` 只依赖 `project-model.js` 的 `parseScopeKey()`；范围键编解码仍归 `project-model.js`，下拉数据仍归 `canvas-compose.js`，本模块负责「怎么分组、何时算变化、显示什么、是否只读」。
- 所有新模块顶层不触碰 `document` / `window` / `localStorage`（`$()` 内部用 `typeof document` 保护），`node:test` 可直接导入。

#### 14.12.3 统一口径与两处有意的健壮性提升

| 项 | 统一后 | 说明 |
|---|---|---|
| `esc(s)` | 转义 `& < > " '`，`null/undefined` 归空串 | 升级为原先更安全的版本；浏览器中 `&#39;` 仍渲染成 `'`，视觉无变化 |
| `cut(s, n)` | 输出长度 ≤ n，`…` 计入 n | 与 `source-view` / `canvas-compose` 等原本较严格的口径对齐；原 `slice(0,n)+'…'` 的调用方少 1 个字符 |
| `uid(prefix)` | 时间戳 + 单调递增序列 + 随机尾 | 原实现同毫秒内高频调用约 7% 概率碰撞（单测曾偶发失败），补序列后同毫秒连续调用也唯一；调用方只用其作 id 值，不依赖格式 |
| `EMPTY_CANVAS_PROJECT` | 从 `app.js` 移到 `canvas-scope.js`，保持普通对象 | 不冻结，避免画布空态被写入时由静默失败变成 TypeError |

除上述两点（转义强度、uid 唯一性）属于**修复**外，其余均为等价搬移，`cut` 的长度统一只影响省略号位置，不改变任何业务流程或数据结构。

#### 14.12.4 验证

`npm run check` **97 文件**通过；`npm test` **299/299**（新增 `utils` 8 项、`canvas-scope` 7 项）。另做 ESM 链接与符号完整性扫描，确认 19 个被改模块无重复声明、无漏导入。Electron 33 offscreen 连隔离服务 `PORT=45423` 复跑既有 E2E **35/35、0 JS 运行时错误**，两张深色主题截图目视确认无转义残留与布局回归。详见 [`VERIFICATION.md`](VERIFICATION.md)。

### 14.13 项目退出出口统一（2026-11-08）

> 需求：从项目列表进入项目工作台后，只有「项目设置 → 退出项目」与右上角退出按钮可以退出工作台。

#### 14.13.1 收敛前的出口清单

| 旧出口 | 位置 | 处理 |
|---|---|---|
| `✕ 关闭项目` 小图标 | 顶栏 `tb-left`，项目名旁 | **改造保留**：移到 `tb-right` 最右侧，保留 id `btn-close-project`，改为明确文字「⇦ 退出项目」，加深色主题下偏红的描边 |
| 项目卡右上角 `✕` | `project-sidebar.js` `.ps-home-btn` / `data-act="home"` | 删除（项目卡是信息展示区，不该承载破坏性操作） |
| `⌂ 项目列表` | `index.html` `#btn-home`（`.app-only`，实际一直隐藏） | 删除 DOM、事件绑定与 `setView()` 里的显隐操作 |
| `✕ 关闭项目` 面包屑 | `updateCrumb()` 剧集详情 `data-crumb="home"` | 删除；剧集面包屑只保留「项目名 / 第 N 集」，项目名链接回工作台 / 画布 |
| `H` 快捷键 | `app.js` keydown | 删除；退出不设快捷键，避免误按 |
| 项目设置里无退出项 | `project-sidebar.js` `.ps-settings` | **新增** `data-act="exit-project"`，`grid-column: 1 / -1` 独占整行、偏红样式 |

#### 14.13.2 唯一出口函数

```js
function requestExitProject() {
  if (!state.project || state.view === 'home') return undefined;
  const menu = $('more-menu');
  if (menu) menu.hidden = true;
  return closeProject();
}
```

- 两处 UI 都只绑这一个函数：顶栏按钮 `addEventListener('click', requestExitProject)`，侧栏 `onExitProject: requestExitProject` → `case 'exit-project'`。
- `closeProject()` 仍是唯一真正清理会话的实现，负责 `state.project = null`、清画布 / 浮层 / 日志 / 计时器 / 模型作用域、`setView('home')`、`refreshProjects()` 与「继续上次项目」。
- 项目被删除 / 外部移除时的两处 `closeProject({ silent: true })` 属内部清理，保留不变；它们不经过 `requestExitProject()`，也不是用户可见出口。
- 契约由 `tests/project-exit.test.mjs`（5 项结构断言）锁定：读源码校验两处出口存在、旧出口消失、无参 `closeProject()` 只出现一次、帮助与样式同步。

#### 14.13.3 验证

`npm run check` **98 文件**通过；`npm test` **304/304**（新增 `project-exit` 5 项）。Electron 33 offscreen 连隔离服务 `LINGXIMANJU_DATA_DIR=/tmp/lxm-e2e-data-6 PORT=45423` 复跑扩展后的 E2E **42/42、0 JS 运行时错误**，新增覆盖：右上角按钮在 `.tb-right` 且文字为「退出项目」、设置区出口唯一、旧出口清零、`H` 不再退出、剧集面包屑无关闭项、两处出口各自都能回列表且无残留。截图目视确认右上角按钮与设置区独占行按钮无重叠 / 溢出。详见 [`VERIFICATION.md`](VERIFICATION.md)。


