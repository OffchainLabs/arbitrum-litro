// @ts-check

// The questions a testnode's metrics answer, as PromQL. The Grafana dashboards and `litro metrics
// summary` both build on these, so a person and an agent read the same number for the same
// question. Each takes the label selector to narrow it by: a dashboard variable such as
// `{chain=~"$chain"}`, or none for every series.

export const QUESTIONS = {
	rpcUp: (selector = "") => `litro_rpc_up${selector}`,
	headBlock: (selector = "") => `eth_exe_block_most_recent_number${selector}`,
	transactionsPerSecond: (selector = "") => `rate(litro_transactions_total${selector}[30s])`,
	failedTransactionsPerSecond: (selector = "") =>
		`rate(litro_failed_transactions_total${selector}[30s])`,
	secondsSinceLastTransaction: (selector = "") =>
		`time() - litro_last_user_transaction_timestamp_seconds${selector}`,
	arbosVersion: (selector = "") => `litro_arbos_version${selector}`,

	batchesPerMinute: (selector = "") => `increase(litro_rollup_batches${selector}[1m])`,
	secondsSinceLastBatch: (selector = "") =>
		`time() - litro_rollup_last_batch_timestamp_seconds${selector}`,
	depositsWaiting: (selector = "") => `litro_rollup_delayed_waiting${selector}`,
	oldestDepositWaitingSeconds: (selector = "") =>
		`time() - litro_rollup_oldest_delayed_waiting_timestamp_seconds${selector}`,
	secondsSinceAssertionCreated: (selector = "") =>
		`time() - litro_rollup_last_assertion_created_timestamp_seconds${selector}`,
	secondsSinceAssertionConfirmed: (selector = "") =>
		`time() - litro_rollup_last_assertion_confirmed_timestamp_seconds${selector}`,

	blocksBehindSequencer: (selector = "") =>
		`max by (chain) (chain_head_block) - on (chain) group_right chain_head_block${selector}`,
	cpuPercent: (selector = "") => `system_cpu_procload${selector}`,
	memoryBytes: (selector = "") => `system_memory_used${selector}`,

	fastFeedClients: (selector = "") => `litro_fast_feed_clients${selector}`,
	fastFeedUserTransactionsPerSecond: (selector = "") =>
		`rate(litro_fast_feed_user_frames_total${selector}[30s])`,
	/** @param {number} quantile */
	fastFeedLatencyMs: (quantile) =>
		`histogram_quantile(${quantile}, sum by (le) (rate(litro_fast_feed_delivery_latency_ms_bucket[1m])))`,
	fastFeedRejected: (selector = "") => `increase(litro_fast_feed_rejected_total${selector}[1m])`,
};
