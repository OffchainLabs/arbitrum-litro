type JsonObject = Record<string, unknown>;

const FAST_BATCH_POSTER_CONFIG = {
	"max-delay": "100ms",
	"poll-interval": "100ms",
	"error-delay": "100ms",
	"wait-for-max-delay": false,
} as const;

const FAST_BOLD_CONFIG = {
	"rpc-block-number": "latest",
	"assertion-posting-interval": "100ms",
	"assertion-confirming-interval": "100ms",
	"assertion-scanning-interval": "100ms",
	"minimum-gap-to-parent-assertion": "100ms",
	"parent-chain-block-time": "100ms",
} as const;

const FAST_STAKER_CONFIG = {
	"staker-interval": "100ms",
	"make-assertion-interval": "100ms",
} as const;

const FAST_EXECUTION_SEQUENCER_CONFIG = {
	"max-block-speed": "100ms",
} as const;

// L3 sequencer runs at 333ms (not 100ms) to widen the gap between block
// production cycles, reducing the consensus/execution msgIdx-race window that
// under load makes the TransactionStreamer reject eth_sendRawTransaction with
// "wrong msgIdx" (JSON-RPC -32000).
const L3_EXECUTION_SEQUENCER_CONFIG = {
	"max-block-speed": "333ms",
} as const;

function getJsonObject(parent: JsonObject, key: string): JsonObject {
	const value = parent[key];
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Expected ${key} to be an object`);
	}
	return value as JsonObject;
}

function getOrCreateJsonObject(parent: JsonObject, key: string): JsonObject {
	const value = parent[key];
	if (value === undefined) {
		const next: JsonObject = {};
		parent[key] = next;
		return next;
	}
	return getJsonObject(parent, key);
}

function normalizePrivateKey(value: string): string {
	return value.startsWith("0x") ? value.slice(2) : value;
}

function patchChainInfoJsonStakeToken(config: JsonObject, stakeTokenAddress?: string): void {
	if (!stakeTokenAddress) {
		return;
	}
	const chain = getJsonObject(config, "chain");
	const infoJson = chain["info-json"];
	if (typeof infoJson !== "string") {
		return;
	}
	const parsed = JSON.parse(infoJson) as Array<Record<string, unknown>>;
	for (const entry of parsed) {
		const rollup = entry["rollup"];
		if (typeof rollup === "object" && rollup !== null && !Array.isArray(rollup)) {
			(rollup as Record<string, unknown>)["stake-token"] = stakeTokenAddress;
		}
	}
	chain["info-json"] = JSON.stringify(parsed);
}

export function patchGeneratedL2NodeConfig(
	config: JsonObject,
	batchPosterPrivateKey?: string,
	stakeTokenAddress?: string,
	stakerPrivateKey?: string,
): JsonObject {
	const next = structuredClone(config);
	const node = getJsonObject(next, "node");
	const batchPoster = getJsonObject(node, "batch-poster");
	const delayedSequencer = getJsonObject(node, "delayed-sequencer");
	const staker = getJsonObject(node, "staker");
	const execution = getOrCreateJsonObject(next, "execution");

	patchChainInfoJsonStakeToken(next, stakeTokenAddress);
	if (batchPosterPrivateKey) {
		batchPoster["parent-chain-wallet"] = {
			"private-key": normalizePrivateKey(batchPosterPrivateKey),
		};
	}
	if (stakerPrivateKey) {
		staker["parent-chain-wallet"] = {
			"private-key": normalizePrivateKey(stakerPrivateKey),
		};
	}
	staker["use-smart-contract-wallet"] = true;
	staker["disable-challenge"] = true;
	batchPoster["l1-block-bound"] = "ignore";
	Object.assign(batchPoster, FAST_BATCH_POSTER_CONFIG);
	batchPoster["data-poster"] = {
		"wait-for-l1-finality": false,
	};
	delayedSequencer["finalize-distance"] = 0;
	Object.assign(getOrCreateJsonObject(execution, "sequencer"), FAST_EXECUTION_SEQUENCER_CONFIG);

	return next;
}

export function patchGeneratedL3NodeConfig(
	config: JsonObject,
	parentChainUrl: string,
	enableStaker = true,
	batchPosterPrivateKey?: string,
): JsonObject {
	const next = structuredClone(config);
	const chain = getJsonObject(next, "chain");
	const parentChain = getJsonObject(next, "parent-chain");
	const parentConnection = getJsonObject(parentChain, "connection");
	const node = getJsonObject(next, "node");
	const batchPoster = getJsonObject(node, "batch-poster");
	const bold = getOrCreateJsonObject(node, "bold");
	const dangerous = getJsonObject(node, "dangerous");
	const delayedSequencer = getJsonObject(node, "delayed-sequencer");
	const staker = getOrCreateJsonObject(node, "staker");
	const execution = getJsonObject(next, "execution");

	next["ensure-rollup-deployment"] = false;
	// biome-ignore lint/performance/noDelete: nitro's config loader treats `info-json` as present when the key exists; must remove it, not set to undefined
	delete chain["info-json"];
	chain["id"] = 333333;
	chain["info-files"] = ["/config/l3_chain_info.json"];
	parentConnection["url"] = parentChainUrl;
	if (batchPosterPrivateKey) {
		batchPoster["parent-chain-wallet"] = {
			"private-key": normalizePrivateKey(batchPosterPrivateKey),
		};
	}
	batchPoster["redis-url"] = "";
	batchPoster["l1-block-bound"] = "ignore";
	Object.assign(batchPoster, FAST_BATCH_POSTER_CONFIG);
	batchPoster["data-poster"] = {
		"wait-for-l1-finality": false,
	};
	staker["enable"] = enableStaker;
	staker["use-smart-contract-wallet"] = true;
	staker["disable-challenge"] = true;
	Object.assign(staker, FAST_STAKER_CONFIG);
	Object.assign(bold, FAST_BOLD_CONFIG);
	dangerous["disable-blob-reader"] = true;
	delayedSequencer["finalize-distance"] = 0;
	execution["forwarding-target"] = "null";
	Object.assign(getOrCreateJsonObject(execution, "sequencer"), L3_EXECUTION_SEQUENCER_CONFIG);
	next["persistent"] = { chain: "local" };
	next["ws"] = { addr: "0.0.0.0" };

	return next;
}
