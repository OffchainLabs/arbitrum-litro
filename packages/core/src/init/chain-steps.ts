import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address } from "viem";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { accounts } from "../accounts.js";
import { writeChainConfig } from "../chain-config.js";
import { clampDepositAmount } from "../deposit-amount.js";
import { composeRestart, composeUp, waitForRpc } from "../docker.js";
import { exec, execOrThrow } from "../exec.js";
import { deployFeeTokenPricer } from "../fee-token-pricer.js";
import { deployTestErc20, testErc20Abi } from "../fee-token.js";
import { ZERO_ADDRESS } from "../init-helpers.js";
import { patchGeneratedL2NodeConfig, patchGeneratedL3NodeConfig } from "../node-config-patches.js";
import { inboxAbi, publicClient, rollupAbi, walletClient } from "../rpc.js";
import { startL1Container } from "../runtime.js";
import { deployRollupViaSdk, prepareNodeConfigFromDeployment } from "../sdk-chain.js";
import type { InitState } from "../state.js";
import { markStepDone } from "../state.js";
import type { TokenBridgeSource } from "../token-bridge-source.js";
import {
	deployL1L2TokenBridge,
	deployL2L3TokenBridge,
	ensureL2L3TokenBridgeFunding,
	getL2ChildWeth,
	transferL3OwnershipToOrbitUpgradeExecutor,
} from "../token-bridge.js";
import { ensureValidatorWalletStaked } from "../validator-wallet.js";
import type { InitRuntime } from "./context.js";
import {
	type DeployerImageSpec,
	type NitroContractsSource,
	resolveDeployerImageSpec,
} from "./nitro-contracts-source.js";

const L1_RPC = "http://127.0.0.1:8545";
const L1_BEACON_RPC = "http://127.0.0.1:5555";
const L2_RPC = "http://127.0.0.1:8547";
const L3_RPC = "http://127.0.0.1:8549";

// Docker-internal URLs
const L1_RPC_DOCKER = "http://host.docker.internal:8545";
const L1_BEACON_RPC_DOCKER = "http://host.docker.internal:5555";
const L2_RPC_DOCKER = "http://host.docker.internal:8547";
const L2_RPC_INTERNAL = "http://sequencer:8547";

const L2_DEPOSIT_READY_THRESHOLD_WEI = 250n * 10n ** 18n;
const L3_DEPOSIT_TARGET_WEI = 50n * 10n ** 18n;
const L3_DEPOSIT_RESERVE_WEI = 1n * 10n ** 18n;
const L3_DEPOSIT_READY_THRESHOLD_WEI = 10n * 10n ** 18n;
const L2_OWNER_DEPLOYER_FUNDING_WEI = 100n * 10n ** 18n;
const CONTRACT_DEPLOYER_POLLING_INTERVAL_MS = 100;
const CONTRACT_DEPLOYER_CREATE2_CONFIRMATIONS = 1;
const WASM_MODULE_ROOT = "0xdb698a2576298f25448bc092e52cf13b1e24141c997135d70f217d674bbeb69a";

interface RollupCreatorDeployment {
	rollupCreator: Address;
	stakeToken: Address;
}

interface TimeboostAuctionDeployment {
	auctionContract: Address;
	auctioneer: Address;
	beneficiary: Address;
	biddingToken: Address;
}

import type { StepRunner } from "./support.js";
import {
	applyGasEstimationWorkaround,
	copyConfigFile,
	ensureL2ValidatorFunding,
	fundL3ParentChainAccounts,
	getBalanceWei,
	patchConfigUrl,
	readDeployment,
	readJsonFile,
	sendZeroAddressTransfer,
	setL3StakerEnabled,
	waitForBalanceAtLeast,
	waitForL3RpcWithParentChainNudges,
} from "./support.js";

const builtContractDeployerImages = new Set<string>();

export async function ensureContractDeployerImage(
	runtime: InitRuntime,
	spec: DeployerImageSpec,
	forceRebuild = false,
	commands: { exec: typeof exec; execOrThrow: typeof execOrThrow } = { exec, execOrThrow },
): Promise<void> {
	const { image, dockerfile, buildContext, reuseImage } = spec;
	// forceRebuild (stale-image recovery) must rebuild even if we already built
	// this tag this run; drop the in-run marker so the build below actually runs.
	if (forceRebuild) {
		builtContractDeployerImages.delete(image);
	} else if (builtContractDeployerImages.has(image)) {
		console.log(`[init] Contract deployer image already built this run: ${image}`);
		return;
	}
	if (!forceRebuild && reuseImage) {
		console.log(`[init] Checking contract deployer image: ${image}`);
		const inspect = commands.exec("docker", ["image", "inspect", image], {
			timeout: 30_000,
		});
		if (inspect.exitCode === 0) {
			console.log(`[init] Contract deployer image found: ${image}`);
			builtContractDeployerImages.add(image);
			return;
		}
	}
	// Named contexts require BuildKit. Set this explicitly so older daemons do
	// not fall back to the classic builder.
	process.env["DOCKER_BUILDKIT"] ??= "1";
	console.log(`[init] Building contract deployer image: ${image}`);
	commands.execOrThrow(
		"docker",
		[
			"build",
			"--progress=plain",
			"--build-context",
			`nitrocontracts=${buildContext}`,
			"-t",
			image,
			"-f",
			resolve(runtime.projectRoot, dockerfile),
			resolve(runtime.projectRoot, "docker"),
		],
		{ timeout: 1_800_000 },
	);
	console.log(`[init] Contract deployer image built: ${image}`);
	builtContractDeployerImages.add(image);
}

async function deployRollupCreatorViaDocker(
	runtime: InitRuntime,
	params: {
		hostParentRpc: string;
		dockerParentRpc: string;
		deployerKey: string;
		maxDataSize: string;
		nitroContractsSource: NitroContractsSource;
		retryAfterImageRebuild?: boolean;
	},
): Promise<RollupCreatorDeployment> {
	const retryAfterImageRebuild = params.retryAfterImageRebuild ?? true;
	const spec = resolveDeployerImageSpec(params.nitroContractsSource);
	const image = spec.image;
	await ensureContractDeployerImage(runtime, spec);
	await waitForRpc(params.hostParentRpc);
	console.log(`[init] Deploying RollupCreator on ${params.dockerParentRpc}`);
	const args = [
		"run",
		"--rm",
		"--add-host",
		"host.docker.internal:host-gateway",
		"--workdir",
		"/workspace/nitro-contracts",
		"-v",
		`${runtime.configDir}:/config`,
		"-e",
		`PARENT_CHAIN_RPC=${params.dockerParentRpc}`,
		"-e",
		`DEPLOYER_PRIVKEY=${params.deployerKey}`,
		"-e",
		`MAX_DATA_SIZE=${params.maxDataSize}`,
		"-e",
		`POLLING_INTERVAL=${CONTRACT_DEPLOYER_POLLING_INTERVAL_MS}`,
		"-e",
		`CREATE2_CONFIRMATIONS=${CONTRACT_DEPLOYER_CREATE2_CONFIRMATIONS}`,
		"-e",
		"ROLLUP_CREATOR_OUTPUT=/config/rollup_creator.json",
		image,
		"hardhat",
		"run",
		"--no-compile",
		"scripts/local-deployment/deployRollupCreatorOnly.ts",
	];
	execOrThrow("docker", args, { timeout: 900_000 });
	const output = readJsonFile<{ rollupCreator?: string; stakeToken?: string }>(
		runtime,
		"rollup_creator.json",
	);
	if (!output.rollupCreator) {
		throw new Error("RollupCreator deployment did not write a contract address");
	}
	if (!output.stakeToken) {
		if (retryAfterImageRebuild) {
			console.warn("[init] Contract deployer image is stale; rebuilding and retrying once");
			await ensureContractDeployerImage(runtime, spec, true);
			return deployRollupCreatorViaDocker(runtime, {
				...params,
				retryAfterImageRebuild: false,
			});
		}
		throw new Error("RollupCreator deployment did not write a stake token address");
	}
	console.log(`[init] RollupCreator deployed at ${output.rollupCreator}`);
	console.log(`[init] Stake token deployed at ${output.stakeToken}`);
	return {
		rollupCreator: output.rollupCreator as Address,
		stakeToken: output.stakeToken as Address,
	};
}

async function deployTimeboostAuctionViaDocker(
	runtime: InitRuntime,
	params: {
		hostRpc: string;
		dockerRpc: string;
		deployerKey: string;
		nitroContractsSource: NitroContractsSource;
	},
): Promise<TimeboostAuctionDeployment> {
	const spec = resolveDeployerImageSpec(params.nitroContractsSource);
	await ensureContractDeployerImage(runtime, spec);
	await waitForRpc(params.hostRpc);
	console.log(`[init] Deploying Timeboost auction contract on ${params.dockerRpc}`);
	const args = [
		"run",
		"--rm",
		"--add-host",
		"host.docker.internal:host-gateway",
		"--workdir",
		"/workspace/nitro-contracts",
		"-v",
		`${runtime.configDir}:/config`,
		"-e",
		`CHAIN_RPC=${params.dockerRpc}`,
		"-e",
		`DEPLOYER_PRIVKEY=${params.deployerKey}`,
		"-e",
		`CUSTOM_RPC_URL=${params.dockerRpc}`,
		"-e",
		`CUSTOM_PRIVKEY=${params.deployerKey}`,
		"-e",
		`POLLING_INTERVAL=${CONTRACT_DEPLOYER_POLLING_INTERVAL_MS}`,
		"-e",
		`TIMEBOOST_AUCTIONEER_ADDRESS=${accounts.auctioneer.address}`,
		"-e",
		`TIMEBOOST_ADMIN_ADDRESS=${accounts.l2owner.address}`,
		"-e",
		`TIMEBOOST_BENEFICIARY_ADDRESS=${accounts.l2owner.address}`,
		"-e",
		"TIMEBOOST_AUCTION_OUTPUT=/config/timeboost-auction.json",
		spec.image,
		"hardhat",
		"run",
		"--no-compile",
		"--network",
		"custom",
		"scripts/local-deployment/deployTimeboostAuction.ts",
	];
	execOrThrow("docker", args, { timeout: 900_000 });

	const output = readJsonFile<{
		auctionContract?: string;
		auctioneer?: string;
		beneficiary?: string;
		biddingToken?: string;
	}>(runtime, "timeboost-auction.json");
	if (!output.auctionContract) {
		throw new Error("Timeboost auction deployment did not write an auction contract address");
	}
	if (!output.biddingToken) {
		throw new Error("Timeboost auction deployment did not write a bidding token address");
	}
	console.log(`[init] Timeboost auction deployed at ${output.auctionContract}`);
	console.log(`[init] Timeboost bidding token deployed at ${output.biddingToken}`);
	return {
		auctionContract: output.auctionContract as Address,
		auctioneer: (output.auctioneer ?? accounts.auctioneer.address) as Address,
		beneficiary: (output.beneficiary ?? accounts.l2owner.address) as Address,
		biddingToken: output.biddingToken as Address,
	};
}

async function fundL2OwnerForContractDeployments(): Promise<void> {
	const funnelAccount = privateKeyToAccount(accounts.funnel.privateKey);
	for (const rpcUrl of [L1_RPC, L2_RPC]) {
		console.log(`[init] Funding l2owner on ${rpcUrl} with ${L2_OWNER_DEPLOYER_FUNDING_WEI} wei`);
		const client = walletClient(rpcUrl, accounts.funnel.privateKey);

		await client.sendTransaction({
			account: funnelAccount,
			to: accounts.l2owner.address,
			value: L2_OWNER_DEPLOYER_FUNDING_WEI,
		});
	}
}

function createL1Steps(runtime: InitRuntime): Record<string, StepRunner> {
	return {
		"start-l1": async (state) => {
			startL1Container(runtime);
			return markStepDone(state, "start-l1");
		},
		"wait-l1": async (state) => {
			await waitForRpc(L1_RPC);
			return markStepDone(state, "wait-l1");
		},
	};
}

function createL2DeploySteps(
	runtime: InitRuntime,
	nitroContractsSource: NitroContractsSource,
): Record<string, StepRunner> {
	return {
		"deploy-l2-rollup": async (state) => {
			writeChainConfig(runtime.configDir, "l2_chain_config.json", {
				chainId: 412346,
				owner: accounts.l2owner.address,
			});
			const rollupCreatorDeployment = await deployRollupCreatorViaDocker(runtime, {
				hostParentRpc: L1_RPC,
				dockerParentRpc: L1_RPC_DOCKER,
				deployerKey: accounts.l2owner.privateKey,
				maxDataSize: "117964",
				nitroContractsSource,
			});
			await deployRollupViaSdk({
				chainConfigPath: resolve(runtime.configDir, "l2_chain_config.json"),
				chainId: 412346,
				chainName: "arb-dev-test",
				parentChainId: 1337,
				parentChainIsArbitrum: false,
				parentRpcUrl: L1_RPC,
				parentBeaconRpcUrl: L1_BEACON_RPC,
				ownerAddress: accounts.l2owner.address,
				ownerKey: accounts.l2owner.privateKey,
				batchPosterAddress: accounts.sequencer.address,
				batchPosterKey: accounts.sequencer.privateKey,
				validatorAddress: accounts.validator.address,
				validatorKey: accounts.validator.privateKey,
				maxDataSize: 117964n,
				wasmModuleRoot: WASM_MODULE_ROOT as `0x${string}`,
				deploymentOutputPath: resolve(runtime.configDir, "l2_deployment.json"),
				chainInfoOutputPath: resolve(runtime.configDir, "l2_chain_info.json"),
				rawNodeConfigOutputPath: resolve(runtime.configDir, "l2-nodeConfig.raw.json"),
				rollupCreatorAddress: rollupCreatorDeployment.rollupCreator,
				stakeToken: rollupCreatorDeployment.stakeToken,
			});
			copyConfigFile(runtime, "l2_deployment.json", "deployment.json");
			const deployment = readDeployment(runtime, "l2_deployment.json");
			return markStepDone(state, "deploy-l2-rollup", {
				rollup: deployment["rollup"],
				inbox: deployment["inbox"],
				bridge: deployment["bridge"],
				sequencerInbox: deployment["sequencer-inbox"],
				upgradeExecutor: deployment["upgrade-executor"],
				validatorWalletCreator: deployment["validator-wallet-creator"] ?? ZERO_ADDRESS,
				stakeToken: deployment["stake-token"] ?? ZERO_ADDRESS,
			});
		},
		"generate-l2-config": async (state) => {
			const rollupData = state.steps["deploy-l2-rollup"]?.data;
			if (!rollupData) {
				throw new Error("Missing l2 rollup deployment data");
			}
			const nodeConfig = prepareNodeConfigFromDeployment({
				chainName: "arb-dev-test",
				chainConfig: readJsonFile(runtime, "l2_chain_config.json"),
				deployment: readJsonFile(runtime, "l2_deployment.json"),
				parentChainId: 1337,
				parentChainRpcUrl: L1_RPC,
				parentChainBeaconRpcUrl: L1_BEACON_RPC,
				batchPosterPrivateKey: accounts.sequencer.privateKey,
				validatorPrivateKey: accounts.validator.privateKey,
			});
			writeFileSync(
				resolve(runtime.configDir, "nodeConfig.json"),
				JSON.stringify(nodeConfig, null, 2),
			);
			// Patch parent RPC URL for Docker networking
			patchConfigUrl(resolve(runtime.configDir, "nodeConfig.json"), L1_RPC, L1_RPC_DOCKER);
			patchConfigUrl(
				resolve(runtime.configDir, "nodeConfig.json"),
				L1_BEACON_RPC,
				L1_BEACON_RPC_DOCKER,
			);
			const src = resolve(runtime.configDir, "nodeConfig.json");
			const dest = resolve(runtime.configDir, "l2-nodeConfig.json");
			const config = JSON.parse(readFileSync(src, "utf-8")) as Record<string, unknown>;
			const stakeToken = (rollupData["stakeToken"] as string | undefined) ?? ZERO_ADDRESS;
			const patched = patchGeneratedL2NodeConfig(
				config,
				accounts.sequencer.privateKey,
				stakeToken,
				accounts.validator.privateKey,
			);
			writeFileSync(dest, `${JSON.stringify(patched, null, 2)}\n`, "utf-8");
			if (stakeToken !== ZERO_ADDRESS) {
				await ensureL2ValidatorFunding(
					rollupData["rollup"] as Address,
					stakeToken as Address,
					rollupData["validatorWalletCreator"] as string,
				);
			}
			return markStepDone(state, "generate-l2-config");
		},
	};
}

function createL2RuntimeSteps(
	runtime: InitRuntime,
	nitroContractsSource: NitroContractsSource,
	tokenBridgeSource: TokenBridgeSource,
): Record<string, StepRunner> {
	return {
		"start-l2": async (state) => {
			composeUp(["sequencer", "validator"], runtime.dockerOpts);
			return markStepDone(state, "start-l2");
		},
		"wait-l2": async (state) => {
			await waitForRpc(L2_RPC, 120_000);
			return markStepDone(state, "wait-l2");
		},
		"deploy-timeboost-auction": async (state) => {
			const deployment = await deployTimeboostAuctionViaDocker(runtime, {
				hostRpc: L2_RPC,
				dockerRpc: L2_RPC_DOCKER,
				deployerKey: accounts.l2owner.privateKey,
				nitroContractsSource,
			});
			return markStepDone(state, "deploy-timeboost-auction", { ...deployment });
		},
		"restart-l2-timeboost": async (state) => {
			const auctionData = state.steps["deploy-timeboost-auction"]?.data;
			if (!auctionData?.["auctionContract"]) {
				throw new Error("Missing Timeboost auction deployment data");
			}
			composeUp(["timeboost-redis"], runtime.dockerOpts);
			composeRestart(["sequencer"], runtime.dockerOpts);
			return markStepDone(state, "restart-l2-timeboost", {
				auctionContract: auctionData["auctionContract"],
			});
		},
		"wait-l2-timeboost": async (state) => {
			await waitForRpc(L2_RPC, 120_000);
			return markStepDone(state, "wait-l2-timeboost");
		},
		"deposit-eth-to-l2": async (state) => {
			const rollupData = state.steps["deploy-l2-rollup"]?.data;
			if (!rollupData) {
				throw new Error("Missing l2 rollup deployment data");
			}
			const currentL2BalanceWei = await getBalanceWei(accounts.funnel.address, L2_RPC);
			if (currentL2BalanceWei >= L2_DEPOSIT_READY_THRESHOLD_WEI) {
				console.log("[init] L2 funnel already funded; skipping inbox deposit");
				return markStepDone(state, "deposit-eth-to-l2", {
					skipped: true,
					reason: "l2 funnel already has balance",
				});
			}
			const inbox = rollupData["inbox"] as Address;
			// Call depositEth() on the Inbox contract with ETH value
			const funnelAccount = privateKeyToAccount(accounts.funnel.privateKey);
			const client = walletClient(L1_RPC, accounts.funnel.privateKey);
			await client.writeContract({
				account: funnelAccount,
				address: inbox,
				abi: inboxAbi,
				functionName: "depositEth",
				value: parseEther("100000"),
			});
			await waitForBalanceAtLeast(accounts.funnel.address, L2_RPC, L2_DEPOSIT_READY_THRESHOLD_WEI);
			return markStepDone(state, "deposit-eth-to-l2");
		},
		"fund-l2owner": async (state) => {
			await fundL2OwnerForContractDeployments();
			return markStepDone(state, "fund-l2owner");
		},
		"deploy-l2-token-bridge": async (state) => {
			const rollupData = state.steps["deploy-l2-rollup"]?.data;
			if (!rollupData) {
				throw new Error("Missing l2 rollup deployment data");
			}
			await new Promise((resolve) => setTimeout(resolve, 10_000));
			await deployL1L2TokenBridge({
				compose: runtime.dockerOpts,
				configDir: runtime.configDir,
				rollupAddress: rollupData["rollup"] as string,
				rollupOwnerKey: accounts.l2owner.privateKey,
				parentRpc: L1_RPC_DOCKER,
				childRpc: L2_RPC_INTERNAL,
				parentKey: accounts.l2owner.privateKey,
				childKey: accounts.l2owner.privateKey,
				tokenBridgeDir: tokenBridgeSource.path,
			});
			return markStepDone(state, "deploy-l2-token-bridge");
		},
	};
}

async function fundL3DeployerAccounts(): Promise<void> {
	console.log("[init] Funding L3 deployer accounts on L2");
	for (const { address, label, amount } of [
		{ address: accounts.l3owner.address, label: "l3owner", amount: parseEther("1000") },
		{
			address: accounts.userTokenBridgeDeployer.address,
			label: "userTokenBridgeDeployer",
			amount: parseEther("100"),
		},
		{
			address: accounts.userFeeTokenDeployer.address,
			label: "userFeeTokenDeployer",
			amount: parseEther("100"),
		},
	]) {
		const funnelAccount = privateKeyToAccount(accounts.funnel.privateKey);
		const client = walletClient(L2_RPC, accounts.funnel.privateKey);
		await client.sendTransaction({
			account: funnelAccount,
			to: address,
			value: amount,
		});
		console.log(`[init] Funded ${label} on L2 with ${amount} wei`);
	}
	// Also fund deployer accounts on L1
	const funnelAccount = privateKeyToAccount(accounts.funnel.privateKey);
	const l1Client = walletClient(L1_RPC, accounts.funnel.privateKey);
	for (const { address, label } of [
		{ address: accounts.userTokenBridgeDeployer.address, label: "userTokenBridgeDeployer" },
		{ address: accounts.userFeeTokenDeployer.address, label: "userFeeTokenDeployer" },
	]) {
		await l1Client.sendTransaction({
			account: funnelAccount,
			to: address,
			value: parseEther("100"),
		});
		console.log(`[init] Funded ${label} on L1 with 100ether`);
	}
}

async function deployCustomFeeToken(
	feeTokenDecimals?: number,
): Promise<{ feeTokenAddress?: string; feeTokenPricerAddress?: string }> {
	if (feeTokenDecimals === undefined) {
		return {};
	}
	const mintAmount = 10n ** BigInt(feeTokenDecimals) * 1_000_000_000n;
	const feeTokenAddress = await deployTestErc20({
		rpcUrl: L2_RPC,
		deployerKey: accounts.userFeeTokenDeployer.privateKey,
		name: `TestCustomFeeToken${feeTokenDecimals}`,
		symbol: `FEE${feeTokenDecimals}`,
		decimals: feeTokenDecimals,
		initialMintAddresses: [
			accounts.userFeeTokenDeployer.address,
			accounts.funnel.address,
			accounts.l3owner.address,
		],
		mintAmountPerAddress: mintAmount,
	});
	console.log(
		`[init] Custom fee token deployed at ${feeTokenAddress} with ${feeTokenDecimals} decimals`,
	);
	// Custom-gas Rollup chains require a non-zero feeTokenPricer.
	// Deploy a constant-rate pricer on the parent chain (L2), using
	// the same deployer key the rollup uses.
	// feeTokenPricer = "1e18 (1:1 constant)" exchange rate.
	const feeTokenPricerAddress = await deployFeeTokenPricer({
		rpcUrl: L2_RPC,
		deployerKey: accounts.l3owner.privateKey,
		exchangeRate: 1000000000000000000n,
	});
	console.log(`[init] Custom fee token pricer deployed at ${feeTokenPricerAddress}`);
	return { feeTokenAddress, feeTokenPricerAddress };
}

// Custom-gas L3s use an ERC20Inbox whose depositEth() reverts. The native fee
// token must instead be approved to the inbox and deposited via depositERC20().
async function depositFeeTokenToL3Inbox(nativeToken: Address, inbox: Address): Promise<void> {
	const l2Pub = publicClient(L2_RPC);
	const l2Client = walletClient(L2_RPC, accounts.funnel.privateKey);
	const funnelAccount = privateKeyToAccount(accounts.funnel.privateKey);
	const feeTokenBalance = (await l2Pub.readContract({
		address: nativeToken,
		abi: testErc20Abi,
		functionName: "balanceOf",
		args: [accounts.funnel.address],
	})) as bigint;
	const depositAmount = feeTokenBalance / 2n;
	console.log(`[init] Approving ${depositAmount} fee tokens to ERC20 inbox ${inbox}`);
	const approveHash = await l2Client.writeContract({
		account: funnelAccount,
		address: nativeToken,
		abi: testErc20Abi,
		functionName: "approve",
		args: [inbox, depositAmount],
	});
	await l2Pub.waitForTransactionReceipt({ hash: approveHash });
	console.log(`[init] Depositing ${depositAmount} fee tokens into L3 ERC20 inbox`);
	const depositHash = await l2Client.writeContract({
		account: funnelAccount,
		address: inbox,
		abi: inboxAbi,
		functionName: "depositERC20",
		args: [depositAmount],
	});
	await l2Pub.waitForTransactionReceipt({ hash: depositHash });
}

async function deployL3Rollup(
	state: InitState,
	runtime: InitRuntime,
	feeTokenDecimals: number | undefined,
	nitroContractsSource: NitroContractsSource,
): Promise<InitState> {
	await fundL3DeployerAccounts();
	writeChainConfig(runtime.configDir, "l3_chain_config.json", {
		chainId: 333333,
		owner: accounts.l3owner.address,
	});
	await applyGasEstimationWorkaround();

	// If custom fee token is requested, deploy an ERC20 and pricer on L2.
	const { feeTokenAddress, feeTokenPricerAddress } = await deployCustomFeeToken(feeTokenDecimals);

	const rollupCreatorDeployment = await deployRollupCreatorViaDocker(runtime, {
		hostParentRpc: L2_RPC,
		dockerParentRpc: L2_RPC_DOCKER,
		deployerKey: accounts.l3owner.privateKey,
		maxDataSize: "104857",
		nitroContractsSource,
	});
	await deployRollupViaSdk({
		chainConfigPath: resolve(runtime.configDir, "l3_chain_config.json"),
		chainId: 333333,
		chainName: "orbit-dev-test",
		parentChainId: 412346,
		parentChainIsArbitrum: true,
		parentRpcUrl: L2_RPC,
		ownerAddress: accounts.l3owner.address,
		ownerKey: accounts.l3owner.privateKey,
		batchPosterAddress: accounts.l3sequencer.address,
		batchPosterKey: accounts.l3sequencer.privateKey,
		validatorAddress: accounts.validator.address,
		validatorKey: accounts.validator.privateKey,
		maxDataSize: 104857n,
		wasmModuleRoot: WASM_MODULE_ROOT as `0x${string}`,
		deploymentOutputPath: resolve(runtime.configDir, "l3_deployment.json"),
		chainInfoOutputPath: resolve(runtime.configDir, "l3_chain_info.json"),
		rawNodeConfigOutputPath: resolve(runtime.configDir, "l3-nodeConfig.raw.json"),
		rollupCreatorAddress: rollupCreatorDeployment.rollupCreator,
		stakeToken: rollupCreatorDeployment.stakeToken,
		nitroContractsVersion: nitroContractsSource.family,
		...(feeTokenAddress ? { nativeToken: feeTokenAddress as `0x${string}` } : {}),
		...(feeTokenPricerAddress ? { feeTokenPricer: feeTokenPricerAddress as `0x${string}` } : {}),
	});

	copyConfigFile(runtime, "l3_deployment.json", "l3deployment.json");
	const deployment = readDeployment(runtime, "l3_deployment.json");
	return markStepDone(state, "deploy-l3-rollup", {
		rollup: deployment["rollup"],
		inbox: deployment["inbox"],
		bridge: deployment["bridge"],
		sequencerInbox: deployment["sequencer-inbox"],
		upgradeExecutor: deployment["upgrade-executor"],
		validatorWalletCreator: deployment["validator-wallet-creator"] ?? ZERO_ADDRESS,
		stakeToken: deployment["stake-token"] ?? ZERO_ADDRESS,
		...(feeTokenAddress ? { feeTokenAddress } : {}),
		...(feeTokenDecimals !== undefined ? { feeTokenDecimals } : {}),
	});
}

function createL3Steps(
	runtime: InitRuntime,
	feeTokenDecimals: number | undefined,
	nitroContractsSource: NitroContractsSource,
	tokenBridgeSource: TokenBridgeSource,
): Record<string, StepRunner> {
	return {
		"deploy-l3-rollup": (state) =>
			deployL3Rollup(state, runtime, feeTokenDecimals, nitroContractsSource),
		"generate-l3-config": async (state) => {
			const rollupData = state.steps["deploy-l3-rollup"]?.data;
			if (!rollupData) {
				throw new Error("Missing l3 rollup deployment data");
			}
			const nodeConfig = prepareNodeConfigFromDeployment({
				chainName: "orbit-dev-test",
				chainConfig: readJsonFile(runtime, "l3_chain_config.json"),
				deployment: readJsonFile(runtime, "l3_deployment.json"),
				parentChainId: 412346,
				parentChainRpcUrl: L2_RPC,
				batchPosterPrivateKey: accounts.l3sequencer.privateKey,
				validatorPrivateKey: accounts.validator.privateKey,
			});
			writeFileSync(
				resolve(runtime.configDir, "nodeConfig.json"),
				JSON.stringify(nodeConfig, null, 2),
			);
			patchConfigUrl(resolve(runtime.configDir, "nodeConfig.json"), L2_RPC, L2_RPC_DOCKER);
			const src = resolve(runtime.configDir, "nodeConfig.json");
			const dest = resolve(runtime.configDir, "l3-nodeConfig.json");
			const config = JSON.parse(readFileSync(src, "utf-8")) as Record<string, unknown>;
			const patched = patchGeneratedL3NodeConfig(
				config,
				L2_RPC_INTERNAL,
				false,
				accounts.l3sequencer.privateKey,
			);
			writeFileSync(dest, JSON.stringify(patched, null, 2));
			return markStepDone(state, "generate-l3-config");
		},
		"start-l3": async (state) => {
			const rollupData = state.steps["deploy-l3-rollup"]?.data;
			if (!rollupData) {
				throw new Error("Missing l3 rollup deployment data");
			}
			await fundL3ParentChainAccounts();
			const stakeToken = rollupData["stakeToken"] as string | undefined;
			const validatorWalletCreator = rollupData["validatorWalletCreator"] as string | undefined;
			if (
				stakeToken &&
				stakeToken !== ZERO_ADDRESS &&
				validatorWalletCreator &&
				validatorWalletCreator !== ZERO_ADDRESS
			) {
				const requiredStakeWei = (await publicClient(L2_RPC).readContract({
					address: rollupData["rollup"] as Address,
					abi: rollupAbi,
					functionName: "baseStake",
				})) as bigint;
				await ensureValidatorWalletStaked({
					parentRpc: L2_RPC,
					creatorAddress: validatorWalletCreator as `0x${string}`,
					rollupAddress: rollupData["rollup"] as `0x${string}`,
					stakeTokenAddress: stakeToken as `0x${string}`,
					validatorAddress: accounts.validator.address,
					validatorKey: accounts.validator.privateKey,
					funderKey: accounts.funnel.privateKey,
					requiredStakeWei,
				});
			}
			composeUp(["l3node"], runtime.dockerOpts);
			return markStepDone(state, "start-l3");
		},
		"wait-l3": async (state) => {
			await waitForL3RpcWithParentChainNudges(300_000);
			return markStepDone(state, "wait-l3");
		},
		"deposit-eth-to-l3": async (state) => {
			const rollupData = state.steps["deploy-l3-rollup"]?.data;
			if (!rollupData) {
				throw new Error("Missing l3 rollup deployment data");
			}
			const existingL3BalanceWei = await getBalanceWei(accounts.funnel.address, L3_RPC);
			if (existingL3BalanceWei >= L3_DEPOSIT_READY_THRESHOLD_WEI) {
				console.log("[init] L3 funnel already funded; skipping inbox deposit");
				return markStepDone(state, "deposit-eth-to-l3", {
					skipped: true,
					reason: "l3 funnel already has balance",
				});
			}
			const inbox = rollupData["inbox"] as Address;
			const nativeToken = (rollupData["feeTokenAddress"] as Address | undefined) ?? ZERO_ADDRESS;
			const isCustomGas = nativeToken !== ZERO_ADDRESS;
			if (isCustomGas) {
				await depositFeeTokenToL3Inbox(nativeToken, inbox);
				await waitForBalanceAtLeast(accounts.funnel.address, L3_RPC, parseEther("1"));
			} else {
				const balanceWei = await getBalanceWei(accounts.funnel.address, L2_RPC);
				const depositWei = clampDepositAmount({
					balanceWei,
					desiredWei: L3_DEPOSIT_TARGET_WEI,
					reserveWei: L3_DEPOSIT_RESERVE_WEI,
				});
				console.log(`[init] Depositing ${depositWei} wei from L2 into L3 inbox`);
				const funnelAccount = privateKeyToAccount(accounts.funnel.privateKey);
				const l2Client = walletClient(L2_RPC, accounts.funnel.privateKey);
				await l2Client.writeContract({
					account: funnelAccount,
					address: inbox,
					abi: inboxAbi,
					functionName: "depositEth",
					value: depositWei,
				});
				await waitForBalanceAtLeast(
					accounts.funnel.address,
					L3_RPC,
					L3_DEPOSIT_READY_THRESHOLD_WEI,
				);
			}
			// Fund userFeeTokenDeployer on L3 so portal E2E tests can use it as a funder
			const l3Client = walletClient(L3_RPC, accounts.funnel.privateKey);
			const l3FunnelAccount = privateKeyToAccount(accounts.funnel.privateKey);
			await l3Client.sendTransaction({
				account: l3FunnelAccount,
				to: accounts.userFeeTokenDeployer.address,
				value: parseEther("10"),
			});
			console.log("[init] Funded userFeeTokenDeployer on L3 with 10 ETH");
			return markStepDone(state, "deposit-eth-to-l3");
		},
		"deploy-l3-token-bridge": async (state) => {
			const rollupData = state.steps["deploy-l3-rollup"]?.data;
			if (!rollupData) {
				throw new Error("Missing l3 rollup deployment data");
			}
			await ensureL2L3TokenBridgeFunding(L2_RPC, L3_RPC);
			const orbitUpgradeExecutor = await deployL2L3TokenBridge({
				compose: runtime.dockerOpts,
				configDir: runtime.configDir,
				rollupAddress: rollupData["rollup"] as string,
				rollupOwnerKey: accounts.l3owner.privateKey,
				parentRpc: L2_RPC_INTERNAL,
				childRpc: "http://l3node:8547",
				parentKey: accounts.l3owner.privateKey,
				childKey: accounts.l3owner.privateKey,
				parentWethOverride: getL2ChildWeth(runtime.configDir),
				tokenBridgeDir: tokenBridgeSource.path,
			});

			setL3StakerEnabled(runtime, false);

			await sendZeroAddressTransfer(L2_RPC);
			await sendZeroAddressTransfer(L2_RPC);
			execOrThrow("sleep", ["5"], { timeout: 6_000 });
			composeRestart(["l3node"], runtime.dockerOpts);
			await waitForL3RpcWithParentChainNudges(120_000);
			await transferL3OwnershipToOrbitUpgradeExecutor(
				runtime.configDir,
				L3_RPC,
				orbitUpgradeExecutor,
			);
			return markStepDone(state, "deploy-l3-token-bridge");
		},
	};
}

export function makeStepRunners(
	runtime: InitRuntime,
	options: {
		feeTokenDecimals?: number | undefined;
		nitroContractsSource: NitroContractsSource;
		tokenBridgeSource: TokenBridgeSource;
	},
): Record<string, StepRunner> {
	return {
		...createL1Steps(runtime),
		...createL2DeploySteps(runtime, options.nitroContractsSource),
		...createL2RuntimeSteps(runtime, options.nitroContractsSource, options.tokenBridgeSource),
		...createL3Steps(
			runtime,
			options.feeTokenDecimals,
			options.nitroContractsSource,
			options.tokenBridgeSource,
		),
	};
}
