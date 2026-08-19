import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	type ContainerDiagnostics,
	bootTestnode,
	buildStartTestnodeState,
	collectContainerDiagnostics,
	copyNetworkConfigPaths,
	pruneStaleRebasedImages,
	rebaseTestnodeImage,
} from "@arbitrum/testnode";
import { Cli, z } from "incur";
import { DEFAULT_START_IMAGE_VERSION } from "../package-metadata.js";

const DEFAULT_CONFIG_BASENAME = "testnode.start.json";
export { DEFAULT_START_IMAGE_VERSION };

const startFileSchema = z.object({
	containerName: z.string().optional(),
	feeTokenDecimals: z.number().optional(),
	imageRef: z.string().optional(),
	imageRepository: z.string().optional(),
	l3Enabled: z.boolean().optional(),
	networkConfigPath: z.union([z.string(), z.array(z.string())]).optional(),
	nitroContractsVersion: z.string().optional(),
	nitroImage: z.string().optional(),
	outputDir: z.string().optional(),
	startupTimeoutSeconds: z.number().optional(),
	timeboostEnabled: z.boolean().optional(),
	version: z.string().optional(),
});

type StartFileConfig = z.infer<typeof startFileSchema>;

interface StartResolvedInput {
	configPath: string | undefined;
	containerName: string | undefined;
	cwd: string;
	feeTokenDecimals: number | undefined;
	imageRef: string | undefined;
	imageRepository: string | undefined;
	l3Enabled: boolean;
	networkConfigPaths: string[];
	nitroContractsVersion: string | undefined;
	nitroImage: string | undefined;
	outputDir: string | undefined;
	startupTimeoutSeconds: number;
	timeboostEnabled: boolean;
	version: string;
}

interface StartExecutionDeps {
	bootTestnode: typeof bootTestnode;
	collectContainerDiagnostics: typeof collectContainerDiagnostics;
	copyNetworkConfigPaths: typeof copyNetworkConfigPaths;
	pruneStaleRebasedImages?: typeof pruneStaleRebasedImages;
	rebaseTestnodeImage: typeof rebaseTestnodeImage;
}

type StartResult =
	| {
			success: false;
			error: string;
			diagnostics?: ContainerDiagnostics;
	  }
	| {
			success: true;
			baseImageRef: string;
			configDir: string;
			configPath?: string;
			containerName: string;
			exportedFiles: string[];
			imageRef: string;
			nitroImage: string;
			l1RpcUrl: string;
			l2RpcUrl: string;
			l3RpcUrl: string;
			localNetworkPath: string;
			networkConfigPaths: string[];
			timeboostEnabled: boolean;
			variant: string;
	  };

function resolveOptionalPath(baseDir: string, value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	return resolve(baseDir, value);
}

function resolveNetworkConfigPaths(
	baseDir: string,
	value: string | string[] | undefined,
): string[] {
	if (!value) {
		return [];
	}
	const rawPaths = Array.isArray(value) ? value : value.split(",");
	return rawPaths
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => resolve(baseDir, entry));
}

export function getDefaultStartConfigPath(cwd: string): string {
	return resolve(cwd, DEFAULT_CONFIG_BASENAME);
}

export function loadStartFileConfig(
	configPath: string | undefined,
	cwd: string,
): { config: StartFileConfig; path?: string } {
	const resolvedPath = configPath ? resolve(cwd, configPath) : getDefaultStartConfigPath(cwd);
	if (!existsSync(resolvedPath)) {
		if (configPath) {
			throw new Error(`Start config not found: ${resolvedPath}`);
		}
		return { config: {} };
	}
	const raw = JSON.parse(readFileSync(resolvedPath, "utf-8")) as unknown;
	return { config: startFileSchema.parse(raw), path: resolvedPath };
}

function resolveStartVersion(
	imageVersion: string | undefined,
	fileVersion: string | undefined,
): string {
	return imageVersion ?? fileVersion ?? DEFAULT_START_IMAGE_VERSION;
}

function resolveMergedOutputDir(params: {
	configDir: string;
	cwd: string;
	fileValue: string | undefined;
	optionValue: string | undefined;
}): string | undefined {
	if (params.optionValue !== undefined) {
		return resolveOptionalPath(params.cwd, params.optionValue);
	}
	return resolveOptionalPath(params.configDir, params.fileValue);
}

function resolveMergedNetworkConfigPaths(params: {
	configDir: string;
	cwd: string;
	fileValue: string | string[] | undefined;
	optionValue: string | undefined;
}): string[] {
	if (params.optionValue !== undefined) {
		return resolveNetworkConfigPaths(params.cwd, params.optionValue);
	}
	return resolveNetworkConfigPaths(params.configDir, params.fileValue);
}

export function resolveStartInput(
	options: {
		config?: string | undefined;
		containerName?: string | undefined;
		feeTokenDecimals?: number | undefined;
		imageRef?: string | undefined;
		imageRepository?: string | undefined;
		l3Enabled?: boolean | undefined;
		networkConfigPath?: string | undefined;
		nitroContractsVersion?: string | undefined;
		nitroImage?: string | undefined;
		outputDir?: string | undefined;
		startupTimeoutSeconds?: number | undefined;
		timeboostEnabled?: boolean | undefined;
		imageVersion?: string | undefined;
	},
	cwd = process.cwd(),
): StartResolvedInput {
	const { config: fileConfig, path: resolvedConfigPath } = loadStartFileConfig(options.config, cwd);
	const configDir = resolvedConfigPath ? dirname(resolvedConfigPath) : cwd;

	return {
		configPath: resolvedConfigPath,
		containerName: options.containerName ?? fileConfig.containerName,
		cwd,
		feeTokenDecimals: options.feeTokenDecimals ?? fileConfig.feeTokenDecimals,
		imageRef: options.imageRef ?? fileConfig.imageRef,
		imageRepository: options.imageRepository ?? fileConfig.imageRepository,
		l3Enabled: options.l3Enabled ?? fileConfig.l3Enabled ?? true,
		networkConfigPaths: resolveMergedNetworkConfigPaths({
			configDir,
			cwd,
			fileValue: fileConfig.networkConfigPath,
			optionValue: options.networkConfigPath,
		}),
		nitroContractsVersion: options.nitroContractsVersion ?? fileConfig.nitroContractsVersion,
		nitroImage: options.nitroImage ?? fileConfig.nitroImage,
		outputDir: resolveMergedOutputDir({
			configDir,
			cwd,
			fileValue: fileConfig.outputDir,
			optionValue: options.outputDir,
		}),
		startupTimeoutSeconds: options.startupTimeoutSeconds ?? fileConfig.startupTimeoutSeconds ?? 120,
		timeboostEnabled: options.timeboostEnabled ?? fileConfig.timeboostEnabled ?? false,
		version: resolveStartVersion(options.imageVersion, fileConfig.version),
	};
}

// A rebase failure gets no container diagnostics: no container was started, and
// any container from a previous run would be unrelated to the build error.
function runRebase(
	state: ReturnType<typeof buildStartTestnodeState>,
	deps: StartExecutionDeps,
): Extract<StartResult, { success: false }> | undefined {
	if (!state.nitroImage) {
		return undefined;
	}
	// GC before — not after — the build: a cache-hit rebuild can resurrect an
	// image already older than the prune window.
	deps.pruneStaleRebasedImages?.();
	try {
		deps.rebaseTestnodeImage(state);
		return undefined;
	} catch (error) {
		return {
			success: false as const,
			error: `rebase onto ${state.nitroImage} failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function runStart(
	input: StartResolvedInput,
	deps: StartExecutionDeps = {
		bootTestnode,
		collectContainerDiagnostics,
		copyNetworkConfigPaths,
		pruneStaleRebasedImages,
		rebaseTestnodeImage,
	},
): StartResult {
	if (!Number.isFinite(input.startupTimeoutSeconds) || input.startupTimeoutSeconds <= 0) {
		throw new Error("startup-timeout-seconds must be a positive number");
	}

	const state = buildStartTestnodeState({
		containerName: input.containerName,
		contractsVersion: input.nitroContractsVersion,
		cwd: input.cwd,
		feeTokenDecimals: input.feeTokenDecimals,
		imageRef: input.imageRef,
		imageRepository: input.imageRepository,
		l3Enabled: input.l3Enabled,
		nitroImage: input.nitroImage,
		outputDir: input.outputDir,
		timeboostEnabled: input.timeboostEnabled,
		version: input.version,
	});

	const rebaseFailure = runRebase(state, deps);
	if (rebaseFailure) {
		return rebaseFailure;
	}

	let exported: string[];
	try {
		exported = deps.bootTestnode(state, input.startupTimeoutSeconds * 1000);
	} catch (error) {
		return {
			success: false as const,
			error: error instanceof Error ? error.message : String(error),
			diagnostics: deps.collectContainerDiagnostics(state.containerName),
		};
	}
	if (input.networkConfigPaths.length > 0) {
		deps.copyNetworkConfigPaths(state.paths.localNetwork, input.networkConfigPaths);
	}

	return {
		success: true as const,
		baseImageRef: state.baseImageRef,
		configDir: state.configDir,
		containerName: state.containerName,
		exportedFiles: exported,
		imageRef: state.imageRef,
		nitroImage: state.nitroImage,
		l1RpcUrl: state.rpcUrls.l1,
		l2RpcUrl: state.rpcUrls.l2,
		l3RpcUrl: state.rpcUrls.l3,
		localNetworkPath: state.paths.localNetwork,
		networkConfigPaths: input.networkConfigPaths,
		timeboostEnabled: input.timeboostEnabled,
		variant: state.variant,
		...(input.configPath ? { configPath: input.configPath } : {}),
	};
}

export const startCli = Cli.create("start", {
	description: "Boot the published testnode image from config with one command",
	options: z.object({
		config: z.string().optional().describe("Path to a start JSON config file"),
		containerName: z.string().optional().describe("Optional Docker container name override"),
		feeTokenDecimals: z
			.number()
			.optional()
			.describe("Custom fee token decimals (6, 16, 18, or 20) for L3 start"),
		imageRef: z
			.string()
			.optional()
			.describe("Full image reference (incl. tag) to boot, bypassing variant/version resolution"),
		imageRepository: z
			.string()
			.optional()
			.describe("Container repository prefix used to resolve the testnode image"),
		l3Enabled: z.boolean().optional().describe("Set false to boot the L2-only testnode"),
		networkConfigPath: z
			.string()
			.optional()
			.describe("Comma-separated path(s) to overwrite with localNetwork.json"),
		nitroContractsVersion: z
			.string()
			.optional()
			.describe("Nitro contracts version (e.g. v2.1, v3.2)"),
		nitroImage: z
			.string()
			.optional()
			.describe("Nitro image to rebase the testnode image onto before booting"),
		outputDir: z
			.string()
			.optional()
			.describe("Directory where exported config files should be written"),
		startupTimeoutSeconds: z
			.number()
			.optional()
			.describe("Maximum time to wait for the testnode RPCs to become ready"),
		timeboostEnabled: z
			.boolean()
			.optional()
			.describe("Enable Timeboost sequencer args and auctioneer/timeboost HTTP APIs"),
		imageVersion: z
			.string()
			.optional()
			.describe("Pinned release version used to resolve the testnode image tag"),
	}),
	run(c) {
		try {
			const input = resolveStartInput(c.options);
			return runStart(input);
		} catch (error) {
			return {
				success: false as const,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},
});
