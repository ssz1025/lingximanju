# 设计：ComfyUI 工作流库（多导入 + 真实试跑）

日期：2026-11-06
状态：已确认（方案 A：库内置 `data/comfyui.json`）

## 背景与目标

设置弹窗中「出图工作流 / 视频工作流」各只有一个槽位（单文件导入 + 分析按钮），全局配置存 `data/comfyui.json`（`imageWorkflow` / `videoWorkflow` 单对象 + `*Name`）。

目标：

1. 出图、视频各支持**导入多个** ComfyUI「导出(API)」JSON，形成工作流库；库中每类有一个**当前生效**的选中项，切换即生效。
2. 导入后可**测试是否导入成功**：测试 = 真实提交本地 ComfyUI 串行试跑，逐项记录成功/失败。
3. 支持一次多选批量导入、删除、重命名库项。

已确认的需求决策：

1. 用途：工作流库 + 选中生效（非同时运行多个、非仅存储）。
2. 测试级别：必须真实试跑（非仅静态校验）。
3. 存储方案：方案 A，库内置 `data/comfyui.json` 单文件，消费端零改动。

## 非目标

- 不做多工作流同时/并行参与一次生成。
- 不把库拆成多文件（方案 B）、不用前端 IndexedDB 存库（方案 C，违背「数据只写 data/」承诺）。
- 不改 ComfyUI 侧能力：试跑复用现有 `runWorkflow` 与测试提示词。
- 不做工作流在线编辑（只读查看/复制 JSON）。

## 数据模型与迁移（src/core/comfy-config.mjs）

`DEFAULT_COMFY` 新增字段：

```js
imageWorkflowLib: [],   // [{id, name, workflow, createdAt, lastTest: {ok, durationMs, at, error}|null}]
videoWorkflowLib:  [],   // 同构
imageActiveId: null,
videoActiveId:  null,
// 保留 imageWorkflow / imageWorkflowName / videoWorkflow / videoWorkflowName 作为「当前生效」镜像
```

规则：

- **迁移**（`normalize` 内）：旧配置若 `imageWorkflow`（或 `videoWorkflow`）非空而对应库为空 → 生成 id，以 `*Name` 为名加入库并设为 `*ActiveId`，镜像字段保持原值。库非空时不做覆盖。迁移失败（异常）时保留镜像，下次 load 重试，保证不丢工作流。
- **切换选中**：`saveComfyConfig` 收到 `imageActiveId` / `videoActiveId` 变化时，从库取对应项回填镜像 `imageWorkflow/Name`；id 在库中不存在 → 视为清空（镜像置 null，回退 Mock）。
- **删除选中项**：`*ActiveId` 置 null，镜像置 null。
- **镜像冗余的意义**：`providers.mjs`（`createProviders` 读 `comfy[`${kind}Workflow`]`）、`director-pack.mjs`、`/api/comfyui/run-test`、`comfySummary` 等全部消费端**零改动**。
- `normalize` 对库做防御性清洗：非数组清空、项缺 `id/workflow` 丢弃、`name` 缺省为 `未命名工作流`、`lastTest` 非对象置 null。
- `comfySummary` 增加 `imageWorkflowLib` / `videoWorkflowLib` 概览数组：`[{id, name, nodes, createdAt, lastTest}]`，**不回传 workflow 本体**；原 `imageWorkflow/videoWorkflow` 概览字段保留。

## API（src/api/routes.mjs）

| 端点 | 方法 | 作用 |
|---|---|---|
| `/api/comfyui/library` | POST | 批量导入：`{kind: 'image'|'video', items: [{name, workflow}]}`。逐项 `parseWorkflow` 校验 + 静态格式检查（必须 API 格式，拒绝界面格式 `nodes/links`），**非法项单独计入 failed，不阻断合法项入库**。同名同内容 → 跳过计入 failed（提示「已存在」）；同名不同内容 → 名称自动加 `(2)` 后缀入库。返回 `{added: [{id, name}], failed: [{name, error}]}` |
| `/api/comfyui/library` | PUT | 切换选中：`{kind, id}` → 回填镜像后返回新 summary |
| `/api/comfyui/library/:kind/:id` | DELETE | 删除库项；删选中项 → 镜像清空 |
| `/api/comfyui/test-batch` | POST | 真实试跑：`{kind, ids: [...]}` → 串行逐项 `runWorkflow`（复用 `/api/comfyui/run-test` 的参数：测试提示词、`filenamePrefix: 'lingximanju_test'`、该 kind 的 bindings），每项完成即把 `lastTest` 写回配置（落盘），返回 `[{id, ok, durationMs, error}]` |

试跑约束：

- **串行不并发**，避免与正常生成抢 ComfyUI 队列；单个失败记录错误继续下一个。
- 试跑开始前先 `testConnection(baseUrl)`：连不上 → 整批返回 `{connectionError}`，不逐项空等超时。
- 单项超时沿用 `cfg.timeoutMs`（15 分钟默认），超时记 `ok:false, error:'超时'`。
- 客户端 `fetch` abort → 服务端在当前项 `signal` 触发后停止后续项（复用 `runWorkflow` 已有的 signal 支持）。

## UI（public/panels.js 设置弹窗）

出图/视频两个区块从「单槽位 textarea」改为**工作流库列表**：

- 每行：单选（选中 = 生效）· 名称 · 节点数 · 测试徽标（未测 / ✓ 用时 / ✕ 错误 tooltip）· 删除按钮；点击行展开只读 JSON 详情（可查看/复制，非编辑）。
- 顶部「⇧ 导入 JSON」：`input.multiple` 一次多选；导入后立即对新增项**自动逐个真实试跑**（串行），行内转圈状态，完成刷新徽标；结果用 toast 汇总（`新增 3 · 失败 1`）。
- 「▶ 测试全部」：串行试跑库内全部项，进度经 SSE `log` 事件回显到 `#cf-result`。
- 选中切换即点单选 → `PUT library` → toast 确认；textarea 仅作为选中项只读详情保留于展开行内。

## 边界与错误处理

- ComfyUI 未连接：试跑整批标记连接失败（见 API 节）。
- 重复导入：同名同内容跳过报「已存在」；同名不同内容自动 `(2)` 后缀。
- 删除正在使用的库项：确认弹窗；确认后镜像清空，toast 提示已回退 Mock。
- 导入非法 JSON：该项进 `failed` 带原因（「不是合法 JSON」「是界面保存格式，请导出(API)」），合法项正常入库。
- 旧配置迁移：镜像有值而库空时每次 load 重试构建，幂等不重复（以镜像是否已在库中按内容比对去重）。

## 验证清单（无测试框架，手工）

1. `./start.sh` 启动，打开设置 → ComfyUI 页。
2. 多选导入 3 个 JSON（含 1 个界面保存格式）→ 2 入库、1 报错提示「请使用导出(API)格式」。
3. 导入后自动串行试跑 → ✓ 用时徽标 / ✕ 错误徽标正确；ComfyUI 关闭时 → 整批「连接失败」。
4. 切换选中项 → `data/comfyui.json` 中镜像字段更新 → 跑一次出图，日志确认用的是新工作流。
5. 删除选中项 → 确认弹窗 → 镜像清空，出图回退 Mock 自绘。
6. 重启服务 → 库、选中态、lastTest 保留。
7. 旧配置（无库字段）首次加载 → 单槽位自动迁移为库第一项且为选中。
8. 同名不同内容重复导入 → 自动 `(2)` 后缀；同名同内容 → 报「已存在」。
