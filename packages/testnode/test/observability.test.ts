import { describe, expect, it } from "vitest";
import {
	buildStartTestnodeState,
	grafanaProvisioning,
	observabilityEndpoints,
	prometheusConfig,
	resolveObservabilityOptions,
	scrapeTargets,
	testnodeDockerRunArgs,
} from "../src/index.js";

const start = (l3Enabled: boolean, observability: Record<string, unknown>) =>
	buildStartTestnodeState({ cwd: "/work", l3Enabled, version: "v1.2.3", observability });

describe("observability options", () => {
	it("is off by default, with Grafana on 3000 and Prometheus on 9090", () => {
		expect(resolveObservabilityOptions()).toEqual({
			metrics: false,
			pprof: false,
			grafanaPort: 3000,
			prometheusPort: 9090,
		});
	});

	it("rejects ports that are not positive integers", () => {
		expect(() => resolveObservabilityOptions({ grafanaPort: "abc" })).toThrow(/grafana-port/);
		expect(() => resolveObservabilityOptions({ prometheusPort: 0 })).toThrow(/prometheus-port/);
	});

	it("adds nothing to docker run when off", () => {
		const args = testnodeDockerRunArgs(start(true, {}));
		expect(args.join(" ")).not.toMatch(/TESTNODE_METRICS|TESTNODE_PPROF|:60[78]\d/);
	});

	it("publishes metrics for every node the variant runs, and the chain exporter", () => {
		const l3 = testnodeDockerRunArgs(start(true, { metricsEnabled: true })).join(" ");
		expect(l3).toContain("-e TESTNODE_METRICS=true");
		for (const port of [6070, 6072, 6074, 6080]) {
			expect(l3).toContain(`-p 127.0.0.1:${port}:${port}`);
		}
		const l2 = testnodeDockerRunArgs(start(false, { metricsEnabled: true })).join(" ");
		expect(l2).not.toContain("6074");
	});

	it("publishes pprof on its own", () => {
		const args = testnodeDockerRunArgs(start(false, { pprofEnabled: true })).join(" ");
		expect(args).toContain("-e TESTNODE_PPROF=true");
		expect(args).toContain("-p 127.0.0.1:6071:6071");
		expect(args).not.toContain("6070");
	});

	it("names each endpoint as the endpoint table does", () => {
		const state = resolveObservabilityOptions({ metricsEnabled: true, pprofEnabled: true });
		expect(observabilityEndpoints(state, { l3Enabled: false, fastFeed: true })).toEqual({
			l2SequencerMetrics: "http://127.0.0.1:6070/debug/metrics/prometheus",
			l2ValidatorMetrics: "http://127.0.0.1:6072/debug/metrics/prometheus",
			chainMetrics: "http://127.0.0.1:6080/metrics",
			l2SequencerPprof: "http://127.0.0.1:6071/debug/pprof/",
			l2ValidatorPprof: "http://127.0.0.1:6073/debug/pprof/",
			fastFeedMetrics: "http://127.0.0.1:9646/metrics",
		});
	});
});

describe("prometheus config", () => {
	it("scrapes every Nitro node, the chain exporter and, with the Fast Feed, the relay", () => {
		const config = prometheusConfig(scrapeTargets({ l3Enabled: true, fastFeed: true }));
		expect(config.global.scrape_interval).toBe("2s");
		expect(config.scrape_configs).toEqual([
			{
				job_name: "nitro",
				metrics_path: "/debug/metrics/prometheus",
				static_configs: [
					{ targets: ["testnode:6070"], labels: { node: "l2-sequencer", chain: "l2" } },
					{ targets: ["testnode:6072"], labels: { node: "l2-validator", chain: "l2" } },
					{ targets: ["testnode:6074"], labels: { node: "l3", chain: "l3" } },
				],
			},
			{
				job_name: "chain",
				metrics_path: "/metrics",
				static_configs: [{ targets: ["testnode:6080"], labels: {} }],
			},
			{
				job_name: "fast-feed",
				metrics_path: "/metrics",
				static_configs: [{ targets: ["testnode:9646"], labels: {} }],
			},
		]);
	});

	it("has no L3 or relay target when the testnode runs neither", () => {
		const jobs = prometheusConfig(
			scrapeTargets({ l3Enabled: false, fastFeed: false }),
		).scrape_configs;
		expect(jobs.map((job) => job.job_name)).toEqual(["nitro", "chain"]);
		expect(jobs[0]?.static_configs).toHaveLength(2);
	});

	it("points Grafana at Prometheus by its network alias and loads the dashboards folder", () => {
		const provisioning = grafanaProvisioning();
		expect(provisioning.datasource.datasources[0]).toMatchObject({
			uid: "prometheus",
			url: "http://prometheus:9090",
		});
		expect(provisioning.dashboards.providers[0]?.options.path).toBe("/var/lib/grafana/dashboards");
	});
});
