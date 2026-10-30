// @ts-check

// Builds litro's Grafana dashboards (metrics/dashboards/*.json) from the specs below, so every
// panel shares one layout and datasource. test/metrics-dashboards.test.ts fails when the committed
// JSON differs from what this writes:
//
//   node metrics/build-dashboards.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DATASOURCE = { type: "prometheus", uid: "prometheus" };

/**
 * @typedef {{ expr: string; legend?: string }} Query
 * @typedef {{
 *   title: string; description: string; queries: Query[];
 *   kind?: "timeseries" | "stat"; unit?: string; width?: number; height?: number;
 *   stack?: boolean; decimals?: number;
 * }} PanelSpec
 * @typedef {{ row: string; collapsed?: boolean } | PanelSpec} Item
 * @typedef {{ name: string; label?: string; query: string; multi?: boolean; textbox?: string }} VariableSpec
 * @typedef {{ uid: string; title: string; description: string; tags: string[]; variables: VariableSpec[]; items: Item[]; repeat?: { variable: string; panel: PanelSpec } }} DashboardSpec
 * @typedef {{
 *   id: number; type: string; title: string; description?: string;
 *   gridPos: { x: number; y: number; w: number; h: number };
 *   targets?: Array<{ expr: string }>; [key: string]: unknown;
 * }} GrafanaPanel
 */

/** @param {PanelSpec} spec */
function fieldDefaults(spec) {
	return {
		unit: spec.unit ?? "short",
		// Every metric here is a count, rate, size or duration, so axes start at zero.
		...((spec.kind ?? "timeseries") === "timeseries" ? { min: 0 } : {}),
		...(spec.decimals === undefined ? {} : { decimals: spec.decimals }),
		...((spec.kind ?? "timeseries") === "timeseries"
			? {
					custom: {
						lineWidth: 2,
						fillOpacity: spec.stack ? 30 : 10,
						stacking: { mode: spec.stack ? "normal" : "none" },
						showPoints: "never",
					},
				}
			: {}),
	};
}

/** @param {"timeseries" | "stat"} kind */
function panelOptions(kind) {
	return kind === "stat"
		? {
				reduceOptions: { calcs: ["lastNotNull"], values: false },
				textMode: "value_and_name",
				colorMode: "none",
				graphMode: "none",
			}
		: {
				legend: { displayMode: "list", placement: "bottom" },
				tooltip: { mode: "multi", sort: "desc" },
			};
}

/**
 * @param {PanelSpec} spec
 * @param {{ x: number; y: number }} at
 * @param {number} id
 * @returns {GrafanaPanel}
 */
function panel(spec, at, id) {
	const kind = spec.kind ?? "timeseries";
	return {
		id,
		type: kind,
		title: spec.title,
		description: spec.description,
		datasource: DATASOURCE,
		gridPos: { x: at.x, y: at.y, w: spec.width ?? 12, h: spec.height ?? (kind === "stat" ? 4 : 8) },
		targets: spec.queries.map((query, index) => ({
			datasource: DATASOURCE,
			refId: String.fromCharCode(65 + index),
			expr: query.expr,
			legendFormat: query.legend ?? "",
		})),
		fieldConfig: { defaults: fieldDefaults(spec), overrides: [] },
		options: panelOptions(kind),
	};
}

/**
 * Lay items out left to right in a 24-column grid, wrapping rows. Panels after a collapsed row are
 * nested inside it, as Grafana stores them, so they stay hidden until the row is opened.
 *
 * @param {Item[]} items
 */
function layout(items) {
	/** @type {GrafanaPanel[]} */
	const panels = [];
	/** @type {GrafanaPanel[]} */
	let target = panels;
	let x = 0;
	let y = 0;
	let rowHeight = 0;
	let id = 1;
	for (const item of items) {
		if ("row" in item) {
			y += rowHeight;
			x = 0;
			rowHeight = 0;
			/** @type {GrafanaPanel[]} */
			const nested = [];
			panels.push({
				id: id++,
				type: "row",
				title: item.row,
				collapsed: item.collapsed ?? false,
				gridPos: { x: 0, y, w: 24, h: 1 },
				panels: nested,
			});
			target = item.collapsed ? nested : panels;
			y += 1;
			continue;
		}
		const width = item.width ?? 12;
		if (x + width > 24) {
			y += rowHeight;
			x = 0;
			rowHeight = 0;
		}
		const built = panel(item, { x, y }, id++);
		target.push(built);
		x += width;
		rowHeight = Math.max(rowHeight, built.gridPos.h);
	}
	return { panels, bottom: y + rowHeight, nextId: id };
}

/** @param {VariableSpec} spec */
function variable(spec) {
	if (spec.textbox !== undefined) {
		return {
			name: spec.name,
			label: spec.label ?? spec.name,
			type: "textbox",
			query: spec.textbox,
			current: { text: spec.textbox, value: spec.textbox },
		};
	}
	return {
		name: spec.name,
		label: spec.label ?? spec.name,
		type: "query",
		datasource: DATASOURCE,
		query: { query: spec.query, refId: "variable" },
		definition: spec.query,
		refresh: 2,
		sort: 1,
		multi: spec.multi ?? true,
		includeAll: spec.multi ?? true,
		current: spec.multi === false ? {} : { text: "All", value: "$__all" },
	};
}

/** @param {DashboardSpec} spec */
export function dashboard(spec) {
	const { panels, bottom, nextId } = layout(spec.items);
	if (spec.repeat) {
		const repeated = panel(spec.repeat.panel, { x: 0, y: bottom }, nextId);
		panels.push({
			...repeated,
			repeat: spec.repeat.variable,
			repeatDirection: "h",
			maxPerRow: 3,
			gridPos: { ...repeated.gridPos, w: 8 },
		});
	}
	return {
		uid: spec.uid,
		title: spec.title,
		description: spec.description,
		tags: ["litro", ...spec.tags],
		timezone: "browser",
		editable: true,
		graphTooltip: 1,
		refresh: "5s",
		time: { from: "now-15m", to: "now" },
		schemaVersion: 39,
		version: 1,
		templating: { list: spec.variables.map(variable) },
		annotations: { list: [] },
		panels,
	};
}

const CHAIN = '{chain=~"$chain"}';
const NODE = '{node=~"$node"}';

/** Only the series that moved, so a stacked panel's legend lists what actually happened. */
const moved = (/** @type {string} */ expr) => `(${expr}) > 0`;

/** @type {DashboardSpec} */
export const LITRO_CHAINS = {
	uid: "litro-chains",
	title: "Litro chains",
	description:
		"Every chain the testnode runs, L1 to L3: is it running, how much load it carries, and whether deposits, batches and assertions are moving between each chain and its parent.",
	tags: ["chains"],
	variables: [{ name: "chain", query: "label_values(eth_exe_block_most_recent_number, chain)" }],
	items: [
		{ row: "Is it running?" },
		{
			title: "RPC up",
			description: "Whether each chain's RPC answered the exporter's last poll (1 = up).",
			kind: "stat",
			width: 6,
			queries: [{ expr: `litro_rpc_up${CHAIN}`, legend: "{{chain}}" }],
		},
		{
			title: "Head block",
			description: "Latest block number per chain.",
			kind: "stat",
			width: 6,
			queries: [{ expr: `eth_exe_block_most_recent_number${CHAIN}`, legend: "{{chain}}" }],
		},
		{
			title: "L1 head block age",
			description:
				"Seconds since the L1 (Anvil) mined a block. It mines one a second, so anything above a few seconds means the L1 has stopped.",
			kind: "stat",
			width: 4,
			unit: "s",
			decimals: 0,
			queries: [{ expr: 'time() - litro_block_timestamp_seconds{chain="l1"}', legend: "l1" }],
		},
		{
			title: "Last transaction",
			description:
				"Seconds since each Arbitrum chain included a user transaction. Nitro produces blocks only when there is something to sequence, so this is how long the chain has been idle.",
			kind: "stat",
			width: 4,
			unit: "s",
			decimals: 0,
			queries: [
				{
					expr: `time() - litro_last_user_transaction_timestamp_seconds{chain=~"$chain", chain!="l1"}`,
					legend: "{{chain}}",
				},
			],
		},
		{
			title: "ArbOS version",
			description:
				"ArbOS version each Arbitrum chain runs; 60 once --pga-rounds-per-block has upgraded it.",
			kind: "stat",
			width: 4,
			queries: [{ expr: `litro_arbos_version${CHAIN}`, legend: "{{chain}}" }],
		},
		{ row: "Load" },
		{
			title: "Transactions per second",
			description:
				"User transactions included per second, per chain. ArbOS's own start-of-block transaction is not counted.",
			queries: [{ expr: `rate(litro_transactions_total${CHAIN}[30s])`, legend: "{{chain}}" }],
		},
		{
			title: "Failed transactions per second",
			description:
				"User transactions that were included but reverted. A reverting contract call shows here, not as an RPC error.",
			queries: [
				{ expr: `rate(litro_failed_transactions_total${CHAIN}[30s])`, legend: "{{chain}}" },
			],
		},
		{
			title: "Gas per second",
			description:
				"Gas used per second, per chain. On the L1 this is mostly the batch poster and validator paying to post the rollups' data.",
			queries: [{ expr: `rate(litro_gas_used_total${CHAIN}[30s])`, legend: "{{chain}}" }],
		},
		{
			title: "Batches per minute",
			description:
				"Batches each batch poster posted to its parent chain in the last minute. It follows transaction load; zero while the chain is idle.",
			queries: [{ expr: "increase(litro_rollup_batches[1m])", legend: "{{chain}} → {{parent}}" }],
		},
		{ row: "Deposits, batches and withdrawals (child → parent)" },
		{
			title: "Deposits waiting",
			description:
				"Deposits, retryables and force-included transactions in the delayed inbox that no posted batch has read yet. Batch posting reports are left out.",
			kind: "stat",
			width: 6,
			queries: [{ expr: "litro_rollup_delayed_waiting", legend: "{{chain}}" }],
		},
		{
			title: "Oldest waiting deposit",
			description:
				"How long the oldest of those messages has waited. Empty when nothing waits; a value that keeps climbing means deposits are not reaching the chain.",
			width: 18,
			unit: "s",
			decimals: 0,
			queries: [
				{
					expr: "time() - litro_rollup_oldest_delayed_waiting_timestamp_seconds",
					legend: "{{chain}}",
				},
			],
		},
		{
			title: "Time since last batch",
			description:
				"Seconds since each chain's transactions were last posted to its parent. While transactions are being sent, a value that keeps climbing means batches are not reaching the parent; it climbs whenever the chain is idle.",
			unit: "s",
			decimals: 0,
			queries: [
				{
					expr: "time() - litro_rollup_last_batch_timestamp_seconds",
					legend: "{{chain}} → {{parent}}",
				},
			],
		},
		{
			title: "Deposits and retryables per minute",
			description:
				"User messages delivered to each delayed inbox in the last minute, by kind: eth_deposit, retryable, l2_message (force-included). Only kinds that occurred are shown.",
			queries: [
				{
					expr: moved(
						'increase(litro_rollup_delayed_messages_total{kind!~"batch_posting_report|initialize"}[1m])',
					),
					legend: "{{chain}} {{kind}}",
				},
			],
		},
		{
			title: "Time since last assertion",
			description:
				"Seconds since the validator last created, and last confirmed, an assertion of this chain's state on the parent chain. A withdrawal can be claimed once an assertion covering it is confirmed.",
			kind: "stat",
			width: 24,
			unit: "s",
			decimals: 0,
			queries: [
				{
					expr: "time() - litro_rollup_last_assertion_created_timestamp_seconds",
					legend: "{{chain}} created",
				},
				{
					expr: "time() - litro_rollup_last_assertion_confirmed_timestamp_seconds",
					legend: "{{chain}} confirmed",
				},
			],
		},
	],
};

/** @type {DashboardSpec} */
export const FAST_FEED_RELAY = {
	uid: "litro-fast-feed",
	title: "Fast Feed relay",
	description:
		"The local Fast Feed relay: who is connected, how fast transactions reach them, and why clients were turned away or dropped.",
	tags: ["fast-feed"],
	variables: [],
	items: [
		{
			title: "Clients connected",
			description: "Clients holding a Fast Feed connection now.",
			kind: "stat",
			width: 8,
			queries: [{ expr: "litro_fast_feed_clients", legend: "clients" }],
		},
		{
			title: "Upstream connected",
			description:
				"Whether the relay is connected to Nitro's transaction feed (1 = connected). At 0, clients stay connected but receive nothing.",
			kind: "stat",
			width: 8,
			queries: [{ expr: "litro_fast_feed_upstream_connected", legend: "upstream" }],
		},
		{
			title: "Upstream reconnects",
			description: "Times the relay had to reconnect to Nitro's transaction feed.",
			kind: "stat",
			width: 8,
			queries: [{ expr: "litro_fast_feed_upstream_reconnects_total", legend: "reconnects" }],
		},
		{
			title: "Delivery latency",
			description:
				"Age of each transaction as the relay sends it, from the moment the sequencer sequenced it (timestamp_ms): median and 99th percentile. Includes any --fast-feed-delay-ms.",
			unit: "ms",
			queries: [
				{
					expr: "histogram_quantile(0.5, sum by (le) (rate(litro_fast_feed_delivery_latency_ms_bucket[1m])))",
					legend: "p50",
				},
				{
					expr: "histogram_quantile(0.99, sum by (le) (rate(litro_fast_feed_delivery_latency_ms_bucket[1m])))",
					legend: "p99",
				},
			],
		},
		{
			title: "Transactions per second",
			description:
				"Transactions relayed to clients per second. User transactions should match the L2 on the Litro chains dashboard; all frames also include the ArbOS transaction Nitro sequences at the start of every block.",
			queries: [
				{ expr: "rate(litro_fast_feed_user_frames_total[30s])", legend: "user transactions" },
				{ expr: "rate(litro_fast_feed_frames_total[30s])", legend: "all frames" },
			],
		},
		{
			title: "Rejected connections",
			description:
				"Upgrade requests refused in the last minute, by HTTP status: 401 wrong or missing API key, 429 the key is already connected, 426 not a WebSocket upgrade.",
			queries: [
				{
					expr: 'sum by (status) (increase(litro_fast_feed_rejected_total[1m])) or label_replace(vector(0), "status", "none", "", "")',
					legend: "HTTP {{status}}",
				},
			],
		},
		{
			title: "Clients closed by the relay",
			description:
				"Connections the relay closed in the last minute, by close code: 1013 client fell behind, 1003 client sent data, 1008 round ended, 1011 relay shutting down.",
			queries: [
				{
					expr: 'sum by (code) (increase(litro_fast_feed_closed_total[1m])) or label_replace(vector(0), "code", "none", "", "")',
					legend: "close {{code}}",
				},
			],
		},
	],
};

/** @type {DashboardSpec} */
export const NITRO_EVERY_METRIC = {
	uid: "litro-nitro-all",
	title: "Nitro: every metric",
	description:
		"One panel per metric a Nitro node exports, filtered by a regex. Nothing Nitro reports is left out, including metrics added in later Nitro versions.",
	tags: ["nitro"],
	variables: [
		{ name: "node", label: "Node", query: 'label_values(up{job="nitro"}, node)', multi: false },
		{ name: "filter", label: "Metric regex", query: "", textbox: "arb_sequencer_.*" },
		{
			name: "metric",
			label: "Metric",
			query: 'label_values({job="nitro", node="$node", __name__=~"$filter"}, __name__)',
		},
	],
	items: [],
	repeat: {
		variable: "metric",
		panel: {
			title: "$metric",
			description: "",
			queries: [{ expr: '{__name__="$metric", node="$node"}', legend: "{{node}} {{quantile}}" }],
		},
	},
};

/**
 * Curated from the metrics Nitro v3.12.1 and its geth export (names as geth's Prometheus exporter
 * writes them: `/` becomes `_`, histograms become summaries with `quantile` labels).
 *
 * @type {DashboardSpec}
 */
export const NITRO_NODES = {
	uid: "litro-nitro-nodes",
	title: "Nitro nodes",
	description:
		"What each Nitro node is doing: keeping up with the sequencer, sequencing, posting batches, and the resources it uses. Panels that only matter when something breaks are in Diagnostics.",
	tags: ["nitro"],
	variables: [{ name: "node", label: "Node", query: 'label_values(up{job="nitro"}, node)' }],
	items: [
		{ row: "Is each node keeping up?" },
		{
			title: "Blocks behind the sequencer",
			description:
				"How far each node trails the newest block of its chain. Under load the validator falls behind and catches up; one that keeps falling behind delays assertions, and so withdrawals.",
			width: 24,
			queries: [
				{
					expr: `max by (chain) (chain_head_block) - on (chain) group_right chain_head_block${NODE}`,
					legend: "{{node}}",
				},
			],
		},
		{ row: "Sequencer" },
		{
			title: "Block build time",
			description:
				"Time the sequencer takes to build a block, median and 99th percentile. The number to watch when booting your own Nitro build with --nitro-image.",
			unit: "ns",
			queries: [
				{
					expr: `arb_sequencer_block_creation{quantile="0.5", node=~"$node"}`,
					legend: "{{node}} p50",
				},
				{
					expr: `arb_sequencer_block_creation{quantile="0.99", node=~"$node"}`,
					legend: "{{node}} p99",
				},
			],
		},
		{
			title: "Why blocks closed",
			description:
				"Blocks per second by what ended them. Queue empty means the sequencer kept up; gas, data or time limits mean load reached the chain's capacity. Only reasons that occurred are shown.",
			stack: true,
			queries: [
				{
					expr: moved(`rate(arb_sequencer_block_txexhausted${NODE}[30s])`),
					legend: "{{node}} queue empty",
				},
				{
					expr: moved(`rate(arb_sequencer_block_gaslimited${NODE}[30s])`),
					legend: "{{node}} gas limit",
				},
				{
					expr: moved(`rate(arb_sequencer_block_datalimited${NODE}[30s])`),
					legend: "{{node}} data limit",
				},
				{
					expr: moved(`rate(arb_sequencer_block_timelimited${NODE}[30s])`),
					legend: "{{node}} time limit",
				},
			],
		},
		{
			title: "Transaction ordering",
			description:
				"Transactions ordered first-come-first-served versus by priority gas auction. PGA appears only with --pga-rounds-per-block.",
			stack: true,
			queries: [
				{ expr: moved(`rate(arb_sequencer_ordering_fifo${NODE}[30s])`), legend: "{{node}} FIFO" },
				{ expr: moved(`rate(arb_sequencer_ordering_pga${NODE}[30s])`), legend: "{{node}} PGA" },
			],
		},
		{
			title: "Most transactions queued",
			description:
				"The longest the sequencer's queue got in the time range. Above a handful means transactions arrive faster than blocks are built.",
			kind: "stat",
			width: 6,
			queries: [
				{
					expr: `max_over_time(arb_sequencer_queue_length{node=~"$node"}[$__range])`,
					legend: "{{node}}",
				},
			],
		},
		{
			title: "Dropped transactions",
			description:
				"Transactions the sequencer dropped in the time range because they waited too long in its queue or were canceled.",
			kind: "stat",
			width: 6,
			queries: [
				{
					expr: `sum by (node) (increase(arb_sequencer_transactions_dropped_queuetimeout${NODE}[$__range]) + increase(arb_sequencer_transactions_dropped_canceled${NODE}[$__range]))`,
					legend: "{{node}}",
				},
			],
		},
		{ row: "Batch poster" },
		{
			title: "Batch poster wallet",
			description:
				"ETH each batch poster has left to pay for posting on its parent chain. At zero, batches stop. The L3 poster pays in L2 ETH and starts with far less than the L2 poster.",
			kind: "stat",
			width: 8,
			decimals: 4,
			queries: [
				{
					expr: `arb_batchposter_wallet_eth{node=~"$node", node!~".*validator"}`,
					legend: "{{node}}",
				},
			],
		},
		{
			title: "Posting failures",
			description: "Failed batch-posting attempts in the time range.",
			kind: "stat",
			width: 4,
			queries: [
				{
					expr: `increase(arb_batchPoster_action_failure{node=~"$node", node!~".*validator"}[$__range])`,
					legend: "{{node}}",
				},
			],
		},
		{
			title: "Parent-chain transactions pending",
			description:
				"Transactions the data poster (batches, assertions) has sent to the parent chain that are not mined yet. It rises under load and should drain back to zero.",
			queries: [
				{
					expr: `clamp_min(arb_dataposter_nonce_unconfirmed${NODE} - arb_dataposter_nonce_softconfirmed${NODE}, 0)`,
					legend: "{{node}}",
				},
			],
		},
		{ row: "Resources" },
		{
			title: "CPU",
			description: "CPU used by each node's process.",
			unit: "percent",
			queries: [{ expr: `system_cpu_procload${NODE}`, legend: "{{node}}" }],
		},
		{
			title: "Memory in use",
			description: "Go heap in use by each node.",
			unit: "bytes",
			queries: [{ expr: `system_memory_used${NODE}`, legend: "{{node}}" }],
		},
		{
			title: "Goroutines",
			description: "Goroutines each node runs. Steady growth suggests a leak.",
			queries: [{ expr: `system_cpu_goroutines${NODE}`, legend: "{{node}}" }],
		},
		{
			title: "Disk I/O",
			description: "Bytes each node reads and writes per second.",
			unit: "Bps",
			queries: [
				{ expr: `rate(system_disk_readbytes${NODE}[30s])`, legend: "{{node}} read" },
				{ expr: `rate(system_disk_writebytes${NODE}[30s])`, legend: "{{node}} write" },
			],
		},
		{ row: "Diagnostics", collapsed: true },
		{
			title: "Assertion posting errors",
			description:
				"Failed attempts to post an assertion, per minute. Under load litro's fast validator retries assertions it has just posted (item not found on-chain, EXPECTED_ASSERTION_SEEN); it matters only if Time since last assertion on the Litro chains dashboard keeps climbing.",
			queries: [
				{
					expr: `rate(arb_validator_poster_error_posting_assertion${NODE}[1m]) * 60`,
					legend: "{{node}}",
				},
			],
		},
		{
			title: "L1 gas price the sequencer charges for",
			description:
				"The parent-chain gas price the sequencer uses to price each transaction's data. Static on litro unless you change the parent chain's base fee.",
			unit: "wei",
			queries: [{ expr: `arb_sequencer_l1gasprice${NODE}`, legend: "{{node}}" }],
		},
	],
};

/** Dashboards by file name. */
export const DASHBOARDS = {
	"litro-chains.json": LITRO_CHAINS,
	"litro-fast-feed.json": FAST_FEED_RELAY,
	"litro-nitro-all.json": NITRO_EVERY_METRIC,
	"litro-nitro-nodes.json": NITRO_NODES,
};

/** @param {string} dir */
export function writeDashboards(dir) {
	mkdirSync(dir, { recursive: true });
	for (const [file, spec] of Object.entries(DASHBOARDS)) {
		writeFileSync(join(dir, file), `${JSON.stringify(dashboard(spec), null, "\t")}\n`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	writeDashboards(join(import.meta.dirname, "dashboards"));
}
