import { appendFileSync } from "node:fs";
import { buildActionTestnodeState } from "./lib.mjs";

function writeOutput(key, value) {
	const outputFile = process.env["GITHUB_OUTPUT"];
	if (!outputFile) {
		throw new Error("GITHUB_OUTPUT is required");
	}
	appendFileSync(outputFile, `${key}=${value}\n`);
}

const state = buildActionTestnodeState({
	containerName: process.env["INPUT_CONTAINER_NAME"],
	contractsVersion: process.env["INPUT_NITRO_CONTRACTS_VERSION"],
	feeTokenDecimals: process.env["INPUT_FEE_TOKEN_DECIMALS"],
	imageRef: process.env["INPUT_IMAGE_REF"],
	imageRepository: process.env["INPUT_IMAGE_REPOSITORY"],
	l3Enabled: process.env["INPUT_L3_ENABLED"],
	outputDir: process.env["INPUT_OUTPUT_DIR"],
	runnerTemp: process.env["RUNNER_TEMP"],
	variant: process.env["INPUT_VARIANT"],
	version: process.env["INPUT_VERSION"],
	workspace: process.env["GITHUB_WORKSPACE"],
});

writeOutput("config-dir", state.configDir);
writeOutput("container-name", state.containerName);
writeOutput("image-ref", state.imageRef);
writeOutput("l1-bridge-ui-config-path", state.paths.l1BridgeUiConfig);
writeOutput("l1-rpc-url", state.rpcUrls.l1);
writeOutput("l1l2-network-path", state.paths.l1l2Network);
writeOutput("l2-bridge-ui-config-path", state.paths.l2BridgeUiConfig);
writeOutput("l2-rpc-url", state.rpcUrls.l2);
writeOutput("l2l3-network-path", state.paths.l2l3Network);
writeOutput("l3-rpc-url", state.rpcUrls.l3);
writeOutput("local-network-path", state.paths.localNetwork);
writeOutput("output-dir", state.outputDir);
writeOutput("snapshot-id", state.snapshotId);
writeOutput("nitro-contracts-version", state.contractsVersion);
writeOutput("variant", state.variant);
writeOutput("l3-enabled", state.variantDefinition.l3Enabled ? "true" : "false");
