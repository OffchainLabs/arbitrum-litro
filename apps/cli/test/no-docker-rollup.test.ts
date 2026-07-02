import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("init chain steps deploy rollups through a local RollupCreator", () => {
	const initSource = readFileSync(
		resolve(import.meta.dirname, "../../../packages/core/src/init/chain-steps.ts"),
		"utf-8",
	);
	const sdkSource = readFileSync(
		resolve(import.meta.dirname, "../../../packages/core/src/sdk-chain.ts"),
		"utf-8",
	);
	const composeSource = readFileSync(
		resolve(import.meta.dirname, "../../../docker/docker-compose.yaml"),
		"utf-8",
	);

	it("uses Docker only to provision the RollupCreator contracts", () => {
		expect(initSource).toContain("deployRollupCreatorViaDocker");
		expect(initSource).toContain("CONTRACT_DEPLOYER_IMAGE");
		expect(initSource).not.toContain("ROLLUPCREATOR_IMAGE");
	});

	it("deploys rollups with the SDK using the local RollupCreator", () => {
		expect(initSource).toContain("deployRollupViaSdk");
		expect(initSource).toContain("rollupCreatorAddress: rollupCreatorDeployment.rollupCreator");
		expect(initSource).toContain("stakeToken: rollupCreatorDeployment.stakeToken");
	});

	it("deploys the Timeboost auction after L2 is available", () => {
		expect(initSource).toContain("deployTimeboostAuctionViaDocker");
		expect(initSource).toContain('"deploy-timeboost-auction"');
		expect(initSource).toContain('"restart-l2-timeboost"');
		expect(initSource).toContain("TIMEBOOST_AUCTION_OUTPUT=/config/timeboost-auction.json");
		expect(initSource).toContain('composeUp(["timeboost-redis"]');
		expect(composeSource).toContain("timeboost-redis:");
		expect(composeSource).toContain(
			"TESTNODE_TIMEBOOST_REDIS_URL=${TESTNODE_TIMEBOOST_REDIS_URL:-redis://timeboost-redis:6379}",
		);
	});

	it("persists Anvil state while L1 is running", () => {
		expect(composeSource).toContain("--state=/state");
		expect(composeSource).toContain("--state-interval=1");
	});

	it("records the deployed RollupCreator address in deployment artifacts", () => {
		expect(sdkSource).toContain('"rollup-creator"');
	});
});
