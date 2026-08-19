import { findRepoRoot } from "@arbitrum/testnode";

export function findProjectRoot(startDir = import.meta.dirname): string {
	return findRepoRoot(startDir);
}

let cached: string | undefined;
export function projectRoot(): string {
	if (cached === undefined) {
		cached = findProjectRoot();
	}
	return cached;
}
