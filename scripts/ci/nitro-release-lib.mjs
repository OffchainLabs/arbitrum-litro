/**
 * Pure helpers for bump-nitro.mjs: pick the newest stable Nitro release, find
 * its nitro-node image tag, and rewrite the Dockerfile's NITRO_IMAGE default.
 */

export const NITRO_IMAGE_REPOSITORY = "offchainlabs/nitro-node";

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const ARG_LINE = /^ARG NITRO_IMAGE=offchainlabs\/nitro-node:(v\d+\.\d+\.\d+)-([0-9a-f]+)$/m;

/** @param {string} tag @returns {[number, number, number] | undefined} */
export function parseStableVersion(tag) {
	const match = STABLE_TAG.exec(tag);
	if (!match) {
		return undefined;
	}
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** @param {[number, number, number]} a @param {[number, number, number]} b */
export function compareVersions(a, b) {
	for (let i = 0; i < 3; i++) {
		const diff = /** @type {number} */ (a[i]) - /** @type {number} */ (b[i]);
		if (diff !== 0) {
			return diff;
		}
	}
	return 0;
}

/**
 * Nitro ships patches on older lines after newer ones (v3.11.5 after v3.12.0),
 * so the newest release by date is not the highest version.
 *
 * @param {Array<{ tag_name: string; draft?: boolean; prerelease?: boolean }>} releases
 * @returns {string | undefined}
 */
export function pickLatestStableRelease(releases) {
	/** @type {{ tag: string; version: [number, number, number] } | undefined} */
	let best;
	for (const release of releases) {
		if (release.draft || release.prerelease) {
			continue;
		}
		const version = parseStableVersion(release.tag_name);
		if (version && (!best || compareVersions(version, best.version) > 0)) {
			best = { tag: release.tag_name, version };
		}
	}
	return best?.tag;
}

/**
 * The plain multi-arch tag is `<version>-<short sha>`; every other tag for the
 * release adds a suffix (-slim, -dev, -arm64, ...).
 *
 * @param {string} version
 * @param {string[]} tagNames
 * @returns {string}
 */
export function pickImageTag(version, tagNames) {
	const exact = new RegExp(`^${version.replaceAll(".", "\\.")}-[0-9a-f]{7,}$`);
	const matches = [...new Set(tagNames.filter((name) => exact.test(name)))];
	if (matches.length !== 1) {
		throw new Error(
			`expected one ${NITRO_IMAGE_REPOSITORY} tag for ${version}, found ${matches.length}: ${matches.join(", ") || "none"}`,
		);
	}
	return /** @type {string} */ (matches[0]);
}

/**
 * @param {string} dockerfile
 * @returns {{ image: string; version: string }}
 */
export function readPinnedNitroImage(dockerfile) {
	const match = ARG_LINE.exec(dockerfile);
	if (!match) {
		throw new Error("no `ARG NITRO_IMAGE=offchainlabs/nitro-node:vX.Y.Z-<sha>` line found");
	}
	return {
		image: `${NITRO_IMAGE_REPOSITORY}:${match[1]}-${match[2]}`,
		version: /** @type {string} */ (match[1]),
	};
}

/**
 * @param {string} dockerfile
 * @param {string} image full `offchainlabs/nitro-node:<tag>` reference
 */
export function rewritePinnedNitroImage(dockerfile, image) {
	readPinnedNitroImage(dockerfile);
	return dockerfile.replace(ARG_LINE, `ARG NITRO_IMAGE=${image}`);
}
