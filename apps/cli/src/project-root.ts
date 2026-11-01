import { findRepoRoot } from "@arbitrum/testnode";
import { type InitContext, createInitContext } from "@arbitrum/testnode-core/init-runner.js";

export function findProjectRoot(startDir = import.meta.dirname): string {
	return findRepoRoot(startDir);
}

let cached: string | null | undefined;

/** The checkout the CLI runs from, or null when it runs from an installed package. */
function checkoutRoot(): string | null {
	if (cached === undefined) {
		try {
			cached = findProjectRoot();
		} catch {
			cached = null;
		}
	}
	return cached;
}

/** The arbitrum-litro checkout the CLI runs from, for the commands that need one. */
export function projectRoot(): string {
	const root = checkoutRoot();
	if (root === null) {
		throw new Error(
			"This command runs from an arbitrum-litro checkout: git clone https://github.com/OffchainLabs/arbitrum-litro",
		);
	}
	return root;
}

/** The checkout's init stack (config dir, compose file and project), when there is a checkout. */
export function findCheckout(): InitContext | undefined {
	const root = checkoutRoot();
	return root === null ? undefined : createInitContext(root);
}
