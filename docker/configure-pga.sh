#!/bin/sh
set -eu

# Turns on priority gas auction (PGA) ordering on the L2 sequencer, as Arbitrum One runs it.
# PGA engages only when the chain is on ArbOS 60+ and collects tips; litro snapshots are
# created on ArbOS 40, so the chain owner upgrades ArbOS and enables tip collection here.
# Both calls are idempotent, so restarting a container that already ran them is a no-op.

RPC_URL="${1:-http://127.0.0.1:8547}"
TARGET_ARBOS_VERSION="${TESTNODE_PGA_ARBOS_VERSION:-60}"
ARB_SYS=0x0000000000000000000000000000000000000064
ARB_OWNER=0x0000000000000000000000000000000000000070
ARB_OWNER_PUBLIC=0x000000000000000000000000000000000000006b
# Well-known nitro-testnode keys (index 5 is the L2 chain owner, index 0 the funnel).
L2_OWNER_KEY=0xdc04c5399f82306ec4b4d654a342f40e2e0620fe39950d967e1e574b32d4dd36
L2_OWNER=0x5E1497dD1f08C87b2d8FE23e9AAB6c1De833D927
FUNNEL_KEY=0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659

send() {
	cast send --async --rpc-url "$RPC_URL" --private-key "$@" > /dev/null
}

arbos_version() {
	echo $(($(cast call --rpc-url "$RPC_URL" "$ARB_SYS" "arbOSVersion()(uint64)") - 55))
}

if [ "$(cast balance --rpc-url "$RPC_URL" "$L2_OWNER")" = "0" ]; then
	cast send --rpc-url "$RPC_URL" --private-key "$FUNNEL_KEY" --value 1ether "$L2_OWNER" > /dev/null
fi

version="$(arbos_version)"
if [ "$version" -lt "$TARGET_ARBOS_VERSION" ]; then
	cast send --rpc-url "$RPC_URL" --private-key "$L2_OWNER_KEY" \
		"$ARB_OWNER" "scheduleArbOSUpgrade(uint64,uint64)" "$TARGET_ARBOS_VERSION" 0 > /dev/null
	# A scheduled upgrade with timestamp 0 takes effect when the next block is built, and an idle
	# sequencer builds no blocks, so nudge it with self-transfers until the version changes.
	attempts=0
	while [ "$(arbos_version)" -lt "$TARGET_ARBOS_VERSION" ]; do
		attempts=$((attempts + 1))
		if [ "$attempts" -gt 60 ]; then
			echo "pga: ArbOS stayed at $(arbos_version), expected $TARGET_ARBOS_VERSION" >&2
			exit 1
		fi
		send "$L2_OWNER_KEY" "$L2_OWNER"
		sleep 0.5
	done
	echo "pga: upgraded ArbOS $version -> $(arbos_version)"
fi

if [ "$(cast call --rpc-url "$RPC_URL" "$ARB_OWNER_PUBLIC" "getCollectTips()(bool)")" != "true" ]; then
	cast send --rpc-url "$RPC_URL" --private-key "$L2_OWNER_KEY" \
		"$ARB_OWNER" "setCollectTips(bool)" true > /dev/null
fi
echo "pga: ArbOS $(arbos_version), collectTips $(cast call --rpc-url "$RPC_URL" "$ARB_OWNER_PUBLIC" "getCollectTips()(bool)")"
