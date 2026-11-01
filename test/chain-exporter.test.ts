import { mkdtempSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	TOPICS,
	chainSpecs,
	formatMetrics,
	startChainExporter,
} from "../docker/chain-exporter.mjs";

const hex = (value: number) => `0x${value.toString(16)}`;
const word = (value: number) => `0x${value.toString(16).padStart(64, "0")}`;

const CONTRACTS = {
	bridge: "0x00000000000000000000000000000000000000b1",
	sequencerInbox: "0x00000000000000000000000000000000000000b2",
	rollup: "0x00000000000000000000000000000000000000b3",
};

type FakeLog = { address: string; topic: string; block: number; index?: number; kind?: number };

/** MessageDelivered's data words: inbox, kind, sender, messageDataHash, baseFeeL1, timestamp. */
const deliveredData = (kind: number, timestamp: number) =>
	`0x${[0, kind, 0, 0, 0, timestamp].map((value) => value.toString(16).padStart(64, "0")).join("")}`;

/** A chain that grows a block per eth_getBlockByNumber("latest") call, with fixed contract state. */
function fakeChain(options: {
	chainId: number;
	logs?: FakeLog[];
	txpool?: boolean;
	receipts?: boolean;
}) {
	let head = 10;
	let txpoolCalls = 0;
	const block = (number: number) => ({
		number: hex(number),
		timestamp: hex(1_700_000_000 + number),
		gasUsed: hex(21_000 * 2),
		gasLimit: hex(30_000_000),
		baseFeePerGas: hex(100_000_000),
		size: hex(600),
		transactions: ["0x01", "0x02"],
	});
	const calls: Record<string, number> = {
		[`${CONTRACTS.sequencerInbox}:0x06f13056`]: 7,
		[`${CONTRACTS.bridge}:0xeca067ad`]: 5,
		[`${CONTRACTS.sequencerInbox}:0x7fa3a40e`]: 3,
		"0x0000000000000000000000000000000000000064:0x051038f2": 55 + 40,
	};
	type Call = { to: string; data: string };
	type LogQuery = { address: string; topics: string[]; fromBlock: string; toBlock: string };
	const handlers: Record<string, (params: unknown[]) => unknown> = {
		eth_getBlockByNumber: ([tag]) => block(tag === "latest" ? ++head : Number(tag)),
		// Like Nitro: ArbOS's internal transaction first, then a user transaction that reverted.
		eth_getBlockReceipts: () => {
			if (options.receipts === false) {
				throw new Error("not supported");
			}
			return [
				{ type: "0x6a", status: "0x1" },
				{ type: "0x2", status: "0x0" },
			];
		},
		eth_blockNumber: () => hex(head),
		eth_chainId: () => hex(options.chainId),
		eth_gasPrice: () => hex(2_000_000_000),
		txpool_status: () => {
			txpoolCalls++;
			if (options.txpool === false) {
				throw new Error("not implemented");
			}
			return { pending: "0x4", queued: "0x1" };
		},
		eth_call: ([call]) => {
			const { to, data } = call as Call;
			return word(calls[`${to}:${data}`] ?? 0);
		},
		eth_getLogs: ([query]) => {
			const { address, topics, fromBlock, toBlock } = query as LogQuery;
			return (options.logs ?? [])
				.filter((log) => log.address === address && log.topic === topics[0])
				.filter((log) => log.block >= Number(fromBlock) && log.block <= Number(toBlock))
				.map((log) => ({
					blockNumber: hex(log.block),
					blockTimestamp: hex(1_700_000_000 + log.block),
					topics: [log.topic, word(log.index ?? 0)],
					data: deliveredData(log.kind ?? 0, 1_700_000_000 + log.block),
				}));
		},
	};
	/** A handler that throws answers with a JSON-RPC error, as Nitro does for txpool_status. */
	const answer = (id: unknown, method: string, params: unknown[]) => {
		const handler = handlers[method];
		try {
			if (!handler) {
				throw new Error(`no ${method}`);
			}
			return { jsonrpc: "2.0", id, result: handler(params) };
		} catch (error) {
			return { jsonrpc: "2.0", id, error: { code: -32601, message: (error as Error).message } };
		}
	};
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const { id, method, params } = JSON.parse(body);
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify(answer(id, method, params)));
		});
	});
	return Object.assign(server, { txpoolCalls: () => txpoolCalls });
}

const servers: Server[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()));
	for (const server of servers.splice(0)) {
		server.close();
	}
});

async function listen(server: Server) {
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Sample values from Prometheus text, keyed `name{labels}`. */
function samples(text: string) {
	return Object.fromEntries(
		text
			.split("\n")
			.filter((line) => line && !line.startsWith("#"))
			.map((line) => {
				const at = line.lastIndexOf(" ");
				return [line.slice(0, at), Number(line.slice(at + 1))];
			}),
	);
}

describe("chain-exporter", () => {
	it("reports execution metrics per chain and the rollup between them", async () => {
		const l1 = await listen(
			fakeChain({
				chainId: 1337,
				// Like Anvil without eth_getBlockReceipts: every transaction counts as a user's.
				receipts: false,
				logs: [
					{ address: CONTRACTS.sequencerInbox, topic: TOPICS.sequencerBatchDelivered, block: 3 },
					{ address: CONTRACTS.sequencerInbox, topic: TOPICS.sequencerBatchDelivered, block: 6 },
					{ address: CONTRACTS.rollup, topic: TOPICS.assertionCreated, block: 4 },
					{ address: CONTRACTS.rollup, topic: TOPICS.assertionConfirmed, block: 5 },
					// Read: indexes below totalDelayedMessagesRead (3).
					{
						address: CONTRACTS.bridge,
						topic: TOPICS.messageDelivered,
						block: 3,
						index: 0,
						kind: 12,
					},
					{
						address: CONTRACTS.bridge,
						topic: TOPICS.messageDelivered,
						block: 3,
						index: 1,
						kind: 13,
					},
					{
						address: CONTRACTS.bridge,
						topic: TOPICS.messageDelivered,
						block: 4,
						index: 2,
						kind: 13,
					},
					// Unread: a batch report, which nobody waits on, then a deposit and a retryable.
					{
						address: CONTRACTS.bridge,
						topic: TOPICS.messageDelivered,
						block: 6,
						index: 3,
						kind: 13,
					},
					{
						address: CONTRACTS.bridge,
						topic: TOPICS.messageDelivered,
						block: 7,
						index: 4,
						kind: 12,
					},
				],
			}),
		);
		const l2 = await listen(fakeChain({ chainId: 412346 }));
		const exporter = await startChainExporter({
			chains: [
				{ name: "l1", rpc: l1 },
				{
					name: "l2",
					rpc: l2,
					parent: { name: "l1", rpc: l1, contracts: { ...CONTRACTS, deployedAt: 2 } },
				},
			],
			port: 0,
			intervalMs: 50,
		});
		closers.push(exporter.close);

		let metrics: Record<string, number> = {};
		await expect
			.poll(
				async () => {
					metrics = samples(
						await (await fetch(`http://127.0.0.1:${exporter.port}/metrics`)).text(),
					);
					return metrics['litro_blocks_total{chain="l2"}'] ?? 0;
				},
				{ timeout: 5000 },
			)
			.toBeGreaterThanOrEqual(2);

		expect(metrics['litro_rpc_up{chain="l1"}']).toBe(1);
		expect(metrics['eth_exe_chain_id{chain="l2"}']).toBe(412346);
		expect(metrics['eth_exe_block_head_transactions_in_block{chain="l1"}']).toBe(2);
		expect(metrics['eth_exe_block_head_base_fee_per_gas{chain="l1"}']).toBe(100_000_000);
		expect(metrics['eth_exe_gas_price_gwei{chain="l1"}']).toBe(2);
		expect(metrics['eth_exe_txpool_transactions{chain="l1",status="pending"}']).toBe(4);
		// Counted blocks carry two transactions and 42000 gas each.
		// Each L2 block holds ArbOS's internal transaction, not counted, and one user transaction that
		// reverted; the L1 has no receipts API, so both of its transactions count.
		const blocks = metrics['litro_blocks_total{chain="l2"}'] ?? 0;
		expect(metrics['litro_transactions_total{chain="l2"}']).toBe(blocks);
		expect(metrics['litro_failed_transactions_total{chain="l2"}']).toBe(blocks);
		expect(metrics['litro_gas_used_total{chain="l2"}']).toBe(blocks * 42_000);
		const l1Blocks = metrics['litro_blocks_total{chain="l1"}'] ?? 0;
		expect(metrics['litro_transactions_total{chain="l1"}']).toBe(l1Blocks * 2);
		expect(metrics['litro_failed_transactions_total{chain="l1"}']).toBe(0);
		expect(metrics['litro_last_user_transaction_timestamp_seconds{chain="l2"}']).toBeGreaterThan(
			1_700_000_000,
		);
		expect(metrics['litro_arbos_version{chain="l2"}']).toBe(40);
		expect(metrics['litro_arbos_version{chain="l1"}']).toBeUndefined();

		const rollup = '{chain="l2",parent="l1"}';
		expect(metrics[`litro_rollup_batches${rollup}`]).toBe(7);
		expect(metrics[`litro_rollup_delayed_messages${rollup}`]).toBe(5);
		expect(metrics[`litro_rollup_delayed_messages_read${rollup}`]).toBe(3);
		expect(
			metrics['litro_rollup_delayed_messages_total{chain="l2",parent="l1",kind="eth_deposit"}'],
		).toBe(2);
		expect(
			metrics[
				'litro_rollup_delayed_messages_total{chain="l2",parent="l1",kind="batch_posting_report"}'
			],
		).toBe(3);
		// Only the unread deposit is waited on; the unread batch report is not.
		expect(metrics[`litro_rollup_delayed_waiting${rollup}`]).toBe(1);
		expect(metrics[`litro_rollup_oldest_delayed_waiting_timestamp_seconds${rollup}`]).toBe(
			1_700_000_007,
		);
		expect(metrics[`litro_rollup_last_batch_timestamp_seconds${rollup}`]).toBe(1_700_000_006);
		expect(metrics[`litro_rollup_assertions_created_total${rollup}`]).toBe(1);
		expect(metrics[`litro_rollup_assertions_confirmed_total${rollup}`]).toBe(1);
		expect(metrics[`litro_rollup_last_assertion_confirmed_timestamp_seconds${rollup}`]).toBe(
			1_700_000_005,
		);
	});

	it("marks a chain down without dropping the others", async () => {
		const l1 = await listen(fakeChain({ chainId: 1337 }));
		const exporter = await startChainExporter({
			chains: [
				{ name: "l1", rpc: l1 },
				{ name: "l2", rpc: "http://127.0.0.1:1" },
			],
			port: 0,
			intervalMs: 50,
		});
		closers.push(exporter.close);
		await expect
			.poll(
				async () =>
					samples(await (await fetch(`http://127.0.0.1:${exporter.port}/metrics`)).text()),
				{ timeout: 5000 },
			)
			.toMatchObject({ 'litro_rpc_up{chain="l1"}': 1, 'litro_rpc_up{chain="l2"}': 0 });
	});

	it("asks a chain without txpool_status only once", async () => {
		const chain = fakeChain({ chainId: 412346, txpool: false });
		const url = await listen(chain);
		const exporter = await startChainExporter({
			chains: [{ name: "l2", rpc: url }],
			port: 0,
			intervalMs: 20,
		});
		closers.push(exporter.close);
		await expect
			.poll(
				async () =>
					samples(await (await fetch(`http://127.0.0.1:${exporter.port}/metrics`)).text())[
						'litro_blocks_total{chain="l2"}'
					] ?? 0,
				{ timeout: 5000 },
			)
			.toBeGreaterThanOrEqual(3);
		expect(chain.txpoolCalls()).toBe(1);
	});

	it("reads the chains and rollup contracts from the exported config", () => {
		const dir = mkdtempSync(join(tmpdir(), "litro-export-"));
		const network = (sequencerInbox: string) => ({ ethBridge: { ...CONTRACTS, sequencerInbox } });
		writeFileSync(
			join(dir, "localNetwork.json"),
			JSON.stringify({ l2Network: network("0xa"), l3Network: network("0xb") }),
		);
		writeFileSync(join(dir, "l2_deployment.json"), JSON.stringify({ "deployed-at": 2284 }));
		writeFileSync(join(dir, "l3_deployment.json"), JSON.stringify({ "deployed-at": 49 }));

		const l3 = chainSpecs({ variant: "l3-eth", exportConfigDir: dir });
		expect(
			l3.map((chain) => [
				chain.name,
				chain.parent?.name,
				chain.parent?.contracts.sequencerInbox,
				chain.parent?.contracts.deployedAt,
			]),
		).toEqual([
			["l1", undefined, undefined, undefined],
			["l2", "l1", "0xa", 2284],
			["l3", "l2", "0xb", 49],
		]);
		expect(chainSpecs({ variant: "l2", exportConfigDir: dir }).map((chain) => chain.name)).toEqual([
			"l1",
			"l2",
		]);
	});

	it("formats Prometheus text and leaves out series without a value", () => {
		expect(
			formatMetrics([
				{ name: "a", help: "A", type: "gauge", samples: [[{ chain: "l1" }, 1]] },
				{ name: "b", help: "B", type: "counter", samples: [] },
			]),
		).toBe('# HELP a A\n# TYPE a gauge\na{chain="l1"} 1\n');
	});
});
