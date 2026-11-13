#!/usr/bin/env bash
# Local development stack for the web app (WSL/Linux only; nothing touches a
# public network). See the header of devstack.ts.
#   bash server/scripts/devstack.sh
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACT_DIR="$SERVER_DIR/../contract"
TARGET="${CARGO_TARGET_DIR_BASE:-$HOME/target}"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

if [ "${DEVSTACK_BUILD_WASM:-1}" = "1" ]; then
  echo "== building contracts"
  (cd "$CONTRACT_DIR" && CARGO_TARGET_DIR="$TARGET/escrow" cargo near build non-reproducible-wasm >/dev/null 2>&1)
  (cd "$CONTRACT_DIR/mock-ft" && CARGO_TARGET_DIR="$TARGET/mock-ft" cargo near build non-reproducible-wasm --no-abi >/dev/null 2>&1)
fi
export ESCROW_WASM="$TARGET/escrow/near/escrow.wasm"
export FT_WASM="$TARGET/mock-ft/near/mock_ft.wasm"

if [ -z "${NEAR_SANDBOX_BIN:-}" ]; then
  NEAR_SANDBOX_BIN="$(find "$TARGET" -type f -name near-sandbox -path '*near-sandbox*' 2>/dev/null | head -1)"
fi
if [ -z "${NEAR_SANDBOX_BIN:-}" ]; then
  echo "near-sandbox binary not found: run the contract sandbox tests first or set NEAR_SANDBOX_BIN" >&2
  exit 1
fi
export NEAR_SANDBOX_BIN

cd "$SERVER_DIR"
# The compiled server is shared with other runs: build only when asked.
if [ "${DEVSTACK_BUILD_SERVER:-1}" = "1" ]; then npm run --silent build; fi
exec node --disable-warning=ExperimentalWarning dist/scripts/devstack.js
