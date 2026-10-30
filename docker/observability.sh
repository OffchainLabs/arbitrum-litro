# Metrics for every process in the testnode: Nitro's Prometheus endpoint and pprof on each Nitro
# node, and the chain exporter, which covers the L1 (Anvil has no metrics) and rollup activity.
# Sourced by testnode-entrypoint.sh. Each switch is read from its TESTNODE_* variable here only.

: "${TESTNODE_BIN:=/opt/arbitrum-testnode/bin}"

# nitro_observability_args <metrics-port> <pprof-port>: the flags for one Nitro process.
nitro_observability_args() {
	args=""
	if [ "${TESTNODE_METRICS:-}" = "true" ]; then
		args="--metrics --metrics-server.addr=0.0.0.0 --metrics-server.port=$1"
	fi
	if [ "${TESTNODE_PPROF:-}" = "true" ]; then
		args="$args --pprof --pprof-cfg.addr=0.0.0.0 --pprof-cfg.port=$2"
	fi
	printf "%s" "$args"
}

start_observability() {
	if [ "${TESTNODE_METRICS:-}" = "true" ]; then
		start_background node "$TESTNODE_BIN/chain-exporter.mjs"
	fi
}
