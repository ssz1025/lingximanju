# 理论依据与实施映射 · 创作项目（小说分集 → 视频 / 导演包）

> **依据**：ViMax: Agentic Video Generation，arXiv:2606.07649v2（Lingxuan Huang 等，HKUDS）。
> 本仓库只**参考论文的方法思想**，用零依赖 Node.js 自主实现，未复制官方 Python 代码、提示词或权重。
> 论文原文、中文全文、导读与配图均归档在 [`docs/paper/`](paper/README.md)；公式编号沿用论文 §2，实验数字沿用 §3。
> 本文回答一个问题：**创作项目的六步任务，每一步凭什么这样设计、对应论文哪条公式、落到本仓库哪个函数。**

---

## 1. 定位与边界

| 层次 | 来源 | 说明 |
|---|---|---|
| 论文方法层 | ViMax §2.1–§2.3、式 (1)–(8) | 编剧归一、镜头规划、层次化分解、RAG、机位依赖图、转场空间锚点、VLM 择优、依赖图并行 |
| 本项目实现层 | `src/agents/`、`src/core/`、`src/api/` | 11 个智能体、DAG 编排、Mock / OpenAI 兼容 / 本地 ComfyUI 三种 Provider |
| **创作项目扩展层** | **本文 §4** | 长篇小说→分集、六步任务状态机、项目管理、无限画布表达 —— **论文中没有，属本项目的工程扩展** |

论文的评测尺度是 **8–16 镜头的短故事**（§3.5：405 秒 / 17.5 美元）。长篇小说一次塞进剧本与分镜规划会超出上下文容量，因此创作项目在论文流水线之前增加了「**集**」这一中间粒度。这是架构上唯一的方法论外推，其余六步都能逐条回溯到论文公式。

---

## 2. 公式速查与本仓库落点

| 编号 | 论文含义（§2） | 本仓库落点 | 实现要点 |
|---|---|---|---|
| (1) | `𝒮 = ScreenWriting(ℐ; P_C(ℐ))` 输入 → 统一格式剧本 | `src/agents/narrative.mjs` · `screenwriter`；`src/core/providers.mjs` · `generate('screenplay')`；契约定义在 `src/core/screenplay.mjs` | 契约 v2：角色表（动机 / 秘密 / 弧光）、幕结构、分集映射、场次表（内外景 · 地点 · 时间 · 时长 · 人物 · 目标 · 冲突 · 转折 · 节拍 · 关键道具 · 转场 · 正文行）。整剧走 `SCREENPLAY_PROJECT_GUIDE`（逐集展开、每集 ≥2 场、`episodeNo` 标注），单集走 `SCREENPLAY_GUIDE`；写作准则按输入形态路由，零 Key 兜底把每集原文**转写**成同构剧本（不再只给 3 段分集概述） |
| (2) | `S₁…Sₙ = ShotPlanning(𝒮)` 剧本 → 镜头规格序列 | `src/agents/narrative.mjs` · `storyboard`；`providers.generate('shots')` | 每镜头含景别、机位、运镜、首帧描述、时长、运动/音频描述 |
| (3) | `ImageGen → VideoGen` 关键帧与片段 | `src/agents/visual.mjs` · `keyframe` / `video`；`src/core/comfyui.mjs` | Mock 自绘 SVG 帧序列；接入 ComfyUI 后产出真实片段，再由 `src/core/film.mjs` 拼接 MP4 |
| (4) | `C* = argmax VLM-Judge(Cⱼ, Sᵢ)` best-of-k 择优 | `src/agents/visual.mjs` · `review`；`providers.judge()` | 默认 `k=2`；落选候选保留在 `candidates` / `rejected` 供检查器对比 |
| (5) | `Decomp(N_{d-1,i})` 层次化叙事分解 | `src/agents/narrative.mjs` · `decomposer`；`src/core/graph.mjs` | 递归展开 `事件 → 场景 → 镜头` 三层画布节点，运行中动态长图 |
| (6) | `Index / Retrieve / Enrich` RAG 全局上下文 | `src/core/knowledge.mjs`；`src/agents/narrative.mjs` · `rag` / `decomposer`；`src/core/providers.mjs` · `generate('context')` | **整本原著按 512/128 分块建本地知识库**：BM25 宽召回 top-k → min-max 归一化重排 → 0.7 阈值过滤 → 按 `processChain` 逐条检索并分数累加 → `<FRAGMENT_i>` 标签串下发到 event / scene / shots。详见 §5.1 |
| (7) | `BuildCameraGraph` + `GenConditioned(Sᵢ, Aᵢ)` | `src/agents/narrative.mjs` · `camera-graph` / `storyboard`；`src/core/graph.mjs` · `topoLayers` | 父子机位建 `anchor` 边，父关键帧 / 转场图作 `refs` 传入下游关键帧；同层并发 |
| (8) | `GenTransition / ExtractViews` 转场视频作空间锚点 | `src/agents/visual.mjs` · `transition` | 跨机位镜头之间生成 `transition` 节点并以 `anchor` 边串接，锁定三维空间关系 |

---

## 3. 六步任务 → 公式 → 代码 → 默认值（核心对照）

六步定义是代码里的**单一事实来源**：`src/core/project-steps.mjs` 的 `STEPS` 常量，同时驱动后端分阶段调度（`scope`）、前端步骤面板、向导确认页与论文依据卡。

| 步 | 任务 | 论文依据 | `scope`（实际调度的节点类型） | 对应动作 |
|---|---|---|---|---|
| ① | 上传小说与交付设置 | 式(1) 前置 · **扩展层** | 创建时完成 | `src/core/novel.mjs · parseNovel()` → `management.source.text`（原著全文）、`idea` 节点 |
| ② | 分集拆解 | 式(5) 前置 · **扩展层** | 创建时完成 | `splitEpisodes()` → `episode` 画布节点 + `ref` 边把每集梗概传给 `script` |
| ③ | 剧本生成与格式统一 | **式(1)** | `['script']` | `screenwriter` → 统一格式剧本 `S`（片名 / 类型 / 梗概 / 角色表 / 幕 / 分集映射 / 场次表 + 可拍摄正文）；输入为每集 ≤750 字原文、≤12 集，逐集展开成 2~3 场 |
| ④ | RAG · 角色 · 层次分解 | **式(5)(6)** | `['rag','character','plan','event','scene','shot']` | `rag`（原著索引）→ `character`（定妆资产）→ `decomposer`（事件→场景→镜头）→ `storyboard`（镜头链） |
| ⑤ | 分镜提示词 · 分镜图 · 分镜板 | **式(2)(4)(7)(8)** | `['keyframe','review','transition','camera']` | `keyframe`(k=2) → `review` 择优 → `transition` 端点帧 → `camera-graph` 汇总；收尾按**分镜画面设置**（九宫格 / 六宫格 / 四宫格 / 条漫四联 / 二十五宫格 / 单图）用真实关键帧合成每段分镜板。**本步不出视频** |
| ⑥ | 视频生成与成片交付 | **式(3)** + 依赖图并行 · **扩展层** | `['video','transition','final']`（仅导演包时收窄为 `['final']`） | `video` 逐镜头图生视频 → `transition` 续跑转场视频 → `composer` → `timeline.json` / MP4 / `*.mmxpack.zip` |

**分阶段调度的实现**：`src/core/orchestrator.mjs` 的 `runProject(id, { scope })` 在 `computeTargets()` 中按节点类型白名单筛选目标，运行期动态展开的节点也按同一白名单过滤；不传 `scope` 时保持原有「运行完整流水线」行为不变。后端 `POST /api/projects/:id/step`（`src/api/routes.mjs · executeSteps`）把步骤翻译成 `scope`，逐步或一次性执行，并通过 SSE `project:meta` 广播状态。

**数据如何贯穿六步**（式(6) 不丢失信息的关键）：

```
上传小说原文 → management.source.text
  ├─ ② 分集 → management.episodes[] / episode 节点 / script.data.novelEpisodes
  ├─ ③ 剧本 → script.data.script（场景表来自分集梗概 + 结尾钩子）
  ├─ ④ RAG  → chunkNovel(512,128) → data/knowledge/<projectId>.json（分块落盘）
  │          → rag.data.chunkCount / cacheFile / knowledgeId / passages
  │          → character 三视图（ref 边被每个 keyframe 继承）
  │          → decomposer：逐事件按 processChain 检索 → relevantChunks / fragments
  │          → event / scene / shots 节点携带 `<FRAGMENT_i_START>…</FRAGMENT_i_END>`
  └─ ⑤⑥    → anchor / ref 边 → 关键帧候选 → 择优 → 片段 → 时间线 / 导演包
```

**⑤ 的画面上游是「分镜画面设置」**（`management.storyboard`，纯函数层 `core/storyboard-settings.mjs`）：版式决定每段几格、画幅决定单格比例（单格画幅恒等于成片画幅，换版式不会把格子拉长）、提示词公式决定关键帧 prompt 里出现哪几段（景别 / 角色 / 风格 / 连续性 / 画幅）。分镜规划据此给每个镜头打「第 N 格」，分镜板合成据此排版；业务口径收在 `storyboard-sheets` Agent 里，详见 [`AGENTS.md`](AGENTS.md) §12。

---

## 4. 论文之外的扩展层（明确标注，勿误引）

| 扩展 | 为什么需要 | 实现 |
|---|---|---|
| **分集层** | 论文以 8–16 镜头短片为尺度；长篇需先压成「集」这一中间粒度，让每层只处理合适规模的上下文 | `src/core/novel.mjs` · `parseNovel / splitEpisodes / extractCharacters / novelPreview`（章节 / 字数 / 场景段落三种策略，尾部并入最后一集保证不丢原文） |
| **创作项目数据模型** | 论文没有「项目」概念；上传原文、分集表、交付设置、标签 / 收藏 / 归档 / 快照都需要持久化 | `src/core/project-steps.mjs` · `createManagement / applyManageAction / projectIndex`，写入 `data/projects/<id>.json` 的 `management` 字段 |
| **六步任务状态机** | 把论文机制变成用户可逐步执行、可观察、可重试的任务 | `STEPS` + `startStep / finishStep / resetStep / stepProgress`；四态 `pending / running / done / error` |
| **项目管理** | 多项目并存后的检索、筛选、复制、归档、快照、产物管理 | `src/core/store.mjs` 索引与快照；`src/api/routes.mjs` 的 `manage / duplicate / snapshots / restore`；`public/project-manager.js` |
| **无限画布** | 论文无画布；本项目用节点 / 连线把每一步的中间产物可视化、可编辑 | `public/canvas.js`（未改动）、`public/nodes.js`（新增 `episode` 类型）、`src/agents/canvas-agent.mjs` |
| **双产物格式** | 论文未展开交付格式 | `src/core/film.mjs`（ffmpeg MP4）、`src/core/director-pack.mjs`（`mmxpack.zip`，兼容 ComfyUI MiniMax H3 Director） |

---

## 5. 论文消融结论 → 固化的默认值

改这些默认值前请回查 [`paper/ViMax_论文中文版.md`](paper/ViMax_论文中文版.md) §3.4 / §3.7 与 [`paper/ViMax_核心要点导读.md`](paper/ViMax_核心要点导读.md) §4。

| 论文结论 | 数值 | 本项目的落地 | 去掉会怎样 |
|---|---|---|---|
| RQ6：候选越多反而越差 | `k=2`：GC 0.5571 / 405s / $17.5；k=3：0.5041；k=4：0.5194 | `project.settings.k = 2`，创建创作项目时写死；设置页可调 | 失去 best-of-k 质量闸门 |
| RQ3：VLM 择优不可省 | 去择优 GC **−3.8%** | `review` 节点不可关闭，落选候选保留供对比 | 失配关键帧会成为后续镜头参考并级联传播误差 |
| RQ3：跨镜头依赖不可省 | 去全部跨镜头依赖 GC **−8.7%**（全文最有力的因果证据） | `anchor` 边（视觉锚点 / 转场）+ `ref` 边（角色定妆）必选 | 只剩角色定妆照，无法维持身份、布局与场景状态 |
| RQ3：RAG 补回全局信息 | 去 RAG：NF **3.52 → 3.14** | `rag` 用**整本原著**建 512/128 分块知识库（非剧本摘要）；逐事件 `processChain` 检索后把 `<FRAGMENT_i>` 片段下发，见 §5.1 | 分解后丢失角色动机与伏笔 |
| RQ3：事件链不可省 | 去事件感知流程链：NF **3.52 → 2.34** | `decomposer` 的 `事件 → 场景 → 镜头` 三层节点 | 长程因果断裂 |
| RQ4：依赖图并行最优 | 全并行 310s / GC 0.5085；全串行 835s / 0.5511；完整 ViMax **405s / 0.5571** | `topoLayers()` + `concurrency=3` 同层并发、join 汇聚 | 要么质量下降，要么时延翻倍 |
| RQ1：长篇增益更大 | 总体 GC 0.5272 → **0.5571** | 结构化依赖追踪跨场景边界；分集层把长篇切到可追踪的粒度 | — |

> 注意：GC 是 ViCLIP 余弦相似度的**代理指标**，绝对值不高；NF 最高仅 3.52/5，长程忠实度仍是开放问题（导读 §6）。本项目复刻的是机制与编排，不承诺复现论文的绝对指标；真实画质取决于接入的图像 / 视频模型。

### 5.1 式(6) 知识库：与 ViMax rerank 实现的对齐与差异

用户曾要求核对「是否使用了与 ViMax 相同的 rerank 模型知识库技术」。结论是：**方法层完全对齐，实现技术不同**。ViMax 依赖外部 embedding 与 rerank 服务；本项目为保持零 Key / Mock 模式可用，用纯 JS 的 BM25 + 归一化重排复刻同一套检索语义。

| 环节 | ViMax 参考实现 | lingximanju 实现 | 是否等价 |
|---|---|---|---|
| 分块 | `RecursiveCharacterTextSplitter(chunk_size=512, chunk_overlap=128)` | `src/core/bm25.mjs · chunkNovel(text, {chunkSize:512, overlap:128})`，按段落 / 句子边界聚合，块间带 128 字重叠 | ✅ 参数与重叠语义一致 |
| 索引 / 宽召回 | `FAISS.from_texts()` + `CacheBackedEmbeddings`，`similarity_search(k=10)` | `KnowledgeBase` 构建 `df` / `avgLen`，`search(query,{k:10})` 用 BM25（`K1=1.5, B=0.75`）打分 | ⚠️ 同为「top-k 宽召回」，但用字词重合度替代向量语义 |
| 重排 | `BAAI/bge-reranker-v2-m3`（SiliconAPI `/rerank`, `top_n=10`, `relevance_score`） | `normalizeScores()` 对 BM25 分做 min-max 归一化到 `[0,1]`，语义对齐 rerank 分数 | ⚠️ 同为「把召回结果重新打分到可阈值化的量纲」，但不用外部模型 |
| 阈值与聚合 | `if score >= 0.7: relevant[chunk] += score`，对 `event.process_chain` 每条单独检索 | `retrieveRelevantChunks(kb, processChain, {topK:10, threshold:0.7})`，同一块跨 process 分数累加 | ✅ 逐条检索 / 0.7 / 累加语义一致 |
| 片段下发 | `scene_extractor.py` 拼 `<FRAGMENT_i_START>…</FRAGMENT_i_END>` | `formatFragments()` 生成 `<CONTEXT_FRAGMENTS_START>` + 最多 4 个 `<FRAGMENT_i_*>` | ✅ 标签格式一致 |
| 落盘 | FAISS 索引 / `knowledge_base` 缓存 | `saveKnowledgeCache()` / `loadKnowledgeCache()` → `data/knowledge/<projectId>.json` | ✅ 同为项目级缓存 |

**落地链路**（第 ④ 步 `scope=['rag','character','plan','event','scene','shot']`）：

1. `rag` 智能体把 `management.source.text` 切成块并落盘，`ctx.patch()` 写入 `knowledgeId / cacheFile / chunkCount / passages`，摘要标注 `512/128`。
2. `decomposer` 从 RAG 节点读缓存（缺失时用 `originalCorpus` 兜底重建），对每个事件的 `processChain` 逐条调用 `retrieveRelevantChunks()`；命中为空时以事件标题 + 梗概做 `threshold:0` 的兜底召回。
3. 每个 `event` / `scene` 节点携带 `relevantChunks` 与 `fragments`；`shots` 生成时把 `fragments` 传给 `providers.generate('shots')`，LLM 系统提示词明确约束「镜头 / 场景描述必须与 FRAGMENT 片段的人物、道具、环境、光线一致，不要引入矛盾设定」。
4. `plan` 节点写入 `knowledgeChunks` 与 `fragmentsPerEvent`，运行日志输出「知识库 N 块 · 逐事件检索命中 a/b/c 段」。
5. `providers.generate('context')` 短路为本地确定性 BM25 检索（不再把整本原著塞给 LLM），返回 `query / passages / chunkCount / notes`。

**代价与边界**：BM25 无法捕捉「同义不同字」的语义相关性；若需要严格复现 ViMax 的向量召回 + bge reranker，可在 `src/core/providers.mjs` 增加可配置的 embedding / rerank Provider（当前实现不依赖外部服务，Mock 模式也能跑通式(6)）。差异不影响论文机制层的完整性：**分块 → 宽召回 → 重排 → 阈值 → processChain 累加 → FRAGMENT 下发**这条链路已逐条落地。

### 5.2 角色提取与定妆：论文方法论 → 代码落点

角色提取与定妆对应 ViMax 的 `agents/character_extractor.py` 与 `agents/character_portraits_generator.py`。本项目在「项目管理 → 角色」页实现同名能力，落点如下：

| 论文方法 | ViMax 参考实现 | lingximanju 实现 | 是否等价 |
|---|---|---|---|
| 特征二分 | `CharacterInScene.static_features` / `dynamic_features` | `src/core/characters.mjs` 的 `staticFeatures`（脸型五官 / 发型发色 / 体型肤色，跨镜头恒定）与 `dynamicFeatures`（服装 / 配饰 / 道具，随场景变化）；缺失时由 `deriveFeatures()` 从外貌/发型/服装按语义派生 | ✅ 二分语义一致 |
| 抽取准则 | `character_extractor.py` 的 `Guidelines` 段（不引入片段外设定 / 同一实体多称呼归并 / 未点名角色用身份+外貌命名 / 背景群众不单列 / 静态动态分离 / 角色间外形配色可区分） | `src/core/providers.mjs · SCHEMAS.charExtractGuide`（6 条），由 `generate('charExtract')` 注入 system prompt | ✅ 逐条对应 |
| 检索增强（式(6)） | `retrieve_relevant_chunks`：分块 → 召回 → 重排 → 阈值 → FRAGMENT 下发 | `src/core/characters.mjs · buildCharacterPassages()`：全书 512/128 分块 → BM25 召回（候选角色名 + 分集梗概为线索）→ 阈值过滤 → 候选名字面定位窗口补齐 → 拼成 `【原著相关片段】/【「name」原文片段】` 证据 | ✅ 机制一致（检索器为纯 JS BM25，见 §5.1） |
| 提示词结构 | extractor 输出 `appearance / hair / costume / props` 等自由字段 | `SCHEMAS.charExtract` 增加 `aliases`（别称归并）、`staticFeatures` / `dynamicFeatures`（特征二分）、`palette`（角色间配色可区分）、`viewPrompt`（定妆画面提示词） | ✅ 字段语义一致 |
| 多视图一致性 | `character_portraits_generator.py`：front 写明 `(static) X; (dynamic) Y`，side/back 以 **front 定妆图为参考图**（`reference_image_paths`），提示词不重复特征描述 | `buildViewPrompt()`：front 写特征串；side/back 只声明朝向 +「以提供的正面定妆图为唯一外观依据」，不重述特征；`management.mjs · generateCharacterView()` 把 `character.views.front.url` 作为 `refs[0]` 注入图像生成（ComfyUI 侧为 `imageBuffer`） | ✅ 一致性策略等价 |

**与旧实现的差异**：旧提取链路只取「开头 6000 字 + 每候选名附近 2 个窗口」，长篇中后段角色的外貌/服饰描写必然落空，模型只能靠常识编造；现改为全书检索召回 + 原文定位窗口，模型看到的是原文证据。单次 LLM 调用成本不变（上下文总量仍受 `EXTRACT_CAP=12000` 约束），召回率与属性准确度显著提升。

**2026-11-09 提取链路优化**：

- **候选抽取**（`src/core/novel.mjs · extractCharacters`）改为全书扫描（旧实现只取前 60000 字，长篇中后段角色必然漏掉）；用「非汉字边界 + 常见姓氏锚定」双策略、剥离身份修饰前缀，修正「少年阿杰说」被截成「年阿杰」的误捕；过滤虚词 / 说话动词尾字 / 地点组织后缀，并为每位候选附首现原文句 `evidence`（可被 `verifyEvidence()` 逐字回溯）。
- **证据预算**（`src/core/characters.mjs`）：窗口与 BM25 召回块按原文字符区间去重（重叠 > 60% 跳过），窗口优先占位且取「首次 + 末次出现」两段以覆盖全书；分集梗概预留 `EXTRACT_SUMMARY_CAP = 1200`，不再被 `EXTRACT_CAP = 12000` 整体截断挤掉。
- **零 Key 可信度**（`src/core/providers.mjs`）：Mock 的 `charExtract` 不再按候选序号轮流编造性别 / 年龄 / 性格 / 配色 / 画风，只输出可逐字回溯的原文证据与「待补全」占位；`generate()` 打 `__mock` 标记，路由据此把 `source` 定为 `heuristic` 并明示「未配置模型…占位设定」，既避免假成功，也保证后续真实 LLM 能覆盖占位值（`mergeExtracted` 的 `fromHeuristic` 分支）。
- **Agent 化**（`src/agents/character-agent.mjs`）：内联在路由里的提取逻辑抽成 `extractProjectCharacters()`，路由与画布共用同一口径，并注册 `character-extractor`（组「资产」，出现在 `/api/bootstrap` 的智能体列表）；提取响应新增 `source` 与 `stats{candidates, fragments, verified, dropped}`，前端提示可观测。候选上限由 8 提升到 `MAX_CHARACTERS = 12`。

**依赖方向约束**：检索算法层独立在 `src/core/bm25.mjs`（零 I/O、零依赖），`src/core/knowledge.mjs` 只保留磁盘缓存并转出算法。否则 `characters → knowledge → store → project-steps → characters` 会形成循环依赖。

### 5.3 导演 Agent 技能：流程型智能体与最终产物验收（论文之外的扩展层）

论文只定义到「镜头 → 成片」的生成机制，没有项目级制片策略，也没有交接格式与验收环节。本节的 `director` 属于 §4 标注的扩展层，不对应任何论文公式。

| 层 | 落点 | 职责 |
|---|---|---|
| 策略声明（纯逻辑） | `src/core/director-skills.mjs` | **14 项技能**（4 流程策略 + 10 导演风格，按 `DIRECTOR_SKILL_GROUPS` 分两组）：`capabilities`（前置能力，5 项）、`deliverables`（最终产物组合）、`steps`（六步 / 智能体四步）、`repack` / `verify`；`planDirectorRun()` 产出可执行计划，`verifyDirectorDeliverables()` 产出验收清单 |
| 美学档案（纯数据） | `src/core/director-styles.mjs` | 十位导演的调色板 / 光线 / 构图 / 运镜 / 媒介 / 禁忌 / 固定否定词；`resolveAesthetic` 合成生效美学对象，`aestheticPrompt` / `aestheticShotSuffix` / `aestheticTreatment` 供生成侧消费。**对本文件无反向 import**，避免与 director-skills 循环依赖 |
| 流程型 Agent | `src/agents/director-agent.mjs` | 不产出单个画布节点，而是串起：原著前置保障 → 能力调度（设定 / 导演阐述 / 角色 / 定妆 / 音色）→ `executeSteps()` 六步编排 → 导演包补齐 → 验收报告 |
| 项目状态 | `management.director` | `skillId`（项目级选择）、`styleId` + `paletteKey`（风格与主色）、`treatment`（全片视听纲领）、`lastRun`（含 checklist 的完整报告） |
| 接口与界面 | `src/api/routes/director.mjs`、`public/director-panel.js` | `GET/POST /director/skills`（含切主色调）、`POST /director/run`；工作台 ① 选技能 + 选主色、⑦ 看验收；SSE `director:progress` 推阶段进度 |

**与六步状态机的关系**：导演是「编排的编排」，不另起一套流水线——主流程仍走 `executeSteps(scope)` 与 `runProject()` 的拓扑分层调度，因此式(1)–(8) 的机制、波次并发、节点状态与 SSE 全部沿用。技能只决定「跑哪些步、跑之前补哪些资料、最终交什么」。

**诚实化约束**（与 §5.2 零 Key 策略同源）：

- 零 Key / 模型回退时，导演阐述与原著生成均标 `heuristic` / `mock`，不冒充 LLM 成果；
- 没有 ComfyUI 真实片段时：本机 ffmpeg 可用会产出「关键帧预览成片」并标 `source='preview-frames'`（真实可播放、时长可 ffprobe 实测，但不冒充 AI 生成视频）；ffmpeg 不可用时验收项 `level='degraded'` 并写明原因。`complete=true` 仅表示「必需产物均已就绪且降级已如实披露」；
- 缺少原著且无构想时直接 `blocked='source'`，不把六步标成已完成——修复前直接调用 `executeSteps()` 而不经 `agents/index.mjs` 注册时，会出现「六步全 done、画布 0 节点」的假成功，现由 `step-runner.mjs` 显式导入节点型 Agent 兜住。

### 5.4 短剧成片规格：时长作为可核对的硬约束（论文之外的扩展层）

论文按「镜头」组织生成，未规定全片时长与单镜头时长；工程上若各层各自取默认值，就无法表达「30s / 每片段 3s」。本节同样属于 §4 扩展层，不对应论文公式。

**单一事实来源**：`management.runtime` 只存 `{totalSeconds, clipSeconds, fps}`，`normalizeRuntimeSpec()` 推导 `clipCount / framesPerClip / totalFrames`；片数不独立存储，避免「片数与时长互相矛盾」。总时长不能整除时按片段时长对齐（优先保证每段严格等长），并以 `aligned` 如实标记。

| 机制 | 落点 |
|---|---|
| 镜头预算 | `allocateShots(sceneCount, spec)` 把 `clipCount` 精确分配到各场景，`shotSequenceStarts()` 给全局序号；`decomposer` 先摊平场景再下发 `shotCount`，`storyboard` 严格按预算生成并补齐缺额 |
| 时长贯通 | 分镜 mock、`video` Agent、`composer` 时间线、导演包 `collectShotPackages()`、单集包 `timeline.json` 统一读 `runtime.clipSeconds` |
| 成片 | `stitchClips()` 拼接真实 ComfyUI 片段；`renderPreviewFilm()` 在零 Key 下用 ffmpeg 把关键帧渲染为等长片段并拼成 MP4 |
| 实测 | `probeDuration()` 用 ffprobe 读实际秒数，`duration` 取实测值而非元数据求和，`measured=false` 时如实标明 |
| 验收 | `verifyRuntime()` 逐条核对片段数 / 每片段时长 / 时间线总长 / 导演包组数 / MP4 实测时长，并作为 `verifyDirectorDeliverables()` 的「成片时长规格」项 |

**修复前的真实缺陷**：片段时长散落在 5 处硬编码（分镜 `4+(i%3)`、视频 / 时间线 / 拼接默认 5s、单集包固定 5s），实测产出 12 个片段、时长 4/5/6s 循环、总 60s，而验收清单不含时长项，于是被判「全流程已达成」。现在 30s / 3s → 10 个片段，导演包 `timeline.json` 10 段 × 72 帧 = 720 帧，成片 ffprobe 实测 30.00s，8 项验收全达成。

### 5.5 成片真实性与 AI 制片对话：让「调用过」与「对话过」都可核对（论文之外的扩展层）

**成片真实性（`core/film-policy.mjs`）**：时长规格解决「多长」，真实性策略解决「是不是真的」。`real` 策略（默认）要求每个片段 `provider === 'comfyui'` 且有真实视频文件且未标合成预览，成片必须由真实片段拼接（`source === 'comfyui'` 或 `isRealVideo === true`）；`preview` 策略须显式切换，产物标 `preview-frames` 并在验收记降级。`evaluateFilm()` 输出 `level / blockers / realClips`，与 `verifyRuntime()` 一起把「30s 成片已生成」拆成可逐条证伪的断言——修复前 ComfyUI 一次未被调用，系统却判「全流程已达成」。

**AI 制片对话（`core/step-chat.mjs` 分步 + `core/production-chat.mjs` 项目级）**：每一步的操作都能用中文一句话完成，意图不依赖 LLM（正则分类，零 Key 可用），每个意图都落到与 UI 按钮相同的业务函数（`applyManageAction / executeSteps / runDirector / extractProjectCharacters / assignVoices`），因此「对话改了什么」与「按钮改了什么」在数据层不可区分。三条工程保证：

1. **留痕即记录**：每条消息存意图、参数、实际调用的接口与等价 `curl`，按步落盘 `data/conversations/` 并双写 `management.stepChats`；
2. **复刻即导出**：`export?format=md` 生成含「按顺序的一键复刻命令串」的 Markdown，`format=json` 可脚本重放——其他用户照抄 curl 即可复现整段流程；
3. **分账即透明**：步骤执行的 token 记 `step.tokens`，对话生成记 `step.chatTokens`，合计可解释。

---

## 6. 可验证清单（机制是否真的落地）

| 检查项 | 在哪看 |
|---|---|
| 上传小说确实进入剧本 | 创建后执行第 ③ 步，检查 `script` 节点的 `data.script.scenes[].location` 是否来自原著章节、`characters` 是否来自原著抽取 |
| RAG 索引整本原著 | `rag` 节点 `data.originalCorpus` 长度、`data.chunkCount / cacheFile / knowledgeId`、`summary` 中的「N 个知识块（512/128）」；`data/knowledge/<projectId>.json` 落盘 |
| 检索片段确实进入分解链 | `event` / `scene` 节点 `data.relevantChunks` 与 `data.fragments`（含 `<FRAGMENT_i_START>`），`plan` 节点 `data.fragmentsPerEvent`；运行日志「知识库 N 块 · 逐事件检索命中 …」 |
| 层次化分解 | 画布出现 `event / scene / shot` 三层节点与 `flow` 连线 |
| 机位依赖图与空间锚点 | `edges` 中 `kind='anchor'` 数量、`camera` 节点 `anchorCount / parallelLayers` |
| best-of-2 择优 | `keyframe` 节点 `candidates.length=2`，`review` 节点 `selected / scores / reason` |
| 角色一致性 | `edges` 中 `kind='ref'` 数量；`keyframe.data.refs` 含角色定妆图 |
| 角色提取基于原文证据 | 「角色」页点「从原著提取」→ 运行日志「角色提取 · 召回 N 段原著片段」；角色对象的 `staticFeatures` / `dynamicFeatures` / `aliases` 字段；`management.characters[].source='llm'` |
| 多视图以正面图为参考 | 角色卡片的侧面 / 背面图与正面图同脸型同服装；`character.views.side.prompt` 只含朝向与「以提供的正面定妆图为唯一外观依据」 |
| 并行调度 | 运行日志的「第 N 波：X 个节点就绪，按并发 3 调度」 |
| 六步状态与视觉提示 | 右侧「任务步骤」Tab、顶栏 `x/6` 胶囊与进度条、画布上方六步导航条、Toast 与运行日志 |
| 双产物 | 第 ⑥ 步后 `final` 节点 `data.directorPack`（可下载 ZIP）/ `data.film`（接入 ComfyUI 后才有 MP4）、`timeline.json` |
| 导演技能全流程（§5.3） | 工作台 ① 切换技能 → `GET /director/skills` 的计划与验收快照同步变化；点「一键完成最终产物全流程」→ 六步全 done、画布长出 `shot/keyframe/video`、`final.data.directorPack` 可下载、⑦ 验收清单 8 项全达成、`management.director.lastRun.complete=true` |
| 短剧成片规格（§5.4） | 工作台 ① 的「短剧成片规格」显示 `30s ÷ 3s = 10 个片段 · 24fps · 720 帧`；`GET /runtime` 的 `timeline` 10 段各 3s；跑完后 `final.data.timeline` 10 段 / `duration=30`、每个 `video` 节点 `duration=3`、`film.duration=30` 且 `film.measured=true`；导演包 `timeline.json` 10 段 × `durationSec=3` / `totalFrames=720`；`GET /film` 下载后用 ffprobe 实测 30.00s |
| 项目管理 | 侧栏搜索 / 筛选 / 收藏 / 归档 / 复制 / 标签，管理面板的快照创建与恢复 |

### 6.1 自动化验证（`npm test` → 479 项全通过）

机制层面的"真的落地"由测试固化，而非仅靠肉眼检查：

| 机制 | 对应断言 |
|---|---|
| 输入归一（式(1) 前置） | `tests/novel.test.mjs`：章节正则覆盖 `第X章`/`Chapter N`/数字标题；书名首行提取；无章节标记时退化为单块正文 |
| 分集（式(5) 前置） | 三策略各自断言分组边界；`targetChars` 钳制在 `[300,8000]`、`maxEpisodes` 钳制在 `[1,12]`；**尾集吸收溢出内容且不丢原文**；`fixed` 策略实测 400 字目标产出 399/393 字/集 |
| 层次化分解（式(5)） | `tests/novel-project.test.mjs`：分集节点与 `management.episodes` 数量一致；所有连线的 `from`/`to` 均指向存在的节点 |
| RAG 语料（式(6)） | `idea` 节点携带原著全文；`management.source.text` 在重新分集后仍保留全文 |
| 知识库 / 重排（式(6)） | `tests/knowledge.test.mjs`：`chunkNovel()` 的 512/128 分块与块间重叠、`KnowledgeBase.search()` 的 BM25 排序与 k 限制、`retrieveRelevantChunks()` 的 `processChain` 逐条检索 / 0.7 阈值 / 分数累加 / 单命中保底、缓存落盘往返、`formatFragments()` 的 FRAGMENT 标签与 512 截断 |
| 检索算法层（角色提取复用） | `tests/bm25.test.mjs`：中文 bigram 分词与停用词过滤、512/128 分块与重叠、BM25 排序、多线索召回与阈值过滤、`formatFragments()` 标签串 |
| 角色提取与定妆（§5.2） | `tests/characters.test.mjs`：`normalizeCharacter()` 的静态/动态特征派生与不被覆盖、`buildCharacterPrompt()` 区分固定/可变特征、`buildViewPrompt()` 正面显式写出特征二分、侧面/背面以正面图为依据且不重复特征描述、`buildCharacterPassages()` 能召回长篇中后段角色的外貌原文、`buildExtractVars()` 证据组装与 `EXTRACT_CAP` 截断、`mergeExtracted()` 别名并集 / 启发式占位可被覆盖 / 手改与已手改角色不被覆盖 |
| 角色抽取的提示词注入（§5.2） | `tests/providers.test.mjs`：`charExtract` 的 system prompt 含论文抽取准则与 FRAGMENT 声明，user 消息带召回的原文片段且不重复塞入 `fragments` 元信息 |
| 角色管理路由（§5.2） | `tests/character-routes.test.mjs`：`POST /characters/extract` 召回片段并写回角色（含 static/dynamic 特征）、无原著 400、`POST /characters/views` 三视图依次产出且侧面/背面提示词以正面定妆图为依据、角色不存在 404、非法视图 502 |
| 项目封面（管理动作） | `tests/project-steps.test.mjs`：`createManagement` 初始化名称封面、`ensureManagement` 兼容老项目、上传 / ComfyUI 生成 / 恢复名称封面三种 `cover` 动作、`url`/`prompt` 长度钳制、`projectIndex` 下发 `cover` |
| 角色一致性（ref 边） | `projectStats` 断言 `anchorCount` / `refCount` 分别统计两类依赖边 |
| 六步状态机 | `tests/project-steps.test.mjs`：待执行→进行中→完成/失败→重置的完整迁移；进度百分比；失败时 `status='error'` |
| 论文默认值 | `management.theory.defaults` 断言 `k=2`、`anchorRequired`、`ragRequired`、`eventChainRequired` 均为真 |
| 交付格式 | `outputModeOf()` 三态映射；导演包 ZIP 经 Python `zipfile.testzip()` 逐条 CRC 校验 |
| 导演技能与最终产物验收（§5.3） | `tests/director-skills.test.mjs`：技能清单 / 运行计划（六步 vs 四步）/ 交付设置覆盖 / 验收分级（达成·降级·缺失）/ **时长规格不符即判未达成** / 零 Key 导演阐述；`tests/director-run.test.mjs`：空项目真实编排到 62 节点与 35 文件导演包、六步全 done、**10 片段 × 3s = 30s、ffprobe 实测成片、导演包 timeline 10 段 / 720 帧**、角色音色写回、换技能同步交付设置与强制重打包、缺原著阻断、空步骤链不伪造执行记录 |
| 短剧成片规格（§5.4） | `tests/runtime-spec.test.mjs`：30/3→10 推导、非整除对齐与钳制、`allocateShots()` 在任意场景数下总和恒等于片段数、项目状态与管理动作、验收逐条列出失败项（含还原「12 片段 / 60s」旧缺陷）、**真实 ffmpeg 成片 ffprobe 实测 30s**、`stitchClips()` 报告实测时长而非标称值 |
| 成片真实性与制片对话（§5.5） | `tests/film-policy.test.mjs`：`isRealClip` / `isRealFilm` 口径、`evaluateFilm` 在 real/preview 与缺口组合下的分级（零真实片段判缺失、少一段判缺失、预览显式降级）；`tests/step-chat.test.mjs` 32 项与 `tests/production-chat.test.mjs` 9 项：意图分类、对话改 bible/runtime/policy 真实落库、长任务互斥、**导出含一键复刻命令串**、JSON 可重放 |
| 图调度（DAG 分层） | `tests/graph.test.mjs`：`topoLayers()` 分层、`descendants/ancestors` 上下游子图、`autoLayout()` 自动布局、`validate()` 环检测 |
| 持久层一致性 | `tests/store.test.mjs`：列表缓存同毫秒连改仍读到最新索引、快照封顶 20 份且同毫秒不互相覆盖 |
| 极简创建与延迟上传 | `tests/novel-project.test.mjs`：空 text 返回骨架（六步全 pending、停在第 ① 步、不建分集节点但保留画布 DAG）；`attachSource()` 注入节点并完成 ①②；过短正文仍被 40 字校验拦截 |
| 资源索引与角色复用 | `tests/assets.test.mjs`：按文件名推断类型、`index.json` 自动收录落盘、打标签改名校验、重扫剔除且保护用户元数据、角色名归一化（全角/空白/称谓）、**跨项目角色优先匹配（同名与变体命中、未登记不误配）** |
| 编排器调度 | `tests/orchestrator.test.mjs`：波次调度、`scope` 白名单、失败与跳过传播、取消与并发保护（全程 mock，无网络请求） |
| LLM 端点健壮性 | `tests/providers.test.mjs`：挂起端点经 `llmTimeoutMs` 超时后回退 Mock 不永久卡死；调用方已取消时不等完整超时立即失败 |

---

## 7. 阅读路线与引用规范

1. 想知道「某一步为什么这样设计」→ 本文 §3 + `src/core/project-steps.mjs` 的 `STEPS[].theory`。
2. 想核对公式、指标、消融 → [`paper/ViMax_论文中文版.md`](paper/ViMax_论文中文版.md) §2–§3；权威措辞回查 [`paper/ViMax_原文_EN.md`](paper/ViMax_原文_EN.md) 或 [`paper/ViMax_原文_arXiv2606.07649v2.pdf`](paper/ViMax_原文_arXiv2606.07649v2.pdf)。
3. 想改分层 / 数据契约 / API → [`ARCHITECTURE.md`](ARCHITECTURE.md) §14（创作项目管理层）。
4. 论文 ↔ 代码的逐文件对照 → [`paper/README.md`](paper/README.md) §4。

对外描述请写「**参考 ViMax 论文（arXiv:2606.07649）的方法思想**」，不要表述为官方实现或官方移植；分集、项目管理、无限画布、导演包格式都属本项目扩展。
