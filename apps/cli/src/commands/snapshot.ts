import { resolve } from "node:path";
import { waitForRpc } from "@arbitrum/testnode-core/docker.js";
import {
	startL1Container,
	startNitroFromSnapshot,
	stopRuntime,
} from "@arbitrum/testnode-core/runtime.js";
import { bakeSnapshotImage } from "@arbitrum/testnode-core/snapshot-image.js";
import {
	installSnapshotRelease,
	packageSnapshotRelease,
} from "@arbitrum/testnode-core/snapshot-release.js";
import {
	DEFAULT_SNAPSHOT_ID,
	captureSnapshot,
	hasSnapshot,
	invalidateSnapshot,
	restoreSnapshot,
	verifySnapshotManifest,
	verifySnapshotSemanticState,
} from "@arbitrum/testnode-core/snapshot.js";
import { Cli, z } from "incur";
import { projectRoot } from "../project-root.js";

function snapshotPackDir(): string {
	return resolve(projectRoot(), "dist/snapshots");
}

const RPCS = {
	l1: "http://127.0.0.1:8545",
	l2: "http://127.0.0.1:8547",
	l3: "http://127.0.0.1:8549",
} as const;

export const snapshotCli = Cli.create("snapshot", {
	description: "Snapshot lifecycle commands",
});

const snapshotOptions = z.object({
	id: z.string().optional().describe("Snapshot identifier (default: default)"),
});

const snapshotInstallOptions = z.object({
	force: z.boolean().optional().describe("Replace an existing local snapshot"),
	id: z.string().optional().describe("Install the archive into this local snapshot id"),
	repo: z
		.string()
		.optional()
		.describe("GitHub repo in owner/repo form (defaults to TESTNODE_SNAPSHOT_GH_REPO)"),
	releaseTag: z.string().optional().describe("GitHub release tag to install (defaults to latest)"),
	url: z.string().optional().describe("Direct snapshot archive URL override"),
});

const snapshotBakeOptions = z.object({
	id: z.string().optional().describe("Snapshot identifier to bake (default: default)"),
	imageRef: z
		.string()
		.describe("Full image reference including tag (e.g. ghcr.io/acme/testnode:custom)"),
	push: z.boolean().optional().describe("docker push the image after building"),
	l3Enabled: z
		.boolean()
		.optional()
		.describe("Force L3 on/off (default: whether the snapshot carries an l3node archive)"),
});

const snapshotPackOptions = z.object({
	id: z.string().optional().describe("Snapshot identifier to package (default: default)"),
	outDir: z
		.string()
		.optional()
		.describe(
			"Output directory for packaged assets (default: dist/snapshots under the project root)",
		),
	tag: z.string().describe("Release tag used in the packaged asset names"),
});

snapshotCli.command("build", {
	description: "Capture the current initialized stack into a reusable snapshot",
	options: snapshotOptions,
	async run(c) {
		const CONFIG_DIR = resolve(projectRoot(), "config");
		const COMPOSE_FILE = resolve(projectRoot(), "docker/docker-compose.yaml");
		const snapshotId = c.options.id ?? DEFAULT_SNAPSHOT_ID;
		await verifySnapshotSemanticState(CONFIG_DIR, RPCS);
		stopRuntime({
			composeFile: COMPOSE_FILE,
			projectName: "arbitrum-testnode",
			configDir: CONFIG_DIR,
		});
		const manifest = captureSnapshot(CONFIG_DIR, COMPOSE_FILE, snapshotId);
		startL1Container({
			composeFile: COMPOSE_FILE,
			projectName: "arbitrum-testnode",
			configDir: CONFIG_DIR,
		});
		await waitForRpc(RPCS.l1);
		await startNitroFromSnapshot(
			{
				composeFile: COMPOSE_FILE,
				projectName: "arbitrum-testnode",
				configDir: CONFIG_DIR,
			},
			RPCS,
		);
		await verifySnapshotSemanticState(CONFIG_DIR, RPCS);
		return {
			success: true,
			snapshotId,
			manifest,
		};
	},
});

snapshotCli.command("restore", {
	description: "Restore a snapshot and start the stack from it",
	options: snapshotOptions,
	async run(c) {
		const CONFIG_DIR = resolve(projectRoot(), "config");
		const COMPOSE_FILE = resolve(projectRoot(), "docker/docker-compose.yaml");
		const snapshotId = c.options.id ?? DEFAULT_SNAPSHOT_ID;
		stopRuntime({
			composeFile: COMPOSE_FILE,
			projectName: "arbitrum-testnode",
			configDir: CONFIG_DIR,
		});
		const manifest = restoreSnapshot(CONFIG_DIR, snapshotId);
		startL1Container({
			composeFile: COMPOSE_FILE,
			projectName: "arbitrum-testnode",
			configDir: CONFIG_DIR,
		});
		await waitForRpc(RPCS.l1);
		await startNitroFromSnapshot(
			{
				composeFile: COMPOSE_FILE,
				projectName: "arbitrum-testnode",
				configDir: CONFIG_DIR,
			},
			RPCS,
		);
		await verifySnapshotSemanticState(CONFIG_DIR, RPCS);
		return {
			success: true,
			snapshotId,
			manifest,
		};
	},
});

snapshotCli.command("verify", {
	description: "Verify snapshot structure and, if running, semantic bridge state",
	options: snapshotOptions,
	async run(c) {
		const CONFIG_DIR = resolve(projectRoot(), "config");
		const snapshotId = c.options.id ?? DEFAULT_SNAPSHOT_ID;
		const manifest = verifySnapshotManifest(CONFIG_DIR, snapshotId);
		let semanticState: "skipped" | "verified" = "skipped";
		try {
			await waitForRpc(RPCS.l1, 1_000, 100);
			await waitForRpc(RPCS.l2, 1_000, 100);
			await waitForRpc(RPCS.l3, 1_000, 100);
			await verifySnapshotSemanticState(CONFIG_DIR, RPCS);
			semanticState = "verified";
		} catch {
			semanticState = "skipped";
		}
		return {
			success: true,
			snapshotId,
			semanticState,
			manifest,
		};
	},
});

snapshotCli.command("install", {
	description: "Download and install a snapshot release",
	options: snapshotInstallOptions,
	async run(c) {
		const CONFIG_DIR = resolve(projectRoot(), "config");
		const COMPOSE_FILE = resolve(projectRoot(), "docker/docker-compose.yaml");
		const result = await installSnapshotRelease({
			composeFile: COMPOSE_FILE,
			configDir: CONFIG_DIR,
			...(c.options.force !== undefined ? { force: c.options.force } : {}),
			...(c.options.id ? { snapshotId: c.options.id } : {}),
			...(c.options.releaseTag ? { version: c.options.releaseTag } : {}),
			...(c.options.repo ? { repo: c.options.repo } : {}),
			...(c.options.url ? { url: c.options.url } : {}),
		});
		return {
			success: true,
			snapshotId: result.snapshotId,
			archiveName: result.archiveName,
			sourceUrl: result.sourceUrl,
			sourceRepo: result.sourceRepo,
			releaseTag: result.releaseTag,
			manifest: result.manifest,
		};
	},
});

snapshotCli.command("pack", {
	description: "Package a local snapshot into GitHub release assets",
	options: snapshotPackOptions,
	run(c) {
		const CONFIG_DIR = resolve(projectRoot(), "config");
		const result = packageSnapshotRelease(CONFIG_DIR, {
			outDir: c.options.outDir ?? snapshotPackDir(),
			tag: c.options.tag,
			...(c.options.id ? { snapshotId: c.options.id } : {}),
		});
		return {
			success: true,
			snapshotId: result.snapshotId,
			tag: result.tag,
			archiveName: result.archiveName,
			archivePath: result.archivePath,
			checksum: result.checksum,
			checksumName: result.checksumName,
			checksumPath: result.checksumPath,
		};
	},
});

snapshotCli.command("bake", {
	description: "Build a runnable testnode docker image from a snapshot",
	options: snapshotBakeOptions,
	run(c) {
		const CONFIG_DIR = resolve(projectRoot(), "config");
		const snapshotId = c.options.id ?? DEFAULT_SNAPSHOT_ID;
		const result = bakeSnapshotImage({
			configDir: CONFIG_DIR,
			snapshotId,
			imageRef: c.options.imageRef,
			projectRoot: projectRoot(),
			...(c.options.push !== undefined ? { push: c.options.push } : {}),
			...(c.options.l3Enabled !== undefined ? { l3Enabled: c.options.l3Enabled } : {}),
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

snapshotCli.command("invalidate", {
	description: "Remove a snapshot bundle",
	options: snapshotOptions,
	run(c) {
		const CONFIG_DIR = resolve(projectRoot(), "config");
		const snapshotId = c.options.id ?? DEFAULT_SNAPSHOT_ID;
		return {
			success: true,
			snapshotId,
			removed: invalidateSnapshot(CONFIG_DIR, snapshotId),
		};
	},
});

export function hasDefaultSnapshot(): boolean {
	return hasSnapshot(resolve(projectRoot(), "config"), DEFAULT_SNAPSHOT_ID);
}
