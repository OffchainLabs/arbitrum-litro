// Move every package.json version, the README's action pins and the git tag together, because
// they must agree: apps/cli/package.json feeds DEFAULT_START_IMAGE_VERSION, the README is what
// people copy, and the tag is what `Publish Testnode` stamps on the images. A tag ahead of the
// files publishes images the CLI never defaults to (that drift is why this exists --
// package.json sat at 0.2.6 through the v0.2.7..v0.2.9 releases).
//
//   node scripts/release.mjs 0.2.11          # bump + commit + tag
//   node scripts/release.mjs 0.2.11 --push   # ...and push, triggering publish
//
// The tag push is what starts the release, so it stays opt-in.

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MANIFESTS = [
	"package.json",
	"apps/cli/package.json",
	"packages/action/package.json",
	"packages/core/package.json",
	"packages/testnode/package.json",
];

const README = "README.md";

/** A line carrying this marker keeps its version: it documents a specific old release. */
export const PINNED_MARKER = "# pinned";

/**
 * Point the README's action examples at `version`: every `arbitrum-litro@v…` (and `/bake@v…`)
 * and the `version: v…` input under them, except lines marked {@link PINNED_MARKER}.
 *
 * @param {string} readme
 * @param {string} version without the leading v
 */
export function bumpReadmePins(readme, version) {
	return readme
		.split("\n")
		.map((line) =>
			line.includes(PINNED_MARKER)
				? line
				: line
						.replace(/(arbitrum-litro(?:\/bake)?@)v\d+\.\d+\.\d+(?:-[\w.]+)?/g, `$1v${version}`)
						.replace(/^(\s+version: )v\d+\.\d+\.\d+(?:-[\w.]+)?$/, `$1v${version}`),
		)
		.join("\n");
}

/** @param {string[]} args */
const git = (...args) => execFileSync("git", args, { encoding: "utf-8" }).trim();

/**
 * @param {string} version
 * @param {boolean} push
 */
function checkReleasable(version, push) {
	if (git("status", "--porcelain")) {
		throw new Error("working tree is dirty; commit or stash before releasing");
	}
	if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") {
		throw new Error("releases are cut from main");
	}
	if (git("tag", "--list", `v${version}`)) {
		throw new Error(`tag v${version} already exists`);
	}
	if (push) {
		git("fetch", "origin", "main");
		if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) {
			throw new Error("main is not at origin/main; pull or push it before releasing");
		}
	}
}

/** @param {string} version */
function writeVersion(version) {
	for (const manifest of MANIFESTS) {
		const raw = readFileSync(manifest, "utf-8");
		const updated = raw.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
		if (updated === raw) {
			throw new Error(`no version field updated in ${manifest}`);
		}
		writeFileSync(manifest, updated);
	}
	writeFileSync(README, bumpReadmePins(readFileSync(README, "utf-8"), version));
}

/** @param {string} version */
function commitAndTag(version) {
	git("add", ...MANIFESTS, README);
	git("commit", "-m", `chore(release): v${version}`);
	try {
		// Lightweight like every earlier tag; a signing config would otherwise demand a message.
		git("-c", "tag.gpgSign=false", "tag", `v${version}`);
	} catch (error) {
		// The tree was clean before the release commit, so dropping it loses nothing.
		git("reset", "--hard", "HEAD~1");
		throw error;
	}
}

function main() {
	const version = process.argv[2]?.replace(/^v/, "");
	const push = process.argv.includes("--push");
	if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
		throw new Error(`Usage: node scripts/release.mjs <version> [--push] (got ${process.argv[2]})`);
	}
	checkReleasable(version, push);
	writeVersion(version);
	commitAndTag(version);
	console.log(`committed and tagged v${version}`);
	if (push) {
		git("push", "origin", "main");
		git("push", "origin", `v${version}`);
		console.log(`pushed v${version} — Publish Testnode will build the full matrix`);
	} else {
		console.log(`to release: git push origin main && git push origin v${version}`);
	}
}

// Resolved paths, so a symlinked path to the script (macOS /var → /private/var) still runs it.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
