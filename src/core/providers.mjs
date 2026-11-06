// Provider 抽象：把「模型能力」与「智能体业务」彻底解耦
// - mock：确定性中文内容 + 自绘 SVG 资产，零 Key 可完整跑通
// - openai：任意 OpenAI 兼容 /chat/completions，失败自动回退 mock
// - comfyui：图片 / 视频直接提交本地 ComfyUI 导出的 API 格式 workflow（主路径）
import { uid, writeAsset, readAsset } from './store.mjs';
import { hash, storyboardSVG, characterSVG, transitionSVG, posterSVG } from './artwork.mjs';
import { parseWorkflow, runWorkflow } from './comfyui.mjs';
import { placeholderFrame } from './raster.mjs';

const SCHEMAS = {
  screenplay: '剧本：{title, genre, logline, style, characters:[{name,role,appearance}], scenes:[{id,location,time,summary,script:[字符串]}]}',
  events: '事件图谱：{events:[{title,summary,processChain:[字符串],scenes:[{title,location,time,summary}]}]}',
  shots: '分镜表：{shots:[{shotNo,size,angle,movement,ffDesc,motionDesc,audioDesc,duration,characters:[名称]}]}',
  characters: '角色设定：{characters:[{name,role,appearance,palette:[颜色],traits:[字符串]}]}',
  cameras: '机位依赖图：{cameras:[{id,label,shotNos:[数字],parent,reason}]}',
  context: '检索结果：{query, passages:[字符串], notes:[字符串]}',
  spatial: '转场说明：{fromCam,toCam,spatialNotes,axisRule,cameraPath}',
  review: '评审：{reason, highlights:[字符串]}',
};

const THEMES = [
  {
    key: 'noir', test: /侦探|悬疑|案|凶|警|雨夜|推理|谜|罪/,
    genre: '悬疑 / 黑色电影', styleHint: 'noir',
    chars: [
      { name: '沈砚', role: '私家侦探', appearance: '深色风衣、略显疲惫的眼神、左手旧怀表' },
      { name: '林夏', role: '调查记者', appearance: '短发、米色风衣、随身相机' },
      { name: '老周', role: '刑警队长', appearance: '灰呢大衣、烟斗、沉稳' },
    ],
    scenes: [
      { location: '雨夜旧城区 · 巷口', time: '深夜', summary: '一封没有署名的信把侦探引到案发地' },
      { location: '警局审讯室', time: '凌晨', summary: '证词里出现无法解释的时间差' },
      { location: '码头仓库', time: '黎明前', summary: '真相在潮湿的雾气里浮出水面' },
    ],
  },
  {
    key: 'scifi', test: /太空|星际|飞船|宇宙|未来|机器人|空间站|星球/,
    genre: '科幻 / 冒险', styleHint: 'cinematic',
    chars: [
      { name: '叶舟', role: '领航员', appearance: '银灰飞行服、短发、左眉疤痕' },
      { name: '苏离', role: '工程师', appearance: '橙色工装、护目镜、工具腰带' },
      { name: 'K-7', role: '机载智能体', appearance: '蓝色全息投影、无实体' },
    ],
    scenes: [
      { location: '沙漠坠毁点', time: '黄昏', summary: '飞船迫降，沙尘中传来求救信号' },
      { location: '驾驶舱', time: '夜', summary: '两人核对航线，发现坐标被篡改' },
      { location: '空间站环形走廊', time: '深夜', summary: '在失重前完成最后一道闸门' },
    ],
  },
  {
    key: 'youth', test: /校园|青春|少年|少女|同学|毕业|夏天|成长/,
    genre: '青春 / 成长', styleHint: 'anime',
    chars: [
      { name: '许知夏', role: '转学生', appearance: '白衬衫、蓝色发带、帆布书包' },
      { name: '陆屿', role: '同桌', appearance: '高个、校服外套、总戴耳机' },
      { name: '阿婆', role: '旧书店店主', appearance: '银发、圆框眼镜、方格围裙' },
    ],
    scenes: [
      { location: '高二教室', time: '午后', summary: '一张纸条改变了两个人的夏天' },
      { location: '街角旧书店', time: '傍晚', summary: '在旧书里发现上一届留下的秘密' },
      { location: '学校天台', time: '日落', summary: '约定在毕业前把故事写完' },
    ],
  },
  {
    key: 'general', test: /.*/, genre: '剧情 / 短片', styleHint: 'cinematic',
    chars: [
      { name: '顾言', role: '主角', appearance: '简洁深色外套、目光坚定' },
      { name: '程曦', role: '搭档', appearance: '浅色衬衫、随身笔记本' },
    ],
    scenes: [
      { location: '故事开始的地方', time: '清晨', summary: '一个意外打破了日常' },
      { location: '转折发生的房间', time: '夜', summary: '选择必须在此刻做出' },
      { location: '终点与起点', time: '黎明', summary: '带着新的理解重新出发' },
    ],
  },
];

export function detectTheme(text = '') {
  return THEMES.find((t) => t.key !== 'general' && t.test.test(text)) || THEMES[THEMES.length - 1];
}

const SIZES = ['建立全景', '全景', '双人中景', '过肩中景', '特写', '插入镜头', '反打中景', '反应特写'];
const ANGLES = ['平视', '低角度', '过肩', '俯拍', '平视', '微仰', '平视', '平视'];
const MOVES = ['缓慢推镜', '固定', '横移', '固定', '缓慢推近', '固定', '固定', '轻微手持'];

function pick(arr, i) { return arr[i % arr.length]; }
function shortTitle(idea = '') {
  const clean = idea.replace(/\s+/g, ' ').trim();
  return clean.length > 14 ? `${clean.slice(0, 13)}…` : (clean || '未命名故事');
}

function mockGenerate(intent, vars = {}) {
  const idea = String(vars.idea || vars.text || '');
  const theme = detectTheme(idea || vars.title || '');
  const seed = hash(idea + intent);
  switch (intent) {
    case 'screenplay': {
      const title = vars.title || (theme.key === 'noir' ? '雨夜来信' : theme.key === 'scifi' ? '坐标之外' : theme.key === 'youth' ? '夏末纸条' : shortTitle(idea) || '无名短片');
      return {
        title,
        genre: theme.genre,
        logline: `${shortTitle(idea) || '一个念头'}，被拆成三个场景、若干镜头，最终成为一段可以观看的故事。`,
        style: vars.style || theme.styleHint,
        characters: theme.chars.map((c) => ({ ...c })),
        scenes: theme.scenes.map((s, i) => ({
          id: `sc_${i + 1}`, location: s.location, time: s.time, summary: s.summary,
          script: [
            `【${s.time} · ${s.location}】`,
            `${s.summary}。`,
            `${theme.chars[0].name}：「${i === 0 ? '这件事，不像看上去那么简单。' : i === 1 ? '再给我一点时间，线索能连上。' : '现在，我们终于可以把它讲完了。'}」`,
            `${theme.chars[1 % theme.chars.length].name} 没有回答，只是看向画面外的某个方向。`,
          ],
        })),
      };
    }
    case 'events': {
      const scenes = vars.scenes || theme.scenes;
      return {
        events: scenes.slice(0, 3).map((s, i) => ({
          title: `事件 ${i + 1} · ${s.location || s.title || '转折'}`,
          summary: s.summary || '推动故事向前的关键节点',
          processChain: i === 0 ? ['起因', '发现线索', '决定调查'] : i === 1 ? ['追问', '证词矛盾', '信任动摇'] : ['对峙', '真相浮现', '做出选择'],
          scenes: [{ title: s.title || s.location || '场景', location: s.location || '内景', time: s.time || '夜', summary: s.summary || '' }],
        })),
      };
    }
    case 'shots': {
      const count = Math.max(3, Math.min(8, Number(vars.count) || 5));
      const scene = vars.scene || theme.scenes[0];
      const location = scene.location || '场景';
      return {
        shots: Array.from({ length: count }, (_, i) => ({
          shotNo: i + 1,
          size: pick(SIZES, i + (seed % 3)),
          angle: pick(ANGLES, i + (seed % 2)),
          movement: pick(MOVES, i),
          ffDesc: `${location}｜${pick(SIZES, i + (seed % 3))}｜${theme.chars[i % theme.chars.length].name}位于画面${['左三分之一', '中央', '右三分之一'][i % 3]}，${['冷调侧光', '逆光轮廓', '柔和顶光'][i % 3]}，环境细节保持一致`,
          motionDesc: `${pick(MOVES, i)}，${['角色缓缓转身看向画外', '雨滴沿镜头前滑落', '远处灯光次第亮起', '纸页被风翻动'][i % 4]}`,
          audioDesc: `${['雨声与远处警笛', '低频环境音', '脚步与衣料摩擦', '短暂的静默'][i % 4]}`,
          duration: 4 + (i % 3),
          characters: [theme.chars[i % theme.chars.length].name],
        })),
      };
    }
    case 'characters': {
      const list = vars.characters || theme.chars;
      return {
        characters: list.map((c, i) => ({
          name: c.name, role: c.role || '角色',
          appearance: c.appearance || '造型待定',
          palette: ['#0b111c', ['#3a506b', '#6b4f8a', '#7a6fc4', '#3f6b5c'][i % 4], '#ff9a5c'],
          traits: ['动机连贯', '跨镜头可辨识', '服装一致'],
        })),
      };
    }
    case 'cameras': {
      const shots = vars.shots || [];
      const groups = [];
      for (let i = 0; i < shots.length; i += 2) {
        groups.push({
          id: `cam_${groups.length + 1}`,
          label: `机位 ${String.fromCharCode(65 + groups.length)}`,
          shotNos: shots.slice(i, i + 2).map((s) => s.shotNo),
          parent: groups.length > 0 ? `cam_${groups.length}` : null,
          reason: groups.length === 0 ? '建立镜头作为视觉锚点根节点' : '复用上一机位的角色与空间状态',
        });
      }
      return { cameras: groups };
    }
    case 'context': {
      const corpus = String(vars.corpus || '');
      const query = String(vars.query || '');
      const parts = corpus.split(/[。！？\n]/).map((s) => s.trim()).filter((s) => s.length > 6);
      const keys = query.replace(/[，。、\s]/g, '').slice(0, 6);
      const matched = parts.filter((s) => keys && s.includes(keys.slice(0, 2))).slice(0, 3);
      return {
        query,
        passages: (matched.length ? matched : parts.slice(0, 3)).map((s) => `……${s}。`),
        notes: [
          '角色动机：不要在后续镜头中改变既定立场',
          '空间状态：保持上一场景的道具位置与光照方向',
          '主题线索：呼应开篇出现的意象',
        ],
      };
    }
    case 'spatial': {
      return {
        fromCam: vars.fromCam || '机位 A', toCam: vars.toCam || '机位 B',
        spatialNotes: '两位角色的相对座位、桌面道具与墙面陈设保持一致；反打镜头隐式满足 180 度轴线规则。',
        axisRule: '180°',
        cameraPath: '从建立全景平滑过渡至反打过肩，保持视线方向连续',
      };
    }
    case 'review': {
      return { reason: '候选与镜头规格的语义对齐度更高，角色身份与空间布局更稳定。', highlights: ['构图符合景别', '角色可辨识', '光照方向一致'] };
    }
    default:
      return { text: `${intent} 的模拟输出`, seed };
  }
}

function mergeDefaults(intent, real, vars) {
  const base = mockGenerate(intent, vars);
  if (!real || typeof real !== 'object') return base;
  const merged = { ...base, ...real };
  for (const key of Object.keys(base)) {
    if (Array.isArray(base[key]) && (!Array.isArray(merged[key]) || !merged[key].length)) merged[key] = base[key];
  }
  return merged;
}

function extractJSON(text = '') {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('响应中没有 JSON 对象');
  return JSON.parse(cleaned.slice(start, end + 1));
}

export function createProviders(settings = {}, log = () => {}) {
  const mode = settings.provider === 'openai' && settings.baseUrl && settings.apiKey ? 'openai' : 'mock';
  const comfy = settings.comfy || null;
  const comfyWorkflows = { image: null, video: null };
  if (comfy?.enabled) {
    for (const kind of ['image', 'video']) {
      const raw = comfy[`${kind}Workflow`];
      if (!raw) continue;
      try { comfyWorkflows[kind] = parseWorkflow(raw, `${kind} 工作流`); }
      catch (err) { log('warn', `ComfyUI ${kind} 工作流无效：${err.message}`); }
    }
  }
  const comfyActive = Boolean(comfyWorkflows.image || comfyWorkflows.video);
  const delay = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('已取消', 'AbortError')); }, { once: true });
  });

  /** 执行一份用户粘贴的 API 格式工作流 */
  function runComfy(kind, vars, signal) {
    return runWorkflow(comfy, comfyWorkflows[kind], { ...vars, cfg: comfy }, {
      signal, log, bindings: comfy?.bindings?.[kind] || [],
    });
  }

  /** 画布资产 → ComfyUI 可上传的二进制；SVG 渲染成等价 PNG 占位 */
  function referenceBuffer(url, opts = {}) {
    if (!url) return null;
    const m = String(url).match(/\/assets\/([A-Za-z0-9_.-]+)/);
    if (!m) return null;
    const name = m[1];
    const buf = readAsset(name);
    if (!buf) return null;
    if (/\.svg$/i.test(name)) {
      return {
        buffer: placeholderFrame({ seed: `${opts.seed || ''}-${name}`, shotNo: opts.shotNo || 1, style: opts.style }),
        name: `${name.replace(/\.svg$/i, '')}.png`, converted: true,
      };
    }
    return { buffer: buf, name, converted: false };
  }

  async function callLLM(system, user, signal) {
    const base = String(settings.baseUrl).replace(/\/+$/, '');
    const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: settings.model || 'gpt-4o-mini',
        temperature: 0.7,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal,
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const json = await res.json();
    return extractJSON(json?.choices?.[0]?.message?.content || '');
  }

  async function generate(intent, vars = {}, signal) {
    if (mode === 'openai') {
      try {
        const system = `你是影视制作智能体。只输出严格 JSON，不要解释、不要 Markdown 代码块。输出结构：${SCHEMAS[intent] || '{text:string}'}。内容使用简体中文，符合用户提供的故事设定。`;
        const user = `任务类型：${intent}\n输入数据：\n${JSON.stringify(vars, null, 2)}`;
        const out = await callLLM(system, user, signal);
        return mergeDefaults(intent, out, vars);
      } catch (err) {
        log('warn', `模型调用失败，已回退 Mock：${err.message}`);
      }
    }
    await delay(140 + (hash(intent + JSON.stringify(vars)) % 260), signal);
    return mockGenerate(intent, vars);
  }

  async function image(opts = {}, signal) {
    const { kind = 'keyframe', style = 'cinematic', label = '', seed = '', shotNo = 1,
      size = '中景', angle = '平视', movement = '固定', prompt = '', characters = [] } = opts;

    // 主路径：本地 ComfyUI「导出(API)」工作流
    if (comfyWorkflows.image) {
      try {
        const ref = referenceBuffer((opts.refs || [])[0], { seed, shotNo, style });
        const fullPrompt = `${prompt}｜${size}｜${angle}｜${movement}｜${style}`;
        const result = await runComfy('image', {
          prompt: fullPrompt, seed: `${kind}-${seed}-${shotNo}`, style, shotNo,
          filenamePrefix: `lingximanju_${kind}_${shotNo}`,
          imageBuffer: ref?.buffer, imageName: ref?.name,
        }, signal);
        return {
          url: result.primary.url, width: comfy.width, height: comfy.height,
          provider: 'comfyui', promptId: result.promptId,
          applied: result.applied.length, assets: result.assets,
        };
      } catch (err) {
        if (comfy.strict) throw err;
        log('warn', `ComfyUI 出图失败，已回退本地生成：${err.message}`);
      }
    }

    if (settings.imageEndpoint) {
      try {
        const res = await fetch(settings.imageEndpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, size: '1280x720', n: 1 }), signal,
        });
        if (res.ok) {
          const json = await res.json();
          const url = json?.data?.[0]?.url || json?.url;
          if (url) return { url, width: 1280, height: 720, provider: 'remote' };
          const b64 = json?.data?.[0]?.b64_json;
          if (b64) return { url: writeAsset(`${uid('img')}.png`, Buffer.from(b64, 'base64')), width: 1280, height: 720, provider: 'remote' };
        }
      } catch (err) { log('warn', `图像接口失败，已回退自绘 SVG：${err.message}`); }
    }
    await delay(180 + (hash(seed + prompt) % 320), signal);
    let svg;
    if (kind === 'character') svg = characterSVG({ name: label, appearance: prompt, style, seed });
    else if (kind === 'transition') svg = transitionSVG({ from: opts.from, to: opts.to, style, seed });
    else if (kind === 'poster') svg = posterSVG({ title: label, shotCount: opts.shotCount || 0, duration: opts.duration || 0, style });
    else svg = storyboardSVG({ title: label, shotNo, size, angle, movement, prompt, style, characters, seed, kind });
    return { url: writeAsset(`${uid('img')}.svg`, svg), width: 640, height: 360, provider: 'mock' };
  }

  async function video(opts = {}, signal) {
    const frames = opts.frames || [];
    const duration = Number(opts.duration) || 5;

    // 主路径：本地 ComfyUI 图生视频 / 首尾帧工作流
    // 只导出导演包时跳过本地视频渲染（成片交给导演工作台生成），避免浪费 GPU
    if (comfyWorkflows.video && comfy.outputMode !== 'director-pack') {
      try {
        const first = frames.find(Boolean);
        const ref = referenceBuffer(first, { seed: opts.prompt, shotNo: opts.shotNo || 1, style: opts.style });
        const result = await runComfy('video', {
          prompt: opts.prompt || '', motion: opts.prompt || '',
          seed: `clip-${first}-${opts.shotNo || 1}`,
          frames: Math.round(duration * (comfy.fps || 24)), duration,
          shotNo: opts.shotNo || 1, style: opts.style,
          filenamePrefix: `lingximanju_clip_${opts.shotNo || 1}`,
          imageBuffer: ref?.buffer, imageName: ref?.name,
        }, signal);
        const videoAsset = result.assets.find((a) => a.kind === 'video') || result.primary;
        const posterAsset = result.assets.find((a) => a.kind === 'image');
        return {
          url: videoAsset.url, file: videoAsset.file, assets: result.assets,
          poster: posterAsset?.url || first || null,
          frames, duration, promptId: result.promptId,
          provider: 'comfyui', synthetic: false,
          note: '由本地 ComfyUI 工作流生成的真实视频片段。',
        };
      } catch (err) {
        if (comfy.strict) throw err;
        log('warn', `ComfyUI 视频生成失败，已回退帧序列预览：${err.message}`);
      }
    }

    await delay(260 + (hash(JSON.stringify(opts)) % 340), signal);
    return {
      poster: frames[0] || null,
      frames,
      duration,
      synthetic: true,
      provider: 'mock',
      note: 'Mock 模式以关键帧序列模拟镜头预览；在设置里导入 ComfyUI 视频工作流后返回真实片段。',
    };
  }

  async function judge(opts = {}, signal) {
    const candidates = opts.candidates || [];
    await delay(120, signal);
    const scores = candidates.map((c, i) => {
      const h = hash(`${i}|${c.prompt || ''}|${c.url || ''}`);
      const base = 0.62 + (h % 350) / 1000;
      return Math.min(0.98, base + (i === 0 ? 0.04 : 0));
    });
    const index = scores.indexOf(Math.max(...scores));
    return {
      index,
      scores: scores.map((s) => Number(s.toFixed(3))),
      criteria: ['视觉保真度', '叙事一致性', '镜头规格遵循'],
      reason: `候选 ${index + 1} 在角色可辨识度、构图与光照方向上与「${opts.shotTitle || '镜头规格'}」最一致；其余候选存在身份或空间状态漂移风险。`,
    };
  }

  return { mode, comfyActive, generate, image, video, judge, detectTheme };
}
