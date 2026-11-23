#!/bin/sh
set -eu

CONFIG_ROOT="/opt/arbitrum-testnode/runtime-config"
DATA_ROOT="/opt/arbitrum-testnode/runtime"
VARIANT="${TESTNODE_VARIANT:-l2}"
NITRO_WASM_ROOTS="/home/user/nitro-legacy/machines,/home/user/target/machines"
SEQUENCER_HTTP_API="net,web3,eth,txpool,debug"
TESTNODE_BIN="/opt/arbitrum-testnode/bin"

. "$TESTNODE_BIN/processes.sh"

echo "state file: $DATA_ROOT/anvil-state"
ls -la "$DATA_ROOT/anvil-state" 2>&1 || echo "state file missing!"
echo "variant: $VARIANT"

# Nitro's 15s default is sized for Ethereum's 12s blocks. Here anvil makes a block every second and
# the L2 several, so at 15s each staker sees a new batch up to 15s late.
node /usr/local/bin/configure-parent-chain-poll-interval.mjs \
	"$CONFIG_ROOT" \
	"${TESTNODE_PARENT_CHAIN_POLL_INTERVAL:-250ms}"

. "$TESTNODE_BIN/sequencer-features.sh"
. "$TESTNODE_BIN/observability.sh"
# Probed once: the batch-size rename (see configure-sequencer.mjs) and each optional feature
# depend on which flags this Nitro build has.
NITRO_HELP="$(/usr/local/bin/nitro --help 2>&1 || true)"
if nitro_supports "--node.batch-poster.max-calldata-batch-size"; then
	RENAME_BATCH_MAX_SIZE=true
else
	RENAME_BATCH_MAX_SIZE=false
fi
# An nc2.1 (AnyTrust) L3 config carries data-availability L1 keys that Nitro >= v3.10 rejects.
if nitro_supports "--node.data-availability.parent-chain-node-url"; then
	DROP_DA_L1_KEYS=false
else
	DROP_DA_L1_KEYS=true
fi
node "$TESTNODE_BIN/configure-sequencer.mjs" "$CONFIG_ROOT" "$RENAME_BATCH_MAX_SIZE" "${TESTNODE_L2_MAX_BLOCK_SPEED:-}" "$DROP_DA_L1_KEYS"
sequencer_feature_args
# Recent Nitro rejects Stylus activation inside eth_call/eth_estimateGas unless this is set; contracts
# that activate programs in their constructor (e.g. StylusDeployer) need it to estimate gas.
STYLUS_ARGS=""
if nitro_supports "--execution.stylus-target.allow-offchain-activation"; then
	STYLUS_ARGS="--execution.stylus-target.allow-offchain-activation"
fi
# A BoLD staker asserts only batches its parent chain has finalized. anvil reports a block final
# 64 blocks (about a minute) after it is mined and never reorgs, so the wait buys nothing here.
STAKER_ARGS=""
if nitro_supports "--node.bold.state-provider-config.check-batch-finality"; then
	STAKER_ARGS="--node.bold.state-provider-config.check-batch-finality=false"
fi

start_background anvil /usr/local/bin/anvil \
	--host 0.0.0.0 \
	--port 8545 \
	--block-time "${TESTNODE_L1_BLOCK_TIME:-1}" \
	--chain-id 1337 \
	--mnemonic "indoor dish desk flag debris potato excuse depart ticket judge file exit" \
	--state "$DATA_ROOT/anvil-state/state.json" \
	--state-interval 1 \
	--max-persisted-states 128

echo "waiting for anvil on port 8545..."
# 8545 = 0x2161
wait_for_listen 2161 anvil
echo "anvil ready"

# anvil's block builder skips a transaction that does not fit the block's remaining gas, then drops
# a later transaction from the same sender for its nonce gap. At 30M, a burst of deploys from one
# account (arbitrum-chain-sdk's token bridge creator, ~36M) loses its last one. 100M avoids that.
# Set by RPC: anvil keeps the gas limit saved in the loaded state and ignores --gas-limit.
curl -sf -H 'content-type: application/json' \
	-d '{"jsonrpc":"2.0","id":1,"method":"evm_setBlockGasLimit","params":["0x5f5e100"]}' \
	http://127.0.0.1:8545 >/dev/null || {
	echo "anvil: evm_setBlockGasLimit failed" >&2
	exit 1
}

start_background sequencer env HOME="$DATA_ROOT/sequencer" /usr/local/bin/nitro \
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
	$SEQUENCER_FEATURE_ARGS \
	$STYLUS_ARGS \
	$(nitro_observability_args 6070 6071)

start_sequencer_features

start_background validator env HOME="$DATA_ROOT/validator" /usr/local/bin/nitro \
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
	$STAKER_ARGS \
	--http.addr=0.0.0.0 \
	--http.port=8647 \
	--http.api=net,web3,eth \
	--ws.addr=0.0.0.0 \
	--ws.port=8648 \
	--auth.port=8552 \
	$(nitro_observability_args 6072 6073)

if [ "$VARIANT" != "l2" ]; then
	# The L3 node's parent chain is the L2 sequencer, so start it once that answers.
	echo "waiting for L2 sequencer RPC..."
	wait_for_rpc http://127.0.0.1:8547
	echo "L2 wait done, starting L3 node"

	start_background l3 env HOME="$DATA_ROOT/l3node" /usr/local/bin/nitro \
		--validation.wasm.allowed-wasm-module-roots "$NITRO_WASM_ROOTS" \
		--conf.file="$CONFIG_ROOT/l3-nodeConfig.json" \
		--node.dangerous.disable-blob-reader \
		--node.bold.check-staker-switch-interval=1s \
		--node.staker.dangerous.without-block-validator \
		$STAKER_ARGS \
		--http.addr=0.0.0.0 \
		--http.port=8549 \
		--http.api=net,web3,eth,txpool,debug \
		--http.corsdomain='*' \
		--http.vhosts='*' \
		--ws.addr=0.0.0.0 \
		--ws.port=8550 \
		--auth.port=8553 \
		$STYLUS_ARGS \
		$(nitro_observability_args 6074 6075)
fi

# Legacy compat: make network files accessible at /tokenbridge-data/ for SDK's gen:network
mkdir -p /tokenbridge-data
ln -sf /opt/arbitrum-testnode/export-config/l1l2_network.json /tokenbridge-data/l1l2_network.json
ln -sf /opt/arbitrum-testnode/export-config/l2l3_network.json /tokenbridge-data/l2l3_network.json

start_observability

# Serve config files and health endpoint over HTTP for service container consumers
start_background config-server python3 /usr/local/bin/config-server.py 8080

monitor_pids
