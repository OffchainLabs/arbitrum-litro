// Consumes the refs the resolve step already computed, so this step cannot
// disagree with it about variant or image.
import { pruneStaleRebasedImages, rebaseTestnodeImage, runDocker } from "./lib.mjs";

const IMAGE_INSPECT_TIMEOUT_MS = 10_000;

/** @param {string} message */
function log(message) {
	console.log(`[arbitrum-testnode] ${message}`);
}

/** @param {string} name */
function required(name) {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`${name} is required; expected it from the resolve step outputs`);
	}
	return value;
}

const state = {
	baseImageRef: required("BASE_IMAGE_REF"),
	imageRef: required("IMAGE_REF"),
	nitroImage: required("NITRO_IMAGE"),
};

pruneStaleRebasedImages();
log(`rebasing ${state.baseImageRef} onto ${state.nitroImage}`);
rebaseTestnodeImage(state);
// The image ID distinguishes a genuine rebuild from a cache reuse when a
// mutable ref (e.g. nitro-node-dev:latest) produces the same tag every run.
try {
	const imageId = runDocker(["image", "inspect", "--format", "{{.Id}}", state.imageRef], {
		timeout: IMAGE_INSPECT_TIMEOUT_MS,
	}).trim();
	log(`built ${state.imageRef} (${imageId})`);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	if (/no such (image|object)/i.test(message)) {
		throw new Error(
			`rebased image ${state.imageRef} is not visible to the docker daemon — the build may have run on a docker-container buildx builder (check BUILDX_BUILDER): ${message}`,
		);
	}
	// A transient inspect failure must not fail a step whose build succeeded.
	log(`built ${state.imageRef} (image id unavailable: ${message.split("\n")[0]})`);
}
