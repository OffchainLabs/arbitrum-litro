// @ts-check

// Prometheus metrics for the testnode's chains, polled over JSON-RPC. Anvil (the L1) exposes no
// metrics of its own, and Nitro's describe each node rather than the chain, so this is where
// chain and rollup activity come from. Dependency-free, like the Fast Feed relay.
//
// Per chain (label `chain`): head block, gas, base fee, size and transactions, using
// ethereum-metrics-exporter's `eth_exe_*` names so its dashboards work unchanged; plus litro's own
// counters over every block. Per rollup (labels `chain` = child, `parent`): batches posted, the
// delayed inbox and how much of it the sequencer has read, assertions created and confirmed, and
// the child's ArbOS version.
//
//   TESTNODE_VARIANT                     l2 runs L1 + L2; anything else adds the L3
//   TESTNODE_CHAIN_EXPORTER_PORT         default 6080
//   TESTNODE_CHAIN_EXPORTER_INTERVAL_MS  default 1000

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Event topics, checked against the nitro-contracts ABIs by test/chain-exporter.test.ts. */
export const TOPICS = {
	sequencerBatchDelivered: "0x7394f4a19a13c7b92b5bb71033245305946ef78452f7b4986ac1390b5df4ebd7",
	assertionCreated: "0x901c3aee23cf4478825462caaab375c606ab83516060388344f0650340753630",
	assertionConfirmed: "0xfc42829b29c259a7370ab56c8f69fce23b5f351a9ce151da453281993ec0090c",
	messageDelivered: "0x5e3c1311ea442664e8b1611bfabef659120ea7a0a2cfc0667700bebc69cbffe1",
};

/**
 * Delayed-inbox message kinds (Nitro's L1MessageType). Every batch also appends a batch posting
 * report, which the next batch reads, so the report is not something a user waits on.
 */
const MESSAGE_KINDS = {
	3: "l2_message",
	7: "l2_funded_by_l1",
	9: "retryable",
	11: "initialize",
	12: "eth_deposit",
	13: "batch_posting_report",
};
const BATCH_POSTING_REPORT = 13;

export const SELECTORS = {
	batchCount: "0x06f13056",
	delayedMessageCount: "0xeca067ad",
	totalDelayedMessagesRead: "0x7fa3a40e",
	arbOSVersion: "0x051038f2",
};

/** ArbSys precompile; arbOSVersion() returns the version plus 55. */
const ARBSYS = "0x0000000000000000000000000000000000000064";
const ARBOS_VERSION_OFFSET = 55;

/** Type of the transaction ArbOS puts first in every Nitro block; not something a user sent. */
const ARBITRUM_INTERNAL_TX_TYPE = 0x6a;

/** Most blocks folded into the counters per poll, and the widest eth_getLogs range asked for. */
const MAX_BLOCKS_PER_POLL = 200;
const MAX_LOG_RANGE = 5000;

/**
 * @typedef {{ bridge: string; sequencerInbox: string; rollup: string; deployedAt: number }} RollupContracts
 * @typedef {{ name: string; rpc: string; parent?: { name: string; rpc: string; contracts: RollupContracts } }} ChainSpec
 * @typedef {{ number: number; timestamp: number; gasUsed: number; gasLimit: number; baseFee: number; size: number; transactions: number }} BlockInfo
 * @typedef {{ count: number; lastTimestamp: number }} EventTally
 * @typedef {{ index: number; kind: number; timestamp: number }} DelayedMessage
 * @typedef {{
 *   batches: number; delayedMessages: number; delayedMessagesRead: number; scannedTo: number;
 *   batchEvents: EventTally; assertionsCreated: EventTally; assertionsConfirmed: EventTally;
 *   delayedByKind: Record<string, number>; unread: DelayedMessage[];
 * }} RollupState
 * @typedef {{
 *   up: boolean; chainId?: number; head?: BlockInfo; gasPriceWei?: number;
 *   txpool?: { pending: number; queued: number }; arbosVersion?: number;
 *   counted?: number; blocks: number; transactions: number; failedTransactions: number;
 *   gasUsed: number; lastUserTransaction?: number; rollup?: RollupState;
 *   noTxpool?: boolean;
 * }} ChainState
 */

/**
 * The chains of a variant, from the config the image exports.
 *
 * @param {{ variant: string; exportConfigDir: string }} options
 * @returns {ChainSpec[]}
 */
export function chainSpecs({ variant, exportConfigDir }) {
	const network = JSON.parse(readFileSync(join(exportConfigDir, "localNetwork.json"), "utf-8"));
	/** @param {string} child @param {string} file */
	const contracts = (child, file) => {
		const { bridge, sequencerInbox, rollup } = network[`${child}Network`].ethBridge;
		const deployment = JSON.parse(readFileSync(join(exportConfigDir, file), "utf-8"));
		return { bridge, sequencerInbox, rollup, deployedAt: Number(deployment["deployed-at"] ?? 0) };
	};
	const l1 = { name: "l1", rpc: "http://127.0.0.1:8545" };
	const l2 = { name: "l2", rpc: "http://127.0.0.1:8547" };
	const chains = [
		l1,
		{ ...l2, parent: { ...l1, contracts: contracts("l2", "l2_deployment.json") } },
	];
	if (variant !== "l2" && network.l3Network) {
		chains.push({
			name: "l3",
			rpc: "http://127.0.0.1:8549",
			parent: { ...l2, contracts: contracts("l3", "l3_deployment.json") },
		});
	}
	return chains;
}

/**
 * @param {string} url
 * @param {string} method
 * @param {unknown[]} params
 * @returns {Promise<any>}
 */
async function rpc(url, method, params = []) {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		signal: AbortSignal.timeout(5000),
	});
	const body = /** @type {{ result?: unknown; error?: { message: string } }} */ (
		await response.json()
	);
	if (body.error) {
		throw new Error(`${method}: ${body.error.message}`);
	}
	return body.result;
}

/** @param {string | undefined | null} hex */
const toNumber = (hex) => (hex ? Number(BigInt(hex)) : 0);

/** @param {any} block @returns {BlockInfo} */
function blockInfo(block) {
	return {
		number: toNumber(block.number),
		timestamp: toNumber(block.timestamp),
		gasUsed: toNumber(block.gasUsed),
		gasLimit: toNumber(block.gasLimit),
		baseFee: toNumber(block.baseFeePerGas),
		size: toNumber(block.size),
		transactions: block.transactions.length,
	};
}

/** @param {string} url @param {number | "latest"} number */
async function getBlock(url, number) {
	const tag = number === "latest" ? number : `0x${number.toString(16)}`;
	return blockInfo(await rpc(url, "eth_getBlockByNumber", [tag, false]));
}

/** @param {string} url @param {string} to @param {string} data */
const call = async (url, to, data) =>
	toNumber(await rpc(url, "eth_call", [{ to, data }, "latest"]));

/**
 * Fold every block since the last poll into the counters. The first poll only marks the head,
 * so the counters cover what happened while the exporter ran.
 *
 * @param {ChainSpec} chain
 * @param {ChainState} state
 * @param {BlockInfo} head
 */
async function countBlocks(chain, state, head) {
	const from = (state.counted ?? head.number) + 1;
	const to = Math.min(head.number, from + MAX_BLOCKS_PER_POLL - 1);
	for (let number = from; number <= to; number++) {
		const block = number === head.number ? head : await getBlock(chain.rpc, number);
		const { user, failed } = await userTransactions(chain.rpc, number, block.transactions);
		state.blocks += 1;
		state.transactions += user;
		state.failedTransactions += failed;
		state.gasUsed += block.gasUsed;
		if (user > 0) {
			state.lastUserTransaction = block.timestamp;
		}
	}
	state.counted = Math.max(state.counted ?? head.number, to);
}

/**
 * A block's transactions as a user sees them: without the internal transaction ArbOS starts
 * every Nitro block with, and how many of them reverted.
 *
 * @param {string} url
 * @param {number} number
 * @param {number} count the block's transaction count, used when receipts are unavailable
 */
async function userTransactions(url, number, count) {
	/** @type {Array<{ type: string; status: string }> | null} */
	const receipts = await rpc(url, "eth_getBlockReceipts", [`0x${number.toString(16)}`]).catch(
		() => null,
	);
	if (!receipts) {
		return { user: count, failed: 0 };
	}
	const user = receipts.filter((receipt) => toNumber(receipt.type) !== ARBITRUM_INTERNAL_TX_TYPE);
	return { user: user.length, failed: user.filter((receipt) => receipt.status === "0x0").length };
}

/** @param {ChainSpec} chain @param {ChainState} state */
async function pollExecution(chain, state) {
	const head = await getBlock(chain.rpc, "latest");
	await countBlocks(chain, state, head);
	state.head = head;
	state.chainId ??= toNumber(await rpc(chain.rpc, "eth_chainId"));
	state.gasPriceWei = toNumber(await rpc(chain.rpc, "eth_gasPrice"));
	// Nitro does not implement txpool_status and logs an error for every call, so ask once.
	if (!state.noTxpool) {
		const txpool = await rpc(chain.rpc, "txpool_status").catch(() => undefined);
		state.noTxpool = !txpool;
		if (txpool) {
			state.txpool = { pending: toNumber(txpool.pending), queued: toNumber(txpool.queued) };
		}
	}
	if (chain.parent) {
		state.arbosVersion =
			(await call(chain.rpc, ARBSYS, SELECTORS.arbOSVersion)) - ARBOS_VERSION_OFFSET;
	}
}

/**
 * Count matching logs from `from` to `to`, keeping the newest one's block timestamp.
 *
 * @param {string} url
 * @param {{ address: string; topic: string; from: number; to: number }} query
 * @param {EventTally} tally
 */
async function tallyLogs(url, { address, topic, from, to }, tally) {
	for (let start = from; start <= to; start += MAX_LOG_RANGE) {
		const end = Math.min(to, start + MAX_LOG_RANGE - 1);
		/** @type {Array<{ blockNumber: string; blockTimestamp?: string }>} */
		const logs = await rpc(url, "eth_getLogs", [
			{
				address,
				topics: [topic],
				fromBlock: `0x${start.toString(16)}`,
				toBlock: `0x${end.toString(16)}`,
			},
		]);
		const last = logs.at(-1);
		if (last) {
			tally.count += logs.length;
			tally.lastTimestamp = last.blockTimestamp
				? toNumber(last.blockTimestamp)
				: (await getBlock(url, toNumber(last.blockNumber))).timestamp;
		}
	}
}

/**
 * Record each message delivered to the delayed inbox from `from` to `to`: its kind, and when it
 * arrived. MessageDelivered's data words are inbox, kind, sender, messageDataHash, baseFeeL1,
 * timestamp; its first indexed topic is the message index.
 *
 * @param {string} url
 * @param {{ bridge: string; from: number; to: number }} query
 * @param {RollupState} rollup
 */
async function scanDeliveries(url, { bridge, from, to }, rollup) {
	for (let start = from; start <= to; start += MAX_LOG_RANGE) {
		const end = Math.min(to, start + MAX_LOG_RANGE - 1);
		/** @type {Array<{ topics: string[]; data: string }>} */
		const logs = await rpc(url, "eth_getLogs", [
			{
				address: bridge,
				topics: [TOPICS.messageDelivered],
				fromBlock: `0x${start.toString(16)}`,
				toBlock: `0x${end.toString(16)}`,
			},
		]);
		for (const log of logs) {
			const word = (/** @type {number} */ n) =>
				toNumber(`0x${log.data.slice(2 + n * 64, 2 + (n + 1) * 64)}`);
			const kind = word(1);
			const name =
				MESSAGE_KINDS[/** @type {keyof typeof MESSAGE_KINDS} */ (kind)] ?? `kind_${kind}`;
			rollup.delayedByKind[name] = (rollup.delayedByKind[name] ?? 0) + 1;
			rollup.unread.push({ index: toNumber(log.topics[1]), kind, timestamp: word(5) });
		}
	}
}

/**
 * Messages a user is waiting on: delivered, not yet read by a posted batch, and not a batch
 * posting report.
 *
 * @param {RollupState} rollup
 */
const waiting = (rollup) =>
	rollup.unread.filter(
		(message) =>
			message.index >= rollup.delayedMessagesRead && message.kind !== BATCH_POSTING_REPORT,
	);

/** @param {number} deployedAt @returns {RollupState} */
function newRollupState(deployedAt) {
	const tally = () => ({ count: 0, lastTimestamp: 0 });
	return {
		batches: 0,
		delayedMessages: 0,
		delayedMessagesRead: 0,
		scannedTo: deployedAt - 1,
		batchEvents: tally(),
		assertionsCreated: tally(),
		assertionsConfirmed: tally(),
		delayedByKind: {},
		unread: [],
	};
}

/** @param {NonNullable<ChainSpec["parent"]>} parent @param {RollupState} rollup */
async function pollRollup(parent, rollup) {
	const { rpc: url, contracts } = parent;
	rollup.batches = await call(url, contracts.sequencerInbox, SELECTORS.batchCount);
	rollup.delayedMessages = await call(url, contracts.bridge, SELECTORS.delayedMessageCount);
	rollup.delayedMessagesRead = await call(
		url,
		contracts.sequencerInbox,
		SELECTORS.totalDelayedMessagesRead,
	);
	const range = { from: rollup.scannedTo + 1, to: toNumber(await rpc(url, "eth_blockNumber")) };
	await Promise.all([
		tallyLogs(
			url,
			{ ...range, address: contracts.sequencerInbox, topic: TOPICS.sequencerBatchDelivered },
			rollup.batchEvents,
		),
		tallyLogs(
			url,
			{ ...range, address: contracts.rollup, topic: TOPICS.assertionCreated },
			rollup.assertionsCreated,
		),
		tallyLogs(
			url,
			{ ...range, address: contracts.rollup, topic: TOPICS.assertionConfirmed },
			rollup.assertionsConfirmed,
		),
		scanDeliveries(url, { ...range, bridge: contracts.bridge }, rollup),
	]);
	rollup.scannedTo = range.to;
	rollup.unread = rollup.unread.filter((message) => message.index >= rollup.delayedMessagesRead);
}

/**
 * One poll of one chain. A failure marks the chain down but keeps its last values.
 *
 * @param {ChainSpec} chain
 * @param {ChainState} state
 */
async function pollChain(chain, state) {
	try {
		await pollExecution(chain, state);
		if (chain.parent) {
			state.rollup ??= newRollupState(chain.parent.contracts.deployedAt);
			await pollRollup(chain.parent, state.rollup);
		}
		state.up = true;
	} catch {
		state.up = false;
	}
}

/**
 * @typedef {{ name: string; help: string; type: "gauge" | "counter"; samples: Array<[Record<string, string>, number]> }} Family
 */

/** @param {Record<string, string>} labels */
const formatLabels = (labels) =>
	`{${Object.entries(labels)
		.map(([key, value]) => `${key}="${value}"`)
		.join(",")}}`;

/** @param {Family[]} families */
export function formatMetrics(families) {
	return `${families
		.filter((family) => family.samples.length > 0)
		.flatMap((family) => [
			`# HELP ${family.name} ${family.help}`,
			`# TYPE ${family.name} ${family.type}`,
			...family.samples.map(([labels, value]) => `${family.name}${formatLabels(labels)} ${value}`),
		])
		.join("\n")}\n`;
}

/**
 * @param {string} name
 * @param {string} help
 * @param {"gauge" | "counter"} type
 * @param {Array<[Record<string, string>, number | undefined]>} samples
 * @returns {Family}
 */
function family(name, help, type, samples) {
	return {
		name,
		help,
		type,
		samples: /** @type {Array<[Record<string, string>, number]>} */ (
			samples.filter(([, value]) => value !== undefined)
		),
	};
}

/** @param {Array<[ChainSpec, ChainState]>} chains @returns {Family[]} */
function executionFamilies(chains) {
	/** @param {(state: ChainState) => number | undefined} pick */
	const per = (pick) =>
		chains.map(
			([chain, state]) =>
				/** @type {[Record<string, string>, number | undefined]} */ ([
					{ chain: chain.name },
					pick(state),
				]),
		);
	return [
		family(
			"litro_rpc_up",
			"Whether the chain's RPC answered the last poll",
			"gauge",
			per((s) => (s.up ? 1 : 0)),
		),
		family(
			"eth_exe_chain_id",
			"Chain id",
			"gauge",
			per((s) => s.chainId),
		),
		family(
			"eth_exe_block_most_recent_number",
			"Head block number",
			"gauge",
			per((s) => s.head?.number),
		),
		family(
			"eth_exe_block_head_gas_used",
			"Gas used by the head block",
			"gauge",
			per((s) => s.head?.gasUsed),
		),
		family(
			"eth_exe_block_head_gas_limit",
			"Gas limit of the head block",
			"gauge",
			per((s) => s.head?.gasLimit),
		),
		family(
			"eth_exe_block_head_base_fee_per_gas",
			"Base fee of the head block, in wei",
			"gauge",
			per((s) => s.head?.baseFee),
		),
		family(
			"eth_exe_block_head_block_size_bytes",
			"Size of the head block",
			"gauge",
			per((s) => s.head?.size),
		),
		family(
			"eth_exe_block_head_transactions_in_block",
			"Transactions in the head block",
			"gauge",
			per((s) => s.head?.transactions),
		),
		family(
			"eth_exe_gas_price_gwei",
			"eth_gasPrice, in gwei",
			"gauge",
			per((s) => (s.gasPriceWei === undefined ? undefined : s.gasPriceWei / 1e9)),
		),
		family(
			"eth_exe_txpool_transactions",
			"Transactions in the txpool",
			"gauge",
			chains.flatMap(([chain, s]) => [
				[{ chain: chain.name, status: "pending" }, s.txpool?.pending],
				[{ chain: chain.name, status: "queued" }, s.txpool?.queued],
			]),
		),
		family(
			"litro_block_timestamp_seconds",
			"Timestamp of the head block",
			"gauge",
			per((s) => s.head?.timestamp),
		),
		family(
			"litro_blocks_total",
			"Blocks produced since the exporter started",
			"counter",
			per((s) => s.blocks),
		),
		family(
			"litro_transactions_total",
			"User transactions in blocks produced since the exporter started (not ArbOS's internal ones)",
			"counter",
			per((s) => s.transactions),
		),
		family(
			"litro_failed_transactions_total",
			"User transactions that reverted, since the exporter started",
			"counter",
			per((s) => s.failedTransactions),
		),
		family(
			"litro_last_user_transaction_timestamp_seconds",
			"Timestamp of the latest block with a user transaction",
			"gauge",
			per((s) => s.lastUserTransaction),
		),
		family(
			"litro_gas_used_total",
			"Gas used by blocks produced since the exporter started",
			"counter",
			per((s) => s.gasUsed),
		),
		family(
			"litro_arbos_version",
			"ArbOS version the chain runs",
			"gauge",
			per((s) => s.arbosVersion),
		),
	];
}

/** @param {Array<[ChainSpec, ChainState]>} chains @returns {Family[]} */
function rollupFamilies(chains) {
	const rollups = chains.filter(([chain, state]) => chain.parent && state.rollup);
	/** @param {(rollup: RollupState) => number | undefined} pick */
	const per = (pick) =>
		rollups.map(
			([chain, state]) =>
				/** @type {[Record<string, string>, number | undefined]} */ ([
					{ chain: chain.name, parent: chain.parent?.name ?? "" },
					pick(/** @type {RollupState} */ (state.rollup)),
				]),
		);
	/** @param {number} timestamp */
	const seen = (timestamp) => (timestamp > 0 ? timestamp : undefined);
	return [
		family(
			"litro_rollup_batches",
			"Batches the sequencer inbox holds (batchCount)",
			"gauge",
			per((r) => r.batches),
		),
		family(
			"litro_rollup_last_batch_timestamp_seconds",
			"Parent-chain timestamp of the latest batch",
			"gauge",
			per((r) => seen(r.batchEvents.lastTimestamp)),
		),
		family(
			"litro_rollup_delayed_messages",
			"Messages in the delayed inbox (delayedMessageCount)",
			"gauge",
			per((r) => r.delayedMessages),
		),
		family(
			"litro_rollup_delayed_messages_read",
			"Delayed messages the sequencer has included (totalDelayedMessagesRead)",
			"gauge",
			per((r) => r.delayedMessagesRead),
		),
		family(
			"litro_rollup_delayed_messages_total",
			"Messages delivered to the delayed inbox since the rollup was deployed, by kind",
			"counter",
			rollups.flatMap(([chain, state]) =>
				Object.entries(/** @type {RollupState} */ (state.rollup).delayedByKind).map(
					([kind, count]) =>
						/** @type {[Record<string, string>, number]} */ ([
							{ chain: chain.name, parent: chain.parent?.name ?? "", kind },
							count,
						]),
				),
			),
		),
		family(
			"litro_rollup_delayed_waiting",
			"Deposits, retryables and other user messages in the delayed inbox that no posted batch has read yet",
			"gauge",
			per((r) => waiting(r).length),
		),
		family(
			"litro_rollup_oldest_delayed_waiting_timestamp_seconds",
			"When the oldest user message still waiting in the delayed inbox arrived",
			"gauge",
			per((r) => waiting(r)[0]?.timestamp),
		),
		family(
			"litro_rollup_assertions_created_total",
			"Assertions created on the rollup",
			"counter",
			per((r) => r.assertionsCreated.count),
		),
		family(
			"litro_rollup_assertions_confirmed_total",
			"Assertions confirmed on the rollup",
			"counter",
			per((r) => r.assertionsConfirmed.count),
		),
		family(
			"litro_rollup_last_assertion_created_timestamp_seconds",
			"Parent-chain timestamp of the latest created assertion",
			"gauge",
			per((r) => seen(r.assertionsCreated.lastTimestamp)),
		),
		family(
			"litro_rollup_last_assertion_confirmed_timestamp_seconds",
			"Parent-chain timestamp of the latest confirmed assertion",
			"gauge",
			per((r) => seen(r.assertionsConfirmed.lastTimestamp)),
		),
	];
}

/**
 * Poll `chains` every `intervalMs` and serve `/metrics` on `port`.
 *
 * @param {{ chains: ChainSpec[]; port: number; intervalMs: number }} options
 */
export async function startChainExporter({ chains, port, intervalMs }) {
	/** @type {Array<[ChainSpec, ChainState]>} */
	const states = chains.map((chain) => [
		chain,
		{ up: false, blocks: 0, transactions: 0, failedTransactions: 0, gasUsed: 0 },
	]);
	let stopped = false;
	const loop = (async () => {
		while (!stopped) {
			const started = Date.now();
			await Promise.all(states.map(([chain, state]) => pollChain(chain, state)));
			await new Promise((resolve) =>
				setTimeout(resolve, Math.max(0, intervalMs - (Date.now() - started))),
			);
		}
	})();
	const server = createServer((req, res) => {
		if (req.url !== "/metrics") {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
		res.end(formatMetrics([...executionFamilies(states), ...rollupFamilies(states)]));
	});
	await new Promise((resolve) => server.listen(port, "0.0.0.0", () => resolve(undefined)));
	const address = server.address();
	return {
		port: typeof address === "object" && address ? address.port : port,
		async close() {
			stopped = true;
			await loop;
			await new Promise((resolve) => server.close(() => resolve(undefined)));
		},
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const exporter = await startChainExporter({
		chains: chainSpecs({
			variant: process.env["TESTNODE_VARIANT"] || "l2",
			exportConfigDir: "/opt/arbitrum-testnode/export-config",
		}),
		port: Number(process.env["TESTNODE_CHAIN_EXPORTER_PORT"] || 6080),
		intervalMs: Number(process.env["TESTNODE_CHAIN_EXPORTER_INTERVAL_MS"] || 1000),
	});
	console.log(`chain-exporter: serving /metrics on :${exporter.port}`);
	const shutdown = () => exporter.close().then(() => process.exit(0));
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}
