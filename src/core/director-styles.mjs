/* ============================================================================
 * 导演美学档案（Director Styles）· 纯逻辑层，无任何 IO
 *
 * 与 core/director-skills.mjs 的分工：
 *   director-skills.mjs —— 「技能」= 制片策略（步骤范围 / 交付物 / 附加能力）
 *   director-styles.mjs —— 「风格」= 视听参数（调色板 / 光线 / 构图 / 运镜 / 否定词）
 *
 * 风格不是界面文案：resolveAesthetic / aestheticPrompt / aestheticTreatment
 * 的输出会被导演智能体、Provider 与分镜智能体真实消费——
 *   ① 导演阐述：零 Key 时用风格基线，不再走通用模板
 *   ② 出图提示词：正向追加 stylePrompt，负向追加 negativePrompt
 *   ③ Mock 出图：按 svg 调色板绘制，选不同导演画面就真的不同
 *   ④ 分镜提示：ffDesc 注入主色调、媒介与构图关键词
 *
 * 十份完整可执行档案见 docs/导演技能/，本文件是它们的结构化投影。
 * ==========================================================================*/

/** 十位导演的完整美学档案（顺序即工作台展示顺序） */
export const DIRECTOR_STYLES = [
  {
    id: 'zhangyimou', icon: '🀄', label: '大风国色 · 张艺谋',
    workTitle: '大风国色', director: '张艺谋',
    tagline: '色彩统治 · 仪式化长镜',
    summary: '以主色调的画面统治力与视觉仪式感为基准：主色占画面 ≥ 65%，非主色一律降饱和或水墨化；固定长镜承载仪式，升格只给关键动作。专治国风武侠、历史史诗与国潮广告的画面廉价感。',
    palettes: [
      { key: 'hero-red', name: '英雄红', hex: '#C81D25', mood: '热烈 / 宿命' },
      { key: 'ink-black', name: '影墨黑', hex: '#12100F', mood: '水墨 / 隐忍' },
      { key: 'bamboo-green', name: '竹林绿', hex: '#2F4F3A', mood: '清冷 / 杀机' },
      { key: 'desert-yellow', name: '大漠黄', hex: '#C89A4B', mood: '风沙 / 生命力' },
    ],
    defaultPalette: 'hero-red',
    colorRule: '主色调占画面 65% 以上，辅色降饱和至 20% 以下或转水墨灰阶',
    light: '大侧光与强逆光为主，光源单一且方向明确；正午高反差、黄昏长影用于情绪高点',
    composition: '强对称（中轴 / 门洞 / 廊柱）与大面积留白交替，人物常置于三分之一并被建筑线条压迫',
    camera: '固定长镜承载仪式，升格慢动作只给落刃、转身、衣袂扬起',
    texture: '布料纤维、甲胄锈迹、汗珠、尘土颗粒可见，加轻微胶片颗粒，拒绝塑料皮肤',
    taboos: ['大平光', '柔光美颜', '多彩杂色', '现代推拉变焦 / 翻页 / 缩放转场'],
    medium: ['飞扬狂风', '砸落暴雨', '弥漫风沙', '静谧飞雪'],
    pace: { minShotSec: 6, maxShotSec: 12, fixedShotRatio: 0.7, mode: 'slow' },
    tone: '宿命感与克制的悲壮，情绪在画面里accumulate而非台词里说明',
    visualStyle: '主色调统治式国风美学：单一高饱和主色占画面 65% 以上，辅色水墨化；大侧光与强逆光塑造体积，胶片颗粒保留真实皮肤纹理',
    pacing: '单镜 6–12 秒的仪式感长镜，固定机位占比 ≥ 70%；情绪靠构图与光线累积，不靠切碎镜头',
    shotStrategy: '先以大全景用建筑线条压迫人物，再以中景给仪式动作，特写只留给手、眼与兵器；全程强对称或框架构图',
    audioStrategy: '环境声放大自然媒介（风、雨、沙、雪），人声压低留白；转场保留连续底噪',
    continuityRules: [
      '主色调跨镜头保持同一色号与占比，禁止中途换主色',
      '角色服装材质与配色以身份板为唯一基准，不做镜头级微调',
      '同一场戏光源方向固定，明暗对比层级不跳变',
      '自然媒介（风 / 雨 / 雪 / 沙）方向与强度在连戏分组内保持一致',
    ],
    risks: ['主色被模型稀释成杂色：提示词前置色号并加大权重', '仪式长镜生成后动作漂移：以首尾帧锁定姿态'],
    stylePrompt: '国风电影感，英雄红主色调统治画面，大侧光强逆光，强对称构图，胶片颗粒，布料与甲胄真实质感，仪式化长镜',
    negativePrompt: 'washed-out colors, low contrast flat lighting, beauty filter, plastic skin, oversaturated rainbow palette, modern zoom transition, text watermark',
    svg: { sky: ['#1C0E0E', '#5A1418', '#C81D25'], ground: '#0F0C0B', fog: '#E8D9C0', accent: '#F0B429', text: '#FFF6E8' },
    highlights: ['主色统治 ≥65%', '仪式长镜 ≥70%', '大侧光逆光', '胶片颗粒'],
  },
  {
    id: 'wongkarwai', icon: '🚬', label: '花样年华 · 王家卫',
    workTitle: '花样年华', director: '王家卫',
    tagline: '都市暧昧 · 时间错位',
    summary: '以单一实用光源与大面积暗部制造暧昧：霓虹、雨滴、烟雾与玻璃反射是质感来源；手持微晃、慢门拖影与抽帧降格让情绪溢出画面。适合都市情感、民国上海与品牌情绪片。',
    palettes: [
      { key: 'neon-amber', name: '霓虹琥珀', hex: '#D99A3C', mood: '暖昧 / 怀旧' },
      { key: 'qipao-green', name: '旗袍绿', hex: '#1F3B33', mood: '克制 / 压抑' },
      { key: 'rain-teal', name: '夜雨青', hex: '#1B2A38', mood: '疏离 / 潮湿' },
      { key: 'faded-sepia', name: '旧照褐', hex: '#8A6B52', mood: '记忆 / 褪色' },
    ],
    defaultPalette: 'neon-amber',
    colorRule: '单一暖色统治 + 一点高饱和点缀（洋红 / 翠绿），暗部保留细节但不提亮',
    light: '单一实用光源（招牌、台灯、车灯），强反差，允许光斑与眩光',
    composition: '框架构图（门框 / 车窗 / 镜子 / 帘子）、人物偏置、前景遮挡制造窥视感',
    camera: '手持微晃、慢门拖影、抽帧降格、同镜重复',
    texture: '颗粒、雨滴、烟雾、玻璃反射、胶片褪色',
    taboos: ['均匀棚拍光', '干净商业感', '完美对称', '顺滑推拉转场'],
    medium: ['细密雨丝', '缭绕烟雾', '霓虹光斑', '玻璃水汽'],
    pace: { minShotSec: 3, maxShotSec: 6, fixedShotRatio: 0.3, mode: 'fragment' },
    tone: '欲言又止的暧昧与错位感，情绪靠停顿与错身而非台词',
    visualStyle: '霓虹暗部与单一实用光源的都市电影感：大面积暗部 + 高饱和单色点缀 + 慢门拖影 + 胶片颗粒',
    pacing: '单镜 3–6 秒的碎片叙事，允许抽帧降格、同镜重复与跳切；情绪靠节奏断层累积',
    shotStrategy: '多用框架构图与前景遮挡，人物偏置；中近景给眼神与手部，特写只给道具（烟、杯、口红）',
    audioStrategy: '环境音以雨声、空调低频与远处爵士乐为主；BGM 权重高，循环感强、情绪克制',
    continuityRules: [
      '同一角色的服装套数与发型在连戏分组内固定',
      '烟 / 酒 / 口红等标志物状态跨镜连续，作为时间推进的显式证据',
      '光源色温与位置不变，暗部亮度不因切镜提亮',
      '雨伞开合、时钟读数在连续场景内一致',
    ],
    risks: ['画面被模型提亮失去暧昧感：加大暗部权重并追加否定词', '抽帧被平均成正常帧率：在运动描述里写明降格'],
    stylePrompt: '都市暧昧电影感，单一实用光源，大面积暗部，霓虹光斑与玻璃反射，烟雾与细雨，慢门拖影，胶片颗粒',
    negativePrompt: 'flat studio lighting, clean commercial look, symmetrical composition, smooth zoom transition, oversharpened, plastic skin, bright even exposure',
    svg: { sky: ['#1A1208', '#8A5A1E', '#D99A3C'], ground: '#120C07', fog: '#E8C9A0', accent: '#B23A6B', text: '#F5E6D0' },
    highlights: ['单一实用光源', '大面积暗部', '抽帧拖影', '框架构图'],
  },
  {
    id: 'ang-lee', icon: '🪷', label: '藏锋 · 李安',
    workTitle: '藏锋', director: '李安',
    tagline: '东方克制 · 水面张力',
    summary: '以低饱和自然光与固定长镜承载"水面下的张力"：人物用最小可行动作表达情绪，画面靠礼仪空间与器物细节说话。适合家庭伦理、武侠留白与跨文化题材。',
    palettes: [
      { key: 'quiet-grey', name: '素雅青灰', hex: '#8A9A9E', mood: '克制 / 日常' },
      { key: 'bamboo-ink', name: '竹林墨绿', hex: '#3C5144', mood: '隐忍 / 江湖' },
      { key: 'feast-brown', name: '家宴暖褐', hex: '#A9714B', mood: '团圆 / 裂痕' },
      { key: 'snow-white', name: '雪山冷白', hex: '#DDE3E4', mood: '孤绝 / 澄明' },
    ],
    defaultPalette: 'quiet-grey',
    colorRule: '低饱和自然色温，靠光线层次而非色块制造情绪；肤色真实不做美颜',
    light: '自然窗光与天井光，方向明确但柔和；室内灯只作补光',
    composition: '对称、稳定、留白；人物与器物并置，强调空间里的"礼"',
    camera: '固定长镜、极缓慢横移；几乎不用变焦',
    texture: '真实肤色（毛孔 / 疲惫）、织物褶皱、器物釉面与水渍',
    taboos: ['高饱和', '糖水美颜', '炫技运镜', '夸张表演', '文化符号堆砌'],
    medium: ['薄雾', '微风', '落叶', '檐下雨滴'],
    pace: { minShotSec: 6, maxShotSec: 10, fixedShotRatio: 0.7, mode: 'slow' },
    tone: '克制内敛、情绪压在礼貌之下，爆发只在最小动作里泄露',
    visualStyle: '低饱和自然光东方美学：素雅青灰基调，自然窗光塑形，器物与织物细节可辨，真实肤色不做美颜',
    pacing: '单镜 6–10 秒静观长镜，固定机位 ≥ 70%；情绪转折在一镜内完成，不靠切碎',
    shotStrategy: '中景与全景为主，对称构图承载礼仪关系；特写只给手部动作与器物，视线不轻易给满',
    audioStrategy: '环境音以室内细节为主（碗筷轻碰、布料摩擦、远处水声）；BGM 极简或留白',
    continuityRules: [
      '同一场家宴的坐次、菜色推进与服饰层级严格连续',
      '角色服饰层级（里衣 / 外袍 / 配饰）不跨镜更换',
      '自然光源方向与时段固定，不出现无来源补光',
      '关键道具（剑是否出鞘、书信是否拆封）状态显式记录',
    ],
    risks: ['克制被模型演成呆滞：用最小可行动作替代静止', '低饱和被压成灰雾：靠光比不靠饱和度找层次'],
    stylePrompt: '东方克制电影感，低饱和自然光，自然窗光方向明确，对称留白构图，织物褶皱与器物釉面细节，真实肤色毛孔，柔和层次',
    negativePrompt: 'high saturation, beauty filter, exaggerated acting, theatrical gesture, flashy camera move, plastic skin, oversharpened, flat grey haze',
    svg: { sky: ['#8FA0A4', '#B9C6C6', '#EDE6D8'], ground: '#5A6B62', fog: '#F2EFE6', accent: '#7A8C7E', text: '#2A3230' },
    highlights: ['低饱和自然光', '固定静观长镜', '对称礼仪构图', '器物细节'],
  },
  {
    id: 'hou-hsiao-hsien', icon: '🌾', label: '静观 · 侯孝贤',
    workTitle: '静观', director: '侯孝贤',
    tagline: '固定长镜 · 时间自己说话',
    summary: '以极慢固定长镜与环境全貌让时间自己说话：大景别、人物偏置、自然光时段变化；不喂情绪、不切碎空间。适合乡土记忆、成长叙事与散文电影。',
    palettes: [
      { key: 'distant-hill', name: '远山青', hex: '#6E8577', mood: '辽远 / 平静' },
      { key: 'paddy-green', name: '稻田黄绿', hex: '#A7B05B', mood: '生长 / 生计' },
      { key: 'old-house', name: '老屋褐', hex: '#8A6B52', mood: '旧日 / 家常' },
      { key: 'lamp-orange', name: '夜灯橙', hex: '#D98F45', mood: '归家 / 守候' },
    ],
    defaultPalette: 'distant-hill',
    colorRule: '低饱和自然色，光影随时段变化而非靠色块；保留高光溢出与水汽感',
    light: '自然光为主（窗光、天光、夕照），保留高光溢出与水汽感',
    composition: '大景别、人物偏置、留出环境；纵深用田埂 / 廊道 / 山道引导',
    camera: '固定长镜；极缓后拉或横移；不用变焦',
    texture: '生活器物、旧墙斑驳、汗湿衣领、灰尘与阳光颗粒',
    taboos: ['快速剪辑', '花式转场', '舞台化表演', '过度特写', '糖水调色'],
    medium: ['微风树影', '扬尘', '薄雾', '檐下光影'],
    pace: { minShotSec: 8, maxShotSec: 12, fixedShotRatio: 0.8, mode: 'slow' },
    tone: '淡然的生活流，情绪藏在日常动作与空间里，不做解释',
    visualStyle: '低饱和自然光散文电影感：大景别环境全貌，人物偏置留白，自然光时段变化，旧墙与器物细节，灰尘与阳光颗粒',
    pacing: '单镜 8–12 秒极慢长镜，固定机位 ≥ 80%；允许一镜内完成时间跨越',
    shotStrategy: '全景与远景为主建立空间，中景偶尔靠近；特写极少，接近也保持环境在画面里',
    audioStrategy: '环境音为主（蝉鸣、远处火车、风扇转动、碗筷声）；BGM 可省略或只用环境化弦乐',
    continuityRules: [
      '同一段路程的光线时段按叙事顺序推进，不来回跳',
      '人物在画面中的相对位置与走动方向连续',
      '载具与道具（单车、碗、票）状态跨镜一致',
      '固定机位的机位高度与焦段在同一场景内不变',
    ],
    risks: ['长镜被切碎：明确要求固定机位与镜内叙事', '低饱和变成灰暗：保留高光与水汽感'],
    stylePrompt: '散文电影感，大景别环境全貌，人物偏置留白，自然光时段明确，低饱和自然色，旧墙斑驳与生活器物细节，阳光颗粒',
    negativePrompt: 'fast cutting, flashy transition, dramatic staging, theatrical performance, oversaturated, beauty filter, tight closeup montage, crushed shadows',
    svg: { sky: ['#A8BBAE', '#C9D3C0', '#E4E1D6'], ground: '#6E8577', fog: '#EDEFE6', accent: '#A7B05B', text: '#28302A' },
    highlights: ['固定长镜 ≥80%', '大景别留白', '自然光时段', '生活器物质感'],
  },
  {
    id: 'tsui-hark', icon: '⚔️', label: '御剑 · 徐克',
    workTitle: '御剑', director: '徐克',
    tagline: '高动能武侠 · 奇诡奇观',
    summary: '以有来源的强光（月华、符火、剑光）与高动能运镜制造奇观：衣袂、水花、碎冰、火星是动态质感核心；打斗必须有空间逻辑与连贯运动方向。适合武侠奇幻、江湖对决与游戏 CG。',
    palettes: [
      { key: 'frost-blue', name: '玄冰蓝', hex: '#1F3B5C', mood: '冷月 / 剑光' },
      { key: 'blaze-orange', name: '烈火橙', hex: '#E2571F', mood: '爆发 / 炽烈' },
      { key: 'demon-purple', name: '妖紫', hex: '#6B3E86', mood: '诡秘 / 妖异' },
      { key: 'blood-ink', name: '血墨红', hex: '#8E1F22', mood: '杀伐 / 惨烈' },
    ],
    defaultPalette: 'frost-blue',
    colorRule: '双色对比（冷月 / 烈火），光效高亮但不泛白，暗部保留色相',
    light: '有明确来源的强光（月华、符火、水波反射、剑光），允许逆光剪影',
    composition: '对角线动势、前后景分层（前景衣袂 / 中景交锋 / 远景奇观），决斗轴线明确',
    camera: '高速跟拍、甩镜、升格、俯冲；运动方向必须连贯',
    texture: '衣袂、水花、碎冰、火星、金属反光；允许 motion blur',
    taboos: ['软绵绵动作', '糊成团的粒子', '无来源光晕', '贴图感特效'],
    medium: ['剑风激起的狂风', '水雾与碎冰', '符火火星', '崖顶流云'],
    pace: { minShotSec: 3, maxShotSec: 6, fixedShotRatio: 0.3, mode: 'kinetic' },
    tone: '凌厉而带悲怆的江湖气，胜负之外还有不甘',
    visualStyle: '高动能武侠奇观：有来源的强光（月华 / 符火 / 剑光），双色对比，动态质感（衣袂 / 水花 / 火星）清晰，允许 motion blur',
    pacing: '单镜 3–6 秒张力推进，对决高潮压缩到 2–4 秒；升格只给决定胜负的一击',
    shotStrategy: '全景交代空间与站位，中近景给交锋与兵器相交点，特写给眼神与兵器；对角线构图保持动势',
    audioStrategy: '环境音（风声、金属摩擦、脚步落地）+ BGM 鼓点与弦乐，重音与出招同步',
    continuityRules: [
      '同一场对决双方站位与朝向连续，不越轴',
      '兵器是否出鞘 / 脱手、缺口位置跨镜一致',
      '地形破坏程度随交锋累积，不回退',
      '运动方向与速度在连戏分组内连贯',
    ],
    risks: ['动作软而失重：写明重心、落地扬尘与反作用力', '粒子糊成一片：要求光效有形状（剑光成线、符火成环）'],
    stylePrompt: '武侠奇观电影感，有来源的强光（月华 / 符火 / 剑光），双色高对比，衣袂水花火星动态质感，对角线动势，motion blur',
    negativePrompt: 'stiff motion, weightless fighting, mushy particle effect, random glow, flat lighting, plastic armor, static pose',
    svg: { sky: ['#0C1A28', '#1F3B5C', '#4A7A9E'], ground: '#0A1219', fog: '#9FC4D8', accent: '#5FD3E8', text: '#E6F3FA' },
    highlights: ['有来源强光', '高动能运镜', '兵器空间逻辑', '动态质感'],
  },
  {
    id: 'king-hu', icon: '🏯', label: '山水侠意 · 胡金铨',
    workTitle: '山水侠意', director: '胡金铨',
    tagline: '客栈空间 · 慢起骤急',
    summary: '以客栈空间结构与戏曲韵律构建武侠：场景板先锁定楼层、门洞与楼梯位置；铺垫用长镜、爆发用 1–2 秒短切，形成强烈节奏落差。适合古典武侠、客栈对峙与禅意山水。',
    palettes: [
      { key: 'ink-grey', name: '水墨灰', hex: '#6B6F72', mood: '古意 / 沉静' },
      { key: 'temple-ochre', name: '古寺赭', hex: '#8C5A3C', mood: '香火 / 岁月' },
      { key: 'pine-ink', name: '松林墨绿', hex: '#38473C', mood: '幽深 / 隐逸' },
      { key: 'dusk-gold', name: '暮色金', hex: '#C0913F', mood: '苍茫 / 收束' },
    ],
    defaultPalette: 'ink-grey',
    colorRule: '灰调为主，灯笼暖光与月光冷光双色对比；服饰纹样清晰但不花哨',
    light: '灯笼暖光作点光、月光作环境光、雾气散射；明暗层次分明',
    composition: '框架构图（门洞 / 窗格 / 楼梯）、对称对峙、留白与雾气填充',
    camera: '固定机位、精准横移、爆发段快速剪切',
    texture: '木纹与榫卯、旧漆、织纹、雾气颗粒',
    taboos: ['现代服饰感', '匀速节奏', '棚拍平光', '无韵律打斗'],
    medium: ['雾气', '灯笼光晕', '尘烟', '山风'],
    pace: { minShotSec: 1, maxShotSec: 10, fixedShotRatio: 0.6, mode: 'contrast' },
    tone: '古意沉静中藏着杀机，节奏落差本身就是叙事',
    visualStyle: '水墨灰调古典武侠：灯笼暖光与月光冷光对比，木构与榫卯质感可辨，雾气散射，框架构图',
    pacing: '铺垫段单镜 6–10 秒长镜，爆发段 1–2 秒短切；节奏落差（慢起骤急）是本风格的核心',
    shotStrategy: '框架构图（门洞 / 楼梯 / 窗格）交代空间，对称构图给对峙；爆发段用精准的短切与动作衔接',
    audioStrategy: '环境音（木门吱呀、脚步、雾中虫鸣）+ BGM 锣鼓与梆子，重音落在动作启动瞬间',
    continuityRules: [
      '客栈平面结构（楼层 / 门洞 / 楼梯）跨镜严格一致',
      '灯笼是否点亮、桌椅位移在连戏分组内连续',
      '兵器是否在手、服饰纹样不跨镜更换',
      '爆发段的剪辑点必须落在动作启动瞬间',
    ],
    risks: ['节奏被平均化：显式指定铺垫 / 爆发两段时长', '空间混乱：以场景板的结构重写机位与门洞朝向'],
    stylePrompt: '古典武侠电影感，水墨灰调，灯笼暖光与月光冷光双色对比，木构榫卯与旧漆质感，雾气散射，框架构图',
    negativePrompt: 'modern costume, even pacing, studio flat lighting, rhythmless fighting, oversaturated color, plastic texture, clean digital look',
    svg: { sky: ['#2A2E31', '#5A6064', '#8A8F92'], ground: '#1E2224', fog: '#C9C4B8', accent: '#C87941', text: '#EDE8DC' },
    highlights: ['慢起骤急节奏', '客栈空间锁定', '灯笼月光对比', '框架构图'],
  },
  {
    id: 'chen-kaige', icon: '🎭', label: '史诗寓言 · 陈凯歌',
    workTitle: '史诗寓言', director: '陈凯歌',
    tagline: '舞台化史诗 · 构图叙事',
    summary: '以舞台化光源（顶光、追光、烛阵）与重色块构建史诗感，但必须有真实材质支撑（丝绸反光、甲胄锈迹、雪地颗粒）。构图本身承担矛盾：权力高低用机位与体量对比。适合历史史诗、戏曲题材与寓言叙事。',
    palettes: [
      { key: 'court-crimson', name: '宫廷绛', hex: '#7A1E28', mood: '权力 / 压抑' },
      { key: 'stage-gold', name: '戏台金', hex: '#D9A441', mood: '华彩 / 虚妄' },
      { key: 'wasteland-brown', name: '荒原褐', hex: '#8B6B4A', mood: '流放 / 苍凉' },
      { key: 'snownight-blue', name: '雪夜蓝', hex: '#2C3746', mood: '孤绝 / 彻悟' },
    ],
    defaultPalette: 'court-crimson',
    colorRule: '重色块 + 单点高光（金、烛、血色），非主色压暗以突出体量',
    light: '舞台化光源（顶光、追光、烛阵）+ 真实大气散射，形成双重层次',
    composition: '强轴线、体量对比、留白；画面本身讲述权力与孤独',
    camera: '仪式化固定、缓慢升降、长镜跟随队列',
    texture: '丝绸反光、甲胄锈迹、雪地颗粒、烛烟',
    taboos: ['舞台布景感', '纸板道具', '解说式台词', '炫技转场'],
    medium: ['落雪', '烛烟', '风沙', '仪仗扬尘'],
    pace: { minShotSec: 6, maxShotSec: 12, fixedShotRatio: 0.6, mode: 'ritual' },
    tone: '宿命般的悲怆与孤高，个体被时代与仪式碾压',
    visualStyle: '舞台化史诗电影感，重色块与单点高光，顶光 / 追光 / 烛阵塑形，丝绸与锈甲真实材质，强轴线体量对比',
    pacing: '慢节奏仪式段落单镜 6–12 秒，与中节奏 4–8 秒交替；结尾用静止画面收束',
    shotStrategy: '远景给场面与队列，中景给人物关系与体量对比，特写给妆面与手；构图必须承担叙事矛盾',
    audioStrategy: '环境音（风、雪、脚步、鼓）+ BGM 戏曲锣鼓或交响，强调宿命感',
    continuityRules: [
      '同一场仪式的队列位置与朝向连续',
      '妆面是否已卸、戏服层数不跨镜改变',
      '道具（剑、琵琶、面具）状态显式记录',
      '光源布置（烛阵 / 顶光 / 追光）在同一场戏内固定',
    ],
    risks: ['舞台感过强变成布景：补真实材质与空气感', '宏大但内核空：用构图承担矛盾而非台词'],
    stylePrompt: '史诗电影感，重色块与单点高光，舞台化顶光与烛阵，真实丝绸反光与甲胄锈迹，强轴线体量对比构图，雪粒与烛烟',
    negativePrompt: 'theatrical backdrop, painted set, cardboard props, flat lighting, oversaturated rainbow, plastic texture, empty spectacle',
    svg: { sky: ['#2A0A0E', '#5E1620', '#8E2A32'], ground: '#1A0E10', fog: '#D9B46A', accent: '#C9A227', text: '#F7EAD5' },
    highlights: ['舞台化光源', '体量对比构图', '真实材质支撑', '仪式段落'],
  },
  {
    id: 'kurosawa', icon: '🌧️', label: '风雨史诗 · 黑泽明',
    workTitle: '风雨史诗', director: '黑泽明',
    tagline: '天气叙事 · 群像动势',
    summary: '以高强度天气（暴雨、尘暴、雪）作为叙事主体，配合三层纵深与长焦压缩调度群像：动作方向必须明确可读，群戏一次只让一个动作成为视觉主体。适合历史战争、武士题材与群像史诗。',
    palettes: [
      { key: 'storm-grey', name: '暴雨灰', hex: '#5A6068', mood: '肃杀 / 天威' },
      { key: 'flame-red', name: '烈焰红', hex: '#B83227', mood: '战火 / 血性' },
      { key: 'mud-brown', name: '泥泞褐', hex: '#6B5842', mood: '苦战 / 消耗' },
      { key: 'snow-white', name: '雪原白', hex: '#DCE0E2', mood: '终结 / 澄净' },
    ],
    defaultPalette: 'storm-grey',
    colorRule: '低饱和灰基 + 单点高饱和（血、火、旗），对比强烈',
    light: '阴天散射光 + 逆光雨幕 + 火把点光；允许大面积剪影',
    composition: '三层纵深（前 / 中 / 远）、对角线动势、群像三角站位、长焦压缩',
    camera: '动态跟拍、横移、长焦压缩、多机位覆盖同一动作',
    texture: '雨柱、泥浆飞溅、甲胄反光、尘土、旗面湿重',
    taboos: ['模糊动作', '动作方向不明', '天气仅作背景', '扁平群戏'],
    medium: ['暴雨砸落', '狂风尘暴', '飞雪', '泥浆飞溅'],
    pace: { minShotSec: 2, maxShotSec: 8, fixedShotRatio: 0.35, mode: 'kinetic' },
    tone: '悍勇与天威并置，人在天气里被压小但仍然向前',
    visualStyle: '史诗战争电影感，低饱和灰基加单点高饱和，阴天散射与逆光雨幕，三层纵深群像构图，甲胄与旗面湿重质感',
    pacing: '中节奏单镜 4–8 秒，群戏压缩到 2–4 秒；以动作方向与视线引导剪辑',
    shotStrategy: '远景给阵型与天气，中景给交锋，特写给身体、武器与雨水；长焦压缩保持群像密度',
    audioStrategy: '环境音（雨、马蹄、金属撞击）+ BGM 太鼓与低音弦乐',
    continuityRules: [
      '阵型位置、旗号方向与运动方向跨镜连续',
      '兵器状态与甲片缺失位置一致',
      '雨势与地面泥泞程度随时间累积，不回退',
      '同一动作的多次覆盖必须保持动作逻辑一致',
    ],
    risks: ['动作看不清：写明重心与反作用力、加入泥浆飞溅', '群戏混乱：先锁阵型图，一次只让一个动作成为主体'],
    stylePrompt: '战争史诗电影感，高层级天气（暴雨 / 尘暴）作为主体，三层纵深群像构图，阴天散射与逆光雨幕，甲胄与旗面湿重，泥浆飞溅',
    negativePrompt: 'blurry action, unclear motion direction, flat group staging, weak weather, oversaturated color, plastic armor, clean dry ground',
    svg: { sky: ['#2A2F33', '#4E555B', '#767E85'], ground: '#3A3228', fog: '#B9BFC4', accent: '#B83227', text: '#EDEFF1' },
    highlights: ['天气参与叙事', '三层纵深群像', '动作方向可读', '单点高饱和'],
  },
  {
    id: 'miyazaki', icon: '🌿', label: '自然童话 · 宫崎骏',
    workTitle: '自然童话', director: '宫崎骏',
    tagline: '手绘清透 · 飞行浪漫',
    summary: '以手绘动画的清透色彩与"活着的自然"为基准：云在移动、草在摇、光斑在变；飞行必须有高度、风向与机身倾斜。人物保留生活细节（汗、脏手、卷起袖子）。适合奇幻动画与治愈系短片。',
    palettes: [
      { key: 'sky-cyan', name: '晴空青', hex: '#7FB6D9', mood: '开阔 / 自由' },
      { key: 'forest-green', name: '森林绿', hex: '#3E6B4F', mood: '生机 / 庇护' },
      { key: 'dusk-orange', name: '黄昏橙', hex: '#E4A15C', mood: '温暖 / 归途' },
      { key: 'rain-grey', name: '雨雾灰', hex: '#9FAFB8', mood: '静谧 / 等待' },
    ],
    defaultPalette: 'sky-cyan',
    colorRule: '清透高明度，阴影带蓝紫而非纯灰；饱和但不刺眼',
    light: '阳光穿透树叶的斑驳光、黄昏逆光、云层散射',
    composition: '大景别环境 + 人物偏置、天空占画面 1/3 以上、纵深用景深层次',
    camera: '固定全景、缓移、飞行跟拍、缓慢拉远',
    texture: '手绘水彩边缘、纸质颗粒、植被细节、机械旧化',
    taboos: ['糖果色', '塑料 3D 感', '过曝', '无细节的自然贴图'],
    medium: ['穿林斑驳光', '流云', '草叶摇动', '细雨'],
    pace: { minShotSec: 3, maxShotSec: 8, fixedShotRatio: 0.5, mode: 'breath' },
    tone: '温柔而坚定的成长感，世界很大但值得起飞',
    visualStyle: '手绘动画电影感，清透明度高饱和但不刺眼，阳光穿透树叶的斑驳光，水彩边缘与纸质颗粒，活的自然（云移 / 草摇 / 光斑变）',
    pacing: '慢节奏生活流单镜 5–8 秒，冒险段 3–6 秒；以呼吸节奏剪辑，允许一镜完成起飞或降落',
    shotStrategy: '大景别环境占画面主体，人物偏置；中景给人物关系，特写给手、道具与机械细节',
    audioStrategy: '环境音（风声、鸟鸣、机械声、水声）+ BGM 钢琴与管弦，旋律性强',
    continuityRules: [
      '飞行器状态（螺旋桨转速、高度、倾斜角）跨镜连续',
      '角色服装与随身道具（背包、帽子）不跨镜更换',
      '同一场景的光线时段与植被状态一致',
      '自然动态元素（云 / 风 / 光斑）方向在连戏分组内连贯',
    ],
    risks: ['画面发甜：降粉、加环境脏污与旧化', '飞行失重：写明高度、风向与机身倾斜'],
    stylePrompt: '手绘动画电影感，清透高明度色彩，阳光穿透树叶的斑驳光，水彩边缘与纸质颗粒，活的自然（流云草摇光斑），植被与机械旧化细节',
    negativePrompt: 'candy colors, plastic 3D render, overexposed, flat cartoon shading, oversaturated pink, no texture background, sterile clean look',
    svg: { sky: ['#7FB6D9', '#A9D2EA', '#DCEEF7'], ground: '#6E9147', fog: '#EAF3F7', accent: '#E4A15C', text: '#20303A' },
    highlights: ['手绘质感', '活的自然', '飞行重量感', '生活细节'],
  },
  {
    id: 'kitano', icon: '🌊', label: '静默暴烈 · 北野武',
    workTitle: '静默暴烈', director: '北野武',
    tagline: '极简构图 · 静默暴力',
    summary: '以正面平视、居中对称与极简背景制造冷感：长时间静止后突然硬切爆发，暴力简短、不美化、常发生在画面外。适合黑帮题材、犯罪悬疑与极简叙事短片。',
    palettes: [
      { key: 'cold-greyblue', name: '冷灰蓝', hex: '#5C6B78', mood: '冷静 / 疏离' },
      { key: 'night-black', name: '夜黑', hex: '#131518', mood: '沉默 / 压抑' },
      { key: 'seaside-teal', name: '海边青', hex: '#5E8A8C', mood: '空旷 / 终局' },
      { key: 'blood-red', name: '血红', hex: '#8E2226', mood: '突发 / 代价' },
    ],
    defaultPalette: 'cold-greyblue',
    colorRule: '低饱和冷调、背景干净、单点红（血）极少量',
    light: '有方向的平淡侧光；不打戏剧光，不铺柔光',
    composition: '正面平视、居中对称、极简背景、大量留白（空的空间）',
    camera: '固定机位；突然静止；不做运动镜头',
    texture: '真实西装面料、皮肤纹理、海风与热浪的空气感',
    taboos: ['暴力美化', '慢镜英雄化', '花式转场', '做作表演'],
    medium: ['海风', '热浪扭曲', '夜雨', '空旷回声'],
    pace: { minShotSec: 0.5, maxShotSec: 12, fixedShotRatio: 0.85, mode: 'silence-burst' },
    tone: '冷到极致的压抑，爆发短促且没有快感',
    visualStyle: '极简冷调电影感，正面平视居中构图，极简干净背景，有方向的平淡侧光，真实西装面料与皮肤纹理，空气感（海风 / 热浪）',
    pacing: '极慢静默单镜 8–12 秒几乎不动，爆发段 0.5–2 秒硬切；禁止渐变与叠化',
    shotStrategy: '中景正面、全身居中、极简背景；爆发在画面外或极短呈现，不延展不美化',
    audioStrategy: '环境音（海浪、引擎、脚步、静默）+ BGM 可缺失或极简（单音、鼓点）',
    continuityRules: [
      '同一场对峙双方站位与朝向连续，居中构图不被打破',
      '枪械弹数与伤痕位置跨镜一致',
      '车辆位置与车门开合角度连续',
      '爆发后的血迹方向与弹壳位置可追溯',
    ],
    risks: ['暴力被美化：去掉慢镜与英雄光效，改为画面外', '沉默变呆滞：给角色明确的内心动作'],
    stylePrompt: '极简冷调电影感，正面平视居中构图，背景极简干净，有方向的平淡侧光，低饱和冷色，真实西装与皮肤纹理，空气感海风',
    negativePrompt: 'slow motion violence, heroic pose, glamorized blood, dramatic lighting, flashy transition, oversaturated color, busy background',
    svg: { sky: ['#3E4A55', '#5C6B78', '#8A98A4'], ground: '#242A30', fog: '#C6CED5', accent: '#B23A47', text: '#E8EDF1' },
    highlights: ['极简居中构图', '静默→爆发节奏', '暴力不美化', '干净背景'],
  },
];

export const STYLE_BY_ID = Object.fromEntries(DIRECTOR_STYLES.map((s) => [s.id, s]));

/**
 * 常见别名 → 规范 id（中文名 / 英文写法 / 片名意象 / 旧数据都能落到同一份档案）。
 * 查询时先做「小写 + 去空格与连字符」归一，因此 `ANG LEE`、`ang-lee`、`angLee` 同一结果。
 */
const STYLE_ALIASES = {
  zhang: 'zhangyimou', zhangyimou: 'zhangyimou', yimou: 'zhangyimou',
  '张艺谋': 'zhangyimou', '大风国色': 'zhangyimou', '英雄红': 'zhangyimou',
  wkw: 'wongkarwai', wong: 'wongkarwai', wongkarwai: 'wongkarwai', karwai: 'wongkarwai',
  '王家卫': 'wongkarwai', '花样年华': 'wongkarwai',
  anglee: 'ang-lee', lee: 'ang-lee', '李安': 'ang-lee', '藏锋': 'ang-lee',
  hou: 'hou-hsiao-hsien', hsiao: 'hou-hsiao-hsien', housiaohsien: 'hou-hsiao-hsien',
  '侯孝贤': 'hou-hsiao-hsien', '静观': 'hou-hsiao-hsien',
  tsui: 'tsui-hark', tsuiHark: 'tsui-hark', '徐克': 'tsui-hark', '御剑': 'tsui-hark',
  kinghu: 'king-hu', hu: 'king-hu', '胡金铨': 'king-hu', '山水侠意': 'king-hu',
  chen: 'chen-kaige', kaige: 'chen-kaige', '陈凯歌': 'chen-kaige', '史诗寓言': 'chen-kaige',
  kurosawa: 'kurosawa', '黑泽明': 'kurosawa', '风雨史诗': 'kurosawa',
  miyazaki: 'miyazaki', haya: 'miyazaki', '宫崎骏': 'miyazaki', '自然童话': 'miyazaki',
  kitano: 'kitano', takeshi: 'kitano', '北野武': 'kitano', '静默暴烈': 'kitano',
};

/** 归一化键：小写、去空格 / 下划线 / 连字符，让各种写法先收敛再查表 */
function styleKey(v) {
  return String(v ?? '').trim().toLowerCase().replace(/[\s_\-·．.]+/g, '');
}

const ALIAS_BY_KEY = Object.fromEntries(
  Object.entries(STYLE_ALIASES).map(([k, v]) => [styleKey(k), v]),
);
const ID_BY_KEY = Object.fromEntries(
  DIRECTOR_STYLES.map((s) => [styleKey(s.id), s.id]),
);

export function normalizeStyleId(id) {
  const raw = String(id ?? '').trim();
  if (!raw) return '';
  if (STYLE_BY_ID[raw]) return raw;
  const key = styleKey(raw);
  return ID_BY_KEY[key] || ALIAS_BY_KEY[key] || '';
}

export function getDirectorStyle(id) {
  const key = normalizeStyleId(id);
  return key ? STYLE_BY_ID[key] || null : null;
}

export function isDirectorStyle(id) {
  return Boolean(normalizeStyleId(id));
}

/** 解析某个主色；不传 paletteKey 时用档案默认主色 */
export function resolvePalette(style, paletteKey) {
  if (!style) return null;
  const key = String(paletteKey || '').trim();
  return (style.palettes || []).find((p) => p.key === key)
    || (style.palettes || []).find((p) => p.key === style.defaultPalette)
    || (style.palettes || [])[0] || null;
}

/**
 * 收敛成一份可被下游消费的美学对象。
 * paletteKey 允许项目在主色调之间切换（张艺谋四色），风格档案本身不变。
 */
export function resolveAesthetic(id, { paletteKey } = {}) {
  const style = getDirectorStyle(id);
  if (!style) return null;
  const palette = resolvePalette(style, paletteKey);
  // Mock 出图画布配色：以档案 svg 为基线，主色决定 accent，
  // 让「换主色」在零 Key 自绘里也看得见（否则切到竹林绿仍是同一张图）。
  const baseSvg = style.svg || {};
  const svg = palette?.hex
    ? { ...baseSvg, accent: palette.hex }
    : { ...baseSvg };
  return {
    id: style.id,
    label: style.label,
    workTitle: style.workTitle,
    director: style.director,
    icon: style.icon,
    tagline: style.tagline,
    paletteKey: palette?.key || style.defaultPalette,
    paletteName: palette?.name || '',
    paletteHex: palette?.hex || '',
    paletteMood: palette?.mood || '',
    colorRule: style.colorRule,
    light: style.light,
    composition: style.composition,
    camera: style.camera,
    texture: style.texture,
    taboos: [...(style.taboos || [])],
    medium: [...(style.medium || [])],
    pace: { ...(style.pace || {}) },
    tone: style.tone,
    visualStyle: style.visualStyle,
    pacing: style.pacing,
    shotStrategy: style.shotStrategy,
    audioStrategy: style.audioStrategy,
    continuityRules: [...(style.continuityRules || [])],
    risks: [...(style.risks || [])],
    stylePrompt: style.stylePrompt,
    negativePrompt: style.negativePrompt,
    // Mock 自绘配色（artwork.resolvePalette 直接消费），缺失时下游退回内置 cinematic
    svg,
  };
}

/**
 * 出图 / 出片的正负提示词：把风格串拼在用户内容之后（内容优先），
 * 保证同一镜头换导演风格会得到不同的提示词，而不是只换标签。
 */
export function aestheticPrompt(id, { base = '', paletteKey = '', extraNegative = '' } = {}) {
  const a = resolveAesthetic(id, { paletteKey });
  const content = String(base ?? '').trim();
  const extraNeg = String(extraNegative ?? '').trim();
  if (!a) {
    return { positive: content, negative: extraNeg, style: null, applied: false };
  }
  // 主色单独前置，模型对句首颜色词的响应明显强于句中
  const colour = a.paletteName ? `${a.paletteName}${a.paletteHex ? `（${a.paletteHex}）` : ''} 主色调，${a.colorRule}` : a.colorRule;
  const positive = [content, colour, a.stylePrompt].filter(Boolean).join('｜');
  const negative = [a.negativePrompt, extraNeg].filter(Boolean).join(', ');
  return { positive, negative, style: a, applied: true };
}

/** 分镜 ffDesc 的风格后缀：主色 + 光线 + 构图 + 媒介，不重复描述主体 */
export function aestheticShotSuffix(id, { paletteKey = '', seed = 0 } = {}) {
  const a = resolveAesthetic(id, { paletteKey });
  if (!a) return '';
  const media = a.medium?.length ? a.medium[Math.abs(Math.trunc(seed)) % a.medium.length] : '';
  return [
    a.paletteName ? `主色 ${a.paletteName}` : '',
    a.light,
    a.composition,
    media,
    a.texture,
  ].filter(Boolean).join('；');
}

/** 零 Key 的导演阐述基线：直接用风格档案，不再走通用模板 */
export function aestheticTreatment(id, vars = {}, { paletteKey = '' } = {}) {
  const a = resolveAesthetic(id, { paletteKey });
  if (!a) return null;
  const title = String(vars.title || '').trim() || '未命名影片';
  const logline = String(vars.logline || vars.idea || '').trim();
  return {
    title: `《${title}》导演阐述 · ${a.workTitle}`,
    logline,
    tone: a.tone,
    visualStyle: `${a.visualStyle}（主色：${a.paletteName || '按档案默认'}${a.paletteHex ? ` ${a.paletteHex}` : ''}；${a.colorRule}）`,
    pacing: a.pacing,
    shotStrategy: `【光线】${a.light}。【构图】${a.composition}。【运镜】${a.camera}。【质感】${a.texture}`,
    audioStrategy: a.audioStrategy,
    continuityRules: a.continuityRules.slice(0, 5),
    risks: a.risks.slice(0, 3),
    styleId: a.id,
    styleLabel: a.label,
    paletteKey: a.paletteKey,
  };
}

/** 前端技能卡用的轻量投影：色块 + 美学标签 + 节奏说明，不含长文本 */
export function styleCard(id) {
  const style = getDirectorStyle(id);
  if (!style) return null;
  return {
    id: style.id, icon: style.icon, label: style.label, director: style.director,
    workTitle: style.workTitle, tagline: style.tagline,
    palettes: (style.palettes || []).map((p) => ({ ...p })),
    defaultPalette: style.defaultPalette,
    medium: [...(style.medium || [])].slice(0, 2),
    paceLabel: paceLabel(style.pace),
  };
}

/** 节奏档案 → 一句人话（技能卡与导演阐述共用） */
export function paceLabel(pace = {}) {
  const min = Number(pace.minShotSec) || 0;
  const max = Number(pace.maxShotSec) || 0;
  const fixed = Math.round((Number(pace.fixedShotRatio) || 0) * 100);
  if (!min || !max) return '';
  const range = min === max ? `单镜 ${min}s` : `单镜 ${min}–${max}s`;
  return fixed >= 30 ? `${range} · 固定长镜 ${fixed}%` : range;
}

export function listStyleCards() {
  return DIRECTOR_STYLES.map((s) => styleCard(s.id));
}

/**
 * 从项目读当前生效的美学：项目选择的技能 → 风格档案 → 主色偏好。
 * 单一入口，编排器 / 导演智能体 / 分镜智能体都用它，避免各处各拼一份。
 * 未选风格技能（或选了流程策略技能）时返回 null，下游行为与升级前一致。
 */
export function resolveProjectAesthetic(project, skillId) {
  const m = project?.management || {};
  const id = normalizeStyleId(skillId || m.director?.styleId || m.director?.skillId || '');
  if (!id) return null;
  return resolveAesthetic(id, { paletteKey: m.director?.paletteKey || '' });
}
