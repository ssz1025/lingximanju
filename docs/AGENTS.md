# lingximanju 智能体编排设计

> 与 `ARCHITECTURE.md` 配套。本文定义「有哪些智能体、它们如何被组织、如何并行、如何失败恢复、画布上如何表达」。
> 文中「论文式(N)」指 ViMax 论文（arXiv:2606.07649v2）的公式编号；中文全文与「论文 ↔ 本项目代码」对照表见 [`paper/README.md`](paper/README.md)。

---

## 1. 设计原则

1. **一个节点就是一个可执行的智能体任务**：节点 = 任务实例，边 = 数据/视觉依赖，画布 = 编排图本身。用户改图即改流程，不需要写配置文件。
2. **编排器不认识业务**：`orchestrator.mjs` 只做拓扑排序、并发控制、状态机、事件广播；具体做什么全部交给注册的 Agent。
3. **Agent 无状态**：所有输入来自上游节点 `data` 与项目 `settings`，所有输出通过 `ctx.patch / ctx.addNodes / ctx.addEdges` 写回，不在内存里保存跨轮状态 → 天然支持断点续跑。
4. **可解释**：每个 Agent 的每次执行都产生 `log`（思考摘要）、`meta`（耗时/成本）与节点产物，右侧检查器可逐节点回看。
5. **可降级**：模型调用失败自动回退 Mock，流程不中断，日志明确标注。

---

## 2. 智能体清单（11 个）

| # | id | 角色 | 输入 | 输出（`node.data`） | 依赖 |
|---|---|---|---|---|---|
| 1 | `screenwriter` | 编剧 | `idea.text` | `script`: 标题、类型、角色表、场景剧本数组 | 论文式(1) |
| 2 | `decomposer` | 叙事分解 | `script` / `idea.text` | `events[]`：`{title, summary, processChain}`；运行中生成 `event` 节点与下游 `scene` 节点 | 式(5) |
| 3 | `rag` | 全局上下文 | 原文 + 各节点描述 | `context`: 检索片段、角色动机、伏笔；把增强描述写回目标节点 | 式(6) |
| 4 | `character` | 角色造型 | `script.characters` | `characters[]`：`{name, appearance, palette, portraitUrl}`；生成三视图 SVG | ViMax 角色抽取 |
| 5 | `storyboard` | 分镜规划 | `scene` + `script` | `shots[]`：`{shotNo, size, angle, movement, ffDesc, motionDesc, duration}`；逐镜头建 `shot` 节点 | 式(2) |
| 6 | `camera-graph` | 机位依赖图 | 同场景 `shots[]` | `cameras[]`：`{id, shots, parent, anchorFrom}`；建立 `anchor` 虚线边 | 式(7) |
| 7 | `keyframe` | 关键帧生成 | 镜头规格 + 角色资产 + 锚点图 | `candidates[]`：`{url, prompt, refs}`（k 个） | 式(3) 上半 |
| 8 | `review` | VLM 质量择优 | `candidates[]` | `selected`: 索引、分数、理由；`keyframeUrl` | 式(4) / RQ6 |
| 9 | `video` | 镜头视频 | 选中关键帧 + 运动描述 | `clip`: `{poster, frames[], duration, url, file, provider}`；ComfyUI 模式产出真实片段 | 式(3) 下半 |
| 10 | `transition` | 转场空间锚点 | 两机位关键帧 | `transition`: `{url, fromCam, toCam, spatialNotes}` | 式(8) |
| 11 | `composer` | 成片组装 / 双产物交付 | 所有 `clip` + 全图节点 | `timeline[]`、`duration`、`poster`、`film`、`directorPack`、`deliverables` | 拼接 + 交接 |
| 12 | `canvas-agent` | 画布助手 | 画布全图 + 用户指令 | 对话回复 + 可选图操作（整理/新增/解释） | Toonflow 浮动 Agent |

> 注：编号 12 为对话型 Agent，不参与 DAG 调度，由 `/api/projects/:id/chat` 单独驱动。

**分组**：叙事组（1–3）、资产组（4）、镜头组（5–6）、生成组（7–10）、交付组（11）、交互组（12）。

---

## 3. 执行上下文（`ctx`）

```js
{
  project, node,                 // 当前项目与节点
  inputs,                        // 上游节点 data 数组（按边顺序）
  upstream,                      // [{id, type, data}] 便于按类型筛选
  settings,                      // provider / k / concurrency / style
  providers,                     // llm / image / video / judge
  signal,                        // AbortSignal，支持取消
  log(level, message),           // 写 SSE 日志
  progress(0..1),                // 写节点进度
  patch(obj),                    // 局部合并 node.data
  addNodes([...]), addEdges([...]), // 运行中动态展开画布
  setTitle(str)
}
```

Agent 签名统一为 `async run(ctx) -> void`，**返回值不承载业务数据**，所有结果写回节点，保证前端与持久化看到同一份状态。

---

## 4. 编排算法

```
run(projectId, { nodeId? })
 1. 读项目快照 → 构造可执行子图
      · 指定 nodeId：取该节点 + 全部下游（递归）
      · 未指定：取 status ∈ {idle, error} 的节点 + 其下游
      · status=done 的节点作为只读输入，不重跑
 2. graph.topoLayers(subgraph)  // Kahn：同层 = 可并行
 3. for layer of layers:
      for batch of chunk(layer, settings.concurrency):
        await Promise.allSettled(batch.map(executeNode))
 4. executeNode(node):
      emit node:status(running) → 汇总 inputs → agents[id].run(ctx)
      → emit node:status(done) + node:data → 捕获异常 emit error
      → 上游失败则下游 skipped
 5. 每个写操作经 store.save() 原子落盘（防抖 120ms）
 6. emit run:done（统计：节点数、耗时、模拟成本、并行层数）
```

**为什么按层并发**：论文的机位依赖图本质上是一个 DAG，拓扑序保证「父机位的关键帧一定先于子机位生成」，同层分支（互不依赖的镜头）才能并行——这正是论文 3.5 中 405s 优于 835s 串行的原因。画布上表现为：同一列的节点同时亮起，依赖列依次推进。

**动态建图的处理**：`decomposer` / `storyboard` / `camera-graph` 会新增节点。编排器在每层执行完后重新收集「本轮新增且属于当前子图下游」的节点，插入后续层，避免展开出的镜头被漏跑。

---

## 5. 三套流水线模板

模板不是硬编码流程，而是**生成一张初始节点图**，用户可以在画布上任意改。

### 5.1 `idea2video`（一句话 → 成片，默认）

```
idea ─► script ─► event×N ─► scene×N ─► storyboard ─► shot×M
                     │                        │
                     └─► rag（上下文）        ├─► character ─► (ref 到每个 shot)
                                             └─► camera-graph ─► anchor 虚线
shot ─► keyframe(k) ─► review ─► video ─► composer ─► final
                   └─► transition（跨机位）┘
```

### 5.2 `script2video`（给定剧本 → 成片）

跳过 `screenwriter`，以 `script` 文本节点为根；其余与 5.1 相同。适合已有分镜稿、需要精确控制的场景。

### 5.3 `novel2video`（长篇小说 → 分集）

增加 `rag` 索引节点与 `event` 事件链（`processChain` 保序），先做「小说压缩 → 事件图谱 → 场景」，再复用 5.2 内核；角色由 `rag` 跨场景合并，保证同一人物在多个事件里指向同一个 `character` 节点（对应论文「全局上下文感知」）。

**模板应用**：`POST /api/projects/:id/template` 清空当前图、按模板生成节点与 `flow/anchor/ref` 三类边、自动布局后通过 SSE `state` 全量刷新。

---

## 6. 关键机制的实现映射

### 6.1 层次化分解 + RAG

`decomposer` 把剧本递归拆成 `事件 → 场景 → 镜头` 三层节点，节点描述只写「范围与边界」；`rag` 对原文建简易倒排索引（中文按 2-gram + 关键词权重），用节点描述检索原文片段，生成 `context` 字段并合并回节点。这样局部规划始终带全局信息，避免论文 2.2.2 指出的「分解丢细节」问题。画布上用 `ref` 点线把 RAG 节点连到各层节点，直观展示「上下文来自哪里」。

### 6.2 机位依赖图与视觉锚点

`camera-graph` 为同一场景内的镜头分配机位，按「是否出现相同角色 / 是否同一环境 / 视角跨度」建立父子关系，输出 `anchor` 边。`keyframe` 执行时读取所有入边为 `anchor` 的上游节点，把其 `keyframeUrl` 作为 `refs` 传入图像生成；无依赖的镜头同层并发生成。对应论文式(7) 的 `A_i` 视觉锚点传播。

### 6.3 转场视频空间锚点

当两个机位存在较大视角变化时，`transition` 生成一段「从机位 A 平滑移动到机位 B」的过渡资产（Mock 模式为渐变合成 SVG + 空间说明），并把 `spatialNotes`（人物相对站位、道具、轴线）写入下游镜头，保证反打镜头不穿帮。对应式(8)。

### 6.4 VLM best-of-k 质量闸门

`keyframe` 一次产出 k 张候选（默认 k=2，来自论文 RQ6 的结论），`review` 按「视觉保真 / 叙事一致 / 镜头规格遵循」三项打分择优，落选候选保留在节点 `candidates` 里供检查器对比。去掉该节点即可做消融实验：画布上删除 `review` 边、把 `keyframe` 直连 `video`。

### 6.5 断点续跑与单节点重跑

节点状态与产物都持久化。右键任一节点「从此处重跑」= 以该节点为根构造下游子图，上游 `done` 节点作为输入。失败的分支不会污染其它分支，符合长视频流水线「改一个镜头不必重做全片」的实际需求。

---

## 7. 画布侧 Agent（`canvas-agent`）

参考 Toonflow 的浮动 Agent：它不是聊天框，而是**能读画布、能操作画布的协作者**。

支持的意图（由 `POST /api/projects/:id/chat` 解析，支持 `@节点ID` 引用）：

| 意图 | 触发示例 | 动作 |
|---|---|---|
| 概览 | 「这个项目现在到哪一步了」 | 统计各状态节点、找出阻塞点、生成摘要 |
| 解释依赖 | 「@n_7 为什么依赖 @n_3」 | 追溯边，用中文解释数据流/视觉锚点 |
| 整理画布 | 「整理一下画布」 | 调用自动布局，返回移动了多少节点 |
| 生成分镜 | 「给 @n_4 补 4 个镜头」 | 调用 `storyboard` 生成节点并连线 |
| 一致性检查 | 「检查角色一致性」 | 遍历 `character` 与 `ref` 边，指出未引用资产的镜头 |
| 下一步建议 | 「接下来做什么」 | 按拓扑找首个 `idle` 节点并建议运行 |

回复以 SSE `chat` 事件分段流出；涉及图修改时追加 `state` / `node:add` 事件，画布实时更新。

---

## 8. 失败、取消与可观测性

- **超时**：单个 Agent 默认 30s（Mock 为 0.2–1.2s 模拟耗时），超时记 error 并继续其它分支。
- **取消**：`POST /stop` 触发 `AbortController.abort()`，运行中节点收到 signal 后尽早退出；队列节点回到 `idle`。
- **日志分级**：`info` 常规、`think` 智能体思考摘要、`warn` 回退/降级、`error` 失败；状态栏可按级别过滤。
- **成本与耗时**：每个节点记录 `durationMs` 与估算 `cost`，运行结束汇总，便于对照论文 3.7 的成本—质量权衡。
- **审计**：`project.runs` 保留最近 20 次运行摘要，包含节点数、并行层数、总耗时、失败数。

---

## 9. 如何扩展

1. **加一个 Agent**：`src/agents/*.mjs` 中 `defineAgent({id, label, group, run})`，在 `src/agents/index.mjs` 注册；编排器与 UI 自动可用。
2. **加一种节点类型**：`public/nodes.js` 的 `NODE_TYPES` 增一项，声明 `color / icon / fields / preview`；节点库自动出现。
3. **换模型**：实现 `providers.mjs` 的四个方法，或在设置页切 `openai` 兼容端点；Agent 代码零改动。
4. **换调度策略**：`orchestrator.mjs` 的 `topoLayers` 替换为优先级队列/成本感知调度即可，事件协议不变。

---

## 10. 与 ViMax / Toonflow 的边界说明

- 本项目**不复制** ViMax 的 Python 实现、提示词文本或 Toonflow 的画布源码；只复刻其公开的功能形态与论文中的方法思想。
- 编排器是通用 DAG 执行器，Agent 是可插拔插件，画布是自研渲染层——三层均可独立替换。
- Mock 模式用于无 Key 演示完整流程；接入真实图像/视频模型后才能产出真实视频文件，这一点在产品内也明确告知用户，不制造「已生成成片」的错觉。

---

## 11. 生成后端与交付型 Agent

### 11.1 Agent 不感知供应商

`keyframe` / `transition` / `character` / `composer` 里的海报，以及 `video`，统一调用 `ctx.providers.image()` / `video()`。Agent 只关心「给我一张图 / 一段视频」，不写任何 ComfyUI URL、节点 ID 或 HTTP 调用。供应商切换由 `createProviders(settings)` 内部完成：

| 条件 | image() 行为 | video() 行为 |
|---|---|---|
| 配置了 ComfyUI 出图工作流 | 提交 API 工作流，返回 `{url, provider:'comfyui'}` | — |
| 配置了视频工作流且 `outputMode !== 'director-pack'` | — | 上传首帧 → 提交工作流 → 返回 `{url, file, provider:'comfyui', synthetic:false}` |
| 未配置 / 调用失败且 `strict=false` | 回退 Mock SVG | 回退帧序列预览 |
| 调用失败且 `strict=true` | 抛错，节点标 `error`，下游 `skipped` | 同左 |

编排器把全局 `data/comfyui.json` 与项目 `settings.comfy` 合并后，通过 `buildContext({ settings })` 注入 `ctx.settings`，因此交付 Agent 能读到 `outputMode` / `packTarget` / `stitch`，但全局配置不会污染项目快照。

### 11.2 `video` 的交付决策

```
clip.frames[0]（选中关键帧）
   └─ referenceBuffer()  ── SVG → PNG 占位 / 真实 PNG 直读
        └─ runWorkflow(videoWorkflow, { prompt: motionDesc, frames: duration*fps, ... })
             └─ clip = { url, file, poster, duration, provider, synthetic:false }
```

`outputMode='director-pack'` 时跳过整条链路：导演包把首帧与提示词交给 ComfyUI 导演工作台，视频由对方生成，本地不重复占用 GPU。

### 11.3 `composer` 的双产物职责

`composer` 仍是 DAG 的汇聚节点（等待所有 `video` 节点完成），在原有 `timeline[] / duration / poster` 之外新增两段：

```
outputMode = ctx.settings.comfy.outputMode   // both | video | director-pack

if (mode !== 'director-pack' && stitch && realClips.length)
    film = stitchClips(clips)                // ffmpeg concat，失败返回 null 并写日志
if (mode !== 'video')
    directorPack = exportDirectorPack(ctx.project, cfg)   // mmxpack / generic

ctx.patch({ film, directorPack, deliverables: { outputMode, video, directorPack }, outputMode })
```

`deliverables` 是给前端检查器的**展示契约**：成片卡片显示片段数 / 拼接方式 / 下载按钮，导演包卡片显示文件名 / 组数 / 文件数 / 重新导出按钮。二者都为空时明确写「Mock 模式为帧序列预览」，不伪造产物。

### 11.4 导演包与画布元素的映射

`director-pack.mjs` 只读画布，不改画布：遍历 `video` 节点按 `shotNo` 排序 → 找上游 `review` 取选中关键帧 → 从 `character` 节点取定妆图 → 从 `transition` 节点取空间锚点 → 组装 `shared_params/` 与 `asset_groups/NN/` → `createZip()` 落盘。因此**用户在画布上改连线、改提示词、删镜头，重新导出即反映到导演包**，不需要重跑生成模型。

### 11.5 可观测性

- 每次 ComfyUI 提交写入日志：`已排队 <prompt_id> · 注入 N 个参数`、完成耗时、下载产物数。
- 参考图上传、回退 Mock、拼接失败、导演包生成均有 `ctx.log` / SSE 日志。
- 成片节点的 `meta` 仍记录耗时与成本估算；`report.realClips` 记录真实片段数，便于区分 Mock 与真实出片。
