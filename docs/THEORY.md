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
| (1) | `𝒮 = ScreenWriting(ℐ; P_C(ℐ))` 输入 → 统一格式剧本 | `src/agents/narrative.mjs` · `screenwriter`；`src/core/providers.mjs` · `generate('screenplay')` | 创作项目下发 `novelTitle / novelEpisodes / characters / novelExcerpt`，Mock 分支据此生成「第 N 集」场景表与结尾钩子，而不是固定模板剧情 |
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
| ③ | 剧本生成与格式统一 | **式(1)** | `['script']` | `screenwriter` → 统一格式剧本 `S`（片名 / 类型 / 梗概 / 角色 / 场景表） |
| ④ | RAG · 角色 · 层次分解 | **式(5)(6)** | `['rag','character','plan','event','scene','shot']` | `rag`（原著索引）→ `character`（定妆资产）→ `decomposer`（事件→场景→镜头）→ `storyboard`（镜头链） |
| ⑤ | 分镜 · 机位图 · 择优 · 片段 | **式(2)(3)(4)(7)(8)** | `['keyframe','review','video','transition','camera']` | `keyframe`(k=2) → `review` → `video` / `transition` → `camera-graph` 汇总 |
| ⑥ | 双产物交付 | 式(3) + 依赖图并行 · **扩展层** | `['final']` | `composer` → `timeline.json` / MP4 / `*.mmxpack.zip` |

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
| 分块 | `RecursiveCharacterTextSplitter(chunk_size=512, chunk_overlap=128)` | `src/core/knowledge.mjs · chunkNovel(text, {chunkSize:512, overlap:128})`，按段落 / 句子边界聚合，块间带 128 字重叠 | ✅ 参数与重叠语义一致 |
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
| 并行调度 | 运行日志的「第 N 波：X 个节点就绪，按并发 3 调度」 |
| 六步状态与视觉提示 | 右侧「任务步骤」Tab、顶栏 `x/6` 胶囊与进度条、画布上方六步导航条、Toast 与运行日志 |
| 双产物 | 第 ⑥ 步后 `final` 节点 `data.directorPack`（可下载 ZIP）/ `data.film`（接入 ComfyUI 后才有 MP4）、`timeline.json` |
| 项目管理 | 侧栏搜索 / 筛选 / 收藏 / 归档 / 复制 / 标签，管理面板的快照创建与恢复 |

### 6.1 自动化验证（`npm test` → 92 项全通过）

机制层面的"真的落地"由测试固化，而非仅靠肉眼检查：

| 机制 | 对应断言 |
|---|---|
| 输入归一（式(1) 前置） | `tests/novel.test.mjs`：章节正则覆盖 `第X章`/`Chapter N`/数字标题；书名首行提取；无章节标记时退化为单块正文 |
| 分集（式(5) 前置） | 三策略各自断言分组边界；`targetChars` 钳制在 `[300,8000]`、`maxEpisodes` 钳制在 `[1,12]`；**尾集吸收溢出内容且不丢原文**；`fixed` 策略实测 400 字目标产出 399/393 字/集 |
| 层次化分解（式(5)） | `tests/novel-project.test.mjs`：分集节点与 `management.episodes` 数量一致；所有连线的 `from`/`to` 均指向存在的节点 |
| RAG 语料（式(6)） | `idea` 节点携带原著全文；`management.source.text` 在重新分集后仍保留全文 |
| 知识库 / 重排（式(6)） | `tests/knowledge.test.mjs`：`chunkNovel()` 的 512/128 分块与块间重叠、`KnowledgeBase.search()` 的 BM25 排序与 k 限制、`retrieveRelevantChunks()` 的 `processChain` 逐条检索 / 0.7 阈值 / 分数累加 / 单命中保底、缓存落盘往返、`formatFragments()` 的 FRAGMENT 标签与 512 截断 |
| 项目封面（管理动作） | `tests/project-steps.test.mjs`：`createManagement` 初始化名称封面、`ensureManagement` 兼容老项目、上传 / ComfyUI 生成 / 恢复名称封面三种 `cover` 动作、`url`/`prompt` 长度钳制、`projectIndex` 下发 `cover` |
| 角色一致性（ref 边） | `projectStats` 断言 `anchorCount` / `refCount` 分别统计两类依赖边 |
| 六步状态机 | `tests/project-steps.test.mjs`：待执行→进行中→完成/失败→重置的完整迁移；进度百分比；失败时 `status='error'` |
| 论文默认值 | `management.theory.defaults` 断言 `k=2`、`anchorRequired`、`ragRequired`、`eventChainRequired` 均为真 |
| 交付格式 | `outputModeOf()` 三态映射；导演包 ZIP 经 Python `zipfile.testzip()` 逐条 CRC 校验 |
| 图调度（DAG 分层） | `tests/graph.test.mjs`：`topoLayers()` 分层、`descendants/ancestors` 上下游子图、`autoLayout()` 自动布局、`validate()` 环检测 |
| 持久层一致性 | `tests/store.test.mjs`：列表缓存同毫秒连改仍读到最新索引、快照封顶 20 份且同毫秒不互相覆盖 |
| 编排器调度 | `tests/orchestrator.test.mjs`：波次调度、`scope` 白名单、失败与跳过传播、取消与并发保护（全程 mock，无网络请求） |

---

## 7. 阅读路线与引用规范

1. 想知道「某一步为什么这样设计」→ 本文 §3 + `src/core/project-steps.mjs` 的 `STEPS[].theory`。
2. 想核对公式、指标、消融 → [`paper/ViMax_论文中文版.md`](paper/ViMax_论文中文版.md) §2–§3；权威措辞回查 [`paper/ViMax_原文_EN.md`](paper/ViMax_原文_EN.md) 或 [`paper/ViMax_原文_arXiv2606.07649v2.pdf`](paper/ViMax_原文_arXiv2606.07649v2.pdf)。
3. 想改分层 / 数据契约 / API → [`ARCHITECTURE.md`](ARCHITECTURE.md) §14（创作项目管理层）。
4. 论文 ↔ 代码的逐文件对照 → [`paper/README.md`](paper/README.md) §4。

对外描述请写「**参考 ViMax 论文（arXiv:2606.07649）的方法思想**」，不要表述为官方实现或官方移植；分集、项目管理、无限画布、导演包格式都属本项目扩展。
