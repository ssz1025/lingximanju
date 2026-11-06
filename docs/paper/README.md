# 论文资料 · ViMax（本项目的参考依据）

> **ViMax: Agentic Video Generation** — arXiv:2606.07649v2，Lingxuan Huang 等，HKUDS。
> 本目录存放本项目的**论文参考依据**，与代码一同纳入版本管理，使仓库脱离任何特定 AI 工具后仍可独立阅读、独立开发。
> 本仓库**只参考论文的方法思想**，未复制 ViMax 的 Python 实现、提示词文本或任何源码。

---

## 1. 文件清单

| 文件 | 大小 | 用途 | 什么时候读 |
|---|---|---|---|
| [`ViMax_核心要点导读.md`](ViMax_核心要点导读.md) | 15 KB | 批判性导读：一分钟速览、方法全景、实验速查、术语对照、论文↔官方代码对照 | **先读这份**。改动架构前快速建立地图，10 分钟 |
| [`ViMax_论文中文版.md`](ViMax_论文中文版.md) | 50 KB | 全文中文翻译：摘要、方法 1–2 章、实验 3 章、结论、局限、伦理、参考文献、附录 A（20 页 / 13 幅图） | 需要确认某个公式、指标、消融结论时查全文 |
| [`ViMax_论文中文阅读版.html`](ViMax_论文中文阅读版.html) | 99 KB | 带目录导航、图注、MathJax 公式渲染的单页阅读版 | 想连图带公式完整阅读；用浏览器或 IDE 内置预览打开 |
| [`ViMax_原文_arXiv2606.07649v2.pdf`](ViMax_原文_arXiv2606.07649v2.pdf) | 14 MB | **英文原版 PDF（v2，官方排版，21 页）** | 引用页码、核对原始措辞与数值、对外引用的权威依据 |
| [`ViMax_原文_官方HTML版.html`](ViMax_原文_官方HTML版.html) | 234 KB | arXiv 官方 HTML 全文的离线副本：正文、MathML 公式、16 张图、13 张表，样式与配图均已本地化 | 完全离线、带图读英文原文；直接双击打开即可，无需联网 |
| [`ViMax_原文_EN.md`](ViMax_原文_EN.md) | 63 KB | 从官方 HTML 提取的**结构化英文全文**：章节标题、8 个 display 公式（LaTeX）、5 张数据表、16 处图引用、图注、参考文献 | **给 IDE / AI 助手用**：全文检索、grep、`@` 引用；PDF 在多数 IDE 里不便直接喂给 AI |
| [`vimax_paper_figures/`](vimax_paper_figures/) | 8.5 MB / 16 张 | 论文配图（框架图、案例图、消融与超参图表，SVG + PNG） | 中文 HTML 与英文 HTML / Markdown 共用此目录，**请勿移动或改名** |
| `assets/` | 77 KB | arXiv 官方 HTML 的样式表（3 个 CSS，本地化） | 仅供英文 HTML 版离线渲染 |

**注意**：两个 HTML 阅读版与 `ViMax_原文_EN.md` 都用相对路径 `vimax_paper_figures/xxx` 引用配图，因此必须与 `vimax_paper_figures/` 保持同级。中文阅读版的公式走 jsDelivr 的 MathJax CDN，离线时公式显示为 LaTeX 源码；**英文 HTML 版公式是 MathML，浏览器原生渲染，完全离线可用**。

**版本与来源**：英文三件套均取自 [arXiv:2606.07649v2](https://arxiv.org/abs/2606.07649v2)（v1 2026-06-02 / v2 2026-07-21），PDF 与 HTML 全文内容未改写，只做了离线路径重写；英文 Markdown 为自动提取，排版细节可能与 PDF 略有出入，**引用具体措辞与数值请回查 PDF**。未收录 LaTeX 源码包（TeX Source），需要可访问 [arXiv /src](https://arxiv.org/src/2606.07649v2)。译文中提到的「本地副本 `ViMax/`」位于工作区根目录下（`../../../ViMax/`，相对本目录），**不在本仓库内**，本仓库不依赖它运行。

---

## 2. 阅读路线

| 目标 | 路线 |
|---|---|
| 只是想改个 UI、修个 bug | 不必读论文，直接看根目录 [`README.md`](../../README.md) 与 [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) |
| 要改智能体 / 流水线 / 调度 | 导读 §0–§3 → 全文 §2.1–§2.3 → [`docs/AGENTS.md`](../AGENTS.md) §2 智能体清单 → 本文 §4 对照表 |
| 要改创作项目的六步任务 / 默认值 | [`docs/THEORY.md`](../THEORY.md) §3–§5 → [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) §14 → `src/core/project-steps.mjs` 的 `STEPS` |
| 要复现或质疑实验结论（k 值、耗时、成本、指标） | 导读 §4/§7 → 全文 §3.2–§3.7、附录 A.5 → `vimax_paper_figures/` 内对应图表 |
| 核对英文原始措辞、公式、表头、引用出处 | `ViMax_原文_EN.md`（检索定位）→ `ViMax_原文_官方HTML版.html`（带图阅读）→ `ViMax_原文_arXiv2606.07649v2.pdf`（权威定稿） |

---

## 3. 公式速查（全文 §2）

| 编号 | 含义 | 小节 |
|---|---|---|
| (1) | `𝒮 = ScreenWriting(ℐ; P_C(ℐ))` 用户输入 → 统一格式剧本 | 2.1 |
| (2) | `S₁…Sₙ = ShotPlanning(𝒮)` 剧本 → 镜头规格序列 | 2.1 |
| (3) | `ImageGen → VideoGen` 关键帧与视频片段生成 | 2.1 |
| (4) | `C* = argmax VLM-Judge(Cⱼ, Sᵢ)` best-of-k 择优 | 2.1 |
| (5) | `Decomp(N_{d-1,i})` 层次化叙事分解 | 2.2.1 |
| (6) | `Index / Retrieve / Enrich` RAG 全局上下文增强 | 2.2.2 |
| (7) | `BuildCameraGraph` + `GenConditioned(Sᵢ, Aᵢ)` 机位依赖图与视觉锚点传播 | 2.3.1 |
| (8) | `GenTransition / ExtractViews` 转场视频作空间锚点 | 2.3.2 |

---

## 4. 论文 ↔ 本项目实现对照（**给继续开发的人 / AI 看**）

> 下表路径均相对**仓库根目录**。智能体 id 与输入输出契约详见 [`docs/AGENTS.md`](../AGENTS.md) §2。
> 本项目是**功能形态复刻 + 画布化表达**，实现是零依赖 Node.js 自研，与官方 Python 实现无代码关系；表中「简化」处是明确的工程取舍，非遗漏。

| 论文机制 | 出处 | 本项目落点 | 实现要点 / 差异 |
|---|---|---|---|
| 编剧与镜头规划 | 2.1 / 式(1)(2) | `src/agents/narrative.mjs`（`screenwriter`、`storyboard`） | 按输入形态路由提示词；镜头规格含景别、机位、运镜、时长 |
| 层次化叙事分解 | 2.2.1 / 式(5) | `src/agents/narrative.mjs`（`decomposer`）、`src/pipelines/templates.mjs` | 递归拆成 `事件 → 场景 → 镜头` 三层画布节点，运行中动态展开 |
| RAG 全局上下文 | 2.2.2 / 式(6) | `src/agents/narrative.mjs`（`rag`） | **简化**：中文 2-gram + 关键词权重倒排索引，非向量库；`ref` 边标出上下文来源 |
| 角色一致性资产 | 2.1 | `src/agents/narrative.mjs`（`character`）、`src/core/artwork.mjs` | 角色抽取 + 自绘三视图 SVG；Mock 无真实图像模型 |
| 机位依赖图 / 视觉锚点 | 2.3.1 / 式(7) | `src/agents/narrative.mjs`（`camera-graph`）、`src/core/graph.mjs` | 父子机位建 `anchor` 虚线边，父关键帧作 `refs` 传入下游关键帧 |
| VLM best-of-k 择优 | 2.1 / 式(4)、RQ6 | `src/agents/visual.mjs`（`keyframe`、`review`） | 默认 `k=2`（论文 RQ6 结论）；落选候选保留在 `candidates` 供检查器对比；可删 `review` 边做消融 |
| 关键帧 / 视频生成 | 2.1 / 式(3) | `src/agents/visual.mjs`、`src/core/providers.mjs`、`src/core/comfyui.mjs` | Mock / OpenAI 兼容 / 本地 ComfyUI 三种 Provider，失败自动回退并写日志 |
| 转场空间锚点 | 2.3.2 / 式(8) | `src/agents/visual.mjs`（`transition`） | Mock 为自绘转场图；真实路径由 ComfyUI 图生视频工作流承担 |
| 依赖图并行调度 | 2.3.1 末 / 3.5 | `src/core/graph.mjs`（`topoLayers`）、`src/core/orchestrator.mjs` | Kahn 拓扑分层、同层并发、取消、失败隔离、断点续跑、单节点重跑 |
| 成片与交付 | —（论文未展开） | `src/core/film.mjs`、`src/core/director-pack.mjs` | ffmpeg 拼接 MP4 + `*.mmxpack.zip` 导演包，属本项目扩展 |
| **论文之外** | — | `public/canvas.js`、`public/nodes.js`、`src/agents/canvas-agent.mjs`、`src/api/routes.mjs` | 无限画布引擎、节点/连线体系、画布 Agent、REST + SSE，均为本项目原创，论文中无对应物 |
| **创作项目扩展层** | — | `src/core/novel.mjs`、`src/core/project-steps.mjs`、`src/pipelines/novel-project.mjs`、`public/wizard.js`、`public/project-manager.js` | 长篇小说→分集、六步任务状态机、项目管理、导演包交接格式；**不是论文机制**，详见 [`../THEORY.md`](../THEORY.md) §4 |

**实验数字定位**：端到端 405 s / 17.5 美元（§3.5、§3.7）、GC 0.5272 → 0.5571（§3.2）、NF 3.52/5（§3.3）、消融与 k 值（§3.4、§3.7）。改 `k`、`concurrency` 等默认值前建议先对照这些结论。
**六步任务与公式的逐条映射**见 [`../THEORY.md`](../THEORY.md) §3（后端 `STEPS[].scope` → 节点类型 → 函数），默认值的消融依据见该文 §5。

---

## 5. 在其他 IDE 中继续开发

本目录是普通文件，不依赖 WorkBuddy。用 VS Code / Cursor / Windsurf / JetBrains 等打开 `lingximanju/` 后：

1. **让 AI 助手先读三份上下文**：根目录 `README.md`（能做什么 + 接口）、`docs/ARCHITECTURE.md`（分层与数据契约）、`docs/AGENTS.md`（智能体与 DAG 算法）；需要论文依据时 `@` 引用 `ViMax_核心要点导读.md` / `ViMax_论文中文版.md`，**核对英文原文用 `ViMax_原文_EN.md`**（纯文本，最省上下文且可全文检索，优于喂 PDF）。
2. **改编排/智能体前**，先查本文 §4 对照表定位文件，避免把「论文中的机制」误当成「本仓库已有的实现」。
3. **入口与运行**：`node server.mjs` 或 `./start.sh` → `http://127.0.0.1:45367`。零 `npm install`、零构建、零 API Key（Mock 模式即可跑通全流程）。
4. **约定**：Node.js ≥ 18、原生 ESM（`.mjs` + `public/*.js`）、无第三方运行时依赖、数据落 `data/`（已被 `.gitignore` 排除）。

---

## 6. 归档说明

- 归档时间：2026-11-06。中文三件套与 16 张配图来自工作区根目录调研产物，内容未改写、整套复制；英文三件套取自 arXiv 官方 v2（PDF / HTML 全文），仅重写离线资源路径，正文未改写；`ViMax_原文_EN.md` 为自动提取的结构化副本。
- 论文中文翻译版、核心要点导读、中文 HTML 阅读版与配图均为本工作区的调研产物，供本项目开发参考；英文原文著作权归原作者所有，归档仅供本项目内部开发参考。
- 译文中的图号、表号、公式编号与原文一致，可据此对照 arXiv 原版 PDF。
- 引用规范：对外描述本项目时请注明「参考 ViMax 论文方法思想」及 [arXiv:2606.07649](https://arxiv.org/abs/2606.07649)，不要表述为官方实现或官方移植。
