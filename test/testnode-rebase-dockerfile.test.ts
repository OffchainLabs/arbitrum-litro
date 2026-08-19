import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The rebase only works while it agrees with `testnode.Dockerfile` on what the
 * testnode artifacts are, so expectations here are derived from that file rather
 * than restated: adding a COPY there fails this suite until the rebase copies it.
 */

const testnodeDockerfile = readFileSync("docker/testnode.Dockerfile", "utf-8");
const rebaseDockerfile = readFileSync("docker/testnode-rebase.Dockerfile", "utf-8");

/** The destination of a COPY instruction: its last whitespace-separated token. */
function copyDestinations(lines: string[], predicate: (line: string) => boolean): string[] {
	return lines
		.filter((line) => /^COPY\s/.test(line.trim()))
		.filter(predicate)
		.map((line) => line.trim().split(/\s+/).at(-1) as string);
}

/** Instructions in the final stage -- everything after the last FROM. */
function finalStageLines(dockerfile: string): string[] {
	const lines = dockerfile.split(/\r?\n/);
	let lastFrom = -1;
	lines.forEach((line, index) => {
		if (/^FROM\s/.test(line.trim())) {
			lastFrom = index;
		}
	});
	return lines.slice(lastFrom + 1);
}

/** Whether `path` is copied by a destination that is it or an ancestor of it. */
function isCovered(path: string, destinations: string[]): boolean {
	return destinations.some((dest) => path === dest || path.startsWith(`${dest}/`));
}

describe("testnode-rebase.Dockerfile", () => {
	const sourceArtifacts = copyDestinations(finalStageLines(testnodeDockerfile), () => true);
	const rebaseArtifacts = copyDestinations(finalStageLines(rebaseDockerfile), (line) =>
		line.includes("--from=testnode"),
	);

	it("finds the artifact paths it is meant to compare", () => {
		// Guards the parser itself: a silently-empty list would pass everything.
		expect(sourceArtifacts.length).toBeGreaterThanOrEqual(12);
		expect(rebaseArtifacts.length).toBeGreaterThan(0);
		expect(sourceArtifacts).toContain("/usr/local/bin/anvil");
		expect(sourceArtifacts).toContain("/opt/arbitrum-testnode/runtime-config");
	});

	it("labels rebase outputs with the same label every GC command filters on", () => {
		// A prune whose label filter drifts silently matches nothing, forever.
		const label = "org.offchainlabs.testnode-rebase=true";
		expect(rebaseDockerfile).toContain(`LABEL ${label}`);
		expect(readFileSync("README.md", "utf-8")).toContain(`label=${label}`);
		expect(readFileSync("packages/testnode/src/runtime.mjs", "utf-8")).toContain(`"${label}"`);
	});

	it("documents the same GC age window the code prunes with", () => {
		const runtime = readFileSync("packages/testnode/src/runtime.mjs", "utf-8");
		const maxAge = runtime.match(/REBASED_IMAGE_GC_MAX_AGE = "([^"]+)"/)?.[1];
		expect(maxAge).toBeDefined();
		expect(readFileSync("README.md", "utf-8")).toContain(`until=${maxAge}`);
	});

	it("copies every artifact the testnode image layers onto Nitro", () => {
		const missing = sourceArtifacts.filter((path) => !isCovered(path, rebaseArtifacts));
		expect(missing).toEqual([]);
	});

	it("takes each artifact from the testnode image rather than the build context", () => {
		// A bare COPY would read from the build context, which the rebase leaves
		// empty; every copy has to name the testnode stage.
		const copies = finalStageLines(rebaseDockerfile).filter((line) => /^COPY\s/.test(line.trim()));
		expect(copies.length).toBeGreaterThan(0);
		expect(copies.every((line) => line.includes("--from=testnode"))).toBe(true);
	});

	it("reproduces the runtime contract of the testnode image", () => {
		for (const instruction of ["EXPOSE 8545 8547 8548 8549 8550 8080", "USER user"]) {
			expect(testnodeDockerfile).toContain(instruction);
			expect(rebaseDockerfile).toContain(instruction);
		}
		expect(rebaseDockerfile).toContain('ENTRYPOINT ["/usr/local/bin/arbitrum-testnode"]');
		expect(rebaseDockerfile).toContain("CMD /usr/local/bin/healthcheck.sh");
	});

	it("reproduces the filesystem setup the entrypoint depends on", () => {
		// yarn is a symlink created at build time, so it is not COPY-able; the
		// entrypoint symlinks network files into /tokenbridge-data at boot.
		expect(rebaseDockerfile).toContain("ln -sf /opt/yarn-v1.22.22/bin/yarn /usr/local/bin/yarn");
		expect(rebaseDockerfile).toContain("mkdir -p /tokenbridge-data");
	});

	it("declares both images as build args and never pins a default Nitro image", () => {
		expect(rebaseDockerfile).toContain("ARG TESTNODE_IMAGE");
		expect(rebaseDockerfile).toContain("ARG NITRO_IMAGE");
		// A default would silently rebase onto the wrong Nitro when the caller's
		// build arg is missing; the caller always supplies both.
		expect(rebaseDockerfile).not.toMatch(/ARG NITRO_IMAGE=/);
		expect(rebaseDockerfile).not.toMatch(/ARG TESTNODE_IMAGE=/);
	});

	it("only reaches for the network when libstdc++6 is genuinely absent", () => {
		// Nitro images already carry it; an unconditional apt-get would add a
		// network dependency to every rebase.
		expect(rebaseDockerfile).toMatch(/if ! ldconfig -p \| grep -q .*libstdc\+\+/);
	});
});
