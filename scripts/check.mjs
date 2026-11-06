#!/usr/bin/env node
/* 语法快查（零依赖）：node scripts/check.mjs
 * 遍历 server / electron / src / tests / public / scripts 全部源码执行 node --check，
 * 任一文件失败即非零退出。.js 按浏览器 ESM 走 stdin 校验（package.json 无 type 字段，
 * 直接对文件执行会被当作 CJS 解析而误报 import/export）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['server.mjs', 'electron', 'src', 'tests', 'public', 'scripts'];

function walk(rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return /\.(mjs|cjs|js)$/.test(rel) ? [rel] : [];
  const out = [];
  for (const f of fs.readdirSync(abs)) {
    if (f === 'node_modules' || f === 'release') continue;
    out.push(...walk(path.join(rel, f)));
  }
  return out;
}

const failed = [];
const files = TARGETS.flatMap(walk);
for (const rel of files) {
  const isJs = rel.endsWith('.js');           // 仅 public/*.js 是浏览器 ESM
  const res = spawnSync(process.execPath, isJs ? ['--input-type=module', '--check'] : ['--check'], {
    input: isJs ? fs.readFileSync(path.join(root, rel)) : undefined,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    failed.push({ rel, msg: (res.stderr || '').trim().split('\n').slice(0, 4).join('\n') });
  }
}

if (failed.length) {
  for (const f of failed) console.error(`✖ ${f.rel}\n${f.msg}\n`);
  console.error(`check 失败：${failed.length}/${files.length} 个文件`);
  process.exit(1);
}
console.log(`check 通过：${files.length} 个文件`);
