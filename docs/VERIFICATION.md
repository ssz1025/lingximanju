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
