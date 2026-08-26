import { execFileSync } from "node:child_process";
import { DEFAULT_TESTNODE_IMAGE_REPOSITORY } from "../../packages/testnode/src/runtime.mjs";

/**
 * Points `latest-<variant>` at the just-published version of that variant.
 *
 * Copies with crane rather than `docker buildx imagetools create`, which wraps a
 * multi-arch source in a new index and so would give the alias a different
 * digest than the version tag it names. Matching digests are what let a consumer
 * tell which release `latest-<variant>` currently is -- and what carries the
 * published index across intact rather than rebuilding it.
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

// Same derivation as resolve-publish-refs.mjs: the image name comes from the one
// constant consumers resolve, so an alias cannot name a repository nothing pulls.
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
