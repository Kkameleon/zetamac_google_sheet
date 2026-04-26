#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT_DIR/extension"
DIST_DIR="$ROOT_DIR/dist"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to read extension/manifest.json" >&2
  exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "zip is required to build the .xpi package" >&2
  exit 1
fi

VERSION="$(jq -r '.version' "$EXT_DIR/manifest.json")"
OUT="$DIST_DIR/zetamac-google-sheet-$VERSION.xpi"

mkdir -p "$DIST_DIR"
rm -f "$OUT"

(
  cd "$EXT_DIR"
  zip -r "$OUT" . >/dev/null
)

echo "Built $OUT"
