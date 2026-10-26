import { findRepoRoot } from "@arbitrum/testnode";

export function findProjectRoot(startDir = import.meta.dirname): string {
	return findRepoRoot(startDir);
}

let cached: string | undefined;

/** The arbitrum-litro checkout the CLI runs from, for the commands that need one. */
export function projectRoot(): string {
	const root = tryProjectRoot();
	if (root === undefined) {
		throw new Error(
			"This command runs from an arbitrum-litro checkout: git clone https://github.com/OffchainLabs/arbitrum-litro",
		);
	}
	return root;
}

/** The checkout, or undefined when the CLI runs from an installed package. */
export function tryProjectRoot(): string | undefined {
	if (cached === undefined) {
		try {
			cached = findProjectRoot();
		} catch {
			return undefined;
		}
	}
	return cached;
}
