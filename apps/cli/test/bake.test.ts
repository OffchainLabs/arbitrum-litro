import { describe, expect, it, vi } from "vitest";
import { runBundleBake } from "../src/commands/bake.js";

function dependencies(commands: string[][]) {
	return {
		boot: vi.fn(() => []),
		remove: vi.fn(),
		runDocker: vi.fn((args: string[]) => {
			commands.push(args);
			return "";
		}),
		verify: vi.fn(async () => undefined),
	};
}

describe("runBundleBake", () => {
	it("customizes and commits an explicit local bundle without rebuilding sources", async () => {
		const commands: string[][] = [];
		const deps = dependencies(commands);

		const result = await runBundleBake(
			{
				baseImageRef: "local/base:test",
				imageRef: "local/custom:test",
				push: true,
				setupCommand: "true",
			},
			deps,
		);

		expect(result).toMatchObject({
			baseImageRef: "local/base:test",
			imageRef: "local/custom:test",
			pushed: true,
			variant: "l3-eth",
		});
		expect(commands.some(([command]) => command === "pull")).toBe(false);
		expect(commands.map(([command]) => command)).toEqual(["cp", "stop", "commit", "push"]);
		expect(commands.flat()).not.toContain("build");
		expect(commands.flat()).not.toContain("git");
		expect(deps.remove).toHaveBeenCalledOnce();
	});

	it("pulls the latest composed bundle by default", async () => {
		const commands: string[][] = [];
		const deps = dependencies(commands);

		const result = await runBundleBake(
			{ imageRef: "local/custom:test", setupCommand: "true" },
			deps,
		);

		expect(result.baseImageRef).toBe("ghcr.io/offchainlabs/arbitrum-testnode-ci:latest-l3-eth");
		expect(commands[0]).toEqual([
			"pull",
			"ghcr.io/offchainlabs/arbitrum-testnode-ci:latest-l3-eth",
		]);
	});

	it("supports an L2 bundle without running L3 semantic checks", async () => {
		const commands: string[][] = [];
		const deps = dependencies(commands);

		const result = await runBundleBake(
			{
				baseImageRef: "local/base:l2",
				imageRef: "local/custom:l2",
				l3Enabled: false,
				setupCommand: "true",
			},
			deps,
		);

		expect(result.variant).toBe("l2");
		expect(deps.verify).not.toHaveBeenCalled();
	});
});
