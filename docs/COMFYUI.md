# 接入本地 ComfyUI（图片 / 视频主路径）

### 1. 准备

以监听模式启动本机 ComfyUI：`python main.py --listen 127.0.0.1 --port 8188`。在 ComfyUI 里把出图、图生视频工作流各跑通一次，然后用工作流菜单的 **「导出(API) / Export (API)」** 保存 JSON —— 必须是 API 格式（`{节点ID: {class_type, inputs}}`），普通「保存」的界面格式会被明确拒绝。仓库 `examples/workflows/` 下有两份可直接改造的示例。

### 2. 配置

顶栏 ⚙ 设置 → 第二个 Tab「本地 ComfyUI / 最终产物」：填地址 → 分别「导入 JSON」两份工作流 → 「测试连接」→ 需要时点「⌗ 分析」查看自动识别到的注入点 → 设置尺寸 / 帧率 / 采样 / 产物模式 → 保存。配置写入 `data/comfyui.json`（全局复用，不随项目 JSON 走）。

**逐个工作流独立测试**：出图 / 视频工作流库的每一行都有「▶ 测试」按钮，只向本地 ComfyUI 提交**该工作流一次真实生成**，不牵动其它行。结果框会显示耗时、成功 / 失败原因、`prompt_id`、产物数量与缩略图、提示词实际注入的节点与策略、注入告警；实时进度日志追加在同一结果框中，并把成功 / 失败状态写回该行的 `lastTest` 徽标，可随时点按钮重跑。「▶ 测试全部」则按库顺序串行跑完所有行。同一时间只允许一个试跑任务（单项或批量），避免抢占 ComfyUI 队列。接口也支持可选的自定义测试提示词 `prompt`。

**参数注入分三层，优先级从高到低**：

| 层 | 用法 | 适用 |
|---|---|---|
| 显式绑定 | `settings.bindings.image/video = [{node:'6', input:'text', value:'{{prompt}}'}]` | 节点 ID 不常规、需要精确控制 |
| 占位符 | 在工作流任意字符串输入里写 `{{prompt}}` `{{negative_prompt}}` `{{seed}}` `{{width}}` `{{height}}` `{{frames}}` `{{fps}}` `{{duration}}` `{{filename_prefix}}` `{{title}}` `{{shot_no}}` | 最直观，推荐 |
| 自动识别 | 沿图回溯 `KSampler.positive/negative → CLIPTextEncode → 上游字符串节点`，定位真正的提示词源；`seed/noise_seed/sampling_mode.seed` → 每次随机（避开 ComfyUI 缓存）；`width/height`；`num_frames/frame_count/length` → 镜头时长 × fps；`fps`；`filename_prefix`；`LoadImage.image`；`SaveImage`/`VHS_VideoCombine` 等输出节点 | 不想改工作流时 |

> ⚠️ **「所有镜头生成的都是同一张图」的根因**：Krea2 / Qwen-Image / Flux 等现代工作流把提示词放在 `PrimitiveStringMultiline`、`StringConcatenate`、`TextGenerate`（提示词润色）或 `Switch` 里，`CLIPTextEncode.text` 只是连线 `[节点ID, 0]`。旧版只认「`CLIPTextEncode.text` 是字符串」的节点，于是一个提示词都不注入，每次都沿用工作流里写死的那句话，只剩随机种子带来一点姿态差异。现在注入器会沿输入连线回溯，自动找到真正的用户提示词节点（例如 Krea2 的 `30:19.value`「Text String (User Prompt)」），并**跳过系统提示词、LoRA 触发词与负向链路**；确实找不到任何文本源时，才兜底把提示词直接写进 `CLIPTextEncode.text`（会绕过润色链路，同时在日志告警）。

**自检**：设置页「⌗ 提示词注入自检」在打开面板时自动本地干跑一次（不连 ComfyUI），显示两份生效工作流把提示词写到了哪个节点、用的什么策略（`binding` / `placeholder` / `clipText` / `primitive` / `overrideLink`）。若显示「✕ 有风险 / 未找到注入点」，说明该工作流仍会产出雷同画面 —— 请在提示词节点写 `{{prompt}}`，或用显式绑定指定节点。运行日志同样回显注入位置，例如 `提示词 → 30:19.value「Text String (User Prompt)」· primitive · "雨夜霓虹街头…"`。

运行时链路：`POST /upload/image`（上传首帧 / 角色参考，SVG 自动渲染成 PNG）→ `POST /prompt` → 轮询 `GET /history/{prompt_id}` → `GET /view` 下载产物到 `data/assets/` → 回填到画布节点。每次运行的 `filename_prefix` 带唯一后缀，避免自定义输出节点复用同名文件。支持超时、取消、`node_errors` 可读化；`strict=false`（默认）时失败自动回退 Mock 并在日志标注。

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
| POST | `/api/comfyui/analyze` | 分析工作流（可传 `kind` 取当前生效工作流），返回可注入节点清单 + `promptInjection` 干跑计划 |
| POST | `/api/comfyui/inject-check` | 本地干跑自检：图片 / 视频两份生效工作流的提示词注入位置、策略与告警 |
| POST | `/api/comfyui/run-test` | 用当前配置试跑一次工作流，响应含 `promptInjection` |
| POST | `/api/comfyui/test-one` | 设置页每行「▶ 测试」：按 `{kind, id, prompt?}` 单独试跑库中某一个工作流，返回 `result`（成功 / 失败、耗时、prompt_id、产物、提示词注入计划与告警），并只写回该行 `lastTest`；id 不存在返回 404 |
| POST | `/api/comfyui/test-batch` | 按 `{kind, ids}` 串行批量试跑，逐项写回 `lastTest`，进度经 SSE `wf-test` 日志广播；与 `test-one` 共用同一套试跑逻辑 |
| GET / POST | `/api/projects/:id/director-pack` | 下载 / 重新生成导演包 |
| GET | `/api/projects/:id/film` | 下载拼接后的成片 MP4 |

LLM 仍可独立配置：设置第一个 Tab 选「OpenAI 兼容接口」并填 Base URL / Key / Model，剧本与分镜规划改走 `/chat/completions`，解析失败自动回退 Mock。密钥只写本地 `data/projects/<id>.json`，不上传第三方。
