import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
	NITRO_IMAGE_REPOSITORY,
	compareVersions,
	parseStableVersion,
	pickImageTag,
	pickLatestStableRelease,
	readPinnedNitroImage,
	rewritePinnedNitroImage,
} from "./nitro-release-lib.mjs";

/**
 * Moves docker/testnode.Dockerfile's NITRO_IMAGE default to the newest stable
 * Nitro release. Writes changed/current/latest/image to GITHUB_OUTPUT when set.
 * `--dry-run` reports without writing the Dockerfile.
 */

const DOCKERFILE = "docker/testnode.Dockerfile";
const dryRun = process.argv.includes("--dry-run");

/** @param {string} url @param {Record<string, string>} [headers] */
async function getJson(url, headers = {}) {
	const response = await fetch(url, { headers });
	if (!response.ok) {
		throw new Error(`GET ${url}: HTTP ${response.status}`);
	}
	return response.json();
}

const githubHeaders = /** @type {Record<string, string>} */ ({
	Accept: "application/vnd.github+json",
	...(process.env["GITHUB_TOKEN"]
		? { Authorization: `Bearer ${process.env["GITHUB_TOKEN"]}` }
		: {}),
});
const releases = await getJson(
	"https://api.github.com/repos/OffchainLabs/nitro/releases?per_page=50",
	githubHeaders,
);
const latest = pickLatestStableRelease(releases);
if (!latest) {
	throw new Error("no stable Nitro release found");
}

const dockerfile = readFileSync(DOCKERFILE, "utf-8");
const pinned = readPinnedNitroImage(dockerfile);
const newer =
	compareVersions(
		/** @type {[number, number, number]} */ (parseStableVersion(latest)),
		/** @type {[number, number, number]} */ (parseStableVersion(pinned.version)),
	) > 0;

let image = pinned.image;
if (newer) {
	const tags = await getJson(
		`https://hub.docker.com/v2/repositories/${NITRO_IMAGE_REPOSITORY}/tags?page_size=100&name=${latest}-`,
	);
	image = `${NITRO_IMAGE_REPOSITORY}:${pickImageTag(
		latest,
		tags.results.map((/** @type {{ name: string }} */ t) => t.name),
	)}`;
	if (!dryRun) {
		writeFileSync(DOCKERFILE, rewritePinnedNitroImage(dockerfile, image));
	}
}

console.log(
	newer
		? `${pinned.image} -> ${image}${dryRun ? " (dry run)" : ""}`
		: `${pinned.image} is current (latest stable ${latest})`,
);

if (process.env["GITHUB_OUTPUT"]) {
	appendFileSync(
		process.env["GITHUB_OUTPUT"],
		`changed=${newer}\ncurrent=${pinned.version}\nlatest=${latest}\nimage=${image}\n`,
	);
}
