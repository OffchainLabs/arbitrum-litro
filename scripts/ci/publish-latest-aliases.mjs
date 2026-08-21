import { execFileSync } from "node:child_process";
import { resolveRepositories } from "./registries.mjs";

/**
 * Points `latest-<variant>` at the just-published version of that variant, in
 * every repository the release was pushed to.
 *
 * Copies with crane rather than `docker buildx imagetools create`, which wraps a
 * single-arch source in a new index and so would give the alias a different
 * digest than the version tag it names. Matching digests are what let a consumer
 * tell which release `latest-<variant>` currently is.
 */

function readArg(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) {
		return "";
	}
	return process.argv[index + 1] || "";
}

const repositories = resolveRepositories({
	dockerhubRepository: readArg("--dockerhub-repository"),
	owner: readArg("--owner"),
	registries: readArg("--registries"),
}).map((entry) => entry.repository);

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

for (const repository of repositories) {
	for (const row of rows) {
		const source = `${repository}:${version}-${contractsTag(row.contractsVersion)}-${row.variant}`;
		const target = `${repository}:latest-${row.variant}`;
		console.log(`${target} -> ${source}`);
		execFileSync("crane", ["copy", source, target], { stdio: "inherit" });
	}
}
