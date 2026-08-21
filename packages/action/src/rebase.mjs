// Consumes the refs the resolve step already computed, so this step cannot
// disagree with it about variant or image.
import { pruneStaleRebasedImages, rebaseTestnodeImage } from "./lib.mjs";

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
log(`built ${state.imageRef}`);
