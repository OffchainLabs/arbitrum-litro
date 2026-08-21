import { appendFileSync } from "node:fs";
import { buildTestnodeImageRef } from "../../packages/testnode/src/runtime.mjs";
import { resolveRepositories } from "./registries.mjs";

/**
 * Resolves the tags one matrix row publishes, and refuses to publish over a tag
 * that is already public.
 *
 * Refs come from buildTestnodeImageRef, the same function consumers resolve, so
 * a release cannot publish a tag shape nothing pulls.
 */

function readArg(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) {
		return "";
	}
	return process.argv[index + 1] || "";
}

const contractsVersion = readArg("--contracts-version");
const dockerhubRepository = readArg("--dockerhub-repository");
const owner = readArg("--owner");
const registries = readArg("--registries");
const variant = readArg("--variant");
const version = readArg("--version");
const overwrite = process.argv.includes("--overwrite");

const refs = resolveRepositories({ dockerhubRepository, owner, registries }).map(
	({ registry, repository }) => ({
		registry,
		ref: buildTestnodeImageRef({ contractsVersion, imageRepository: repository, variant, version }),
	}),
);

/**
 * Docker Hub tags are mutable and public: without this, a re-run silently
 * replaces a shipped image. Queried through the Hub API rather than the registry
 * because Docker Hub answers 401 for an unknown repository, which is
 * indistinguishable from bad credentials. Assumes a public repository (a private
 * one 404s whether or not the tag exists).
 */
async function assertTagIsFree(ref) {
	const repository = ref.slice(0, ref.lastIndexOf(":"));
	const tag = ref.slice(ref.lastIndexOf(":") + 1);
	const response = await fetch(`https://hub.docker.com/v2/repositories/${repository}/tags/${tag}`);
	if (response.status === 404) {
		console.log(`${ref} is free`);
		return;
	}
	if (response.status === 200) {
		throw new Error(`${ref} already exists; re-run with overwrite to replace it`);
	}
	throw new Error(`could not determine whether ${ref} exists (HTTP ${response.status})`);
}

const dockerhub = refs.find((entry) => entry.registry === "dockerhub");
if (dockerhub) {
	// A publish must not degrade to a subset of the selected registries when a
	// credential is missing: half-published versions are worse than a failed run.
	if (!process.env.DOCKERHUB_USERNAME || !process.env.DOCKERHUB_TOKEN) {
		throw new Error("DOCKERHUB_USERNAME and DOCKERHUB_TOKEN are required to publish to Docker Hub");
	}
	if (!overwrite) {
		await assertTagIsFree(dockerhub.ref);
	}
}

const tags = refs.map((entry) => entry.ref);
console.log(`publishing ${tags.join(" ")}`);

if (process.env.GITHUB_OUTPUT) {
	appendFileSync(process.env.GITHUB_OUTPUT, `tags<<TAGS\n${tags.join("\n")}\nTAGS\n`);
}
