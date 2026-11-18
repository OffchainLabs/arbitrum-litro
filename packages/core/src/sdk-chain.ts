import { readFileSync, writeFileSync } from "node:fs";
import {
	type CreateRollupParams,
	type CreateRollupResults,
	type NodeConfig,
	type PrepareNodeConfigParams,
	createRollup,
	createRollupDefaultRetryablesFees,
	createRollupEnoughCustomFeeTokenAllowance,
	createRollupPrepareCustomFeeTokenApprovalTransactionRequest,
	createRollupPrepareDeploymentParamsConfig,
	createRollupPrepareTransaction,
	createRollupPrepareTransactionReceipt,
	createRollupPrepareTransactionRequest,
	prepareNodeConfig,
} from "@arbitrum/chain-sdk";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FAST_PARENT_ROLLUP_CONFIG } from "./chain-spec.js";
import { ZERO_ADDRESS } from "./init-helpers.js";
import { publicClient } from "./rpc.js";

export interface CreateChainDeployment {
	bridge: Address;
	inbox: Address;
	"sequencer-inbox": Address;
	"deployed-at": number;
	rollup: Address;
	"native-token": Address;
	"upgrade-executor": Address;
	"validator-utils"?: Address;
	"validator-wallet-creator": Address;
	"stake-token"?: Address;
}

export interface DeployRollupViaSdkParams {
	chainConfigPath: string;
	chainId: number;
	chainName: string;
	parentChainId: number;
	parentChainIsArbitrum: boolean;
	parentRpcUrl: string;
	parentBeaconRpcUrl?: string;
	ownerAddress: Address;
	ownerKey: `0x${string}`;
	batchPosterAddress: Address;
	batchPosterKey: `0x${string}`;
	validatorAddress: Address;
	validatorKey: `0x${string}`;
	maxDataSize: bigint;
	wasmModuleRoot?: `0x${string}`;
	deploymentOutputPath: string;
	chainInfoOutputPath: string;
	rawNodeConfigOutputPath: string;
	nativeToken?: Address;
	feeTokenPricer?: Address;
	stakeToken?: Address;
	rollupCreatorAddress?: Address;
	nitroContractsVersion?: "v2.1" | "v3.2";
}

type DeploymentForNodeConfig = Partial<CreateChainDeployment> &
	Pick<CreateChainDeployment, "rollup" | "bridge" | "inbox" | "sequencer-inbox">;

interface CodeReader {
	getCode(input: { address: Address }): Promise<`0x${string}` | undefined>;
}

async function normalizeStakeTokenAddress(
	codeReader: CodeReader,
	stakeToken?: Address,
): Promise<Address> {
	if (!stakeToken || stakeToken === ZERO_ADDRESS) {
		return ZERO_ADDRESS;
	}
	const code = await codeReader.getCode({ address: stakeToken });
	return code && code !== "0x" ? stakeToken : ZERO_ADDRESS;
}

export function prepareNodeConfigFromDeployment(input: {
	chainName: string;
	chainConfig: Record<string, unknown> & { chainId: number };
	deployment: DeploymentForNodeConfig;
	parentChainId: 1337 | 412346;
	parentChainIsArbitrum?: boolean;
	parentChainRpcUrl: string;
	parentChainBeaconRpcUrl?: string;
	batchPosterPrivateKey: string;
	validatorPrivateKey: string;
	dasServerUrl?: string;
}) {
	return prepareNodeConfig({
		chainName: input.chainName,
		chainConfig: input.chainConfig as PrepareNodeConfigParams["chainConfig"],
		coreContracts: {
			rollup: input.deployment.rollup,
			bridge: input.deployment.bridge,
			inbox: input.deployment.inbox,
			sequencerInbox: input.deployment["sequencer-inbox"],
			validatorUtils: input.deployment["validator-utils"],
			validatorWalletCreator: input.deployment["validator-wallet-creator"] ?? ZERO_ADDRESS,
			nativeToken: input.deployment["native-token"] ?? ZERO_ADDRESS,
			deployedAtBlockNumber: input.deployment["deployed-at"] ?? 0,
		} as PrepareNodeConfigParams["coreContracts"],
		batchPosterPrivateKey: input.batchPosterPrivateKey,
		validatorPrivateKey: input.validatorPrivateKey,
		stakeToken: input.deployment["stake-token"] ?? ZERO_ADDRESS,
		parentChainId: input.parentChainId,
		...(input.parentChainIsArbitrum !== undefined
			? { parentChainIsArbitrum: input.parentChainIsArbitrum }
			: {}),
		parentChainRpcUrl: input.parentChainRpcUrl,
		...(input.parentChainBeaconRpcUrl
			? { parentChainBeaconRpcUrl: input.parentChainBeaconRpcUrl }
			: {}),
		...(input.dasServerUrl ? { dasServerUrl: input.dasServerUrl } : {}),
	});
}

type DeploymentConfig = ReturnType<typeof createRollupPrepareDeploymentParamsConfig>;

function buildRollupParams(
	version: "v2.1" | "v3.2",
	deploymentConfig: DeploymentConfig,
	params: DeployRollupViaSdkParams,
): CreateRollupParams<"v2.1"> | CreateRollupParams<"v3.2"> {
	// feeTokenPricer is a top-level createRollup param (read as params.feeTokenPricer
	// by the SDK's custom-gas validation), not a deployment-config field. v2.1's
	// CreateRollupParams has no feeTokenPricer field, so omit it entirely there.
	const baseRollupParams = {
		config: deploymentConfig,
		batchPosters: [params.batchPosterAddress],
		validators: [params.validatorAddress],
		maxDataSize: Number(params.maxDataSize),
		...(params.nativeToken ? { nativeToken: params.nativeToken } : {}),
	};
	if (version === "v2.1") {
		return baseRollupParams as CreateRollupParams<"v2.1">;
	}
	return {
		...baseRollupParams,
		...(params.feeTokenPricer ? { feeTokenPricer: params.feeTokenPricer } : {}),
	} as CreateRollupParams<"v3.2">;
}

function buildChainDeployment(
	result: CreateRollupResults,
	stakeToken: Address,
): CreateChainDeployment {
	return {
		bridge: result.coreContracts.bridge,
		inbox: result.coreContracts.inbox,
		"sequencer-inbox": result.coreContracts.sequencerInbox,
		"deployed-at": result.coreContracts.deployedAtBlockNumber,
		rollup: result.coreContracts.rollup,
		"native-token": result.coreContracts.nativeToken,
		"upgrade-executor": result.coreContracts.upgradeExecutor,
		...(result.coreContracts.validatorUtils
			? { "validator-utils": result.coreContracts.validatorUtils }
			: {}),
		"validator-wallet-creator": result.coreContracts.validatorWalletCreator,
		"stake-token": stakeToken,
	};
}

export async function deployRollupViaSdk(params: DeployRollupViaSdkParams): Promise<void> {
	const chainConfig = JSON.parse(readFileSync(params.chainConfigPath, "utf-8")) as Record<
		string,
		unknown
	>;
	const account = privateKeyToAccount(params.ownerKey);
	const parentChainPublicClient = publicClient(params.parentRpcUrl);
	const version = params.nitroContractsVersion ?? "v3.2";
	const deploymentConfig = createRollupPrepareDeploymentParamsConfig(
		parentChainPublicClient,
		{
			chainId: BigInt(params.chainId),
			owner: params.ownerAddress,
			chainConfig: chainConfig as PrepareNodeConfigParams["chainConfig"],
			// The SDK's defaults for these are sized for public parent chains (150 and 75 blocks), so
			// every withdrawal would wait minutes for confirmation. The exported network files record
			// the same values.
			confirmPeriodBlocks: BigInt(FAST_PARENT_ROLLUP_CONFIG.confirmPeriodBlocks),
			minimumAssertionPeriod: BigInt(FAST_PARENT_ROLLUP_CONFIG.minimumAssertionPeriod),
			...(params.wasmModuleRoot ? { wasmModuleRoot: params.wasmModuleRoot } : {}),
			...(params.stakeToken ? { stakeToken: params.stakeToken } : {}),
		},
		version,
	);

	const rollupParams = buildRollupParams(version, deploymentConfig, params);

	const result = params.rollupCreatorAddress
		? await createRollupWithCreatorOverride({
				params: rollupParams,
				account,
				parentChainPublicClient,
				rollupCreatorAddress: params.rollupCreatorAddress,
				version,
			})
		: await createRollup({
				params: rollupParams,
				account,
				parentChainPublicClient,
				rollupCreatorVersion: version,
			});

	const stakeToken = await normalizeStakeTokenAddress(
		parentChainPublicClient,
		(deploymentConfig as { stakeToken?: Address }).stakeToken as Address | undefined,
	);
	const deployment = buildChainDeployment(result, stakeToken);
	const nodeConfig: NodeConfig = prepareNodeConfig({
		chainName: params.chainName,
		chainConfig: chainConfig as PrepareNodeConfigParams["chainConfig"],
		coreContracts: result.coreContracts,
		batchPosterPrivateKey: params.batchPosterKey,
		validatorPrivateKey: params.validatorKey,
		stakeToken,
		parentChainId: params.parentChainId as PrepareNodeConfigParams["parentChainId"],
		parentChainIsArbitrum: params.parentChainIsArbitrum,
		parentChainRpcUrl: params.parentRpcUrl,
		...(params.parentBeaconRpcUrl ? { parentChainBeaconRpcUrl: params.parentBeaconRpcUrl } : {}),
	});
	const deploymentWithCreator = {
		...deployment,
		"rollup-creator": params.rollupCreatorAddress ?? result.transaction.to ?? ZERO_ADDRESS,
	};
	writeFileSync(params.deploymentOutputPath, JSON.stringify(deploymentWithCreator, null, 2));
	writeFileSync(
		params.chainInfoOutputPath,
		JSON.stringify(
			[
				{
					"chain-name": params.chainName,
					"parent-chain-id": params.parentChainId,
					"parent-chain-is-arbitrum": params.parentChainIsArbitrum,
					"sequencer-url": "",
					"secondary-forwarding-target": "",
					"feed-url": "",
					"secondary-feed-url": "",
					"das-index-url": "",
					"has-genesis-state": false,
					"chain-config": chainConfig,
					rollup: deployment,
				},
			],
			null,
			2,
		),
	);
	writeFileSync(params.rawNodeConfigOutputPath, JSON.stringify(nodeConfig, null, 2));
}

async function createRollupWithCreatorOverride(input: {
	params: CreateRollupParams<"v2.1"> | CreateRollupParams<"v3.2">;
	account: ReturnType<typeof privateKeyToAccount>;
	parentChainPublicClient: ReturnType<typeof publicClient>;
	rollupCreatorAddress: Address;
	version: "v2.1" | "v3.2";
}): Promise<CreateRollupResults> {
	const nativeToken = input.params["nativeToken"];
	if (nativeToken && nativeToken !== ZERO_ADDRESS) {
		const allowanceParams = {
			nativeToken,
			account: input.account.address,
			publicClient: input.parentChainPublicClient,
			rollupCreatorAddressOverride: input.rollupCreatorAddress,
			rollupCreatorVersion: input.version,
		};
		if (!(await createRollupEnoughCustomFeeTokenAllowance(allowanceParams))) {
			console.log("Approving custom fee token allowance for RollupCreator...");
			const approvalTxRequest =
				await createRollupPrepareCustomFeeTokenApprovalTransactionRequest(allowanceParams);
			const approvalTxHash = await input.parentChainPublicClient.sendRawTransaction({
				serializedTransaction: await input.account.signTransaction(approvalTxRequest),
			});
			const approvalTxReceipt = await input.parentChainPublicClient.waitForTransactionReceipt({
				hash: approvalTxHash,
			});
			console.log(`Approval transaction hash is ${approvalTxReceipt.transactionHash}`);
		}
	}

	const value =
		nativeToken && nativeToken !== ZERO_ADDRESS ? 0n : createRollupDefaultRetryablesFees;
	const txRequest = await createRollupPrepareTransactionRequest({
		params: input.params,
		account: input.account.address,
		publicClient: input.parentChainPublicClient,
		rollupCreatorAddressOverride: input.rollupCreatorAddress,
		rollupCreatorVersion: input.version,
		value,
	});

	console.log("Deploying the Rollup...");
	const txHash = await input.parentChainPublicClient.sendRawTransaction({
		serializedTransaction: await input.account.signTransaction(txRequest),
	});
	console.log(`Deployment transaction submitted: ${txHash}`);
	const transactionReceipt = createRollupPrepareTransactionReceipt(
		await input.parentChainPublicClient.waitForTransactionReceipt({ hash: txHash }),
	);
	console.log(`Deployment transaction confirmed in block ${transactionReceipt.blockNumber}`);
	const transaction = createRollupPrepareTransaction(
		await input.parentChainPublicClient.getTransaction({ hash: txHash }),
	);
	console.log(`Deployment transaction hash is ${transactionReceipt.transactionHash}`);

	return {
		transaction,
		transactionReceipt,
		coreContracts: transactionReceipt.getCoreContracts(),
	};
}
