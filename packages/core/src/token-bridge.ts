import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	createTokenBridge,
	createTokenBridgeFetchTokenBridgeContracts,
	createTokenBridgePrepareSetWethGatewayTransactionReceipt,
	createTokenBridgePrepareSetWethGatewayTransactionRequest,
} from "@arbitrum/chain-sdk";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { accounts } from "./accounts.js";
import {
	type BridgeUiConfigFile,
	ZERO_ADDRESS,
	createChainSpec,
	createParentDeployment,
	getAdminOutputDir,
	getChainSpecPath,
	readDeploymentArtifact,
	writeChainSpecFile,
	writeCombinedLocalNetworkFile,
	writeSdkNetworkFileFromBridgeUiConfig,
} from "./chain-spec.js";
import { clampDepositAmount } from "./deposit-amount.js";
import { execOrThrow } from "./exec.js";
import {
	arbOwnerAbi,
	getBalanceWei as getBalanceWeiRpc,
	publicClient,
	readContractOrZero,
	rollupAbi,
	walletClient,
} from "./rpc.js";

const ARB_OWNER = "0x0000000000000000000000000000000000000070" as const;
const TOKEN_BRIDGE_CREATOR_SCRIPT = "./scripts/deployment/deployTokenBridgeCreator.ts";
const FUNDING_RESERVE_WEI = 1n * 10n ** 18n;
const TOKENBRIDGE_DEPLOYER_TARGET_L2_WEI = 100n * 10n ** 18n;
const TOKENBRIDGE_DEPLOYER_TARGET_L3_WEI = 10n * 10n ** 18n;
const TOKEN_BRIDGE_TX_GAS_LIMIT = 6_000_000n;
const TOKEN_BRIDGE_RETRYABLE_GAS_LIMIT = 20_000_000n;
const TOKEN_BRIDGE_RETRYABLE_SUBMISSION_COST = 4_000_000_000_000n;
const WETH_GATEWAY_RETRYABLE_GAS_LIMIT = 100_000n;
const TOKEN_BRIDGE_POLLING_INTERVAL_MS = 100;

export interface ComposeContext {
	composeFile: string;
	projectName: string;
}

interface BridgeDeployParams {
	compose: ComposeContext;
	configDir: string;
	rollupAddress: string;
	rollupOwnerKey: string;
	parentRpc: string;
	childRpc: string;
	parentKey: string;
	childKey: string;
	tokenBridgeDir: string;
	parentWethOverride?: string;
}

function localNetworkOutputPaths(): string[] {
	return [
		process.env["ARBITRUM_SDK_LOCAL_NETWORK_PATH"] ??
			resolve(import.meta.dirname, "../../../../arbitrum-sdk/packages/sdk/localNetwork.json"),
		process.env["ARBITRUM_PORTAL_LOCAL_NETWORK_PATH"] ??
			resolve(
				import.meta.dirname,
				"../../../../arbitrum-portal/packages/arb-token-bridge-ui/src/util/networksNitroTestnode.generated.json",
			),
	];
}

interface L1L2NetworkFile {
	l2Network?: {
		tokenBridge?: {
			childWeth?: string;
		};
	};
}

interface L2L3NetworkFile {
	l1TokenBridgeCreator?: string;
	tokenBridge?: {
		chain?: {
			upgradeExecutor?: string;
		};
	};
}

interface TokenBridgeContracts {
	parentChainContracts: {
		router: Address;
		standardGateway: Address;
		customGateway: Address;
		wethGateway: Address;
		weth: Address;
		multicall: Address;
	};
	orbitChainContracts: {
		router: Address;
		standardGateway: Address;
		customGateway: Address;
		wethGateway: Address;
		weth: Address;
		multicall: Address;
		proxyAdmin: Address;
		upgradeExecutor: Address;
	};
}

export function parseTokenBridgeCreatorAddress(output: string): string {
	const logicMatch = output.match(
		/L1AtomicTokenBridgeCreator created at address:\s+(0x[a-fA-F0-9]{40})/,
	);
	const logicAddress = logicMatch?.[1];
	if (logicAddress) {
		const proxyRegex = new RegExp(
			`TransparentUpgradeableProxy created at address:\\s+(0x[a-fA-F0-9]{40})\\s+${logicAddress}\\b`,
		);
		const proxyMatch = output.match(proxyRegex);
		const proxyAddress = proxyMatch?.[1];
		if (proxyAddress) {
			return proxyAddress;
		}
	}

	const matches = [...output.matchAll(/L1TokenBridgeCreator:?\s+(0x[a-fA-F0-9]{40})/g)];
	const match = matches.at(-1);
	if (!match) {
		throw new Error(`Failed to parse L1TokenBridgeCreator from output: ${output}`);
	}
	const creatorAddress = match[1];
	if (!creatorAddress) {
		throw new Error(`Failed to parse L1TokenBridgeCreator from output: ${output}`);
	}
	return creatorAddress;
}

async function getBalanceWei(address: Address, rpcUrl: string): Promise<bigint> {
	return getBalanceWeiRpc(address, rpcUrl);
}

async function topUpIfNeeded(
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
	const topUpWei = clampDepositAmount({
		balanceWei: senderBalanceWei,
		desiredWei: targetWei - currentBalanceWei,
		reserveWei: FUNDING_RESERVE_WEI,
	});

	console.log(`[init] Funding ${label} on ${rpcUrl} with ${topUpWei} wei`);
	const account = privateKeyToAccount(senderKey);
	const client = walletClient(rpcUrl, senderKey);
	await client.sendTransaction({
		account,
		to: address,
		value: topUpWei,
	});
}

function readL1L2Network(configDir: string): L1L2NetworkFile {
	return JSON.parse(readFileSync(join(configDir, "l1l2_network.json"), "utf-8")) as L1L2NetworkFile;
}

function readL2L3Network(configDir: string): L2L3NetworkFile {
	return JSON.parse(readFileSync(join(configDir, "l2l3_network.json"), "utf-8")) as L2L3NetworkFile;
}

function readL2ChildWeth(configDir: string): string {
	const childWeth = readL1L2Network(configDir).l2Network?.tokenBridge?.childWeth;
	if (!childWeth) {
		throw new Error("Missing l2Network.tokenBridge.childWeth in l1l2_network.json");
	}
	return childWeth;
}

function readL3UpgradeExecutor(configDir: string): string {
	const upgradeExecutor = readL2L3Network(configDir).tokenBridge?.chain?.upgradeExecutor;
	if (!upgradeExecutor) {
		throw new Error("Missing tokenBridge.chain.upgradeExecutor in l2l3_network.json");
	}
	return upgradeExecutor;
}

function toHostAccessibleRpcUrl(rpcUrl: string): string {
	switch (rpcUrl) {
		case "http://host.docker.internal:8545":
			return "http://127.0.0.1:8545";
		case "http://sequencer:8547":
		case "http://host.docker.internal:8547":
			return "http://127.0.0.1:8547";
		case "http://l3node:8547":
			return "http://127.0.0.1:8549";
		default:
			return rpcUrl;
	}
}

async function readAddressOrZero(
	contractAddress: Address,
	functionName: "outbox" | "rollupEventInbox" | "challengeManager",
	rpcUrl: string,
): Promise<string> {
	return readContractOrZero(contractAddress, rollupAbi, functionName, rpcUrl);
}

/**
 * Verify the token-bridge-contracts workspace has the dependencies the creator
 * deploy spawn requires (the ts-node binary and the deploy script). A fresh
 * sibling checkout has no node_modules, which would otherwise surface as a
 * cryptic ENOENT from the child process. Throws an actionable error instead.
 */
export function assertTokenBridgeDepsPresent(dir: string): void {
	const tsNodeBin = resolve(dir, "node_modules/ts-node/dist/bin.js");
	const deployScript = resolve(dir, TOKEN_BRIDGE_CREATOR_SCRIPT);
	const missing: string[] = [];
	if (!existsSync(tsNodeBin)) {
		missing.push(tsNodeBin);
	}
	if (!existsSync(deployScript)) {
		missing.push(deployScript);
	}
	if (missing.length > 0) {
		throw new Error(
			`token-bridge-contracts dependencies are missing in ${dir} (expected ${missing.join(
				", ",
			)}). Run \`yarn install\` inside token-bridge-contracts, or set TOKEN_BRIDGE_LOCAL_DIR to a checkout with installed dependencies.`,
		);
	}
}

function deployTokenBridgeCreator(params: {
	compose: ComposeContext;
	parentRpc: string;
	parentKey: string;
	tokenBridgeDir: string;
	parentWeth?: string | undefined;
}): string {
	assertTokenBridgeDepsPresent(params.tokenBridgeDir);
	const tokenBridgeTsNode = resolve(params.tokenBridgeDir, "node_modules/ts-node/dist/bin.js");
	const requiresParentDeployGasOverride =
		params.parentRpc !== "http://host.docker.internal:8545" &&
		params.parentRpc !== "http://127.0.0.1:8545";
	const output = execOrThrow(
		"env",
		[
			`BASECHAIN_RPC=${toHostAccessibleRpcUrl(params.parentRpc)}`,
			`BASECHAIN_DEPLOYER_KEY=${params.parentKey}`,
			`BASECHAIN_WETH=${params.parentWeth ?? ""}`,
			...(requiresParentDeployGasOverride ? ["DEPLOY_GAS_LIMIT=50000000"] : []),
			`POLLING_INTERVAL=${TOKEN_BRIDGE_POLLING_INTERVAL_MS}`,
			"DISABLE_CONTRACT_VERIFICATION=true",
			"GAS_LIMIT_FOR_L2_FACTORY_DEPLOYMENT=10000000",
			"node",
			tokenBridgeTsNode,
			TOKEN_BRIDGE_CREATOR_SCRIPT,
		],
		{
			cwd: params.tokenBridgeDir,
			timeout: 600_000,
		},
	);
	return parseTokenBridgeCreatorAddress(output);
}

function waitForCreatorSettlement(seconds = 10): void {
	execOrThrow("sleep", [String(seconds)], { timeout: (seconds + 1) * 1000 });
}

async function deployChildChainFromSpec(
	params: BridgeDeployParams & {
		parentRpc: string;
		childRpc: string;
		tokenBridgeCreator: Address;
		deployment: ReturnType<typeof readDeploymentArtifact>;
		outbox: string;
		chainName: string;
		chainId: number;
		parentChainId: number;
		outputDirName: "l2" | "l3";
	},
): Promise<TokenBridgeContracts> {
	mkdirSync(getAdminOutputDir(params.configDir, params.outputDirName), { recursive: true });

	const nativeTokenAddress = params.deployment["native-token"] as Address | undefined;
	const parentChainPublicClient = publicClient(params.parentRpc);
	const orbitChainPublicClient = publicClient(params.childRpc);
	const deployTokenBridgeContracts = async (): Promise<TokenBridgeContracts> => {
		const result = await createTokenBridge({
			rollupOwner: privateKeyToAccount(params.rollupOwnerKey as `0x${string}`).address,
			rollupAddress: params.rollupAddress as Address,
			rollupDeploymentBlockNumber: BigInt(params.deployment["deployed-at"] ?? 0),
			account: privateKeyToAccount(params.parentKey as `0x${string}`),
			...(nativeTokenAddress && nativeTokenAddress !== ZERO_ADDRESS ? { nativeTokenAddress } : {}),
			parentChainPublicClient,
			orbitChainPublicClient,
			tokenBridgeCreatorAddressOverride: params.tokenBridgeCreator,
			gasOverrides: {
				gasLimit: {
					base: TOKEN_BRIDGE_TX_GAS_LIMIT,
				},
			},
			retryableGasOverrides: {
				maxGasForFactory: {
					base: TOKEN_BRIDGE_RETRYABLE_GAS_LIMIT,
				},
				maxGasForContracts: {
					base: TOKEN_BRIDGE_RETRYABLE_GAS_LIMIT,
				},
				maxSubmissionCostForFactory: {
					base: TOKEN_BRIDGE_RETRYABLE_SUBMISSION_COST,
				},
				maxSubmissionCostForContracts: {
					base: TOKEN_BRIDGE_RETRYABLE_SUBMISSION_COST,
				},
			},
			setWethGatewayGasOverrides: {
				gasLimit: {
					base: WETH_GATEWAY_RETRYABLE_GAS_LIMIT,
				},
			},
		});
		return result.tokenBridgeContracts;
	};
	const fetchExistingTokenBridgeContracts = async (): Promise<TokenBridgeContracts> =>
		createTokenBridgeFetchTokenBridgeContracts({
			inbox: params.deployment.inbox as Address,
			parentChainPublicClient,
			tokenBridgeCreatorAddressOverride: params.tokenBridgeCreator,
		});
	const tokenBridgeContracts = await deployChildChainWithRecovery({
		deploy: deployTokenBridgeContracts,
		fetchExisting: fetchExistingTokenBridgeContracts,
	});
	if (!nativeTokenAddress || nativeTokenAddress === ZERO_ADDRESS) {
		await ensureWethGatewayRegistered({
			rollupAddress: params.rollupAddress as Address,
			rollupDeploymentBlockNumber: BigInt(params.deployment["deployed-at"] ?? 0),
			parentChainPublicClient,
			orbitChainPublicClient,
			parentKey: params.parentKey as `0x${string}`,
			tokenBridgeCreator: params.tokenBridgeCreator,
		});
	}

	writeBridgeUiConfig({
		configDir: params.configDir,
		outputDirName: params.outputDirName,
		chainName: params.chainName,
		parentChainId: params.parentChainId,
		chainId: params.chainId,
		parentRpc: params.parentRpc,
		childRpc: params.childRpc,
		deployment: params.deployment,
		outbox: params.outbox,
		tokenBridgeContracts,
	});
	return tokenBridgeContracts;
}

async function deployChildChainWithRecovery(input: {
	deploy: () => Promise<TokenBridgeContracts>;
	fetchExisting: () => Promise<TokenBridgeContracts>;
}): Promise<TokenBridgeContracts> {
	try {
		return await input.deploy();
	} catch (error) {
		if (shouldFetchExistingChildDeploy(error)) {
			console.warn("[init] Token bridge already exists; loading deployed contract addresses");
			return input.fetchExisting();
		}
		if (!shouldRetryChildDeploy(error)) {
			throw error;
		}
		console.warn("[init] Token bridge deployment wrote partial state; retrying once");
		try {
			return await input.deploy();
		} catch (retryError) {
			if (shouldFetchExistingChildDeploy(retryError)) {
				console.warn(
					"[init] Token bridge already exists after retry; loading deployed contract addresses",
				);
				return input.fetchExisting();
			}
			throw retryError;
		}
	}
}

async function ensureWethGatewayRegistered(input: {
	rollupAddress: Address;
	rollupDeploymentBlockNumber: bigint;
	parentChainPublicClient: ReturnType<typeof publicClient>;
	orbitChainPublicClient: ReturnType<typeof publicClient>;
	parentKey: `0x${string}`;
	tokenBridgeCreator: Address;
}): Promise<void> {
	const account = privateKeyToAccount(input.parentKey);
	let txRequest: Awaited<
		ReturnType<typeof createTokenBridgePrepareSetWethGatewayTransactionRequest>
	>;
	try {
		txRequest = await createTokenBridgePrepareSetWethGatewayTransactionRequest({
			rollup: input.rollupAddress,
			rollupDeploymentBlockNumber: input.rollupDeploymentBlockNumber,
			parentChainPublicClient: input.parentChainPublicClient,
			orbitChainPublicClient: input.orbitChainPublicClient,
			account: account.address,
			tokenBridgeCreatorAddressOverride: input.tokenBridgeCreator,
			retryableGasOverrides: {
				gasLimit: {
					base: WETH_GATEWAY_RETRYABLE_GAS_LIMIT,
				},
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("weth gateway is already registered in the router")) {
			return;
		}
		throw error;
	}

	console.log("[init] Registering WETH gateway");
	const txHash = await input.parentChainPublicClient.sendRawTransaction({
		serializedTransaction: await account.signTransaction(txRequest),
	});
	const txReceipt = createTokenBridgePrepareSetWethGatewayTransactionReceipt(
		await input.parentChainPublicClient.waitForTransactionReceipt({ hash: txHash }),
	);
	const retryableReceipts = await txReceipt.waitForRetryables({
		orbitPublicClient: input.orbitChainPublicClient,
	});
	const retryableReceipt = retryableReceipts[0];
	if (retryableReceipt?.status !== "success") {
		throw new Error(
			`Retryable status is not success: ${retryableReceipt?.status ?? "missing"}. Aborting...`,
		);
	}
}

function shouldFetchExistingChildDeploy(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("already deployed") || message.includes("already included");
}

function shouldRetryChildDeploy(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes("Unexpected status for retryable ticket") ||
		message.includes("already included") ||
		message.includes("inboxToL1Deployment") ||
		message.includes("inboxToL2Deployment") ||
		message.includes("l1TokenToGateway")
	);
}

function writeBridgeUiConfig(input: {
	configDir: string;
	outputDirName: "l2" | "l3";
	chainName: string;
	parentChainId: number;
	chainId: number;
	parentRpc: string;
	childRpc: string;
	deployment: ReturnType<typeof readDeploymentArtifact>;
	outbox: string;
	tokenBridgeContracts: TokenBridgeContracts;
}): void {
	const outputDir = getAdminOutputDir(input.configDir, input.outputDirName);
	const parent = input.tokenBridgeContracts.parentChainContracts;
	const child = input.tokenBridgeContracts.orbitChainContracts;
	const nativeToken = input.deployment["native-token"] ?? ZERO_ADDRESS;
	// Custom-fee (ERC20 gas token) L3 chains don't get a WETH gateway from the Orbit
	// token-bridge deployment, so parentChain.weth comes back as the zero address. The
	// portal E2E setup deposits this address as a normal ERC20, and a zero address makes
	// the gateway revert L1_NOT_CONTRACT. Backfill it with the parent chain's real WETH
	// (the L2 WETH recorded as l2Network.tokenBridge.childWeth) so the deposit routes
	// through the standard ERC20 gateway instead of reverting.
	const isCustomFeeChild = input.outputDirName === "l3" && nativeToken !== ZERO_ADDRESS;
	const parentWeth =
		isCustomFeeChild && parent.weth === ZERO_ADDRESS
			? (readL2ChildWeth(input.configDir) as typeof parent.weth)
			: parent.weth;
	const bridgeUiConfig: BridgeUiConfigFile = {
		chainName: input.chainName,
		parentChainId: input.parentChainId,
		chainId: input.chainId,
		rollup: input.deployment.rollup,
		parentChainRpc: input.parentRpc,
		chainRpc: input.childRpc,
		nativeToken,
		coreContracts: {
			bridge: input.deployment.bridge,
			inbox: input.deployment.inbox,
			outbox: input.outbox,
			rollup: input.deployment.rollup,
			sequencerInbox: input.deployment["sequencer-inbox"],
		},
		tokenBridge: {
			parentChain: {
				router: parent.router,
				standardGateway: parent.standardGateway,
				customGateway: parent.customGateway,
				wethGateway: parent.wethGateway,
				weth: parentWeth,
				multicall: parent.multicall,
			},
			chain: {
				router: child.router,
				standardGateway: child.standardGateway,
				customGateway: child.customGateway,
				wethGateway: child.wethGateway,
				weth: child.weth,
				multicall: child.multicall,
				proxyAdmin: child.proxyAdmin,
			},
		},
	};
	writeFileSync(
		join(outputDir, "bridgeUiConfig.json"),
		`${JSON.stringify(bridgeUiConfig, null, 2)}\n`,
	);
}

function publishLocalNetworkArtifacts(configDir: string): void {
	const localNetworkPath = join(configDir, "localNetwork.json");
	if (!existsSync(localNetworkPath)) {
		return;
	}

	const localNetwork = readFileSync(localNetworkPath, "utf-8");
	for (const targetPath of localNetworkOutputPaths()) {
		mkdirSync(dirname(targetPath), { recursive: true });
		writeFileSync(targetPath, localNetwork);
	}
}

async function setL3ChainOwners(l3RpcUrl: string, upgradeExecutorAddress: Address): Promise<void> {
	const l3OwnerAccount = privateKeyToAccount(accounts.l3owner.privateKey);
	const client = walletClient(l3RpcUrl, accounts.l3owner.privateKey);
	await client.writeContract({
		account: l3OwnerAccount,
		address: ARB_OWNER,
		abi: arbOwnerAbi,
		functionName: "addChainOwner",
		args: [upgradeExecutorAddress],
	});

	await client.writeContract({
		account: l3OwnerAccount,
		address: ARB_OWNER,
		abi: arbOwnerAbi,
		functionName: "removeChainOwner",
		args: [accounts.l3owner.address],
	});
}

function recordChainOwnerUpgradeExecutor(configDir: string, address: Address): void {
	for (const fileName of ["l3_deployment.json", "l3deployment.json"]) {
		const filePath = join(configDir, fileName);
		if (!existsSync(filePath)) {
			continue;
		}
		const deployment = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
		deployment["chain-owner-upgrade-executor"] = address;
		writeFileSync(filePath, `${JSON.stringify(deployment, null, 2)}\n`);
	}
}

export async function transferL3OwnershipToOrbitUpgradeExecutor(
	configDir: string,
	l3RpcUrl: string,
	orbitUpgradeExecutor: Address,
): Promise<void> {
	await setL3ChainOwners(l3RpcUrl, orbitUpgradeExecutor);
	recordChainOwnerUpgradeExecutor(configDir, orbitUpgradeExecutor);
}

export async function ensureL2L3TokenBridgeFunding(
	l2RpcUrl: string,
	l3RpcUrl: string,
): Promise<void> {
	await topUpIfNeeded(
		accounts.l3owner.address,
		TOKENBRIDGE_DEPLOYER_TARGET_L2_WEI,
		l2RpcUrl,
		accounts.funnel.privateKey,
		"l3owner tokenbridge deployer on L2",
	);
	await topUpIfNeeded(
		accounts.l3owner.address,
		TOKENBRIDGE_DEPLOYER_TARGET_L3_WEI,
		l3RpcUrl,
		accounts.funnel.privateKey,
		"l3owner tokenbridge deployer on L3",
	);
}

export async function deployL1L2TokenBridge(params: BridgeDeployParams): Promise<void> {
	const specPath = getChainSpecPath(params.configDir, "l2");
	const parentRpc = toHostAccessibleRpcUrl(params.parentRpc);
	const childRpc = toHostAccessibleRpcUrl(params.childRpc);
	const l2Deployment = readDeploymentArtifact(params.configDir, "l2_deployment.json");
	const tokenBridgeCreator = deployTokenBridgeCreator({
		compose: params.compose,
		parentRpc: params.parentRpc,
		parentKey: params.parentKey,
		tokenBridgeDir: params.tokenBridgeDir,
		parentWeth: l2Deployment["stake-token"] ?? ZERO_ADDRESS,
	});
	waitForCreatorSettlement();
	const rollupAddress = params.rollupAddress as Address;
	const parentDeployment = createParentDeployment({
		deployment: l2Deployment,
		outbox: await readAddressOrZero(rollupAddress, "outbox", parentRpc),
		rollupEventInbox: await readAddressOrZero(rollupAddress, "rollupEventInbox", parentRpc),
		challengeManager: await readAddressOrZero(rollupAddress, "challengeManager", parentRpc),
	});
	const spec = createChainSpec({
		chainName: "arb-dev-test",
		chainId: 412346,
		parentChainId: 1337,
		parentRpc,
		chainRpc: childRpc,
		tokenBridgeCreator,
		parentDeployment,
		owner: accounts.l2owner.address,
	});
	writeChainSpecFile(specPath, spec);
	await deployChildChainFromSpec({
		...params,
		parentRpc,
		childRpc,
		tokenBridgeCreator: tokenBridgeCreator as Address,
		deployment: l2Deployment,
		outbox: parentDeployment.outbox,
		chainName: "arb-dev-test",
		chainId: 412346,
		parentChainId: 1337,
		outputDirName: "l2",
	});
	writeSdkNetworkFileFromBridgeUiConfig(
		params.configDir,
		getAdminOutputDir(params.configDir, "l2"),
		"l1l2_network.json",
		"l2Network",
	);
	writeCombinedLocalNetworkFile(params.configDir);
	publishLocalNetworkArtifacts(params.configDir);
}

export async function deployL2L3TokenBridge(params: BridgeDeployParams): Promise<Address> {
	const specPath = getChainSpecPath(params.configDir, "l3");
	const parentRpc = toHostAccessibleRpcUrl(params.parentRpc);
	const childRpc = toHostAccessibleRpcUrl(params.childRpc);
	const l3Deployment = readDeploymentArtifact(params.configDir, "l3_deployment.json");
	const tokenBridgeCreator = deployTokenBridgeCreator({
		compose: params.compose,
		parentRpc: params.parentRpc,
		parentKey: params.parentKey,
		tokenBridgeDir: params.tokenBridgeDir,
		parentWeth: params.parentWethOverride,
	});
	waitForCreatorSettlement();
	const rollupAddress = params.rollupAddress as Address;
	const parentDeployment = createParentDeployment({
		deployment: l3Deployment,
		outbox: await readAddressOrZero(rollupAddress, "outbox", parentRpc),
		rollupEventInbox: await readAddressOrZero(rollupAddress, "rollupEventInbox", parentRpc),
		challengeManager: await readAddressOrZero(rollupAddress, "challengeManager", parentRpc),
	});
	const spec = createChainSpec({
		chainName: "orbit-dev-test",
		chainId: 333333,
		parentChainId: 412346,
		parentRpc,
		chainRpc: childRpc,
		tokenBridgeCreator,
		parentDeployment,
		ownership: {
			addChainOwners: [l3Deployment["upgrade-executor"]],
			removeDeployer: true,
		},
		owner: accounts.l3owner.address,
	});
	writeChainSpecFile(specPath, spec);
	const tokenBridgeContracts = await deployChildChainFromSpec({
		...params,
		parentRpc,
		childRpc,
		tokenBridgeCreator: tokenBridgeCreator as Address,
		deployment: l3Deployment,
		outbox: parentDeployment.outbox,
		chainName: "orbit-dev-test",
		chainId: 333333,
		parentChainId: 412346,
		outputDirName: "l3",
	});
	writeSdkNetworkFileFromBridgeUiConfig(
		params.configDir,
		getAdminOutputDir(params.configDir, "l3"),
		"l2l3_network.json",
		"l3Network",
	);
	writeCombinedLocalNetworkFile(params.configDir);
	publishLocalNetworkArtifacts(params.configDir);
	return tokenBridgeContracts.orbitChainContracts.upgradeExecutor;
}

export async function transferL3ChainOwnership(
	configDir: string,
	_l2RpcUrl: string,
	l3RpcUrl: string,
): Promise<void> {
	const upgradeExecutor = readL3UpgradeExecutor(configDir);
	await setL3ChainOwners(l3RpcUrl, upgradeExecutor as Address);
}

export function getL2ChildWeth(configDir: string): string {
	return readL2ChildWeth(configDir);
}
