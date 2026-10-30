import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
	SUMMARY_QUERIES,
	listMetrics,
	metricsSummary,
	parseDuration,
	queryInstant,
	queryRange,
} from "../src/index.js";

const servers: Server[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) {
		server.close();
	}
});

/** A Prometheus answering each API path from `routes`; `requests` records what was asked. */
async function fakePrometheus(routes: Record<string, (params: URLSearchParams) => unknown>) {
	const requests: Array<{ path: string; params: URLSearchParams }> = [];
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		requests.push({ path: url.pathname, params: url.searchParams });
		const route = routes[url.pathname];
		res.setHeader("Content-Type", "application/json");
		res.end(
			JSON.stringify(
				route
					? { status: "success", data: route(url.searchParams) }
					: { status: "error", error: `no ${url.pathname}` },
			),
		);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

const vector = (samples: Array<[Record<string, string>, string]>) => ({
	resultType: "vector",
	result: samples.map(([metric, value]) => ({ metric, value: [1_700_000_000, value] })),
});

describe("metrics queries", () => {
	it("answers each summary question under its section, keyed by chain or node", async () => {
		const answers: Record<string, ReturnType<typeof vector>> = {
			litro_rpc_up: vector([
				[{ chain: "l1" }, "1"],
				[{ chain: "l2" }, "1"],
			]),
			"rate(litro_transactions_total[1m])": vector([[{ chain: "l2" }, "4.12345"]]),
			litro_rollup_delayed_waiting: vector([[{ chain: "l2", parent: "l1" }, "0"]]),
			system_cpu_procload: vector([[{ node: "l2-validator" }, "52"]]),
			litro_fast_feed_clients: vector([[{}, "1"]]),
			"histogram_quantile(0.99, sum by (le) (rate(litro_fast_feed_delivery_latency_ms_bucket[5m])))":
				vector([[{}, "NaN"]]),
		};
		const { url } = await fakePrometheus({
			"/api/v1/query": (params) => answers[params.get("query") ?? ""] ?? vector([]),
		});
		const summary = await metricsSummary(url);
		expect(summary).toMatchObject({
			chains: { l1: { up: 1 }, l2: { up: 1, transactionsPerSecond: 4.123 } },
			rollups: { l2: { depositsWaiting: 0 } },
			nodes: { "l2-validator": { cpuPercent: 52 } },
			fastFeed: { clients: 1, latencyP99Ms: null },
		});
		// A section the testnode does not run, or a query with no series, leaves no field.
		expect(summary.chains["l1"]).not.toHaveProperty("transactionsPerSecond");
	});

	it("covers every summary question with a distinct field", () => {
		const fields = SUMMARY_QUERIES.map((query) => `${query.section}.${query.field}`);
		expect(new Set(fields).size).toBe(fields.length);
	});

	it("returns a range as timestamped points over the window asked for", async () => {
		const { url, requests } = await fakePrometheus({
			"/api/v1/query_range": () => ({
				resultType: "matrix",
				result: [
					{
						metric: { chain: "l2" },
						values: [
							[1_700_000_000, "2"],
							[1_700_000_060, "+Inf"],
						],
					},
				],
			}),
		});
		const series = await queryRange(url, "up", {
			sinceSeconds: 600,
			stepSeconds: 60,
			now: 1_700_000_600,
		});
		expect(series).toEqual([
			{
				metric: { chain: "l2" },
				points: [
					{ time: "2023-11-14T22:13:20.000Z", value: 2 },
					{ time: "2023-11-14T22:14:20.000Z", value: null },
				],
			},
		]);
		const asked = requests[0]?.params;
		expect([asked?.get("start"), asked?.get("end"), asked?.get("step")]).toEqual([
			"1700000000",
			"1700000600",
			"60",
		]);
	});

	it("lists metrics once each, with every source that reports them, filtered in full", async () => {
		const { url } = await fakePrometheus({
			"/api/v1/targets/metadata": () => [
				{
					target: { job: "nitro", node: "l2-sequencer" },
					metric: "arb_block_basefee",
					type: "gauge",
					help: "",
				},
				{
					target: { job: "nitro", node: "l3" },
					metric: "arb_block_basefee",
					type: "gauge",
					help: "",
				},
				{ target: { job: "chain" }, metric: "litro_rpc_up", type: "gauge", help: "RPC answered" },
				{
					target: { job: "nitro", node: "l3" },
					metric: "arb_block_basefee_extra",
					type: "gauge",
					help: "",
				},
			],
		});
		expect(await listMetrics(url, "arb_block_basefee")).toEqual([
			{ name: "arb_block_basefee", type: "gauge", help: "", sources: ["l2-sequencer", "l3"] },
		]);
		expect((await listMetrics(url)).map((metric) => [metric.name, metric.sources])).toEqual([
			["arb_block_basefee", ["l2-sequencer", "l3"]],
			["arb_block_basefee_extra", ["l3"]],
			["litro_rpc_up", ["chain"]],
		]);
	});

	it("passes Prometheus's error on, so a bad query says why", async () => {
		const { url } = await fakePrometheus({});
		await expect(queryInstant(url, "rate(")).rejects.toThrow(/Prometheus: no \/api\/v1\/query/);
	});

	it("reads durations in seconds, minutes, hours and days", () => {
		expect([
			parseDuration("30s", "since"),
			parseDuration("15m", "since"),
			parseDuration("2h", "since"),
			parseDuration("1d", "since"),
		]).toEqual([30, 900, 7200, 86_400]);
		expect(() => parseDuration("10 minutes", "since")).toThrow(/since must look like 30s/);
	});
});
