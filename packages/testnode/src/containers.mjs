// @ts-check

// The testnode containers `start` runs, as docker sees them: running docker, reading a
// container's state and logs, and finding every start container from any directory.

import { execFileSync, spawnSync } from "node:child_process";
import { CONTAINER_ENDPOINTS, endpointUrl, isContainerEndpoint } from "./endpoints.mjs";

/**
 * @typedef {import("./types.js").ContainerDiagnostics} ContainerDiagnostics
 * @typedef {import("./types.js").ContainerState} ContainerState
 * @typedef {import("./types.js").LogCaptureResult} LogCaptureResult
 * @typedef {import("./types.js").LogCaptureSpawn} LogCaptureSpawn
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

/** A composite action step cannot carry `timeout-minutes`, so the boot path bounds its own docker calls. */
const CONTAINER_INSPECT_TIMEOUT_MS = 10_000;
const CONTAINER_REMOVE_TIMEOUT_MS = 60_000;
const CONTAINER_LOGS_TIMEOUT_MS = 30_000;

/** anvil logs a stanza per block; read far more lines than are kept, because filtering drops those first. */
const RAW_LINES_PER_KEPT_LINE = 50;
const LOG_CAPTURE_MAX_BUFFER = 64 * 1024 * 1024;
const DIAGNOSTIC_TAIL_LINES = 200;

/**
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [options]
 * @returns {string}
 */
export function runDocker(args, options = {}) {
	try {
		return /** @type {string} */ (
			execFileSync("docker", args, {
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
				...options,
			})
		);
	} catch (error) {
		if (/** @type {{ code?: string }} */ (error)?.code === "ETIMEDOUT") {
			throw new Error(`docker ${args[0]} timed out after ${options.timeout}ms`, { cause: error });
		}
		throw error;
	}
}

/**
 * @param {string} containerName
 * @returns {ContainerState}
 */
export function inspectContainer(containerName) {
	/** @type {{ Status: string; Running: boolean; ExitCode: number; OOMKilled: boolean; Health?: { Status: string } }} */
	const state = JSON.parse(
		runDocker(["inspect", "--format", "{{json .State}}", containerName], {
			timeout: CONTAINER_INSPECT_TIMEOUT_MS,
		}),
	);
	return {
		running: state.Running,
		status: state.Status,
		exitCode: state.ExitCode,
		oomKilled: state.OOMKilled,
		health: state.Health?.Status ?? "",
	};
}

/** @param {ContainerState} state */
export function describeContainerState(state) {
	const health = state.health ? ` health=${state.health}` : "";
	return `${state.status} exit=${state.exitCode} oom=${state.oomKilled}${health}`;
}

/**
 * Docker's own error text from a failed `runDocker`. It lives on `stderr`; `message` carries it
 * only while the call pipes stderr.
 *
 * @param {unknown} error
 */
export function dockerErrorText(error) {
	return String(
		/** @type {{ stderr?: string }} */ (error)?.stderr ||
			(error instanceof Error ? error.message : error),
	);
}

/** @param {string} containerName */
export function removeContainer(containerName) {
	try {
		runDocker(["rm", "-f", containerName], { timeout: CONTAINER_REMOVE_TIMEOUT_MS });
	} catch (error) {
		// Anything but a missing container would resurface as a name conflict from the next
		// `docker run`, blaming the wrong step.
		if (!/no such (container|object)/i.test(dockerErrorText(error))) {
			throw error;
		}
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
 * Up to `tailLines` log lines without anvil's block stanzas: the last ones, or the oldest when a
 * note says the capture was truncated.
 *
 * @param {string} containerName
 * @param {number} tailLines
 * @param {LogCaptureSpawn} [spawn]
 * @returns {{ logs: string; notes: string[] }}
 */
export function readContainerLogs(
	containerName,
	tailLines,
	spawn = /** @type {LogCaptureSpawn} */ (/** @type {unknown} */ (spawnSync)),
) {
	// `docker logs` replays the container's stdout and stderr separately, and Nitro writes its
	// fatal to stderr. Merging in the child keeps one chronology (approximate across streams);
	// two parent buffers can only be concatenated, and the second then fills the whole tail.
	const result = spawn(
		"sh",
		[
			"-c",
			'exec docker logs --tail "$1" "$2" 2>&1',
			"sh",
			String(tailLines * RAW_LINES_PER_KEPT_LINE),
			containerName,
		],
		{
			encoding: "utf-8",
			maxBuffer: LOG_CAPTURE_MAX_BUFFER,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: CONTAINER_LOGS_TIMEOUT_MS,
		},
	);
	const captured = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	const truncation = captureTruncation(result, captured);
	/** @type {string[]} */
	const notes = [];
	if (truncation) {
		notes.push(
			`log capture truncated (${truncation}): showing the OLDEST ${tailLines} lines read, not the tail; the fatal error is likely not among them`,
		);
	}
	const logs = filterContainerLogs(captured, tailLines, truncation !== undefined);
	if (!logs && !truncation) {
		notes.push(
			captured.trim() === ""
				? "container produced no output on either stream"
				: "container logs were empty after filtering blank lines and block-progress spam",
		);
	}
	return { logs, notes };
}

/**
 * Throws when docker failed rather than ran out of room or time: what came back ends with
 * docker's complaint, not container output.
 *
 * @param {LogCaptureResult} result
 * @param {string} captured
 * @returns {string | undefined}
 */
function captureTruncation(result, captured) {
	if (!result.error && result.status === 0) {
		return undefined;
	}
	const { reason, truncated } = describeLogCaptureFailure(result);
	if (!truncated) {
		const lastLine = captured.trim().split("\n").at(-1);
		throw new Error(lastLine ? `${reason}: ${lastLine}` : reason);
	}
	return reason;
}

/** @param {LogCaptureResult} result */
function describeLogCaptureFailure(result) {
	const code = /** @type {{ code?: string } | undefined} */ (result.error)?.code;
	if (code === "ENOBUFS") {
		return { reason: `capture exceeded ${LOG_CAPTURE_MAX_BUFFER} bytes`, truncated: true };
	}
	if (code === "ETIMEDOUT") {
		return {
			reason: `docker logs timed out after ${CONTAINER_LOGS_TIMEOUT_MS}ms`,
			truncated: true,
		};
	}
	if (result.error) {
		return { reason: String(result.error), truncated: false };
	}
	if (result.status === null) {
		return { reason: `docker logs was killed by ${result.signal}`, truncated: true };
	}
	return { reason: `docker logs exited with code ${result.status}`, truncated: false };
}

/** Anchored to anvil's stanza shape, so a fatal that mentions a block hash survives. */
const ANVIL_BLOCK_STANZA = /^\s*Block (Number|Hash|Time):/;

/**
 * @param {string} logs
 * @param {number} tailLines
 * @param {boolean} [fromStart]
 */
export function filterContainerLogs(logs, tailLines, fromStart = false) {
	const kept = logs
		.split(/\r?\n/)
		.filter((line) => line.trim() !== "" && !ANVIL_BLOCK_STANZA.test(line));
	return (fromStart ? kept.slice(0, tailLines) : kept.slice(-tailLines)).join("\n");
}

/**
 * The container's state and, unless `skipLogs`, its log tail. Capture problems land in `errors`
 * rather than failing, since this runs while a boot failure is already being reported.
 *
 * @param {string} containerName
 * @param {{
 *   tailLines?: number;
 *   skipLogs?: boolean;
 *   inspect?: typeof inspectContainer;
 *   readLogs?: typeof readContainerLogs;
 * }} [options]
 * @returns {ContainerDiagnostics}
 */
export function collectContainerDiagnostics(containerName, options = {}) {
	const { inspect = inspectContainer, readLogs = readContainerLogs } = options;
	const diagnostics = /** @type {ContainerDiagnostics} */ ({ errors: [] });
	try {
		diagnostics.inspect = describeContainerState(inspect(containerName));
	} catch (error) {
		diagnostics.errors.push(
			`inspect failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (options.skipLogs) {
		return diagnostics;
	}
	try {
		const { logs, notes } = readLogs(containerName, options.tailLines ?? DIAGNOSTIC_TAIL_LINES);
		diagnostics.errors.push(...notes);
		if (logs) {
			diagnostics.logs = logs;
		}
	} catch (error) {
		diagnostics.errors.push(
			`log collection failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return diagnostics;
}

/**
 * Diagnostics as lines to print, in the order they must be read: caveats come before the logs
 * they qualify, or they arrive after the logs are already believed.
 *
 * @param {ContainerDiagnostics} diagnostics
 * @returns {string[]}
 */
export function diagnosticLines(diagnostics) {
	return [
		...(diagnostics.inspect ? [`container state: ${diagnostics.inspect}`] : []),
		...diagnostics.errors,
		...(diagnostics.logs ? [`container logs:\n${diagnostics.logs}`] : []),
	];
}
