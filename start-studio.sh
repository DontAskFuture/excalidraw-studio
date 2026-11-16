#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$ROOT_DIR/rust-server/dist"
BIN_PATH="$ROOT_DIR/rust-server/target/release/excalidraw-rust-server"

FORCE_BUILD=0
BUILD_ONLY=0
CUSTOM_HOST="${HOST:-127.0.0.1}"
CUSTOM_PORT="${PORT:-3001}"
CUSTOM_DATA_DIR="${EXCALIDRAW_DATA_DIR:-}"

usage() {
  cat <<'EOF'
Excalidraw Studio — Native Local Launcher (No Docker Required)

Usage:
  ./start-studio.sh [options]

Options:
  -b, --build             Rebuild Studio UI (Vite -> rust-server/dist) and Rust server
      --build-only        Rebuild Studio UI and Rust release binary, then exit
      --port <PORT>       Listen port (default: 3001, or $PORT)
      --host <HOST>       Bind host (default: 127.0.0.1, or $HOST)
      --data-dir <PATH>   Autosave root directory (default: rust-server/data, or $EXCALIDRAW_DATA_DIR)
  -h, --help              Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -b|--build)
      FORCE_BUILD=1
      shift
      ;;
    --build-only)
      FORCE_BUILD=1
      BUILD_ONLY=1
      shift
      ;;
    --port)
      CUSTOM_PORT="${2:?--port requires a value}"
      shift 2
      ;;
    --port=*)
      CUSTOM_PORT="${1#*=}"
      shift
      ;;
    --host)
      CUSTOM_HOST="${2:?--host requires a value}"
      shift 2
      ;;
    --host=*)
      CUSTOM_HOST="${1#*=}"
      shift
      ;;
    --data-dir)
      CUSTOM_DATA_DIR="${2:?--data-dir requires a value}"
      shift 2
      ;;
    --data-dir=*)
      CUSTOM_DATA_DIR="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

need_ui_build=0
if [[ "$FORCE_BUILD" -eq 1 || ! -f "$DIST_DIR/index.html" ]]; then
  need_ui_build=1
fi

need_rust_build=0
if [[ "$FORCE_BUILD" -eq 1 || ! -x "$BIN_PATH" ]]; then
  need_rust_build=1
fi

if [[ "$need_ui_build" -eq 1 ]]; then
  if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
    echo "Installing JavaScript dependencies (node_modules not found)..."
    if command -v yarn >/dev/null 2>&1; then
      (cd "$ROOT_DIR" && yarn install --ignore-engines)
    else
      (cd "$ROOT_DIR" && npm install)
    fi
  fi
  echo "Building Studio UI bundle -> rust-server/dist ..."
  (cd "$ROOT_DIR/studio-ui" && ../node_modules/.bin/tsc --noEmit && ../node_modules/.bin/vite build)
fi

if [[ "$need_rust_build" -eq 1 ]]; then
  if ! command -v cargo >/dev/null 2>&1; then
    echo "Error: 'cargo' (Rust toolchain) is not installed. Install via https://rustup.rs" >&2
    exit 1
  fi
  echo "Building Rust release server -> rust-server/target/release/excalidraw-rust-server ..."
  (cd "$ROOT_DIR/rust-server" && cargo build --release)
fi

if [[ "$BUILD_ONLY" -eq 1 ]]; then
  echo "Build complete:"
  echo "  UI bundle:   $DIST_DIR"
  echo "  Rust binary: $BIN_PATH"
  exit 0
fi

export HOST="$CUSTOM_HOST"
export PORT="$CUSTOM_PORT"
export EXCALIDRAW_DIST_DIR="${EXCALIDRAW_DIST_DIR:-$DIST_DIR}"
if [[ -n "$CUSTOM_DATA_DIR" ]]; then
  export EXCALIDRAW_DATA_DIR="$CUSTOM_DATA_DIR"
else
  export EXCALIDRAW_DATA_DIR="$ROOT_DIR/rust-server/data"
fi

echo "Starting Excalidraw Studio (native Rust server, no Docker):"
echo "  URL:      http://${HOST}:${PORT}"
echo "  Data dir: ${EXCALIDRAW_DATA_DIR}"
echo "  UI dist:  ${EXCALIDRAW_DIST_DIR}"

cd "$ROOT_DIR/rust-server"
exec "$BIN_PATH"
