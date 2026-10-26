import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const NODE_CONFIG_FILENAMES = ["l2-nodeConfig.json", "l3-nodeConfig.json"];

/**
 * The parts of a Nitro node config this script edits; everything else passes through.
 * @typedef {{
 *   node?: { "batch-poster"?: Record<string, unknown>; [key: string]: unknown };
 *   execution?: { sequencer?: Record<string, unknown>; [key: string]: unknown };
 *   [key: string]: unknown;
 * }} NodeConfig
 */

/**
 * Snapshots are created on an older Nitro that sets batch-poster.max-size. Nitro >= v3.12
 * deprecates it for max-calldata-batch-size, and its alias copies the value across during
 * validation, so a second validation pass rejects a config that still sets max-size. Only a
 * Nitro that knows the new key may get it: older ones reject it as invalid.
 *
 * @param {NodeConfig} config
 * @returns {NodeConfig}
 */
export function renameBatchMaxSize(config) {
	const batchPoster = config.node?.["batch-poster"];
	if (!batchPoster || !Object.hasOwn(batchPoster, "max-size")) {
		return config;
	}
	const { "max-size": maxSize, ...rest } = batchPoster;
	return {
		...config,
		node: {
			...config.node,
			"batch-poster": { "max-calldata-batch-size": maxSize, ...rest },
		},
	};
}

/**
 * @param {NodeConfig} config
 * @param {string} maxBlockSpeed Go duration, e.g. 250ms
 * @returns {NodeConfig}
 */
export function setMaxBlockSpeed(config, maxBlockSpeed) {
	return {
		...config,
		execution: {
			...config.execution,
			sequencer: { ...config.execution?.sequencer, "max-block-speed": maxBlockSpeed },
		},
	};
}

/**
 * Rewrite the runtime node configs in `configRoot` for this boot.
 *
 * @param {string} configRoot
 * @param {{ renameBatchMaxSize: boolean; l2MaxBlockSpeed?: string | undefined }} options
 */
export function configureSequencer(configRoot, options) {
	for (const filename of NODE_CONFIG_FILENAMES) {
		const path = join(configRoot, filename);
		if (!existsSync(path)) {
			continue;
		}
		let config = JSON.parse(readFileSync(path, "utf8"));
		if (options.renameBatchMaxSize) {
			config = renameBatchMaxSize(config);
		}
		if (options.l2MaxBlockSpeed && filename === "l2-nodeConfig.json") {
			config = setMaxBlockSpeed(config, options.l2MaxBlockSpeed);
		}
		writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	}
}

function main() {
	const [configRoot, renameFlag, l2MaxBlockSpeed] = process.argv.slice(2);
	if (!configRoot || (renameFlag !== "true" && renameFlag !== "false")) {
		console.error(
			"Usage: configure-sequencer.mjs <config-root> <rename-batch-max-size:true|false> [l2-max-block-speed]",
		);
		process.exitCode = 2;
		return;
	}
	try {
		configureSequencer(configRoot, { renameBatchMaxSize: renameFlag === "true", l2MaxBlockSpeed });
		if (l2MaxBlockSpeed) {
			process.stdout.write(`l2 max-block-speed: ${l2MaxBlockSpeed}\n`);
		}
	} catch (error) {
		console.error(`arbitrum-testnode: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
