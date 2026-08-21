import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	installSnapshotArchive,
	installSnapshotRelease,
	packageSnapshotRelease,
} from "../src/snapshot-release.js";
import {
	ANVIL_STATE_DIRNAME,
	DEFAULT_SNAPSHOT_ID,
	buildSnapshotManifest,
	getSnapshotConfigDir,
	getSnapshotDir,
	getSnapshotManifestPath,
	getSnapshotVolumesDir,
} from "../src/snapshot.js";

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

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "arbitrum-testnode-release-"));
	tempDirs.push(dir);
	return dir;
}

function writeFixtureTree(configDir: string): void {
	for (const filename of CRITICAL_CONFIG_FILES) {
		const fullPath = join(configDir, filename);
		mkdirSync(join(fullPath, ".."), { recursive: true });
		if (filename === "l2_deployment.json" || filename === "l3_deployment.json") {
			writeFileSync(fullPath, JSON.stringify({ rollup: `0x${filename}` }, null, 2));
			continue;
		}
		writeFileSync(fullPath, filename);
	}
	mkdirSync(join(configDir, ANVIL_STATE_DIRNAME), { recursive: true });
	writeFileSync(join(configDir, ANVIL_STATE_DIRNAME, "state.json"), "{}");
}

function createSnapshotFixture(
	rootDir: string,
	nitroImage = "offchainlabs/nitro-node:v3.9.5-test",
): {
	composeFile: string;
	configDir: string;
} {
	const configDir = join(rootDir, "config");
	writeFixtureTree(configDir);

	const composeFile = join(rootDir, "docker-compose.yaml");
	writeFileSync(composeFile, `services:\n  sequencer:\n    image: ${nitroImage}\n`);

	const manifest = buildSnapshotManifest(configDir, composeFile);
	const snapshotConfigDir = getSnapshotConfigDir(configDir, DEFAULT_SNAPSHOT_ID);
	for (const filename of CRITICAL_CONFIG_FILES) {
		const fullPath = join(snapshotConfigDir, filename);
		mkdirSync(join(fullPath, ".."), { recursive: true });
		writeFileSync(fullPath, readFileSync(join(configDir, filename), "utf-8"));
	}

	const snapshotAnvilDir = join(configDir, "snapshots", DEFAULT_SNAPSHOT_ID, ANVIL_STATE_DIRNAME);
	mkdirSync(snapshotAnvilDir, { recursive: true });
	writeFileSync(join(snapshotAnvilDir, "state.json"), "{}");

	const snapshotVolumesDir = getSnapshotVolumesDir(configDir, DEFAULT_SNAPSHOT_ID);
	for (const archiveName of ["sequencer-data.tar", "validator-data.tar", "l3node-data.tar"]) {
		mkdirSync(snapshotVolumesDir, { recursive: true });
		writeFileSync(join(snapshotVolumesDir, archiveName), archiveName);
	}

	writeFileSync(getSnapshotManifestPath(configDir), JSON.stringify(manifest, null, 2));
	return { composeFile, configDir };
}

afterEach(() => {
	vi.restoreAllMocks();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("packageSnapshotRelease", () => {
	it("creates a tagged snapshot archive and checksum file", () => {
		const rootDir = createTempDir();
		const { configDir } = createSnapshotFixture(rootDir);
		const outDir = join(rootDir, "out");

		const result = packageSnapshotRelease(configDir, { outDir, tag: "v1.2.3" });

		expect(result.archiveName).toBe("arbitrum-testnode-snapshot-v1.2.3.tgz");
		expect(result.checksumName).toBe("arbitrum-testnode-snapshot-v1.2.3.sha256");
		expect(existsSync(result.archivePath)).toBe(true);
		expect(readFileSync(result.checksumPath, "utf-8")).toBe(
			`${result.checksum}  ${result.archiveName}\n`,
		);
	});
});

describe("installSnapshotArchive", () => {
	it("extracts a packaged snapshot into the target config directory", () => {
		const sourceRoot = createTempDir();
		const { configDir: sourceConfigDir } = createSnapshotFixture(sourceRoot);
		const packageDir = join(sourceRoot, "out");
		const releaseAsset = packageSnapshotRelease(sourceConfigDir, {
			outDir: packageDir,
			tag: "v1.0.0",
		});

		const targetRoot = createTempDir();
		const targetConfigDir = join(targetRoot, "config");
		mkdirSync(targetConfigDir, { recursive: true });
		const targetComposeFile = join(targetRoot, "docker-compose.yaml");
		writeFileSync(
			targetComposeFile,
			"services:\n  sequencer:\n    image: offchainlabs/nitro-node:v3.9.5-test\n",
		);

		const manifest = installSnapshotArchive(
			targetConfigDir,
			targetComposeFile,
			releaseAsset.archivePath,
		);

		expect(manifest.rollups.l2).toBe("0xl2_deployment.json");
		expect(existsSync(getSnapshotDir(targetConfigDir, DEFAULT_SNAPSHOT_ID))).toBe(true);
		expect(existsSync(getSnapshotManifestPath(targetConfigDir, DEFAULT_SNAPSHOT_ID))).toBe(true);
	});

	it("removes the extracted snapshot when the compose Nitro image is incompatible", () => {
		const sourceRoot = createTempDir();
		const { configDir: sourceConfigDir } = createSnapshotFixture(sourceRoot);
		const releaseAsset = packageSnapshotRelease(sourceConfigDir, {
			outDir: join(sourceRoot, "out"),
			tag: "v1.0.0",
		});

		const targetRoot = createTempDir();
		const targetConfigDir = join(targetRoot, "config");
		mkdirSync(targetConfigDir, { recursive: true });
		const targetComposeFile = join(targetRoot, "docker-compose.yaml");
		writeFileSync(
			targetComposeFile,
			"services:\n  sequencer:\n    image: offchainlabs/nitro-node:v9.9.9-test\n",
		);

		expect(() =>
			installSnapshotArchive(targetConfigDir, targetComposeFile, releaseAsset.archivePath),
		).toThrow("Snapshot Nitro image");
		expect(existsSync(getSnapshotDir(targetConfigDir, DEFAULT_SNAPSHOT_ID))).toBe(false);
	});
});

describe("installSnapshotRelease", () => {
	let fetchSpy: MockInstance<typeof globalThis.fetch>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	it("downloads the latest GitHub release snapshot, verifies it, and installs it", async () => {
		const sourceRoot = createTempDir();
		const { configDir: sourceConfigDir } = createSnapshotFixture(sourceRoot);
		const releaseAsset = packageSnapshotRelease(sourceConfigDir, {
			outDir: join(sourceRoot, "out"),
			tag: "v2.0.0",
		});
		const archiveBuffer = readFileSync(releaseAsset.archivePath);
		const checksumContents = readFileSync(releaseAsset.checksumPath, "utf-8");

		fetchSpy.mockImplementation(async (input, init) => {
			const url = String(input);
			if (url === "https://api.github.com/repos/acme/testnode/releases/latest") {
				expect(init?.headers).toMatchObject({
					Accept: "application/vnd.github+json",
					Authorization: "Bearer secret-token",
				});
				return new Response(
					JSON.stringify({
						tag_name: "v2.0.0",
						assets: [
							{
								name: releaseAsset.archiveName,
								url: "https://api.github.com/assets/snapshot",
							},
							{
								name: releaseAsset.checksumName,
								url: "https://api.github.com/assets/checksum",
							},
						],
					}),
					{ status: 200 },
				);
			}
			if (url === "https://api.github.com/assets/snapshot") {
				expect(init?.headers).toMatchObject({
					Accept: "application/octet-stream",
					Authorization: "Bearer secret-token",
				});
				return new Response(archiveBuffer, { status: 200 });
			}
			if (url === "https://api.github.com/assets/checksum") {
				return new Response(checksumContents, { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});

		const targetRoot = createTempDir();
		const targetConfigDir = join(targetRoot, "config");
		mkdirSync(targetConfigDir, { recursive: true });
		const targetComposeFile = join(targetRoot, "docker-compose.yaml");
		writeFileSync(
			targetComposeFile,
			"services:\n  sequencer:\n    image: offchainlabs/nitro-node:v3.9.5-test\n",
		);

		const result = await installSnapshotRelease({
			composeFile: targetComposeFile,
			configDir: targetConfigDir,
			repo: "acme/testnode",
			token: "secret-token",
		});

		expect(result.releaseTag).toBe("v2.0.0");
		expect(result.sourceRepo).toBe("acme/testnode");
		expect(result.archiveName).toBe(releaseAsset.archiveName);
		expect(existsSync(getSnapshotManifestPath(targetConfigDir, DEFAULT_SNAPSHOT_ID))).toBe(true);
	});
});
