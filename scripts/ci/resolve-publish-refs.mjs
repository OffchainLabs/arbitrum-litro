import { appendFileSync } from "node:fs";
import {
	DEFAULT_TESTNODE_IMAGE_REPOSITORY,
	buildTestnodeImageRef,
} from "../../packages/testnode/src/runtime.mjs";

/**
 * Resolves the tag and repository one matrix row publishes, through
 * buildTestnodeImageRef so a release cannot publish a shape nothing pulls. Both
 * architectures resolve here, so they cannot land under different tags.
 */

function readArg(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) {
		return "";
	}
	return process.argv[index + 1] || "";
}

const contractsVersion = readArg("--contracts-version");
const owner = readArg("--owner");
const variant = readArg("--variant");
const version = readArg("--version");

if (!owner) {
	throw new Error("--owner is required");
}

// From the constant consumers resolve, so a rename cannot leave releases
// publishing under a name nothing pulls.
const imageName = DEFAULT_TESTNODE_IMAGE_REPOSITORY.split("/").pop();
const repository = `ghcr.io/${owner.toLowerCase()}/${imageName}`;
const tag = buildTestnodeImageRef({
	contractsVersion,
	imageRepository: repository,
	variant,
	version,
});

console.log(`publishing ${tag}`);

if (process.env.GITHUB_OUTPUT) {
	// Untagged: the arm64 job pushes by digest, which names a repository.
	appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\nrepository=${repository}\n`);
}
