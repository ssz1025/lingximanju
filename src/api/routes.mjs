// REST 路由聚合器：跨源访问硬化 + 按域分发（域实现见 ./routes/*.mjs，共用件见 ./http.mjs）
import { json } from './http.mjs';
import { handleSystem } from './routes/system.mjs';
import { handleComfy } from './routes/comfy.mjs';
import { handleManagement } from './routes/management.mjs';
import { handleVoices } from './routes/voices.mjs';
import { handleDirector } from './routes/director.mjs';
import { handleDirectorStyles } from './routes/director-styles.mjs';
import { handleRuntime } from './routes/runtime.mjs';
import { handleProductionChat } from './routes/production-chat.mjs';
import { handleMedia } from './routes/media.mjs';
import { handleProjects } from './routes/projects.mjs';
import { handleEpisodes } from './routes/episodes.mjs';
import { handleAssets } from './routes/assets.mjs';
import { handleStepChat } from './routes/step-chat.mjs';
import { handleAiThread } from './routes/ai-thread.mjs';

// 跨源白名单：默认空（浏览器/Electron 都是同源访问，不需要任何 CORS 头）。
// 需要跨源调试时用 ALLOW_ORIGIN=https://dev.example.com,http://other:1234 显式放行。
const EXTRA_ORIGINS = new Set(String(process.env.ALLOW_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean));

export async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';
  // 访问硬化：之前无条件回 `Access-Control-Allow-Origin: *` 且 OPTIONS 一律 204，
  // 任意恶意网页都能预检通过后读写本地项目。现在同源/白名单之外的 Origin 连预检一起 403。
  // DNS rebinding 由 server.mjs 的 Host 字面量校验拦截，两道防线互补。
  const origin = req.headers?.origin;
  if (origin && origin !== `http://${req.headers?.host}` && !EXTRA_ORIGINS.has(origin)) {
    return json(res, { error: '跨源请求被拒绝' }, 403);
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

  // 各域路由正则与字面路径互不相交（见 routes/match.mjs），分发顺序不影响匹配结果
  if (await handleSystem(req, res, url)) return true;
  if (await handleComfy(req, res, url)) return true;
  if (await handleManagement(req, res, url)) return true;
  if (await handleVoices(req, res, url)) return true;
  if (await handleDirector(req, res, url)) return true;
  if (await handleDirectorStyles(req, res, url)) return true;
  if (await handleRuntime(req, res, url)) return true;
  if (await handleMedia(req, res, url)) return true;
  if (await handleEpisodes(req, res, url)) return true;
  if (await handleProjects(req, res, url)) return true;
  if (await handleAssets(req, res, url)) return true;
  // 对话域：分步会话（steps/*）与项目级制片对话（production/chat）各管一段，路径互不相交
  if (await handleStepChat(req, res, url)) return true;
  if (await handleProductionChat(req, res, url)) return true;
  // 统一对话线程（ai/*）：读取时合并上面两段 + 新增档位，派发时按档位回到各自业务函数
  if (await handleAiThread(req, res, url)) return true;

  return json(res, { error: `未知接口 ${method} ${pathname}` }, 404), true;
}
