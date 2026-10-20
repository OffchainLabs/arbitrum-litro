# Optional L2 sequencer features: Timeboost, the Fast Feed, PGA rounds, and block speed.
# Sourced by testnode-entrypoint.sh, which calls sequencer_feature_args before starting the
# sequencer and start_sequencer_features once it is running. Each feature is read from its
# TESTNODE_* variable in exactly one place.

: "${TESTNODE_BIN:=/opt/arbitrum-testnode/bin}"
FAST_FEED_RELAY="$TESTNODE_BIN/fast-feed-relay.mjs"

nitro_supports() {
	printf "%s" "$NITRO_HELP" | grep -q -- "$1"
}

# Port numbers are matched in /proc/net/tcp as hex, in the LISTEN state (0A), so a client that is
# only connecting to the port does not count.
wait_for_listen() {
	port_hex="$1"
	name="$2"
	deadline=$(($(date +%s) + 60))
	while ! awk -v port=":$port_hex" '$2 ~ port "$" && $4 == "0A" { found = 1 } END { exit !found }' \
		/proc/net/tcp 2>/dev/null; do
		if [ "$(date +%s)" -ge "$deadline" ]; then
			echo "$name did not start within 60s" >&2
			exit 1
		fi
		sleep 1
	done
}

wait_for_rpc() {
	deadline=$(($(date +%s) + 60))
	while ! curl -sf -X POST -H 'Content-Type: application/json' \
		-d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$1" > /dev/null; do
		if [ "$(date +%s)" -ge "$deadline" ]; then
			echo "RPC at $1 did not start within 60s" >&2
			exit 1
		fi
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

require_nitro_flag() {
	if ! nitro_supports "$1"; then
		echo "$2: this Nitro has no $1; $3 needs Nitro >= v3.12" >&2
		exit 1
	fi
}

# Sets SEQUENCER_FEATURE_ARGS (extra sequencer flags) and extends SEQUENCER_HTTP_API.
sequencer_feature_args() {
	SEQUENCER_FEATURE_ARGS=""
	if [ "${TESTNODE_TIMEBOOST:-}" = "true" ]; then
		SEQUENCER_HTTP_API="$SEQUENCER_HTTP_API,timeboost,auctioneer"
		TIMEBOOST_AUCTION_CONTRACT_ADDRESS="$(read_timeboost_auction_contract_address)"
		: "${TIMEBOOST_AUCTION_CONTRACT_ADDRESS:?timeboost-auction.json or TESTNODE_TIMEBOOST_AUCTION_CONTRACT_ADDRESS is required when TESTNODE_TIMEBOOST=true}"
		: "${TESTNODE_TIMEBOOST_REDIS_URL:?TESTNODE_TIMEBOOST_REDIS_URL is required when TESTNODE_TIMEBOOST=true}"
		SEQUENCER_FEATURE_ARGS="$SEQUENCER_FEATURE_ARGS \
			--execution.sequencer.timeboost.enable \
			--execution.sequencer.timeboost.redis-url=$TESTNODE_TIMEBOOST_REDIS_URL \
			--execution.sequencer.timeboost.auction-contract-address=$TIMEBOOST_AUCTION_CONTRACT_ADDRESS \
			--execution.sequencer.timeboost.auctioneer-address=0x46225F4cee2b4A1d506C7f894bb3dAeB21BF1596"
		echo "timeboost: enabled with auction $TIMEBOOST_AUCTION_CONTRACT_ADDRESS"
	else
		echo "timeboost: disabled"
	fi

	# The Fast Feed is Nitro's transaction feed behind an authenticating relay. Nitro serves the
	# raw feed on loopback only; the relay owns the published port.
	if [ "${TESTNODE_FAST_FEED:-}" = "true" ]; then
		require_nitro_flag "--execution.transaction-feed.enable" "fast feed" TESTNODE_FAST_FEED
		if [ ! -f "$FAST_FEED_RELAY" ]; then
			echo "fast feed: $FAST_FEED_RELAY is missing; this testnode image predates Fast Feed support" >&2
			exit 1
		fi
		SEQUENCER_FEATURE_ARGS="$SEQUENCER_FEATURE_ARGS \
			--execution.transaction-feed.enable \
			--execution.transaction-feed.addr=127.0.0.1 \
			--execution.transaction-feed.port=19646"
		echo "fast feed: enabled"
	else
		echo "fast feed: disabled"
	fi

	if [ -n "${TESTNODE_PGA_ROUNDS_PER_BLOCK:-}" ]; then
		require_nitro_flag "--execution.sequencer.pga.rounds-per-block" pga TESTNODE_PGA_ROUNDS_PER_BLOCK
		SEQUENCER_FEATURE_ARGS="$SEQUENCER_FEATURE_ARGS \
			--execution.sequencer.pga.rounds-per-block=$TESTNODE_PGA_ROUNDS_PER_BLOCK"
		echo "pga: $TESTNODE_PGA_ROUNDS_PER_BLOCK rounds per block"
	fi
}

# Starts what runs beside the sequencer and finishes chain setup. Returns once each feature is
# ready, so the config server (and with it the container healthcheck) starts only after them.
start_sequencer_features() {
	if [ "${TESTNODE_FAST_FEED:-}" = "true" ]; then
		start_background node "$FAST_FEED_RELAY"
		# 9646 = 0x25AE
		wait_for_listen 25AE "fast feed relay"
	fi
	if [ -n "${TESTNODE_PGA_ROUNDS_PER_BLOCK:-}" ]; then
		wait_for_rpc http://127.0.0.1:8547
		PATH="$TESTNODE_BIN:$PATH" "$TESTNODE_BIN/configure-pga.sh" http://127.0.0.1:8547
	fi
}
