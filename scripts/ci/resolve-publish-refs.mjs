import { appendFileSync } from "node:fs";
import {
	DEFAULT_TESTNODE_IMAGE_REPOSITORY,
	buildTestnodeImageRef,
} from "../../packages/testnode/src/runtime.mjs";

/**
 * Resolves the tag and repository one matrix row publishes.
 *
 * The ref comes from buildTestnodeImageRef, the same function consumers resolve,
 * so a release cannot publish a tag shape nothing pulls. The arm64 job resolves
 * through here too, so the two architectures of one row cannot disagree about
 * which tag they belong to.
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

// The image name comes from the one constant consumers resolve, so a rename
// cannot leave the workflow publishing under a name nothing pulls.
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
	// The repository is emitted without a tag because the arm64 job pushes its
	// manifest by digest, which names a repository rather than a tag.
	appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\nrepository=${repository}\n`);
}
