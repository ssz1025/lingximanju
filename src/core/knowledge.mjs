// 原著知识库：论文式(6) 的检索基础设施
// 对齐 ViMax 的三层做法，但用纯 JS 实现无需外部 embedding 服务：
//   1. RecursiveCharacterTextSplitter(512, 128) → chunkNovel()
//   2. FAISS 向量召回 top-k → BM25 词频打分（同为「宽召回」，中文场景字词重合度可用）
//   3. Reranker 重排 + 0.7 阈值过滤 + 分数累加 → retrieveRelevantChunks()
// ViMax 参考实现：pipelines/novel2movie_pipeline.py L154-200（FAISS + bge-reranker-v2-m3）
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.mjs';

const CHUNK_SIZE = 512;
const CHUNK_OVERLAP = 128;
const KB_DIR = path.join(DATA_DIR, 'knowledge');

// 中文停用词：BM25 打分前过滤，避免「的/了/是」主导词频
const STOPWORDS = new Set([
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
  '自己', '这', '那', '他', '她', '它', '们', '与', '及', '或', '而', '之', '其',
  '被', '把', '让', '向', '往', '从', '对', '但', '可是', '然而', '因为', '所以',
  '于是', '然后', '还是', '又', '再', '才', '只', '更', '最', '非常', '什么',
]);

/** 中文字符 bigram 分词：无需词典，对中文召回稳健 */
export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const tokens = [];
  // 中文连续段做 bigram；英文/数字段整段作为一个词
  const re = /([\u4e00-\u9fff]+)|([a-z0-9]+)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) {
      const han = m[1];
      if (han.length === 1) { if (!STOPWORDS.has(han)) tokens.push(han); continue; }
      for (let i = 0; i < han.length - 1; i++) tokens.push(han.slice(i, i + 2));
    } else if (m[2]) {
      tokens.push(m[2]);
    }
  }
  return tokens;
}

/**
 * 论文式(6) 前置：把原著长文本切成知识块。
 * 对齐 ViMax 的 RecursiveCharacterTextSplitter(chunk_size=512, chunk_overlap=128)：
 * 优先按段落/句子边界切，超长句硬切，块间带 128 字符重叠保住跨块上下文。
 * @returns {Array<{index:number, text:string, tokens:string[]}>}
 */
export function chunkNovel(text, { chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP } = {}) {
  const src = String(text || '').trim();
  if (!src) return [];
  // 先按段落聚合到目标块长
  const paragraphs = src.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const pieces = [];
  let buf = '';
  const flush = () => { if (buf.trim()) pieces.push(buf.trim()); buf = ''; };
  for (const p of paragraphs) {
    if (p.length > chunkSize) {
      // 超长段落先按句子边界拆开
      flush();
      let sent = '';
      for (const sentence of p.split(/(?<=[。！？!?；;])/)) {
        if ((sent + sentence).length > chunkSize) {
          if (sent.trim()) pieces.push(sent.trim());
          sent = sentence;
        } else {
          sent += sentence;
        }
      }
      if (sent.trim()) buf = sent.trim();
    } else if ((buf + p).length > chunkSize) {
      flush();
      buf = p;
    } else {
      buf = buf ? `${buf}\n${p}` : p;
    }
  }
  flush();

  // 相邻块加 overlap：从上一块尾部取 overlap 字符接到当前块头部
  const chunks = [];
  let prevTail = '';
  for (const piece of pieces) {
    const text = prevTail ? `${prevTail}\n${piece}` : piece;
    chunks.push({
      index: chunks.length,
      text,
      tokens: tokenize(text),
    });
    prevTail = piece.slice(-overlap);
  }
  return chunks;
}

/** BM25 参数（业界常用值） */
const K1 = 1.5;
const B = 0.75;

/**
 * 原著知识库：建一次索引，可多次查询。
 * BM25 作为召回器（对应 ViMax 的 FAISS 相似召回 top-k），单文档量级下 O(N) 打分足够快。
 */
export class KnowledgeBase {
  constructor(chunks) {
    this.chunks = chunks || [];
    this.df = new Map(); // 词 → 含该词的块数
    for (const chunk of this.chunks) {
      const seen = new Set(chunk.tokens);
      for (const t of seen) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
    this.avgLen = this.chunks.length
      ? this.chunks.reduce((a, c) => a + c.tokens.length, 0) / this.chunks.length
      : 1;
  }

  /** BM25 打分：返回 [{chunk, score}] 按分降序 */
  search(query, { k = 10, minScore = 0.01 } = {}) {
    const qTokens = tokenize(query);
    if (!qTokens.length || !this.chunks.length) return [];
    const n = this.chunks.length;
    const scored = this.chunks.map((chunk) => {
      const tf = new Map();
      for (const t of chunk.tokens) tf.set(t, (tf.get(t) || 0) + 1);
      let score = 0;
      for (const t of qTokens) {
        const f = tf.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (n - (this.df.get(t) || 0) + 0.5) / ((this.df.get(t) || 0) + 0.5));
        score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * chunk.tokens.length / this.avgLen));
      }
      return { chunk, score };
    });
    return scored
      .filter((s) => s.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

/** 归一化分数为「相对最佳命中的比值」（score/max）：
 * 旧 min-max 会把第一名硬拉到 1.0，第二名哪怕只有第一名的一半也轻松过 0.7 阈值；
 * 比值语义下阈值才有筛选力——只有接近最佳命中的块才会进入 FRAGMENT。
 * 单命中时 score/max = 1，不会误杀唯一命中。 */
function normalizeScores(pairs) {
  if (!pairs.length) return [];
  const max = Math.max(...pairs.map((p) => p.score));
  return pairs.map((p) => ({ text: p.chunk.text, score: max < 1e-9 ? 0 : p.score / max }));
}

/** Jaccard 相似度：中文 bigram 词集的重叠度，用于近重复识别 */
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * 论文式(6)：事件相关片段检索。
 * 完全对齐 ViMax retrieve_relevant_chunks 的语义：
 *   - query 粒度 = 事件 processChain 的每一条（不是整个事件）
 *   - 每条召回 top-k(10) → 重排 → 阈值 0.7 过滤 → 同一块分数累加
 * @param {KnowledgeBase} kb 已建索引的知识库
 * @param {string[]} processChain 事件的因果步骤链
 * @param {{topK?:number, threshold?:number}} opts
 * @returns {Array<{text:string, score:number}>} 按累加分数降序
 */
export function retrieveRelevantChunks(kb, processChain, { topK = 10, threshold = 0.7 } = {}) {
  const relevant = new Map(); // text → 累加分数
  for (const process of (processChain || []).filter(Boolean)) {
    const recalled = kb.search(process, { k: topK });
    if (!recalled.length) continue;
    // BM25 原始分没有统一量纲，min-max 归一后才能用 0.7 阈值
    const ranked = normalizeScores(recalled);
    for (const { text, score } of ranked.slice(0, topK)) {
      if (score >= threshold) relevant.set(text, (relevant.get(text) || 0) + score);
    }
  }
  return [...relevant.entries()]
    .map(([text, score]) => ({ text, score: Math.round(score * 100) / 100 }))
    .sort((a, b) => b.score - a.score)
    // 近重复去重：overlap 分块让相邻块共享大段文本，Jaccard > 0.85 只留分数更高的一块
    .filter((item, _, arr) => {
      const toks = new Set(tokenize(item.text));
      return !arr.slice(0, arr.indexOf(item)).some((prev) => jaccard(new Set(tokenize(prev.text)), toks) > 0.85);
    });
}

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

/**
 * 把相关片段格式化为 ViMax scene_extractor 提示词里的 FRAGMENT 标签串。
 * 论文式(6) 的「不丢失信息」靠这一步把原著原文喂给下游场景/镜头智能体。
 */
export function formatFragments(fragments = [], max = 4) {
  const list = (fragments || []).slice(0, max);
  if (!list.length) return '';
  return [
    '<CONTEXT_FRAGMENTS_START>',
    ...list.map((f, i) => {
      const text = typeof f === 'string' ? f : f.text;
      return `<FRAGMENT_${i}_START>\n${String(text || '').slice(0, 512)}\n<FRAGMENT_${i}_END>`;
    }),
    '<CONTEXT_FRAGMENTS_END>',
  ].join('\n');
}
