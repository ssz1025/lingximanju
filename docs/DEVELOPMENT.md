# 论文参考资料 · 在其他 IDE 中继续开发

`docs/paper/` 已随仓库归档 ViMax 论文的**英文原版（PDF / 离线 HTML / 可检索 Markdown）、中文全文翻译、核心要点导读、带图阅读版与 16 张配图**，不依赖本工作区外的任何路径，用 VS Code / Cursor / Windsurf / JetBrains 等打开 `lingximanju/` 即可直接阅读；两个 HTML 版均已把图片与样式本地化，断网也能看。

参考 ViMax 论文（[arXiv:2606.07649v2](https://arxiv.org/abs/2606.07649)）的方法思想与本地 `ViMax/` 仓库的功能划分，交互范式参考 Toonflow 的无限画布；**未复制任何一方源码**。

| 场景 | 入口 |
|---|---|
| 了解项目能做什么、怎么跑 | [`README.md`](../README.md) |
| 改分层 / 数据契约 / API | [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)（§14 创作项目管理层） |
| 确认六步任务对应论文哪条公式、默认值依据 | [`docs/THEORY.md`](THEORY.md) |
| 改智能体 / DAG 调度 / 失败恢复 | [`docs/AGENTS.md`](AGENTS.md) |
| 确认某个机制出自论文哪一节、对应本仓库哪个文件 | [`docs/paper/README.md`](paper/README.md) §4 对照表 |
| 查公式、指标、消融结论 | [`docs/paper/ViMax_论文中文版.md`](paper/ViMax_论文中文版.md) §2–§3 |
| 核对英文原文措辞 / 权威引用 | [`docs/paper/ViMax_原文_EN.md`](paper/ViMax_原文_EN.md)（检索）· [`ViMax_原文_arXiv2606.07649v2.pdf`](paper/ViMax_原文_arXiv2606.07649v2.pdf)（定稿） |

给 AI 助手的上下文建议：先让它读 `README.md` → `docs/ARCHITECTURE.md` → `docs/AGENTS.md`，涉及论文机制时再 `@` 引用 `docs/paper/ViMax_核心要点导读.md` 或全文版。运行只需 `node server.mjs`（Node.js ≥ 18，零依赖、零构建、无需 API Key）。
