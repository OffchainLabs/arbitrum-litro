import { buildActionTestnodeState, rebaseTestnodeImage } from "./lib.mjs";

function log(message) {
	console.log(`[arbitrum-testnode] ${message}`);
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

log(`rebasing ${state.baseImageRef} onto ${state.nitroImage}`);
rebaseTestnodeImage(state);
log(`built ${state.imageRef}`);
