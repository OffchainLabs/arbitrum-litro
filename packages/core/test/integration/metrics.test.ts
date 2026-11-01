import { readFileSync } from "node:fs";
import { request } from "node:http";
import { http, type Hex, createWalletClient, defineChain, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { accounts } from "../../src/accounts.js";

// Runs against a testnode started with `litro start --metrics` (and optionally the Fast Feed). Each
// scenario does something a developer would do and checks the metrics behind the dashboards see it:
//
//   pnpm dev start --metrics --fast-feed-enabled
//   LOCAL_NETWORK_PATH=.arbitrum-testnode/latest/l3-eth/config/localNetwork.json \
//     pnpm exec vitest run -c vitest.integration.config.ts packages/core/test/integration/metrics.test.ts

const PROMETHEUS_URL = process.env["PROMETHEUS_URL"] || "http://127.0.0.1:9090";
const GRAFANA_URL = process.env["GRAFANA_URL"] || "http://127.0.0.1:3000";
const L1_RPC_URL = process.env["L1_RPC_URL"] || "http://127.0.0.1:8545";
const L2_RPC_URL = process.env["L2_RPC_URL"] || "http://127.0.0.1:8547";
const LOCAL_NETWORK_PATH = process.env["LOCAL_NETWORK_PATH"] || "";
const EXPECT_L3 = process.env["METRICS_EXPECT_L3"] !== "false";
const FAST_FEED_URL = process.env["FAST_FEED_URL"] || "";

/** The value of a PromQL query's first series, or undefined when it returns nothing. */
async function query(promql: string): Promise<number | undefined> {
	const response = await fetch(
		`${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(promql)}`,
	);
	const body = (await response.json()) as {
		data: { result: Array<{ value: [number, string] }> };
	};
	const first = body.data.result[0];
	return first ? Number(first.value[1]) : undefined;
}

/** Poll a query until `accept` holds for its value. */
async function eventually(promql: string, accept: (value: number) => boolean, timeoutMs = 60_000) {
	await expect
		.poll(
			async () => {
				const value = await query(promql);
				return value !== undefined && accept(value);
			},
			{ timeout: timeoutMs, interval: 1000, message: `${promql} never reached the expected value` },
		)
		.toBe(true);
}

async function chainOf(url: string) {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
	});
	const id = Number(((await response.json()) as { result: string }).result);
	return defineChain({
		id,
		name: `chain-${id}`,
		nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
		rpcUrls: { default: { http: [url] } },
	});
}

async function wallet(url: string, privateKey: Hex) {
	return createWalletClient({
		account: privateKeyToAccount(privateKey),
		chain: await chainOf(url),
		transport: http(url),
	});
}

/** The HTTP status a WebSocket upgrade with `apiKey` gets. fetch refuses Upgrade headers. */
function upgradeStatus(feedUrl: string, apiKey: string) {
	const url = new URL(feedUrl);
	return new Promise<number | undefined>((resolve, reject) => {
		request(
			{
				host: url.hostname,
				port: url.port,
				path: url.pathname,
				headers: {
					Connection: "Upgrade",
					Upgrade: "websocket",
					"Sec-WebSocket-Version": "13",
					"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
					Authorization: `Bearer ${apiKey}`,
				},
			},
			(res) => {
				res.resume();
				resolve(res.statusCode);
			},
		)
			.on("error", reject)
			.end();
	});
}

describe("litro metrics", () => {
	it("scrapes every Nitro node, the chains and the relay", async () => {
		const response = await fetch(`${PROMETHEUS_URL}/api/v1/targets?state=active`);
		const { data } = (await response.json()) as {
			data: { activeTargets: Array<{ labels: Record<string, string>; health: string }> };
		};
		const targets = data.activeTargets.map((target) => [
			target.labels["job"],
			target.labels["node"] ?? "",
			target.health,
		]);
		expect(targets).toEqual(
			expect.arrayContaining([
				["nitro", "l2-sequencer", "up"],
				["nitro", "l2-validator", "up"],
				["chain", "", "up"],
				...(EXPECT_L3 ? [["nitro", "l3", "up"]] : []),
				...(FAST_FEED_URL ? [["fast-feed", "", "up"]] : []),
			]),
		);
		expect(targets.every(([, , health]) => health === "up")).toBe(true);
	});

	it("serves the dashboards in Grafana, with the chains dashboard as home", async () => {
		const search = (await (await fetch(`${GRAFANA_URL}/api/search?tag=litro`)).json()) as Array<{
			uid: string;
		}>;
		expect(search.map((dashboard) => dashboard.uid).sort()).toEqual(
			["litro-chains", "litro-fast-feed", "litro-nitro-all", "litro-nitro-nodes"].sort(),
		);
		// A home dashboard set by path is served through a redirect to its slug.
		const home = (await (await fetch(`${GRAFANA_URL}/api/dashboards/home`)).json()) as {
			redirectUri?: string;
		};
		expect(home.redirectUri).toMatch(/\/litro-chains$/);
	});

	it("exports Nitro's own metrics from every node", async () => {
		const nodes = EXPECT_L3 ? 3 : 2;
		await eventually(
			'count(count by (node) ({job="nitro", __name__=~"arb_.+"}))',
			(v) => v === nodes,
		);
	});

	it("shows the L1, which has no metrics of its own, producing blocks", async () => {
		await eventually('eth_exe_block_most_recent_number{chain="l1"}', (v) => v > 0);
		const before = (await query('eth_exe_block_most_recent_number{chain="l1"}')) ?? 0;
		await eventually(
			'eth_exe_block_most_recent_number{chain="l1"}',
			(v) => v >= before + 2,
			15_000,
		);
	});

	it("shows transactions sent to L2 in the throughput panels", async () => {
		const client = await wallet(L2_RPC_URL, accounts.funnel.privateKey);
		const before = (await query('litro_transactions_total{chain="l2"}')) ?? 0;
		for (let i = 0; i < 20; i++) {
			await client.sendTransaction({ to: client.account.address, value: 1n });
		}
		await eventually('litro_transactions_total{chain="l2"}', (v) => v >= before + 20, 30_000);
	});

	it("counts a reverting transaction as failed, not as an RPC error", async () => {
		const client = await wallet(L2_RPC_URL, accounts.funnel.privateKey);
		const before = (await query('litro_failed_transactions_total{chain="l2"}')) ?? 0;
		// ArbSys has no such method, so the call reverts; the explicit gas skips estimation, which
		// would refuse to send it.
		await client.sendTransaction({
			to: "0x0000000000000000000000000000000000000064",
			data: "0xdeadbeef",
			gas: 100_000n,
		});
		await eventually('litro_failed_transactions_total{chain="l2"}', (v) => v >= before + 1, 30_000);
	});

	it("shows the batch poster posting those transactions to L1", async () => {
		await eventually('litro_rollup_batches{chain="l2"}', (v) => v > 0);
		const before = (await query('litro_rollup_batches{chain="l2"}')) ?? 0;
		const client = await wallet(L2_RPC_URL, accounts.funnel.privateKey);
		await client.sendTransaction({ to: client.account.address, value: 1n });
		await eventually('litro_rollup_batches{chain="l2"}', (v) => v > before, 120_000);
		await eventually(
			'time() - litro_rollup_last_batch_timestamp_seconds{chain="l2"}',
			(v) => v < 120,
		);
	}, 150_000);

	it.skipIf(!LOCAL_NETWORK_PATH)(
		"shows a deposit arriving in the delayed inbox and leaving nothing waiting once a batch reads it",
		async () => {
			const network = JSON.parse(readFileSync(LOCAL_NETWORK_PATH, "utf-8"));
			const deposits = 'litro_rollup_delayed_messages_total{chain="l2", kind="eth_deposit"}';
			const before = (await query(deposits)) ?? 0;
			const client = await wallet(L1_RPC_URL, accounts.funnel.privateKey);
			await client.writeContract({
				address: network.l2Network.ethBridge.inbox,
				abi: parseAbi(["function depositEth() payable returns (uint256)"]),
				functionName: "depositEth",
				value: parseEther("0.01"),
			});
			await eventually(deposits, (v) => v >= before + 1, 30_000);
			await eventually('litro_rollup_delayed_waiting{chain="l2"}', (v) => v === 0, 90_000);
		},
		150_000,
	);

	it.skipIf(!FAST_FEED_URL)(
		"measures how fast the Fast Feed delivers each transaction",
		async () => {
			const count = "litro_fast_feed_delivery_latency_ms_count";
			const before = (await query(count)) ?? 0;
			const client = await wallet(L2_RPC_URL, accounts.funnel.privateKey);
			await client.sendTransaction({ to: client.account.address, value: 1n });
			await eventually(count, (v) => v > before, 15_000);
			await eventually(
				"histogram_quantile(0.99, sum by (le) (rate(litro_fast_feed_delivery_latency_ms_bucket[5m])))",
				(v) => v > 0 && v < 1000,
			);
		},
	);

	it.skipIf(!FAST_FEED_URL)("counts a Fast Feed client turned away for a bad key", async () => {
		const before = (await query('litro_fast_feed_rejected_total{status="401"}')) ?? 0;
		expect(await upgradeStatus(FAST_FEED_URL, "wrong")).toBe(401);
		await eventually(
			'litro_fast_feed_rejected_total{status="401"}',
			(v) => v >= before + 1,
			15_000,
		);
	});
});
