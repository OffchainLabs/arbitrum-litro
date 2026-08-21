import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { buildTestnodeImageRef } from "@arbitrum/testnode";
import { execOrThrow } from "./exec.js";
import {
	getSnapshotAnvilStateDir,
	getSnapshotConfigDir,
	getSnapshotVolumesDir,
	verifySnapshotManifest,
} from "./snapshot.js";

/**
 * Turn a captured snapshot into a runnable testnode docker image.
 */

const SEQUENCER_ARCHIVE = "sequencer-data.tar";
const VALIDATOR_ARCHIVE = "validator-data.tar";
const L3NODE_ARCHIVE = "l3node-data.tar";

/** Docker-internal URLs rewritten to host URLs in the runtime node config. */
const RUNTIME_CONFIG_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
	["http://host.docker.internal:8545", "http://127.0.0.1:8545"],
	["http://host.docker.internal:8547", "http://127.0.0.1:8547"],
	["http://sequencer:8547", "http://127.0.0.1:8547"],
	["http://l3node:8547", "http://127.0.0.1:8549"],
	["/config/", "/opt/arbitrum-testnode/runtime-config/"],
];

/** Docker-internal URLs rewritten to host URLs in the exported (consumer) config. */
const EXPORT_CONFIG_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
	["http://host.docker.internal:8545", "http://127.0.0.1:8545"],
	["http://host.docker.internal:8547", "http://127.0.0.1:8547"],
	["http://sequencer:8547", "http://127.0.0.1:8547"],
	["http://l3node:8547", "http://127.0.0.1:3347"],
	["http://127.0.0.1:8549", "http://127.0.0.1:3347"],
];

function walkJsonFiles(path: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(path)) {
		const fullPath = join(path, entry);
		if (statSync(fullPath).isDirectory()) {
			files.push(...walkJsonFiles(fullPath));
			continue;
		}
		if (entry.endsWith(".json")) {
			files.push(fullPath);
		}
	}
	return files;
}

function rewriteTree(
	rootDir: string,
	replacements: ReadonlyArray<readonly [string, string]>,
): void {
	for (const filePath of walkJsonFiles(rootDir)) {
		const next = replacements.reduce(
			(content, [pattern, value]) => content.replaceAll(pattern, value),
			readFileSync(filePath, "utf-8"),
		);
		writeFileSync(filePath, next);
	}
}

function extractArchive(archivePath: string, destination: string): void {
	mkdirSync(destination, { recursive: true });
	execOrThrow("tar", ["-xf", archivePath, "-C", destination]);
}

export interface PrepareContextOptions {
	/** Directory that holds the `snapshots/<id>` tree (the testnode `config` dir). */
	configDir: string;
	/** Snapshot id to lay out. */
	snapshotId: string;
	/** Where to write the `.testnode-context` layout consumed by the Dockerfile. */
	outputDir: string;
	/**
	 * Whether the image should boot an L3 node. Defaults to whether the snapshot
	 * captured an l3node volume archive, so custom snapshots decide for themselves.
	 */
	l3Enabled?: boolean;
	/** Free-form label recorded in the image metadata (e.g. downstream image name). */
	testnodeName?: string;
	/** Recorded in metadata for provenance; not otherwise interpreted. */
	nitroContractsVersion?: string;
	/** Recorded in metadata for provenance; the generic path has no variant. */
	variant?: string;
}

export interface PrepareContextResult {
	outputDir: string;
	l3Enabled: boolean;
}

/**
 * Whether a captured snapshot carries an l3node volume archive. Used as the
 * default for `l3Enabled` so the generic bake path never has to know the closed
 * variant catalog.
 */
export function snapshotHasL3(configDir: string, snapshotId: string): boolean {
	const manifest = verifySnapshotManifest(configDir, snapshotId);
	return manifest.volumeArchives.includes(join("volumes", L3NODE_ARCHIVE));
}

/**
 * Lay out the `.testnode-context` directory (`export-config`, `runtime-config`,
 * `runtime`, `metadata.json`) that `docker/testnode.Dockerfile` copies into the
 * runnable image, rewriting docker-internal URLs to host URLs.
 */
export function prepareTestnodeContext(options: PrepareContextOptions): PrepareContextResult {
	const manifest = verifySnapshotManifest(options.configDir, options.snapshotId);
	const l3Enabled =
		options.l3Enabled ?? manifest.volumeArchives.includes(join("volumes", L3NODE_ARCHIVE));
	const outputDir = resolve(options.outputDir);
	const runtimeConfigDir = join(outputDir, "runtime-config");
	const exportConfigDir = join(outputDir, "export-config");
	const runtimeDir = join(outputDir, "runtime");
	const volumeDir = getSnapshotVolumesDir(options.configDir, options.snapshotId);
	const snapshotConfigDir = getSnapshotConfigDir(options.configDir, options.snapshotId);
	const snapshotAnvilStateDir = getSnapshotAnvilStateDir(options.configDir, options.snapshotId);

	rmSync(outputDir, { force: true, recursive: true });
	mkdirSync(outputDir, { recursive: true });
	cpSync(snapshotConfigDir, runtimeConfigDir, { recursive: true });
	cpSync(snapshotConfigDir, exportConfigDir, { recursive: true });
	cpSync(snapshotAnvilStateDir, join(runtimeDir, "anvil-state"), { recursive: true });

	extractArchive(join(volumeDir, SEQUENCER_ARCHIVE), join(runtimeDir, "sequencer", ".arbitrum"));
	extractArchive(join(volumeDir, VALIDATOR_ARCHIVE), join(runtimeDir, "validator", ".arbitrum"));
	if (l3Enabled) {
		extractArchive(join(volumeDir, L3NODE_ARCHIVE), join(runtimeDir, "l3node", ".arbitrum"));
	}

	rewriteTree(runtimeConfigDir, RUNTIME_CONFIG_REPLACEMENTS);
	rewriteTree(exportConfigDir, EXPORT_CONFIG_REPLACEMENTS);

	writeFileSync(
		join(outputDir, "metadata.json"),
		`${JSON.stringify(
			{
				l3Enabled,
				nitroContractsVersion:
					options.nitroContractsVersion ?? manifest.nitroContractsVersion ?? "",
				snapshotId: options.snapshotId,
				testnodeName: options.testnodeName ?? "",
				variant: options.variant ?? "",
			},
			null,
			2,
		)}\n`,
	);

	return { outputDir, l3Enabled };
}

export interface BakeSnapshotImageOptions {
	/** Directory that holds the `snapshots/<id>` tree (the testnode `config` dir). */
	configDir: string;
	/** Snapshot id to bake. */
	snapshotId: string;
	/** Full image reference including tag, e.g. `ghcr.io/acme/testnode:custom`. */
	imageRef: string;
	/** Docker build context / repo root containing `docker/testnode.Dockerfile`. */
	projectRoot: string;
	/** Published testnode bundle to layer the snapshot onto. */
	baseImageRef?: string;
	/** `docker push` the image after building. */
	push?: boolean;
	/** Override the Dockerfile (default `docker/custom-testnode.Dockerfile` under root). */
	dockerfile?: string;
	/** Override the `.testnode-context` output dir (default under the build context). */
	contextDir?: string;
	/** Force L3 on/off; defaults to whether the snapshot carries an l3node archive. */
	l3Enabled?: boolean;
	/** Recorded in image metadata for provenance. */
	testnodeName?: string;
	nitroContractsVersion?: string;
	variant?: string;
}

export interface BakeSnapshotImageResult {
	imageRef: string;
	l3Enabled: boolean;
	pushed: boolean;
	contextDir: string;
}

function defaultBaseImageRef(l3Enabled: boolean): string {
	return buildTestnodeImageRef({ variant: l3Enabled ? "l3-eth" : "l2", version: "latest" });
}

/**
 * Prepare a snapshot's docker context and build (optionally push) a runnable
 * testnode image from it. Registry auth is the caller's responsibility.
 */
export function bakeSnapshotImage(options: BakeSnapshotImageOptions): BakeSnapshotImageResult {
	if (!options.imageRef) {
		throw new Error("imageRef is required");
	}
	const projectRoot = resolve(options.projectRoot);
	const dockerfile = options.dockerfile
		? resolve(options.dockerfile)
		: join(projectRoot, "docker", "custom-testnode.Dockerfile");
	if (!existsSync(dockerfile)) {
		throw new Error(`Dockerfile not found: ${dockerfile}`);
	}
	// The Dockerfile COPYs from a `.testnode-context` path relative to the build
	// context, so the context dir must live inside the build context (repo root).
	const contextDir = options.contextDir
		? resolve(options.contextDir)
		: join(projectRoot, ".testnode-context");

	const prepared = prepareTestnodeContext({
		configDir: options.configDir,
		snapshotId: options.snapshotId,
		outputDir: contextDir,
		...(options.l3Enabled !== undefined ? { l3Enabled: options.l3Enabled } : {}),
		...(options.testnodeName !== undefined ? { testnodeName: options.testnodeName } : {}),
		...(options.nitroContractsVersion !== undefined
			? { nitroContractsVersion: options.nitroContractsVersion }
			: {}),
		...(options.variant !== undefined ? { variant: options.variant } : {}),
	});
	const baseImageRef = options.baseImageRef ?? defaultBaseImageRef(prepared.l3Enabled);

	execOrThrow(
		"docker",
		[
			"build",
			"--build-arg",
			`BASE_IMAGE=${baseImageRef}`,
			"-f",
			dockerfile,
			"-t",
			options.imageRef,
			projectRoot,
		],
		{
			timeout: 900_000,
		},
	);

	let pushed = false;
	if (options.push) {
		execOrThrow("docker", ["push", options.imageRef], { timeout: 900_000 });
		pushed = true;
	}

	return {
		imageRef: options.imageRef,
		l3Enabled: prepared.l3Enabled,
		pushed,
		contextDir,
	};
}
