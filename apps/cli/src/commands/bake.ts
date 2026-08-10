import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
	bootTestnode,
	buildStartTestnodeState,
	collectContainerDiagnostics,
	removeContainer,
	runDocker,
} from "@arbitrum/testnode";
import { verifySnapshotSemanticState } from "@arbitrum/testnode-core/snapshot.js";
import { Cli, z } from "incur";

interface RpcUrls {
	l1: string;
	l2: string;
	l3: string;
}

interface BundleBakeOptions {
	baseImageRef?: string | undefined;
	feeTokenDecimals?: number | undefined;
	imageRef: string;
	imageRepository?: string | undefined;
	imageVersion?: string | undefined;
	l3Enabled?: boolean | undefined;
	outputDir?: string | undefined;
	push?: boolean | undefined;
	setupCommand: string;
	setupWorkingDirectory?: string | undefined;
	startupTimeoutSeconds?: number | undefined;
	timeboostEnabled?: boolean | undefined;
}

interface BundleBakeDependencies {
	boot: typeof bootTestnode;
	remove: typeof removeContainer;
	runDocker: typeof runDocker;
	verify: typeof verifySnapshotSemanticState;
}

const defaultDependencies: BundleBakeDependencies = {
	boot: bootTestnode,
	remove: removeContainer,
	runDocker,
	verify: verifySnapshotSemanticState,
};

function runSetupCommand(
	setupCommand: string,
	configDir: string,
	rpcUrls: RpcUrls,
	setupWorkingDirectory?: string,
): void {
	const result = spawnSync(setupCommand, {
		shell: true,
		stdio: "inherit",
		...(setupWorkingDirectory ? { cwd: resolve(setupWorkingDirectory) } : {}),
		env: {
			...process.env,
			ARBITRUM_TESTNODE_L1_RPC_URL: rpcUrls.l1,
			ARBITRUM_TESTNODE_L2_RPC_URL: rpcUrls.l2,
			ARBITRUM_TESTNODE_L3_RPC_URL: rpcUrls.l3,
			ARBITRUM_TESTNODE_CONFIG_DIR: configDir,
			ARBITRUM_TESTNODE_DEPLOYMENT_JSON: resolve(configDir, "deployment.json"),
		},
	});
	if (result.error) {
		throw new Error(`setup-command failed to start: ${result.error.message}`);
	}
	if (typeof result.status === "number" && result.status !== 0) {
		throw new Error(`setup-command exited with code ${result.status}`);
	}
	if (result.signal) {
		throw new Error(`setup-command terminated by signal ${result.signal}`);
	}
}

function resolveBundleState(options: BundleBakeOptions) {
	return buildStartTestnodeState({
		cwd: process.cwd(),
		feeTokenDecimals: options.feeTokenDecimals,
		imageRef: options.baseImageRef,
		imageRepository: options.imageRepository,
		l3Enabled: options.l3Enabled ?? true,
		outputDir: options.outputDir,
		timeboostEnabled: options.timeboostEnabled,
		version: options.imageVersion?.trim() || "latest",
	});
}

function pullBundle(imageRef: string, deps: BundleBakeDependencies): void {
	if (!imageRef.startsWith("local/")) {
		deps.runDocker(["pull", imageRef], { stdio: "inherit" });
	}
}

function commitBundle(
	containerName: string,
	baseImageRef: string,
	imageRef: string,
	deps: BundleBakeDependencies,
): void {
	deps.runDocker(["stop", "--timeout", "30", containerName], { stdio: "inherit" });
	deps.runDocker(
		[
			"commit",
			"--change",
			`LABEL io.arbitrum.testnode.bundle.parent=${baseImageRef}`,
			containerName,
			imageRef,
		],
		{ stdio: "inherit" },
	);
}

function logBakeDiagnostics(containerName: string): void {
	const diagnostics = collectContainerDiagnostics(containerName);
	if (diagnostics.inspect) {
		console.error(`[bake] container: ${diagnostics.inspect}`);
	}
	if (diagnostics.logs) {
		console.error(`[bake] logs:\n${diagnostics.logs}`);
	}
}

/**
 * Customize an already-baked testnode bundle. The container's writable layer
 * is the bundle: Anvil persists its state file and Nitro persists its databases
 * under /opt/arbitrum-testnode/runtime. A clean stop followed by docker commit
 * produces a derived image without rebuilding any contract source.
 */
export async function runBundleBake(
	options: BundleBakeOptions,
	deps: BundleBakeDependencies = defaultDependencies,
) {
	const state = resolveBundleState(options);
	const timeoutMs = (options.startupTimeoutSeconds ?? 300) * 1000;

	try {
		pullBundle(state.imageRef, deps);
		deps.boot(state, timeoutMs);
		runSetupCommand(
			options.setupCommand,
			state.configDir,
			state.rpcUrls,
			options.setupWorkingDirectory,
		);
		if (state.variantDefinition.l3Enabled) {
			await deps.verify(state.configDir, state.rpcUrls);
		}

		// Files written by setup-command are part of the bundle's exported config.
		deps.runDocker([
			"cp",
			`${state.configDir}/.`,
			`${state.containerName}:/opt/arbitrum-testnode/export-config`,
		]);
		// A graceful stop flushes Anvil's --state file and Nitro's databases before
		// docker commit captures the container layer.
		commitBundle(state.containerName, state.imageRef, options.imageRef, deps);
		if (options.push) {
			deps.runDocker(["push", options.imageRef], { stdio: "inherit" });
		}
		return {
			success: true,
			baseImageRef: state.imageRef,
			imageRef: options.imageRef,
			pushed: options.push ?? false,
			variant: state.variant,
		};
	} catch (error) {
		logBakeDiagnostics(state.containerName);
		throw error;
	} finally {
		deps.remove(state.containerName);
	}
}

export const bakeCli = Cli.create("bake", {
	description: "Customize a published testnode bundle and commit it as a new image",
	options: z.object({
		baseImageRef: z.string().optional().describe("Published bundle image override"),
		feeTokenDecimals: z
			.number()
			.optional()
			.describe("Custom fee token decimals (6, 16, 18, or 20)"),
		imageRef: z.string().describe("Full output image reference including tag"),
		imageRepository: z.string().optional().describe("Published bundle image repository"),
		imageVersion: z.string().optional().describe("Published bundle version (default: latest)"),
		l3Enabled: z.boolean().optional().describe("Use an L3-enabled bundle (default: true)"),
		outputDir: z.string().optional().describe("Temporary exported-config directory"),
		push: z.boolean().optional().describe("Push the customized image"),
		setupCommand: z.string().describe("Shell command run against the booted bundle"),
		setupWorkingDirectory: z.string().optional().describe("Setup command working directory"),
		startupTimeoutSeconds: z.number().optional().describe("Bundle startup timeout (default: 300)"),
		timeboostEnabled: z.boolean().optional().describe("Use the L2 Timeboost bundle"),
	}),
	async run(c) {
		return runBundleBake(c.options);
	},
});
