import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const L2_CONFIG_FILENAME = "l2-nodeConfig.json";
const L3_CONFIG_FILENAME = "l3-nodeConfig.json";

function setPollInterval(config, pollInterval) {
	config.node = {
		...config.node,
		"parent-chain-reader": {
			...config.node?.["parent-chain-reader"],
			"poll-interval": pollInterval,
		},
		"delayed-sequencer": {
			...config.node?.["delayed-sequencer"],
			"rescan-interval": pollInterval,
		},
	};
	config.execution = {
		...config.execution,
		"parent-chain-reader": {
			...config.execution?.["parent-chain-reader"],
			"poll-interval": pollInterval,
		},
	};
	return config;
}

function readUpdatedConfig(configPath, pollInterval) {
	let config;
	try {
		config = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		throw new Error(`Unable to read ${configPath}: ${error.message}`, { cause: error });
	}
	return `${JSON.stringify(setPollInterval(config, pollInterval), null, 2)}\n`;
}

export function configureParentChainPollInterval(configRoot, pollInterval) {
	if (pollInterval === undefined) {
		return;
	}

	const l2ConfigPath = join(configRoot, L2_CONFIG_FILENAME);
	if (!existsSync(l2ConfigPath)) {
		throw new Error(`Missing required Nitro config: ${l2ConfigPath}`);
	}

	const l3ConfigPath = join(configRoot, L3_CONFIG_FILENAME);
	const configPaths = existsSync(l3ConfigPath) ? [l2ConfigPath, l3ConfigPath] : [l2ConfigPath];
	const updates = configPaths.map((configPath) => ({
		configPath,
		contents: readUpdatedConfig(configPath, pollInterval),
	}));

	for (const { configPath, contents } of updates) {
		writeFileSync(configPath, contents, "utf8");
	}
}

function main() {
	const [configRoot, pollInterval] = process.argv.slice(2);
	if (!configRoot || pollInterval === undefined) {
		console.error("Usage: configure-parent-chain-poll-interval.mjs <config-root> <poll-interval>");
		process.exitCode = 2;
		return;
	}

	try {
		configureParentChainPollInterval(configRoot, pollInterval);
		process.stdout.write(`parent chain poll interval: ${pollInterval}\n`);
	} catch (error) {
		console.error(`arbitrum-testnode: ${error.message}`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
