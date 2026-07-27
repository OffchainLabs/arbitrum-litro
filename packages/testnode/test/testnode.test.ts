import { describe, expect, it } from "vitest";
import {
	buildStartTestnodeState,
	hasVariantSnapshot,
	resolvePublishMatrix,
	resolveVariantSnapshot,
	snapshotIdForContractsVersion,
	testnodeDockerRunArgs,
} from "../src/index.js";

describe("hasVariantSnapshot", () => {
	it("is true for every variant at the default contracts version (v3.2)", () => {
		expect(hasVariantSnapshot("l2", "v3.2")).toBe(true);
		expect(hasVariantSnapshot("l3-eth", "v3.2")).toBe(true);
		expect(hasVariantSnapshot("l3-custom-16", "v3.2")).toBe(true);
		expect(hasVariantSnapshot("l3-custom-18", "v3.2")).toBe(true);
	});

	it("is true only for variants with a declared bundle at v2.1", () => {
		expect(hasVariantSnapshot("l3-custom-18", "v2.1")).toBe(true);
		expect(hasVariantSnapshot("l3-custom-6", "v2.1")).toBe(true);
	});

	it("is false for variants with no bundle at a non-default version", () => {
		expect(hasVariantSnapshot("l2", "v2.1")).toBe(false);
		expect(hasVariantSnapshot("l3-eth", "v2.1")).toBe(false);
		expect(hasVariantSnapshot("l3-custom-16", "v2.1")).toBe(false);
		expect(hasVariantSnapshot("l3-custom-20", "v2.1")).toBe(false);
	});

	it("is false for an unknown variant", () => {
		expect(hasVariantSnapshot("nope", "v3.2")).toBe(false);
	});
});

describe("resolveVariantSnapshot", () => {
	it("returns the base bundle for the default contracts version (v3.2)", () => {
		expect(resolveVariantSnapshot("l3-custom-18", "v3.2")).toEqual({
			snapshotId: "l3-custom-18",
			snapshotReleaseTag: "l3-custom-18",
		});
		expect(resolveVariantSnapshot("l2", "v3.2")).toEqual({
			snapshotId: "l2",
			snapshotReleaseTag: "v0.1.6",
		});
	});

	it("returns the per-version bundle for v2.1 custom-gas variants", () => {
		expect(resolveVariantSnapshot("l3-custom-18", "v2.1")).toEqual({
			snapshotId: "l3-custom-18-v2.1",
			snapshotReleaseTag: "l3-custom-18-v2.1",
		});
		expect(resolveVariantSnapshot("l3-custom-6", "v2.1")).toEqual({
			snapshotId: "l3-custom-6-v2.1",
			snapshotReleaseTag: "l3-custom-6-v2.1",
		});
	});

	it("throws on an unknown variant", () => {
		expect(() => resolveVariantSnapshot("nope", "v3.2")).toThrow(/Unknown variant/);
	});
});

describe("buildStartTestnodeState", () => {
	it("defaults to the local L3 variant and cwd-scoped output dir", () => {
		const state = buildStartTestnodeState({
			cwd: "/workspace/project",
			l3Enabled: true,
			version: "v1.2.3",
		});

		expect(state.variant).toBe("l3-eth");
		expect(state.outputDir).toBe("/workspace/project/.arbitrum-testnode/v1.2.3/l3-eth");
		expect(state.configDir).toBe("/workspace/project/.arbitrum-testnode/v1.2.3/l3-eth/config");
		expect(state.rpcUrls.l1).toBe("http://127.0.0.1:8545");
		expect(state.rpcUrls.l2).toBe("http://127.0.0.1:8547");
		expect(state.rpcUrls.l3).toBe("http://127.0.0.1:3347");
	});

	it("supports the local L2-only variant", () => {
		const state = buildStartTestnodeState({
			cwd: "/workspace/project",
			l3Enabled: false,
			version: "v1.2.3",
		});

		expect(state.variant).toBe("l2");
		expect(state.rpcUrls.l3).toBe("");
		expect(state.paths.l2BridgeUiConfig).toBe("");
		expect(state.paths.l2l3Network).toBe("");
	});

	it("boots a full image-ref without changing variant resolution", () => {
		const state = buildStartTestnodeState({
			cwd: "/workspace/project",
			imageRef: "ghcr.io/acme/testnode:custom",
			l3Enabled: false,
			version: "v1.2.3",
		});

		expect(state.imageRef).toBe("ghcr.io/acme/testnode:custom");
		expect(state.variant).toBe("l2");
		expect(state.rpcUrls.l1).toBe("http://127.0.0.1:8545");
		expect(state.rpcUrls.l2).toBe("http://127.0.0.1:8547");
		expect(state.rpcUrls.l3).toBe("");
		const args = testnodeDockerRunArgs(state);
		expect(args).toEqual(expect.arrayContaining(["TESTNODE_VARIANT=l2"]));
		expect(args).toContain("ghcr.io/acme/testnode:custom");
	});

	it("uses the existing l3-enabled option with an image-ref", () => {
		const state = buildStartTestnodeState({
			cwd: "/workspace/project",
			imageRef: "ghcr.io/acme/testnode:custom-l3",
			l3Enabled: true,
			version: "v1.2.3",
		});

		expect(state.imageRef).toBe("ghcr.io/acme/testnode:custom-l3");
		expect(state.variant).toBe("l3-eth");
		expect(state.rpcUrls.l3).toBe("http://127.0.0.1:3347");
		expect(testnodeDockerRunArgs(state)).toEqual(
			expect.arrayContaining(["TESTNODE_VARIANT=l3-eth"]),
		);
	});

	it("enables Timeboost", () => {
		const state = buildStartTestnodeState({
			containerName: "custom-testnode",
			cwd: "/workspace/project",
			l3Enabled: true,
			timeboostEnabled: true,
			version: "v1.2.3",
		});

		expect(state.variant).toBe("l2-timeboost");
		expect(state.outputDir).toBe("/workspace/project/.arbitrum-testnode/v1.2.3/l2-timeboost");
		expect(state.imageRef).toBe(
			"ghcr.io/offchainlabs/arbitrum-testnode-ci:v1.2.3-nc3.2-l2-timeboost",
		);
		expect(state.rpcUrls.l3).toBe("");
		const args = testnodeDockerRunArgs(state);
		expect(args).toEqual(
			expect.arrayContaining([
				"TESTNODE_TIMEBOOST=true",
				"TESTNODE_TIMEBOOST_REDIS_URL",
				"TESTNODE_TIMEBOOST_AUCTION_CONTRACT_ADDRESS",
			]),
		);
		expect(args).not.toContain("redis://timeboost-redis:6379");
		expect(args).not.toContain("redis:7-alpine");
	});
});

describe("snapshotIdForContractsVersion", () => {
	it("returns the base snapshot id for the default contracts version (v3.2)", () => {
		expect(snapshotIdForContractsVersion("l3-custom-16", "v3.2")).toBe("l3-custom-16");
		expect(snapshotIdForContractsVersion("l2", "v3.2")).toBe("l2");
	});

	it("suffixes the snapshot id for non-default versions (v2.1)", () => {
		expect(snapshotIdForContractsVersion("l3-custom-16", "v2.1")).toBe("l3-custom-16-v2.1");
		expect(snapshotIdForContractsVersion("l3-custom-6", "v2.1")).toBe("l3-custom-6-v2.1");
	});

	it("agrees with the declared snapshotsByContractsVersion overrides", () => {
		expect(snapshotIdForContractsVersion("l3-custom-6", "v2.1")).toBe(
			resolveVariantSnapshot("l3-custom-6", "v2.1").snapshotId,
		);
		expect(snapshotIdForContractsVersion("l3-custom-18", "v2.1")).toBe(
			resolveVariantSnapshot("l3-custom-18", "v2.1").snapshotId,
		);
	});

	it("throws on an unknown variant", () => {
		expect(() => snapshotIdForContractsVersion("nope", "v3.2")).toThrow(/Unknown variant/);
	});
});

describe("resolvePublishMatrix", () => {
	const key = (row: { variant: string; contractsVersion: string }) =>
		`${row.variant}@${row.contractsVersion}`;

	it("emits exactly the 11 expected (variant × version) rows for all/all", () => {
		const rows = resolvePublishMatrix("all", "all");
		expect(new Set(rows.map(key))).toEqual(
			new Set([
				"l2@v3.2",
				"l2-timeboost@v3.2",
				"l3-eth@v3.2",
				"l3-custom-6@v2.1",
				"l3-custom-6@v3.2",
				"l3-custom-16@v2.1",
				"l3-custom-16@v3.2",
				"l3-custom-18@v2.1",
				"l3-custom-18@v3.2",
				"l3-custom-20@v2.1",
				"l3-custom-20@v3.2",
			]),
		);
		expect(rows).toHaveLength(11);
	});

	it("does not emit a v2.1 row for l2, l2-timeboost, or l3-eth", () => {
		const rows = resolvePublishMatrix("all", "all");
		const v21 = new Set(rows.filter((r) => r.contractsVersion === "v2.1").map((r) => r.variant));
		expect(v21.has("l2")).toBe(false);
		expect(v21.has("l2-timeboost")).toBe(false);
		expect(v21.has("l3-eth")).toBe(false);
	});

	it("carries the snapshot id and fee-token decimals for a custom v2.1 row", () => {
		const rows = resolvePublishMatrix("all", "all");
		const row = rows.find((r) => r.variant === "l3-custom-16" && r.contractsVersion === "v2.1");
		expect(row).toMatchObject({
			snapshotId: "l3-custom-16-v2.1",
			feeTokenDecimals: 16,
			timeboostEnabled: false,
		});
	});

	it("marks the timeboost row and sets null fee-token decimals", () => {
		const rows = resolvePublishMatrix("all", "all");
		const row = rows.find((r) => r.variant === "l2-timeboost");
		expect(row).toMatchObject({
			contractsVersion: "v3.2",
			feeTokenDecimals: null,
			timeboostEnabled: true,
		});
	});

	it("returns exactly one row when filtering to a variant and version", () => {
		const rows = resolvePublishMatrix("l3-custom-20", "v2.1");
		expect(rows).toEqual([
			{
				variant: "l3-custom-20",
				contractsVersion: "v2.1",
				snapshotId: "l3-custom-20-v2.1",
				feeTokenDecimals: 20,
				timeboostEnabled: false,
			},
		]);
	});

	it("returns no rows when the version is unsupported for the variant", () => {
		expect(resolvePublishMatrix("l2", "v2.1")).toEqual([]);
	});

	it("throws on an unknown variant filter", () => {
		expect(() => resolvePublishMatrix("nope", "all")).toThrow(/Unknown variant/);
	});
});
