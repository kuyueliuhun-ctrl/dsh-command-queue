#!/bin/bash
# dsh-command-queue 是手写 ESM JavaScript 插件：没有编译步骤，
# 因此 build 只做「语法校验 + 单元测试 + 产物存在性」三道检查。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Syntax check: lib/index.js ==="
node --check lib/index.js

echo "=== Unit tests ==="
node --test tests/*.test.mjs

echo "=== Build complete ==="
echo "entry: $ROOT/lib/index.js ($(wc -c < lib/index.js) bytes)"
