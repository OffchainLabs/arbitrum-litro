#!/bin/sh
set -eu

CONFIG_ROOT="/opt/arbitrum-testnode/runtime-config"
DATA_ROOT="/opt/arbitrum-testnode/runtime"
VARIANT="${TESTNODE_VARIANT:-l2}"
NITRO_WASM_ROOTS="/home/user/nitro-legacy/machines,/home/user/target/machines"
PIDS=""
SEQUENCER_HTTP_API="net,web3,eth,txpool,debug"
SEQUENCER_TIMEBOOST_ARGS=""

start_background() {
	"$@" &
	PIDS="$PIDS $!"
}

cleanup() {
	for pid in $PIDS; do
		kill "$pid" 2>/dev/null || true
	done
	wait || true
}

monitor_pids() {
	while true; do
		for pid in $PIDS; do
			if ! kill -0 "$pid" 2>/dev/null; then
				wait "$pid" || true
				exit 1
			fi
		done
		sleep 1
	done
}

read_timeboost_auction_contract_address() {
	if [ -n "${TESTNODE_TIMEBOOST_AUCTION_CONTRACT_ADDRESS:-}" ]; then
		printf "%s" "$TESTNODE_TIMEBOOST_AUCTION_CONTRACT_ADDRESS"
		return
	fi
	if [ -f "$CONFIG_ROOT/timeboost-auction.json" ]; then
		jq -r '.auctionContract // empty' "$CONFIG_ROOT/timeboost-auction.json"
	fi
}

trap cleanup EXIT INT TERM

echo "state file: $DATA_ROOT/anvil-state"
ls -la "$DATA_ROOT/anvil-state" 2>&1 || echo "state file missing!"
echo "variant: $VARIANT"

if [ "${TESTNODE_PARENT_CHAIN_POLL_INTERVAL+x}" = "x" ]; then
	node /usr/local/bin/configure-parent-chain-poll-interval.mjs \
		"$CONFIG_ROOT" \
		"$TESTNODE_PARENT_CHAIN_POLL_INTERVAL"
fi

if [ "${TESTNODE_TIMEBOOST:-}" = "true" ]; then
	SEQUENCER_HTTP_API="$SEQUENCER_HTTP_API,timeboost,auctioneer"
	TIMEBOOST_AUCTION_CONTRACT_ADDRESS="$(read_timeboost_auction_contract_address)"
	: "${TIMEBOOST_AUCTION_CONTRACT_ADDRESS:?timeboost-auction.json or TESTNODE_TIMEBOOST_AUCTION_CONTRACT_ADDRESS is required when TESTNODE_TIMEBOOST=true}"
	: "${TESTNODE_TIMEBOOST_REDIS_URL:?TESTNODE_TIMEBOOST_REDIS_URL is required when TESTNODE_TIMEBOOST=true}"
	SEQUENCER_TIMEBOOST_ARGS="\
		--execution.sequencer.timeboost.enable \
		--execution.sequencer.timeboost.redis-url=$TESTNODE_TIMEBOOST_REDIS_URL \
		--execution.sequencer.timeboost.auction-contract-address=$TIMEBOOST_AUCTION_CONTRACT_ADDRESS \
		--execution.sequencer.timeboost.auctioneer-address=0x46225F4cee2b4A1d506C7f894bb3dAeB21BF1596"
	echo "timeboost: enabled with auction $TIMEBOOST_AUCTION_CONTRACT_ADDRESS"
else
	echo "timeboost: disabled"
fi

start_background /usr/local/bin/anvil \
	--host 0.0.0.0 \
	--port 8545 \
	--block-time 1 \
	--chain-id 1337 \
	--mnemonic "indoor dish desk flag debris potato excuse depart ticket judge file exit" \
	--load-state "$DATA_ROOT/anvil-state"

echo "waiting for anvil on port 8545..."
DEADLINE=$(($(date +%s) + 60))
while ! grep -q ":2161 " /proc/net/tcp 2>/dev/null; do
	if [ "$(date +%s)" -ge "$DEADLINE" ]; then
		echo "anvil did not start within 60s" >&2
		exit 1
	fi
	sleep 1
done
echo "anvil ready"

start_background env HOME="$DATA_ROOT/sequencer" /usr/local/bin/nitro \
	--validation.wasm.allowed-wasm-module-roots "$NITRO_WASM_ROOTS" \
	--conf.file="$CONFIG_ROOT/l2-nodeConfig.json" \
	--node.feed.output.enable \
	--node.feed.output.port=9642 \
	--node.dangerous.disable-blob-reader \
	--node.staker.enable=false \
	--http.addr=0.0.0.0 \
	--http.port=8547 \
	--http.api="$SEQUENCER_HTTP_API" \
	--http.corsdomain='*' \
	--http.vhosts='*' \
	--ws.addr=0.0.0.0 \
	--ws.port=8548 \
	--auth.port=8551 \
	$SEQUENCER_TIMEBOOST_ARGS

start_background env HOME="$DATA_ROOT/validator" /usr/local/bin/nitro \
	--validation.wasm.allowed-wasm-module-roots "$NITRO_WASM_ROOTS" \
	--conf.file="$CONFIG_ROOT/l2-nodeConfig.json" \
	--node.sequencer=false \
	--node.delayed-sequencer.enable=false \
	--node.dangerous.disable-blob-reader \
	--execution.sequencer.enable=false \
	--execution.forwarding-target=null \
	--node.staker.enable=true \
	--node.staker.use-smart-contract-wallet=true \
	--node.staker.disable-challenge=true \
	--node.staker.dangerous.without-block-validator \
	--node.staker.staker-interval=100ms \
	--node.staker.make-assertion-interval=100ms \
	--node.staker.confirmation-blocks=1 \
	--node.bold.check-staker-switch-interval=1s \
	--node.bold.rpc-block-number=latest \
	--node.bold.assertion-posting-interval=100ms \
	--node.bold.assertion-confirming-interval=100ms \
	--node.bold.assertion-scanning-interval=100ms \
	--node.bold.minimum-gap-to-parent-assertion=100ms \
	--node.bold.parent-chain-block-time=100ms \
	--http.addr=0.0.0.0 \
	--http.port=8647 \
	--http.api=net,web3,eth \
	--ws.addr=0.0.0.0 \
	--ws.port=8648 \
	--auth.port=8552

if [ "$VARIANT" != "l2" ]; then
	echo "waiting 10s for L2 sequencer to start..."
	sleep 10
	echo "L2 wait done, starting L3 node"

	start_background env HOME="$DATA_ROOT/l3node" /usr/local/bin/nitro \
		--validation.wasm.allowed-wasm-module-roots "$NITRO_WASM_ROOTS" \
		--conf.file="$CONFIG_ROOT/l3-nodeConfig.json" \
		--node.dangerous.disable-blob-reader \
		--node.bold.check-staker-switch-interval=1s \
		--node.staker.dangerous.without-block-validator \
		--http.addr=0.0.0.0 \
		--http.port=8549 \
		--http.api=net,web3,eth,txpool,debug \
		--http.corsdomain='*' \
		--http.vhosts='*' \
		--ws.addr=0.0.0.0 \
		--ws.port=8550 \
		--auth.port=8553
fi

# Legacy compat: make network files accessible at /tokenbridge-data/ for SDK's gen:network
mkdir -p /tokenbridge-data
ln -sf /opt/arbitrum-testnode/export-config/l1l2_network.json /tokenbridge-data/l1l2_network.json
ln -sf /opt/arbitrum-testnode/export-config/l2l3_network.json /tokenbridge-data/l2l3_network.json

# Serve config files and health endpoint over HTTP for service container consumers
start_background python3 /usr/local/bin/config-server.py 8080

monitor_pids
