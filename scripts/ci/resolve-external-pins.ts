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
 * Exports the pinned external contracts repositories to `$GITHUB_ENV`.
 *
 * Workflows read their pins from here rather than pasting commits inline, so the
 * host checkout `init` deploys from, the build context the image is built with,
 * and the OCI labels recording what the image contains cannot drift apart -- and
 * bumping a contracts pin is a one-line change in external-pins.ts.
 *
 * Run through tsx: this has to work before the workspace is built, since the
 * jobs that need the pins run before anything compiles.
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
	// The ref and the commit are the same value: the pin is a commit, and the
	// label records it under both names for callers that expect a symbolic ref.
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
