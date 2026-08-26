import { execFileSync } from "node:child_process";
import { DEFAULT_TESTNODE_IMAGE_REPOSITORY } from "../../packages/testnode/src/runtime.mjs";

/**
 * Points `latest-<variant>` at the just-published version of that variant.
 *
 * crane rather than `imagetools create`, which re-wraps its source in a new
 * index: matching digests are what let a consumer tell which release the alias
 * is, and what carries the published index across intact.
 */

function readArg(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) {
		return "";
	}
	return process.argv[index + 1] || "";
}

const owner = readArg("--owner");
if (!owner) {
	throw new Error("--owner is required");
}

// Same derivation as resolve-publish-refs.mjs, so an alias cannot name a
// repository nothing pulls.
const imageName = DEFAULT_TESTNODE_IMAGE_REPOSITORY.split("/").pop();
const repository = `ghcr.io/${owner.toLowerCase()}/${imageName}`;

const version = process.env.VERSION;
if (!version) {
	throw new Error("VERSION is required");
}

const matrix = JSON.parse(process.env.MATRIX ?? "{}");
const rows = matrix.include ?? [];
if (rows.length === 0) {
	throw new Error("MATRIX contained no rows");
}

const contractsTag = (contractsVersion) => `nc${contractsVersion.replace(/^v/, "")}`;

for (const row of rows) {
	const source = `${repository}:${version}-${contractsTag(row.contractsVersion)}-${row.variant}`;
	const target = `${repository}:latest-${row.variant}`;
	console.log(`${target} -> ${source}`);
	execFileSync("crane", ["copy", source, target], { stdio: "inherit" });
}
