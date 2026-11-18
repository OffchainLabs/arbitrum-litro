import { decodeFunctionData } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rollupAbi } from "../src/rpc.js";

const VALIDATOR = "0x6A568afe0f82d34759347bb36F14A6bB171d2CBe";
const WALLET = "0x00000000000000000000000000000000000000AA";
const ROLLUP = "0x00000000000000000000000000000000000000bb";
const EXECUTOR = "0x00000000000000000000000000000000000000cc";
const CREATOR = "0x00000000000000000000000000000000000000dd";

const chain = vi.hoisted(() => ({
	logs: [] as unknown[],
	isValidator: false,
	writes: [] as Array<{ address: string; functionName: string; args: unknown[] }>,
}));

vi.mock("../src/rpc.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/rpc.js")>();
	return {
		...original,
		publicClient: () => ({
			getLogs: async () => chain.logs,
			readContract: async () => chain.isValidator,
			waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 1n }),
		}),
		walletClient: () => ({
			writeContract: async (call: { address: string; functionName: string; args: unknown[] }) => {
				chain.writes.push(call);
				if (call.functionName === "createWallet") {
					chain.logs = [{ args: { walletAddress: WALLET } }];
				}
				return "0x01";
			},
		}),
	};
});

const { ensureValidatorWalletWhitelisted } = await import("../src/validator-wallet.js");

const params = {
	parentRpc: "http://l2",
	creatorAddress: CREATOR,
	rollupAddress: ROLLUP,
	stakeTokenAddress: "0x0000000000000000000000000000000000000000",
	validatorAddress: VALIDATOR,
	validatorKey: `0x${"11".repeat(32)}`,
	upgradeExecutor: EXECUTOR,
	ownerKey: `0x${"22".repeat(32)}`,
} as const;

describe("ensureValidatorWalletWhitelisted (v2.1, ETH stake)", () => {
	beforeEach(() => {
		chain.logs = [];
		chain.isValidator = false;
		chain.writes = [];
	});

	it("creates the wallet and whitelists it through the UpgradeExecutor", async () => {
		await expect(ensureValidatorWalletWhitelisted(params)).resolves.toBe(WALLET);
		expect(chain.writes.map((w) => w.functionName)).toEqual(["createWallet", "executeCall"]);
		const call = chain.writes[1];
		expect(call?.address).toBe(EXECUTOR);
		expect(call?.args[0]).toBe(ROLLUP);
		const inner = decodeFunctionData({ abi: rollupAbi, data: call?.args[1] as `0x${string}` });
		expect(inner).toEqual({ functionName: "setValidator", args: [[WALLET], [true]] });
	});

	it("leaves an existing whitelisted wallet alone and never stakes", async () => {
		chain.logs = [{ args: { walletAddress: WALLET, executorAddress: VALIDATOR } }];
		chain.isValidator = true;
		await expect(ensureValidatorWalletWhitelisted(params)).resolves.toBe(WALLET);
		expect(chain.writes).toEqual([]);
	});
});
