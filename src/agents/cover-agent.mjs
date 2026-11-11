// 封面智能体：对话式封面创作。提示词构建、参考图解析、LLM 对话编排都收敛在这里，
// 路由层（api/routes/management.mjs）只做 HTTP 编排，不承载封面业务。
import { readAsset } from '../core/store.mjs';
import { createProviders } from '../core/providers.mjs';
import { resolveModelSettings } from '../core/app-settings.mjs';

/** 参考图上限：与 ComfyUI LoadImage 插槽数量同量级，防止把整个资源库都上传一遍 */
export const MAX_COVER_REFS = 6;

/** 封面兜底提示词：片名 + 原著/剧本梗概 + 电影海报视觉要求（中文提示词可直接喂 SDXL） */
export function buildCoverPrompt(project, m, custom = '') {
  const name = String(project.name || m.title || '未命名影片').slice(0, 40);
  const idea = (project.nodes || []).find((n) => n.type === 'idea');
  const script = (project.nodes || []).find((n) => n.type === 'script');
  const gist = [
    script?.data?.script?.logline || script?.data?.logline || '',
    (m.episodes || [])[0]?.summary || '',
    String(idea?.data?.text || '').replace(/\s+/g, ' ').slice(0, 90),
    String(m.source?.text || '').replace(/\s+/g, ' ').slice(0, 90),
  ].filter(Boolean).join('，').slice(0, 180);
  const base = `电影海报风格的项目封面插画，片名《${name}》，${gist || '一部富有戏剧张力的故事'}，` +
    `cinematic movie poster, dramatic cinematic lighting, rich atmosphere, centered composition, ` +
    `highly detailed, film grain, no text, no watermark, no lettering`;
  const extra = String(custom || '').trim().slice(0, 400);
  return extra ? `电影海报风格的项目封面插画，片名《${name}》，${extra}，cinematic movie poster, dramatic lighting, no text, no watermark` : base;
}

/** 封面对话 / 提示词生成的 LLM 输入：项目名 + 简介 / 剧本梗概 + 分集摘要 + 小说节选 */
export function buildCoverVars(project, m, custom = '') {
  const name = String(project.name || m.title || '未命名影片').slice(0, 40);
  const idea = (project.nodes || []).find((n) => n.type === 'idea');
  const script = (project.nodes || []).find((n) => n.type === 'script');
  const logline = script?.data?.script?.logline || script?.data?.logline || '';
  return {
    title: name,
    genre: String(script?.data?.script?.genre || script?.data?.genre || ''),
    logline: String(logline).slice(0, 200),
    episodes: (m.episodes || []).slice(0, 6)
      .map((e) => `第${e.no}集《${e.title}》：${String(e.summary || '').replace(/\s+/g, ' ').slice(0, 120)}`),
    idea: String(idea?.data?.text || '').replace(/\s+/g, ' ').slice(0, 300),
    novelExcerpt: String(m.source?.text || '').replace(/\s+/g, ' ').slice(0, 1500),
    custom: String(custom || '').trim().slice(0, 400),
    style: project.settings?.style || '',
  };
}

/** dataURL → 合法图片二进制；失败抛错（与封面上传同校验：魔数 + 6MB 上限） */
export function parseImagePayload(dataUrl, label = '图片', allowGif = true) {
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '').trim());
  if (!match) throw new Error(`${label}仅支持 PNG / JPEG / WebP / GIF 图片`);
  const buf = Buffer.from(match[2], 'base64');
  if (!buf.length || buf.length > 6 * 1024 * 1024) throw new Error(`${label}大小需在 1B–6MB 之间`);
  const head = buf.subarray(0, 8).toString('hex');
  const valid = match[1] === 'png' ? head.startsWith('89504e47')
    : match[1] === 'jpeg' ? head.startsWith('ffd8ff')
    : match[1] === 'webp' ? head.startsWith('52494646')
    : /^47494638/.test(head);
  if (!valid) throw new Error(`${label}内容与声明格式不符`);
  if (match[1] === 'gif' && !allowGif) throw new Error(`${label}不支持 GIF（ComfyUI 参考图仅支持 PNG / JPEG / WebP）`);
  return { buf, ext: match[1] === 'jpeg' ? 'jpg' : match[1] };
}

/** 前端提交的参考图（refs=[{asset}|{dataUrl}]）→ {name, dataUrl}：资源库读盘转 base64 / 本地 dataUrl 透传 */
export function resolveChatRefs(refs) {
  const out = [];
  for (const item of (Array.isArray(refs) ? refs.slice(0, MAX_COVER_REFS) : [])) {
    const it = item && typeof item === 'object' ? item : { asset: String(item) };
    if (it.asset) {
      const name = String(it.asset);
      if (!/^[a-zA-Z0-9_.-]+$/.test(name) || !/\.(png|jpe?g|webp)$/i.test(name)) {
        throw new Error(`参考图「${name}」不是可用的图片资源（仅支持 PNG / JPEG / WebP）`);
      }
      const buf = readAsset(name);
      if (!buf) throw new Error(`参考图「${name}」不存在或已被删除`);
      const ext = /\.png$/i.test(name) ? 'png' : /\.webp$/i.test(name) ? 'webp' : 'jpeg';
      out.push({ name, dataUrl: `data:image/${ext};base64,${buf.toString('base64')}` });
    } else if (it.dataUrl) {
      parseImagePayload(it.dataUrl, `参考图 ${out.length + 1}：`, false);
      out.push({ name: it.name || `本地上传 ${out.length + 1}`, dataUrl: String(it.dataUrl) });
    } else {
      throw new Error(`参考图 ${out.length + 1} 缺少 asset 或 dataUrl`);
    }
  }
  return out;
}

/**
 * 独立封面提示词 agent：只负责提示词的设计优化，不承担对话职责。
 * 输入项目资料 + 用户画面要求 + 参考图（VLM 真实看图），输出一句完整连贯的中文画面描述 + 负向提示词。
 * LLM 未配置 / 调用失败时自动落到完整句模板兜底（providers 内置）。
 */
export async function designCoverPrompt({ project, m, requirement = '', refs = [], providers, modelId = '', log = () => {}, onUsage = null }) {
  const p = providers || createProviders(resolveModelSettings(project, modelId), log, onUsage);
  const vars = {
    ...buildCoverVars(project, m, String(requirement || '').trim()),
    requirement: String(requirement || '').trim().slice(0, 400),
    refs: refs.map((r) => r.name),
    // VLM 多模态输入：模型能看图时按参考图的风格 / 构图优化提示词
    __images: refs.map((r) => r.dataUrl),
  };
  const out = await p.generate('coverPromptDesign', vars);
  const prompt = String(out?.prompt || '').trim();
  if (!prompt) throw new Error('提示词 agent 未返回有效结果');
  const fromMock = Boolean(out.__fallback) || (out.__mockKeys || []).includes('prompt');
  return {
    prompt,
    negative: String(out.negative || '').trim(),
    style: String(out.style || '').trim(),
    source: fromMock ? 'fallback' : p.mode === 'openai' ? 'llm' : 'template',
    fellBack: fromMock && p.mode === 'openai',
  };
}

/**
 * 封面对话：对话历史 + 项目资料 + 参考图（VLM 真实看图）→ 一轮助手回复。
 * 提示词一律由独立的 designCoverPrompt agent 产出（对话与设计并行请求，互不阻塞）。
 * 返回 { reply, prompt, negative, suggestions, source, fellBack, message }；prompt 为空视为失败。
 */
export async function coverChat({ project, m, messages = [], refs = [], modelId = '', log = () => {}, onUsage = null }) {
  const history = (Array.isArray(messages) ? messages : [])
    .filter((x) => x && (x.role === 'user' || x.role === 'assistant') && String(x.content || '').trim())
    .slice(-12)
    .map((x) => ({ role: x.role, content: String(x.content).slice(0, 1000) }));
  const lastUser = [...history].reverse().find((x) => x.role === 'user')?.content || '';
  const providers = createProviders(resolveModelSettings(project, modelId),
    (level, msg) => log(level, msg), onUsage);
  const talkVars = {
    ...buildCoverVars(project, m, ''),
    history,
    refs: refs.map((r) => r.name),
    __images: refs.map((r) => r.dataUrl),
  };
  // 对话回复与提示词设计并行：prompt 只信独立设计 agent 的产出
  const [talk, designed] = await Promise.all([
    providers.generate('coverChat', talkVars).catch(() => null),
    designCoverPrompt({ project, m, requirement: lastUser, refs, providers, modelId }),
  ]);
  const prompt = String(designed?.prompt || '').trim();
  if (!prompt) throw new Error('提示词 agent 未返回有效提示词');
  return {
    reply: String(talk?.reply || '').trim() || `已为《${buildCoverVars(project, m, '').title}》设计好封面提示词，确认后即可生成。`,
    prompt,
    negative: String(designed.negative || '').trim(),
    suggestions: (Array.isArray(talk?.suggestions) ? talk.suggestions : []).map(String).slice(0, 4),
    source: designed.source,
    fellBack: designed.fellBack,
  };
}
