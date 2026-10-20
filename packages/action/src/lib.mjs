export {
	bootTestnode,
	buildActionTestnodeState,
	buildTestnodeImageRef,
	collectContainerDiagnostics,
	NITRO_CONTRACTS_VERSIONS,
	copyNetworkConfigPaths,
	DEFAULT_NITRO_CONTRACTS_VERSION,
	DEFAULT_TESTNODE_IMAGE_REPOSITORY,
	testnodeDockerRunArgs,
	normalizeNitroContractsVersion,
	pruneStaleRebasedImages,
	rebasedTestnodeImageRef,
	rebaseTestnodeImage,
	removeContainer,
	resolveVariant,
	runDocker,
	VARIANTS,
	waitForRpc,
} from "../../testnode/src/runtime.mjs";

/**
 * Testnode state options from the composite action's environment: `INPUT_*` for its inputs
 * (always strings, empty when unset) and the runner's own variables.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {import("../../testnode/src/types.js").ActionStateOptions}
 */
export function actionStateOptionsFromEnv(env) {
	return {
		containerName: env["INPUT_CONTAINER_NAME"],
		contractsVersion: env["INPUT_NITRO_CONTRACTS_VERSION"],
		feeTokenDecimals: env["INPUT_FEE_TOKEN_DECIMALS"],
		imageRef: env["INPUT_IMAGE_REF"],
		imageRepository: env["INPUT_IMAGE_REPOSITORY"],
		l3Enabled: env["INPUT_L3_ENABLED"],
		nitroImage: env["INPUT_NITRO_IMAGE"],
		outputDir: env["INPUT_OUTPUT_DIR"],
		runnerTemp: env["RUNNER_TEMP"],
		sequencer: {
			fastFeedApiKey: env["INPUT_FAST_FEED_API_KEY"],
			fastFeedAuth: env["INPUT_FAST_FEED_AUTH"],
			fastFeedDelayMs: env["INPUT_FAST_FEED_DELAY_MS"],
			fastFeedEnabled: env["INPUT_FAST_FEED_ENABLED"],
			l2MaxBlockSpeed: env["INPUT_L2_MAX_BLOCK_SPEED"],
			pgaRoundsPerBlock: env["INPUT_PGA_ROUNDS_PER_BLOCK"],
		},
		timeboostEnabled: env["INPUT_TIMEBOOST_ENABLED"],
		version: env["INPUT_VERSION"],
		workspace: env["GITHUB_WORKSPACE"],
	};
}
