#!/usr/bin/env bash
# Writes the env file of the marketplace DEV instance (port 8788, throwaway DB)
# once. It reads the live TEST contract but can never send a transaction: the
# relayer is a fresh random key of an account that does not exist.
#   bash server/scripts/market-dev-env.sh
# Start it (attached to the caller, logs to the home folder):
#   cd server && ENV_FILE=$HOME/pinky-market-dev/server.env \
#     node --disable-warning=ExperimentalWarning dist/src/main.js >> $HOME/pinky-market-dev/server.log 2>&1
set -euo pipefail
HOME_DIR="${MARKET_DEV_HOME:-$HOME/pinky-market-dev}"
mkdir -p "$HOME_DIR"
cd "$(dirname "$0")/.."
if [ -f "$HOME_DIR/server.env" ]; then echo "exists: $HOME_DIR/server.env"; exit 0; fi
KEY=$(node --input-type=module -e 'import { KeyPair } from "near-api-js"; console.log(KeyPair.fromRandom("ed25519").toString());')
umask 077
cat > "$HOME_DIR/server.env" <<EOF
# Marketplace DEV instance (throwaway DB). Reads the LIVE TEST contract
# (read-only); can NOT send: the relayer account below does not exist.
NEAR_NETWORK=mainnet
NEAR_RPC_URL=https://near.drpc.org
ESCROW_CONTRACT_ID=9e537c21716b2035d7c88f153f0283e8dda925af16bbb6cf6ea23256436c2c9c
RELAYER_ACCOUNT_ID=pinky-market-dev-cannot-send.near
RELAYER_PRIVATE_KEY=$KEY
ONECLICK_FORCE_DRY=true
PORT=8788
HOST=127.0.0.1
DB_PATH=$HOME_DIR/market-dev.sqlite
MIN_REVIEW_PERIOD_SECONDS=300
EOF
echo "written: $HOME_DIR/server.env"
