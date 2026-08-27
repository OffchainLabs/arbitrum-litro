import { execFileSync } from "node:child_process";

/**
 * Asserts a tag resolves to a multi-arch index covering the expected platforms.
 *
 * `imagetools create` succeeds when handed one source, so a merge that lost a
 * platform publishes silently and crane copies it on into the aliases.
 */

function readArg(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) {
		return "";
	}
	return process.argv[index + 1] || "";
}

const imageRef = readArg("--image-ref");
if (!imageRef) {
	throw new Error("--image-ref is required");
}

const expected = (readArg("--platforms") || "linux/amd64,linux/arm64")
	.split(",")
	.map((entry) => entry.trim())
	.filter(Boolean);

const manifest = JSON.parse(
	execFileSync(
		"docker",
		["buildx", "imagetools", "inspect", imageRef, "--format", "{{json .Manifest}}"],
		{ encoding: "utf-8" },
	),
);

// An unmerged tag is a plain manifest, which would otherwise read as an index
// covering no platforms.
if (!Array.isArray(manifest.manifests)) {
	throw new Error(
		`${imageRef} is a single-platform manifest (${manifest.mediaType}), not a multi-arch index`,
	);
}

// Attestation manifests ride along as `unknown/unknown`; not runnable platforms.
const platforms = manifest.manifests
	.map((entry) => `${entry.platform?.os}/${entry.platform?.architecture}`)
	.filter((platform) => !platform.includes("unknown"));

const missing = expected.filter((platform) => !platforms.includes(platform));
if (missing.length > 0) {
	throw new Error(
		`${imageRef} covers ${platforms.join(" ") || "no platforms"}, missing ${missing.join(" ")}`,
	);
}

console.log(`${imageRef} covers ${platforms.join(" ")}`);
