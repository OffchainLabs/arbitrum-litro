import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	bootTestnode,
	buildActionTestnodeState,
	collectContainerDiagnostics,
	copyNetworkConfigPaths,
} from "./lib.mjs";

function log(message) {
	console.log(`[arbitrum-testnode] ${message}`);
}

function writeEnv(key, value) {
	const envFile = process.env["GITHUB_ENV"];
	if (!envFile) {
		throw new Error("GITHUB_ENV is required");
	}
	appendFileSync(envFile, `${key}=${value}\n`);
}

const state = buildActionTestnodeState({
	containerName: process.env["INPUT_CONTAINER_NAME"],
	contractsVersion: process.env["INPUT_NITRO_CONTRACTS_VERSION"],
	feeTokenDecimals: process.env["INPUT_FEE_TOKEN_DECIMALS"],
	imageRef: process.env["INPUT_IMAGE_REF"],
	imageRepository: process.env["INPUT_IMAGE_REPOSITORY"],
	l3Enabled: process.env["INPUT_L3_ENABLED"],
	nitroImage: process.env["INPUT_NITRO_IMAGE"],
	outputDir: process.env["INPUT_OUTPUT_DIR"],
	runnerTemp: process.env["RUNNER_TEMP"],
	timeboostEnabled: process.env["INPUT_TIMEBOOST_ENABLED"],
	version: process.env["INPUT_VERSION"],
	workspace: process.env["GITHUB_WORKSPACE"],
});
log(`variant=${state.variant} image=${state.imageRef}`);
log(`outputDir=${state.outputDir} configDir=${state.configDir}`);

const timeoutSeconds = Number(process.env["INPUT_STARTUP_TIMEOUT_SECONDS"] || "120");
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
	throw new Error("startup-timeout-seconds must be a positive number");
}
const timeoutMs = timeoutSeconds * 1000;

try {
	log("starting container and waiting for RPCs...");
	const exported = bootTestnode(state, timeoutMs);
	log(`exported ${exported.length} entries: ${exported.join(", ")}`);
} catch (error) {
	log(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
	const diagnostics = collectContainerDiagnostics(state.containerName);
	if (diagnostics.inspect) {
		log(`container state: ${diagnostics.inspect}`);
	}
	if (diagnostics.logs) {
		log(`container logs:\n${diagnostics.logs}`);
	}
	for (const diagnosticError of diagnostics.errors) {
		log(diagnosticError);
	}
	process.exit(1);
}

writeEnv("ARBITRUM_PORTAL_LOCAL_NETWORK_PATH", state.paths.localNetwork);
writeEnv("ARBITRUM_SDK_LOCAL_NETWORK_PATH", state.paths.localNetwork);
writeEnv("ARBITRUM_TESTNODE_CONFIG_DIR", state.configDir);
writeEnv("ARBITRUM_TESTNODE_L1L2_NETWORK_PATH", state.paths.l1l2Network);
writeEnv("ARBITRUM_TESTNODE_L1_BRIDGE_UI_CONFIG_PATH", state.paths.l1BridgeUiConfig);
writeEnv("ARBITRUM_TESTNODE_L1_RPC_URL", state.rpcUrls.l1);
writeEnv("ARBITRUM_TESTNODE_L2L3_NETWORK_PATH", state.paths.l2l3Network);
writeEnv("ARBITRUM_TESTNODE_L2_BRIDGE_UI_CONFIG_PATH", state.paths.l2BridgeUiConfig);
writeEnv("ARBITRUM_TESTNODE_L2_RPC_URL", state.rpcUrls.l2);
writeEnv("ARBITRUM_TESTNODE_L3_RPC_URL", state.rpcUrls.l3);
writeEnv("ARBITRUM_TESTNODE_LOCAL_NETWORK_PATH", state.paths.localNetwork);
writeEnv("ARBITRUM_TESTNODE_NITRO_CONTRACTS_VERSION", state.contractsVersion);
writeEnv("ARBITRUM_TESTNODE_VARIANT", state.variant);
writeEnv("ARBITRUM_TESTNODE_CONTAINER_NAME", state.containerName);
writeEnv("INTEGRATION_TEST_NITRO_CONTRACTS_BRANCH", state.contractsVersion);

const networkConfigPaths = (process.env["INPUT_NETWORK_CONFIG_PATH"] || "")
	.split(",")
	.map((p) => p.trim())
	.filter(Boolean);
for (const dest of networkConfigPaths) {
	mkdirSync(dirname(dest), { recursive: true });
	copyNetworkConfigPaths(state.paths.localNetwork, [dest]);
	log(`copied network config to ${dest}`);
}

log("done");
