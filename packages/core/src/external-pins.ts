/**
 * Every reference to an external contracts repository this project pulls in.
 *
 * These values appear in four places that must agree: the host checkout `init`
 * deploys from, the named build context the image is built with, the OCI labels
 * recording what an image contains, and the CI jobs that drive both. A pasted
 * copy in any of them publishes an image whose labels describe contracts it does
 * not contain, which is undetectable once the image is out of sight.
 *
 * This module deliberately imports nothing, so CI can read it without building
 * the workspace first -- see scripts/ci/resolve-external-pins.ts.
 */

export const TOKEN_BRIDGE_REPOSITORY = "https://github.com/OffchainLabs/token-bridge-contracts.git";
export const DEFAULT_TOKEN_BRIDGE_COMMIT = "5975d8f7360816341be7f94fd333ef240f4aec23";

export const NITRO_CONTRACTS_REPOSITORY = "https://github.com/OffchainLabs/nitro-contracts.git";
export const DEFAULT_NITRO_CONTRACTS_RELEASE = "v3.2.0";
export const DEFAULT_NITRO_CONTRACTS_COMMIT = "2695e7b3e3f460531e2b77fed48a60561c54d90e";

/**
 * A git build context pinned to a commit, the form `docker build --build-context`
 * and compose's `additional_contexts` both take.
 */
export function gitBuildContext(repository: string, commit: string): string {
	return `${repository}#${commit}`;
}
