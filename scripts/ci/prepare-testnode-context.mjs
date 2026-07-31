import { basename, dirname, join, resolve } from "node:path";
import { prepareTestnodeContext } from "../../packages/core/dist/snapshot-image.js";
import {
	DEFAULT_NITRO_CONTRACTS_VERSION,
	VARIANTS,
	hasVariantSnapshot,
	resolveVariantSnapshot,
} from "../../packages/testnode/src/runtime.mjs";

function readArg(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) {
		return "";
	}
	return process.argv[index + 1] || "";
}

const variant = readArg("--variant");
if (!variant) {
	throw new Error("Missing required argument --variant");
}
const definition = VARIANTS[variant];
if (!definition) {
	throw new Error(`Unknown variant ${variant}`);
}

const contractsVersion = readArg("--nitro-contracts-version") || "";
const testnodeName = readArg("--testnode-name") || "";
let snapshotId = readArg("--snapshot-id");
if (!snapshotId) {
	const resolveVersion = contractsVersion || DEFAULT_NITRO_CONTRACTS_VERSION;
	if (!hasVariantSnapshot(variant, resolveVersion)) {
		throw new Error(
			`No snapshot bundle for variant ${variant} at contracts version ${resolveVersion}; pass --snapshot-id`,
		);
	}
	snapshotId = resolveVariantSnapshot(variant, resolveVersion).snapshotId;
}

const snapshotDirArg = readArg("--snapshot-dir");
const snapshotDir = resolve(snapshotDirArg || join("config", "snapshots", snapshotId));
const configDir = dirname(dirname(snapshotDir));
const resolvedSnapshotId = basename(snapshotDir);
const outputDir = resolve(readArg("--output-dir") || ".testnode-context");

prepareTestnodeContext({
	configDir,
	snapshotId: resolvedSnapshotId,
	outputDir,
	l3Enabled: definition.l3Enabled,
	nitroContractsVersion: contractsVersion,
	testnodeName,
	variant,
});
