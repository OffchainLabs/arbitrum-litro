import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address } from "viem";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { accounts } from "../accounts.js";
import { clampDepositAmount } from "../deposit-amount.js";
import { waitForRpc } from "../docker.js";
import { ZERO_ADDRESS } from "../init-helpers.js";
import { getL3ParentChainFundingPlan } from "../l3-parent-chain-funding.js";
import { patchGeneratedL3NodeConfig } from "../node-config-patches.js";
import {
	erc20Abi,
	getBalanceWei as getBalanceWeiRpc,
	publicClient,
	rollupAbi,
	walletClient,
} from "../rpc.js";
import type { InitState } from "../state.js";
import { ensureValidatorWalletStaked } from "../validator-wallet.js";
import type { InitRuntime } from "./context.js";

const L1_RPC = "http://127.0.0.1:8545";
const L2_RPC = "http://127.0.0.1:8547";
const L3_RPC = "http://127.0.0.1:8549";

const L2_RPC_INTERNAL = "http://sequencer:8547";

const L3_PARENT_CHAIN_FUNDING_RESERVE_WEI = 5n * 10n ** 16n;
const L2_VALIDATOR_GAS_TARGET_WEI = 1n * 10n ** 18n;

export type StepRunner = (state: InitState) => Promise<InitState>;

export interface DeploymentJson {
	rollup: string;
	inbox: string;
	bridge: string;
	"sequencer-inbox": string;
	"upgrade-executor": string;
	"stake-token"?: string;
	"validator-wallet-creator"?: string;
}

export function setL3StakerEnabled(runtime: InitRuntime, enabled: boolean): void {
	const configPath = resolve(runtime.configDir, "l3-nodeConfig.json");
	const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
	const patched = patchGeneratedL3NodeConfig(config, L2_RPC_INTERNAL, enabled);
	writeFileSync(configPath, JSON.stringify(patched, null, 2));
}

export async function applyGasEstimationWorkaround(): Promise<void> {
	console.log("[init] Applying L1/L2 gas estimation workaround");
	for (const rpcUrl of [L1_RPC, L2_RPC]) {
		await sendZeroAddressTransfer(rpcUrl, parseEther("1"));
	}
}

export async function sendZeroAddressTransfer(rpcUrl: string, value = 1n): Promise<void> {
	try {
		const account = privateKeyToAccount(accounts.funnel.privateKey);
		const client = walletClient(rpcUrl, accounts.funnel.privateKey);
		await client.sendTransaction({
			account,
			to: ZERO_ADDRESS as Address,
			value,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (
			message.includes("replacement transaction underpriced") ||
			message.includes("already known")
		) {
			console.warn(`[init] Skipping gas-estimation poke on ${rpcUrl}: ${message}`);
			return;
		}
		throw error;
	}
}

export async function getBalanceWei(address: Address, rpcUrl: string): Promise<bigint> {
	return getBalanceWeiRpc(address, rpcUrl);
}

async function getErc20BalanceWei(
	tokenAddress: Address,
	address: Address,
	rpcUrl: string,
): Promise<bigint> {
	return publicClient(rpcUrl).readContract({
		address: tokenAddress,
		abi: erc20Abi,
		functionName: "balanceOf",
		args: [address],
	}) as Promise<bigint>;
}

async function topUpEthIfNeeded(
	address: Address,
	targetWei: bigint,
	rpcUrl: string,
	senderKey: `0x${string}`,
	label: string,
): Promise<void> {
	const currentBalanceWei = await getBalanceWei(address, rpcUrl);
	if (currentBalanceWei >= targetWei) {
		return;
	}

	const senderAddress = accounts.funnel.address;
	const senderBalanceWei = await getBalanceWei(senderAddress, rpcUrl);
	const depositWei = clampDepositAmount({
		balanceWei: senderBalanceWei,
		desiredWei: targetWei - currentBalanceWei,
		reserveWei: L3_PARENT_CHAIN_FUNDING_RESERVE_WEI,
	});

	console.log(`[init] Funding ${label} on ${rpcUrl} with ${depositWei} wei`);
	const account = privateKeyToAccount(senderKey);
	const client = walletClient(rpcUrl, senderKey);
	await client.sendTransaction({
		account,
		to: address,
		value: depositWei,
	});
}

export async function ensureL2ValidatorFunding(
	rollupAddress: Address,
	stakeTokenAddress: Address,
	validatorWalletCreatorAddress: string,
	upgradeExecutor: Address,
): Promise<void> {
	await topUpEthIfNeeded(
		accounts.validator.address,
		L2_VALIDATOR_GAS_TARGET_WEI,
		L1_RPC,
		accounts.funnel.privateKey,
		"L2 validator gas",
	);

	const requiredStakeWei = (await publicClient(L1_RPC).readContract({
		address: rollupAddress,
		abi: rollupAbi,
		functionName: "baseStake",
	})) as bigint;
	const currentStakeWei = await getErc20BalanceWei(
		stakeTokenAddress,
		accounts.validator.address,
		L1_RPC,
	);
	if (currentStakeWei >= requiredStakeWei) {
		return;
	}

	const neededStakeWei = requiredStakeWei - currentStakeWei;
	const funderStakeWei = await getErc20BalanceWei(
		stakeTokenAddress,
		accounts.funnel.address,
		L1_RPC,
	);
	if (funderStakeWei < neededStakeWei) {
		const shortfallWei = neededStakeWei - funderStakeWei;
		console.log(`[init] Wrapping ${shortfallWei} wei into stake token for L2 validator`);
		const funnelAccount = privateKeyToAccount(accounts.funnel.privateKey);
		const depositClient = walletClient(L1_RPC, accounts.funnel.privateKey);
		await depositClient.writeContract({
			account: funnelAccount,
			address: stakeTokenAddress,
			abi: erc20Abi,
			functionName: "deposit",
			value: shortfallWei,
		});
	}

	console.log(`[init] Funding L2 validator stake token with ${neededStakeWei} units`);
	const funnelAccount = privateKeyToAccount(accounts.funnel.privateKey);
	const transferClient = walletClient(L1_RPC, accounts.funnel.privateKey);
	await transferClient.writeContract({
		account: funnelAccount,
		address: stakeTokenAddress,
		abi: erc20Abi,
		functionName: "transfer",
		args: [accounts.validator.address, neededStakeWei],
	});

	await ensureValidatorWalletStaked({
		parentRpc: L1_RPC,
		creatorAddress: validatorWalletCreatorAddress as `0x${string}`,
		rollupAddress: rollupAddress,
		stakeTokenAddress: stakeTokenAddress,
		validatorAddress: accounts.validator.address,
		validatorKey: accounts.validator.privateKey,
		funderKey: accounts.funnel.privateKey,
		requiredStakeWei,
		upgradeExecutor,
		ownerKey: accounts.l2owner.privateKey,
	});
}

export async function fundL3ParentChainAccounts(): Promise<void> {
	for (const transfer of getL3ParentChainFundingPlan()) {
		const recipientBalanceWei = await getBalanceWei(transfer.address as Address, L2_RPC);
		if (recipientBalanceWei >= transfer.amountWei) {
			console.log(`[init] ${transfer.label} already funded on L2 parent chain`);
			continue;
		}
		const senderBalanceWei = await getBalanceWei(accounts.funnel.address, L2_RPC);
		let topUpWei: bigint;
		try {
			topUpWei = clampDepositAmount({
				balanceWei: senderBalanceWei,
				desiredWei: transfer.amountWei - recipientBalanceWei,
				reserveWei: L3_PARENT_CHAIN_FUNDING_RESERVE_WEI,
			});
		} catch {
			console.warn(`[init] Skipping ${transfer.label} funding; funnel L2 balance is too low`);
			continue;
		}
		console.log(`[init] Funding ${transfer.label} on L2 parent chain with ${topUpWei} wei`);
		const funnelAccount = privateKeyToAccount(accounts.funnel.privateKey);
		const client = walletClient(L2_RPC, accounts.funnel.privateKey);
		await client.sendTransaction({
			account: funnelAccount,
			to: transfer.address as Address,
			value: topUpWei,
		});
	}
}

export async function waitForBalanceAtLeast(
	address: Address,
	rpcUrl: string,
	targetWei: bigint,
	timeoutMs = 120_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await getBalanceWei(address, rpcUrl)) >= targetWei) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	throw new Error(`Balance for ${address} on ${rpcUrl} did not reach ${targetWei} wei`);
}

export async function waitForL3RpcWithParentChainNudges(timeoutMs = 300_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		try {
			await waitForRpc(L3_RPC, 5_000, 500);
			return;
		} catch {
			await sendZeroAddressTransfer(L2_RPC);
		}
	}

	throw new Error(`RPC at ${L3_RPC} not ready after ${timeoutMs}ms`);
}

export function patchConfigUrl(configPath: string, hostUrl: string, dockerUrl: string): void {
	const content = readFileSync(configPath, "utf-8");
	const patched = content.replaceAll(hostUrl, dockerUrl);
	writeFileSync(configPath, patched, "utf-8");
}

export function copyConfigFile(runtime: InitRuntime, sourceName: string, destName: string): void {
	writeFileSync(
		resolve(runtime.configDir, destName),
		readFileSync(resolve(runtime.configDir, sourceName), "utf-8"),
	);
}

export function readDeployment(runtime: InitRuntime, name: string): DeploymentJson {
	const raw = readFileSync(resolve(runtime.configDir, name), "utf-8");
	return JSON.parse(raw) as DeploymentJson;
}

export function readJsonFile<T>(runtime: InitRuntime, name: string): T {
	return JSON.parse(readFileSync(resolve(runtime.configDir, name), "utf-8")) as T;
}
