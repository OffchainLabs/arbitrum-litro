import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ANVIL_STATE_DIRNAME,
	ANVIL_STATE_FILENAME,
	DEFAULT_SNAPSHOT_ID,
	buildSnapshotManifest,
	buildWethGatewayChecks,
	getSnapshotConfigDir,
	getSnapshotDir,
	getSnapshotManifestPath,
	getSnapshotVolumesDir,
	invalidateSnapshot,
	verifySnapshotManifest,
	withSnapshotReplacementRollback,
} from "../src/snapshot.js";

const ZERO = "0x0000000000000000000000000000000000000000";

function makeNetwork(nativeToken?: string) {
	return {
		...(nativeToken !== undefined ? { nativeToken } : {}),
		tokenBridge: {
			parentGatewayRouter: "0xa111111111111111111111111111111111111111",
			parentWeth: "0xa555555555555555555555555555555555555555",
			parentWethGateway: "0xa444444444444444444444444444444444444444",
			childGatewayRouter: "0xb111111111111111111111111111111111111111",
			childWethGateway: "0xb444444444444444444444444444444444444444",
		},
	};
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

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "arbitrum-testnode-snapshot-"));
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

function copyConfigFixtureToSnapshot(configDir: string): void {
	const snapshotConfigDir = getSnapshotConfigDir(configDir, DEFAULT_SNAPSHOT_ID);
	for (const filename of CRITICAL_CONFIG_FILES) {
		const fullPath = join(snapshotConfigDir, filename);
		mkdirSync(join(fullPath, ".."), { recursive: true });
		writeFileSync(fullPath, readFileSync(join(configDir, filename), "utf-8"));
	}
}

function writeSnapshotAnvilState(configDir: string, content = "{}"): void {
	const snapshotAnvilDir = join(configDir, "snapshots", DEFAULT_SNAPSHOT_ID, ANVIL_STATE_DIRNAME);
	mkdirSync(snapshotAnvilDir, { recursive: true });
	writeFileSync(join(snapshotAnvilDir, ANVIL_STATE_FILENAME), content);
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("snapshot manifest", () => {
	it("builds and verifies a manifest for a complete snapshot tree", () => {
		const configDir = createTempDir();
		writeFixtureTree(configDir);

		const composeFile = join(configDir, "docker-compose.yaml");
		writeFileSync(
			composeFile,
			"services:\n  sequencer:\n    image: offchainlabs/nitro-node:v3.9.5-test\n",
		);

		const manifest = buildSnapshotManifest(configDir, composeFile);
		const snapshotVolumesDir = getSnapshotVolumesDir(configDir, DEFAULT_SNAPSHOT_ID);

		copyConfigFixtureToSnapshot(configDir);
		writeSnapshotAnvilState(configDir);
		for (const archiveName of ["sequencer-data.tar", "validator-data.tar", "l3node-data.tar"]) {
			mkdirSync(snapshotVolumesDir, { recursive: true });
			writeFileSync(join(snapshotVolumesDir, archiveName), archiveName);
		}
		writeFileSync(getSnapshotManifestPath(configDir), JSON.stringify(manifest, null, 2));

		const verified = verifySnapshotManifest(configDir);
		expect(verified.nitroNodeImage).toBe("offchainlabs/nitro-node:v3.9.5-test");
		expect(verified.requiredFiles).toContain(join(ANVIL_STATE_DIRNAME, ANVIL_STATE_FILENAME));
		expect(verified.rollups.l2).toBe("0xl2_deployment.json");
		expect(verified.rollups.l3).toBe("0xl3_deployment.json");
	});

	it("fails verification if a config checksum does not match", () => {
		const configDir = createTempDir();
		writeFixtureTree(configDir);

		const composeFile = join(configDir, "docker-compose.yaml");
		writeFileSync(
			composeFile,
			"services:\n  sequencer:\n    image: offchainlabs/nitro-node:v3.9.5-test\n",
		);

		const manifest = buildSnapshotManifest(configDir, composeFile);
		const snapshotConfigDir = getSnapshotConfigDir(configDir, DEFAULT_SNAPSHOT_ID);
		const snapshotVolumesDir = getSnapshotVolumesDir(configDir, DEFAULT_SNAPSHOT_ID);

		copyConfigFixtureToSnapshot(configDir);
		writeFileSync(join(snapshotConfigDir, "localNetwork.json"), "tampered");
		writeSnapshotAnvilState(configDir);
		for (const archiveName of ["sequencer-data.tar", "validator-data.tar", "l3node-data.tar"]) {
			mkdirSync(snapshotVolumesDir, { recursive: true });
			writeFileSync(join(snapshotVolumesDir, archiveName), archiveName);
		}
		writeFileSync(getSnapshotManifestPath(configDir), JSON.stringify(manifest, null, 2));

		expect(() => verifySnapshotManifest(configDir)).toThrow(
			"Checksum mismatch for snapshot file localNetwork.json",
		);
	});

	it("fails verification if the Anvil state file is empty", () => {
		const configDir = createTempDir();
		writeFixtureTree(configDir);

		const composeFile = join(configDir, "docker-compose.yaml");
		writeFileSync(
			composeFile,
			"services:\n  sequencer:\n    image: offchainlabs/nitro-node:v3.9.5-test\n",
		);

		const manifest = buildSnapshotManifest(configDir, composeFile);
		const snapshotVolumesDir = getSnapshotVolumesDir(configDir, DEFAULT_SNAPSHOT_ID);

		copyConfigFixtureToSnapshot(configDir);
		writeSnapshotAnvilState(configDir, "");
		for (const archiveName of ["sequencer-data.tar", "validator-data.tar", "l3node-data.tar"]) {
			mkdirSync(snapshotVolumesDir, { recursive: true });
			writeFileSync(join(snapshotVolumesDir, archiveName), archiveName);
		}
		writeFileSync(getSnapshotManifestPath(configDir), JSON.stringify(manifest, null, 2));

		expect(() => verifySnapshotManifest(configDir)).toThrow(
			"Snapshot missing non-empty Anvil state file",
		);
	});

	it("includes WETH gateway checks for ETH (non-custom-fee) chains", () => {
		const checks = buildWethGatewayChecks(makeNetwork(ZERO), makeNetwork(ZERO), {
			l1: "l1",
			l2: "l2",
			l3: "l3",
		});
		const labels = checks.map((c) => c.label);
		expect(labels).toContain("L1->L2 parent WETH gateway");
		expect(labels).toContain("L1->L2 child WETH gateway");
		expect(labels).toContain("L2->L3 parent WETH gateway");
		expect(labels).toContain("L2->L3 child WETH gateway");
	});

	it("treats an absent nativeToken as ETH and includes WETH gateway checks", () => {
		const checks = buildWethGatewayChecks(makeNetwork(), makeNetwork(), {
			l1: "l1",
			l2: "l2",
			l3: "l3",
		});
		expect(checks).toHaveLength(4);
	});

	it("excludes L2->L3 WETH gateway checks for a custom-fee L3 chain", () => {
		const checks = buildWethGatewayChecks(
			makeNetwork(ZERO),
			makeNetwork("0x1234567890123456789012345678901234567890"),
			{ l1: "l1", l2: "l2", l3: "l3" },
		);
		const labels = checks.map((c) => c.label);
		expect(labels).toContain("L1->L2 parent WETH gateway");
		expect(labels).toContain("L1->L2 child WETH gateway");
		expect(labels).not.toContain("L2->L3 parent WETH gateway");
		expect(labels).not.toContain("L2->L3 child WETH gateway");
	});

	it("excludes L1->L2 WETH gateway checks for a custom-fee L2 chain", () => {
		const checks = buildWethGatewayChecks(
			makeNetwork("0x1234567890123456789012345678901234567890"),
			makeNetwork(ZERO),
			{ l1: "l1", l2: "l2", l3: "l3" },
		);
		const labels = checks.map((c) => c.label);
		expect(labels).not.toContain("L1->L2 parent WETH gateway");
		expect(labels).not.toContain("L1->L2 child WETH gateway");
		expect(labels).toContain("L2->L3 parent WETH gateway");
		expect(labels).toContain("L2->L3 child WETH gateway");
	});

	it("invalidates a snapshot directory", () => {
		const configDir = createTempDir();
		const snapshotConfigDir = getSnapshotConfigDir(configDir, DEFAULT_SNAPSHOT_ID);
		mkdirSync(snapshotConfigDir, { recursive: true });
		writeFileSync(join(snapshotConfigDir, "state.json"), "{}");

		expect(invalidateSnapshot(configDir)).toBe(true);
		expect(invalidateSnapshot(configDir)).toBe(false);
	});

	it("commits a successful snapshot replacement", async () => {
		const configDir = createTempDir();
		const snapshotDir = getSnapshotDir(configDir, "custom");
		mkdirSync(snapshotDir, { recursive: true });
		writeFileSync(join(snapshotDir, "marker"), "old");

		const result = await withSnapshotReplacementRollback(configDir, "custom", () => {
			mkdirSync(snapshotDir, { recursive: true });
			writeFileSync(join(snapshotDir, "marker"), "new");
			return "built";
		});

		expect(result).toBe("built");
		expect(readFileSync(join(snapshotDir, "marker"), "utf-8")).toBe("new");
	});

	it("restores the previous snapshot when replacement fails", async () => {
		const configDir = createTempDir();
		const snapshotDir = getSnapshotDir(configDir, "custom");
		mkdirSync(snapshotDir, { recursive: true });
		writeFileSync(join(snapshotDir, "marker"), "old");

		await expect(
			withSnapshotReplacementRollback(configDir, "custom", () => {
				mkdirSync(snapshotDir, { recursive: true });
				writeFileSync(join(snapshotDir, "marker"), "partial");
				throw new Error("docker push failed");
			}),
		).rejects.toThrow("docker push failed");

		expect(readFileSync(join(snapshotDir, "marker"), "utf-8")).toBe("old");
	});

	it("removes a partial first snapshot when replacement fails", async () => {
		const configDir = createTempDir();
		const snapshotDir = getSnapshotDir(configDir, "custom");

		await expect(
			withSnapshotReplacementRollback(configDir, "custom", () => {
				mkdirSync(snapshotDir, { recursive: true });
				writeFileSync(join(snapshotDir, "marker"), "partial");
				throw new Error("capture failed");
			}),
		).rejects.toThrow("capture failed");

		expect(existsSync(snapshotDir)).toBe(false);
	});
});
