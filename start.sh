#!/usr/bin/env bash
# lingximanju 一键启动（零依赖，无需 npm install）
set -e
cd "$(dirname "$0")"
export PORT="${PORT:-45367}"
echo "启动 lingximanju → http://127.0.0.1:${PORT}"
echo "（若该端口被占用会自动向后顺延，实际地址以控制台输出与 data/.port 为准）"
exec node server.mjs
