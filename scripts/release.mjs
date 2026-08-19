// Move every package.json version and the git tag together, because they must
// agree: apps/cli/package.json feeds DEFAULT_START_IMAGE_VERSION, while the tag
// is what `Publish Testnode` stamps on the images. A tag ahead of the file
// publishes images the CLI never defaults to (that drift is why this exists --
// package.json sat at 0.2.6 through the v0.2.7..v0.2.9 releases).
//
//   node scripts/release.mjs 0.2.11          # bump + commit + tag
//   node scripts/release.mjs 0.2.11 --push   # ...and push, triggering publish
//
// The tag push is what starts the release, so it stays opt-in.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const MANIFESTS = [
	"package.json",
	"apps/cli/package.json",
	"packages/action/package.json",
	"packages/core/package.json",
	"packages/testnode/package.json",
];

const version = process.argv[2]?.replace(/^v/, "");
const push = process.argv.includes("--push");

if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
	throw new Error(`Usage: node scripts/release.mjs <version> [--push] (got ${process.argv[2]})`);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf-8" }).trim();

if (git("status", "--porcelain")) {
	throw new Error("working tree is dirty; commit or stash before releasing");
}
if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") {
	throw new Error("releases are cut from main");
}
if (git("tag", "--list", `v${version}`)) {
	throw new Error(`tag v${version} already exists`);
}

for (const manifest of MANIFESTS) {
	const raw = readFileSync(manifest, "utf-8");
	const updated = raw.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
	if (updated === raw) {
		throw new Error(`no version field updated in ${manifest}`);
	}
	writeFileSync(manifest, updated);
}

git("add", ...MANIFESTS);
git("commit", "-m", `chore(release): v${version}`);
git("tag", `v${version}`);
console.log(`committed and tagged v${version}`);

if (push) {
	git("push", "origin", "main");
	git("push", "origin", `v${version}`);
	console.log(`pushed v${version} — Publish Testnode will build the full matrix`);
} else {
	console.log(`to release: git push origin main && git push origin v${version}`);
}
