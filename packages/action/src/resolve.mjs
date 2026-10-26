import { appendFileSync } from "node:fs";
import { actionStateOptionsFromEnv, buildActionTestnodeState } from "./lib.mjs";

/**
 * @param {string} key
 * @param {string} value
 */
function writeOutput(key, value) {
	const outputFile = process.env["GITHUB_OUTPUT"];
	if (!outputFile) {
		throw new Error("GITHUB_OUTPUT is required");
	}
	appendFileSync(outputFile, `${key}=${value}\n`);
}

const state = buildActionTestnodeState(actionStateOptionsFromEnv(process.env));

writeOutput("base-image-ref", state.baseImageRef);
writeOutput("config-dir", state.configDir);
writeOutput("fast-feed-url", state.sequencer.fastFeed?.url ?? "");
writeOutput("container-name", state.containerName);
writeOutput("image-ref", state.imageRef);
writeOutput("nitro-image", state.nitroImage);
writeOutput("l1-bridge-ui-config-path", state.paths.l1BridgeUiConfig);
writeOutput("l1-rpc-url", state.rpcUrls.l1);
writeOutput("l1l2-network-path", state.paths.l1l2Network);
writeOutput("l2-bridge-ui-config-path", state.paths.l2BridgeUiConfig);
writeOutput("l2-rpc-url", state.rpcUrls.l2);
writeOutput("l2l3-network-path", state.paths.l2l3Network);
writeOutput("l3-rpc-url", state.rpcUrls.l3);
writeOutput("local-network-path", state.paths.localNetwork);
writeOutput("output-dir", state.outputDir);
writeOutput("sequencer-feed-url", state.sequencer.fastFeed?.sequencerFeedUrl ?? "");
writeOutput("snapshot-id", state.snapshotId);
writeOutput("nitro-contracts-version", state.contractsVersion);
writeOutput("variant", state.variant);
writeOutput("l3-enabled", state.variantDefinition.l3Enabled ? "true" : "false");
