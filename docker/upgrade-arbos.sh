#!/bin/sh
set -eu

# Upgrades a chain's ArbOS to at least TARGET as its chain owner, and waits until it runs it.
# A chain already on TARGET or later is left alone, so restarting a container is a no-op.
#
#   upgrade-arbos.sh <rpc-url> <target> <owner-key> <name>

RPC_URL="$1"
TARGET="$2"
OWNER_KEY="$3"
NAME="$4"
ARB_SYS=0x0000000000000000000000000000000000000064
ARB_OWNER=0x0000000000000000000000000000000000000070
# Well-known nitro-testnode funnel key (index 0), funded on every chain.
FUNNEL_KEY=0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659

arbos_version() {
	echo $(($(cast call --rpc-url "$RPC_URL" "$ARB_SYS" "arbOSVersion()(uint64)") - 55))
}

version="$(arbos_version)"
if [ "$version" -ge "$TARGET" ]; then
	echo "$NAME: ArbOS $version"
	exit 0
fi

owner="$(cast wallet address "$OWNER_KEY")"
if [ "$(cast balance --rpc-url "$RPC_URL" "$owner")" = "0" ]; then
	cast send --rpc-url "$RPC_URL" --private-key "$FUNNEL_KEY" --value 1ether "$owner" > /dev/null
fi
cast send --rpc-url "$RPC_URL" --private-key "$OWNER_KEY" \
	"$ARB_OWNER" "scheduleArbOSUpgrade(uint64,uint64)" "$TARGET" 0 > /dev/null
# A scheduled upgrade with timestamp 0 takes effect when the next block is built, and an idle
# sequencer builds no blocks, so nudge it with self-transfers until the version changes.
attempts=0
while [ "$(arbos_version)" -lt "$TARGET" ]; do
	attempts=$((attempts + 1))
	if [ "$attempts" -gt 60 ]; then
		echo "$NAME: ArbOS stayed at $(arbos_version), expected $TARGET" >&2
		exit 1
	fi
	cast send --async --rpc-url "$RPC_URL" --private-key "$OWNER_KEY" "$owner" > /dev/null
	sleep 0.5
done
echo "$NAME: upgraded ArbOS $version -> $(arbos_version)"
