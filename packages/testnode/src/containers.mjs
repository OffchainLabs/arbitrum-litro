// @ts-check

// The testnode containers `start` runs, as docker sees them: running docker, reading a
// container's state and logs, and finding every start container from any directory.

import { execFileSync, spawnSync } from "node:child_process";
import { CONTAINER_ENDPOINTS, endpointUrl, isContainerEndpoint } from "./endpoints.mjs";

/**
 * @typedef {import("./types.js").ContainerDiagnostics} ContainerDiagnostics
 * @typedef {import("./types.js").StartContainer} StartContainer
 * @typedef {{ HostIp: string; HostPort: string }} PortBinding
 * @typedef {{
 *   Name: string;
 *   Config: { Image: string; Labels: Record<string, string> | null };
 *   State: { Status: string; Health?: { Status: string } };
 *   HostConfig: { PortBindings: Record<string, PortBinding[] | null> | null };
 * }} DockerInspect the parts of `docker inspect` output read here
 */

/** Set on every container `start` runs, so `stop`, `status` and `logs` find them from anywhere. */
export const START_CONTAINER_LABEL = "org.offchainlabs.testnode.start";

/**
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [options]
 * @returns {string}
 */
export function runDocker(args, options = {}) {
	return /** @type {string} */ (
		execFileSync("docker", args, {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
			...options,
		})
	);
}

/** @param {string} containerName */
export function inspectContainer(containerName) {
	const [running, health] = runDocker([
		"inspect",
		"--format",
		"{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{end}}",
		containerName,
	])
		.trim()
		.split(" ");
	return { running: running === "true", health };
}

/** @param {string} containerName */
export function removeContainer(containerName) {
	try {
		runDocker(["rm", "-f", containerName]);
	} catch {
		// ignore missing container
	}
}

/**
 * Every container `start` ran, running or not.
 *
 * @returns {StartContainer[]}
 */
export function listStartContainers() {
	const ids = runDocker(["ps", "-aq", "--filter", `label=${START_CONTAINER_LABEL}`])
		.split("\n")
		.filter(Boolean);
	if (ids.length === 0) {
		return [];
	}
	/** @type {DockerInspect[]} */
	const inspected = JSON.parse(runDocker(["inspect", ...ids]));
	return inspected.map(toStartContainer);
}

/**
 * @param {DockerInspect} container
 * @returns {StartContainer}
 */
export function toStartContainer(container) {
	return {
		name: container.Name.replace(/^\//, ""),
		variant: container.Config.Labels?.[START_CONTAINER_LABEL] ?? "",
		image: container.Config.Image,
		state: container.State.Status,
		health: container.State.Health?.Status ?? "",
		endpoints: publishedEndpoints(container.HostConfig.PortBindings ?? {}),
	};
}

/**
 * The endpoints a container publishes, read from its port bindings, which a stopped container
 * keeps too.
 *
 * @param {Record<string, PortBinding[] | null>} bindings keyed `<container port>/tcp`
 * @returns {Record<string, string>}
 */
function publishedEndpoints(bindings) {
	/** @type {Record<string, string>} */
	const endpoints = {};
	for (const [key, published] of Object.entries(bindings)) {
		const port = Number.parseInt(key, 10);
		const binding = published?.[0];
		if (binding && isContainerEndpoint(port)) {
			const host = binding.HostIp && binding.HostIp !== "0.0.0.0" ? binding.HostIp : "127.0.0.1";
			endpoints[CONTAINER_ENDPOINTS[port].name] = endpointUrl(port, binding.HostPort, host);
		}
	}
	return endpoints;
}

/**
 * The container a command acts on: the named one, else the only running one, else the only one.
 *
 * @param {StartContainer[]} containers
 * @param {string | undefined} name
 * @returns {StartContainer}
 */
export function selectStartContainer(containers, name) {
	if (name) {
		const named = containers.find((container) => container.name === name);
		if (!named) {
			throw new Error(`No start container named ${name}`);
		}
		return named;
	}
	const running = containers.filter((container) => container.state === "running");
	const candidates = running.length > 0 ? running : containers;
	const [only] = candidates;
	if (candidates.length !== 1 || !only) {
		throw new Error(
			candidates.length === 0
				? "No start container found"
				: `Pick a container with --container: ${candidates.map((c) => c.name).join(", ")}`,
		);
	}
	return only;
}

/**
 * The last `tailLines` log lines of a container, without Nitro's per-block lines.
 *
 * @param {string} containerName
 * @param {number} tailLines
 */
export function readContainerLogs(containerName, tailLines) {
	// `docker logs` replays the container's stdout and stderr separately, and Nitro writes to
	// stderr, so keep both. Nitro also logs every block: read a window much larger than the tail
	// kept, because filterContainerLogs drops the block lines first.
	const result = spawnSync("docker", ["logs", "--tail", String(tailLines * 50), containerName], {
		encoding: "utf-8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error || result.status !== 0) {
		throw new Error(result.error?.message ?? result.stderr.trim());
	}
	return filterContainerLogs(`${result.stdout}${result.stderr}`, tailLines);
}

/**
 * @param {string} logs
 * @param {number} tailLines
 */
export function filterContainerLogs(logs, tailLines) {
	return logs
		.split(/\r?\n/)
		.filter((line) => !/Block Number|Block Hash|Block Time/.test(line))
		.slice(-tailLines)
		.join("\n");
}

/**
 * @param {string} containerName
 * @param {{ tailLines?: number }} [options]
 * @returns {ContainerDiagnostics}
 */
export function collectContainerDiagnostics(containerName, options = {}) {
	const diagnostics = /** @type {ContainerDiagnostics} */ ({ errors: [] });
	try {
		diagnostics.inspect = runDocker([
			"inspect",
			"--format",
			"{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}",
			containerName,
		]).trim();
	} catch (error) {
		diagnostics.errors.push(
			`inspect failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		diagnostics.logs = readContainerLogs(containerName, options.tailLines ?? 100);
	} catch (error) {
		diagnostics.errors.push(
			`log collection failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return diagnostics;
}
