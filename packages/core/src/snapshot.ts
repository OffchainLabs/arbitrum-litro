import { createHash } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Address } from "viem";
import { execOrThrow } from "./exec.js";
import { ZERO_ADDRESS } from "./init-helpers.js";
import { gatewayRouterAbi, publicClient } from "./rpc.js";

export const SNAPSHOT_VERSION = 1;
export const DEFAULT_SNAPSHOT_ID = "default";
export const SNAPSHOTS_DIRNAME = "snapshots";
export const ANVIL_STATE_DIRNAME = "anvil-state";
export const ANVIL_STATE_FILENAME = "state.json";

export interface SnapshotManifest {
	version: number;
	snapshotId: string;
	createdAt: string;
	nitroNodeImage: string;
	chainIds: {
		l1: number;
		l2: number;
		l3: number;
	};
	rollups: {
		l2: string;
		l3: string;
	};
	nitroContractsVersion?: string;
	requiredFiles: string[];
	configChecksums: Record<string, string>;
	volumeArchives: string[];
}

const CRITICAL_CONFIG_FILES = [
	"state.json",
	"l2-nodeConfig.json",
	"l3-nodeConfig.json",
	"l2_chain_info.json",
	"l3_chain_info.json",
	"l2_deployment.json",
	"l3_deployment.json",
	"l1-l2-chain-config.json",
	"l2-l3-chain-config.json",
	"localNetwork.json",
	"l1-l2-admin/bridgeUiConfig.json",
	"l2-l3-admin/bridgeUiConfig.json",
] as const;

const SNAPSHOT_VOLUME_ARCHIVES = [
	{ volumeName: "arbitrum-testnode_sequencer-data", archiveName: "sequencer-data.tar" },
	{ volumeName: "arbitrum-testnode_validator-data", archiveName: "validator-data.tar" },
	{ volumeName: "arbitrum-testnode_l3node-data", archiveName: "l3node-data.tar" },
] as const;

function ensureDirectory(path: string): void {
	mkdirSync(path, { recursive: true });
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function copyDirectoryContents(sourceDir: string, destDir: string): void {
	ensureDirectory(destDir);
	for (const entry of readdirSync(sourceDir)) {
		const sourcePath = join(sourceDir, entry);
		if (sourcePath === resolve(join(sourceDir, SNAPSHOTS_DIRNAME))) {
			continue;
		}
		cpSync(sourcePath, join(destDir, entry), { recursive: true });
	}
}

function copyPath(sourcePath: string, destPath: string): void {
	const stats = statSync(sourcePath);
	if (stats.isDirectory()) {
		copyDirectoryContents(sourcePath, destPath);
		return;
	}
	ensureDirectory(dirname(destPath));
	copyFileSync(sourcePath, destPath);
}

function clearDirectoryExcept(path: string, namesToKeep: Set<string>): void {
	if (!existsSync(path)) {
		return;
	}
	for (const entry of readdirSync(path)) {
		if (namesToKeep.has(entry)) {
			continue;
		}
		rmSync(join(path, entry), { recursive: true, force: true });
	}
}

function parseDeploymentFile(configDir: string, name: "l2" | "l3"): { rollup: string } {
	const filename = name === "l2" ? "l2_deployment.json" : "l3_deployment.json";
	return JSON.parse(readFileSync(join(configDir, filename), "utf-8")) as { rollup: string };
}

export function readNitroNodeImage(composeFile: string): string {
	const compose = readFileSync(composeFile, "utf-8");
	const match = compose.match(/image:\s*(offchainlabs\/nitro-node:[^\s]+)/);
	const image = match?.[1];
	if (!image) {
		throw new Error(`Unable to determine Nitro image from ${composeFile}`);
	}
	return image;
}

function assertRequiredConfigFiles(configDir: string): void {
	for (const filename of CRITICAL_CONFIG_FILES) {
		const fullPath = join(configDir, filename);
		if (!existsSync(fullPath)) {
			throw new Error(`Snapshot source missing required file: ${fullPath}`);
		}
	}
}

export function getSnapshotsDir(configDir: string): string {
	return join(configDir, SNAPSHOTS_DIRNAME);
}

export function getSnapshotDir(configDir: string, snapshotId = DEFAULT_SNAPSHOT_ID): string {
	return join(getSnapshotsDir(configDir), snapshotId);
}

export function getSnapshotConfigDir(configDir: string, snapshotId = DEFAULT_SNAPSHOT_ID): string {
	return join(getSnapshotDir(configDir, snapshotId), "config");
}

export function getSnapshotAnvilStateDir(
	configDir: string,
	snapshotId = DEFAULT_SNAPSHOT_ID,
): string {
	return join(getSnapshotDir(configDir, snapshotId), ANVIL_STATE_DIRNAME);
}

export function getSnapshotVolumesDir(configDir: string, snapshotId = DEFAULT_SNAPSHOT_ID): string {
	return join(getSnapshotDir(configDir, snapshotId), "volumes");
}

export function getSnapshotManifestPath(
	configDir: string,
	snapshotId = DEFAULT_SNAPSHOT_ID,
): string {
	return join(getSnapshotDir(configDir, snapshotId), "manifest.json");
}

export function getAnvilStateDir(configDir: string): string {
	return join(configDir, ANVIL_STATE_DIRNAME);
}

export function hasSnapshot(configDir: string, snapshotId = DEFAULT_SNAPSHOT_ID): boolean {
	return existsSync(getSnapshotManifestPath(configDir, snapshotId));
}

export function loadSnapshotManifest(
	configDir: string,
	snapshotId = DEFAULT_SNAPSHOT_ID,
): SnapshotManifest | null {
	const path = getSnapshotManifestPath(configDir, snapshotId);
	if (!existsSync(path)) {
		return null;
	}
	return JSON.parse(readFileSync(path, "utf-8")) as SnapshotManifest;
}

function assertSnapshotFilesExist(
	snapshotDir: string,
	filenames: readonly string[],
	errorLabel: string,
): void {
	for (const filename of filenames) {
		const fullPath = join(snapshotDir, filename);
		if (!existsSync(fullPath)) {
			throw new Error(`Snapshot missing ${errorLabel}: ${fullPath}`);
		}
	}
}

function assertNonEmptyFile(path: string, message: string): void {
	if (!existsSync(path)) {
		throw new Error(`${message}: ${path}`);
	}
	const stats = statSync(path);
	if (!stats.isFile() || stats.size === 0) {
		throw new Error(`${message}: ${path}`);
	}
}

function assertSnapshotChecksums(snapshotDir: string, checksums: Record<string, string>): void {
	for (const [filename, checksum] of Object.entries(checksums)) {
		const fullPath = join(snapshotDir, "config", filename);
		if (sha256File(fullPath) !== checksum) {
			throw new Error(`Checksum mismatch for snapshot file ${filename}`);
		}
	}
}

export function verifySnapshotManifest(
	configDir: string,
	snapshotId = DEFAULT_SNAPSHOT_ID,
): SnapshotManifest {
	const manifest = loadSnapshotManifest(configDir, snapshotId);
	if (!manifest) {
		throw new Error(`Snapshot manifest not found for ${snapshotId}`);
	}
	if (manifest.version !== SNAPSHOT_VERSION) {
		throw new Error(
			`Unsupported snapshot version ${manifest.version}; expected ${SNAPSHOT_VERSION}`,
		);
	}

	const snapshotDir = getSnapshotDir(configDir, snapshotId);
	assertSnapshotFilesExist(snapshotDir, manifest.requiredFiles, "required file");
	assertNonEmptyFile(
		join(snapshotDir, ANVIL_STATE_DIRNAME, ANVIL_STATE_FILENAME),
		"Snapshot missing non-empty Anvil state file",
	);
	assertSnapshotFilesExist(snapshotDir, manifest.volumeArchives, "volume archive");
	assertSnapshotChecksums(snapshotDir, manifest.configChecksums);

	return manifest;
}

export function buildSnapshotManifest(
	configDir: string,
	composeFile: string,
	snapshotId = DEFAULT_SNAPSHOT_ID,
	metadata: { nitroContractsVersion?: string | undefined } = {},
): SnapshotManifest {
	assertRequiredConfigFiles(configDir);
	assertNonEmptyFile(
		join(getAnvilStateDir(configDir), ANVIL_STATE_FILENAME),
		"Snapshot source missing non-empty Anvil state file",
	);

	const l2Deployment = parseDeploymentFile(configDir, "l2");
	const l3Deployment = parseDeploymentFile(configDir, "l3");
	const configChecksums = Object.fromEntries(
		CRITICAL_CONFIG_FILES.map((filename) => [filename, sha256File(join(configDir, filename))]),
	);

	return {
		version: SNAPSHOT_VERSION,
		snapshotId,
		createdAt: new Date().toISOString(),
		nitroNodeImage: readNitroNodeImage(composeFile),
		chainIds: {
			l1: 1337,
			l2: 412346,
			l3: 333333,
		},
		rollups: {
			l2: l2Deployment.rollup,
			l3: l3Deployment.rollup,
		},
		...(metadata.nitroContractsVersion
			? { nitroContractsVersion: metadata.nitroContractsVersion }
			: {}),
		requiredFiles: [
			...CRITICAL_CONFIG_FILES.map((file) => join("config", file)),
			join(ANVIL_STATE_DIRNAME, ANVIL_STATE_FILENAME),
		],
		configChecksums,
		volumeArchives: SNAPSHOT_VOLUME_ARCHIVES.map(({ archiveName }) => join("volumes", archiveName)),
	};
}

function exportDockerVolume(volumeName: string, archivePath: string): void {
	ensureDirectory(dirname(archivePath));
	const archiveName = basename(archivePath);
	execOrThrow("docker", [
		"run",
		"--rm",
		"-v",
		`${volumeName}:/from`,
		"-v",
		`${dirname(archivePath)}:/to`,
		"alpine",
		"sh",
		"-c",
		`cd /from && tar -cf /to/${archiveName} .`,
	]);
}

function importDockerVolume(volumeName: string, archivePath: string): void {
	const archiveName = basename(archivePath);
	execOrThrow("docker", ["volume", "create", volumeName]);
	execOrThrow("docker", [
		"run",
		"--rm",
		"-v",
		`${volumeName}:/to`,
		"-v",
		`${dirname(archivePath)}:/from`,
		"alpine",
		"sh",
		"-c",
		`cd /to && tar -xf /from/${archiveName}`,
	]);
}

export function captureSnapshot(
	configDir: string,
	composeFile: string,
	snapshotId = DEFAULT_SNAPSHOT_ID,
	metadata: { nitroContractsVersion?: string | undefined } = {},
): SnapshotManifest {
	assertRequiredConfigFiles(configDir);
	const snapshotDir = getSnapshotDir(configDir, snapshotId);
	const snapshotConfigDir = getSnapshotConfigDir(configDir, snapshotId);
	const snapshotAnvilStateDir = getSnapshotAnvilStateDir(configDir, snapshotId);
	const snapshotVolumesDir = getSnapshotVolumesDir(configDir, snapshotId);

	rmSync(snapshotDir, { recursive: true, force: true });
	ensureDirectory(snapshotDir);
	copyDirectoryContents(configDir, snapshotConfigDir);
	copyPath(getAnvilStateDir(configDir), snapshotAnvilStateDir);

	for (const { volumeName, archiveName } of SNAPSHOT_VOLUME_ARCHIVES) {
		exportDockerVolume(volumeName, join(snapshotVolumesDir, archiveName));
	}

	const manifest = buildSnapshotManifest(configDir, composeFile, snapshotId, metadata);
	writeFileSync(
		getSnapshotManifestPath(configDir, snapshotId),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	return manifest;
}

export function restoreSnapshot(
	configDir: string,
	snapshotId = DEFAULT_SNAPSHOT_ID,
): SnapshotManifest {
	const manifest = verifySnapshotManifest(configDir, snapshotId);
	const snapshotConfigDir = getSnapshotConfigDir(configDir, snapshotId);
	const snapshotAnvilStateDir = getSnapshotAnvilStateDir(configDir, snapshotId);

	ensureDirectory(configDir);
	clearDirectoryExcept(configDir, new Set([SNAPSHOTS_DIRNAME]));
	copyDirectoryContents(snapshotConfigDir, configDir);
	copyPath(snapshotAnvilStateDir, getAnvilStateDir(configDir));

	for (const { volumeName, archiveName } of SNAPSHOT_VOLUME_ARCHIVES) {
		execOrThrow("docker", ["volume", "rm", "-f", volumeName]);
		importDockerVolume(volumeName, join(getSnapshotVolumesDir(configDir, snapshotId), archiveName));
	}

	return manifest;
}

export function invalidateSnapshot(configDir: string, snapshotId = DEFAULT_SNAPSHOT_ID): boolean {
	const snapshotDir = getSnapshotDir(configDir, snapshotId);
	if (!existsSync(snapshotDir)) {
		return false;
	}
	rmSync(snapshotDir, { recursive: true, force: true });
	return true;
}

/**
 * Replace a snapshot without losing the previous valid copy when a later step
 * fails. The backup lives beside the snapshot so restoration is a same-filesystem
 * rename.
 */
export async function withSnapshotReplacementRollback<T>(
	configDir: string,
	snapshotId: string,
	operation: () => Promise<T> | T,
): Promise<T> {
	const snapshotsDir = getSnapshotsDir(configDir);
	ensureDirectory(snapshotsDir);
	const snapshotDir = getSnapshotDir(configDir, snapshotId);
	const backupRoot = mkdtempSync(join(snapshotsDir, ".bake-backup-"));
	const backupSnapshotDir = join(backupRoot, "snapshot");
	const hadPreviousSnapshot = existsSync(snapshotDir);

	if (hadPreviousSnapshot) {
		renameSync(snapshotDir, backupSnapshotDir);
	}

	try {
		const result = await operation();
		rmSync(backupRoot, { recursive: true, force: true });
		return result;
	} catch (error) {
		rmSync(snapshotDir, { recursive: true, force: true });
		if (hadPreviousSnapshot) {
			renameSync(backupSnapshotDir, snapshotDir);
		}
		rmSync(backupRoot, { recursive: true, force: true });
		throw error;
	}
}

export function publishSnapshotArtifacts(
	configDir: string,
	snapshotId = DEFAULT_SNAPSHOT_ID,
): void {
	const snapshotConfigDir = getSnapshotConfigDir(configDir, snapshotId);
	copyFileSync(join(snapshotConfigDir, "localNetwork.json"), join(configDir, "localNetwork.json"));
}

async function readAddress(contract: Address, arg: Address, rpcUrl: string): Promise<string> {
	const result = await publicClient(rpcUrl).readContract({
		address: contract,
		abi: gatewayRouterAbi,
		functionName: "getGateway",
		args: [arg],
	});
	return result as string;
}

interface SemanticNetwork {
	nativeToken?: string;
	tokenBridge: {
		parentGatewayRouter: string;
		parentWeth: string;
		parentWethGateway: string;
		childGatewayRouter: string;
		childWethGateway: string;
	};
}

interface WethGatewayCheck {
	label: string;
	contract: string;
	expected: string;
	token: string;
	rpcUrl: string;
}

/**
 * Build the WETH-gateway router checks, gating each chain's checks on whether it
 * uses a custom fee token. The deploy path only registers a WETH gateway for
 * non-custom-fee chains (see `ensureWethGatewayRegistered` in token-bridge.ts,
 * guarded by `nativeTokenAddress === ZERO_ADDRESS`), so custom-fee chains
 * legitimately have no WETH gateway to verify. A network is custom-fee when its
 * `nativeToken` is set to a non-zero address (mirrors `isCustomGas` in
 * init/chain-steps.ts). An absent `nativeToken` means ETH.
 */
export function buildWethGatewayChecks(
	l2Network: SemanticNetwork,
	l3Network: SemanticNetwork,
	rpcUrls: { l1: string; l2: string; l3: string },
): WethGatewayCheck[] {
	const isCustomFee = (network: SemanticNetwork): boolean =>
		!!network.nativeToken && network.nativeToken !== ZERO_ADDRESS;

	const checks: WethGatewayCheck[] = [];

	if (!isCustomFee(l2Network)) {
		checks.push(
			{
				label: "L1->L2 parent WETH gateway",
				contract: l2Network.tokenBridge.parentGatewayRouter,
				expected: l2Network.tokenBridge.parentWethGateway,
				token: l2Network.tokenBridge.parentWeth,
				rpcUrl: rpcUrls.l1,
			},
			{
				label: "L1->L2 child WETH gateway",
				contract: l2Network.tokenBridge.childGatewayRouter,
				expected: l2Network.tokenBridge.childWethGateway,
				token: l2Network.tokenBridge.parentWeth,
				rpcUrl: rpcUrls.l2,
			},
		);
	}

	if (!isCustomFee(l3Network)) {
		checks.push(
			{
				label: "L2->L3 parent WETH gateway",
				contract: l3Network.tokenBridge.parentGatewayRouter,
				expected: l3Network.tokenBridge.parentWethGateway,
				token: l3Network.tokenBridge.parentWeth,
				rpcUrl: rpcUrls.l2,
			},
			{
				label: "L2->L3 child WETH gateway",
				contract: l3Network.tokenBridge.childGatewayRouter,
				expected: l3Network.tokenBridge.childWethGateway,
				token: l3Network.tokenBridge.parentWeth,
				rpcUrl: rpcUrls.l3,
			},
		);
	}

	return checks;
}

export async function verifySnapshotSemanticState(
	configDir: string,
	rpcUrls: {
		l1: string;
		l2: string;
		l3: string;
	},
): Promise<void> {
	const localNetworks = JSON.parse(readFileSync(join(configDir, "localNetwork.json"), "utf-8")) as {
		l2Network?: SemanticNetwork;
		l3Network?: SemanticNetwork;
	};

	const l2Network = localNetworks.l2Network;
	const l3Network = localNetworks.l3Network;
	if (!l2Network || !l3Network) {
		throw new Error("Snapshot semantic verification requires l2Network and l3Network");
	}

	const checks = buildWethGatewayChecks(l2Network, l3Network, rpcUrls);

	for (const check of checks) {
		const actual = await readAddress(
			check.contract as Address,
			check.token as Address,
			check.rpcUrl,
		);
		if (actual.toLowerCase() !== check.expected.toLowerCase()) {
			throw new Error(`${check.label} mismatch: expected ${check.expected}, received ${actual}`);
		}
	}
}
