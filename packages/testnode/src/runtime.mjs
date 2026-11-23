// @ts-check

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	START_CONTAINER_LABEL,
	describeContainerState,
	dockerErrorText,
	inspectContainer,
	removeContainer,
	runDocker,
} from "./containers.mjs";
import { endpointUrl } from "./endpoints.mjs";
import { toBoolean, toNumber } from "./inputs.mjs";
import { observabilityDockerArgs, resolveObservabilityOptions } from "./observability.mjs";
import {
	needsHealthyContainer,
	resolveSequencerOptions,
	sequencerDockerArgs,
} from "./sequencer.mjs";

export {
	DEFAULT_FAST_FEED_API_KEY,
	FAST_FEED_HOST_PORT,
	SEQUENCER_FEED_HOST_PORT,
} from "./sequencer.mjs";

/**
 * @typedef {import("./types.js").ActionStateOptions} ActionStateOptions
 * @typedef {import("./types.js").BaseStateOptions} BaseStateOptions
 * @typedef {import("./types.js").ImageRefOptions} ImageRefOptions
 * @typedef {import("./types.js").ScalarInput} ScalarInput
 * @typedef {import("./types.js").StartStateOptions} StartStateOptions
 * @typedef {import("./types.js").TestnodeState} TestnodeState
 * @typedef {import("./types.js").VariantDefinition} VariantDefinition
 */

/** Public, so resolving an image needs no registry credentials. */
export const DEFAULT_TESTNODE_IMAGE_REPOSITORY = "ghcr.io/offchainlabs/arbitrum-litro";

export const NITRO_CONTRACTS_VERSIONS = {
	"v2.1": { tagComponent: "nc2.1" },
	"v3.2": { tagComponent: "nc3.2" },
};

export const DEFAULT_NITRO_CONTRACTS_VERSION = "v3.2";

export const DEFAULT_STARTUP_TIMEOUT_SECONDS = 360;

export const DEFAULT_CONFIG_SERVER_PORT = 8080;

const CONTAINER_RUN_TIMEOUT_MS = 120_000;
const CONFIG_EXPORT_TIMEOUT_MS = 120_000;
const DOCKER_QUERY_TIMEOUT_MS = 10_000;
export const IMAGE_PULL_TIMEOUT_MS = 900_000;

const MAX_CONSECUTIVE_INSPECT_FAILURES = 3;
const RPC_PROBE_TIMEOUT_MS = 5000;

const CONFIG_EXPORT_FAILED = "CONFIG_EXPORT_FAILED";

/** Child progress on fd 2: stdout carries the CLI's result, and in `--mcp` its JSON-RPC stream. */
const PROGRESS_TO_STDERR = 2;

/** How `docker cp` (and podman) report a path the container never created. */
const MISSING_IN_CONTAINER = /could not find the file|no such file or directory/i;

/** Relative path, from the project root, of the rebase Dockerfile. */
const REBASE_DOCKERFILE = join("docker", "testnode-rebase.Dockerfile");

/** Repository every rebased image is tagged under. */
const REBASED_IMAGE_REPOSITORY = "local/arbitrum-testnode-rebase";

/** Declared in docker/testnode-rebase.Dockerfile; GC filters on it. */
const REBASED_IMAGE_GC_LABEL = "org.offchainlabs.testnode-rebase=true";

/** How old an unused rebased image must be before GC removes it. */
const REBASED_IMAGE_GC_MAX_AGE = "168h";

/** Bounds on the two docker calls a rebase makes, so a wedged daemon cannot hang CI. */
const REBASE_BUILD_TIMEOUT_MS = 900_000;
const REBASED_IMAGE_GC_TIMEOUT_MS = 120_000;

/** Paths that together identify the repo root. Both are committed. */
const REPO_ROOT_MARKERS = [join("docker", "docker-compose.yaml"), "config"];

/**
 * Walk up from `startDir` to the repo root. Discovered rather than hard-coded
 * because callers load from source (the composite action) and from `dist`.
 *
 * @param {string} [startDir]
 * @returns {string}
 */
export function findRepoRoot(startDir = import.meta.dirname) {
	let current = resolve(startDir);
	for (;;) {
		if (REPO_ROOT_MARKERS.every((marker) => existsSync(resolve(current, marker)))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			throw new Error(`Unable to locate arbitrum-testnode project root from ${startDir}`);
		}
		current = parent;
	}
}

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
	if (version === "latest") {
		return `${repository}:latest-${definition.name}`;
	}
	const cv = normalizeNitroContractsVersion(contractsVersion);
	const contractsDefinition =
		NITRO_CONTRACTS_VERSIONS[/** @type {keyof typeof NITRO_CONTRACTS_VERSIONS} */ (cv)];
	return `${repository}:${version}-${contractsDefinition.tagComponent}-${definition.name}`;
}

/**
 * The local tag a rebased image is built as. The digest of the (base, nitro)
 * pair keeps rebases with different inputs from reusing each other's tag.
 *
 * @param {string} variant
 * @param {string} baseImageRef
 * @param {string} nitroImage
 */
export function rebasedTestnodeImageRef(variant, baseImageRef, nitroImage) {
	const digest = createHash("sha256")
		.update(`${baseImageRef}\n${nitroImage}`)
		.digest("hex")
		.slice(0, 12);
	return `${REBASED_IMAGE_REPOSITORY}:${variant}-${digest}`;
}

/**
 * A file the CLI ships, by its path in the repo. The CLI bundle carries its assets under the same
 * paths beside itself; a checkout has them under the repo root.
 *
 * @param {string} repoPath
 * @param {string} [startDir]
 * @returns {string}
 */
export function findAsset(repoPath, startDir = import.meta.dirname) {
	const bundled = join(startDir, repoPath);
	if (existsSync(bundled)) {
		return bundled;
	}
	const candidate = join(findRepoRoot(startDir), repoPath);
	if (!existsSync(candidate)) {
		throw new Error(`Unable to locate ${repoPath} beside the CLI or in the repo`);
	}
	return candidate;
}

/**
 * @param {string} [startDir]
 * @returns {string}
 */
export function findRebaseDockerfile(startDir = import.meta.dirname) {
	return findAsset(REBASE_DOCKERFILE, startDir);
}

/**
 * The `docker build` argv grafting a testnode image's artifacts onto another
 * Nitro image. Every COPY reads from `TESTNODE_IMAGE`, so the context is unused.
 *
 * @param {{ baseImageRef: string; contextDir: string; dockerfile: string; imageRef: string; nitroImage: string }} options
 * @returns {string[]}
 */
export function testnodeRebaseBuildArgs({
	baseImageRef,
	contextDir,
	dockerfile,
	imageRef,
	nitroImage,
}) {
	return [
		"build",
		"-f",
		dockerfile,
		"--build-arg",
		`TESTNODE_IMAGE=${baseImageRef}`,
		"--build-arg",
		`NITRO_IMAGE=${nitroImage}`,
		"-t",
		imageRef,
		contextDir,
	];
}

/**
 * Best-effort GC of stale rebased images. Docker prunes only unused images past
 * the age window, so a concurrent run's fresh build is never touched.
 *
 * Call this *before* a rebase build, not after: a cache-hit rebuild can resurrect
 * an image already older than the window, which a post-build prune would collect
 * moments after tagging it. Failures are swallowed — GC never fails a rebase.
 *
 * @param {(args: string[]) => string} [runner]
 */
export function pruneStaleRebasedImages(
	runner = (/** @type {string[]} */ args) =>
		runDocker(args, { timeout: REBASED_IMAGE_GC_TIMEOUT_MS }),
) {
	try {
		runner([
			"image",
			"prune",
			"--all",
			"--force",
			"--filter",
			`label=${REBASED_IMAGE_GC_LABEL}`,
			"--filter",
			`until=${REBASED_IMAGE_GC_MAX_AGE}`,
		]);
	} catch {
		// Unreachable daemon or unsupported filter — the rebase must proceed.
	}
}

/**
 * Build `imageRef` by rebasing `baseImageRef` onto `nitroImage`. Both images must
 * already be local or pullable by the daemon.
 *
 * @param {{ baseImageRef: string; imageRef: string; nitroImage: string }} state
 * @param {{ contextDir?: string; dockerfile?: string; runner?: (args: string[]) => void }} [options]
 * @returns {string} the rebased image ref that was built
 */
export function rebaseTestnodeImage(state, options = {}) {
	if (!state.nitroImage) {
		throw new Error("nitroImage is required to rebase a testnode image");
	}
	const dockerfile = options.dockerfile || findRebaseDockerfile();
	const ownsContextDir = !options.contextDir;
	const contextDir = options.contextDir || mkdtempSync(join(tmpdir(), "arbitrum-testnode-rebase-"));
	const runner =
		options.runner ||
		((args) => {
			runDocker(args, {
				env: daemonBuilderEnv(),
				stdio: ["ignore", PROGRESS_TO_STDERR, "inherit"],
				timeout: REBASE_BUILD_TIMEOUT_MS,
			});
		});
	try {
		runner(
			testnodeRebaseBuildArgs({
				baseImageRef: state.baseImageRef,
				contextDir,
				dockerfile,
				imageRef: state.imageRef,
				nitroImage: state.nitroImage,
			}),
		);
	} finally {
		if (ownsContextDir) {
			rmSync(contextDir, { force: true, recursive: true });
		}
	}
	return state.imageRef;
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
 * @param {string | undefined} version
 * @param {string | undefined} imageRef
 */
function resolveRuntimeVersion(version, imageRef) {
	return version || (imageRef ? "custom" : "latest");
}

/**
 * The exported-config paths for a variant. L3-only entries are empty strings on
 * L2-only variants, since those files are never exported.
 *
 * @param {string} configDir
 * @param {boolean} l3Enabled
 * @returns {TestnodeState["paths"]}
 */
function buildStatePaths(configDir, l3Enabled) {
	return {
		l1BridgeUiConfig: join(configDir, "l1-l2-admin", "bridgeUiConfig.json"),
		l1l2Network: join(configDir, "l1l2_network.json"),
		l2BridgeUiConfig: l3Enabled ? join(configDir, "l2-l3-admin", "bridgeUiConfig.json") : "",
		l2l3Network: l3Enabled ? join(configDir, "l2l3_network.json") : "",
		localNetwork: join(configDir, "localNetwork.json"),
	};
}

/**
 * @param {BaseStateOptions & { defaultOutputDir: (options: { variant: string; version: string }) => string }} options
 * @returns {TestnodeState}
 */
function buildTestnodeState({
	configServerPort,
	containerName,
	contractsVersion,
	feeTokenDecimals,
	imageRef,
	imageRepository,
	l3Enabled,
	nitroImage,
	observability,
	outputDir,
	sequencer,
	timeboostEnabled,
	version,
	defaultOutputDir,
}) {
	const resolvedImageRef = imageRef?.trim() || undefined;
	const resolvedNitroImage = nitroImage?.trim() || "";
	const variant = resolveVariant({ feeTokenDecimals, l3Enabled, timeboostEnabled });
	const definition = VARIANTS[variant];
	if (!definition) {
		throw new Error(`Unknown variant ${variant}`);
	}
	const resolvedTimeboostEnabled =
		toBoolean(timeboostEnabled) || definition.timeboostEnabled === true;
	const resolvedContractsVersion = normalizeNitroContractsVersion(contractsVersion);
	const resolvedVersion = resolveRuntimeVersion(version, resolvedImageRef);
	const resolvedOutputDir = outputDir ?? defaultOutputDir({ variant, version: resolvedVersion });
	const resolvedContainerName = sanitizeContainerName(
		containerName || `arbitrum-testnode-${variant}`,
	);
	const configDir = join(resolvedOutputDir, "config");
	const rpcUrls = {
		l1: endpointUrl(8545, definition.hostPorts.l1),
		l2: endpointUrl(8547, definition.hostPorts.l2),
		l3: definition.l3Enabled ? endpointUrl(8549, definition.hostPorts.l3 ?? "") : "",
	};
	const baseImageRef = resolvedImageRef
		? resolvedImageRef
		: buildTestnodeImageRef({
				contractsVersion: resolvedContractsVersion,
				imageRepository,
				variant,
				version: resolvedVersion,
			});
	return {
		baseImageRef,
		configDir,
		configServerPort: resolveConfigServerPort(configServerPort),
		containerName: resolvedContainerName,
		contractsVersion: resolvedContractsVersion,
		imageRef: resolvedNitroImage
			? rebasedTestnodeImageRef(variant, baseImageRef, resolvedNitroImage)
			: baseImageRef,
		nitroImage: resolvedNitroImage,
		observability: resolveObservabilityOptions(observability),
		outputDir: resolvedOutputDir,
		paths: buildStatePaths(configDir, definition.l3Enabled),
		rpcUrls,
		sequencer: resolveSequencerOptions(sequencer),
		snapshotId: definition.snapshotId,
		timeboostEnabled: resolvedTimeboostEnabled,
		variant,
		variantDefinition: definition,
	};
}

/** @param {number | string | undefined} port */
function resolveConfigServerPort(port) {
	return (
		toNumber(port, "config-server-port", { integer: true, min: 1, max: 65535 }) ??
		DEFAULT_CONFIG_SERVER_PORT
	);
}

/** @param {ActionStateOptions} options */
export function buildActionTestnodeState({ outputDir, runnerTemp, workspace, ...options }) {
	return {
		...buildTestnodeState({
			...options,
			outputDir: outputDir ? resolve(workspace || process.cwd(), outputDir) : undefined,
			defaultOutputDir: ({ variant, version }) =>
				defaultActionOutputDir({ runnerTemp, variant, version }),
		}),
		// CI only: 250ms L1 blocks confirm an L2 transaction in ~3s instead of ~9s. anvil's memory
		// grows ~4x faster with them, so `start` keeps the image's 1s for long-running chains.
		l1BlockTime: "0.25",
	};
}

/** @param {StartStateOptions} options */
export function buildStartTestnodeState({ cwd, outputDir, ...options }) {
	return buildTestnodeState({
		...options,
		outputDir: outputDir ? resolve(cwd, outputDir) : undefined,
		defaultOutputDir: ({ variant, version }) => defaultStartOutputDir({ cwd, variant, version }),
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
		"--label",
		`${START_CONTAINER_LABEL}=${state.variant}`,
		"-e",
		`TESTNODE_VARIANT=${state.variant}`,
		"-p",
		`127.0.0.1:${hostPorts.l1}:8545`,
		"-p",
		`127.0.0.1:${hostPorts.l2}:8547`,
		"-p",
		`127.0.0.1:${hostPorts.l2Ws}:8548`,
		"-p",
		`127.0.0.1:${state.configServerPort}:8080`,
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
	if (state.l1BlockTime) {
		args.push("-e", `TESTNODE_L1_BLOCK_TIME=${state.l1BlockTime}`);
	}
	args.push(...sequencerDockerArgs(state.sequencer));
	args.push(...observabilityDockerArgs(state.observability, state.variantDefinition.l3Enabled));
	args.push(state.imageRef);
	return args;
}

/**
 * The environment for a build that must run on the current docker context's own builder: a
 * docker-container buildx driver (setup-buildx-action selects one) cannot see daemon-local images
 * for FROM, nor load its result into the daemon. Buildx names each context's builder after the
 * context, and only that builder reaches the daemon `docker run` uses.
 */
function daemonBuilderEnv() {
	if (process.env["BUILDX_BUILDER"]) {
		return process.env;
	}
	try {
		const context = runDocker(["context", "show"], { timeout: DOCKER_QUERY_TIMEOUT_MS }).trim();
		return { ...process.env, BUILDX_BUILDER: context };
	} catch {
		return process.env;
	}
}

/**
 * Why one probe got no answer, from the error `execFileSync("curl", …)` threw for it.
 *
 * @param {unknown} error
 */
export function describeRpcFailure(error) {
	const { code, status, stderr } =
		/** @type {{ code?: string; status?: number | null; stderr?: string }} */ (error ?? {});
	if (code === "ETIMEDOUT") {
		return `no answer within ${RPC_PROBE_TIMEOUT_MS / 1000}s`;
	}
	return (typeof stderr === "string" && stderr.trim()) || `curl exited with code ${status}`;
}

/**
 * @param {string} url
 * @returns {string | undefined} why the RPC did not answer, or undefined when it did
 */
function rpcFailure(url) {
	const body = JSON.stringify({ id: 1, jsonrpc: "2.0", method: "eth_chainId", params: [] });
	try {
		execFileSync(
			"curl",
			["-sSf", "-X", "POST", "-H", "Content-Type: application/json", "-d", body, url],
			{ encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: RPC_PROBE_TIMEOUT_MS },
		);
		return undefined;
	} catch (error) {
		// curl's own verdict leaves `code` unset. Any other spawn error but ETIMEDOUT means
		// probing itself is broken, which no amount of waiting fixes.
		const code = /** @type {{ code?: string }} */ (error)?.code;
		if (typeof code === "string" && code !== "ETIMEDOUT") {
			throw new Error(`cannot probe ${url}: curl failed to run (${code})`);
		}
		return describeRpcFailure(error);
	}
}

/**
 * @param {string} containerName
 * @param {typeof inspectContainer} inspect
 */
function healthFailure(containerName, inspect) {
	let health;
	try {
		health = inspect(containerName).health;
	} catch (error) {
		return `inspect failed: ${error instanceof Error ? error.message : String(error)}`;
	}
	if (health === "healthy") {
		return undefined;
	}
	return health ? `health is ${health}` : "no health status yet";
}

function sleepBriefly() {
	execFileSync("sleep", ["0.25"], { stdio: "ignore" });
}

/**
 * @typedef {{
 *   inspect?: typeof inspectContainer;
 *   probe?: (url: string) => string | undefined;
 *   sleep?: () => void;
 * }} ReadinessHooks
 */

/**
 * In the order the testnode comes up, so each is waited on only once the previous one answers.
 *
 * @param {TestnodeState} state
 * @param {Required<ReadinessHooks>} hooks
 * @returns {Array<{ what: string; failure: () => string | undefined }>}
 */
function readinessChecks(state, { inspect, probe }) {
	const rpcs = [state.rpcUrls.l1, state.rpcUrls.l2];
	if (state.variantDefinition.l3Enabled) {
		rpcs.push(state.rpcUrls.l3);
	}
	const checks = rpcs.map((url) => ({ what: `RPC at ${url}`, failure: () => probe(url) }));
	if (needsHealthyContainer(state.sequencer)) {
		checks.push({
			what: "the container healthcheck",
			failure: () => healthFailure(state.containerName, inspect),
		});
	}
	return checks;
}

/**
 * Wait for the testnode to be ready under one deadline shared by every check. A stopped container
 * fails the wait at once; a failed inspect does not until it fails several times in a row, since
 * a lost inspect is not evidence the container died.
 *
 * @param {TestnodeState} state
 * @param {number} timeoutMs
 * @param {ReadinessHooks} [hooks]
 */
export function waitForTestnodeReady(state, timeoutMs, hooks = {}) {
	const resolved = {
		inspect: hooks.inspect ?? inspectContainer,
		probe: hooks.probe ?? rpcFailure,
		sleep: hooks.sleep ?? sleepBriefly,
	};
	const deadline = Date.now() + timeoutMs;
	const pending = readinessChecks(state, resolved);
	const assertRunning = livenessCheck(state.containerName, resolved.inspect);
	for (;;) {
		const waiting = firstUnready(pending);
		if (!waiting) {
			return;
		}
		// After the probes, so a container that died during them reports as a crash rather than
		// a timeout, even on the last pass.
		assertRunning(waiting.what);
		if (Date.now() >= deadline) {
			throw new Error(
				`${waiting.what} not ready after ${timeoutMs}ms; last attempt: ${waiting.failure}`,
			);
		}
		resolved.sleep();
	}
}

/**
 * Drops the leading checks that now pass and returns the first that does not, with why.
 *
 * @param {Array<{ what: string; failure: () => string | undefined }>} pending
 */
function firstUnready(pending) {
	for (;;) {
		const [check] = pending;
		if (!check) {
			return undefined;
		}
		const failure = check.failure();
		if (failure !== undefined) {
			return { what: check.what, failure };
		}
		pending.shift();
	}
}

/**
 * @param {string} containerName
 * @param {typeof inspectContainer} inspect
 * @returns {(what: string) => void} throws once the container has stopped, or once inspect has
 *   failed several times in a row
 */
function livenessCheck(containerName, inspect) {
	let failures = 0;
	/** @param {string} what */
	const inspectTolerantly = (what) => {
		try {
			const container = inspect(containerName);
			failures = 0;
			return container;
		} catch (error) {
			failures += 1;
			if (failures < MAX_CONSECUTIVE_INSPECT_FAILURES) {
				return undefined;
			}
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(
				`cannot inspect container ${containerName} while waiting for ${what}: ${reason}`,
				{ cause: error },
			);
		}
	};
	return (what) => {
		const container = inspectTolerantly(what);
		if (container && !container.running) {
			throw new Error(
				`container ${containerName} stopped while waiting for ${what} (${describeContainerState(container)})`,
			);
		}
	};
}

/** @param {TestnodeState} state */
function copyExportedConfig(state) {
	runDocker(
		["cp", `${state.containerName}:/opt/arbitrum-testnode/export-config/.`, state.configDir],
		{ timeout: CONFIG_EXPORT_TIMEOUT_MS },
	);
}

/**
 * Copy the config the booted container exported. A failure is tagged export-only (see
 * isConfigExportFailure), which callers take as licence to skip the log dump, only when the
 * container is still running and produced config: otherwise it is a node failure whose logs are
 * the whole evidence.
 *
 * @param {TestnodeState} state
 * @param {{ copy?: (state: TestnodeState) => void; inspect?: typeof inspectContainer }} [hooks]
 * @returns {string[]}
 */
export function exportTestnodeConfig(state, hooks = {}) {
	const { copy = copyExportedConfig, inspect = inspectContainer } = hooks;
	mkdirSync(state.configDir, { recursive: true });
	try {
		copy(state);
	} catch (error) {
		const text = dockerErrorText(error).trim();
		if (MISSING_IN_CONTAINER.test(text)) {
			throw new Error(`config export failed: the container produced no config: ${text}`, {
				cause: error,
			});
		}
		let running = false;
		try {
			running = inspect(state.containerName).running;
		} catch {
			// Unknown state keeps the log dump.
		}
		if (!running) {
			throw new Error(`config export failed: ${text}`, { cause: error });
		}
		throw Object.assign(
			new Error(`config export failed after successful boot: ${text}`, { cause: error }),
			{ code: CONFIG_EXPORT_FAILED },
		);
	}
	const exported = readdirSync(state.configDir);
	if (exported.length === 0) {
		throw new Error(`config export failed: no config files exported to ${state.configDir}`);
	}
	return exported;
}

/**
 * The node booted and only copying its config failed.
 *
 * @param {unknown} error
 */
export function isConfigExportFailure(error) {
	return /** @type {{ code?: string }} */ (error)?.code === CONFIG_EXPORT_FAILED;
}

/**
 * `docker run` pulls an absent image itself, but inside its own timeout and with the progress
 * hidden, so a cold pull reads as a hung boot. Absent-only, as `docker run` would: a mutable tag
 * keeps booting the image already on the host, and a cached image still boots offline.
 *
 * @param {TestnodeState} state
 * @param {(args: string[], options?: import("node:child_process").ExecFileSyncOptions) => string} [run]
 */
export function pullMissingImage(state, run = runDocker) {
	if (state.imageRef.startsWith("local/")) {
		return;
	}
	try {
		run(["image", "inspect", "--format", "{{.Id}}", state.imageRef], {
			timeout: DOCKER_QUERY_TIMEOUT_MS,
		});
		return;
	} catch {
		// Any other inspect failure is a daemon problem, which the pull then reports itself.
	}
	run(["pull", state.imageRef], {
		stdio: ["ignore", PROGRESS_TO_STDERR, "inherit"],
		timeout: IMAGE_PULL_TIMEOUT_MS,
	});
}

/**
 * @param {TestnodeState} state
 * @param {number} timeoutMs
 */
export function bootTestnode(state, timeoutMs) {
	removeContainer(state.containerName);
	rmSync(state.outputDir, { force: true, recursive: true });
	mkdirSync(state.outputDir, { recursive: true });
	pullMissingImage(state);
	runDocker(testnodeDockerRunArgs(state), { timeout: CONTAINER_RUN_TIMEOUT_MS });
	waitForTestnodeReady(state, timeoutMs);
	return exportTestnodeConfig(state);
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
