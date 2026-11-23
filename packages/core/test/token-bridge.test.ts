import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createTokenBridge,
	createTokenBridgeFetchTokenBridgeContracts,
	createTokenBridgePrepareSetWethGatewayTransactionReceipt,
	createTokenBridgePrepareSetWethGatewayTransactionRequest,
} from "@arbitrum/chain-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as execModule from "../src/exec.js";
import {
	assertTokenBridgeDepsPresent,
	deployL2L3TokenBridge,
	getL2ChildWeth,
	parseTokenBridgeCreatorAddress,
	transferL3OwnershipToOrbitUpgradeExecutor,
} from "../src/token-bridge.js";

const mocks = vi.hoisted(() => ({
	createTokenBridge: vi.fn(),
	createTokenBridgeFetchTokenBridgeContracts: vi.fn(),
	createTokenBridgePrepareSetWethGatewayTransactionRequest: vi.fn(),
	createTokenBridgePrepareSetWethGatewayTransactionReceipt: vi.fn(),
	waitForWethGatewayRetryables: vi.fn(),
	writeContract: vi.fn().mockResolvedValue("0x"),
	tokenBridgeContracts: {
		parentChainContracts: {
			router: "0xa111111111111111111111111111111111111111",
			standardGateway: "0xa222222222222222222222222222222222222222",
			customGateway: "0xa333333333333333333333333333333333333333",
			wethGateway: "0xa444444444444444444444444444444444444444",
			weth: "0xa555555555555555555555555555555555555555",
			multicall: "0xa666666666666666666666666666666666666666",
		},
		orbitChainContracts: {
			router: "0xb111111111111111111111111111111111111111",
			standardGateway: "0xb222222222222222222222222222222222222222",
			customGateway: "0xb333333333333333333333333333333333333333",
			wethGateway: "0xb444444444444444444444444444444444444444",
			weth: "0xb555555555555555555555555555555555555555",
			multicall: "0xb666666666666666666666666666666666666666",
			proxyAdmin: "0xb777777777777777777777777777777777777777",
			beaconProxyFactory: "0xb888888888888888888888888888888888888888",
			upgradeExecutor: "0xb999999999999999999999999999999999999999",
		},
	},
}));

vi.mock("@arbitrum/chain-sdk", () => ({
	createTokenBridge: mocks.createTokenBridge,
	createTokenBridgeFetchTokenBridgeContracts: mocks.createTokenBridgeFetchTokenBridgeContracts,
	createTokenBridgePrepareSetWethGatewayTransactionRequest:
		mocks.createTokenBridgePrepareSetWethGatewayTransactionRequest,
	createTokenBridgePrepareSetWethGatewayTransactionReceipt:
		mocks.createTokenBridgePrepareSetWethGatewayTransactionReceipt,
}));

vi.mock("../src/exec.js", () => ({
	execOrThrow: vi.fn(),
}));

function isTokenBridgeCreatorDeploy(command: string, args: string[]): boolean {
	return (
		(command === "docker" || command === "env") &&
		args.includes("./scripts/deployment/deployTokenBridgeCreator.ts")
	);
}

vi.mock("../src/rpc.js", () => ({
	getBalanceWei: vi.fn().mockResolvedValue(0n),
	readContractOrZero: vi
		.fn()
		.mockImplementation((_addr: string, _abi: unknown, functionName: string) => {
			switch (functionName) {
				case "outbox":
					return "0x7777777777777777777777777777777777777777";
				case "rollupEventInbox":
					return "0x8888888888888888888888888888888888888888";
				case "challengeManager":
					return "0x9999999999999999999999999999999999999999";
				default:
					return "0x0000000000000000000000000000000000000000";
			}
		}),
	publicClient: vi.fn((rpcUrl: string) => ({
		rpcUrl,
		chain: {
			id: rpcUrl.includes(":8549") ? 333333 : rpcUrl.includes(":8547") ? 412346 : 1337,
		},
		sendRawTransaction: vi.fn().mockResolvedValue("0x1234"),
		waitForTransactionReceipt: vi.fn().mockResolvedValue({
			blockHash: "0x",
			blockNumber: 1n,
			contractAddress: null,
			cumulativeGasUsed: 0n,
			effectiveGasPrice: 0n,
			from: "0x0000000000000000000000000000000000000000",
			gasUsed: 0n,
			logs: [],
			logsBloom: "0x",
			status: "success",
			to: "0x0000000000000000000000000000000000000000",
			transactionHash: "0x1234",
			transactionIndex: 0,
			type: "eip1559",
		}),
	})),
	walletClient: vi.fn().mockReturnValue({
		sendTransaction: vi.fn().mockResolvedValue("0x"),
		writeContract: mocks.writeContract,
	}),
	arbOwnerAbi: [],
	rollupAbi: [],
	erc20Abi: [],
	gatewayRouterAbi: [],
}));

describe("getL2ChildWeth", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-bridge-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("reads the L2 child WETH address from the L1-L2 bridge artifact", () => {
		fs.writeFileSync(
			path.join(tmpDir, "l1l2_network.json"),
			JSON.stringify({
				l2Network: {
					tokenBridge: {
						childWeth: "0x1111111111111111111111111111111111111111",
					},
				},
			}),
		);

		expect(getL2ChildWeth(tmpDir)).toBe("0x1111111111111111111111111111111111111111");
	});

	it("throws when the child WETH address is missing", () => {
		fs.writeFileSync(path.join(tmpDir, "l1l2_network.json"), JSON.stringify({}));

		expect(() => getL2ChildWeth(tmpDir)).toThrow(
			"Missing l2Network.tokenBridge.childWeth in l1l2_network.json",
		);
	});
});

describe("assertTokenBridgeDepsPresent", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-bridge-deps-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("throws an actionable error when token-bridge-contracts deps are missing", () => {
		expect(() => assertTokenBridgeDepsPresent(tmpDir)).toThrow(tmpDir);
		expect(() => assertTokenBridgeDepsPresent(tmpDir)).toThrow("yarn install");
		expect(() => assertTokenBridgeDepsPresent(tmpDir)).toThrow("TOKEN_BRIDGE_LOCAL_DIR");
	});

	it("does not throw when the ts-node binary and deploy script are present", () => {
		fs.mkdirSync(path.join(tmpDir, "node_modules/ts-node/dist"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "node_modules/ts-node/dist/bin.js"), "");
		fs.mkdirSync(path.join(tmpDir, "scripts/deployment"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "scripts/deployment/deployTokenBridgeCreator.ts"), "");

		expect(() => assertTokenBridgeDepsPresent(tmpDir)).not.toThrow();
	});
});

describe("parseTokenBridgeCreatorAddress", () => {
	it("extracts the creator address from deploy output", () => {
		const output = [
			"Deploying token bridge creator...",
			"* L1AtomicTokenBridgeCreator created at address: 0x1111111111111111111111111111111111111111",
			"* TransparentUpgradeableProxy created at address: 0x2222222222222222222222222222222222222222 0x1111111111111111111111111111111111111111 0x3333333333333333333333333333333333333333 0x",
			"Token bridge creator deployed!",
			"L1TokenBridgeCreator: 0x332Fb35767182F8ac9F9C1405db626105F6694E0",
		].join("\n");

		expect(parseTokenBridgeCreatorAddress(output)).toBe(
			"0x2222222222222222222222222222222222222222",
		);
	});

	it("throws when the creator address is missing", () => {
		expect(() => parseTokenBridgeCreatorAddress("no creator here")).toThrow(
			"Failed to parse L1TokenBridgeCreator",
		);
	});
});

describe("deployL2L3TokenBridge", () => {
	let tmpDir: string;
	let previousSdkPath: string | undefined;
	let previousPortalPath: string | undefined;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-bridge-test-"));
		fs.mkdirSync(path.join(tmpDir, "token-bridge/node_modules/ts-node/dist"), {
			recursive: true,
		});
		fs.writeFileSync(path.join(tmpDir, "token-bridge/node_modules/ts-node/dist/bin.js"), "");
		fs.mkdirSync(path.join(tmpDir, "token-bridge/scripts/deployment"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, "token-bridge/scripts/deployment/deployTokenBridgeCreator.ts"),
			"",
		);
		vi.clearAllMocks();
		mocks.createTokenBridge.mockResolvedValue({
			tokenBridgeContracts: mocks.tokenBridgeContracts,
		});
		mocks.createTokenBridgeFetchTokenBridgeContracts.mockResolvedValue(mocks.tokenBridgeContracts);
		mocks.createTokenBridgePrepareSetWethGatewayTransactionRequest.mockRejectedValue(
			new Error("weth gateway is already registered in the router."),
		);
		mocks.waitForWethGatewayRetryables.mockResolvedValue([
			{
				status: "success",
				transactionHash: "0x5555",
			},
		]);
		mocks.createTokenBridgePrepareSetWethGatewayTransactionReceipt.mockReturnValue({
			waitForRetryables: mocks.waitForWethGatewayRetryables,
		});
		previousSdkPath = process.env["ARBITRUM_SDK_LOCAL_NETWORK_PATH"];
		previousPortalPath = process.env["ARBITRUM_PORTAL_LOCAL_NETWORK_PATH"];
		process.env["ARBITRUM_SDK_LOCAL_NETWORK_PATH"] = path.join(tmpDir, "sdk-localNetwork.json");
		process.env["ARBITRUM_PORTAL_LOCAL_NETWORK_PATH"] = path.join(
			tmpDir,
			"portal-localNetwork.json",
		);
	});

	afterEach(() => {
		if (previousSdkPath === undefined) {
			// biome-ignore lint/performance/noDelete: process.env requires delete; assigning undefined stringifies
			delete process.env["ARBITRUM_SDK_LOCAL_NETWORK_PATH"];
		} else {
			process.env["ARBITRUM_SDK_LOCAL_NETWORK_PATH"] = previousSdkPath;
		}
		if (previousPortalPath === undefined) {
			// biome-ignore lint/performance/noDelete: process.env requires delete; assigning undefined stringifies
			delete process.env["ARBITRUM_PORTAL_LOCAL_NETWORK_PATH"];
		} else {
			process.env["ARBITRUM_PORTAL_LOCAL_NETWORK_PATH"] = previousPortalPath;
		}
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("backfills the L3 parentWeth with the L2 WETH for custom-fee chains", async () => {
		// Custom-fee deployment leaves parentChain.weth at the zero address.
		mocks.createTokenBridge.mockResolvedValue({
			tokenBridgeContracts: {
				...mocks.tokenBridgeContracts,
				parentChainContracts: {
					...mocks.tokenBridgeContracts.parentChainContracts,
					weth: "0x0000000000000000000000000000000000000000",
				},
			},
		});
		// The real L2 WETH lives in the L1-L2 bridge artifact.
		fs.writeFileSync(
			path.join(tmpDir, "l1l2_network.json"),
			JSON.stringify({
				l2Network: {
					tokenBridge: { childWeth: "0x1212121212121212121212121212121212121212" },
				},
			}),
		);
		fs.writeFileSync(
			path.join(tmpDir, "l3_deployment.json"),
			JSON.stringify({
				rollup: "0x1111111111111111111111111111111111111111",
				inbox: "0x2222222222222222222222222222222222222222",
				bridge: "0x3333333333333333333333333333333333333333",
				"sequencer-inbox": "0x4444444444444444444444444444444444444444",
				"upgrade-executor": "0x5555555555555555555555555555555555555555",
				"validator-wallet-creator": "0x6666666666666666666666666666666666666666",
				"native-token": "0x9999999999999999999999999999999999999999",
				"deployed-at": 44,
			}),
		);
		vi.mocked(execModule.execOrThrow).mockImplementation((command, args) => {
			if (isTokenBridgeCreatorDeploy(command, args)) {
				return "L1TokenBridgeCreator: 0x332Fb35767182F8ac9F9C1405db626105F6694E0";
			}
			return "";
		});

		await deployL2L3TokenBridge({
			compose: {
				composeFile: "/tmp/docker-compose.yaml",
				projectName: "arbitrum-testnode",
			},
			configDir: tmpDir,
			rollupAddress: "0x1111111111111111111111111111111111111111",
			rollupOwnerKey: "0x2222222222222222222222222222222222222222222222222222222222222222",
			parentRpc: "http://sequencer:8547",
			childRpc: "http://l3node:8547",
			parentKey: "0x3333333333333333333333333333333333333333333333333333333333333333",
			childKey: "0x3333333333333333333333333333333333333333333333333333333333333333",
			tokenBridgeDir: path.join(tmpDir, "token-bridge"),
			parentWethOverride: "0x5555555555555555555555555555555555555555",
		});

		const l2l3Network = JSON.parse(
			fs.readFileSync(path.join(tmpDir, "l2l3_network.json"), "utf-8"),
		) as { l3Network: { nativeToken: string; tokenBridge: { parentWeth: string } } };
		expect(l2l3Network.l3Network.nativeToken).toBe("0x9999999999999999999999999999999999999999");
		expect(l2l3Network.l3Network.tokenBridge.parentWeth).toBe(
			"0x1212121212121212121212121212121212121212",
		);
	});

	it("uses the local token-bridge workspace for creator deploys on the L2 parent path", async () => {
		fs.writeFileSync(
			path.join(tmpDir, "l3_deployment.json"),
			JSON.stringify({
				rollup: "0x1111111111111111111111111111111111111111",
				inbox: "0x2222222222222222222222222222222222222222",
				bridge: "0x3333333333333333333333333333333333333333",
				"sequencer-inbox": "0x4444444444444444444444444444444444444444",
				"upgrade-executor": "0x5555555555555555555555555555555555555555",
				"validator-wallet-creator": "0x6666666666666666666666666666666666666666",
				"native-token": "0x0000000000000000000000000000000000000000",
				"deployed-at": 44,
			}),
		);
		const execOrThrow = vi.mocked(execModule.execOrThrow);
		execOrThrow.mockImplementation((command, args) => {
			if (isTokenBridgeCreatorDeploy(command, args)) {
				return "L1TokenBridgeCreator: 0x332Fb35767182F8ac9F9C1405db626105F6694E0";
			}
			return "";
		});

		const orbitUpgradeExecutor = await deployL2L3TokenBridge({
			compose: {
				composeFile: "/tmp/docker-compose.yaml",
				projectName: "arbitrum-testnode",
			},
			configDir: tmpDir,
			rollupAddress: "0x1111111111111111111111111111111111111111",
			rollupOwnerKey: "0x2222222222222222222222222222222222222222222222222222222222222222",
			parentRpc: "http://sequencer:8547",
			childRpc: "http://l3node:8547",
			parentKey: "0x3333333333333333333333333333333333333333333333333333333333333333",
			childKey: "0x3333333333333333333333333333333333333333333333333333333333333333",
			tokenBridgeDir: path.join(tmpDir, "token-bridge"),
			parentWethOverride: "0x5555555555555555555555555555555555555555",
		});

		expect(orbitUpgradeExecutor).toBe("0xb999999999999999999999999999999999999999");

		expect(execOrThrow).toHaveBeenCalledWith(
			"env",
			expect.arrayContaining([
				"BASECHAIN_RPC=http://127.0.0.1:8547",
				"BASECHAIN_WETH=0x5555555555555555555555555555555555555555",
				"DEPLOY_GAS_LIMIT=50000000",
				"POLLING_INTERVAL=100",
				"DISABLE_CONTRACT_VERIFICATION=true",
				"GAS_LIMIT_FOR_L2_FACTORY_DEPLOYMENT=10000000",
				"node",
				expect.stringContaining("node_modules/ts-node/dist/bin.js"),
				"./scripts/deployment/deployTokenBridgeCreator.ts",
			]),
			expect.objectContaining({
				cwd: expect.any(String),
			}),
		);
		expect(execOrThrow).not.toHaveBeenCalledWith(
			expect.stringMatching(/(?:^node$|\/node$)/),
			expect.anything(),
			expect.anything(),
		);
		expect(createTokenBridge).toHaveBeenCalledWith(
			expect.objectContaining({
				rollupAddress: "0x1111111111111111111111111111111111111111",
				rollupDeploymentBlockNumber: 44n,
				tokenBridgeCreatorAddressOverride: "0x332Fb35767182F8ac9F9C1405db626105F6694E0",
				parentChainPublicClient: expect.objectContaining({
					rpcUrl: "http://127.0.0.1:8547",
				}),
				orbitChainPublicClient: expect.objectContaining({
					rpcUrl: "http://127.0.0.1:8549",
				}),
				gasOverrides: {
					gasLimit: {
						base: 6_000_000n,
					},
				},
				retryableGasOverrides: {
					maxGasForFactory: {
						base: 20_000_000n,
					},
					maxGasForContracts: {
						base: 20_000_000n,
					},
					maxSubmissionCostForFactory: {
						base: 4_000_000_000_000n,
					},
					maxSubmissionCostForContracts: {
						base: 4_000_000_000_000n,
					},
				},
				setWethGatewayGasOverrides: {
					gasLimit: {
						base: 100_000n,
					},
				},
			}),
		);
		expect(createTokenBridgePrepareSetWethGatewayTransactionRequest).toHaveBeenCalledWith({
			rollup: "0x1111111111111111111111111111111111111111",
			rollupDeploymentBlockNumber: 44n,
			parentChainPublicClient: expect.objectContaining({
				rpcUrl: "http://127.0.0.1:8547",
			}),
			orbitChainPublicClient: expect.objectContaining({
				rpcUrl: "http://127.0.0.1:8549",
			}),
			account: "0x5CbDd86a2FA8Dc4bDdd8a8f69dBa48572EeC07FB",
			tokenBridgeCreatorAddressOverride: "0x332Fb35767182F8ac9F9C1405db626105F6694E0",
			retryableGasOverrides: {
				gasLimit: {
					base: 100_000n,
				},
			},
		});
		expect(createTokenBridgePrepareSetWethGatewayTransactionReceipt).not.toHaveBeenCalled();

		const l2l3Network = JSON.parse(
			fs.readFileSync(path.join(tmpDir, "l2l3_network.json"), "utf-8"),
		) as {
			l3Network: {
				parentChainId: number;
				chainId: number;
				tokenBridge: {
					parentGatewayRouter: string;
					childGatewayRouter: string;
					parentWethGateway: string;
					childWethGateway: string;
				};
			};
		};
		expect(l2l3Network.l3Network.parentChainId).toBe(412346);
		expect(l2l3Network.l3Network.chainId).toBe(333333);
		expect(l2l3Network.l3Network.tokenBridge.parentGatewayRouter).toBe(
			"0xa111111111111111111111111111111111111111",
		);
		expect(l2l3Network.l3Network.tokenBridge.childGatewayRouter).toBe(
			"0xb111111111111111111111111111111111111111",
		);
		expect(l2l3Network.l3Network.tokenBridge.parentWethGateway).toBe(
			"0xa444444444444444444444444444444444444444",
		);
		expect(l2l3Network.l3Network.tokenBridge.childWethGateway).toBe(
			"0xb444444444444444444444444444444444444444",
		);

		const localNetwork = JSON.parse(
			fs.readFileSync(path.join(tmpDir, "localNetwork.json"), "utf-8"),
		) as {
			l3Network: {
				chainId: number;
			};
		};
		expect(localNetwork.l3Network.chainId).toBe(333333);

		const spec = JSON.parse(
			fs.readFileSync(path.join(tmpDir, "l2-l3-chain-config.json"), "utf-8"),
		) as {
			deployment: {
				tokenBridgeCreator: string;
			};
			parentRollupConfig: {
				minimumAssertionPeriod: string;
				confirmPeriodBlocks: string;
			};
			ownership: {
				addChainOwners: string[];
				removeDeployer: boolean;
			};
			parentDeployment: {
				challengeManager: string;
				rollupEventInbox: string;
				outbox: string;
			};
		};
		expect(spec.deployment.tokenBridgeCreator).toBe("0x332Fb35767182F8ac9F9C1405db626105F6694E0");
		expect(spec.parentRollupConfig).toEqual({
			minimumAssertionPeriod: "1",
			confirmPeriodBlocks: "1",
		});
		expect(spec.ownership).toEqual({
			addChainOwners: ["0x5555555555555555555555555555555555555555"],
			removeDeployer: true,
		});
		expect(spec.parentDeployment.outbox).toBe("0x7777777777777777777777777777777777777777");
		expect(spec.parentDeployment.rollupEventInbox).toBe(
			"0x8888888888888888888888888888888888888888",
		);
		expect(spec.parentDeployment.challengeManager).toBe(
			"0x9999999999999999999999999999999999999999",
		);
	});

	it("loads existing token bridge contracts when the SDK retry reports an existing deployment", async () => {
		fs.writeFileSync(
			path.join(tmpDir, "l3_deployment.json"),
			JSON.stringify({
				rollup: "0x1111111111111111111111111111111111111111",
				inbox: "0x2222222222222222222222222222222222222222",
				bridge: "0x3333333333333333333333333333333333333333",
				"sequencer-inbox": "0x4444444444444444444444444444444444444444",
				"upgrade-executor": "0x5555555555555555555555555555555555555555",
				"validator-wallet-creator": "0x6666666666666666666666666666666666666666",
				"native-token": "0x0000000000000000000000000000000000000000",
				"deployed-at": 44,
			}),
		);
		const execOrThrow = vi.mocked(execModule.execOrThrow);
		execOrThrow.mockImplementation((command, args) => {
			if (isTokenBridgeCreatorDeploy(command, args)) {
				return "L1TokenBridgeCreator: 0x332Fb35767182F8ac9F9C1405db626105F6694E0";
			}
			return "";
		});
		mocks.createTokenBridge
			.mockRejectedValueOnce(new Error("Unexpected status for retryable ticket: 0xabc"))
			.mockRejectedValueOnce(
				new Error(
					"Token bridge contracts for Rollup 0x1111111111111111111111111111111111111111 are already deployed",
				),
			);
		mocks.createTokenBridgePrepareSetWethGatewayTransactionRequest.mockResolvedValue({
			chainId: 412346,
			to: "0x7777777777777777777777777777777777777777",
			value: 0n,
			data: "0x",
			nonce: 0,
			gas: 21_000n,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
		});

		await deployL2L3TokenBridge({
			compose: {
				composeFile: "/tmp/docker-compose.yaml",
				projectName: "arbitrum-testnode",
			},
			configDir: tmpDir,
			rollupAddress: "0x1111111111111111111111111111111111111111",
			rollupOwnerKey: "0x2222222222222222222222222222222222222222222222222222222222222222",
			parentRpc: "http://sequencer:8547",
			childRpc: "http://l3node:8547",
			parentKey: "0x3333333333333333333333333333333333333333333333333333333333333333",
			childKey: "0x3333333333333333333333333333333333333333333333333333333333333333",
			tokenBridgeDir: path.join(tmpDir, "token-bridge"),
			parentWethOverride: "0x5555555555555555555555555555555555555555",
		});

		expect(createTokenBridge).toHaveBeenCalledTimes(2);
		expect(createTokenBridgeFetchTokenBridgeContracts).toHaveBeenCalledWith({
			inbox: "0x2222222222222222222222222222222222222222",
			parentChainPublicClient: expect.objectContaining({
				rpcUrl: "http://127.0.0.1:8547",
			}),
			tokenBridgeCreatorAddressOverride: "0x332Fb35767182F8ac9F9C1405db626105F6694E0",
		});
		expect(createTokenBridgePrepareSetWethGatewayTransactionRequest).toHaveBeenCalledWith({
			rollup: "0x1111111111111111111111111111111111111111",
			rollupDeploymentBlockNumber: 44n,
			parentChainPublicClient: expect.objectContaining({
				rpcUrl: "http://127.0.0.1:8547",
			}),
			orbitChainPublicClient: expect.objectContaining({
				rpcUrl: "http://127.0.0.1:8549",
			}),
			account: "0x5CbDd86a2FA8Dc4bDdd8a8f69dBa48572EeC07FB",
			tokenBridgeCreatorAddressOverride: "0x332Fb35767182F8ac9F9C1405db626105F6694E0",
			retryableGasOverrides: {
				gasLimit: {
					base: 100_000n,
				},
			},
		});
		expect(createTokenBridgePrepareSetWethGatewayTransactionReceipt).toHaveBeenCalled();
		expect(mocks.waitForWethGatewayRetryables).toHaveBeenCalledWith({
			orbitPublicClient: expect.objectContaining({
				rpcUrl: "http://127.0.0.1:8549",
			}),
		});
		const l2l3Network = JSON.parse(
			fs.readFileSync(path.join(tmpDir, "l2l3_network.json"), "utf-8"),
		) as {
			l3Network: {
				tokenBridge: {
					parentGatewayRouter: string;
					childGatewayRouter: string;
				};
			};
		};
		expect(l2l3Network.l3Network.tokenBridge.parentGatewayRouter).toBe(
			"0xa111111111111111111111111111111111111111",
		);
		expect(l2l3Network.l3Network.tokenBridge.childGatewayRouter).toBe(
			"0xb111111111111111111111111111111111111111",
		);
	});
});

describe("transferL3OwnershipToOrbitUpgradeExecutor", () => {
	let tmpDir: string;
	const orbitUpgradeExecutor = "0xb999999999999999999999999999999999999999";
	const l3OwnerAddress = "0x863c904166E801527125D8672442D736194A3362";

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-bridge-test-"));
		vi.clearAllMocks();
		mocks.writeContract.mockResolvedValue("0x");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("adds the orbit upgrade executor as chain owner then removes the l3owner EOA", async () => {
		await transferL3OwnershipToOrbitUpgradeExecutor(
			tmpDir,
			"http://127.0.0.1:8549",
			orbitUpgradeExecutor,
		);

		expect(mocks.writeContract).toHaveBeenCalledTimes(2);
		expect(mocks.writeContract).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				functionName: "addChainOwner",
				args: [orbitUpgradeExecutor],
			}),
		);
		expect(mocks.writeContract).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				functionName: "removeChainOwner",
				args: [l3OwnerAddress],
			}),
		);
	});

	it("records chain-owner-upgrade-executor in both deployment files without touching upgrade-executor", async () => {
		for (const fileName of ["l3_deployment.json", "l3deployment.json"]) {
			fs.writeFileSync(
				path.join(tmpDir, fileName),
				`${JSON.stringify({ "upgrade-executor": "0x5555555555555555555555555555555555555555" }, null, 2)}\n`,
			);
		}

		await transferL3OwnershipToOrbitUpgradeExecutor(
			tmpDir,
			"http://127.0.0.1:8549",
			orbitUpgradeExecutor,
		);

		for (const fileName of ["l3_deployment.json", "l3deployment.json"]) {
			const deployment = JSON.parse(
				fs.readFileSync(path.join(tmpDir, fileName), "utf-8"),
			) as Record<string, string>;
			expect(deployment["chain-owner-upgrade-executor"]).toBe(orbitUpgradeExecutor);
			expect(deployment["upgrade-executor"]).toBe("0x5555555555555555555555555555555555555555");
		}
	});
});
