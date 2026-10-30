// @ts-check

// Metrics for everything the testnode runs: Prometheus metrics and pprof on each Nitro node, the
// chain exporter (the L1, which has no metrics of its own, and rollup activity) and the Fast Feed
// relay. The image owns the processes (docker/observability.sh); this module turns caller options
// into the container settings and describes what Prometheus should scrape.

import { CONTAINER_ENDPOINTS, endpointUrl } from "./endpoints.mjs";
import { toBoolean, toNumber } from "./inputs.mjs";

/**
 * @typedef {import("./types.js").ObservabilityOptions} ObservabilityOptions
 * @typedef {import("./types.js").ObservabilityState} ObservabilityState
 * @typedef {import("./types.js").ScrapeTarget} ScrapeTarget
 */

/** Each Nitro process, the ports its metrics and pprof listen on, and the chain it serves. */
export const NITRO_NODES = /** @type {const} */ ([
	{ node: "l2-sequencer", chain: "l2", metricsPort: 6070, pprofPort: 6071 },
	{ node: "l2-validator", chain: "l2", metricsPort: 6072, pprofPort: 6073 },
	{ node: "l3", chain: "l3", metricsPort: 6074, pprofPort: 6075 },
]);

export const CHAIN_EXPORTER_PORT = 6080;
export const FAST_FEED_RELAY_PORT = 9646;

/**
 * @param {ObservabilityOptions} [options]
 * @returns {ObservabilityState}
 */
export function resolveObservabilityOptions(options = {}) {
	return {
		metrics: toBoolean(options.metricsEnabled),
		pprof: toBoolean(options.pprofEnabled),
		grafanaPort: toNumber(options.grafanaPort, "grafana-port", { integer: true, min: 1 }) ?? 3000,
		prometheusPort:
			toNumber(options.prometheusPort, "prometheus-port", { integer: true, min: 1 }) ?? 9090,
	};
}

/** @param {boolean} l3Enabled */
const runningNodes = (l3Enabled) => NITRO_NODES.filter((node) => l3Enabled || node.chain !== "l3");

/**
 * @param {ObservabilityState} state
 * @returns {Record<string, string>}
 */
export function observabilityEnvironment(state) {
	/** @type {Record<string, string>} */
	const env = {};
	if (state.metrics) {
		env["TESTNODE_METRICS"] = "true";
	}
	if (state.pprof) {
		env["TESTNODE_PPROF"] = "true";
	}
	return env;
}

/**
 * The container ports to publish on 127.0.0.1, for nodes the variant runs.
 *
 * @param {ObservabilityState} state
 * @param {boolean} l3Enabled
 */
function publishedPorts(state, l3Enabled) {
	const nodes = runningNodes(l3Enabled);
	return [
		...(state.metrics ? [...nodes.map((node) => node.metricsPort), CHAIN_EXPORTER_PORT] : []),
		...(state.pprof ? nodes.map((node) => node.pprofPort) : []),
	];
}

/**
 * `docker run` arguments: the environment that switches metrics and pprof on, and their ports.
 *
 * @param {ObservabilityState} state
 * @param {boolean} l3Enabled
 * @returns {string[]}
 */
export function observabilityDockerArgs(state, l3Enabled) {
	return [
		...publishedPorts(state, l3Enabled).flatMap((port) => ["-p", `127.0.0.1:${port}:${port}`]),
		...Object.entries(observabilityEnvironment(state)).flatMap(([key, value]) => [
			"-e",
			`${key}=${value}`,
		]),
	];
}

/**
 * The endpoints on the host, by name, for the `start` result.
 *
 * @param {ObservabilityState} state
 * @param {{ l3Enabled: boolean; fastFeed: boolean }} features
 * @returns {Record<string, string>}
 */
export function observabilityEndpoints(state, { l3Enabled, fastFeed }) {
	/** @type {Record<string, string>} */
	const endpoints = {};
	for (const port of publishedPorts(state, l3Enabled)) {
		const containerPort = /** @type {import("./endpoints.mjs").ContainerPort} */ (port);
		endpoints[CONTAINER_ENDPOINTS[containerPort].name] = endpointUrl(containerPort, port);
	}
	if (state.metrics && fastFeed) {
		endpoints["fastFeedMetrics"] = `http://127.0.0.1:${FAST_FEED_RELAY_PORT}/metrics`;
	}
	return endpoints;
}

/**
 * What Prometheus scrapes inside the testnode container, labelled so dashboards can pick a node
 * or a chain.
 *
 * @param {{ l3Enabled: boolean; fastFeed: boolean }} features
 * @returns {ScrapeTarget[]}
 */
export function scrapeTargets({ l3Enabled, fastFeed }) {
	return [
		...runningNodes(l3Enabled).map((node) => ({
			job: "nitro",
			port: node.metricsPort,
			path: "/debug/metrics/prometheus",
			labels: { node: node.node, chain: node.chain },
		})),
		{ job: "chain", port: CHAIN_EXPORTER_PORT, path: "/metrics", labels: {} },
		...(fastFeed
			? [{ job: "fast-feed", port: FAST_FEED_RELAY_PORT, path: "/metrics", labels: {} }]
			: []),
	];
}
