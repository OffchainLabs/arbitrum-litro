import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { waitForRpc } from "@arbitrum/testnode-core/docker.js";
import { createInitContext, runInitCommand } from "@arbitrum/testnode-core/init-runner.js";
import {
	startL1Container,
	startNitroFromSnapshot,
	stopRuntime,
} from "@arbitrum/testnode-core/runtime.js";
import { bakeSnapshotImage } from "@arbitrum/testnode-core/snapshot-image.js";
import {
	DEFAULT_SNAPSHOT_ID,
	captureSnapshot,
	hasSnapshot,
	restoreSnapshot,
	verifySnapshotSemanticState,
} from "@arbitrum/testnode-core/snapshot.js";
import { Cli, z } from "incur";
import { projectRoot } from "../project-root.js";

const PROJECT_NAME = "arbitrum-testnode";

const RPCS = {
	l1: "http://127.0.0.1:8545",
	l2: "http://127.0.0.1:8547",
	l3: "http://127.0.0.1:8549",
} as const;

const bakeOptions = z.object({
	setupCommand: z
		.string()
		.describe("Shell command run against the booted base stack to customize it"),
	imageRef: z
		.string()
		.describe("Full image reference including tag (e.g. ghcr.io/acme/testnode:custom)"),
	snapshotId: z
		.string()
		.optional()
		.describe("Snapshot id the customized stack is captured under (default: custom)"),
	push: z.boolean().optional().describe("docker push the baked image"),
	rebuild: z
		.boolean()
		.optional()
		.describe("Run a full init instead of restoring the installed default snapshot"),
	baseSnapshotId: z
		.string()
		.optional()
		.describe("Base snapshot to restore when not rebuilding (default: default)"),
	nitroContractsVersion: z
		.string()
		.optional()
		.describe("Nitro contracts version for a rebuild init (e.g. v2.1, v3.2)"),
	feeTokenDecimals: z
		.number()
		.optional()
		.describe("Custom fee token decimals (6, 16, 18, or 20) for a rebuild init"),
	timeboostEnabled: z.boolean().optional().describe("Enable Timeboost for a rebuild init"),
});

/**
 * Boot the base stack the customization runs against. `--rebuild` runs a full
 * init; otherwise the installed base snapshot is restored and started, mirroring
 * `snapshot restore`.
 */
async function ensureBaseStack(
	root: string,
	configDir: string,
	composeFile: string,
	options: z.infer<typeof bakeOptions>,
): Promise<void> {
	if (options.rebuild) {
		await runInitCommand(
			{
				rebuild: true,
				...(options.nitroContractsVersion
					? { nitroContractsVersion: options.nitroContractsVersion }
					: {}),
				...(options.feeTokenDecimals !== undefined
					? { feeTokenDecimals: options.feeTokenDecimals }
					: {}),
				...(options.timeboostEnabled !== undefined
					? { timeboostEnabled: options.timeboostEnabled }
					: {}),
			},
			createInitContext(root),
		);
		return;
	}

	const baseSnapshotId = options.baseSnapshotId ?? DEFAULT_SNAPSHOT_ID;
	if (!hasSnapshot(configDir, baseSnapshotId)) {
		throw new Error(
			`No base snapshot '${baseSnapshotId}' installed; install one first or pass --rebuild`,
		);
	}
	stopRuntime({ composeFile, projectName: PROJECT_NAME, configDir });
	restoreSnapshot(configDir, baseSnapshotId);
	startL1Container({ composeFile, projectName: PROJECT_NAME, configDir });
	await waitForRpc(RPCS.l1);
	await startNitroFromSnapshot({ composeFile, projectName: PROJECT_NAME, configDir }, RPCS);
}

/**
 * Run the downstream customization on the host. The stack is already booted, so
 * the command sees live L1/L2 RPCs and can write extra files into the config dir
 * (they ride along into the snapshot + config export).
 */
function runSetupCommand(setupCommand: string, configDir: string): void {
	const result = spawnSync(setupCommand, {
		shell: true,
		stdio: "inherit",
		env: {
			...process.env,
			ARBITRUM_TESTNODE_L1_RPC_URL: RPCS.l1,
			ARBITRUM_TESTNODE_L2_RPC_URL: RPCS.l2,
			ARBITRUM_TESTNODE_L3_RPC_URL: RPCS.l3,
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

export const bakeCli = Cli.create("bake", {
	description:
		"Boot the base stack, run a setup command against it, snapshot the result, and build an image",
	options: bakeOptions,
	async run(c) {
		const root = projectRoot();
		const configDir = resolve(root, "config");
		const composeFile = resolve(root, "docker/docker-compose.yaml");
		const snapshotId = c.options.snapshotId ?? "custom";

		await ensureBaseStack(root, configDir, composeFile, c.options);

		runSetupCommand(c.options.setupCommand, configDir);

		// Capture the customized stack. Verify while running, then stop so the
		// docker volumes are exported consistently (mirrors `snapshot build`).
		await verifySnapshotSemanticState(configDir, RPCS);
		stopRuntime({ composeFile, projectName: PROJECT_NAME, configDir });
		captureSnapshot(configDir, composeFile, snapshotId);

		const result = bakeSnapshotImage({
			configDir,
			snapshotId,
			imageRef: c.options.imageRef,
			projectRoot: root,
			...(c.options.push !== undefined ? { push: c.options.push } : {}),
		});

		return {
			success: true,
			snapshotId,
			imageRef: result.imageRef,
			l3Enabled: result.l3Enabled,
			pushed: result.pushed,
			contextDir: result.contextDir,
		};
	},
});
