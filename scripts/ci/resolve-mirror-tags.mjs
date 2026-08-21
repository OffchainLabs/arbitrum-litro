import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

/**
 * Lists the tags a version actually has in the source repository.
 *
 * Enumerating the registry rather than re-deriving from resolvePublishMatrix:
 * that function describes what a release publishes *now*, so it silently omits
 * tags an older release published under rules since changed. A mirror that
 * copies fewer tags than exist looks like a success.
 */

function readArg(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) {
		return "";
	}
	return process.argv[index + 1] || "";
}

const repository = readArg("--repository");
if (!repository) {
	throw new Error("--repository is required");
}

const version = readArg("--version");
if (!version) {
	throw new Error("--version is required");
}

const variant = readArg("--variant") || "all";
const contractsVersion = readArg("--contracts-version") || "all";

const listed = execFileSync("crane", ["ls", repository], { encoding: "utf-8" })
	.split("\n")
	.map((line) => line.trim())
	.filter(Boolean);

// `<version>-nc<contracts>-<variant>`, matching buildTestnodeImageRef.
const pattern = /^(?<version>.+)-nc(?<contracts>[^-]+)-(?<variant>.+)$/;

const tags = listed.filter((tag) => {
	const parts = pattern.exec(tag)?.groups;
	if (!parts || parts.version !== version) {
		return false;
	}
	if (variant !== "all" && parts.variant !== variant) {
		return false;
	}
	return contractsVersion === "all" || `v${parts.contracts}` === contractsVersion;
});

if (tags.length === 0) {
	throw new Error(
		`no tags in ${repository} match version ${version} (variant ${variant}, contracts ${contractsVersion})`,
	);
}

tags.sort();
console.error(`mirroring ${tags.length} tags: ${tags.join(" ")}`);

if (process.env.GITHUB_OUTPUT) {
	appendFileSync(process.env.GITHUB_OUTPUT, `list<<TAGS\n${tags.join("\n")}\nTAGS\n`);
}
