#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export CANVAS_BACKEND_DATA_DIR="${CANVAS_BACKEND_DATA_DIR:-$ROOT_DIR/.local/project-workbench-debug}"

cd "$ROOT_DIR/backend"
exec env -u GOROOT go run ./cmd/server
