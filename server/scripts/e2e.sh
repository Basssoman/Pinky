#!/usr/bin/env bash
# Local end-to-end run (WSL/Linux only; nothing touches a public network).
#   bash server/scripts/e2e.sh
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACT_DIR="$SERVER_DIR/../contract"
TARGET="${CARGO_TARGET_DIR_BASE:-$HOME/target}"

echo "== building contracts"
(cd "$CONTRACT_DIR" && CARGO_TARGET_DIR="$TARGET/escrow" cargo near build non-reproducible-wasm >/dev/null 2>&1)
(cd "$CONTRACT_DIR/mock-ft" && CARGO_TARGET_DIR="$TARGET/mock-ft" cargo near build non-reproducible-wasm --no-abi >/dev/null 2>&1)
export ESCROW_WASM="$TARGET/escrow/near/escrow.wasm"
export FT_WASM="$TARGET/mock-ft/near/mock_ft.wasm"

if [ -z "${NEAR_SANDBOX_BIN:-}" ]; then
  # The near-sandbox binary is downloaded by the contract's sandbox tests
  # (`cargo test --test sandbox`); reuse it.
  NEAR_SANDBOX_BIN="$(find "$TARGET" -type f -name near-sandbox -path '*near-sandbox*' 2>/dev/null | head -1)"
fi
if [ -z "${NEAR_SANDBOX_BIN:-}" ]; then
  echo "near-sandbox binary not found: run the contract sandbox tests first or set NEAR_SANDBOX_BIN" >&2
  exit 1
fi
export NEAR_SANDBOX_BIN
echo "== sandbox: $NEAR_SANDBOX_BIN"

cd "$SERVER_DIR"
npm run --silent build
node --disable-warning=ExperimentalWarning dist/scripts/e2e.js
