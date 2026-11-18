/**
 * Bridges an L1 ERC20 to L2 through the L1/L2 token bridge's standard gateway, so a custom
 * L3 fee token on L2 has an L1 counterpart (as on nitro-testnode). L1-to-L3 fee token
 * bridging (arbitrum-sdk Erc20L1L3Bridger) needs that counterpart.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import { encodeAbiParameters, parseAbi, parseEther, parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { testErc20Abi } from "./fee-token.js";
import { publicClient, walletClient } from "./rpc.js";

const gatewayRouterAbi = parseAbi([
	"function getGateway(address) view returns (address)",
	"function calculateL2TokenAddress(address) view returns (address)",
	"function outboundTransfer(address, address, uint256, uint256, uint256, bytes) payable returns (bytes)",
]);

// The first deposit of a token deploys its L2 contract, so the retryable gets ample gas.
const RETRYABLE_GAS_LIMIT = 2_000_000n;
const RETRYABLE_MAX_FEE_PER_GAS = parseGwei("1");
const RETRYABLE_MAX_SUBMISSION_COST = parseEther("0.01");
const L2_ARRIVAL_TIMEOUT_MS = 180_000;

export function readParentGatewayRouter(configDir: string): Address {
	const network = JSON.parse(readFileSync(join(configDir, "l1l2_network.json"), "utf-8")) as {
		l2Network?: { tokenBridge?: { parentGatewayRouter?: string } };
	};
	const router = network.l2Network?.tokenBridge?.parentGatewayRouter;
	if (!router) {
		throw new Error("Missing l2Network.tokenBridge.parentGatewayRouter in l1l2_network.json");
	}
	return router as Address;
}

export async function bridgeL1TokenToL2({
	l1RpcUrl,
	l2RpcUrl,
	parentGatewayRouter,
	l1Token,
	senderKey,
	recipients,
	amountPerRecipient,
}: {
	l1RpcUrl: string;
	l2RpcUrl: string;
	parentGatewayRouter: Address;
	l1Token: Address;
	senderKey: `0x${string}`;
	recipients: Address[];
	amountPerRecipient: bigint;
}): Promise<Address> {
	const account = privateKeyToAccount(senderKey);
	const l1 = walletClient(l1RpcUrl, senderKey);
	const l1Pub = publicClient(l1RpcUrl);
	const l2Pub = publicClient(l2RpcUrl);

	const gateway = await l1Pub.readContract({
		address: parentGatewayRouter,
		abi: gatewayRouterAbi,
		functionName: "getGateway",
		args: [l1Token],
	});
	const l2Token = await l1Pub.readContract({
		address: parentGatewayRouter,
		abi: gatewayRouterAbi,
		functionName: "calculateL2TokenAddress",
		args: [l1Token],
	});

	const approveHash = await l1.writeContract({
		account,
		address: l1Token,
		abi: testErc20Abi,
		functionName: "approve",
		args: [gateway, amountPerRecipient * BigInt(recipients.length)],
	});
	await expectSuccess(l1Pub, approveHash, "approve fee token to the L1 gateway");

	const data = encodeAbiParameters(
		[{ type: "uint256" }, { type: "bytes" }],
		[RETRYABLE_MAX_SUBMISSION_COST, "0x"],
	);
	const value = RETRYABLE_MAX_SUBMISSION_COST + RETRYABLE_GAS_LIMIT * RETRYABLE_MAX_FEE_PER_GAS;
	for (const recipient of recipients) {
		const hash = await l1.writeContract({
			account,
			address: parentGatewayRouter,
			abi: gatewayRouterAbi,
			functionName: "outboundTransfer",
			args: [
				l1Token,
				recipient,
				amountPerRecipient,
				RETRYABLE_GAS_LIMIT,
				RETRYABLE_MAX_FEE_PER_GAS,
				data,
			],
			value,
		});
		await expectSuccess(l1Pub, hash, `deposit fee token to ${recipient}`);
	}

	const deadline = Date.now() + L2_ARRIVAL_TIMEOUT_MS;
	for (const recipient of recipients) {
		while (!(await hasL2Balance(l2Pub, l2Token, recipient, amountPerRecipient))) {
			if (Date.now() > deadline) {
				throw new Error(`Fee token deposit to ${recipient} did not arrive on L2 at ${l2Token}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}
	console.log(
		`[fee-token] Bridged ${l1Token} to L2 at ${l2Token} for ${recipients.length} accounts`,
	);
	return l2Token;
}

async function hasL2Balance(
	l2Pub: ReturnType<typeof publicClient>,
	l2Token: Address,
	holder: Address,
	amount: bigint,
): Promise<boolean> {
	const code = await l2Pub.getCode({ address: l2Token });
	if (!code || code === "0x") {
		return false;
	}
	const balance = await l2Pub.readContract({
		address: l2Token,
		abi: testErc20Abi,
		functionName: "balanceOf",
		args: [holder],
	});
	return balance >= amount;
}

async function expectSuccess(
	pub: ReturnType<typeof publicClient>,
	hash: `0x${string}`,
	what: string,
): Promise<void> {
	const receipt = await pub.waitForTransactionReceipt({ hash });
	if (receipt.status !== "success") {
		throw new Error(`Failed to ${what}: transaction ${hash} reverted`);
	}
}
