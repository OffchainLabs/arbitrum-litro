import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
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

function walkFiles(path) {
	const entries = readdirSync(path);
	const files = [];
	for (const entry of entries) {
		const fullPath = join(path, entry);
		const stats = statSync(fullPath);
		if (stats.isDirectory()) {
			files.push(...walkFiles(fullPath));
			continue;
		}
		files.push(fullPath);
	}
	return files;
}

function rewriteTree(rootDir, replacements) {
	for (const filePath of walkFiles(rootDir)) {
		const next = replacements.reduce(
			(content, [pattern, value]) => content.replaceAll(pattern, value),
			readFileSync(filePath, "utf-8"),
		);
		writeFileSync(filePath, next);
	}
}

function extractArchive(archivePath, destination) {
	mkdirSync(destination, { recursive: true });
	execFileSync("tar", ["-xf", archivePath, "-C", destination]);
}

function assertNonEmptyFile(path) {
	if (!existsSync(path)) {
		throw new Error(`Snapshot missing non-empty Anvil state file: ${path}`);
	}
	const stats = statSync(path);
	if (!stats.isFile() || stats.size === 0) {
		throw new Error(`Snapshot missing non-empty Anvil state file: ${path}`);
	}
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
const snapshotDir = resolve(readArg("--snapshot-dir") || join("config", "snapshots", snapshotId));
const outputDir = resolve(readArg("--output-dir") || ".testnode-context");

if (!existsSync(snapshotDir)) {
	throw new Error(`Snapshot directory not found: ${snapshotDir}`);
}

const runtimeConfigDir = join(outputDir, "runtime-config");
const exportConfigDir = join(outputDir, "export-config");
const runtimeDir = join(outputDir, "runtime");
const volumeDir = join(snapshotDir, "volumes");
const anvilStateFile = join(snapshotDir, "anvil-state", "state.json");

assertNonEmptyFile(anvilStateFile);

rmSync(outputDir, { force: true, recursive: true });
mkdirSync(outputDir, { recursive: true });
cpSync(join(snapshotDir, "config"), runtimeConfigDir, { recursive: true });
cpSync(join(snapshotDir, "config"), exportConfigDir, { recursive: true });
cpSync(join(snapshotDir, "anvil-state"), join(runtimeDir, "anvil-state"), { recursive: true });

extractArchive(join(volumeDir, "sequencer-data.tar"), join(runtimeDir, "sequencer", ".arbitrum"));
extractArchive(join(volumeDir, "validator-data.tar"), join(runtimeDir, "validator", ".arbitrum"));
if (definition.l3Enabled) {
	extractArchive(join(volumeDir, "l3node-data.tar"), join(runtimeDir, "l3node", ".arbitrum"));
}

rewriteTree(runtimeConfigDir, [
	["http://host.docker.internal:8545", "http://127.0.0.1:8545"],
	["http://host.docker.internal:8547", "http://127.0.0.1:8547"],
	["http://sequencer:8547", "http://127.0.0.1:8547"],
	["http://l3node:8547", "http://127.0.0.1:8549"],
	["/config/", "/opt/arbitrum-testnode/runtime-config/"],
]);
rewriteTree(exportConfigDir, [
	["http://host.docker.internal:8545", "http://127.0.0.1:8545"],
	["http://host.docker.internal:8547", "http://127.0.0.1:8547"],
	["http://sequencer:8547", "http://127.0.0.1:8547"],
	["http://l3node:8547", "http://127.0.0.1:3347"],
	["http://127.0.0.1:8549", "http://127.0.0.1:3347"],
]);

writeFileSync(
	join(outputDir, "metadata.json"),
	`${JSON.stringify({ l3Enabled: definition.l3Enabled, nitroContractsVersion: contractsVersion, snapshotId, testnodeName, variant }, null, 2)}\n`,
);
