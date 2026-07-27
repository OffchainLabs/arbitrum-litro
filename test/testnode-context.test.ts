import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "arbitrum-testnode-context-"));
	tempDirs.push(dir);
	return dir;
}

function writeTarFixture(sourceDir: string, archivePath: string, marker: string): void {
	mkdirSync(sourceDir, { recursive: true });
	writeFileSync(join(sourceDir, marker), marker);
	execFileSync("tar", ["-cf", archivePath, "-C", sourceDir, "."]);
}

function runPrepare(args: string[]): void {
	execFileSync("node", [resolve("scripts/ci/prepare-testnode-context.mjs"), ...args], {
		cwd: resolve("."),
		stdio: "pipe",
	});
}

function createSnapshotFixture(rootDir: string, snapshotId = "default"): string {
	const snapshotDir = join(rootDir, "snapshots", snapshotId);
	const configDir = join(snapshotDir, "config");
	const volumeDir = join(snapshotDir, "volumes");

	mkdirSync(join(configDir, "l1-l2-admin"), { recursive: true });
	mkdirSync(join(configDir, "l2-l3-admin"), { recursive: true });
	writeFileSync(
		join(configDir, "l2-nodeConfig.json"),
		'{"parent-chain":{"connection":{"url":"http://host.docker.internal:8545"}}}\n',
	);
	writeFileSync(
		join(configDir, "l3-nodeConfig.json"),
		'{"parent-chain":{"connection":{"url":"http://sequencer:8547"}}}\n',
	);
	writeFileSync(
		join(configDir, "l1-l2-admin", "bridgeUiConfig.json"),
		'{"parentChainRpc":"http://127.0.0.1:8545","chainRpc":"http://127.0.0.1:8547"}\n',
	);
	writeFileSync(
		join(configDir, "l2-l3-admin", "bridgeUiConfig.json"),
		'{"parentChainRpc":"http://127.0.0.1:8547","chainRpc":"http://127.0.0.1:8549"}\n',
	);
	writeFileSync(join(configDir, "localNetwork.json"), "{}\n");
	writeFileSync(join(configDir, "l1l2_network.json"), "{}\n");
	writeFileSync(join(configDir, "l2l3_network.json"), "{}\n");
	writeFileSync(join(configDir, "custom-artifact.bin"), Buffer.from([0, 255, 1, 254]));
	mkdirSync(join(snapshotDir, "anvil-state"), { recursive: true });
	writeFileSync(join(snapshotDir, "anvil-state", "state.json"), "{}");
	mkdirSync(volumeDir, { recursive: true });
	writeTarFixture(
		join(rootDir, "sequencer-data"),
		join(volumeDir, "sequencer-data.tar"),
		"seq.txt",
	);
	writeTarFixture(
		join(rootDir, "validator-data"),
		join(volumeDir, "validator-data.tar"),
		"val.txt",
	);
	writeTarFixture(join(rootDir, "l3node-data"), join(volumeDir, "l3node-data.tar"), "l3.txt");
	writeFileSync(
		join(snapshotDir, "manifest.json"),
		`${JSON.stringify({
			version: 1,
			snapshotId,
			createdAt: "2026-01-01T00:00:00.000Z",
			nitroNodeImage: "offchainlabs/nitro-node:test",
			chainIds: { l1: 1337, l2: 412346, l3: 333333 },
			rollups: { l2: "0x0", l3: "0x0" },
			requiredFiles: [],
			configChecksums: {},
			volumeArchives: [
				"volumes/sequencer-data.tar",
				"volumes/validator-data.tar",
				"volumes/l3node-data.tar",
			],
		})}\n`,
	);

	return snapshotDir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			rmSync(dir, { force: true, recursive: true });
		}
	}
});

describe("prepare-testnode-context", () => {
	it("rewrites runtime and export config URLs and extracts volume archives", () => {
		const rootDir = createTempDir();
		const snapshotDir = createSnapshotFixture(rootDir);
		const outputDir = join(rootDir, "context");

		runPrepare(["--variant", "l3-eth", "--snapshot-dir", snapshotDir, "--output-dir", outputDir]);

		expect(
			readFileSync(join(outputDir, "runtime-config", "l2-nodeConfig.json"), "utf-8"),
		).toContain("http://127.0.0.1:8545");
		expect(
			readFileSync(join(outputDir, "export-config", "l2-l3-admin", "bridgeUiConfig.json"), "utf-8"),
		).toContain("http://127.0.0.1:3347");
		expect(existsSync(join(outputDir, "runtime", "sequencer", ".arbitrum", "seq.txt"))).toBe(true);
		expect(existsSync(join(outputDir, "runtime", "validator", ".arbitrum", "val.txt"))).toBe(true);
		expect(existsSync(join(outputDir, "runtime", "l3node", ".arbitrum", "l3.txt"))).toBe(true);
		expect(readFileSync(join(outputDir, "runtime-config", "custom-artifact.bin"))).toEqual(
			Buffer.from([0, 255, 1, 254]),
		);

		const metadata = JSON.parse(readFileSync(join(outputDir, "metadata.json"), "utf-8"));
		expect(metadata).toEqual({
			l3Enabled: true,
			nitroContractsVersion: "",
			snapshotId: "default",
			testnodeName: "",
			variant: "l3-eth",
		});
	});

	it("resolves a version-specific snapshot id from the variant + contracts version", () => {
		const rootDir = createTempDir();
		const snapshotDir = createSnapshotFixture(rootDir, "l3-custom-18-v2.1");
		const outputDir = join(rootDir, "context");

		runPrepare([
			"--variant",
			"l3-custom-18",
			"--nitro-contracts-version",
			"v2.1",
			"--snapshot-dir",
			snapshotDir,
			"--output-dir",
			outputDir,
		]);

		const metadata = JSON.parse(readFileSync(join(outputDir, "metadata.json"), "utf-8"));
		expect(metadata.snapshotId).toBe("l3-custom-18-v2.1");
		expect(metadata.nitroContractsVersion).toBe("v2.1");
	});

	it("fails when the snapshot Anvil state file is missing", () => {
		const rootDir = createTempDir();
		const snapshotDir = createSnapshotFixture(rootDir);
		const outputDir = join(rootDir, "context");
		rmSync(join(snapshotDir, "anvil-state", "state.json"), { force: true });

		let stderr = "";
		try {
			runPrepare(["--variant", "l3-eth", "--snapshot-dir", snapshotDir, "--output-dir", outputDir]);
		} catch (error) {
			stderr = String((error as { stderr?: Buffer }).stderr ?? "");
		}

		expect(stderr).toContain("Snapshot missing non-empty Anvil state file");
		expect(existsSync(outputDir)).toBe(false);
	});

	it("echoes the testnode name into metadata when provided", () => {
		const rootDir = createTempDir();
		const snapshotDir = createSnapshotFixture(rootDir);
		const outputDir = join(rootDir, "context");

		runPrepare([
			"--variant",
			"l3-eth",
			"--snapshot-dir",
			snapshotDir,
			"--output-dir",
			outputDir,
			"--testnode-name",
			"fast",
		]);

		const metadata = JSON.parse(readFileSync(join(outputDir, "metadata.json"), "utf-8"));
		expect(metadata.testnodeName).toBe("fast");
	});
});
