import { DEFAULT_TESTNODE_IMAGE_REPOSITORY } from "../../packages/testnode/src/runtime.mjs";

/**
 * Maps a registry selection onto the repositories a release writes to.
 *
 * Both registries carry the same image name, taken from the one constant
 * consumers resolve, so a rename cannot leave the two registries disagreeing
 * about what the image is called.
 */

export const REGISTRIES = ["ghcr", "dockerhub"];

const IMAGE_NAME = DEFAULT_TESTNODE_IMAGE_REPOSITORY.split("/").pop();

/**
 * @param {{ registries: string; owner?: string; dockerhubRepository?: string }} options
 * @returns {{ registry: string; repository: string }[]}
 */
export function resolveRepositories({ registries, owner, dockerhubRepository }) {
	const selected = [
		...new Set(
			String(registries || "")
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean),
		),
	];
	if (selected.length === 0) {
		throw new Error("registries is required");
	}
	const unknown = selected.filter((entry) => !REGISTRIES.includes(entry));
	if (unknown.length > 0) {
		throw new Error(`unknown registries: ${unknown.join(" ")} (expected ${REGISTRIES.join(", ")})`);
	}
	return selected.map((registry) => {
		if (registry === "ghcr") {
			if (!owner) {
				throw new Error("owner is required to resolve a ghcr repository");
			}
			return { registry, repository: `ghcr.io/${owner.toLowerCase()}/${IMAGE_NAME}` };
		}
		return { registry, repository: dockerhubRepository || DEFAULT_TESTNODE_IMAGE_REPOSITORY };
	});
}
