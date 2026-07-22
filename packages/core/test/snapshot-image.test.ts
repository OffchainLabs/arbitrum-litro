import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareTestnodeContext, snapshotHasL3 } from "../src/snapshot-image.js";

/**
 * Lay out a minimal snapshot tree under `<configDir>/snapshots/<id>` with the
 * files `prepareTestnodeContext` consumes: a `config` dir, an `anvil-state` dir,
 * and the volume tar archives. `withL3` controls whether the l3node archive is
 * present (the default discriminator for `l3Enabled`).
 */
function writeFixtureSnapshot(configDir: string, snapshotId: string, withL3: boolean): void {
	const snapshotDir = path.join(configDir, "snapshots", snapshotId);
	const snapshotConfigDir = path.join(snapshotDir, "config");
	const volumesDir = path.join(snapshotDir, "volumes");
	fs.mkdirSync(snapshotConfigDir, { recursive: true });
	fs.mkdirSync(path.join(snapshotDir, "anvil-state"), { recursive: true });
	fs.mkdirSync(volumesDir, { recursive: true });

	// A node-config with docker-internal URLs + a /config/ path to assert rewrites.
	fs.writeFileSync(
		path.join(snapshotConfigDir, "l2-nodeConfig.json"),
		JSON.stringify({
			parent: "http://host.docker.internal:8545",
			sequencer: "http://sequencer:8547",
			l3: "http://127.0.0.1:8549",
			chainInfo: "/config/l2_chain_info.json",
		}),
	);
	fs.writeFileSync(path.join(snapshotDir, "anvil-state", "state.json"), "{}");

	const makeArchive = (name: string) => {
		const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "vol-"));
		fs.writeFileSync(path.join(stageDir, "marker"), name);
		execFileSync("tar", ["-cf", path.join(volumesDir, name), "-C", stageDir, "."]);
	};
	makeArchive("sequencer-data.tar");
	makeArchive("validator-data.tar");
	if (withL3) {
		makeArchive("l3node-data.tar");
	}
}

describe("prepareTestnodeContext", () => {
	let configDir: string;
	let outputDir: string;

	beforeEach(() => {
		configDir = fs.mkdtempSync(path.join(os.tmpdir(), "bake-config-"));
		outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "bake-context-"));
	});

	afterEach(() => {
		fs.rmSync(configDir, { force: true, recursive: true });
		fs.rmSync(outputDir, { force: true, recursive: true });
	});

	it("lays out the docker context and rewrites docker-internal URLs to host URLs", () => {
		writeFixtureSnapshot(configDir, "custom", true);

		const result = prepareTestnodeContext({
			configDir,
			snapshotId: "custom",
			outputDir,
			testnodeName: "acme-governance",
		});

		expect(result.l3Enabled).toBe(true);

		const runtimeConfig = JSON.parse(
			fs.readFileSync(path.join(outputDir, "runtime-config", "l2-nodeConfig.json"), "utf-8"),
		) as Record<string, string>;
		expect(runtimeConfig.parent).toBe("http://127.0.0.1:8545");
		expect(runtimeConfig.sequencer).toBe("http://127.0.0.1:8547");
		expect(runtimeConfig.chainInfo).toBe(
			"/opt/arbitrum-testnode/runtime-config/l2_chain_info.json",
		);

		const exportConfig = JSON.parse(
			fs.readFileSync(path.join(outputDir, "export-config", "l2-nodeConfig.json"), "utf-8"),
		) as Record<string, string>;
		// The export config maps the L3 host port to 3347.
		expect(exportConfig.l3).toBe("http://127.0.0.1:3347");

		// Volume archives are extracted into the runtime tree.
		expect(fs.existsSync(path.join(outputDir, "runtime", "sequencer", ".arbitrum", "marker"))).toBe(
			true,
		);
		expect(fs.existsSync(path.join(outputDir, "runtime", "validator", ".arbitrum", "marker"))).toBe(
			true,
		);
		expect(fs.existsSync(path.join(outputDir, "runtime", "l3node", ".arbitrum", "marker"))).toBe(
			true,
		);
		expect(fs.existsSync(path.join(outputDir, "runtime", "anvil-state", "state.json"))).toBe(true);

		const metadata = JSON.parse(
			fs.readFileSync(path.join(outputDir, "metadata.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(metadata).toMatchObject({
			l3Enabled: true,
			snapshotId: "custom",
			testnodeName: "acme-governance",
		});
	});

	it("derives l3Enabled=false and skips the l3node archive when absent", () => {
		writeFixtureSnapshot(configDir, "l2only", false);
		expect(snapshotHasL3(configDir, "l2only")).toBe(false);

		const result = prepareTestnodeContext({ configDir, snapshotId: "l2only", outputDir });

		expect(result.l3Enabled).toBe(false);
		expect(fs.existsSync(path.join(outputDir, "runtime", "l3node"))).toBe(false);
		const metadata = JSON.parse(
			fs.readFileSync(path.join(outputDir, "metadata.json"), "utf-8"),
		) as { l3Enabled: boolean };
		expect(metadata.l3Enabled).toBe(false);
	});

	it("honors an explicit l3Enabled override", () => {
		writeFixtureSnapshot(configDir, "custom", true);
		const result = prepareTestnodeContext({
			configDir,
			snapshotId: "custom",
			outputDir,
			l3Enabled: false,
		});
		expect(result.l3Enabled).toBe(false);
		expect(fs.existsSync(path.join(outputDir, "runtime", "l3node"))).toBe(false);
	});

	it("throws when the snapshot directory is missing", () => {
		expect(() => prepareTestnodeContext({ configDir, snapshotId: "nope", outputDir })).toThrow(
			/Snapshot directory not found/,
		);
	});
});
