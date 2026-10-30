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
 * @typedef {{ row: string } | PanelSpec} Item
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

/** Lay items out left to right in a 24-column grid, wrapping rows. @param {Item[]} items */
function layout(items) {
	/** @type {GrafanaPanel[]} */
	const panels = [];
	let x = 0;
	let y = 0;
	let rowHeight = 0;
	let id = 1;
	for (const item of items) {
		if ("row" in item) {
			y += rowHeight;
			x = 0;
			rowHeight = 0;
			panels.push({
				id: id++,
				type: "row",
				title: item.row,
				collapsed: false,
				gridPos: { x: 0, y, w: 24, h: 1 },
				panels: [],
			});
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
		panels.push(built);
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

/** @type {DashboardSpec} */
export const LITRO_CHAINS = {
	uid: "litro-chains",
	title: "Litro chains",
	description:
		"Every chain the testnode runs, L1 to L3: block production, load, fees, and the rollup pipeline between each chain and its parent.",
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
			title: "Head block age",
			description:
				"Seconds since each chain's head block was produced. L1 mines a block every second, so a climbing L1 value means it has stopped. Nitro chains produce blocks only when there are transactions, so their age climbs whenever the chain is idle.",
			kind: "stat",
			width: 6,
			unit: "s",
			decimals: 1,
			queries: [{ expr: `time() - litro_block_timestamp_seconds${CHAIN}`, legend: "{{chain}}" }],
		},
		{
			title: "ArbOS version",
			description: "ArbOS version each Arbitrum chain runs.",
			kind: "stat",
			width: 6,
			queries: [{ expr: `litro_arbos_version${CHAIN}`, legend: "{{chain}}" }],
		},
		{ row: "Load" },
		{
			title: "Blocks per second",
			description:
				"Block production rate. L1 (Anvil) mines one block a second; Nitro chains produce a block whenever there is something to sequence.",
			unit: "short",
			queries: [{ expr: `rate(litro_blocks_total${CHAIN}[30s])`, legend: "{{chain}}" }],
		},
		{
			title: "Transactions per second",
			description: "Transactions included in blocks, per chain.",
			unit: "short",
			queries: [{ expr: `rate(litro_transactions_total${CHAIN}[30s])`, legend: "{{chain}}" }],
		},
		{
			title: "Gas per second",
			description: "Gas used by included transactions, per chain.",
			unit: "short",
			queries: [{ expr: `rate(litro_gas_used_total${CHAIN}[30s])`, legend: "{{chain}}" }],
		},
		{
			title: "Base fee",
			description:
				"Base fee of each chain's head block. Nitro raises it when blocks fill beyond the speed limit.",
			unit: "gwei",
			decimals: 4,
			queries: [{ expr: `eth_exe_block_head_base_fee_per_gas${CHAIN} / 1e9`, legend: "{{chain}}" }],
		},
		{
			title: "Txpool",
			description:
				"Transactions waiting in each chain's pool. On Nitro, queued transactions usually mean a nonce gap.",
			stack: true,
			queries: [{ expr: `eth_exe_txpool_transactions${CHAIN}`, legend: "{{chain}} {{status}}" }],
		},
		{
			title: "Head block gas used",
			description: "Gas used by the head block, against its limit.",
			queries: [{ expr: `eth_exe_block_head_gas_used${CHAIN}`, legend: "{{chain}} used" }],
		},
		{ row: "Rollup pipeline (child → parent)" },
		{
			title: "Time since last batch",
			description:
				"Seconds since the batch poster last posted this chain's transactions to its parent chain. While transactions are being sent, a value that keeps climbing means batches are not reaching the parent.",
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
			title: "Batches posted",
			description:
				"Batches in each sequencer inbox (batchCount) and how many were posted per minute.",
			queries: [
				{ expr: "litro_rollup_batches", legend: "{{chain}} → {{parent}} total" },
				{ expr: "increase(litro_rollup_batches[1m])", legend: "{{chain}} → {{parent}} per minute" },
			],
		},
		{
			title: "Deposits waiting for the sequencer",
			description:
				"Deposits, retryables and force-included transactions in the delayed inbox that no posted batch has read yet. Batch posting reports, which Nitro appends with every batch, are left out. A message should be read by the next batch, seconds after it arrives.",
			queries: [{ expr: "litro_rollup_delayed_waiting", legend: "{{chain}}" }],
		},
		{
			title: "Oldest waiting deposit",
			description:
				"How long the oldest of those messages has waited. Empty when nothing is waiting; a value that keeps climbing means deposits are not reaching the chain.",
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
			title: "Deposits and retryables per minute",
			description:
				"User messages delivered to each delayed inbox, by kind: eth_deposit, retryable, l2_message (force-included). Batch posting reports, one per batch, are left out.",
			stack: true,
			queries: [
				{
					expr: 'increase(litro_rollup_delayed_messages_total{kind!~"batch_posting_report|initialize"}[1m])',
					legend: "{{chain}} {{kind}}",
				},
			],
		},
		{
			title: "Time since last assertion",
			kind: "stat",
			width: 12,
			description:
				"Seconds since the validator last created, and last confirmed, an assertion of this chain's state on the parent chain. Withdrawals finalize only once their assertion is confirmed.",
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
		{
			title: "Assertions",
			description: "Assertions created and confirmed on each rollup since it was deployed.",
			queries: [
				{ expr: "litro_rollup_assertions_created_total", legend: "{{chain}} created" },
				{ expr: "litro_rollup_assertions_confirmed_total", legend: "{{chain}} confirmed" },
			],
		},
	],
};

/** @type {DashboardSpec} */
export const FAST_FEED_RELAY = {
	uid: "litro-fast-feed",
	title: "Fast Feed relay",
	description:
		"The local Fast Feed relay: who is connected, what it relays, and why it turned clients away.",
	tags: ["fast-feed"],
	variables: [],
	items: [
		{
			title: "Clients connected",
			description: "Clients holding a Fast Feed connection now.",
			kind: "stat",
			width: 6,
			queries: [{ expr: "litro_fast_feed_clients", legend: "clients" }],
		},
		{
			title: "Upstream connected",
			description: "Whether the relay is connected to Nitro's transaction feed (1 = connected).",
			kind: "stat",
			width: 6,
			queries: [{ expr: "litro_fast_feed_upstream_connected", legend: "upstream" }],
		},
		{
			title: "Added delay",
			description: "Delay the relay adds to every frame (fast-feed-delay-ms).",
			kind: "stat",
			width: 6,
			unit: "ms",
			queries: [{ expr: "litro_fast_feed_delay_ms", legend: "per frame" }],
		},
		{
			title: "Upstream reconnects",
			description: "Times the relay reconnected to Nitro's feed.",
			kind: "stat",
			width: 6,
			queries: [{ expr: "litro_fast_feed_upstream_reconnects_total", legend: "reconnects" }],
		},
		{
			title: "Frames per second",
			description: "Transactions relayed from Nitro to clients.",
			queries: [{ expr: "rate(litro_fast_feed_frames_total[30s])", legend: "frames/s" }],
		},
		{
			title: "Bytes per second",
			description: "Payload relayed from Nitro to clients.",
			unit: "Bps",
			queries: [{ expr: "rate(litro_fast_feed_bytes_total[30s])", legend: "bytes/s" }],
		},
		{
			title: "Rejected connections",
			description:
				"Upgrade requests refused, by HTTP status: 401 wrong or missing key, 429 key already connected, 426 not a WebSocket upgrade.",
			stack: true,
			queries: [
				{ expr: "increase(litro_fast_feed_rejected_total[1m])", legend: "HTTP {{status}}" },
			],
		},
		{
			title: "Clients closed by the relay",
			description:
				"Connections the relay closed, by close code: 1013 client fell behind, 1003 client sent data, 1008 round ended, 1011 relay shutting down.",
			stack: true,
			queries: [{ expr: "increase(litro_fast_feed_closed_total[1m])", legend: "close {{code}}" }],
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
		{ name: "filter", label: "Metric regex", query: "", textbox: "arb_.*" },
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

const NODE = '{node=~"$node"}';

/**
 * Curated from the metrics Nitro v3.12.1 and its geth register (names as geth's Prometheus exporter
 * writes them: `/` becomes `_`, histograms become summaries with `quantile` labels).
 *
 * @type {DashboardSpec}
 */
export const NITRO_NODES = {
	uid: "litro-nitro-nodes",
	title: "Nitro nodes",
	description:
		"What each Nitro node is doing: keeping up, sequencing, posting batches, asserting, serving feeds, and the resources it uses.",
	tags: ["nitro"],
	variables: [{ name: "node", label: "Node", query: 'label_values(up{job="nitro"}, node)' }],
	items: [
		{ row: "Is each node keeping up?" },
		{
			title: "Head block",
			description: "Latest block each node has processed.",
			kind: "stat",
			width: 8,
			queries: [{ expr: `chain_head_block${NODE}`, legend: "{{node}}" }],
		},
		{
			title: "Blocks behind the sequencer",
			description:
				"How far each node trails the newest block any node of the same chain has. A validator that keeps falling behind cannot assert recent state.",
			width: 16,
			queries: [
				{
					expr: `max by (chain) (chain_head_block) - on (chain) group_right chain_head_block${NODE}`,
					legend: "{{node}}",
				},
			],
		},
		{ row: "Sequencer" },
		{
			title: "Sequencer queue",
			description:
				"Transactions waiting to be sequenced, and the sequencer's backlog. Growing queues mean transactions arrive faster than blocks are built.",
			queries: [
				{ expr: `arb_sequencer_queue_length${NODE}`, legend: "{{node}} queue" },
				{ expr: `arb_sequencer_backlog${NODE}`, legend: "{{node}} backlog" },
			],
		},
		{
			title: "Block build time",
			description: "Time the sequencer takes to build a block, median and 99th percentile.",
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
				"Blocks per second, by what ended them: the queue ran dry (tx exhausted), or the block hit its gas, data or time limit. Limited blocks under load mean you are hitting the chain's capacity.",
			stack: true,
			queries: [
				{
					expr: `rate(arb_sequencer_block_txexhausted${NODE}[30s])`,
					legend: "{{node}} queue empty",
				},
				{ expr: `rate(arb_sequencer_block_gaslimited${NODE}[30s])`, legend: "{{node}} gas limit" },
				{
					expr: `rate(arb_sequencer_block_datalimited${NODE}[30s])`,
					legend: "{{node}} data limit",
				},
				{
					expr: `rate(arb_sequencer_block_timelimited${NODE}[30s])`,
					legend: "{{node}} time limit",
				},
			],
		},
		{
			title: "Dropped transactions",
			description:
				"Transactions the sequencer dropped because they waited too long in its queue or the sender canceled them.",
			stack: true,
			queries: [
				{
					expr: `rate(arb_sequencer_transactions_dropped_queuetimeout${NODE}[1m])`,
					legend: "{{node}} queue timeout",
				},
				{
					expr: `rate(arb_sequencer_transactions_dropped_canceled${NODE}[1m])`,
					legend: "{{node}} canceled",
				},
			],
		},
		{
			title: "Transaction ordering",
			description:
				"Transactions ordered first-come-first-served versus by priority gas auction (PGA rounds).",
			stack: true,
			queries: [
				{ expr: `rate(arb_sequencer_ordering_fifo${NODE}[30s])`, legend: "{{node}} FIFO" },
				{ expr: `rate(arb_sequencer_ordering_pga${NODE}[30s])`, legend: "{{node}} PGA" },
			],
		},
		{
			title: "L1 gas price the sequencer charges for",
			description:
				"The parent-chain gas price the sequencer uses to price each transaction's data.",
			unit: "wei",
			queries: [{ expr: `arb_sequencer_l1gasprice${NODE}`, legend: "{{node}}" }],
		},
		{ row: "Batch poster" },
		{
			title: "Batches waiting to post",
			description:
				"Batches the poster estimates it still has to post. It should return to zero after each post.",
			queries: [{ expr: `arb_batchposter_estimated_batch_backlog${NODE}`, legend: "{{node}}" }],
		},
		{
			title: "Batch poster wallet",
			description:
				"ETH the batch poster has left to pay for posting on the parent chain. At zero, batches stop. The L3 poster pays in L2 ETH and starts with far less than the L2 poster.",
			kind: "stat",
			decimals: 4,
			unit: "short",
			queries: [{ expr: `arb_batchposter_wallet_eth${NODE}`, legend: "{{node}}" }],
		},
		{
			title: "Posting failures",
			description: "Failed batch-posting attempts per minute.",
			queries: [
				{ expr: `rate(arb_batchPoster_action_failure${NODE}[1m]) * 60`, legend: "{{node}}" },
			],
		},
		{
			title: "Parent-chain transactions pending",
			description:
				"Transactions the data poster (batches, assertions) has sent to the parent chain that are not mined yet, and its send queue. Should hover near zero.",
			queries: [
				{
					expr: `arb_dataposter_nonce_unconfirmed${NODE} - arb_dataposter_nonce_softconfirmed${NODE}`,
					legend: "{{node}} pending",
				},
				{ expr: `arb_dataposter_queue_length${NODE}`, legend: "{{node}} queued" },
			],
		},
		{ row: "Validator (BoLD)" },
		{
			title: "Assertion posting errors",
			description:
				"Failed attempts to post an assertion, per minute, beside assertions actually created on the parent chain. Under load, litro's fast validator retries assertions it has just posted (item not found on-chain, EXPECTED_ASSERTION_SEEN); errors only matter when assertions stop being created.",
			queries: [
				{
					expr: `rate(arb_validator_poster_error_posting_assertion${NODE}[1m]) * 60`,
					legend: "{{node}} errors",
				},
				{
					expr: "increase(litro_rollup_assertions_created_total[1m])",
					legend: "{{chain}} assertions created",
				},
			],
		},
		{
			title: "Latest confirmed assertion",
			description:
				"Block number of the latest confirmed assertion this node has seen. Withdrawals wait on confirmation.",
			queries: [
				{
					expr: `arb_validator_scanner_latest_confirmed_assertion_block_number${NODE}`,
					legend: "{{node}}",
				},
			],
		},
		{ row: "Feeds" },
		{
			title: "Sequencer feed clients",
			description:
				"Clients of the sequencer feed (port 9642), such as other nodes following the chain.",
			queries: [{ expr: `arb_feed_clients_current${NODE}`, legend: "{{node}}" }],
		},
		{
			title: "Transaction feed clients",
			description: "Clients of Nitro's transaction feed, which the Fast Feed relay connects to.",
			queries: [{ expr: `arb_transactionfeed_clients_current${NODE}`, legend: "{{node}}" }],
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
