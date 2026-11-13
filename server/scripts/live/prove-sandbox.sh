#!/usr/bin/env bash
# Dry run of the live-test kit against a local sandbox (WSL, no network).
#   bash -lc 'bash server/scripts/live/prove-sandbox.sh'
set -euo pipefail
SERVER_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CONTRACT_DIR="$SERVER_DIR/../contract"
TARGET="${CARGO_TARGET_DIR_BASE:-$HOME/target}"
(cd "$CONTRACT_DIR" && CARGO_TARGET_DIR="$TARGET/escrow" cargo near build non-reproducible-wasm >/dev/null 2>&1)
(cd "$CONTRACT_DIR/mock-ft" && CARGO_TARGET_DIR="$TARGET/mock-ft" cargo near build non-reproducible-wasm --no-abi >/dev/null 2>&1)
export ESCROW_WASM="$TARGET/escrow/near/escrow.wasm"
export FT_WASM="$TARGET/mock-ft/near/mock_ft.wasm"
export NEAR_SANDBOX_BIN="${NEAR_SANDBOX_BIN:-$(find "$TARGET" -type f -name near-sandbox -path '*near-sandbox*' 2>/dev/null | head -1)}"
[ -n "$NEAR_SANDBOX_BIN" ] || { echo "near-sandbox binary not found (run the contract sandbox tests once)"; exit 1; }
cd "$SERVER_DIR"
npm run --silent build
node --disable-warning=ExperimentalWarning dist/scripts/live/prove-sandbox.js
