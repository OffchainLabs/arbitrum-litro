// @ts-check

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * @typedef {import("./types.js").ActionStateOptions} ActionStateOptions
 * @typedef {import("./types.js").BaseStateOptions} BaseStateOptions
 * @typedef {import("./types.js").ContainerDiagnostics} ContainerDiagnostics
 * @typedef {import("./types.js").ImageRefOptions} ImageRefOptions
 * @typedef {import("./types.js").ScalarInput} ScalarInput
 * @typedef {import("./types.js").StartStateOptions} StartStateOptions
 * @typedef {import("./types.js").TestnodeState} TestnodeState
 * @typedef {import("./types.js").VariantDefinition} VariantDefinition
 */

export const DEFAULT_TESTNODE_IMAGE_REPOSITORY = "ghcr.io/offchainlabs/arbitrum-testnode-ci";

export const NITRO_CONTRACTS_VERSIONS = {
	"v2.1": { tagComponent: "nc2.1" },
	"v3.2": { tagComponent: "nc3.2" },
};

export const DEFAULT_NITRO_CONTRACTS_VERSION = "v3.2";

/** @type {Record<string, VariantDefinition>} */
export const VARIANTS = {
	l2: {
		name: "l2",
		description: "L1 + L2 testnode",
		snapshotId: "l2",
		snapshotReleaseTag: "v0.1.6",
		l3Enabled: false,
		supportedContractsVersions: ["v3.2"],
		hostPorts: {
			l1: 8545,
			l2: 8547,
			l2Ws: 8548,
		},
	},
	"l2-timeboost": {
		name: "l2-timeboost",
		description: "L1 + L2 testnode with Timeboost enabled on L2",
		snapshotId: "l2-timeboost",
		snapshotReleaseTag: "timeboost-0.1.8",
		l3Enabled: false,
		timeboostEnabled: true,
		supportedContractsVersions: ["v3.2"],
		hostPorts: {
			l1: 8545,
			l2: 8547,
			l2Ws: 8548,
		},
	},
	"l3-eth": {
		name: "l3-eth",
		description: "L1 + L2 + L3 testnode with ETH gas on L3",
		snapshotId: "default",
		snapshotReleaseTag: "v0.1.6",
		l3Enabled: true,
		supportedContractsVersions: ["v3.2"],
		hostPorts: {
			l1: 8545,
			l2: 8547,
			l2Ws: 8548,
			l3: 3347,
			l3Ws: 3348,
		},
	},
	"l3-custom-6": {
		name: "l3-custom-6",
		description: "L1 + L2 + L3 testnode with 6-decimal custom gas token on L3",
		snapshotId: "l3-custom-6",
		snapshotReleaseTag: "l3-custom-6",
		snapshotsByContractsVersion: {
			"v2.1": { snapshotId: "l3-custom-6-v2.1", snapshotReleaseTag: "l3-custom-6-v2.1" },
		},
		l3Enabled: true,
		feeTokenDecimals: 6,
		supportedContractsVersions: ["v2.1", "v3.2"],
		hostPorts: {
			l1: 8545,
			l2: 8547,
			l2Ws: 8548,
			l3: 3347,
			l3Ws: 3348,
		},
	},
	"l3-custom-16": {
		name: "l3-custom-16",
		description: "L1 + L2 + L3 testnode with 16-decimal custom gas token on L3",
		snapshotId: "l3-custom-16",
		snapshotReleaseTag: "l3-custom-16",
		l3Enabled: true,
		feeTokenDecimals: 16,
		supportedContractsVersions: ["v2.1", "v3.2"],
		hostPorts: {
			l1: 8545,
			l2: 8547,
			l2Ws: 8548,
			l3: 3347,
			l3Ws: 3348,
		},
	},
	"l3-custom-18": {
		name: "l3-custom-18",
		description: "L1 + L2 + L3 testnode with 18-decimal custom gas token on L3",
		snapshotId: "l3-custom-18",
		snapshotReleaseTag: "l3-custom-18",
		snapshotsByContractsVersion: {
			"v2.1": { snapshotId: "l3-custom-18-v2.1", snapshotReleaseTag: "l3-custom-18-v2.1" },
		},
		l3Enabled: true,
		feeTokenDecimals: 18,
		supportedContractsVersions: ["v2.1", "v3.2"],
		hostPorts: {
			l1: 8545,
			l2: 8547,
			l2Ws: 8548,
			l3: 3347,
			l3Ws: 3348,
		},
	},
	"l3-custom-20": {
		name: "l3-custom-20",
		description: "L1 + L2 + L3 testnode with 20-decimal custom gas token on L3",
		snapshotId: "l3-custom-20",
		snapshotReleaseTag: "l3-custom-20",
		l3Enabled: true,
		feeTokenDecimals: 20,
		supportedContractsVersions: ["v2.1", "v3.2"],
		hostPorts: {
			l1: 8545,
			l2: 8547,
			l2Ws: 8548,
			l3: 3347,
			l3Ws: 3348,
		},
	},
};

/**
 * @param {ScalarInput} value
 * @param {boolean} [defaultValue]
 */
function toBoolean(value, defaultValue = false) {
	if (value === undefined || value === "") {
		return defaultValue;
	}
	return value === true || value === "true";
}

/** @param {number | string | undefined} value */
function normalizeFeeTokenDecimals(value) {
	if (value === undefined || value === "") {
		return "";
	}
	const normalized = String(value);
	if (!["6", "16", "18", "20"].includes(normalized)) {
		throw new Error("fee-token-decimals must be one of 6, 16, 18, or 20");
	}
	return normalized;
}

/** @param {string | undefined} value */
export function normalizeNitroContractsVersion(value) {
	const v = value || DEFAULT_NITRO_CONTRACTS_VERSION;
	if (!(v in NITRO_CONTRACTS_VERSIONS)) {
		throw new Error(
			`nitro-contracts-version must be one of: ${Object.keys(NITRO_CONTRACTS_VERSIONS).join(", ")}`,
		);
	}
	return v;
}

/**
 * @param {{
 *   feeTokenDecimals?: number | string | undefined;
 *   l3Enabled?: boolean | string | undefined;
 *   timeboostEnabled?: boolean | string | undefined;
 * }} options
 */
export function resolveVariant({ feeTokenDecimals, l3Enabled, timeboostEnabled }) {
	const enableL3 = toBoolean(l3Enabled);
	const decimals = normalizeFeeTokenDecimals(feeTokenDecimals);
	if (toBoolean(timeboostEnabled)) {
		if (decimals) {
			throw new Error("fee-token-decimals is not supported with timeboost-enabled");
		}
		return "l2-timeboost";
	}
	if (!enableL3 && decimals) {
		throw new Error("fee-token-decimals requires L3 to be enabled");
	}
	if (!enableL3) {
		return "l2";
	}
	if (!decimals) {
		return "l3-eth";
	}
	return `l3-custom-${decimals}`;
}

/** @param {ImageRefOptions} options */
export function buildTestnodeImageRef({ contractsVersion, imageRepository, variant, version }) {
	if (!version) {
		throw new Error("version is required");
	}
	const repository = imageRepository || DEFAULT_TESTNODE_IMAGE_REPOSITORY;
	const definition = VARIANTS[variant];
	if (!definition) {
		throw new Error(`Unknown variant ${variant}`);
	}
	const cv = normalizeNitroContractsVersion(contractsVersion);
	const contractsDefinition =
		NITRO_CONTRACTS_VERSIONS[/** @type {keyof typeof NITRO_CONTRACTS_VERSIONS} */ (cv)];
	return `${repository}:${version}-${contractsDefinition.tagComponent}-${definition.name}`;
}

/**
 * Whether a variant ships a snapshot bundle for the given contracts version.
 * The default contracts version always has a bundle (the existing per-variant
 * snapshots are v3.2); non-default versions only when an explicit
 * `snapshotsByContractsVersion` override is declared. Callers use this to skip
 * (variant × version) combinations that have no bundle.
 *
 * @param {string} variant
 * @param {string} contractsVersion
 * @returns {boolean}
 */
export function hasVariantSnapshot(variant, contractsVersion) {
	const def = VARIANTS[variant];
	if (!def) {
		return false;
	}
	if (contractsVersion === DEFAULT_NITRO_CONTRACTS_VERSION) {
		return true;
	}
	return Boolean(def.snapshotsByContractsVersion?.[contractsVersion]);
}

/**
 * Resolve the snapshot bundle (id + release tag) for a (variant, contracts
 * version) pair. A non-default version with a `snapshotsByContractsVersion`
 * override uses that bundle; otherwise the variant's base
 * `snapshotId`/`snapshotReleaseTag` is returned. Pair with
 * {@link hasVariantSnapshot} to decide whether the combination is publishable.
 *
 * @param {string} variant
 * @param {string} contractsVersion
 * @returns {{ snapshotId: string; snapshotReleaseTag: string }}
 */
export function resolveVariantSnapshot(variant, contractsVersion) {
	const def = VARIANTS[variant];
	if (!def) {
		throw new Error(`Unknown variant ${variant}`);
	}
	const override = def.snapshotsByContractsVersion?.[contractsVersion];
	if (override) {
		return override;
	}
	return { snapshotId: def.snapshotId, snapshotReleaseTag: def.snapshotReleaseTag };
}

/**
 * The snapshot id to capture/use for a (variant, contracts version) pair. The
 * default contracts version uses the variant's base `snapshotId`; any other
 * version is suffixed (e.g. `l3-custom-16` + `v2.1` → `l3-custom-16-v2.1`),
 * matching the keys declared in `snapshotsByContractsVersion`.
 *
 * @param {string} variant
 * @param {string} contractsVersion
 * @returns {string}
 */
export function snapshotIdForContractsVersion(variant, contractsVersion) {
	const def = VARIANTS[variant];
	if (!def) {
		throw new Error(`Unknown variant ${variant}`);
	}
	if (contractsVersion === DEFAULT_NITRO_CONTRACTS_VERSION) {
		return def.snapshotId;
	}
	return `${def.snapshotId}-${contractsVersion}`;
}

/**
 * Build one publish-matrix row for a (variant, contracts version) pair.
 *
 * @param {VariantDefinition} def
 * @param {string} contractsVersion
 */
function buildPublishRow(def, contractsVersion) {
	return {
		variant: def.name,
		contractsVersion,
		snapshotId: snapshotIdForContractsVersion(def.name, contractsVersion),
		feeTokenDecimals: def.feeTokenDecimals ?? null,
		timeboostEnabled: def.timeboostEnabled ?? false,
	};
}

/**
 * The publish-matrix rows a single variant contributes, filtered by version.
 *
 * @param {VariantDefinition} def
 * @param {string} versionFilter
 */
function publishRowsForVariant(def, versionFilter) {
	const versions = (def.supportedContractsVersions ?? []).filter(
		(version) => versionFilter === "all" || version === versionFilter,
	);
	return versions.map((version) => buildPublishRow(def, version));
}

/**
 * The set of (variant × nitro-contracts-version) snapshots to publish. Each
 * variant contributes a row per version in its `supportedContractsVersions`
 * that also matches `versionFilter`.
 *
 * @param {string} variantFilter a variant name or "all"
 * @param {string} versionFilter a contracts version or "all"
 * @returns {Array<{ variant: string; contractsVersion: string; snapshotId: string; feeTokenDecimals: number | null; timeboostEnabled: boolean }>}
 */
export function resolvePublishMatrix(variantFilter, versionFilter) {
	const names = variantFilter === "all" ? Object.keys(VARIANTS) : [variantFilter];
	const rows = [];
	for (const name of names) {
		const def = VARIANTS[name];
		if (!def) {
			throw new Error(`Unknown variant ${name}`);
		}
		rows.push(...publishRowsForVariant(def, versionFilter));
	}
	return rows;
}

/** @param {{ runnerTemp?: string | undefined; variant: string; version: string }} options */
export function defaultActionOutputDir({ runnerTemp, variant, version }) {
	if (!runnerTemp) {
		throw new Error("RUNNER_TEMP is required when output-dir is not provided");
	}
	return join(runnerTemp, "arbitrum-testnode", version, variant);
}

/** @param {{ cwd: string; variant: string; version: string }} options */
export function defaultStartOutputDir({ cwd, variant, version }) {
	return join(cwd, ".arbitrum-testnode", version, variant);
}

/** @param {string} value */
function sanitizeContainerName(value) {
	return value.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

/**
 * @param {BaseStateOptions & { defaultOutputDir: (options: { variant: string; version: string }) => string }} options
 * @returns {TestnodeState}
 */
function buildTestnodeState({
	containerName,
	contractsVersion,
	feeTokenDecimals,
	imageRef,
	imageRepository,
	l3Enabled,
	outputDir,
	timeboostEnabled,
	variant: variantOverride,
	version,
	defaultOutputDir,
}) {
	// A full image ref bypasses variant/version image resolution; the variant then
	// only governs host ports and the TESTNODE_VARIANT env, defaulting to l2.
	const useImageRef = Boolean(imageRef);
	const variant = useImageRef
		? variantOverride || "l2"
		: resolveVariant({ feeTokenDecimals, l3Enabled, timeboostEnabled });
	const definition = VARIANTS[variant];
	if (!definition) {
		throw new Error(`Unknown variant ${variant}`);
	}
	const resolvedTimeboostEnabled =
		toBoolean(timeboostEnabled) || definition.timeboostEnabled === true;
	const resolvedContractsVersion = normalizeNitroContractsVersion(contractsVersion);
	const resolvedVersion = version;
	const resolvedOutputDir = outputDir ?? defaultOutputDir({ variant, version });
	const resolvedContainerName = sanitizeContainerName(
		containerName || `arbitrum-testnode-${variant}`,
	);
	const configDir = join(resolvedOutputDir, "config");
	const rpcUrls = {
		l1: `http://127.0.0.1:${definition.hostPorts.l1}`,
		l2: `http://127.0.0.1:${definition.hostPorts.l2}`,
		l3: definition.l3Enabled ? `http://127.0.0.1:${definition.hostPorts.l3}` : "",
	};
	return {
		configDir,
		containerName: resolvedContainerName,
		contractsVersion: resolvedContractsVersion,
		imageRef: imageRef
			? imageRef
			: buildTestnodeImageRef({
					contractsVersion: resolvedContractsVersion,
					imageRepository,
					variant,
					version: resolvedVersion,
				}),
		outputDir: resolvedOutputDir,
		paths: {
			l1BridgeUiConfig: join(configDir, "l1-l2-admin", "bridgeUiConfig.json"),
			l1l2Network: join(configDir, "l1l2_network.json"),
			l2BridgeUiConfig: definition.l3Enabled
				? join(configDir, "l2-l3-admin", "bridgeUiConfig.json")
				: "",
			l2l3Network: definition.l3Enabled ? join(configDir, "l2l3_network.json") : "",
			localNetwork: join(configDir, "localNetwork.json"),
		},
		rpcUrls,
		snapshotId: definition.snapshotId,
		timeboostEnabled: resolvedTimeboostEnabled,
		variant,
		variantDefinition: definition,
	};
}

/** @param {ActionStateOptions} options */
export function buildActionTestnodeState({
	containerName,
	contractsVersion,
	feeTokenDecimals,
	imageRef,
	imageRepository,
	l3Enabled,
	outputDir,
	runnerTemp,
	timeboostEnabled,
	variant,
	version,
	workspace,
}) {
	return buildTestnodeState({
		containerName,
		contractsVersion,
		feeTokenDecimals,
		imageRef,
		imageRepository,
		l3Enabled,
		outputDir: outputDir
			? isAbsolute(outputDir)
				? outputDir
				: resolve(workspace || process.cwd(), outputDir)
			: undefined,
		timeboostEnabled,
		variant,
		version,
		defaultOutputDir: ({ variant, version: nextVersion }) =>
			defaultActionOutputDir({ runnerTemp, variant, version: nextVersion }),
	});
}

/** @param {StartStateOptions} options */
export function buildStartTestnodeState({
	containerName,
	contractsVersion,
	cwd,
	feeTokenDecimals,
	imageRef,
	imageRepository,
	l3Enabled,
	outputDir,
	timeboostEnabled,
	variant,
	version,
}) {
	return buildTestnodeState({
		containerName,
		contractsVersion,
		feeTokenDecimals,
		imageRef,
		imageRepository,
		l3Enabled,
		outputDir: outputDir
			? isAbsolute(outputDir)
				? outputDir
				: resolve(cwd, outputDir)
			: undefined,
		timeboostEnabled,
		variant,
		version,
		defaultOutputDir: ({ variant, version: nextVersion }) =>
			defaultStartOutputDir({ cwd, variant, version: nextVersion }),
	});
}

/** @param {TestnodeState} state */
export function testnodeDockerRunArgs(state) {
	const { hostPorts } = state.variantDefinition;
	const args = [
		"run",
		"-d",
		"--name",
		state.containerName,
		"-e",
		`TESTNODE_VARIANT=${state.variant}`,
		"-p",
		`127.0.0.1:${hostPorts.l1}:8545`,
		"-p",
		`127.0.0.1:${hostPorts.l2}:8547`,
		"-p",
		`127.0.0.1:${hostPorts.l2Ws}:8548`,
		"-p",
		"127.0.0.1:8080:8080",
	];
	if (state.variantDefinition.l3Enabled) {
		if (hostPorts.l3 === undefined || hostPorts.l3Ws === undefined) {
			throw new Error(`Variant ${state.variant} is missing L3 host ports`);
		}
		args.push("-p", `127.0.0.1:${hostPorts.l3}:8549`);
		args.push("-p", `127.0.0.1:${hostPorts.l3Ws}:8550`);
	}
	if (state.timeboostEnabled) {
		args.push("-e", "TESTNODE_TIMEBOOST=true");
		args.push("-e", "TESTNODE_TIMEBOOST_REDIS_URL");
		args.push("-e", "TESTNODE_TIMEBOOST_AUCTION_CONTRACT_ADDRESS");
	}
	args.push(state.imageRef);
	return args;
}

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

/**
 * @param {string} url
 * @param {number} timeoutMs
 */
export function waitForRpc(url, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	const body = JSON.stringify({ id: 1, jsonrpc: "2.0", method: "eth_chainId", params: [] });
	while (Date.now() < deadline) {
		try {
			execFileSync(
				"curl",
				["-sf", "-X", "POST", "-H", "Content-Type: application/json", "-d", body, url],
				{ stdio: ["ignore", "pipe", "pipe"], timeout: 5000 },
			);
			return;
		} catch {
			// retry until deadline
		}
		execFileSync("sleep", ["1"], { stdio: "ignore" });
	}
	throw new Error(`RPC at ${url} not ready after ${timeoutMs}ms`);
}

/** @param {string} containerName */
export function removeContainer(containerName) {
	try {
		runDocker(["rm", "-f", containerName]);
	} catch {
		// ignore missing container
	}
}

/** @param {TestnodeState} state */
export function exportTestnodeConfig(state) {
	mkdirSync(state.configDir, { recursive: true });
	runDocker([
		"cp",
		`${state.containerName}:/opt/arbitrum-testnode/export-config/.`,
		state.configDir,
	]);
	const exported = readdirSync(state.configDir);
	if (exported.length === 0) {
		throw new Error(`No config files exported to ${state.configDir}`);
	}
	return exported;
}

/**
 * @param {TestnodeState} state
 * @param {number} timeoutMs
 */
export function bootTestnode(state, timeoutMs) {
	removeContainer(state.containerName);
	rmSync(state.outputDir, { force: true, recursive: true });
	mkdirSync(state.outputDir, { recursive: true });
	runDocker(testnodeDockerRunArgs(state));
	waitForRpc(state.rpcUrls.l1, timeoutMs);
	waitForRpc(state.rpcUrls.l2, timeoutMs);
	if (state.variantDefinition.l3Enabled) {
		waitForRpc(state.rpcUrls.l3, timeoutMs);
	}
	return exportTestnodeConfig(state);
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
		const logs = runDocker(["logs", containerName]);
		diagnostics.logs = filterContainerLogs(logs, options.tailLines ?? 100);
	} catch (error) {
		diagnostics.errors.push(
			`log collection failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return diagnostics;
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
 * @param {string} sourcePath
 * @param {string[]} destinations
 */
export function copyNetworkConfigPaths(sourcePath, destinations) {
	for (const dest of destinations) {
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(sourcePath, dest);
	}
}
