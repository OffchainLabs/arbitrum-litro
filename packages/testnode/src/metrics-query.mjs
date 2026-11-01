// @ts-check

// Read a running testnode's metrics back from its Prometheus, for `litro metrics` and so for
// agents: any PromQL query, the catalog of metrics with what each means, and a summary that
// answers the dashboards' questions (metrics-questions.mjs) in one JSON object.

import { QUESTIONS } from "./metrics-questions.mjs";

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
	// Prometheus answers its own errors in JSON (with a 4xx); anything else is a proxy or a crash.
	const body = /** @type {{ status: string; data?: unknown; error?: string }} */ (
		await response.json().catch(() => ({ status: "error", error: `HTTP ${response.status}` }))
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
 * What `litro metrics summary` answers, by section: the questions the dashboards ask, keyed by the
 * label that names each entry (a chain, a Nitro node), or flat for the Fast Feed relay.
 */
export const SUMMARY = {
	chains: {
		by: "chain",
		fields: {
			up: QUESTIONS.rpcUp(),
			headBlock: QUESTIONS.headBlock(),
			transactionsPerSecond: QUESTIONS.transactionsPerSecond(),
			failedTransactionsPerSecond: QUESTIONS.failedTransactionsPerSecond(),
			secondsSinceLastTransaction: QUESTIONS.secondsSinceLastTransaction(),
			arbosVersion: QUESTIONS.arbosVersion(),
		},
	},
	rollups: {
		by: "chain",
		fields: {
			batchesLastMinute: QUESTIONS.batchesPerMinute(),
			secondsSinceLastBatch: QUESTIONS.secondsSinceLastBatch(),
			depositsWaiting: QUESTIONS.depositsWaiting(),
			oldestDepositWaitingSeconds: QUESTIONS.oldestDepositWaitingSeconds(),
			secondsSinceAssertionCreated: QUESTIONS.secondsSinceAssertionCreated(),
			secondsSinceAssertionConfirmed: QUESTIONS.secondsSinceAssertionConfirmed(),
		},
	},
	nodes: {
		by: "node",
		fields: {
			blocksBehindSequencer: QUESTIONS.blocksBehindSequencer(),
			cpuPercent: QUESTIONS.cpuPercent(),
			memoryBytes: QUESTIONS.memoryBytes(),
		},
	},
	fastFeed: {
		fields: {
			clients: QUESTIONS.fastFeedClients(),
			userTransactionsPerSecond: QUESTIONS.fastFeedUserTransactionsPerSecond(),
			latencyP50Ms: QUESTIONS.fastFeedLatencyMs(0.5),
			latencyP99Ms: QUESTIONS.fastFeedLatencyMs(0.99),
			rejectedLastMinute: `sum(${QUESTIONS.fastFeedRejected()})`,
		},
	},
};

/** @typedef {Record<string, number | null>} SummaryFields */

/** @param {number | null} value */
const round = (value) => (value === null ? null : Math.round(value * 1000) / 1000);

/**
 * Each field's samples now.
 *
 * @param {string} baseUrl
 * @param {Record<string, string>} fields
 */
const answer = (baseUrl, fields) =>
	Promise.all(
		Object.entries(fields).map(async ([field, expr]) => ({
			field,
			samples: await queryInstant(baseUrl, expr),
		})),
	);

/**
 * One entry per value of the `by` label (a chain, a node), holding each field it has an answer for.
 *
 * @param {string} baseUrl
 * @param {{ by: string; fields: Record<string, string> }} section
 */
async function keyedSection(baseUrl, { by, fields }) {
	/** @type {Record<string, SummaryFields>} */
	const entries = {};
	for (const { field, samples } of await answer(baseUrl, fields)) {
		for (const sample of samples) {
			const key = sample.metric[by] ?? "unknown";
			entries[key] = { ...entries[key], [field]: round(sample.value) };
		}
	}
	return entries;
}

/**
 * @param {string} baseUrl
 * @param {Record<string, string>} fields
 */
async function flatSection(baseUrl, fields) {
	/** @type {SummaryFields} */
	const values = {};
	for (const { field, samples } of await answer(baseUrl, fields)) {
		for (const sample of samples) {
			values[field] = round(sample.value);
		}
	}
	return values;
}

/**
 * The testnode's state now. A chain, node or relay the testnode does not run (no L3, no Fast Feed)
 * leaves no entry, and a question with no answer yet leaves no field.
 *
 * @param {string} baseUrl
 */
export async function metricsSummary(baseUrl) {
	const [chains, rollups, nodes, fastFeed] = await Promise.all([
		keyedSection(baseUrl, SUMMARY.chains),
		keyedSection(baseUrl, SUMMARY.rollups),
		keyedSection(baseUrl, SUMMARY.nodes),
		flatSection(baseUrl, SUMMARY.fastFeed.fields),
	]);
	return { at: new Date().toISOString(), chains, rollups, nodes, fastFeed };
}
