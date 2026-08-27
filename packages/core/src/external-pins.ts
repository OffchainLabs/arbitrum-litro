/**
 * Every reference to an external contracts repository this project pulls in.
 *
 * The host checkout, the image build context and the provenance labels must all
 * name the same commit; a pasted copy anywhere ships an image whose labels
 * describe contracts it does not contain. Imports nothing, so CI can read it
 * before the workspace is built.
 */

export const TOKEN_BRIDGE_REPOSITORY = "https://github.com/OffchainLabs/token-bridge-contracts.git";
export const DEFAULT_TOKEN_BRIDGE_COMMIT = "5975d8f7360816341be7f94fd333ef240f4aec23";

export const NITRO_CONTRACTS_REPOSITORY = "https://github.com/OffchainLabs/nitro-contracts.git";
export const DEFAULT_NITRO_CONTRACTS_RELEASE = "v3.2.0";
export const DEFAULT_NITRO_CONTRACTS_COMMIT = "2695e7b3e3f460531e2b77fed48a60561c54d90e";

/** A commit-pinned git build context, as `--build-context` takes it. */
export function gitBuildContext(repository: string, commit: string): string {
	return `${repository}#${commit}`;
}
