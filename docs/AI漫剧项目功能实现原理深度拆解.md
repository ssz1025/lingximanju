# AI 漫剧项目 · 功能实现原理深度拆解（功能级）

> 接续《AI漫剧项目调研报告》（2026-11-08，行业/竞品/三项目总览）。  
> 本报告下沉到 **功能级**：逐功能给出 **功能细节 / 展示结果 / 实现原理**，并附三项目横向对照与原理提炼。  
> 材料来源：huobao-drama 直接读源码（已本地部署，库内建有 1 个 episode 壳）；LumenX-Studio、LingGuo-Drama 经逐文件核查的源码探查结论。

---

## 〇、范围与总架构

| 项目                              | 后端                              | 前端         | 持久化          | AI 编排                                | 模型层                     | 合成            |
| ------------------------------- | ------------------------------- | ---------- | ------------ | ------------------------------------ | ----------------------- | ------------- |
| **huobao-drama**（火宝）            | Hono + Drizzle + better-sqlite3 | Nuxt3/Vue3 | SQLite 本地    | 5 个 Mastra Agent（提示词外置 SKILL.md，可热改） | Adapter 注册表             | FFmpeg 本地     |
| **LumenX-Studio**（阿里 StarLotus） | FastAPI（comic_gen + playground） | Next.js    | 内存 + JSON 文件 | Studio Pipeline + Playground 独立台     | 声明式 catalog yaml        | FFmpeg/Demucs |
| **LingGuo-Drama**（灵果）           | Go + Gin + GORM                 | Vue3/Vite  | MySQL 8      | 异步任务队列（Asynq）                        | Provider/VideoClient 抽象 | FFmpeg        |

**huobao 的 Agent 机制一句话**：每个 Agent 的「大脑」= `DEFAULT_PROMPTS[type].instructions`（`agent_configs` 表可覆盖）+ 注入的 `skills/<id>/SKILL.md` 文本 + 一组 `tools/*.ts` 工具（读写 DB）。`createAgent(type, episodeId, dramaId)` 每次请求动态装配，工具闭包里注入 episodeId/dramaId。

---

## 一、huobao-drama 功能级拆解（12 个功能点）

### 1. 剧本改写 Agent（script_rewriter）

- **功能细节**：把网文/小说改写为「格式化剧本」。规则：保留核心情节、增强画面感、对话驱动、每场 30–60s、不写镜头语言。
- **展示结果**：章节头 + 动作段 + 对白的标准格式，增量约 20–30%（只加场景头/格式化，不扩写）。
  ```
  ## S01 | 内景 · 咖啡厅 | 黄昏

  黄昏的光线透过落地窗洒进咖啡厅，吧台上咖啡杯热气升腾。
  小明独自坐在角落卡座，低头看手机，神情焦虑。

  小红：（微笑）等很久了吗？
  小明：（抬头）还好，刚到。
  ```
- **实现原理**：
  - 提示词：`agents/index.ts` 的 `DEFAULT_PROMPTS.script_rewriter` + `skills/script_rewriter/SKILL.md`（改写原则 + 格式规则 + 步骤）。
  - 工具链：`tools/script-tools.ts` 的 `read_episode_script` → `save_script`（写回 `scripts.content`）。
  - 热改：`agent_configs` 表按 `agentType` 存 `systemPrompt/model/isActive`，`getAgentConfig` 取激活项覆盖默认；`skills.ts` 运行时把 SKILL.md 拼进 instructions。
  - 模型：`getTextConfig()` 从 `ai_service_configs` 取 `text` 类激活配置（按 `priority`）。

### 2. 角色/场景/道具提取 Agent（extractor）

- **功能细节**：从剧本抽取角色（姓名/定位/外貌 300–500 字/性格/背景）、场景（地点/时间/氛围/英文 prompt）、道具；**与项目已有数据智能去重**，只处理当前集真实出现的实体。
- **展示结果**：角色卡 / 场景卡 / 道具卡（含 `image_prompt` 英文提示词），并自动关联到当前 episode（`episode_characters` / `episode_scenes` 关联表）。
- **实现原理**：
  - 工具：`read_script_for_extraction` → `read_existing_characters` / `read_existing_scenes`（先读已有避免重复）→ `save_dedup_characters` / `save_dedup_scenes`（事务：同名合并/新增）。
  - 去重主键：角色按 `name` 精确；场景按 `[location + time]` 精确（同地点不同时段 = 新场景）。

### 3. 分镜拆解 Agent（storyboard_breaker）

- **功能细节**：把剧本拆成镜头序列，每镜 10–15s，输出 **18 个字段**完整分镜（景别/角度/运镜/动作/对白/结果/氛围/`image_prompt`/`video_prompt`/`bgm_prompt`/`sound_effect` 等）。
- **展示结果**：结构化分镜表，每个镜头绑定 `scene_id`（优先复用已有场景）和 `character_ids`（只能从已有角色选，杜绝凭空造人）。`video_prompt` 时间轴格式：
  ```
  0-3秒：<location>咖啡厅</location>，近景，<role>小明</role>低头看手机，表情焦虑。
  <n>3-6秒：<location>咖啡厅</location>，全景，门铃响，<role>小红</role>推门走入。
  ```
- **实现原理**：
  - 工具 `read_storyboard_context`（聚合 剧本+角色+场景+已有分镜摘要）→ `save_storyboards` 一次性落库。
  - 标签约定：`<location>` 场景、`<role>` 角色、`<voice>` 画外音、`<n>` 时间段分隔（3s 一段）。
  - 一致性约束：`location/time` 必须匹配 `scenes`；`character_ids` 必须来自上下文角色列表。

### 4. 图片提示词 Agent（grid_prompt_generator）

- **功能细节**：生成三类英文提示词 —— 角色图、场景图、宫格图（`first_frame` / `first_last` / `multi_ref` 三种模式）。强约束 `exactly N visible panels / no merged panels / no missing panels`。
- **展示结果**：英文 prompt 串。角色：`[appearance], [personality], [role], cinematic portrait, high quality, no text/watermark`；宫格图返回整体 `grid_prompt` + 每格 `cell_prompts`。
- **实现原理**：`read_characters` / `read_scenes` / `read_shots_for_grid` 取数据 → `generate_grid_prompt`（参考 `reference/character-prompt.md` 等模板）；支持「参考图映射」原样透传（`图片1/图片2` 与 `格1/格2` 不混用）。

### 5. 音色分配 Agent（voice_assigner）

- **功能细节**：按角色性别/年龄/性格/定位匹配音色库。
- **展示结果**：每个角色 → `voice_id` 绑定 + 选择理由；可生成试听（`generateVoiceSample` 用样例文案合成）。
- **实现原理**：`list_voices` → `get_characters` → `assign_voice` 写入 `characters.voiceStyle`；TTS 走 MiniMax / 小米 MiMo。
- **lingximanju 落地**：已在本项目实现并可用，对应代码与接口如下：
  - 全局音色库 `data/voices.json`（`src/core/voices.mjs` 的 `DEFAULT_VOICES` 提供 10 个种子音色）；CRUD 走 `GET/POST /api/voices`、`PUT/DELETE /api/voices/:id`、`POST /api/voices/seed`。
  - 分配智能体 `src/agents/voice-agent.mjs` 的 `voice-assigner`：LLM 优先（`providers.generate('voiceAssign')`），未配置/失败时回退 `matchAll` 启发式打分（性别 40 / 年龄 30 / 性格 20 / 定位 10），写回角色 `voiceId/voiceName/voiceReason/voiceScore`。
  - 项目级接口：`POST /api/projects/:id/voices/assign`（AI 分配）、`GET .../voices/status`、`POST .../voices/set`（手动指定/清空）。
  - 试听：`POST /api/voices/sample` 默认回传浏览器 SpeechSynthesis 参数（`lang/rate/pitch/text`），前端 `public/voice-preview.js` 用 Web Speech API 离线朗读；配置 `TTS_ENDPOINT` 且音色带 `tts.voiceId` 时改为生成真实音频样本。音色自带 `audio.url`（抽卡产物）时优先返回 `{mode:'asset', url}`，前端用单例 `<audio>` 播真实声线。
  - **音色抽卡**（超出原作的扩展）：`src/core/voice-drafts.mjs` 候选池 + `src/core/comfyui.mjs` 的 `drawVoiceCandidates()`。一次抽 N 次（`count` 1–8）、每次换 seed、按 `voiceValues` 轮换说话人，只收真实音频产物；候选落 `data/voice-drafts.json`（`vdr_` 前缀 / 24h TTL / 40 条上限 / 单项目 24 条），过期自动淘汰并回收音频。接口 `POST /api/voices/draw`、`GET /api/voices/drafts`、`POST /api/voices/drafts/:id/save`（转正为 `vox_`，携带 audio + draw 复现参数）、`DELETE /api/voices/drafts/:id`、`POST /api/projects/:id/voices/draw`（按角色条件抽）。**`POST .../voices/set` 收到候选 id 时自动先转正再绑定**（响应 `promoted: true`），保证角色永不引用会被 TTL 清掉的音色。

### 6. 图片生成（image-generation.ts + adapters）

- **功能细节**：按 prompt 生成角色/场景/分镜首帧/尾帧/合成图；支持参考图（I2I）；同步或异步轮询；回写对应实体。  
  |  |  |  |  
  | --- | --- | --- |
- **展示结果**：本地图片（`data/static/images/*`），回写 `characters.imageUrl` / `scenes.imageUrl` / `storyboards.firstFrameImage|lastFrameImage|composedImage`。
- **实现原理**：
  - `generateImage` 先插 `image_generations` 记录（status=processing），再异步 `processImageGeneration`。
  - **Adapter 模式**：`getImageAdapter(provider)` 从 `registry` 取（minimax/openai/gemini/volcengine/ali/chatfire）；`buildGenerateRequest` 构造请求，`parseGenerateResponse` 区分 同步URL / base64 / 异步 taskId。
  - 参考图归一化：`normalizeReferenceImages` 支持 `data:image`、本地 `static/` 路径（sharp 压缩到 768×768 q68），去重，上限 **6 张**。
  - 异步：`pollImageTask` 每 5s 轮询，最多 10 分钟；Gemini 可能返回 base64。

### 7. 视频生成（video-generation.ts + adapters）

|   |   |   |   |
| - | - | - | - |

- **功能细节**：文生视频 / 图生视频（首帧/尾帧）/ 多参考图生视频；`referenceMode = none|first_frame|last_frame|reference`；多模型（MiniMax/火山 Seedance/Vidu/阿里）。
- **展示结果**：本地视频（`data/static/videos/*`），回写 `storyboards.videoUrl` + `duration`。
- **实现原理**：
  - 同图片流程；Adapter 区分 `isAsync / videoUrl / taskId`。
  - **Vidu 无轮询端点** → 依赖 Webhook 回调（`/webhooks`，`videos` 表 `taskId` 等待回调）。
  - 轮询 `pollVideoTask` 每 10s，最多 300 次（≈50 分钟）。

### 8. 配音 TTS（tts-generation.ts）

- **功能细节**：把对白文本合成为角色音频；支持 MiniMax（hex 响应）/ OpenAI 兼容 `/audio/speech` / MiMo。
- **展示结果**：本地 mp3（`data/static/audio/*`），返回相对路径；支持试听样本。
- **实现原理**：`getAudioConfigById` → `getTTSAdapter` → `buildGenerateRequest` → 解析 hex → `Buffer` 解码 → 写文件。

### 9. 单镜头合成 compose（ffmpeg-compose.ts）

- **功能细节**：视频 + TTS 对白音频 + 烧录字幕，合成一个带声画的对白镜头。
- **展示结果**：`composed_video_url`（`data/static/composed/*`），`storyboards.status = compose_completed`。
- **实现原理**：
  - `parseDialogueForTTS`：解析「说话人：台词」，正则 `IGNORE_TTS_*` 过滤环境音/音效/BGM 等不需配音文本。
  - 有对白 → `generateTTS`（按角色 `voiceStyle` 选音色，找不到回退 `alloy`）；生成 SRT 字幕；FFmpeg `subtitles` 滤镜烧录（检测滤镜可用性，否则跳过）+ 混音。
  - 复用已生成 `ttsAudioUrl`/`subtitleUrl`，避免重复生成。

### 10. 整集拼接 merge（ffmpeg-merge.ts）

- **功能细节**：把本集所有 compose 完成的镜头按顺序拼成一集成片。
- **展示结果**：`merged_url`（`data/static/merged/*`），`episodes.video_url` 更新。
- **实现原理**：要求全部 `storyboards` 都有 `composedVideoUrl` 才允许合并；生成 concat 列表文件（`-f concat -safe 0`）→ `libx264/aac` 重编码 → `ffprobe` 取时长。

### 11. 宫格图 grid（grid-split.ts + routes/grid.ts）

- **功能细节**：① 用 `grid_prompt_generator` 生成宫格提示词；② 调图生成出整张宫格大图；③ 用 sharp 按 `rows×cols` 切分成单格。
- **展示结果**：整张宫格图 + N 张单格 `cell_*.png`（`data/static/grid-cells/`），用于批量预览 / 抽卡。
- **实现原理**：`splitGridImage` 用 `sharp.extract`，按 `cellW = width/cols`、`cellH = height/rows` 逐格裁切。

### 12. 图文动画 / 动态海报 motion-post（motion-post.ts）

- **功能细节**：把分镜「合成图」做成带推拉摇的短视频（**无需真实视频模型**），可选配 BGM。
- **展示结果**：`motion_post` 资产（`data/static/motion_posts/*.mp4`），`assets` 表 `type=motion_post`。
- **实现原理**：
  - 每段 `renderSegment` 用 FFmpeg `zoompan`（按 `shot_type` 选 `zoom_in/out/pan`）+ `drawtext` 烧字幕 → 单段 mp4。
  - 时长 `computeSegmentDuration`：有 `duration` 用之，否则按 字数/4.5 估算，clamp 2.5~8s。
  - `concatWithXfade`：`xfade=transition=fade` 串联；`muxBgm` 循环 BGM + 尾 2s 淡出。
  - 输出 1080×1920 竖屏、30fps。

### huobao 一致性设计

- 角色/场景一次性抽取 → 存库 → 分镜阶段**只能引用已有 ID**（上下文注入候选列表），从源头杜绝「凭空造人/造景」。
- 角色图/场景图作为定妆照被后续分镜首帧/视频参考图复用（同一张图多次引用）。
- 画风一致性靠 `projects.style` 贯穿各阶段提示词。

> 实测：库内仅建了 1 个 episode 壳（id=2, drama_id=2, status=draft），`characters/scenes/storyboards` 尚未落内容，故「展示结果」以上述**代码契约级**形态为准。

---

## 二、LumenX-Studio 功能级拆解（Python+Node，阿里 StarLotus，MIT）

架构：FastAPI（`comic_gen` + `playground`），无外部 DB（内存 + JSON 文件持久化 `projects/series/library`），`BackgroundTasks` 异步，OSS 可选。模型接入声明式（`config/model_catalog/families/*.yaml`，8 个 family）。

1. **剧本分析/实体抽取**：`ScriptProcessor.parse_novel` → LLM 抽 角色/场景/道具三类实体 + 草稿分镜；三级 prompt 回退（Episode > Series > 内置）；`extract_preview` 干跑不落库。
2. **美术指导**：`style_presets.json` 预设 + LLM 风格推荐；`positive/negative prompt` 注入资产与分镜。
3. **多模型资产生成 + 角色一致性（最强项）**：
   - `reference_sheet`（多视角合图）作稳定参考；
   - 反向生成：上传图作 I2I 参考 + 强约束 prompt（`STRICTLY MAINTAIN the SAME character appearance…`）+ 切 `wan2.6-image`；
   - `base_character_id` 分组基准。
   - 资产按类型定尺寸：角色 576×1024、场景 1024×576、道具 1024×1024。
4. **AI 分镜 + prompt_assembly（核心算法）**：
   - `analyze_to_storyboard` LLM 拆帧 → 名称模糊匹配回填 scene/character/prop id；
   - `assemble_prompt` 按「主体动作 → 场景/灯光 → 运镜 → 景别 → 外观关键词」拼装；
   - `inject_reference_tags`：R2V 注入 `[characterN:name]` 参考槽；
   - `_get_character_appearance_keywords` 提取外观关键词保跨帧一致；
   - `enrich_prompt_with_dialogue` 把台词织入口型动作提示。
5. **分镜视频 I2V/R2V 多模型 + 抽卡**：按模型名路由 Seedance(MuleRouter)/Kling/Vidu/Wan；批量抽卡 + 星标/打标 + `auto_select_latest`；`workflow_mode`（r2v 节奏优先 / i2v_legacy 画面优先）。
6. **配音 TTS**：CosyVoice / Qwen3-TTS，按 `voice.family` 分派；语音克隆 + 语音设计 + 预览缓存（md5）。
7. **混音/口型对齐**：Demucs 分离人声/伴奏 → FFmpeg `adelay+amix` 把对白按 `offset_ms` 对齐叠加；BGM/SFX 混音 + 循环 BGM mux。
8. **合成导出**：`merge_videos` FFmpeg concat + BGM mux。
9. **系列/多集**：跨集共享角色/场景/道具；`reconcile` 资产对账（名称相似度）；上集回顾 + 下集钩子（LLM 生成摘要/钩子并缓存）。
10. **全局资产库**：三层可见性（Episode+Series+Global）合并 + `source` 标签；`promote`/`fork`；引用完整性检查（删除被引用资产返回 409）。
11. **Playground 独立生成台**：无需剧本即开即用图/视频生成、Prompt 模板、画廊、结果入资产库；复用同一批 `src/models/*` 适配器。

---

## 三、LingGuo-Drama 功能级拆解（Go+Gin+GORM+MySQL+Redis+Asynq，MIT）

架构：Cobra 四命令（`serve/worker/key/cache`）；`serve` 起 Gin，`worker` 起 Asynq 消费；MySQL 持久化，Redis 跑队列，GORM 自动迁移。

1. **异步任务骨架（整条流水线基础）**：
   - 13 种 Asynq Task Type（剧本→角色→场景→道具→分镜→帧提示词→帧图→视频→合并）；
   - 队列权重 `critical:6 / default:3 / low:1`，并发 10；
   - **幂等**：`ensureIdempotencyKey`（SHA1(类型+项目+关联+ payload)），复用则不重复投递；
   - **取消**：改 DB 状态 + Worker 轮询自检中断（对长视频轮询关键）。
2. **流水线 9 阶段**（均为独立异步任务，前端按 `task_id` 轮询手动触发下一阶段）：
   - A 剧本生成 → B 角色提取+生图（**定妆照 `avatar_url`**）→ C 场景提取+生图 → D 道具提取+生图 → E 分镜拆分（**强制只引用已有 `characterIds/propIds/sceneId`**）→ F 帧提示词（first/last/key/action/panel）→ G 分镜帧图（first 帧自动设为封面）→ H 视频（参考图一致性 + `referenceMode` 严格管控）→ I 合并（FFmpeg 转场 `xfade/acrossfade`）。
3. **模型集成层（最关键）**：
   - 文本/图像统一抽象 `Provider` 接口（`GenerateScript`/`GenerateImage`），工厂 `NewProvider` 分发 OpenAI/GetGo/Gemini/Doubao/Vertex/ComfyUI（ComfyUI 纯文生图）；
   - 视频统一抽象 `VideoClient`（`GenerateVideo`/`GetTaskStatus` + 函数式选项），工厂分发 Sora/Minimax/Volces(Seedance)/Runway/Pika/Vertex/GetGo；
   - 落盘：Base64 / URL 下载 / mp4 二进制流直落（GetGo）。
4. **一致性机制**：
   - 分镜 `Preload` 角色定妆照 + 道具图作参考；
   - 视频 `referenceMode` 严格管控：`action` 帧升级 `action_sequence`（九宫格物理约束）；多图上限 **4 张**去重；单图/首尾帧模式**强制清空多图参考**防误判 R2V；
   - `projects.style` 贯穿各阶段提示词（画风统一）。
5. **配置即插拔**：所有 worker 先读 `.env` 兜底，再用 `ai_config` 表「激活 + 优先级最高」覆盖 → 在线切换厂商零改码。
6. **REST API**：`/admin/v1`，JWT；流水线触发 + 任务查询/取消 + CRUD + 连通性测试 + 统计 + Swagger。

---

## 四、三项目功能横向对照（按功能域）


| 功能域       | huobao-drama             | LumenX-Studio                         | LingGuo-Drama              |
| --------- | ------------------------ | ------------------------------------- | -------------------------- |
| 剧本改写/抽取   | ✅ Agent+Skill            | ✅ LLM 实体抽取(三级回退)                      | ✅ 异步任务                     |
| 角色/场景/道具  | ✅ 去重合并+关联集               | ✅ 三类+草稿分镜                             | ✅ 提取+生图(定妆照)               |
| 分镜拆解      | ✅ 18字段+video_prompt时间轴   | ✅ 名称匹配回填+prompt_assembly              | ✅ 强制引用已有ID                 |
| 角色一致性     | 定妆照复用+style              | ★ reference_sheet/反向生成/base_character | 定妆照Preload+referenceMode管控 |
| 图片生成      | ✅ Adapter多厂(I2I/轮询)      | ✅ Wan T2I/I2I 多尺寸                     | ✅ Provider抽象(含ComfyUI)     |
| 视频生成      | ✅ Adapter(含Vidu webhook) | ✅ I2V/R2V 多模型+抽卡                      | ✅ VideoClient多厂+参考图管控      |
| 配音 TTS    | ✅ MiniMax/MiMo           | ✅ CosyVoice/Qwen3+克隆                  | （依赖外部/未专设）                 |
| 单镜合成      | ✅ FFmpeg+TTS+字幕          | ✅ 分镜渲染I2I                             | （依赖外部）                     |
| 整集拼接      | ✅ FFmpeg concat          | ✅ FFmpeg concat+BGM                   | ✅ FFmpeg xfade转场           |
| 宫格图       | ✅ 提示词+sharp切分            | （Playground可生成）                       | —                          |
| 图文动画/动态海报 | ✅ zoompan+xfade+BGM      | —                                     | —                          |
| 系列/多集     | （episode关联）              | ★ 跨集资产对账+回顾钩子                         | （episode分层）                |
| 全局资产库     | —                        | ★ 三层可见性+promote                       | —（MySQL表）                  |
| 异步编排      | 后端轮询(无队列)                | BackgroundTasks                       | ★ Asynq队列(13类型+幂等+取消)      |
| 模型接入      | Adapter注册表               | 声明式catalog yaml                       | Provider/VideoClient抽象     |
| 持久化       | SQLite                   | 内存+JSON文件                             | MySQL+Redis                |

★ = 该项目相对最强的差异化能力。

---

## 五、关键实现原理提炼

1. **角色一致性三流派**
   - huobao：**流程纪律** —— 抽取即存库，分镜只能引用已有 ID，定妆照复用。
   - LumenX：**提示词工程 + 模型能力** —— reference_sheet 稳定参考 + 反向生成 I2I 强约束 + 外观关键词注入。
   - LingGuo：**API 调用防御** —— Preload 定妆照作参考图 + referenceMode 严格管控 + 4 图上限。
   - **共性**：都把「角色/场景」当作一等资产先固化，再让下游引用，而非每镜重新生成。这是对抗「抽卡」损耗的第一道闸门。
2. **异步编排三模式**
   - huobao：生成即落库 + fire-and-forget 异步 + 前端轮询（最简单，无队列，单机）。
   - LumenX：FastAPI `BackgroundTasks`（任务状态挂对象上，前端轮询）。
   - LingGuo：**Asynq 生产级队列**（critical/default/low 优先级、并发、幂等、可取消、重试）—— 最接近工业流水线。
3. **模型接入统一抽象（三者共识）**：都用了 Adapter/Provider/Client 工厂模式，把 OpenAI/火山/Gemini/MiniMax/阿里等差异封装在 `buildRequest/parseResponse` 之后，业务层只调 `generate()`。这是「多模型」能力的基石，也是「在线换厂零改码」的关键。
4. **成本 / 抽卡显性化**：三者都在视频环节支持「批量抽卡 + 打分/星标 + 自动选最新/最优」，把抽卡损耗摆在台面上；LumenX 还有预览缓存（md5）降低重复生成成本。

---

## 六、结论与产品建议（补能力清单）

- **huobao** 胜在「最完整可跑通的单线流水线 + 独特宫格图/动态海报 + Skill 可热改」；短板是 SQLite/无队列/**CC BY-NC-SA 商用限制**。
- **LumenX** 胜在「角色一致性工程最深 + 模型广度最大 + 系列/资产库」；短板是无外部 DB（重启丢状态）、Python 工程较重。
- **LingGuo** 胜在「工程化自托管（MIT）+ 异步队列可水平扩展」；短板是社区声量小、缺专职 TTS/合成模块。
- **共同缺口**（与总报告一致）：跨镜连贯仍靠抽卡；长篇事件图谱/角色弧光一致性缺深模块；出海译制/分发闭环不在工具内。
- **产品化建议**：以 **LingGuo（队列底座）+ LumenX（一致性/模型广度）** 组合，补「成本可观测（Token/算力 accounting）」与「出海译制直发」，规避 huobao 的 NC-SA；huobao 作参考/学习或谈授权后引入。

---

### 附：本次读过的核心文件

- **huobao**：`backend/src/agents/{index,skills}.ts`、`skills/*/SKILL.md`、`services/{ai,image-generation,video-generation,tts-generation,grid-split,motion-post,ffmpeg-compose,ffmpeg-merge}.ts`、`services/adapters/registry.ts`、`index.ts`
- **LumenX**：`src/apps/comic_gen/{llm,assets,storyboard,prompt_assembly,audio,export}.py`、`pipeline.py`、`src/models/*`、`config/model_catalog/families/*.yaml`
- **LingGuo**：`server/pkg/{asynq,openai,video,prompt}`、`app/jobs/*`、`app/services/*`、`app/models/async_tasks/*`
