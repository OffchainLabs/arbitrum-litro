import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { parseEther } from "viem";
import { describe, expect, it } from "vitest";
import { accounts } from "../../src/accounts.js";
import { publicClient, rollupAbi } from "../../src/rpc.js";
import { executeWithdrawal } from "../../src/withdraw.js";

// The action exports these; LOCAL_NETWORK_PATH overrides the network file for a local run.
const L1_RPC_URL = process.env["ARBITRUM_TESTNODE_L1_RPC_URL"] || "http://127.0.0.1:8545";
const L2_RPC_URL = process.env["ARBITRUM_TESTNODE_L2_RPC_URL"] || "http://127.0.0.1:8547";
const L3_RPC_URL = process.env["ARBITRUM_TESTNODE_L3_RPC_URL"] || "http://127.0.0.1:3347";
const LOCAL_NETWORK_PATH =
	process.env["LOCAL_NETWORK_PATH"] || process.env["ARBITRUM_TESTNODE_LOCAL_NETWORK_PATH"] || "";

interface LocalNetwork {
	l2Network: { ethBridge: { rollup: Address } };
	l3Network?: { ethBridge: { rollup: Address } };
}

function readLocalNetwork(): LocalNetwork {
	if (!LOCAL_NETWORK_PATH) {
		throw new Error("Set LOCAL_NETWORK_PATH or ARBITRUM_TESTNODE_LOCAL_NETWORK_PATH");
	}
	return JSON.parse(readFileSync(LOCAL_NETWORK_PATH, "utf8")) as LocalNetwork;
}

async function getOutboxAddress(rollupAddress: Address, rpcUrl: string): Promise<Address> {
	return publicClient(rpcUrl).readContract({
		address: rollupAddress,
		abi: rollupAbi,
		functionName: "outbox",
	});
}

const network = readLocalNetwork();

describe("withdrawal speed", () => {
	it("L2→L1 ETH withdrawal completes within 30 seconds", async () => {
		const outboxAddress = await getOutboxAddress(network.l2Network.ethBridge.rollup, L1_RPC_URL);

		const result = await executeWithdrawal({
			childRpcUrl: L2_RPC_URL,
			parentRpcUrl: L1_RPC_URL,
			privateKey: accounts.funnel.privateKey,
			amount: parseEther("0.01"),
			outboxAddress,
			pollIntervalMs: 1000,
			timeoutMs: 30_000,
		});

		expect(result.durationMs).toBeLessThan(30_000);
		console.log(`L2→L1 withdrawal completed in ${result.durationMs}ms`);
	});

	it.skipIf(!network.l3Network)("L3→L2 ETH withdrawal completes within 30 seconds", async () => {
		const rollup = network.l3Network?.ethBridge.rollup as Address;
		const outboxAddress = await getOutboxAddress(rollup, L2_RPC_URL);

		const result = await executeWithdrawal({
			childRpcUrl: L3_RPC_URL,
			parentRpcUrl: L2_RPC_URL,
			privateKey: accounts.funnel.privateKey,
			amount: parseEther("0.001"),
			outboxAddress,
			pollIntervalMs: 1000,
			timeoutMs: 30_000,
		});

		expect(result.durationMs).toBeLessThan(30_000);
		console.log(`L3→L2 withdrawal completed in ${result.durationMs}ms`);
	});
});
