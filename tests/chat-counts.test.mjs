/* ============================================================================
 * 统一 AI 对话的前端计数（chat-counts.js）· 单元测试
 *
 * 关键契约：前端徽标算出来的条数，必须与服务端 threadCounts() **完全一致**——
 * 否则用户会看到「💬 对话 · 3」但统一面板里只有 2 条。
 *
 * 运行：node --test tests/chat-counts.test.mjs
 * ==========================================================================*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chatCounts, chatCount, CHAT_STEP_SCOPES, CHAT_NEW_SCOPES } from '../public/chat-counts.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxmj-chatcounts-'));
process.env.LINGXIMANJU_DATA_DIR = TMP;

const { buildNovelProject } = await import('../src/pipelines/novel-project.mjs');
const { saveProject } = await import('../src/core/store.mjs');
const { ensureManagement } = await import('../src/core/project-steps.mjs');
const { threadCounts, appendAiMessage, commitAiScope } = await import('../src/core/ai-thread.mjs');

test('chatCounts：空项目全为 0', () => {
  const c = chatCounts({});
  assert.equal(c.all, 0);
  for (const id of [...CHAT_STEP_SCOPES, 'project', ...CHAT_NEW_SCOPES]) {
    assert.equal(c[id], 0, `${id} 应为 0`);
  }
});

test('chatCounts：分步会话 / 制片会话 / 新增档位都计入，总数一致', () => {
  const m = {
    stepChats: {
      script: { messages: [{ seq: 1 }, { seq: 2 }] },
      upload: { messages: [{ seq: 1 }] },
      project: { messages: [{ seq: 1 }] },      // 旧制片助理
    },
    conversation: { messages: [{ seq: 1 }, { seq: 2 }] },  // 制片助手
    aiScopes: {
      cover: { messages: [{ seq: 1 }, { seq: 2 }, { seq: 3 }] },
      style: { messages: [{ seq: 1 }] },
    },
  };
  const c = chatCounts(m);
  assert.equal(c.script, 2);
  assert.equal(c.upload, 1);
  assert.equal(c.project, 3, '总览档 = 旧制片助理 + 制片助手');
  assert.equal(c.cover, 3);
  assert.equal(c.style, 1);
  assert.equal(c.canvas, 0);
  assert.equal(c.all, 2 + 1 + 3 + 3 + 1);
});

test('chatCount：单档位取值', () => {
  const m = { stepChats: { script: { messages: [{}, {}] } } };
  assert.equal(chatCount(m, 'script'), 2);
  assert.equal(chatCount(m, 'project'), 0);
  assert.equal(chatCount(m, '不存在的档位'), 0);
});

test('前后端口径一致：前端 chatCounts == 服务端 threadCounts', async () => {
  const { project } = buildNovelProject({ name: '计数口径' });
  const m = ensureManagement(project);
  // 造出各档位的历史
  m.stepChats.script = { schema: 1, stepId: 'script', messages: [{ seq: 1 }, { seq: 2 }], tokens: {} };
  m.stepChats.project = { schema: 1, stepId: 'project', messages: [{ seq: 1 }], tokens: {} };
  m.conversation = { schema: 1, startedAt: Date.now(), messages: [{ seq: 1 }, { seq: 2 }], runs: [] };
  appendAiMessage(project, 'cover', { role: 'user', text: '封面' });
  appendAiMessage(project, 'canvas', { role: 'user', text: '画布' });
  commitAiScope(project, 'cover');
  saveProject(project);

  const front = chatCounts(m);
  const back = threadCounts(project);
  for (const id of [...CHAT_STEP_SCOPES, 'project', ...CHAT_NEW_SCOPES]) {
    assert.equal(front[id], back[id], `${id} 前后端口径不一致`);
  }
  assert.equal(front.all, back.all);
});

test('脏数据不炸：消息不是数组时按 0 计', () => {
  const c = chatCounts({ stepChats: { script: { messages: 'not-array' } }, aiScopes: { cover: null } });
  assert.equal(c.script, 0);
  assert.equal(c.cover, 0);
});
