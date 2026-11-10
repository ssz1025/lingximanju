# 验证记录

## 2026-11-05

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

## 2026-11-06 · 创作项目管理层

| 项目 | 结果 |
|---|---|
| 论文依据 | `docs/THEORY.md` 把式(1)–(8) 逐条映射到六步、`scope`、具体函数与默认参数；消融结论（k=2 / GC −8.7% / −3.8% / NF 3.52→3.14、2.34 / 405s）固化为默认值 |
| 后端 HTTP 闭环 | 新建创作项目 → 第 ③ 步 → 全部执行：`6/6` 步、42 节点 / 64 连线（2 集）、6 镜头、8 条 anchor、14 条 ref、0 失败；导演包 25 文件经 Python `zipfile.testzip()` 校验 CRC 全通过 |
| 上传内容生效 | 剧本场景来自原著章节、角色由原著抽取（沈砚 / 林夏），RAG 用整本原著索引 |
| 项目管理 | 重命名 / 收藏 / 标签 / 备注 / 归档 / 交付设置 / 复制 / 快照 / 恢复 / 删除全部通过；原有 4 个示例项目未受影响 |
| 前端运行时 | jsdom + 原生 ESM 连真实服务：向导三阶段、实时分集预览、创建后六步引导、四态步骤面板 `2/6 → 3/6 → 6/6`、管理面板四 Tab、侧栏筛选与更多菜单，**0 运行时错误** |
| 修复的真实缺陷 | 步骤请求体未按 `api()` 约定包装导致 GET 404；管理面板误用全局统计且 `project:meta` 覆盖侧栏统计；顶栏进度与步骤面板刷新时机不同步 |
| 画布保留 | `public/canvas.js` 未改动；创作项目初始图 = `novel2video` DAG + `episode` 节点，运行中动态节点仍画在同一画布 |

## 2026-11-06 · ComfyUI 提示词注入修复

| 项目 | 结果 |
|---|---|
| 缺陷复现 | 现网生效的 Krea2 Turbo 工作流把提示词写在 `30:19 PrimitiveStringMultiline.value`，`30:6 CLIPTextEncode.text` 只是连线 `["30:28", 0]`；旧注入器只写进了 `filename_prefix` 与 `seed`，`analyzeWorkflow` 的文本槽位为空 → 每个镜头都沿用「甜酷 Y2K 千禧年风格」那句固定提示词，`data/assets/` 里 15 张出图全是同一位少女的不同姿态 |
| 修复验证 | 干跑注入后 `30:19.value` 被替换为镜头提示词，`30:18`（系统提示词）与 `30:27.string_b`（LoRA 触发词）保持原值，`30:6.text` 连线保留（润色链路仍生效）；`30:3.seed` 与 `30:16.sampling_mode.seed` 逐次随机，`29.filename_prefix` 带唯一后缀 |
| 端到端 | 假 ComfyUI 服务接收两次 `/prompt`：载荷分别含两段不同镜头提示词，均不含工作流内置固定提示词，产物各自落到不同 `/assets/*` 文件 |
| 兼容矩阵 | 经典双 `CLIPTextEncode`（正/负分别注入）、`{{占位符}}`、显式绑定（不会重复注入）、连线但无文本源（兜底覆盖 `CLIPTextEncode.text` 并告警）、完全无文本节点（明确告警）全部通过 |
| 自检接口 | `POST /api/comfyui/inject-check` 对当前生效的出图 / 视频工作流返回注入节点、策略与告警；设置页打开即自动干跑并显示 ✓ / ✕ 徽标 |
| 回归基线 | `npm run check` 57 文件通过；`npm test` **142/142 通过**（新增 `tests/comfy-prompt.test.mjs` 8 项） |

## 2026-11-06 · 项目封面增强 + AI 提示词接口修复

| 项目 | 结果 |
|---|---|
| 缺陷复现 | 「✦ AI 生成提示词」返回的是内置模板原文（`的故事。，cinematic…` 拼接痕迹）却标 `source:llm`：目标模型（mimo-v2.6-pro）把 JSON 包进以任务命名的单键返回（`{"cover文生图提示词":"{\"prompt\":...}"}`），`extractJSON` 解出的对象无 `prompt` 键，`mergeDefaults` 静默用 Mock 模板补位后仍按 LLM 计 |
| 修复验证 | `unwrapNested` 递归解包「单键 + JSON 字符串值」包裹后，实测接口返回模型真实提示词（水墨风黑色电影构图、按项目资料与自定义要求撰写），`source:llm`；Mock 补位改为逐键打 `__mockKeys` 标记，缺 `prompt` 字段时响应明示「LLM 未返回有效提示词，已回退内置模板」，不再冒充 AI |
| 提示词直用 | 文本框内容即完整提示词原样注入工作流（去掉 `exact` 勾选框与后端条件分支），留空才按项目资料套片名模板；假 ComfyUI 载荷断言 `6.text` 与文本框逐字一致 |
| 多参考图 | `refs`（资源库图片 / 本地上传）按顺序对应工作流多个 `LoadImage` 插槽；单图沿用全槽同图旧语义、缺图占位填充、越额与无插槽均告警；非法文件名 / 损坏 dataUrl 拒绝 |
| 回归基线 | `npm run check` 60 文件通过；`npm test` **171/171 通过**（新增 `tests/cover.test.mjs` 12 项） |

## 2026-11-07 · 项目内左侧栏改造（不再保留项目管理）

| 项目 | 结果 |
|---|---|
| 需求 | 进入项目后左侧不再显示「项目管理 / 全部项目卡片」，改为当前项目的资源列表、项目设置等 |
| 实现 | 新增 `public/project-sidebar.js`（项目卡 / 六步进度、导航与剧集快捷入口、资源列表、项目设置）；`index.html` 删除 `#project-list` / 新建 / 导入按钮，画布工具收进 `#side-canvas-tools`（仅 `canvas` 视图显示）；`app.js` 组装侧栏 ctx 并把 SSE 刷新接到资源重扫；`asset-manager.js` 支持 `files` 白名单「仅本项目」 |
| 资源归属 | 递归扫描项目 JSON 中所有 `/assets/` 引用（支持 query / URL 编码 / 引号边界、去重、排除 `.gitkeep`），再补 `sourceProjectId === 当前项目` 的索引条目；无索引元数据时按扩展名兜底；产物落盘经 SSE 防抖刷新 |
| 真机验证 | Electron 33 offscreen 连本机 45367 服务，深链进创作项目：`17/17` 断言通过、0 JS 运行时错误（过滤 Electron 自带 CSP 提示）。覆盖项目内无项目管理 DOM、三块侧栏内容、工作台 / 画布 / 剧集 / 首页切换与工具区显隐、节点库已渲染、资源预览弹窗开关、「仅本项目」资源库范围、项目设置首屏可见、侧栏隐藏 |
| 回归基线 | `npm run check` 81 文件通过；`npm test` **222/222 通过**（新增 `tests/project-sidebar.test.mjs` 5 项） |
| 用户数据 | 只读取现有项目与资产，未新增 / 删除 / 修改任何 `data/` 下的项目文件 |

## 2026-11-07 · 项目会话：整页项目化 + 关闭返回列表

| 项目 | 结果 |
|---|---|
| 需求 | 进入项目后全部显示项目相关内容，关闭后返回项目列表 |
| 实现 | `app.js` 新增 `closeProject()`（清空 `state.project` / 画布 / 弹窗 / 计时器 / 日志 / Agent 对话 → 回列表）、`updateChrome()`（顶栏品牌 / 侧栏页脚 / 状态栏 / 资源库入口随会话切换）、`openProjectAssetLibrary()`；`index.html` 增加项目封面、`✕ 关闭项目`、`⌂ 项目列表` 首页标识与首页状态统计；`project-sidebar.js` 新增纯函数 `projectChrome()`；`asset-manager.js` 支持 `project` 动态范围（默认「仅本项目」，可一键退出看全库） |
| 入口统一 | 顶栏 `✕` / `⌂ 项目列表`、剧集详情面包屑、侧栏项目卡 `✕`、`H` 快捷键、删除当前项目全部走 `closeProject()`；不再出现「只切视图但项目仍在内存」的残留 |
| 真机验证 | **Electron 33 offscreen 26/26 断言通过、0 JS 运行时错误**。用 `LINGXIMANJU_DATA_DIR=/tmp/lxm-e2e-data-2 PORT=45421` 起隔离服务（数据为 `data/` 副本），覆盖：项目页品牌/封面/关闭按钮/资源库范围、画布与剧集视图切换、`⌂`/`H`/`✕` 三种关闭方式、关闭后项目名与节点数清空 + 中性状态栏 +「继续上次项目」、从列表与项目卡重新进入、资源预览开关 |
| 视觉复核 | 深色主题截图确认顶栏无重复项目名、关闭后顶栏左侧「⌂ 项目列表」与状态栏「共 5 个项目」正常，无溢出 / 重叠 |
| 回归基线 | `npm run check` **82 文件**通过；`npm test` **227/227 通过**（新增 `tests/project-session.test.mjs` 5 项） |
| 用户数据 | 真机验证全程连隔离数据副本，真实 `data/` 项目文件未被写入 |

## 2026-11-08 · 项目会话：全部内容绑定当前打开的项目

| 项目 | 结果 |
|---|---|
| 需求 | 进入项目后，页面里全部内容都与打开的项目相关，不混入应用级 / 全局信息或入口 |
| 应用级入口收敛 | `index.html` 给 `⌂ 项目列表` / `⚙` 设置 / `☀` 主题 / `?` 帮助 / `⚠ 模型未配置` 加 `.app-only`，`body:not(.view-home) .app-only` 在项目会话内隐藏；项目列表页完整保留。项目内 `T` 切主题、侧栏项目设置 `◐` / `?` 与 `?` 快捷键仍可达 |
| 项目化内容 | `projectChrome()` 增加 `title`（标签标题 `项目名 · 视图`）；状态栏 Provider 加「本项目 ·」，画布空态与剧集面包屑带项目名；`panels.js` 的 `openSettings(project)` / `openHelp(project)` 标题与快捷键绑定当前项目（帮助展示本项目 `x/6 步 · N 集 · M 节点`） |
| 模型按项目记忆 | `model-picker.js` 新增纯函数 `modelScopeKey()` 与 `setModelProjectScope()`：localStorage 键为 `lm.model.<入口>.p_<项目id>`，`loadProject()` / `closeProject()` 切换作用域并同步所有下拉；项目内首项「本项目默认模型」，关闭后回「默认模型」，不污染全局默认 |
| 画布工具项目化 | `app.js` 拆出 `renderCanvasTools()` + `project-sidebar.js` 纯函数 `collectToolStats()`：模板标注「当前」、节点库显示本项目各类型节点数、智能体只列本项目在用的（附节点数）；`project:meta` SSE 后同步刷新 |
| 真机验证 | **Electron 33 offscreen 27/27 断言通过、0 JS 运行时错误**；旧会话 E2E 回归 **26/26**。`LINGXIMANJU_DATA_DIR=/tmp/lxm-e2e-data-3 PORT=45421` 隔离服务覆盖：`.app-only` 项目内全隐藏 / 关闭后恢复、标签标题与状态栏、模型下拉项目隔离与跨项目不继承、重新进入恢复、帮助 / 设置弹窗标题、`◐` 主题切换、画布工具三分区统计与滚动截图、三个关闭入口 |
| 视觉复核 | 深色主题下工作台 / 画布 / 画布工具区 / 首页四张截图：顶栏无全局按钮、侧栏「项目设置」小图标与节点数徽标无溢出重叠 |
| 回归基线 | `npm run check` **83→84 文件**通过；`npm test` 本轮验证时 **232/232 通过**（新增 `tests/project-scope.test.mjs` 5 项） |
| 后续变化 | 本轮验证完成后，工作区出现外部并行改动（`src/core/characters.mjs` 重构、`knowledge.mjs` 精简、新增 `bm25.mjs`），使 `tests/characters.test.mjs` 的 2 项旧断言（`buildViewPrompt` 属性拼装、`buildExtractVars` 小说开头标记）失败，全量变为 230/232；与本轮前端改动无关，本轮涉及的全部用例仍通过 |
| 用户数据 | 真机验证全程连隔离数据副本；真实 `data/projects/*.json` 修改时间未变化 |

## 2026-11-08 · 角色提取能力（论文方法论 + 式(6) 检索增强）

| 项目 | 结果 |
|---|---|
| 需求 | 以项目内论文（ViMax）的方法论优化「大模型提取漫剧角色」能力 |
| 论文对齐 | `src/core/characters.mjs` 引入 `staticFeatures`（跨镜头恒定的脸型五官 / 发型发色 / 体型肤色）与 `dynamicFeatures`（随场景变化的服装 / 配饰 / 道具）二分（对齐 `CharacterInScene.static_features` / `dynamic_features`）；`src/core/providers.mjs` 新增 `SCHEMAS.charExtractGuide`（6 条抽取准则，逐条对应 `character_extractor.py` 的 Guidelines：不得引入片段外设定 / 多称呼归并入 aliases / 未点名角色用「身份+外貌」命名 / 背景群众不单列 / 静态动态分离 / 角色间外形配色可区分） |
| 式(6) 检索增强 | 新增 `src/core/bm25.mjs`（零 I/O 检索算法层）：中文 bigram 分词 + 停用词、512/128 分块、BM25 召回、归一化重排 + 阈值过滤 + Jaccard 近重复去重。`buildCharacterPassages()` 以候选角色名 + 分集梗概为线索做全书召回，并用候选名字面定位窗口补齐，替代旧「开头 6000 字 + 有限窗口」截断；`buildExtractVars()` 把召回片段拼成 `【原著相关片段】/【「name」原文片段】` 证据，`providers.generate('charExtract')` 以 FRAGMENT 形式注入且不再重复塞入 JSON 元信息 |
| 依赖方向 | `knowledge.mjs` 改为委托 `bm25.mjs`（自身只留磁盘缓存），`characters.mjs` 只依赖 `bm25.mjs` —— 避免 `characters → knowledge → store → project-steps → characters` 循环依赖 |
| 三视图一致性 | `buildViewPrompt()` 正面显式写出特征二分；侧面 / 背面只声明朝向 +「以提供的正面定妆图为唯一外观依据」，不重述特征（避免与正面图漂移）；`management.mjs · generateCharacterView()` 把 `character.views.front.url` 作为 `refs[0]` 注入图像生成（ComfyUI 侧为 `imageBuffer`），正面图缺失时降级为纯文本并写 warn 日志 |
| 合并语义修正 | `mergeExtracted()`：别名取并集（论文要求同一实体所有称呼归并）；启发式占位特征（含由外观串派生的兜底值）可被 LLM 结果覆盖并把来源升级为 `llm`；用户手改过的角色（新增 `edited` 标记，`char-upsert` 写入时置位）不被覆盖 |
| 前端 | 角色编辑器新增「固定特征 / 可变特征」两个字段并随保存提交；角色卡片展示「固定特征」一行 |
| 自动化验证 | `npm run check` **86 文件**通过；`npm test` **257/257 通过**（新增 `tests/bm25.test.mjs` 10 项、`tests/character-routes.test.mjs` 5 项；`tests/characters.test.mjs` / `tests/providers.test.mjs` 同步扩充） |
| 运行时验证 | 隔离服务（`LINGXIMANJU_DATA_DIR=/tmp/lxm_smoke`）HTTP 闭环：新建长篇项目 → `POST /characters/extract` 召回原文片段并返回含 static/dynamic 特征的角色 → 三视图依次产出，侧面提示词含「以提供的正面定妆图为唯一外观依据」、背面含「背面不可见五官」；Chrome headless 走查项目管理 → 角色页 → 编辑器新字段 → 保存回写，全程 0 JS 运行时错误 |

## 2026-11-08 · 项目重组：原著统计 / 分季分集 / 每集画布 / 组合画布 / 资源归纳

| 项目 | 结果 |
|---|---|
| 需求 | 重新整理项目、优化体验；导入小说带数据统计并可查看原文；每集独立无限画布 + 完整组合画布；分集可分季、一季多集；页面简洁、资源归纳 |
| 原著数据与阅读 | 新增 `src/core/source-view.mjs · buildSourceView()` 与 `GET /api/projects/:id/source`；`public/source-view.js` 提供六项统计（字数 / 章节 / 段落 / 分集 / 季 / 角色）、章节目录、全文 / 按章阅读、搜索高亮、复制 / 下载 / 重新导入。历史项目 `chapters=[]` / `sources=[]` / `episodes[].text=''` 惰性重建；旧服务接口 404 时由 `localSourceView()` 前端等价回退 |
| 分季分集 | `public/project-model.js` 建立季 / 集纯函数模型：`ep.season` 缺省 1、`management.seasons[]` 只存标题、全局集号 `no` 不变；支持新增 / 重命名 / 删除季与跨季移动集，侧栏季树、页脚统计、范围下拉按季同步；老项目自动归第 1 季 |
| 每集独立画布 | `management.episodes[n].canvas = { nodes, edges, viewport }`，首次进入由 `seedEpisodeCanvas()` 播种并 `persist(true)` 落盘；剧集详情 / 侧栏 / 分集 Tab 均可直达 |
| 全部组合画布 | `composeOverallCanvas()` 从所有季 / 集画布派生总览：季分行、集按列、节点 id 加 `cp_<集号>_` 前缀 + `data.scopeRef`、跨集 `ref` 连线、600 节点裁剪；**只读派生视图**，不写回主画布，双击节点跳回单集画布 |
| 画布范围隔离 | 范围键 `overall / main / ep:<no>` 由 `scopeKeyOf / parseScopeKey` 管理；`CanvasController.setProject(..., { resetHistory: true })` 清空撤销栈；`scopeReadOnly()` 在组合范围禁用运行 / 布局 / 删除 / 撤销与字段写回；检查器与 SSE 刷新统一走 `syncCanvasScope()` |
| 页面简洁化 | 工作台改四 Tab（概览 / 原著 / 分季分集 / 资源），首屏只显示概览；顶栏次要按钮 `.in-more` 收进 `··· 更多` 菜单；侧栏加 `.ps-links` 快捷入口与按季分组剧集树；资源 Tab 按类型归纳，与侧栏 / 资源库共用 `collectProjectAssets()` 口径 |
| 真机验证 | **Electron 33 offscreen 35/35 断言通过、0 JS 运行时错误**。隔离服务 `LINGXIMANJU_DATA_DIR=/tmp/lxm-e2e-data-4 PORT=45423`（数据为 `data/` 副本）覆盖：四 Tab 切换、原著统计 / 全文 / 搜索 / 章节、新增季 / 跨季移动 / 刷新持久化、资源归纳、单集画布、组合画布（下拉按 2 季分组、250 节点 / 417 连线、双击跳单集）、主画布、剧集详情直达、更多菜单、关闭返回列表 |
| 视觉复核 | 深色主题 7 张截图（概览 / 原著 / 分季分集 / 资源 / 单集画布 / 组合画布 / 首页）：Tab 栏、统计卡、季集卡片、缩略图网格、范围切换条与状态栏计数布局正常，无明显溢出 / 重叠。组合画布因 `fitView()` 约 10% 缩放节点较小，符合总览定位 |
| 修复的缺陷 | ① 阅读器默认只显示第一章（`len:361`）→ `ui.mode` 初始与项目切换重置统一为 `full`；② `seasonGroups()` 未登记 `management.seasons[]` 中声明的空季，导致新增季 / 跨季移动 / 刷新持久化失败 → 同时登记声明季并按季号排序；③ 范围下拉未按季分组 → `updateCanvasScopeUI()` 按 `divider` 生成 `optgroup`；④ 组合节点标题重复「第 1 集 · 第 1 集 · …」→ `epShortTitle()` 剥离开头集号；⑤ `localSourceView()` 把首行书名当正文 → 与 `parseNovel()` 一致跳过首行短书名 |
| 隔离数据说明 | 本机 `45367` 为改动前启动的旧进程（`GET /source` 返回 404），未重启、未杀掉；新 API 用进程内 `handleApi` 验证 200，前端加 `localSourceView()` 兜底。真机验证全程连隔离副本 |
| 回归基线 | `npm run check` **93 文件**通过；`npm test` **284/284 通过**（新增 `tests/source-view.test.mjs` 6 项、`tests/canvas-compose.test.mjs` 6 项、`tests/project-model.test.mjs` 9 项，共 21 项） |
| 用户数据 | 最终核对：真实 `data/projects/prj_mw4g4qgyff65.json` mtime 为 `2026-11-08 01:35:26`（早于 01:43 的 E2E），`seasons` 为空、`episodes[].canvas` 为 0、原著全文 13210 字未变；隔离副本中 `seasons=[{no:2}]`、2 集带画布，证明本轮写入只落在副本 |

## 2026-11-08 · 代码结构整理：共享工具层与纯函数边界

| 项目 | 结果 |
|---|---|
| 需求 | 优化整理代码结构（不改变现有文件路径与业务行为） |
| 整理前问题 | `esc` / `escapeHTML` 在 14 个前端模块各写一份且存在两种转义强度（是否转 `'`）；`cut` 在 9 个模块重复且两种截断语义（输出 n+1 与 ≤ n）；`num` / `clamp` / `uid` / `fmt` / `str` / `escapeRegExp` 各有 2–3 份；画布范围规则散在 `app.js` 的 DOM 写入函数里不可单测；`styles.css` 1700+ 行缺全局导航 |
| 新增共享层 | `public/utils.js`：零依赖、顶层不碰 DOM，统一 `str / esc(escapeHTML) / cut / num / fmtNum / fmt / clamp / uid / escapeRegExp / $`；`public/canvas-scope.js`：只依赖 `project-model.js`，集中 `EMPTY_CANVAS_PROJECT / groupScopeOptions / scopeOptionsSignature / scopeHint / isScopeReadOnly` |
| 收敛范围 | 19 个模块改为从共享层导入（含 `app.js`、`canvas.js`、`source-view.js`、各视图与弹窗），删除约 53 行重复定义；`app.js` 的 `updateCanvasScopeUI()` 改用 `groupScopeOptions / scopeOptionsSignature / scopeHint`，`scopeReadOnly()` 改调 `isScopeReadOnly()`；`wizard.js` 中原本未使用的 `esc` 死代码一并清除 |
| 依赖方向 | `utils.js`（零依赖）← 纯函数层（`project-model` / `canvas-compose` / `canvas-scope`）← 视图与引擎层 ← `app.js` 编排；无循环依赖，所有新模块可被 `node:test` 直接导入 |
| 统一口径 | `esc` 统一转义 `'`（更安全，浏览器仍渲染为 `'`）；`cut(s,n)` 统一为输出 ≤ n 且省略号计入 n；`uid` 由「时间戳 + 4 位随机」补上单调递增序列，消除同毫秒高频调用约 7% 的碰撞概率（单测曾偶发失败）；`EMPTY_CANVAS_PROJECT` 保持普通对象不冻结，避免空态写入行为变化 |
| 样式表 | `styles.css` 文件头新增 10 段分区目录 + 组件前缀约定 + `[hidden]` 兜底位置约定；未改动任何一条 CSS 规则 |
| 静态校验 | 除语法检查与单测外，另做 ESM 链接扫描与工具符号完整性扫描：19 个被改模块无重复声明、无「使用但未导入」的符号；`app.js` 仅在 Node 无 DOM 时求值失败，非链接错误 |
| 回归基线 | `npm run check` **97 文件**通过；`npm test` **299/299**（新增 `tests/utils.test.mjs` 8 项、`tests/canvas-scope.test.mjs` 7 项）；新增用例连续 3 次运行稳定全过 |
| 真机验证 | Electron 33 offscreen 连隔离服务 `LINGXIMANJU_DATA_DIR=/tmp/lxm-e2e-data-5 PORT=45423`，复跑既有「项目重组」E2E **35/35 断言通过、0 JS 运行时错误**；`GET /utils.js`、`GET /canvas-scope.js`、`GET /api/projects/:id/source` 均 200 |
| 视觉复核 | 概览 / 原著两张深色主题截图：Tab 栏、统计卡、章节目录、全文阅读区、侧栏均正常，无 `&amp;` / `&#39;` 之类转义残留，无异常截断与布局溢出 |
| 用户数据 | 真实 `data/` 未写入；隔离副本 `/tmp/lxm-e2e-data-5` 为改动前的干净副本（初始 `seasons=null`、`ep.canvas=0`），E2E 写入仅落副本，验证后清理 |

## 2026-11-08 · 项目退出出口统一

| 项目 | 结果 |
|---|---|
| 需求 | 从项目列表进入项目工作台后，统一退出出口；只有「项目设置 → 退出项目」和右上角退出按钮可以退出工作台 |
| 收敛前 | 6 条能退出 / 清理会话的路径：顶栏 `✕ 关闭项目`、侧栏项目卡 `✕`、`⌂ 项目列表`、剧集面包屑「✕ 关闭项目」、`H` 快捷键，以及删除 / 外部移除的自动收尾；而「项目设置」里反而没有退出项 |
| 两处保留出口 | ① 顶栏右上角 `#btn-close-project`，从 `tb-left` 的小 ✕ 图标移到 `tb-right` 最右侧并改为明确文字「⇦ 退出项目」（`.exit-project`）；② 左侧「项目设置」末行新增 `data-act="exit-project"`（`.ps-exit`，`grid-column: 1 / -1`，偏红样式） |
| 唯一出口函数 | `app.js` 新增 `requestExitProject()`（守卫无项目 / 已在列表页、收起更多菜单）→ `closeProject()`；两处 UI 分别通过 `addEventListener('click', requestExitProject)` 与 `onExitProject: requestExitProject` 绑定。无参 `closeProject()` 全文件仅出现一次 |
| 移除的旧出口 | 删除 `index.html #btn-home`、`project-sidebar.js .ps-home-btn / data-act="home" / onHome`、`updateCrumb()` 的 `data-crumb="home"`、keydown 的 `k === 'h'`；`setView()` 与 `bindUI()` 里的对应显隐 / 监听同步清理；`styles.css` 删除 `.close-project` / `.ps-home-btn` 规则 |
| 保留的内部清理 | 项目删除 / 外部移除的 `closeProject({ silent: true })` 两处不变，它们不经过 `requestExitProject()`，不属于用户出口；剧集面包屑只保留「项目名 / 第 N 集」，项目名链接回工作台 / 画布 |
| 帮助与文档 | `panels.js` 帮助表把「H 或 ✕」改成两处出口说明；README 四视图表、项目会话段、能力表、示意图、快捷键表与测试表同步；ARCHITECTURE 新增 §14.13；结构文档补齐新模块与测试数 |
| 结构契约测试 | 新增 `tests/project-exit.test.mjs` 5 项，直接读源码断言：右上角按钮唯一且位于 `.tb-right`、页面骨架无旧出口、设置区退出项唯一且走 `onExitProject`、`requestExitProject` 是唯一用户出口（旧 `H` / `onHome` / `btn-home` 全消失）、帮助与样式同步 |
| 回归基线 | `npm run check` **98 文件**通过；`npm test` **304/304**（新增 `project-exit` 5 项） |
| 真机验证 | Electron 33 offscreen 连隔离服务 `LINGXIMANJU_DATA_DIR=/tmp/lxm-e2e-data-6 PORT=45423`，扩展后的 E2E **42/42 断言通过、0 JS 运行时错误**；新增覆盖右上角按钮在 `.tb-right` 且文字含「退出项目」、设置区出口唯一、旧出口计数全 0、`H` 按下后仍停在 `view-workshop`、剧集面包屑无关闭项、两处出口各自都能回列表且 `closeHidden === true`、刷新后季 / 画布持久化仍正常 |
| 视觉复核 | 深色主题截图放大复核：顶栏最右「⬡ 画布 / 本项目默认模型 / ··· / ⇦ 退出项目」无重叠；侧栏设置区退出项独占整行、文字完整、与「导出项目」明显区分；项目卡右上角不再有 ✕ |
| 用户数据 | 真机验证全程连 `/tmp/lxm-e2e-data-6`（`data/` 的干净副本，初始 `seasons=null`、`ep.canvas=0`），真实 `data/` 未写入；验证后清理副本与隔离服务 |

## 2026-11-09 · 30s 短剧（每片段 3s）全流程生成与验证

| 项目 | 结果 |
|---|---|
| 需求 | 生成一个 30s 短剧、每片段 3s，跑完最终产物的全部流程；不通过则定位并修复 |
| 基线（修复前） | 不改代码先跑完整流程：**12 个片段**、时长 `4/5/6s` 循环、**总 60s**、导演包 12 组镜头、验收清单 7 项里没有时长检查 → 被误判「全流程已达成」 |
| 根因 | 片段时长散落在 5 处硬编码：分镜 mock `4+(i%3)`、`video` Agent 默认 5s、`composer` 时间线默认 5s、`stitchClips` 默认 5s、单集导演包 `timeline.json` 固定 5s；且缺少项目级时长规格 |
| 修复 | 新增 `core/runtime-spec.mjs`（规格归一 / 片段时间线 / 镜头预算 / 时长验收）与 `core/preview-film.mjs`（零 Key 关键帧预览成片）；项目状态 `management.runtime`；`orchestrator` 下发 `settings.runtime`；`decomposer` 按 `clipCount` 精确分配镜头预算并给全局序号；`providers` / `visual` / `director-pack` / `episode-service` / `film` 全链路同源；`verifyDirectorDeliverables` 新增「成片时长规格」项 |
| 修复后全流程 | 10 个片段 × 3s = 30s；62 节点、6/6 步完成、导演包 35 文件 / 10 组镜头；`timeline.json` 10 段 × `durationSec=3` / `totalFrames=720` @24fps；成片 MP4 经 ffprobe **实测 30.00s**；验收清单 **8 项全达成、降级 0、缺失 0** |
| 诚实化 | 零 Key 成片标 `source='preview-frames'`，报告明确写「关键帧预览成片（非 AI 视频）」；`film.measured=true` 表示时长来自 ffprobe 实测，而非把元数据相加 |
| 单元测试 | `npm test` **346/346**（新增 `tests/runtime-spec.test.mjs` 9 项：真实 ffmpeg 成片实测 30s、`stitchClips` 实测时长、镜头预算恒等、还原「12 片段 / 60s」旧缺陷、管理动作与路由）；`npm run check` **116 文件** |
| 真实 HTTP 冒烟 | 隔离服务 45998：**51/51**（bootstrap 默认规格、项目创建、规格 GET / POST / 非法拒绝 / 部分提交不丢值、一键全流程 20.8s、服务端落盘、`/film` 下载后 ffprobe 30s、`/director-pack` 解包校验 timeline） |
| 无头浏览器 | Playwright + Chromium `/tmp/pwtest/short30.mjs` **27/27**：规格面板 `30s ÷ 3s = 10 个片段 · 24fps · 720 帧`、8 项全绿验收报告、工作台改 12s/2s → 6 片段且落盘、改回 30s/3s → 10 片段、窄屏单列、0 JS 运行时报错 |
| 视觉复核 | `short30-basic-full.png` / `short30-report-full.png`（收起浮层完整页）、`short30-basic.png` / `short30-report.png`（展开态）、`short30-narrow.png`：规格面板与验收报告无遮挡、错位、溢出 |
| 交付产物 | 项目「30s 短剧 · 雨夜便利店」已落到 `data/`（62 节点 / 40 个资产引用全部存在）；成片 `short-30s.mp4`、导演包 `short-30s.mmxpack.zip` |
| 环境说明 | 验证在隔离数据目录进行：本机全局 `app-settings.json` 配置了外部 LLM（mimo-v2.6-pro），真实目录下全流程会等待 5 分钟超时；隔离目录为零 Key mock。真实目录仅追加成品项目与其资产，未改动任何全局配置，也未覆盖既有项目 |

## 2026-11-09 · AI 制片对话 + 成片真实性策略全链路验证

| 项目 | 结果 |
|---|---|
| 需求 | 「ComfyUI 并没有被真实调用，完成的视频也是非真实短剧视频」——把成片真实性做成可核对断言（real/preview 策略）；「每一步都可以通过 AI 对话框形式完成全部内容」；「记录完整对话流程方便分享其他用户复刻」 |
| 成片真实性 | `core/film-policy.mjs`：real 默认策略下零真实片段 / 预览成片一律判缺失，绝不冒充；验收新增「ComfyUI 真实 AI 片段」项（逐片段核对 provider + 文件 + prompt_id 留痕） |
| 分步对话 | `core/step-chat.mjs`（六步 + 项目总助理各一个会话）：意图→真实业务函数，token 分账（执行 / 对话 / 合计），按步落盘 `data/conversations/{projectId}.step-{stepId}.json` |
| 制片对话 | `core/production-chat.mjs`（跨步单会话）：17 类中文意图零 LLM 分类，长意图（小说 / 六步 / 一键全流程）转后台任务 + 互斥，结果写回对话 |
| 复刻导出 | 每条消息带等价 HTTP 与 curl；`steps/:stepId/chat/export` 与 `production/chat/export` 输出 Markdown（对话全文 + 一键复刻命令串 + 环境要求）与可重放 JSON |
| 单元测试 | `npm test` **479/479**（新增 `film-policy` 9 项、`step-chat` 32 项、`production-chat` 9 项）；`npm run check` **135 文件** |
| 真实 HTTP 冒烟 | 隔离服务 45996：**30/30**（两套对话端点、① 改片名写回 bible、⑤ 改规格 30÷3=10 落库、未知步骤 404、归档式清空、双格式导出含 curl、空消息 400） |
| 无头浏览器 | Playwright `/tmp/pwtest/chat.mjs` **13/13**：弹窗穿透、打开项目、7 个对话入口、token 账目条、① 改片名获得回复与建议 chips、⑤ 规格回复给出「10 个片段 × 3s = 30s」与完整时间线、服务端落库核对、导出含 curl 串、0 JS 报错 |
| 视觉复核 | `chat-step5.png`（⑤ 对话：token 条 / 零填充历史 / 完整时间线回复 / chips）、`chat-step1.png`、`chat-workshop.png`：无遮挡、错位、溢出 |
| 修复的缺陷 | ① `classify` 把「依次跑完全部六个步骤」误判为 director（「跑完全部」抢先）→ 六步关键词优先；② `exportStepChat` 缺 curl 复刻命令 → 补等价命令与一键复刻命令串 |

## 2026-11-09 · 分季分集工作台 + 分集剧本台 + 编剧智能体升级

| 项目 | 结果 |
|---|---|
| 需求 | 工作台步骤的分集 / 分季展示界面优化；对应的剧本展示与创作；优化 agent |
| ③ 分季分集 | 统计条（季/集/剧本覆盖/宫格覆盖/视频/覆盖率）+ 关键词搜索 + 状态筛选 chips（本地 DOM 显隐不丢焦点）+ 季折叠与覆盖条 + 「补齐本季」+ 集卡四徽标与就地「✦ 写剧本」；空季在筛选时隐藏、全量保留 |
| ④ 剧本创作 | 由「项目级摘要卡」重做为分集剧本台：覆盖率统计条、每集一行（场次/行数/字数/来源/日期 + 三徽标）、展开阅读（对白高亮 / 动作斜体 / 质量告警 / 承接上集提示）、逐字段编辑保存（manual 来源，草稿在 SSE 重绘下不丢）、单集 / 整本 Markdown 导出 |
| 编剧智能体 | 新增 `core/episode-script.mjs`（vars 构建 / 归一 / 统计 / 质量告警 / 编辑合并 / Markdown / 覆盖率）；生成上下文带 prevRecap / prevTail / nextHook / targetScenes / runtime；`SCREENPLAY_GUIDE` 固定进 system 提示；零 Key 兜底改为按本集原文分段 + 原文引号对白 + 本集真实角色（修复主题模板凭空角色） |
| REST | 批量剧本支持 `nos / onlyMissing / force` 且逐集容错；`PUT /episodes/:no/script` 人工编辑（空场次 400）；`GET /episodes/:no/script/export` 与 `GET /scripts/export`；详情响应带 `scriptCoverage` 与邻居 `hasScript` |
| 单元测试 | `npm test` **515/515**（新增 `tests/episode-script.test.mjs` 13 项）；`npm run check` **145 文件** |
| HTTP 冒烟 | 隔离服务 46011：创建→指定集生成→详情（stats/coverage）→单集导出→PUT 编辑→空场次 400→补齐缺失（0 需求时如实提示）→整本导出→清理，**10/10** |
| 无头浏览器 | Playwright 工作台 **18/18**（季区渲染、3 集卡片、徽标、覆盖条、搜索只显 1 集、计数同步、清空恢复、状态筛选、④ 覆盖率条、3 行、2 已写、阅读场次与对白高亮、编辑保存标题回显 + 人工编辑、导出入口、0 JS 异常）；剧集详情 **10/10**（芯片带场次数、统计条、场次正文、编辑保存、导出链接） |
| 视觉复核 | `sw-seasons2.png` / `sw-script2.png` / `ev-script.png`：统计条、搜索筛选、季头、集卡、剧本行无溢出 / 错位 / 重叠；修复「人工编辑 · 已人工编辑」重复文案与阅读器缺片名标题 |

## 2026-11-09 · 统一格式剧本 v2：从「一段概述」到「逐集逐场可拍摄」

| 项目 | 结果 |
|---|---|
| 需求 | 「统一格式剧本生成不够详细，检查 agent 并优化给出详尽的统一格式剧本」——论文式(1) `S = ScreenWriting(I; P_C(I))` 的产物必须逐集展开、每场带戏剧结构、正文行可以直接拍 |
| 根因（5 条） | ① `SCHEMAS.screenplay` 契约只有 `location/time/summary/script`，模型没有字段可填；② 整剧兜底固定 `episodes.slice(0,3)` 每集一场，`script` 里塞的是分集梗概原文（旧项目实测：3 场、`location:"段落 1"`、`time:"开篇"`、0 句对白）；③ 单集兜底把原文整段当剧本行，没有场次头 / 动作 / 画面 / 对白之分；④ `normalizeEpisodeScript` / `mergeScriptEdit` 会丢掉新字段（保存一次就退回 v1）；⑤ 前端只显示地点 / 时间 / 概述，写了也看不见 |
| 契约 v2 | 新增 `core/screenplay.mjs`：`schema:2`、`characters[]`（动机·秘密·弧光）、`acts[]`、`episodes[]`、`scenes[]`（`interior/location/time/durationSec/characters/summary/objective/conflict/turn/beat/mood/keyProp/props/transition/script[]`）、`durationSec`、`sceneCount`、`coverage`；`enrichScreenplay` 幂等补全；`parseScriptLine` 统一解析 `角色（情绪）：「台词」` / `动作：` / `画面：` / `旁白：` / `音效：` / `【时间 · 地点】` |
| 提示词 | 两套准则分流：单集 `SCREENPLAY_GUIDE`、整剧 `SCREENPLAY_PROJECT_GUIDE`（逐集 ≤750 字原文、≤12 集、每集 2~3 场、每场必写目标 / 冲突 / 转折 / 节拍 / 转场、禁写镜号景别运镜） |
| 零 Key 兜底 | 改为「转写而非虚构」：中文断句（引号内不断句，断引号后紧跟下一句台词时按两句切）、按逗号细化保证短集也能 2 场；台词归属取「本句 → 本场 → 整集」中台词之前最近被提到的人；地点 / 时间 / 道具按原文线索词取（同集地点统一、同场时间以本场线索为准）；目标 / 冲突 / 转折从原文分句里挑且互不重复；hook 已在正文演过就不再重复写 |
| 角色表 | `narrative.scriptCast`：管理角色 ≥2 人时完全以人工维护为准；不足 2 人时从原著正文认名字补齐（`castFromText`：冒号前 14 字窗口取最左「姓氏 + 一字」＋ 叙述提示词），修掉「第③步先于第④步跑导致角色表为空、Provider 退回主题模板角色（顾言 / 程曦）」 |
| 归一 / 编辑 / 导出 | `normalizeEpisodeScript` 保留 v2 字段并补 `no/interior/durationSec/characters/props`；`mergeScriptEdit` 按 `id` / 下标继承旧结构化字段（点一次保存不再丢目标 / 转场）；`scriptToMarkdown` 输出专业格式（基调 / 主题 / 角色动机弧光 / 场次 `> 内景 · 40″ · 人物` / 目标｜冲突｜转折 / 节拍｜道具｜转场 / 正文） |
| 统计与告警 | `scriptStats` 按 `parseScriptLine` 判对白；新增 `scriptTiming`（预估秒数 / 每场耗时 / 声明时长）；`scriptIssues` 增加 `no_objective / no_turn / no_scene_cast / few_dialogue`（info 级，不阻断保存） |
| 前端 | `public/episode-view.js`：统计条加「预估」，场次头显示 `内景 · 地点` + 时间 / 时长 / 人物，正文行按 台词 / 动作 / 旁白 / 场次头 着色，编辑态提示结构化字段只读；`public/panels.js` 检查器展示 `interior · location（time · Ns · EPx）`、目标 / 转折、摘要与前 4 行正文 |
| 单元测试 | `node --test --test-concurrency=1 tests/*.test.mjs` **554/554**（新增 `tests/screenplay-detail.test.mjs` 12 项：整剧逐集多场、每场结构完整、12 集上限、同集地点不跳场 / 台词不串人 / 道具写进 `props`、单集 `targetScenes` 与承接上集、`parseScriptLine`、`enrichScreenplay` 幂等、归一与编辑保真、统计与 Markdown、`scriptIssues`、提示词契约）；`npm run check` **153 文件** |
| 端到端（隔离数据目录 mock） | 六章小说 → 建项目（①② 自动完成）→ `executeSteps({stepId:'script'})`：`done · 1 节点 · 1 波 · 4 个场景`；剧本 `schema:2`、4 场 / 26 行正文 / 388 字 / 22 句对白 / 预估 130″；**缺字段 0**（内外景 / 地点 / 时间 / 时长 / 人物 / 目标 / 冲突 / 转折 / 节拍 / 道具 / 转场全齐）；角色 `沈砚 · 刘左 · 林夏` 全部来自原著，台词归属正确（`林夏：「埋了就能忘？」`、`刘左：「你自己看。」`） |
| 遗留 | 分集策略把六章合成 1 集时，剧本也只剩 1 集 4 场（`coverage.totalEpisodes=1`）——这是第 ② 步切集粒度问题，不是剧本层问题；需要多集时在第 ② 步调整目标字数或集数上限 |

## 2026-11-10 · 分镜画面视觉物料包：每格多图 + 站位图 + 精确提示词

| 项目 | 结果 |
|---|---|
| 需求 | 「每一个分镜画面都应有多张图片：使用的角色图片、多视图、妆照、宫格视图（新生成）、站位图（新生成）；完善分镜 agent 对生成镜头的提示词输出；分镜都是多参考图文生成视频，需要精确给出提示词」 |
| 新增核心模块 | `core/shot-visuals.mjs`：`resolveFrameVisualPack`（出场角色的定妆多视图 + 妆照逐槽位解析，每张标注「锁什么」，超 8 槽如实截断告警）、`blockingSVG`（确定性站位图：取景框 + 三分线 + 机位运动箭头 + 1–4 人站位 + 图例，同镜头重排不跳变）、`buildFramePrompts`（按分镜画面设置的提示词公式拼首帧出图提示词与图生视频提示词，参考图逐槽位写用途，refPlan 覆盖 角色视图/妆照/首帧/宫格视图/站位图） |
| 分镜板链路 | `generateSegmentGrid` 每格落 `blockingUrl`（站位图 SVG）、`imagePrompt` / `videoPrompt`、`visual`（角色视图明细 + 槽位 + 告警）；宫格视图 `gridUrl` 回填到每格；宫格 SVG 每格右下角带「站位」缩略图；`gridShotList` 带全部分镜表新字段 |
| 分镜板智能体 | `storyboard-sheets` 描述与运行日志升级；`planStoryboardSheets` 新增 `visuals` 统计（blockings / promptsReady / refSlots）；重排完成消息带「每格物料」明细 |
| 关键帧智能体 | 提示词插入 `参考图槽位：槽位N＝角色·视图（用途）` 段；节点 patch 带 `refSlots` / `refNotes` / `characterRefs`（含妆照），多参考图不再「有图但模型不知道哪张是谁」 |
| 视频智能体 | 第⑥步逐镜头优先用第⑤步生成的精确 `videoPrompt`（首帧锚定 + 运动运镜 + 角色一致性 + 时长画幅 + 禁止项），无现成字段时按同一公式现场构建；节点带 `refPlan` / `refNote` 留痕 |
| 导演包 | `collectShotPackages` 用精确提示词并在 `group.json` / `shots.json` 带 `refPlan`/`refNote`；单集导演包 `group.json` 的组提示词改用精确 `videoPrompt`，站位图逐格入包（`blocking/segment_NN_cell_K.svg`），README 说明每格物料 |
| 单集视频 | `generateEpisodeVideo` 优先用每格精确 videoPrompt，老项目回退集摘要提示词 |
| 前端 | 分镜板画廊每段卡片带「站位 / 提示词 / 参考图」物料徽标（老项目无字段不渲染空徽标） |
| 单元测试 | `npm test` **618/618 通过**（新增 `tests/storyboard-shot-visuals.test.mjs` 7 项：物料包槽位语义、兜底与缺图告警、站位图确定性、双提示词结构、公式开关、整集链路落盘、画廊徽标）；`npm run check` **167 文件** |
| 冒烟 | 单集导演包导出成功（6 格 × 站位图入包）；导演全流程端到端（director-run）7/7 通过 |

## 2026-11-10 · 分集制作：第③步之后按集走完 ④角色和上下文 / ⑤分镜与画面 / ⑥视频与交付

| 项目 | 结果 |
|---|---|
| 需求 | 「剧本创作之后，可以分集制作，每一集都有对应的出场角色；每一集都有 角色和上下文 和 分镜与画面、视频与交付」 |
| 方案 | 项目级六步状态机不动；新增按集执行层 `core/episode-runner.mjs`（每集步骤状态落 `ep.steps[stepId]`）+ 按集成片 `core/episode-film.mjs`（以分镜格为镜头单元：逐格 ComfyUI 视频 → ffmpeg 拼接本集成片），全部复用既有按集产物链路（单集剧本 / 分镜板 / 单集导演包） |
| 按集三步 | ④ context：角色库为空先自动提取（复用 `extractProjectCharacters`），出场角色按原文匹配（手动关联不覆盖），生成 / 沿用本集剧本；⑤ storyboard：`ensureEpisodeBody` 分段 + `generateEpisodeGrids`（新增 `mode` 透传，可选 comfy 逐格补图）；⑥ deliver：`generateEpisodeCellVideos`（幂等跳过已有片段，单格失败不阻断）→ `stitchEpisodeFilm` → `exportEpisodePack` |
| 状态与预检 | `ep.steps[stepId] = {status, note, startedAt, durationMs, runs, finishedAt}`；预检给出「先做哪一步」（无原文 / 无分段 / ComfyUI 未启用 / 无真实画面格）；`stitchOnly` 只拼接不烧 GPU（预检同步放行 ComfyUI 依赖）；与完整流水线互斥（`isRunning` 拦截）+ 每项目单飞（`activeEpisodeRuns`） |
| 路由 | `POST /episodes/:no/step`（单集）、`POST /episodes/steps`（批量 `nos[]`，单集失败不阻断）、`GET /episodes/:no/film`（成片下载）；`episodeAction` 正则扩展 `step|film`，`episodeStepBatch` 先于 `:no` 消化；进度走 `episode:progress`（cellvideo 逐格）+ `episode:update` / `state` |
| 前端 | 工作台第④⑤⑥步面板顶部「▥ 分集制作」卡（`epx-` 样式第 26 节）：每集一行产物摘要 + 每集本步状态徽标 + 单集执行 / 重做 + 批量补齐；剧集详情「导出与生成」新增本集成片卡（逐格视频 / 拼接 / 在线播放 / 下载），原单段视频降级为「快速预览片段」；header 徽标加「成片」；单集资源图 extras 增成片节点 |
| 口径 | 成片只认 ComfyUI 真实片段（`cell.video.provider==='comfyui'`），静态图 / SVG 占位不冒充；拼接复用 `stitchClips` 的归一 / 标称封顶 / ffprobe 实测；已被清理的片段文件先剔除并如实汇报 |
| 单元测试 | `npm test` **646/646 通过**（新增 `tests/episode-film.test.mjs` 6 项 + `tests/episode-runner.test.mjs` 10 项：格摊平与真实首帧口径、前置校验、幂等跳过、无片段拒绝、真实 ffmpeg 拼接落盘 `ep.film`、摘要口径、三步状态流转、预检阻断、手动关联保护、批量 1/2、路由正则）；`npm run check` **170 文件** |
| 坑 | `ensureManagement` 每次重建 `management.episodes[]` 元素：按集执行后必须重新取 episode 引用再断言 / 改数据；测试夹具 management 必须带 `schema:1`，否则被判老项目整体重置 |

## 2026-11-10 · 分集之后的任务关系：剧集流水线（按集任务台）

| 项目 | 结果 |
|---|---|
| 问题 | 「分完剧集之后，后续的生成与选择的剧集任务逻辑关系展示不明确」：④⑤⑥ 三步各列一遍全集，三张几乎相同的卡互不相认；没有「当前剧集」概念，看不出这一集走到哪、下一步点哪个；项目级步骤（准备故事 / 分集）与剧集级任务（剧本 / 上下文 / 分镜 / 视频）没有视觉边界 |
| 方案 | 新增共享组件「剧集流水线」（`public/project-view.js` · `episodeFlowHTML`）：**每集一行，横向摊开四段任务**（剧本 → 角色·上下文 → 分镜 → 视频·成片）；点集名 = 选中该集（`ui.activeNo`，按项目存 `localStorage`），行内只展开这一集的四段任务与「下一步」；「下一步」固定取四段里第一个未完成的阶段，不会跳段 |
| 层级显性化 | 步骤导航在「分集拆解」与「剧本创作」间插入「以下按集执行」分界；卡片内两行说明条（项目级 ①②③ / 剧集级 ④⑤⑥⑦）；④⑤⑥⑦ 区头挂「剧集级 · EP xx」标签，区头主按钮由含糊的「执行本步」改为只跑当前剧集的「执行本集（EP xx）」；左侧导航「执行下一步 / 全部执行」保留整项目快跑并加注说明 |
| 入口 | ③ 分集完成后插入「分集之后怎么走」说明条（四段完成度 + 「从 EP xx 开始制作（下一步：…）」直达第④步并选中该集）；④ 剧本台顶部加一行任务链，行徽标补「上下文」段，与流水线同口径 |
| 行为 | 单集执行 / 重写剧本时同步选中该集；下一步按钮在该段运行中自动禁用并显示「进行中 · 分镜」；批量只补「当前这一段」的未完成集；`epStepInfo` 无真实格时不再输出「0/0 格片段」，改为「还没有可出片的分镜格 · 先出分镜」 |
| 验证 | `npm test` **673/673 通过**（新增 `tests/episode-flow.test.mjs` 9 项：四段标签齐全 / 下一步不跳段 / 只展开选中集 / 层级文案 / 说明条起点 / 任务链高亮 / 区头只跑本集 / 空分集兜底 / 无 undefined·NaN）；`npm run check` **174 文件** |
| 视觉 | 无头 Chrome 以 2× 渲染预览页截图核对深色 / 浅色两套主题：步骤区头「6. 分镜与画面 · 剧集级 · EP 02 · 待执行 · 执行本集（EP 02）」不挤压换行，四行剧集状态（✓完成 / 分镜中 / ✕失败 / 未开始）与展开面板层次清晰；`.pv-sstep-head` 补 `flex-wrap` 防窄屏溢出 |

## 2026-11-10 · 当前剧集：切换后后续步骤完全独立，角色除外

| 项目 | 结果 |
|---|---|
| 反馈 | 「增加当前剧集的概念，切换不同的剧集，后续步骤完全独立，角色除外，如果角色存在则沿用角色」：上一轮只有流水线里「展开哪一集」，④⑤⑥⑦ 内容仍是全项目混排（剧本台列全集、分镜 / 成片是画布汇总），切集还可能把上一集编辑器草稿带过来；角色库虽是项目级共享，界面没说明沿用 |
| 全局当前集 | 新增 `activeEpisodeNo(m)` / `setActiveEpisode(p,no)` / `activeEpisodeBarHTML`：工作台顶部 sticky 常驻条（EP 号 + 集名 + 四段进度 + 上一集 / 下拉 / 下一集），按项目存 `localStorage`；顶部条、流水线、说明条、区头、单集执行、剧本生成共用一个 `ui.activeNo`，记忆失效时自动落到「第一集还没做完的那集」 |
| 完全独立 | `ui.epUI` 按集存档剧本展开 / 编辑草稿 / 倍速，切集存档并还原目标集、重置分镜灯箱；切集设 `ui.skipCapture`，避免旧 DOM 里的剧本编辑器值盖回新集；④ 剧本台主区只渲染当前集，其余集进 `<details>` 折叠列表（点集号即切换）；⑥⑦ 的全项目画布汇总数据加「跨集汇总」标注，按集产物指向流水线 / 剧集详情页 |
| 角色例外 | 前端：顶部条「👤 角色除外 · 已沿用 N 位，切集不重新提取」、第⑤步 `sharedCharactersHTML` 共享角色库卡、流水线上下文段「沿用全书角色库 N 位」、③ 说明条与左侧导航的例外说明。后端 `runEpisodeContext`：角色库非空直接沿用（即使 `force` 也不重抽），只有为空才首次提取一次；note 追加「沿用项目角色库 N 位（不重新提取）」；文件头注释写明唯一共享边界 |
| 验证 | `npm test` **683/683 通过**：新增 `tests/episode-scope.test.mjs` 7 项（当前集规范化 / 顶部条文案与换集控件 / 角色空库文案 / 切集存档与非法集兜底 / 剧本台只显示当前集 / 流水线与区头对齐 / 空分集），`tests/episode-runner.test.mjs` 追加 1 项（已有角色时换集 + `force` 仍沿用、角色库不增删、本集剧本独立）；`npm run check` **175 文件** |
| 视觉 | 无头 Chrome 2× 截图核对深 / 浅两套主题：顶部条、单集剧本台、共享角色卡、流水线四块完整不溢出；浅色主题把 10px 绿色强调改为 `#07724f`、状态胶囊文字改 `--text-2`，对比度达标 |

## 2026-11-10 · 分季分集之后：按季按集顺序制作 + 定稿推进

| 项目 | 结果 |
|---|---|
| 反馈 | 「分季分集之后，选择分季和分集，默认第一季、第一集；完成后定稿，顺序处理第一季第二集，处理完该季后，处理顺序的下一季；每一集都有 4、5、6、7 步骤，相互独立；角色相同直接复用」：已有 `ui.activeNo` 只是扁平全集顺序，不认季；没有「定稿」状态，四段做完仍可随时覆盖；默认落点是「第一个未完成集」而非 S1E1 |
| 顺序队列 | `public/project-model.js` 新增 `episodeQueue`（基于 `seasonGroups`，季升序 → 季内集号升序，手动移季也正确）/ `defaultEpisode`（首个未定稿 = S1E1）/ `nextPendingEpisode`（只往后找未定稿，天然跨季）/ `adjacentEpisode`（跨季相邻）/ `seasonFinalProgress` / `markFinalized` / `isFinalized` / `episodeStageDone` / `episodeStagesDone` / `canFinalizeEpisode`。定稿写 `ep.finalized = {at, season, no}`；老数据无字段 = 未定稿、无 `season` = 第一季。前端 `epStepDoneLocal` 改委托 `episodeStageDone`，前后端四段判定同源 |
| 当前剧集 | 顶部条升级为「季下拉（含每季定稿数）+ 该季集下拉 + 按队列跨季上/下一集 + 四段进度 + 顺序制作位 + 定稿/撤销」，新增 `data-season-select` 事件（换季自动选该季首集、空季给提示）；`activeEpisodeNo` 改为「记忆集未定稿则保持，否则落到队列首个未定稿集」；③ 说明条改顺序制作进度（季进度胶囊 + 制作队列 + 当前制作位 + 定稿按钮）；分季分集卡每集标「🔒 已定稿 / ● 当前制作位 / 待制作」并加「设为当前集」 |
| 定稿与锁定 | 四段全绿后「✓ 定稿本集并进入下一集」→ `ctx.onFinalizeEpisode`（`public/app.js` 沿用季管理的 mutate + `persist(true)`）→ 自动 `setActiveEpisode(next)` + 跳回第 ④ 步 + toast 提示 S→E 与是否跨季。已定稿集：流水线行 🔒、四段按钮禁用、批量 nos 过滤、剧本台生成/批量按钮禁用、区头显示「🔒 本集已定稿」；后端 `runEpisodeStep` / `runEpisodeSteps` 拒绝或跳过，`/episodes/:no/script` 的 POST 生成与 PUT 编辑返回 409、批量 scripts 过滤。撤销定稿需二次确认，撤销后回到队列 |
| 每集四步 / 角色 | ④⑤⑥⑦ 区头统一「剧集级 · S01E02 · 第 N/4 段」，主按钮只跑当前集；`EPISODE_STEPS` 的 no 从 `[4,5,6]` 对齐为 `[5,6,7]`（④ 剧本走 script 接口），文件头注释写明四段边界。角色仍是唯一例外：共享角色库卡补「不同集同一角色按 ID 直接复用、不重复提取、不重复出定妆图」，定稿 / 撤销 / 跨季都不重建角色库（后端 `runEpisodeContext` 已有沿用逻辑，测试锁死） |
| 验证 | `npm test` **695/695 通过**：新增 `tests/episode-queue.test.mjs` 12 项（队列排序与手动移季 / 默认 S1E1 / 同季推进与跨季 / 跳过已定稿 / 全定稿兜底 / 撤销回队列 / 四段门槛与 running 不误判 / 季进度与跨季相邻 / 顶部两级选集 / 定稿锁定与批量跳过 / ③ 说明条顺序 / 角色复用），`tests/episode-runner.test.mjs` 追加「已定稿集单集 + 批量拒绝、撤销后可继续且角色仍沿用」，并同步更新 `episode-flow.test.mjs` / `episode-scope.test.mjs` 的默认集与区头断言；`npm run check` **176 文件** |
| 视觉 | 无头 Chrome 2× 截图核对深 / 浅两套主题：季下拉 + 集下拉不挤压、顺序制作行与定稿提示完整、流水线按季分组（S01 / S02）与 🔒 锁定行清晰、说明条制作队列 `S01E01 → S01E02 → S01E03 → S02E04 → S02E05` 无截断；浅色主题新增的绿色强调统一走 `#07724f` |

## 2026-11-10 · 剧集选择改为明确的中文「第 1 季 第 1 集」，去掉英文缩略

| 项目 | 结果 |
|---|---|
| 反馈 | 「给出明确的剧集选择，比如第一季第一集，不要用英文缩略」：季下拉写 `S01 · 第 1 季`、集下拉写 `EP 01 · 雨夜`、顶部主标识 `S01` + `EP 01`、队列与提示写 `S01E01 → S02E04`，选集时看不出是哪季哪集。本轮按「规划先行」规则先给书面方案、用户回「按方案执行」后才改文件；拍板值：阿拉伯数字 `第 1 季 第 1 集`、集号沿用全局唯一编号、VERIFICATION 历史记录里的旧文案保留不改 |
| 单一标签源 | `public/project-model.js` 新增 `seasonLabel(season)` → `第 1 季`、`episodeNoLabel(no)` → `第 4 集`、`episodeLabelFull(season, no)` → `第 1 季 第 4 集`、`queueItemLabel(item)`（队列项直接格式化）；异常值兜底 `第 ? 季 / 第 ? 集`，不产出 undefined / NaN。所有 UI 拼接统一走这四个函数，集号仍是全局 `ep.no`（季只是分组视图），因此第二季首集写「第 2 季 第 4 集」而非季内第 1 集 |
| 选集与展示 | `public/project-view.js` **23 处**全部替换：顶部季下拉 → `第 1 季（1/3 集已定稿）`、集下拉 → `第 1 季 第 2 集 · 门铃 ✓定稿`、主标识合并为一个完整标签 `第 1 季 第 2 集`；③ 说明条制作队列 → `第 1 季 第 1 集 → … → 第 2 季 第 5 集`、季进度胶囊 / 当前制作位 / 定稿按钮 / 开始制作按钮；流水线季分组与行号、分季分集卡卡号与季标记、剧本台当前集与折叠列表、④⑤⑥⑦ 区头 pill 与按钮、定稿 toast。`public/episode-view.js` 详情页 `ev-no` 同步改完整标签（新引入 `PMODEL`） |
| 样式 | `public/styles.css` 针对中文标签变长调整：`.epb-switch select` 210→272px、季下拉 190→228px、`.fl-pick` 236→292px（min-width 150→178px）、`.epb-no / .fl-no / .sw-no / .sx-ep-no / .sx-season-mark / .fl-season-mark` 加 `white-space: nowrap` 并去掉让汉字散开的 `letter-spacing`、`.sx-ep-top` 与 `.fl-queue-line b` 允许换行 / 断词。深浅主题均沿用现有变量 |
| 验证 | `npm test` **715/715 通过**；`npm run check` **180 文件通过**。新增 `tests/episode-label.test.mjs` 5 项（纯函数格式与兜底 / 全局集号口径 / 选集控件明确 / 6 个渲染部件不含 `EP \d`、`S\d\dE\d\d`、`>S\d\d<` 且含完整中文标签 / 详情页标签静态核对），同步更新 `episode-flow.test.mjs`（8 处）、`episode-scope.test.mjs`（10 处）、`episode-queue.test.mjs`（9 处）的旧英文断言；`episode-runner.test.mjs` 等其它测试无需改动 |
| 视觉 | 无头 Chrome 2× 截取深 / 浅两套主题：顶部条主标识「第 1 季 第 2 集」、季/集下拉选项、说明条中文制作队列、流水线季分组与每行标签、展开面板、剧本台与区头均完整可读，无截断 / 重叠 / 溢出；临时预览页 `public/__label-preview.html` 已删除 |

## 2026-11-10 · 分季分集布局与全局样式统一，简化界面（功能零删减）

| 项目 | 结果 |
|---|---|
| 反馈 | 「分季 · 分集。布局样式没有统一；另外优化全局布局整体风格统一；简化操作界面，优化用户体验；功能不要删减」：只读调研发现 `styles.css` 有 15 种硬编码圆角、20+ 种字号、400+ 处 9–10.5px 小字，定义了 `--radius:14px` 却只用 2 次；`.btn.sm` 从未定义但被 78 处按钮引用；分季分集卡自带 `max-width:1460px + margin:auto + padding:14px` 却嵌在已有 16px 内距的步骤卡里，形成卡中卡；第③步叠了 4 张大卡、首屏按钮过多。本轮按「规划先行」先给书面方案（含影响 / 风险 / 执行范围），用户选「按方案执行（推荐）」后才改文件 |
| 令牌层 | `public/styles.css` 新增第 01 节共享令牌 `--radius-xs/sm/md/lg/pill`、`--sp-1…5`、`--fs-2xs…2xl`、`--btn-h`；批量令牌化 411 处 `border-radius`、160 处 `gap`、14 处单值 `padding`、388 处精确字号，工作台 `sx/sw/fl/epb` 区段再收敛 41 处零散字号到 7 级字阶。采用「新增令牌 + 局部覆盖」，没有重写整张样式表 |
| 按钮与标签 | 正式定义 `.btn.sm / .btn.xs / .btn.block / .btn.ghost`（78 处 `sm` 立即生效）；第 29 节把 `.pv-chip / .pv-pill / .sx-chip / .sx-ep-state / .fl-count / .fl-st / .fl-season / .epb-st` 等状态标签统一为药丸圆角 + `--fs-xs` 基线，深浅主题跟随语义变量 |
| 卡片同构 | `seasonsHTML` 导出并改为 `class="pv-card sx-wrap"`，配标准 `.pv-card-head`；`.sx-wrap, .ax-wrap` 从页面级容器（`max-width:1460px / margin:auto / padding:14px`）改为卡片内 `flex column + gap`，`.sx-season / .sx-ep` 统一边框、圆角、背景与内距层级；统计条、筛选栏、季头、集卡与工作台其它卡对齐。第④步区头 `.pv-sstep-head` 保留 `flex-wrap` 防窄屏挤压 |
| 渐进披露 | ③ 说明条默认只留制作队列 + 主行动，层级说明 / 季进度 / 四段完成度进 `.fl-intro-more`；章节映射进 `.pv-more`；分季·定稿·角色库说明进 `.sx-foot`；季头与集卡次要动作进 `.sx-more`「更多操作」。所有 `data-act` 与业务回调原样保留 |
| 功能零删减 | 新增 `tests/ui-style.test.mjs` 7 项：① 渲染出的 `data-act` 集合与改造前 **63 个基线完全一致**；② 令牌齐备且 `.btn.sm/.xs` 已定义；③ `.sx-wrap` 不再自带页面级宽内距、`seasonsHTML` 使用标准卡；④ `sx/sw/fl/epb` 区段不再散写圆角与小字号；⑤ 分季卡主行动可见、次要动作进折叠但 DOM 中仍存在；⑥ ③ 说明条默认只显示队列、折叠内容仍保留文案与动作；⑦ 当前剧集条 / 剧本台 / 流水线正常渲染且无 `undefined/NaN`。初版断言「当前制作位 第 1 季 第 2 集」与队列口径不符（第 1 集四段已完成但未定稿，仍停在 S1E1 等定稿），改为断言停在第 1 季第 1 集后全绿 |
| 验证 | `node --test tests/ui-style.test.mjs` **7/7**；`npm test` **722/722**；`node scripts/check.mjs` **181 个文件**（含新增 `tests/ui-style.test.mjs`；`.html` 预览页不计入语法检查）。真实应用验证改用 Playwright + `?project=prj_mw9v9e8g26wci`（4 集 / 2 季），此前直接对 `/` 做 Headless Chrome 截图 / `--dump-dom` 会超时（SIGTERM / exit 124），改用真实项目入口后稳定 |
| 视觉 | 无头 Chrome 2× 预览页深 / 浅 × 宽 / 窄（900px）截图 + Playwright 真实应用深 / 浅截图 `/tmp/pwtest/real-*.png`、`/tmp/pwtest/elem-*.png`：覆盖 **工作台③分季分集卡（元素级 2× 高分辨率截图）、④剧本台与流水线、项目列表首页、剧集详情页**；统计条、筛选栏、季面板、4 张集卡、当前剧集条、剧本台、详情页中文标签「第 1 季 第 1 集」均无文字截断 / 重叠 / 对比度不足；几何核对 `docOverflow=0`、`bodyOverflow=0`、无超宽卡片、0 pageerror（仅既有可选接口 `GET /api/comfyui/interfaces` 未配置返回 404，与样式无关）。「更多操作」弹出层层级正确、不裁切，仅轻微覆盖下一季标题区，未影响可读与可点 |
| 清理 | 临时预览页 `public/__style-preview.html` 已从工作区移除；后端、数据结构、接口、分集 / 定稿 / 队列算法、集号语义、角色复用、`localStorage` 偏好、事件绑定均未改动 |

## 2026-11-10 · 当前剧集不再悬浮：身份进中间导航条，控制区移入第③步分集卡

| 项目 | 结果 |
|---|---|
| 反馈 | 「当前剧集 不要悬浮，直接体现在中间的导航条中；显示格式第1季-1」：`.epb` 是 `position: sticky; top:0; z-index:9` + 阴影的三行常驻条，滚动时压住步骤卡。按「规划先行」先给只读调研 + 书面方案 + 布局示意图，用户通过 4 个选项拍板：位置 = **A 中间竖向步骤窄栏**、原控制区 = **移到第③步「分季 · 分集」卡片内**、格式 = **仅导航条新增短标签**、集号 = **全局唯一编号** |
| 短标签 | `public/project-model.js` 新增 `episodeLabelShort(season, no)` → `第1季-1`（无空格 / 连字符 / 全局 `ep.no`），异常值兜底 `第?季-?`；`第2季-4` 表示第二季首集仍沿用全局集号。**不改动** `seasonLabel / episodeNoLabel / episodeLabelFull / queueItemLabel`，其余位置仍是完整中文「第 1 季 第 1 集」，上一轮中文标签回归测试全部保持 |
| 导航条 | `navHTML()` 导出并在 `.pv-nav-head` 之后插入 `.pv-nav-ep`（当前剧集 + `第1季-1` + 「切换剧集在第③步分集卡内」提示）；收起态 `.pv-rail-ep` 把同一串拆成「第1季 / -1」两行（30px 宽，`clipped=false`）；窄屏 ≤1080px 横向步骤条改成一行且收起时仍常驻。`updateRail` / `setNavCollapsed` 不重建 DOM，标识不受影响 |
| 去悬浮 | `renderProjectView` 的 `<main class="pv-ssteps">` 不再渲染 `activeEpisodeBarHTML`；该函数改为由 `seasonsHTML` 在 `.pv-card.sx-wrap` 卡头之后、统计条之前调用。`styles.css` 第 28 节把 `.epb` 从 `sticky / z-index:9 / box-shadow` 改为 `position: relative` 的卡片内嵌控制带；剧本台「换集用顶部条」文案同步改成「第③步分集卡内」。季/集下拉、上/下一集、四段进度、顺序制作、定稿 / 撤销、角色例外说明全部保留 |
| 一致性 | `ui.activeNo = activeEpisodeNo(m)` 从 `host.innerHTML` 之前移到拼装 `bodies` **之前**——因为 `seasonsHTML` 内部现在会渲染控制区与每集「● 当前制作位」，必须先对齐再渲染，避免同一张卡里两处身份不一致 |
| 验证 | 新增 `tests/nav-episode.test.mjs` **10/10**：短标签格式与全局集号 / 展开态标签 / 收起态两行与 title / 切集跨季同步 / 空分集兜底 / 卡片内控制区顺序与定稿入口 / 主内容不再含顶部条 / CSS 不再 sticky / 63 个 `data-act` 不变 / 第 28 节仍无硬编码字号圆角。**`npm test` 732/732 通过**；`node scripts/check.mjs` 通过 |
| 视觉 | Playwright 真实应用 `?project=prj_mw9v9e8g26wci` 深 / 浅 × 展开 / 收起 × 1000px 窄屏，截图 `/tmp/pwtest/navep-*.png`、`/tmp/pwtest/rail-*.png`：导航条与 40px 状态轨均显示 `第1季-1` 且无裁切；`.epb` 计算样式 `position: relative`、`box-shadow: none`、确在 `.pv-card.sx-wrap` 内且位于卡头之后；主滚动容器下滚 900px 后 `epb.top` 由 2393 → 1493（随内容走，不再吸顶）；`docOverflow=0`、0 pageerror |
| 边界 | 后端、数据结构、接口、`episodeQueue` / 定稿 / 锁定 / 自动推进、角色复用、`localStorage` 偏好、63 个事件入口均未改动 |

## 2026-11-10 · 接口 JSON 可视化编辑 + 生图 Agent 按所选接口自动配参

| 项目 | 结果 |
|---|---|
| 反馈 | 「『模型、ComfyUI 与最终产物设置』模型设置中，修改导入的 comfyui 接口 json 文件，导入后可以可视化编辑需要输入的参数；需要生图的服务，可以选择修改使用的本地 comfyui 接口，生图的 agent 自动根据选择的接口配置参数」。按「规划先行」先给书面方案（现状差距 / 涉及文件 / 7 个修改点 / 影响与兼容 / 4 个风险 / 3 个待拍板项），用户拍板：**按方案执行 + 两个 Tab 都放入口 + Agent 配参按标记触发** |
| 输入清单 | `src/core/comfyui.mjs` 新增 `describeInterfaceInputs(wf)`：全量扫描每个节点输入（含连线槽位），输出类型 / 当前值 / 节点标题 / 推断角色 / 建议内置变量，复用 `analyzeWorkflow` 的连线回溯识别；`BUILTIN_INPUT_VARS` 19 个内置变量、`parseAgentParamReply()` 兼容 4 种 LLM 回复形态 |
| 参数表 | `src/core/comfy-config.mjs` 新增 `inputSchema`（`auto/builtin/fixed/agent/skip` 五种来源）、`normalizeInputSchema` 幂等清洗、`compileInputSchema(schema, workflow)` 编译成 `nodeOverrides` + `paramPlan`；`resolveInterface()` 与手写 nodeOverrides 按槽位合并（可视化优先），失效槽位 / 连线槽位跳过并给 warnings；`interfaceOverview` 带 `inputSchema` 与 `inputCount`。**老配置无字段 = 空表 = 行为完全不变** |
| 接口 JSON | `GET /api/comfyui/interfaces/:id/schema` 返回工作流本体 + 输入清单 + 内置变量；`PUT /api/comfyui/interfaces/:id/workflow` 校验 `parseWorkflow` 后写回库项，选中项同步镜像，旧参数表失效行给告警。档案 PUT 支持 `inputSchema` |
| Agent 配参 | `src/core/providers.mjs` 的 `runComfy()` 是唯一兜底点：仅当 `cfg.paramPlan` 非空且为真实 LLM 模式时调用一次 `callLLM`（按接口名 / 本次提示词 / 负向词 / 画幅 / 字段要求生成参数），解析后追加 `nodeOverrides`；Mock 项目零额外调用，LLM 失败 / 输出不可解析回落档案兜底值，不阻断出图。注入器零改动 |
| 前端 | `public/panels.js`：模型与运行 Tab 新增服务接口摘要卡 + 两个跳转入口；接口档案卡片新增「✎ 接口 JSON」（可编辑文本域 / 文件替换 / 格式化 / 保存）与「⚙ 输入参数」（自动表格 + 来源下拉动态切控件 + 保存）、「⇧ 导入接口 JSON」；`public/interface-picker.js` 下拉补输入数；`public/styles.css` 第 30 节新增 `.mi-*` 样式（全部走设计令牌，浅 / 深主题跟随变量） |
| 验证 | 新增 `tests/interface-schema.test.mjs` **12 项**：输入扫描 / 归一化幂等 / 五来源编译 / resolveInterface 兼容 / injectWorkflow 真实写入 / 3 组 REST（schema、workflow、inputSchema）/ Agent 回复解析 / **fake LLM + fake ComfyUI 端到端 3 项**（标记才生成且参数真进 `/prompt`、无标记零 LLM 调用、LLM 失败回落兜底且不中断）。测试抓到并修复 `auto` 被误当 `skip` 生成锁定覆盖的实现 bug。**`npm test` 744/744**；`node scripts/check.mjs` **183 个文件**。真实 `data/comfyui.json` 未被写入，执行前备份为 `data/comfyui.json.bak-20261110-222814` |
| 真实页面 | 独立端口 `45368` 起新服务（不打扰既有 45367），Playwright + 本机 Chrome 深 / 浅两套主题打开设置弹窗：①「模型与运行」Tab 的 11 个服务接口摘要与 2 个跳转按钮齐全，点击后正确切到 `#pane-comfy`；② 3 份真实接口档案全部渲染；③ 点「⚙ 输入参数」从真实 Krea2 工作流自动解析出 **66 行输入**，来源下拉 5 档、内置变量下拉、保存按钮齐全；④「✎ 接口 JSON」文本域载入 9909 字符 / 22 节点且 `JSON.parse` 通过、`readOnly=false`，保存 / 替换 / 格式化三个动作齐全；⑤ `docOverflow=0`、`bodyOverflow=0`、**0 pageerror / console error**。截图 `/tmp/pwtest/iface-dark.png`、`/tmp/pwtest/iface-light.png` |
| 边界 | 板块绑定 / 请求级 interfaceId / 导演包导出 / 试跑 / 注入自检等既有链路均保持；新增入口如沿用 `runComfy` 即自动获得 Agent 配参能力 |
| 工作流库内联参数表 | 上传新工作流后参数**当场可选**：出图工作流库每条行内新增「⚙ 参数（N）」「✎ JSON」，与接口档案卡共用同一套 `paintInputTable` / `paintJsonEditor` / `saveInputSchema`（容器化改造，只有一份代码）。导入成功后自动展开首个新增条目参数表并滚动到位，同时照旧启动串行试跑（多文件只展开首个并提示）。参数**完全由每份工作流自己的 JSON 决定**，无固定清单 |
| 单项查看 | 每行「ⓘ」展开详情：原始值 / 类型 / 节点类型与标题 / 推断角色 / 建议内置变量 / **该节点全部输入** / 连线与多值额外提示；行首类型标签区分 `text` `number` `array`(标注条数) `link` |
| 顺序调整 | 每行 `⠿` 拖拽把手 + `↑` `↓` 按钮（两种方式都支持，首行禁 ↑、末行禁 ↓，拖动后自动重算）；保存时按当前可见顺序整体回写档案 `inputOrder`（`node::input` 键，去重、上限 400、缺省空数组 = 扫描顺序）；「↺ 恢复默认顺序」清空后重取。纯显示语义，注入器零改动 |
| 数组误判修复 | 旧 `isLink` 只判 `length >= 2`，把 `["a.png","b.png"]` 多图数组误当连线锁死。现收紧为 `[节点id, 输出序号]` 恰好两项且第二项为数字（`comfyui.mjs` 的 `isLink`、`comfy-config.mjs` 的 `isLinkVal` 同口径）；多值参数可用 JSON 数组或逗号简写作固定值，也可交给 Agent（`paramPlan` 带 `multiple`） |
| 验证（本轮） | `tests/interface-schema.test.mjs` 追加 **6 项**（数组判 `array` 而非 `link`、JSON 数组定值还原、逗号简写、Agent 多值标记、`normalizeInputOrder` 去重丢非法、`applyInputOrder` 重排未知项留尾、`inputOrder` 落盘）。**`npm test` 750/750**、`node scripts/check.mjs` 183 文件通过 |
| 真实页面（本轮） | 独立端口 `45372` / `45373` 起新服务，Playwright 打开设置 →「本地 ComfyUI / 最终产物」：3 条库项各有「⚙ 参数（66）」；点开后 **66 行**，`mi-order` / `mi-grip` / `mi-info` 均 66 个；ⓘ 详情正确显示 `29.filename_prefix` 的原始值、角色 `outputPrefix`、建议 `{{filename_prefix}}` 与同节点全部输入；↑↓ 与拖拽均真实改变顺序（`orderBefore`/`orderAfter`/`dragAfter` 逐项核对）；保存后 `GET /:id/schema` 回读到完整 `inputOrder` 且 `inputs` 按新序返回；「↺ 恢复默认顺序」后 `inputOrder=[]` 且首项回到 `29::filename_prefix`；`docOverflowX=0`、**0 pageerror**。截图 `/tmp/pwtest/lib-params-dark.png`、`lib-params-light.png` |
| 边界（本轮） | `inputSchema` 五来源语义 / 板块绑定 / 请求级 interfaceId / Agent 配参兜底 / 镜像字段全部保持；`inputOrder` 为纯新增可选字段，老配置读取幂等补空数组，行为不变 |

## 2026-11-10 · 参数表只显示需填写的参数 + 控件按类型匹配（上传 / 选库）

| 项目 | 结果 |
|---|---|
| 反馈 | 「可以编辑的参数只展示需要输入的内容，其他比如连线等是不需要展示的；并且修改参数对应的输入方式，文本框对应文本框，图片、视频、音频等对应上传或者选择资源」。按「规划先行」先给只读调研 + 书面方案，用户拍板两条口径：**上传落点 = 本地资源库 + ComfyUI 双写**、**被隐藏的连线槽位只留一行统计提示**（不做折叠开关） |
| 输入分类 | `src/core/comfyui.mjs` 的 `describeInterfaceInputs` 新增 3 个字段：`editable = !linked`（前端据此过滤连线）、`media ∈ image / video / audio / ''`、`multiline`。`mediaKindOf()` 三级判定：① 节点类型（`LoadImage`→image、`VHS_LoadVideo`/`LoadVideo`→video、`LoadAudio`→audio）；② 输入名白名单（audio / video / image / mask_image…）；③ 当前值扩展名兜底。**权重文件 `.safetensors` / `.ckpt` / `.pt` 永不判媒体**，模型名槽位仍是文本框。`isLongText()`：`CLIPTextEncode.text` / 含换行 / 长度 > 80 |
| 类型还原 | 参数表 `value` 一律以字符串承载，写回工作流前按原值类型还原：新增 `coerceFixed(value, kind)` —— `number` `"123"`→`123`、`boolean` `"true"/"1"/"是"/"开"`→真布尔与 `"false"/"0"`→假、`array` 仍走 `parseFixedValue`（JSON 数组 / 逗号简写）、其余原样。**这是修掉的真 bug**：升级前布尔与数字槽位会把字符串提交给 ComfyUI，触发节点类型校验失败；`paramPlan` 同步带 `kind` |
| 媒体落点 | 新 API `POST /api/comfyui/interfaces/:id/media`：`{asset}` 复用资源库 / `{dataUrl, name}` 上传；双写 `data/assets/`（`registerAsset` 打「接口参数」标签）+ ComfyUI 输入目录（`uploadFile`），返回 `{asset, url, comfyName, warning?}`。32 MB 上限，`parseMediaPayload` 校验 dataURL 声明类型必须与槽位一致；**ComfyUI 不可达仍 200 + warning**，不阻断保存。`uploadImage` 抽通用 `uploadFile`（按扩展名给 multipart Content-Type，实测 `/upload/image` 端点通吃视频 / 音频），`uploadImage` 退化为薄封装，注入器零改动 |
| 前端表格 | `public/panels.js`：`paintInputTable` 只渲染 `editable` 项，表头写「N 项」+「已隐藏 M 个连线槽位」；新增 `inputControlHTML` 按类型给控件（长文本 → textarea、数字 → `type=number`、布尔 → true/false 下拉、多值 → JSON textarea、媒体 → 上传 + 资源库 + 素材 chips、其余 → 文本框）；`data-show` 声明各控件在哪些来源下可见，`syncCfgVisibility` 统一刷新；`bindMediaUI` 用事件委托处理 `media-upload` / `media-pick` / `media-drop`，资源库走**动态 `import('./asset-manager.js')`** 绕开 panels ⇄ asset-manager 循环依赖；`prefixLibActions` 的 keep 集合补 3 个媒体动作，使库内联表格拿到同名按钮 |
| 交互细节 | ① 媒体行「⇧ 上传 / 📁 资源库」**始终可见**，否则「自动识别」档下按钮被 `hidden` 挡住（Playwright 报 element is not visible）；上传 / 选库后自动切到「固定值」 ② **手动移除素材不改来源**（`applyMedia(row, i, files, switchSource=false)`），否则产生「固定值 = 空」把工作流原素材清掉 ③ 未配置固定值时素材清单**回落到工作流当前值**，否则右侧「当前值」有文件名、左侧清单写「未选图片」，看起来像数据丢了 ④ `collectInputRows` 对「媒体 + 固定值 + 空值」返回 null，不落盘 |
| 计数口径 | `interfaceOverview` 的 `inputCount` 改为只数 `editable`，新增 `linkCount`；库项按钮「⚙ 参数（N）」数字随之变小（**66→38 / 74→40 / 49→36**，隐藏连线 28 / 34 / 13） |
| 验证 | `npm test` **760/760**（新增 10 项：连线 `editable=false`、媒体三级判定含「权重文件不算媒体」、长文本 `multiline`、布尔固定值还原、数字固定值还原、`interfaceOverview` 计数、`POST /media` 上传双写、资源库复用、非法入参被拒、ComfyUI 不可达降级）；`npm run check` **183 个文件**；`tests/interface-schema.test.mjs` **28/28**。两个老断言由 `'0.5'` 改为 `0.5`，属类型还原生效而非回归 |
| 真实链路 | `POST /media` → 本地素材落盘 75 字节、资源库登记 `{"kind":"image","name":"e2e_probe.png","tags":["接口参数"]}`、ComfyUI 侧 `/view` 取回 **HTTP 200**、`warning: null` |
| 真实页面 | Playwright 直连 **45367**（用户实际在用端口）真实页面：① Krea2 **38 行 / 0 连线行**、表头含「已隐藏 28 个连线槽位」、2 个 textarea、16 个数值框、切「固定值」控件可见 1 个 / 切「自动识别」可见 0 个 ② A1-3 **40 行**含 1 个「图片·素材」行、`⇧ 上传` 与 `📁 资源库` 各 1 个、素材 chip 显示 `女主1_v1.png`、点 📁 真实打开资源库弹窗、ⓘ 详情含双写说明 ③ 上传 e2e：来源 `auto` → `fixed`、保存回读 `inputSchema` 内容正确且 `inputOrder` 40 项、移除素材不改来源；`docOverflowX=0`、**0 pageerror / 0 badRequest**。深 / 浅两主题截图 `/tmp/pwtest/typed-dark.png`、`typed-light.png`、`upload-e2e-dark.png` |
| 数据安全 | 测试写入已还原：4 份工作流 `inputSchema` 与 `inputOrder` 全空、`69.image` 回 `女主1_v1.png`、`data/assets` 中 `iface_` 残留 0 个；备份 `data/comfyui.json.bak-20261110-230903` |
| 服务 | 全程在 45367 重启到新代码，不另起端口——上一轮的教训是「另起端口让用户自己换」等于没修 |
| 边界 | 五来源语义 / 板块绑定 / 请求级 interfaceId / Agent 配参兜底 / 镜像字段 / 注入器 / 排序语义均未变；`editable`、`media`、`multiline` 是纯新增可选字段，老配置读取幂等 |
