#!/usr/bin/env bash
# Bundle the lambda source + node_modules into lambda-build/ for cdk deploy.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../lambda"
DEST="$HERE/lambda-build"

rm -rf "$DEST"
mkdir -p "$DEST"
cp "$SRC"/*.mjs "$SRC/package.json" "$DEST/"
# Canonical task schema lives at repo root; copy it into the bundle so
# lambda/task-schema.mjs can read it at runtime.
cp "$SRC/../task-schema.json" "$DEST/"
( cd "$DEST" && npm install --omit=dev --no-audit --no-fund --silent )
echo "lambda-build ready at $DEST"
