import { appendFileSync } from "node:fs";
import {
	DEFAULT_NITRO_CONTRACTS_COMMIT,
	DEFAULT_NITRO_CONTRACTS_RELEASE,
	DEFAULT_TOKEN_BRIDGE_COMMIT,
	NITRO_CONTRACTS_REPOSITORY,
	TOKEN_BRIDGE_REPOSITORY,
	gitBuildContext,
} from "../../packages/core/src/external-pins.js";

/**
 * Exports the pinned external contracts repositories to `$GITHUB_ENV`, so the
 * checkout, the build context and the image labels cannot name different
 * commits. Run through tsx, since the jobs needing pins run before any build.
 */

const pins = {
	NITRO_CONTRACTS_COMMIT: DEFAULT_NITRO_CONTRACTS_COMMIT,
	NITRO_CONTRACTS_DOCKER_CONTEXT: gitBuildContext(
		NITRO_CONTRACTS_REPOSITORY,
		DEFAULT_NITRO_CONTRACTS_COMMIT,
	),
	NITRO_CONTRACTS_REF: DEFAULT_NITRO_CONTRACTS_RELEASE,
	NITRO_CONTRACTS_REPOSITORY,
	TOKEN_BRIDGE_COMMIT: DEFAULT_TOKEN_BRIDGE_COMMIT,
	TOKEN_BRIDGE_DOCKER_CONTEXT: gitBuildContext(
		TOKEN_BRIDGE_REPOSITORY,
		DEFAULT_TOKEN_BRIDGE_COMMIT,
	),
	// Same value: the pin is a commit, recorded under both names for callers
	// expecting a symbolic ref.
	TOKEN_BRIDGE_REF: DEFAULT_TOKEN_BRIDGE_COMMIT,
	TOKEN_BRIDGE_REPOSITORY,
};

for (const [name, value] of Object.entries(pins)) {
	console.log(`${name}=${value}`);
}

const target = process.env["GITHUB_ENV"];
if (target) {
	appendFileSync(
		target,
		`${Object.entries(pins)
			.map(([name, value]) => `${name}=${value}`)
			.join("\n")}\n`,
	);
}
