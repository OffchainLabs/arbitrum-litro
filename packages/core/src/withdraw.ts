import type { Address } from "viem";
import { decodeEventLog } from "viem";
import { arbSysAbi, nodeInterfaceAbi, outboxAbi, publicClient, walletClient } from "./rpc.js";

const ARBSYS_ADDRESS: Address = "0x0000000000000000000000000000000000000064";
const NODE_INTERFACE_ADDRESS: Address = "0x00000000000000000000000000000000000000C8";

export async function executeWithdrawal(params: {
	childRpcUrl: string;
	parentRpcUrl: string;
	privateKey: `0x${string}`;
	amount: bigint;
	outboxAddress: Address;
	pollIntervalMs?: number;
	timeoutMs?: number;
}): Promise<{ durationMs: number; txHash: string }> {
	const {
		childRpcUrl,
		parentRpcUrl,
		privateKey,
		amount,
		outboxAddress,
		pollIntervalMs = 250,
		timeoutMs = 30_000,
	} = params;

	const startMs = Date.now();
	const childWallet = walletClient(childRpcUrl, privateKey);
	const childPublic = publicClient(childRpcUrl);
	const parentWallet = walletClient(parentRpcUrl, privateKey);
	const parentPublic = publicClient(parentRpcUrl);
	const account = childWallet.account.address;

	// 1. Initiate withdrawal on child chain
	const withdrawHash = await childWallet.writeContract({
		address: ARBSYS_ADDRESS,
		abi: arbSysAbi,
		functionName: "withdrawEth",
		args: [account],
		value: amount,
	});

	// viem polls every 4s by default (these chains declare no block time); the testnode answers
	// in under a second, so the default dominated the measured withdrawal time.
	const withdrawReceipt = await childPublic.waitForTransactionReceipt({
		hash: withdrawHash,
		pollingInterval: pollIntervalMs,
	});

	// 2. Parse L2ToL1Tx event
	const l2ToL1Log = withdrawReceipt.logs
		.map((log) => {
			try {
				return decodeEventLog({ abi: arbSysAbi, data: log.data, topics: log.topics });
			} catch {
				return null;
			}
		})
		.find((decoded) => decoded?.eventName === "L2ToL1Tx");

	if (!l2ToL1Log || l2ToL1Log.eventName !== "L2ToL1Tx") {
		throw new Error("L2ToL1Tx event not found in withdrawal receipt");
	}

	const { position, caller, destination, arbBlockNum, ethBlockNum, timestamp, callvalue, data } =
		l2ToL1Log.args;

	// 3. Get sendMerkleTreeState for proof construction
	const [sendCount] = await childPublic.readContract({
		address: ARBSYS_ADDRESS,
		abi: arbSysAbi,
		functionName: "sendMerkleTreeState",
	});

	// 4. Construct outbox proof
	const [_send, _root, proof] = await childPublic.readContract({
		address: NODE_INTERFACE_ADDRESS,
		abi: nodeInterfaceAbi,
		functionName: "constructOutboxProof",
		args: [sendCount, position],
	});

	// 5. Poll until assertion is confirmed (executeTransaction simulation succeeds)
	const executeArgs = {
		address: outboxAddress,
		abi: outboxAbi,
		functionName: "executeTransaction" as const,
		args: [
			proof,
			position,
			caller,
			destination,
			arbBlockNum,
			ethBlockNum,
			timestamp,
			callvalue,
			data,
		] as const,
		account: parentWallet.account,
	};

	const deadline = startMs + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await parentPublic.simulateContract(executeArgs);
			break;
		} catch {
			if (Date.now() + pollIntervalMs >= deadline) {
				throw new Error(`Withdrawal not confirmable within ${timeoutMs}ms timeout`);
			}
			await new Promise((r) => setTimeout(r, pollIntervalMs));
		}
	}

	// 6. Execute the withdrawal on parent chain
	const executeTxHash = await parentWallet.writeContract(executeArgs);
	await parentPublic.waitForTransactionReceipt({
		hash: executeTxHash,
		pollingInterval: pollIntervalMs,
	});

	return {
		durationMs: Date.now() - startMs,
		txHash: executeTxHash,
	};
}
