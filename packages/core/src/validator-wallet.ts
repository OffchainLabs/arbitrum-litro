import { encodeFunctionData, maxUint256, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
	erc20Abi,
	publicClient,
	rollupAbi,
	upgradeExecutorAbi,
	validatorWalletAbi,
	validatorWalletCreatorAbi,
	walletClient,
} from "./rpc.js";

interface EnsureValidatorWalletStakedParams {
	parentRpc: string;
	creatorAddress: `0x${string}`;
	rollupAddress: `0x${string}`;
	stakeTokenAddress: `0x${string}`;
	validatorAddress: `0x${string}`;
	validatorKey: `0x${string}`;
	funderKey: `0x${string}`;
	requiredStakeWei: bigint;
	/** The rollup's UpgradeExecutor and a key it accepts calls from, to whitelist the wallet. */
	upgradeExecutor: `0x${string}`;
	ownerKey: `0x${string}`;
}

type WalletParams = Omit<EnsureValidatorWalletStakedParams, "funderKey" | "requiredStakeWei">;

/** ABI fragments only needed for encodeFunctionData (batched wallet calls). */
const stakeAbi = parseAbi([
	"function approve(address, uint256) returns (bool)",
	"function newStake(uint256, address)",
	"function addToDeposit(address, address, uint256)",
]);

const walletCreatedEvent = validatorWalletCreatorAbi[1];

/** Find or create a validator wallet via the WalletCreator contract. */
async function resolveWalletAddress(params: WalletParams): Promise<`0x${string}`> {
	const pub = publicClient(params.parentRpc);
	const validatorAccount = privateKeyToAccount(params.validatorKey);
	const validator = walletClient(params.parentRpc, params.validatorKey);

	const logs = await pub.getLogs({
		address: params.creatorAddress,
		event: walletCreatedEvent,
		fromBlock: 0n,
		toBlock: "latest",
		args: { ownerAddress: params.validatorAddress },
	});

	// Filter so both executorAddress and ownerAddress match the validator.
	// ownerAddress is already filtered above via the args parameter.
	const matching = logs.filter((l) => l.args.executorAddress === params.validatorAddress);

	if (matching.length > 1) {
		throw new Error(`More than one validator wallet exists for ${params.validatorAddress}`);
	}

	if (matching.length === 1) {
		const addr = matching[0]?.args.walletAddress;
		if (!addr) {
			throw new Error(`WalletCreated event missing walletAddress for ${params.validatorAddress}`);
		}
		return addr;
	}

	// No existing wallet — create one
	const txHash = await validator.writeContract({
		account: validatorAccount,
		address: params.creatorAddress,
		abi: validatorWalletCreatorAbi,
		functionName: "createWallet",
		args: [[params.stakeTokenAddress, params.rollupAddress]],
	});
	const receipt = await pub.waitForTransactionReceipt({ hash: txHash });

	const postLogs = await pub.getLogs({
		address: params.creatorAddress,
		event: walletCreatedEvent,
		fromBlock: receipt.blockNumber,
		toBlock: receipt.blockNumber,
	});
	const created = postLogs[0]?.args.walletAddress;
	if (!created) {
		throw new Error(`WalletCreated event missing for ${params.validatorAddress}`);
	}
	return created;
}

/** Ensure the validator wallet holds at least `requiredStakeWei` of the stake token. */
async function ensureWalletFunded(
	params: EnsureValidatorWalletStakedParams,
	walletAddress: `0x${string}`,
): Promise<void> {
	const pub = publicClient(params.parentRpc);
	const funderAccount = privateKeyToAccount(params.funderKey);
	const funder = walletClient(params.parentRpc, params.funderKey);

	const walletBalance = await pub.readContract({
		address: params.stakeTokenAddress,
		abi: erc20Abi,
		functionName: "balanceOf",
		args: [walletAddress],
	});

	if (walletBalance >= params.requiredStakeWei) {
		return;
	}

	const shortfall = params.requiredStakeWei - walletBalance;

	const funderBalance = await pub.readContract({
		address: params.stakeTokenAddress,
		abi: erc20Abi,
		functionName: "balanceOf",
		args: [funderAccount.address],
	});

	if (funderBalance < shortfall) {
		const depositHash = await funder.writeContract({
			account: funderAccount,
			address: params.stakeTokenAddress,
			abi: erc20Abi,
			functionName: "deposit",
			value: shortfall,
		});
		await pub.waitForTransactionReceipt({ hash: depositHash });
	}

	const transferHash = await funder.writeContract({
		account: funderAccount,
		address: params.stakeTokenAddress,
		abi: erc20Abi,
		functionName: "transfer",
		args: [walletAddress, shortfall],
	});
	await pub.waitForTransactionReceipt({ hash: transferHash });
}

export async function ensureValidatorWalletStaked(
	params: EnsureValidatorWalletStakedParams,
): Promise<`0x${string}`> {
	const pub = publicClient(params.parentRpc);
	const validatorAccount = privateKeyToAccount(params.validatorKey);
	const validator = walletClient(params.parentRpc, params.validatorKey);

	const walletAddress = await resolveWalletAddress(params);
	await ensureWalletWhitelisted(params, walletAddress);
	await ensureWalletFunded(params, walletAddress);

	const currentStake = await pub.readContract({
		address: params.rollupAddress,
		abi: rollupAbi,
		functionName: "amountStaked",
		args: [walletAddress],
	});

	if (currentStake >= params.requiredStakeWei) {
		return walletAddress;
	}

	// Read staker info — tuple: (uint256, bytes32, uint64, bool, address)
	const staker = await pub.readContract({
		address: params.rollupAddress,
		abi: rollupAbi,
		functionName: "getStaker",
		args: [walletAddress],
	});

	const isStaked = staker[3];
	const missingStake = params.requiredStakeWei - currentStake;

	const actionData = isStaked
		? encodeFunctionData({
				abi: stakeAbi,
				functionName: "addToDeposit",
				args: [walletAddress, walletAddress, missingStake],
			})
		: encodeFunctionData({
				abi: stakeAbi,
				functionName: "newStake",
				args: [params.requiredStakeWei, walletAddress],
			});

	const approveData = encodeFunctionData({
		abi: stakeAbi,
		functionName: "approve",
		args: [params.rollupAddress, maxUint256],
	});

	const txHash = await validator.writeContract({
		account: validatorAccount,
		address: walletAddress,
		abi: validatorWalletAbi,
		functionName: "executeTransactions",
		args: [
			[approveData, actionData],
			[params.stakeTokenAddress, params.rollupAddress],
			[0n, 0n],
		],
		gas: 800000n,
	});
	// The gas limit is fixed, so a revert is only visible in the receipt.
	const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
	if (receipt.status !== "success") {
		throw new Error(`Staking validator wallet ${walletAddress} reverted in ${txHash}`);
	}

	return walletAddress;
}

/**
 * A v2.1 (pre-BoLD) rollup stakes ETH, which the legacy staker sends itself, so it only needs the
 * wallet to exist and be whitelisted. Nitro finds the wallet by its WalletCreated log.
 */
export async function ensureValidatorWalletWhitelisted(
	params: WalletParams,
): Promise<`0x${string}`> {
	const walletAddress = await resolveWalletAddress(params);
	await ensureWalletWhitelisted(params, walletAddress);
	return walletAddress;
}

/**
 * The validator node acts through its smart-contract wallet (use-smart-contract-wallet), so the
 * rollup must whitelist the wallet, not only the validator's own address, or every assertion
 * reverts with NOT_VALIDATOR.
 */
async function ensureWalletWhitelisted(
	params: WalletParams,
	walletAddress: `0x${string}`,
): Promise<void> {
	const pub = publicClient(params.parentRpc);
	const isValidator = await pub.readContract({
		address: params.rollupAddress,
		abi: rollupAbi,
		functionName: "isValidator",
		args: [walletAddress],
	});
	if (isValidator) {
		return;
	}
	const ownerAccount = privateKeyToAccount(params.ownerKey);
	const owner = walletClient(params.parentRpc, params.ownerKey);
	const txHash = await owner.writeContract({
		account: ownerAccount,
		address: params.upgradeExecutor,
		abi: upgradeExecutorAbi,
		functionName: "executeCall",
		args: [
			params.rollupAddress,
			encodeFunctionData({
				abi: rollupAbi,
				functionName: "setValidator",
				args: [[walletAddress], [true]],
			}),
		],
	});
	const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
	if (receipt.status !== "success") {
		throw new Error(`Whitelisting validator wallet ${walletAddress} reverted in ${txHash}`);
	}
	console.log(
		`[init] Whitelisted validator wallet ${walletAddress} on rollup ${params.rollupAddress}`,
	);
}
