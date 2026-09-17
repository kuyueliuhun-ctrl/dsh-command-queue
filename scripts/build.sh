#!/bin/bash
# dsh-command-queue 是手写 ESM/浏览器 bundle 插件：没有编译步骤，
# 因此 build 只做「语法校验 + 全套测试」。
#
# 客户端 bundle 的测试（tests/client-bundle.test.mjs）不是可选项：
# DSH 的 boot 审计没有 per-plugin 隔离，客户端 bundle 抛错会让整个 Web
# 应用无法 mount，所以每次改动都必须过这道闸。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Syntax check: lib/index.js (host) ==="
node --check lib/index.js

echo "=== Syntax check: lib/client.js (browser bundle) ==="
node --check lib/client.js

echo "=== Tests ==="
node --test tests/*.test.mjs

echo "=== Build complete ==="
echo "host:   $ROOT/lib/index.js ($(wc -c < lib/index.js) bytes)"
echo "client: $ROOT/lib/client.js ($(wc -c < lib/client.js) bytes)"
