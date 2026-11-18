import { decodeFunctionData } from "viem";
import { describe, expect, it, vi } from "vitest";
import { rollupAbi } from "../src/rpc.js";

const ROLLUP = "0x00000000000000000000000000000000000000BB";
const EXECUTOR = "0x00000000000000000000000000000000000000CC";

const chain = vi.hoisted(() => ({
	status: "success",
	writes: [] as Array<{ address: string; functionName: string; args: unknown[] }>,
}));

vi.mock("../src/rpc.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/rpc.js")>()),
	publicClient: () => ({ waitForTransactionReceipt: async () => ({ status: chain.status }) }),
	walletClient: () => ({
		writeContract: async (call: { address: string; functionName: string; args: unknown[] }) => {
			chain.writes.push(call);
			return "0x01";
		},
	}),
}));

const { setV21MinimumAssertionPeriod } = await import("../src/init/chain-steps.js");

describe("setV21MinimumAssertionPeriod", () => {
	it("sets minimumAssertionPeriod to 1 through the rollup's UpgradeExecutor", async () => {
		await setV21MinimumAssertionPeriod(ROLLUP, EXECUTOR);
		const call = chain.writes[0];
		expect(call).toMatchObject({ address: EXECUTOR, functionName: "executeCall" });
		expect(call?.args[0]).toBe(ROLLUP);
		expect(decodeFunctionData({ abi: rollupAbi, data: call?.args[1] as `0x${string}` })).toEqual({
			functionName: "setMinimumAssertionPeriod",
			args: [1n],
		});
	});

	it("throws when the call reverts", async () => {
		chain.status = "reverted";
		await expect(setV21MinimumAssertionPeriod(ROLLUP, EXECUTOR)).rejects.toThrow(/reverted/);
	});
});
