// Differential fixture for the nitro-image rebase wiring.
//
// State resolution, the rebased tag digest, and the `docker build` argv are all
// pure and deterministic, so any refactor of that wiring is correct only if this
// dump is byte-identical before and after. Capture a baseline, refactor, diff:
//
//   node scripts/ci/rebase-fixture.mjs > /tmp/rebase-baseline.txt
//   node scripts/ci/rebase-fixture.mjs | diff -u /tmp/rebase-baseline.txt -
//
// Paths are pinned to fixed fake workspace/runner dirs so the output carries no
// per-run temp paths.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildActionTestnodeState, rebaseTestnodeImage } from "../../packages/action/src/lib.mjs";

const WORKSPACE = "/fixture/workspace";
const RUNNER_TEMP = "/fixture/runner-temp";

/** Input axes that feed variant selection, tag resolution, and the rebase. */
const SCENARIOS = [
	{ name: "l2", version: "v1.2.3", l3Enabled: "false" },
	{ name: "l2+nitro", version: "v1.2.3", l3Enabled: "false", nitroImage: "nitro-node-dev:latest" },
	{ name: "l3-eth", version: "v1.2.3", l3Enabled: "true" },
	{
		name: "l3-eth+nitro",
		version: "v1.2.3",
		l3Enabled: "true",
		nitroImage: "nitro-node-dev:latest",
	},
	{ name: "timeboost", version: "v1.2.3", l3Enabled: "false", timeboostEnabled: "true" },
	{
		name: "timeboost+nitro",
		version: "v1.2.3",
		l3Enabled: "false",
		timeboostEnabled: "true",
		nitroImage: "nitro-node-dev:latest",
	},
	{ name: "l3-custom-16", version: "v1.2.3", l3Enabled: "true", feeTokenDecimals: "16" },
	{
		name: "l3-custom-16+nitro",
		version: "v1.2.3",
		l3Enabled: "true",
		feeTokenDecimals: "16",
		nitroImage: "nitro-node-dev:latest",
	},
	{ name: "v2.1", version: "v1.2.3", l3Enabled: "true", contractsVersion: "v2.1" },
	{
		name: "v2.1+nitro",
		version: "v1.2.3",
		l3Enabled: "true",
		contractsVersion: "v2.1",
		nitroImage: "nitro-node-dev:latest",
	},
	{ name: "explicit-ref", imageRef: "ghcr.io/acme/testnode:governance", l3Enabled: "false" },
	{
		name: "explicit-ref+nitro",
		imageRef: "ghcr.io/acme/testnode:governance",
		l3Enabled: "false",
		nitroImage: "nitro-node-dev:latest",
	},
	// Whitespace must normalize to "" so the action skips the rebase step.
	{ name: "blank-nitro", version: "v1.2.3", l3Enabled: "false", nitroImage: "   " },
	{
		name: "repository-override",
		version: "v1.2.3",
		l3Enabled: "false",
		imageRepository: "local/arbitrum-testnode",
		nitroImage: "nitro-node-dev:latest",
	},
];

/** Scenario -> the INPUT_* env the composite action would set. */
function envFor(scenario) {
	return {
		INPUT_CONTAINER_NAME: scenario.containerName ?? "",
		INPUT_FEE_TOKEN_DECIMALS: scenario.feeTokenDecimals ?? "",
		INPUT_IMAGE_REF: scenario.imageRef ?? "",
		INPUT_IMAGE_REPOSITORY: scenario.imageRepository ?? "",
		INPUT_L3_ENABLED: scenario.l3Enabled ?? "",
		INPUT_NITRO_CONTRACTS_VERSION: scenario.contractsVersion ?? "",
		INPUT_NITRO_IMAGE: scenario.nitroImage ?? "",
		INPUT_OUTPUT_DIR: scenario.outputDir ?? "",
		INPUT_TIMEBOOST_ENABLED: scenario.timeboostEnabled ?? "",
		INPUT_VERSION: scenario.version ?? "",
	};
}

/** Scenario -> the buildActionTestnodeState options mirroring that env. */
function optionsFor(scenario) {
	return {
		containerName: scenario.containerName,
		contractsVersion: scenario.contractsVersion,
		feeTokenDecimals: scenario.feeTokenDecimals,
		imageRef: scenario.imageRef,
		imageRepository: scenario.imageRepository,
		l3Enabled: scenario.l3Enabled,
		nitroImage: scenario.nitroImage,
		outputDir: scenario.outputDir,
		runnerTemp: RUNNER_TEMP,
		timeboostEnabled: scenario.timeboostEnabled,
		version: scenario.version,
		workspace: WORKSPACE,
	};
}

/** Run the real resolve.mjs entrypoint and return its GITHUB_OUTPUT as pairs. */
function resolveOutputs(scenario) {
	const dir = mkdtempSync(join(tmpdir(), "rebase-fixture-"));
	try {
		const outputFile = join(dir, "github-output");
		execFileSync(process.execPath, ["packages/action/src/resolve.mjs"], {
			env: {
				...process.env,
				...envFor(scenario),
				GITHUB_OUTPUT: outputFile,
				GITHUB_WORKSPACE: WORKSPACE,
				RUNNER_TEMP: RUNNER_TEMP,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		return readFileSync(outputFile, "utf-8").trim().split("\n").sort();
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
}

/** The docker build argv the rebase would run, captured without a daemon. */
function rebaseArgv(state) {
	if (!state.nitroImage) {
		return ["<no rebase>"];
	}
	let argv = [];
	rebaseTestnodeImage(state, {
		contextDir: "/fixture/context",
		dockerfile: "/fixture/docker/testnode-rebase.Dockerfile",
		runner: (args) => {
			argv = args;
		},
	});
	return argv;
}

const lines = [];
for (const scenario of SCENARIOS) {
	lines.push(`## ${scenario.name}`);

	let state;
	try {
		state = buildActionTestnodeState(optionsFor(scenario));
	} catch (error) {
		lines.push(`state: ERROR ${error instanceof Error ? error.message : String(error)}`);
		lines.push("");
		continue;
	}

	lines.push(`state.baseImageRef: ${state.baseImageRef}`);
	lines.push(`state.imageRef: ${state.imageRef}`);
	lines.push(`state.nitroImage: ${JSON.stringify(state.nitroImage)}`);
	lines.push(`state.variant: ${state.variant}`);
	lines.push(`state.snapshotId: ${state.snapshotId}`);
	lines.push(`state.contractsVersion: ${state.contractsVersion}`);
	lines.push(`build argv: ${JSON.stringify(rebaseArgv(state))}`);

	for (const output of resolveOutputs(scenario)) {
		lines.push(`resolve: ${output}`);
	}
	lines.push("");
}

process.stdout.write(`${lines.join("\n")}\n`);
