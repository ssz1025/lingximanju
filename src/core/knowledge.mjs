// 原著知识库：论文式(6) 的检索基础设施 + 磁盘缓存
// 纯算法层（分块 / BM25 召回 / 重排 / FRAGMENT 格式化）已抽到 bm25.mjs，
// 本模块只负责「落盘缓存」这一有 I/O 的部分，避免核心域模块反向依赖 store。
// 对齐 ViMax 的三层做法，但用纯 JS 实现无需外部 embedding 服务：
//   1. RecursiveCharacterTextSplitter(512, 128) → chunkNovel()
//   2. FAISS 向量召回 top-k → BM25 词频打分（同为「宽召回」，中文场景字词重合度可用）
//   3. Reranker 重排 + 0.7 阈值过滤 + 分数累加 → retrieveRelevantChunks()
// ViMax 参考实现：pipelines/novel2movie_pipeline.py L154-200（FAISS + bge-reranker-v2-m3）
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.mjs';
import { chunkNovel, tokenize } from './bm25.mjs';

const KB_DIR = path.join(DATA_DIR, 'knowledge');

export { tokenize, chunkNovel, KnowledgeBase, retrieveRelevantChunks, formatFragments } from './bm25.mjs';

/* ---------------- 磁盘缓存：对齐 ViMax 的 knowledge_base / relevant_chunks 落盘 ---------------- */
/** @returns {string} 缓存文件绝对路径 */
export function saveKnowledgeCache(projectId, chunks) {
  fs.mkdirSync(KB_DIR, { recursive: true });
  const safe = String(projectId).replace(/[^a-zA-Z0-9_-]/g, '');
  const file = path.join(KB_DIR, `${safe}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    updatedAt: Date.now(),
    chunks: chunks.map((c) => ({ index: c.index, text: c.text })),
  }), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** 读回分块并重建 BM25 索引所需的 tokens；缓存不存在返回空数组 */
export function loadKnowledgeCache(projectId) {
  const safe = String(projectId).replace(/[^a-zA-Z0-9_-]/g, '');
  const file = path.join(KB_DIR, `${safe}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (data.chunks || []).map((c) => ({
      index: c.index, text: c.text, tokens: tokenize(c.text),
    }));
  } catch { return []; }
}
