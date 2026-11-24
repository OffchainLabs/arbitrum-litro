import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	pickImageTag,
	pickLatestStableRelease,
	readPinnedNitroImage,
	rewritePinnedNitroImage,
} from "../scripts/ci/nitro-release-lib.mjs";

describe("pickLatestStableRelease", () => {
	it("takes the highest stable version, not the newest by date", () => {
		expect(
			pickLatestStableRelease([
				{ tag_name: "v3.11.5" },
				{ tag_name: "v3.13.0-rc.1", prerelease: true },
				{ tag_name: "v3.12.10" },
				{ tag_name: "v3.12.2" },
				{ tag_name: "v3.14.0", draft: true },
				{ tag_name: "consensus-v40" },
			]),
		).toBe("v3.12.10");
	});

	it("returns undefined when nothing is stable", () => {
		expect(
			pickLatestStableRelease([{ tag_name: "v4.0.0-rc.1", prerelease: true }]),
		).toBeUndefined();
	});
});

describe("pickImageTag", () => {
	const tags = [
		"v3.12.2-5f02f3f-arm64",
		"v3.12.2-5f02f3f",
		"v3.12.2-5f02f3f-slim",
		"v3.12.20-aaaaaaa",
	];

	it("picks the plain multi-arch tag", () => {
		expect(pickImageTag("v3.12.2", tags)).toBe("v3.12.2-5f02f3f");
	});

	it("fails when the release has no image yet", () => {
		expect(() => pickImageTag("v3.12.3", tags)).toThrow(/found 0/);
	});

	it("fails on two candidate tags", () => {
		expect(() => pickImageTag("v3.12.2", [...tags, "v3.12.2-1234567"])).toThrow(/found 2/);
	});
});

describe("the Dockerfile pin", () => {
	const dockerfile = readFileSync("docker/testnode.Dockerfile", "utf-8");

	it("is in the shape bump-nitro.mjs rewrites", () => {
		expect(readPinnedNitroImage(dockerfile).image).toMatch(
			/^offchainlabs\/nitro-node:v\d+\.\d+\.\d+-[0-9a-f]+$/,
		);
	});

	it("rewrites only the ARG default", () => {
		const next = rewritePinnedNitroImage(dockerfile, "offchainlabs/nitro-node:v9.9.9-abcdef0");
		expect(readPinnedNitroImage(next)).toEqual({
			image: "offchainlabs/nitro-node:v9.9.9-abcdef0",
			version: "v9.9.9",
		});
		expect(next.split("\n").length).toBe(dockerfile.split("\n").length);
		expect(next).toContain("FROM ${NITRO_IMAGE}");
	});
});
