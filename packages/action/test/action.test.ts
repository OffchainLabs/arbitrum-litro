import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_NITRO_CONTRACTS_VERSION,
	DEFAULT_TESTNODE_IMAGE_REPOSITORY,
	buildActionTestnodeState,
	buildTestnodeImageRef,
	normalizeNitroContractsVersion,
	resolveVariant,
	testnodeDockerRunArgs,
} from "../src/lib.mjs";

describe("action metadata", () => {
	const action = readFileSync("action.yml", "utf-8");
	const inputs = action.slice(action.indexOf("inputs:"), action.indexOf("outputs:"));

	it("makes version optional and resolves registry behavior from the effective image ref", () => {
		expect(action).toContain(
			'description: "Pinned release version; required unless image-ref is set"',
		);
		expect(action).toContain("startsWith(steps.resolve.outputs.image-ref, 'ghcr.io/')");
		expect(action).toContain("!startsWith(steps.resolve.outputs.image-ref, 'local/')");
	});

	it("does not expose a second variant-selection input", () => {
		expect(inputs).not.toMatch(/^ {2}variant:\s*$/m);
		expect(action).not.toContain("INPUT_VARIANT");
	});
});

describe("resolveVariant", () => {
	it("uses l2 when l3 is disabled", () => {
		expect(resolveVariant({ l3Enabled: "false" })).toBe("l2");
	});

	it("uses l3-eth when l3 is enabled without a fee token", () => {
		expect(resolveVariant({ l3Enabled: "true" })).toBe("l3-eth");
	});

	it("uses the L2 timeboost variant when timeboost is enabled", () => {
		expect(resolveVariant({ l3Enabled: "true", timeboostEnabled: "true" })).toBe("l2-timeboost");
	});

	it("uses the custom gas token variants when decimals are provided", () => {
		expect(resolveVariant({ feeTokenDecimals: "16", l3Enabled: "true" })).toBe("l3-custom-16");
		expect(resolveVariant({ feeTokenDecimals: "18", l3Enabled: "true" })).toBe("l3-custom-18");
		expect(resolveVariant({ feeTokenDecimals: "20", l3Enabled: "true" })).toBe("l3-custom-20");
	});

	it("rejects custom fee token decimals when l3 is disabled", () => {
		expect(() => resolveVariant({ feeTokenDecimals: "18", l3Enabled: "false" })).toThrow(
			"fee-token-decimals requires L3 to be enabled",
		);
	});

	it("rejects custom fee token decimals when timeboost is enabled", () => {
		expect(() =>
			resolveVariant({ feeTokenDecimals: "18", l3Enabled: "true", timeboostEnabled: "true" }),
		).toThrow("fee-token-decimals is not supported with timeboost-enabled");
	});
});

describe("buildTestnodeImageRef", () => {
	it("uses the default repository when none is provided", () => {
		expect(
			buildTestnodeImageRef({ contractsVersion: "v3.2", variant: "l3-eth", version: "v1.2.3" }),
		).toBe(`${DEFAULT_TESTNODE_IMAGE_REPOSITORY}:v1.2.3-nc3.2-l3-eth`);
	});
});

describe("buildActionTestnodeState", () => {
	it("builds stable paths and RPC URLs for l3 variants", () => {
		const state = buildActionTestnodeState({
			contractsVersion: "v3.2",
			l3Enabled: "true",
			runnerTemp: "/tmp/runner",
			version: "v1.2.3",
		});

		expect(state.variant).toBe("l3-eth");
		expect(state.contractsVersion).toBe("v3.2");
		expect(state.imageRef).toContain("nc3.2");
		expect(state.timeboostEnabled).toBe(false);
		expect(state.outputDir).toBe("/tmp/runner/arbitrum-testnode/v1.2.3/l3-eth");
		expect(state.paths.localNetwork).toBe(
			"/tmp/runner/arbitrum-testnode/v1.2.3/l3-eth/config/localNetwork.json",
		);
		expect(state.rpcUrls.l1).toBe("http://127.0.0.1:8545");
		expect(state.rpcUrls.l2).toBe("http://127.0.0.1:8547");
		expect(state.rpcUrls.l3).toBe("http://127.0.0.1:3347");
	});

	it("omits l3-specific outputs for l2", () => {
		const state = buildActionTestnodeState({
			contractsVersion: "v3.2",
			l3Enabled: "false",
			runnerTemp: "/tmp/runner",
			version: "v1.2.3",
		});

		expect(state.variant).toBe("l2");
		expect(state.contractsVersion).toBe("v3.2");
		expect(state.imageRef).toContain("nc3.2");
		expect(state.paths.l2BridgeUiConfig).toBe("");
		expect(state.paths.l2l3Network).toBe("");
		expect(state.rpcUrls.l3).toBe("");
	});

	it("resolves a relative output dir against the workspace", () => {
		const state = buildActionTestnodeState({
			contractsVersion: "v3.2",
			l3Enabled: "true",
			outputDir: "./shadow-testnode-output",
			version: "v1.2.3",
			workspace: "/workspace/sdk-shadow",
		});

		expect(state.outputDir).toBe("/workspace/sdk-shadow/shadow-testnode-output");
		expect(state.configDir).toBe("/workspace/sdk-shadow/shadow-testnode-output/config");
	});

	it("passes the Timeboost flag into docker run args when enabled", () => {
		const state = buildActionTestnodeState({
			contractsVersion: "v3.2",
			l3Enabled: "true",
			runnerTemp: "/tmp/runner",
			timeboostEnabled: "true",
			version: "v1.2.3",
		});

		expect(state.variant).toBe("l2-timeboost");
		expect(state.imageRef).toBe(`${DEFAULT_TESTNODE_IMAGE_REPOSITORY}:v1.2.3-nc3.2-l2-timeboost`);
		expect(state.rpcUrls.l3).toBe("");
		expect(state.timeboostEnabled).toBe(true);
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

	it("bypasses variant/version image resolution when an image-ref is given", () => {
		const state = buildActionTestnodeState({
			imageRef: "ghcr.io/acme/testnode:custom",
			l3Enabled: "false",
			runnerTemp: "/tmp/runner",
		});

		expect(state.imageRef).toBe("ghcr.io/acme/testnode:custom");
		expect(state.variant).toBe("l2");
		expect(state.rpcUrls.l3).toBe("");
		expect(state.outputDir).toBe("/tmp/runner/arbitrum-testnode/custom/l2");
	});

	it("uses the existing l3-enabled option with an image-ref for L3 ports", () => {
		const state = buildActionTestnodeState({
			imageRef: "ghcr.io/acme/testnode:custom-l3",
			l3Enabled: "true",
			runnerTemp: "/tmp/runner",
		});

		expect(state.imageRef).toBe("ghcr.io/acme/testnode:custom-l3");
		expect(state.variant).toBe("l3-eth");
		expect(state.rpcUrls.l3).toBe("http://127.0.0.1:3347");
	});

	it("keeps fee-token and Timeboost variant resolution with an image-ref", () => {
		const customFee = buildActionTestnodeState({
			feeTokenDecimals: "18",
			imageRef: "ghcr.io/acme/testnode:custom-fee",
			l3Enabled: "true",
			runnerTemp: "/tmp/runner",
		});
		const timeboost = buildActionTestnodeState({
			imageRef: "ghcr.io/acme/testnode:timeboost",
			l3Enabled: "false",
			runnerTemp: "/tmp/runner",
			timeboostEnabled: "true",
		});

		expect(customFee.variant).toBe("l3-custom-18");
		expect(customFee.imageRef).toBe("ghcr.io/acme/testnode:custom-fee");
		expect(timeboost.variant).toBe("l2-timeboost");
		expect(timeboost.imageRef).toBe("ghcr.io/acme/testnode:timeboost");
	});

	it("requires version when image-ref is omitted", () => {
		expect(() =>
			buildActionTestnodeState({
				l3Enabled: "false",
				runnerTemp: "/tmp/runner",
			}),
		).toThrow("version is required when image-ref is not provided");
	});

	it("defaults to v3.2 when contractsVersion is not provided", () => {
		const state = buildActionTestnodeState({
			l3Enabled: "true",
			runnerTemp: "/tmp/runner",
			version: "v1.2.3",
		});

		expect(state.contractsVersion).toBe(DEFAULT_NITRO_CONTRACTS_VERSION);
		expect(state.imageRef).toContain("nc3.2");
	});

	it("rejects invalid contracts versions", () => {
		expect(() => normalizeNitroContractsVersion("v9.9")).toThrow(
			"nitro-contracts-version must be one of: v2.1, v3.2",
		);
	});
});
