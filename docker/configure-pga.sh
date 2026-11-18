#!/bin/sh
set -eu

# Turns on priority gas auction (PGA) ordering on the L2 sequencer, as Arbitrum One runs it.
# PGA engages only when the chain is on ArbOS 60+ and collects tips. The image upgrades ArbOS at
# boot (upgrade_arbos in sequencer-features.sh); a chain left on an older version, such as a
# rebased image with no default, is upgraded to 60 here. Then the chain owner enables tip
# collection. Both steps are idempotent, so restarting a container that already ran them is a
# no-op.

RPC_URL="${1:-http://127.0.0.1:8547}"
ARB_OWNER=0x0000000000000000000000000000000000000070
ARB_OWNER_PUBLIC=0x000000000000000000000000000000000000006b
# Well-known nitro-testnode key: index 5 is the L2 chain owner.
L2_OWNER_KEY=0xdc04c5399f82306ec4b4d654a342f40e2e0620fe39950d967e1e574b32d4dd36

"$(dirname "$0")/upgrade-arbos.sh" "$RPC_URL" 60 "$L2_OWNER_KEY" pga

if [ "$(cast call --rpc-url "$RPC_URL" "$ARB_OWNER_PUBLIC" "getCollectTips()(bool)")" != "true" ]; then
	cast send --rpc-url "$RPC_URL" --private-key "$L2_OWNER_KEY" \
		"$ARB_OWNER" "setCollectTips(bool)" true > /dev/null
fi
echo "pga: collectTips $(cast call --rpc-url "$RPC_URL" "$ARB_OWNER_PUBLIC" "getCollectTips()(bool)")"
