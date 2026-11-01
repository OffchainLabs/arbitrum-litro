// @ts-check

// Prometheus and Grafana beside a testnode container, for `litro start --metrics`. Both join a
// network with the testnode and are configured with `docker cp` before they start, so nothing is
// bind-mounted and the stack runs the same on Docker Desktop, Colima or a remote daemon.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDocker } from "./containers.mjs";

/**
 * @typedef {import("./types.js").ObservabilityState} ObservabilityState
 * @typedef {import("./types.js").ScrapeTarget} ScrapeTarget
 */

/** Pinned like every other image litro runs. */
export const PROMETHEUS_IMAGE = "prom/prometheus:v3.15.0";
export const GRAFANA_IMAGE = "grafana/grafana:13.2.3";

/** Marks the stack's containers and network with the testnode container they watch. */
export const METRICS_FOR_LABEL = "org.offchainlabs.testnode.metrics-for";

/** The dashboard Grafana opens on. */
const HOME_DASHBOARD = "litro-chains.json";

/** @param {string} containerName */
const stackNames = (containerName) => ({
	network: `${containerName}-metrics`,
	prometheus: `${containerName}-prometheus`,
	grafana: `${containerName}-grafana`,
});

/**
 * Prometheus's configuration: every target, scraped every 2s by the testnode's network alias.
 * JSON is valid YAML, which Prometheus reads.
 *
 * @param {ScrapeTarget[]} targets
 */
export function prometheusConfig(targets) {
	const jobs = [...new Set(targets.map((target) => target.job))];
	return {
		global: { scrape_interval: "2s", evaluation_interval: "2s" },
		scrape_configs: jobs.map((job) => {
			const ofJob = targets.filter((target) => target.job === job);
			return {
				job_name: job,
				metrics_path: ofJob[0]?.path,
				static_configs: ofJob.map((target) => ({
					targets: [`testnode:${target.port}`],
					labels: target.labels,
				})),
			};
		}),
	};
}

/** Grafana's datasource and dashboard provisioning, as JSON (valid YAML). */
export function grafanaProvisioning() {
	return {
		datasource: {
			apiVersion: 1,
			datasources: [
				{
					name: "Prometheus",
					uid: "prometheus",
					type: "prometheus",
					access: "proxy",
					url: "http://prometheus:9090",
					isDefault: true,
					jsonData: { timeInterval: "2s" },
				},
			],
		},
		dashboards: {
			apiVersion: 1,
			providers: [
				{
					name: "litro",
					folder: "litro",
					type: "file",
					options: { path: "/var/lib/grafana/dashboards" },
				},
			],
		},
	};
}

/** Local-only Grafana: no login, no phoning home, the chains dashboard as home. */
const GRAFANA_ENVIRONMENT = {
	GF_AUTH_ANONYMOUS_ENABLED: "true",
	GF_AUTH_ANONYMOUS_ORG_ROLE: "Admin",
	GF_AUTH_DISABLE_LOGIN_FORM: "true",
	GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH: `/var/lib/grafana/dashboards/${HOME_DASHBOARD}`,
	GF_ANALYTICS_REPORTING_ENABLED: "false",
	GF_ANALYTICS_CHECK_FOR_UPDATES: "false",
	GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: "false",
	GF_NEWS_NEWS_FEED_ENABLED: "false",
};

/**
 * The Grafana and Prometheus URLs of a testnode's stack, read from the companions' port bindings,
 * or undefined when it has none.
 *
 * @param {string} containerName
 * @returns {{ grafanaUrl: string; prometheusUrl: string } | undefined}
 */
export function findMetricsStack(containerName) {
	const names = stackNames(containerName);
	/** @param {string} name @param {string} port */
	const hostUrl = (name, port) => {
		const [binding] = JSON.parse(
			runDocker([
				"inspect",
				"--format",
				`{{json (index .HostConfig.PortBindings "${port}/tcp")}}`,
				name,
			]),
		);
		return `http://127.0.0.1:${binding.HostPort}`;
	};
	try {
		return {
			grafanaUrl: hostUrl(names.grafana, "3000"),
			prometheusUrl: hostUrl(names.prometheus, "9090"),
		};
	} catch {
		return undefined;
	}
}

/**
 * Remove a testnode's stack, or every stack when no container is named.
 *
 * @param {string} [containerName]
 */
export function removeMetricsStack(containerName) {
	const filter = `label=${METRICS_FOR_LABEL}${containerName ? `=${containerName}` : ""}`;
	const containers = runDocker(["ps", "-aq", "--filter", filter]).split("\n").filter(Boolean);
	if (containers.length > 0) {
		runDocker(["rm", "-f", ...containers]);
	}
	for (const network of runDocker(["network", "ls", "-q", "--filter", filter])
		.split("\n")
		.filter(Boolean)) {
		// The testnode container stays attached until it is removed; detach it so the network can go.
		const attached = runDocker([
			"network",
			"inspect",
			"--format",
			"{{range .Containers}}{{.Name}} {{end}}",
			network,
		])
			.trim()
			.split(" ")
			.filter(Boolean);
		for (const container of attached) {
			runDocker(["network", "disconnect", "--force", network, container]);
		}
		runDocker(["network", "rm", network]);
	}
}

/**
 * @param {{ name: string; network: string; alias: string; port: string; image: string; env?: Record<string, string>; args?: string[]; containerName: string }} spec
 */
function createCompanion({
	name,
	network,
	alias,
	port,
	image,
	env = {},
	args = [],
	containerName,
}) {
	runDocker([
		"create",
		"--name",
		name,
		"--label",
		`${METRICS_FOR_LABEL}=${containerName}`,
		"--network",
		network,
		"--network-alias",
		alias,
		"-p",
		port,
		...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
		image,
		...args,
	]);
}

/**
 * @param {() => Promise<boolean>} ready
 * @param {number} timeoutMs
 * @param {() => string} failure
 */
async function waitUntil(ready, timeoutMs, failure) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await ready().catch(() => false)) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(failure());
}

/**
 * Wait for Prometheus to scrape every target successfully. A Nitro target that refuses connections
 * means the image's Nitro nodes run without metrics, i.e. the image predates them.
 *
 * @param {string} prometheusUrl
 * @param {number} expected
 * @param {number} timeoutMs
 */
async function waitForTargets(prometheusUrl, expected, timeoutMs) {
	/** @type {Array<{ health: string; lastError: string; scrapeUrl: string }>} */
	let targets = [];
	await waitUntil(
		async () => {
			const response = await fetch(`${prometheusUrl}/api/v1/targets?state=active`);
			const body = /** @type {{ data: { activeTargets: typeof targets } }} */ (
				await response.json()
			);
			targets = body.data.activeTargets;
			return targets.length === expected && targets.every((target) => target.health === "up");
		},
		timeoutMs,
		() => {
			const down = targets.filter((target) => target.health !== "up");
			return `Prometheus could not scrape ${down.map((t) => `${t.scrapeUrl} (${t.lastError || t.health})`).join(", ") || "its targets"}. Metrics need an image from litro v0.5.0 or later.`;
		},
	);
}

/**
 * Start Prometheus and Grafana for a running testnode container.
 *
 * @param {{
 *   containerName: string; observability: ObservabilityState; targets: ScrapeTarget[];
 *   dashboardsDir: string; timeoutMs?: number;
 * }} options
 * @returns {Promise<{ grafanaUrl: string; prometheusUrl: string }>}
 */
export async function startMetricsStack({
	containerName,
	observability,
	targets,
	dashboardsDir,
	timeoutMs = 120_000,
}) {
	const names = stackNames(containerName);
	removeMetricsStack(containerName);
	runDocker([
		"network",
		"create",
		"--label",
		`${METRICS_FOR_LABEL}=${containerName}`,
		names.network,
	]);
	runDocker(["network", "connect", "--alias", "testnode", names.network, containerName]);
	createCompanion({
		name: names.prometheus,
		network: names.network,
		alias: "prometheus",
		port: `127.0.0.1:${observability.prometheusPort}:9090`,
		image: PROMETHEUS_IMAGE,
		args: ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.retention.time=1d"],
		containerName,
	});
	createCompanion({
		name: names.grafana,
		network: names.network,
		alias: "grafana",
		port: `127.0.0.1:${observability.grafanaPort}:3000`,
		image: GRAFANA_IMAGE,
		env: GRAFANA_ENVIRONMENT,
		containerName,
	});
	const staging = mkdtempSync(join(tmpdir(), "litro-metrics-"));
	try {
		const provisioning = grafanaProvisioning();
		writeFileSync(
			join(staging, "prometheus.yml"),
			JSON.stringify(prometheusConfig(targets), null, 2),
		);
		writeFileSync(
			join(staging, "datasource.yaml"),
			JSON.stringify(provisioning.datasource, null, 2),
		);
		writeFileSync(
			join(staging, "dashboards.yaml"),
			JSON.stringify(provisioning.dashboards, null, 2),
		);
		runDocker([
			"cp",
			join(staging, "prometheus.yml"),
			`${names.prometheus}:/etc/prometheus/prometheus.yml`,
		]);
		runDocker([
			"cp",
			join(staging, "datasource.yaml"),
			`${names.grafana}:/etc/grafana/provisioning/datasources/litro.yaml`,
		]);
		runDocker([
			"cp",
			join(staging, "dashboards.yaml"),
			`${names.grafana}:/etc/grafana/provisioning/dashboards/litro.yaml`,
		]);
		runDocker(["cp", `${dashboardsDir}/.`, `${names.grafana}:/var/lib/grafana/dashboards`]);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	runDocker(["start", names.prometheus, names.grafana]);
	const prometheusUrl = `http://127.0.0.1:${observability.prometheusPort}`;
	const grafanaUrl = `http://127.0.0.1:${observability.grafanaPort}`;
	await waitForTargets(prometheusUrl, targets.length, timeoutMs);
	await waitUntil(
		async () => (await fetch(`${grafanaUrl}/api/health`)).ok,
		timeoutMs,
		() => `Grafana did not answer on ${grafanaUrl}`,
	);
	return { grafanaUrl, prometheusUrl };
}
