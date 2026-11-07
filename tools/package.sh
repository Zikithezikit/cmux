#!/bin/sh
# Builds dist/chrome-tmux-<version>.zip containing only what the extension
# needs at runtime (for the Chrome Web Store or sharing).
set -eu
cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
out="dist/chrome-tmux-$version.zip"
mkdir -p dist
rm -f "$out"
zip -qr "$out" manifest.json icons src -x '*.DS_Store' -x '*.ts'
echo "$out"
