// @ts-check

// Read a running testnode's metrics back from its Prometheus, for `litro metrics` and so for
// agents: any PromQL query, the catalog of metrics with what each means, and a summary that
// answers the dashboards' questions in one JSON object.

/**
 * @typedef {Record<string, string>} Labels
 * @typedef {{ metric: Labels; value: number | null }} InstantSample
 * @typedef {{ metric: Labels; points: Array<{ time: string; value: number | null }> }} RangeSeries
 */

const DURATION_UNITS = { s: 1, m: 60, h: 3600, d: 86_400 };

/**
 * Seconds in a duration such as `30s`, `15m`, `2h` or `1d`.
 *
 * @param {string} value
 * @param {string} name the option it came from, for the error
 */
export function parseDuration(value, name) {
	const match = /^(\d+)([smhd])$/.exec(value.trim());
	if (!match) {
		throw new Error(`${name} must look like 30s, 15m, 2h or 1d, got ${value}`);
	}
	return Number(match[1]) * DURATION_UNITS[/** @type {keyof typeof DURATION_UNITS} */ (match[2])];
}

/** Prometheus encodes sample values as strings; NaN and ±Inf become null, which JSON can carry. */
const sampleValue = (/** @type {string} */ raw) => {
	const value = Number(raw);
	return Number.isFinite(value) ? value : null;
};

/**
 * @param {string} baseUrl
 * @param {string} path
 * @param {Record<string, string>} params
 * @returns {Promise<any>}
 */
async function prometheus(baseUrl, path, params) {
	const response = await fetch(`${baseUrl}${path}?${new URLSearchParams(params)}`);
	const body = /** @type {{ status: string; data?: unknown; error?: string }} */ (
		await response.json()
	);
	if (body.status !== "success") {
		throw new Error(`Prometheus: ${body.error ?? response.statusText}`);
	}
	return body.data;
}

/**
 * The value of each series a query returns now.
 *
 * @param {string} baseUrl
 * @param {string} promql
 * @returns {Promise<InstantSample[]>}
 */
export async function queryInstant(baseUrl, promql) {
	const data = await prometheus(baseUrl, "/api/v1/query", { query: promql });
	if (data.resultType === "scalar") {
		return [{ metric: {}, value: sampleValue(data.result[1]) }];
	}
	return data.result.map((/** @type {{ metric: Labels; value: [number, string] }} */ series) => ({
		metric: series.metric,
		value: sampleValue(series.value[1]),
	}));
}

/**
 * Each series a query returns over the last `sinceSeconds`, one point per `stepSeconds`.
 *
 * @param {string} baseUrl
 * @param {string} promql
 * @param {{ sinceSeconds: number; stepSeconds: number; now?: number }} window
 * @returns {Promise<RangeSeries[]>}
 */
export async function queryRange(
	baseUrl,
	promql,
	{ sinceSeconds, stepSeconds, now = Date.now() / 1000 },
) {
	const data = await prometheus(baseUrl, "/api/v1/query_range", {
		query: promql,
		start: String(now - sinceSeconds),
		end: String(now),
		step: String(stepSeconds),
	});
	return data.result.map(
		(/** @type {{ metric: Labels; values: Array<[number, string]> }} */ series) => ({
			metric: series.metric,
			points: series.values.map(([time, raw]) => ({
				time: new Date(time * 1000).toISOString(),
				value: sampleValue(raw),
			})),
		}),
	);
}

/**
 * Every metric Prometheus scrapes whose name matches `filter`, with its type, description and the
 * sources (`job`, and `node` for Nitro) that report it.
 *
 * @param {string} baseUrl
 * @param {string} [filter] a regex matched against the whole name
 */
export async function listMetrics(baseUrl, filter = ".*") {
	const pattern = new RegExp(`^(?:${filter})$`);
	/** @type {Array<{ target: Labels; metric: string; type: string; help: string }>} */
	const entries = await prometheus(baseUrl, "/api/v1/targets/metadata", {
		match_target: '{job=~".+"}',
	});
	/** @type {Map<string, { name: string; type: string; help: string; sources: Set<string> }>} */
	const metrics = new Map();
	for (const entry of entries.filter((item) => pattern.test(item.metric))) {
		const known = metrics.get(entry.metric) ?? {
			name: entry.metric,
			type: entry.type,
			help: entry.help,
			sources: new Set(),
		};
		known.sources.add(entry.target["node"] ?? entry.target["job"] ?? "");
		metrics.set(entry.metric, known);
	}
	return [...metrics.values()]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((metric) => ({ ...metric, sources: [...metric.sources].sort() }));
}

/**
 * The dashboards' questions as queries: where each answer goes in the summary, which label names
 * its entry, and the PromQL. Rates cover the last minute.
 *
 * @type {Array<{ section: "chains" | "rollups" | "nodes" | "fastFeed"; by?: string; field: string; expr: string }>}
 */
export const SUMMARY_QUERIES = [
	{ section: "chains", by: "chain", field: "up", expr: "litro_rpc_up" },
	{ section: "chains", by: "chain", field: "headBlock", expr: "eth_exe_block_most_recent_number" },
	{
		section: "chains",
		by: "chain",
		field: "transactionsPerSecond",
		expr: "rate(litro_transactions_total[1m])",
	},
	{
		section: "chains",
		by: "chain",
		field: "failedTransactionsPerSecond",
		expr: "rate(litro_failed_transactions_total[1m])",
	},
	{
		section: "chains",
		by: "chain",
		field: "secondsSinceLastTransaction",
		expr: "time() - litro_last_user_transaction_timestamp_seconds",
	},
	{ section: "chains", by: "chain", field: "arbosVersion", expr: "litro_arbos_version" },
	{
		section: "rollups",
		by: "chain",
		field: "batchesLastMinute",
		expr: "increase(litro_rollup_batches[1m])",
	},
	{
		section: "rollups",
		by: "chain",
		field: "secondsSinceLastBatch",
		expr: "time() - litro_rollup_last_batch_timestamp_seconds",
	},
	{
		section: "rollups",
		by: "chain",
		field: "depositsWaiting",
		expr: "litro_rollup_delayed_waiting",
	},
	{
		section: "rollups",
		by: "chain",
		field: "oldestDepositWaitingSeconds",
		expr: "time() - litro_rollup_oldest_delayed_waiting_timestamp_seconds",
	},
	{
		section: "rollups",
		by: "chain",
		field: "secondsSinceAssertionCreated",
		expr: "time() - litro_rollup_last_assertion_created_timestamp_seconds",
	},
	{
		section: "rollups",
		by: "chain",
		field: "secondsSinceAssertionConfirmed",
		expr: "time() - litro_rollup_last_assertion_confirmed_timestamp_seconds",
	},
	{
		section: "nodes",
		by: "node",
		field: "blocksBehindSequencer",
		expr: "max by (chain) (chain_head_block) - on (chain) group_right chain_head_block",
	},
	{ section: "nodes", by: "node", field: "cpuPercent", expr: "system_cpu_procload" },
	{ section: "nodes", by: "node", field: "memoryBytes", expr: "system_memory_used" },
	{ section: "fastFeed", field: "clients", expr: "litro_fast_feed_clients" },
	{
		section: "fastFeed",
		field: "userTransactionsPerSecond",
		expr: "rate(litro_fast_feed_user_frames_total[1m])",
	},
	{
		section: "fastFeed",
		field: "latencyP50Ms",
		expr: "histogram_quantile(0.5, sum by (le) (rate(litro_fast_feed_delivery_latency_ms_bucket[5m])))",
	},
	{
		section: "fastFeed",
		field: "latencyP99Ms",
		expr: "histogram_quantile(0.99, sum by (le) (rate(litro_fast_feed_delivery_latency_ms_bucket[5m])))",
	},
	{
		section: "fastFeed",
		field: "rejectedLast5m",
		expr: "sum(increase(litro_fast_feed_rejected_total[5m]))",
	},
];

/**
 * @typedef {Record<string, number | null>} SummaryFields
 * @typedef {{
 *   at: string;
 *   chains: Record<string, SummaryFields>;
 *   rollups: Record<string, SummaryFields>;
 *   nodes: Record<string, SummaryFields>;
 *   fastFeed: SummaryFields;
 * }} MetricsSummary
 */

/**
 * The fields a summary answer goes in: the section itself, or its entry for one chain or node.
 *
 * @param {Record<string, any>} section
 * @param {string | undefined} key
 * @returns {SummaryFields}
 */
function summaryFields(section, key) {
	if (key === undefined) {
		return section;
	}
	if (!section[key]) {
		section[key] = {};
	}
	return section[key];
}

/** @param {number | null} value */
const round = (value) => (value === null ? null : Math.round(value * 1000) / 1000);

/**
 * The testnode's state now, by section: `chains` and `rollups` keyed by chain, `nodes` by Nitro
 * node, `fastFeed` flat. A chain, node or relay the testnode does not run (no L3, no Fast Feed)
 * leaves no entry, and a question with no answer yet leaves no field.
 *
 * @param {string} baseUrl
 * @returns {Promise<MetricsSummary>}
 */
export async function metricsSummary(baseUrl) {
	const answers = await Promise.all(
		SUMMARY_QUERIES.map(async (query) => ({
			query,
			samples: await queryInstant(baseUrl, query.expr),
		})),
	);
	/** @type {MetricsSummary} */
	const summary = {
		at: new Date().toISOString(),
		chains: {},
		rollups: {},
		nodes: {},
		fastFeed: {},
	};
	for (const { query, samples } of answers) {
		for (const sample of samples) {
			const fields = summaryFields(
				summary[query.section],
				query.by ? (sample.metric[query.by] ?? "unknown") : undefined,
			);
			fields[query.field] = round(sample.value);
		}
	}
	return summary;
}
