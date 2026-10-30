import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Builds the release tarball of the CLI into <dir> and smoke-tests it installed outside the
 * checkout. CI and the release job both run this, so the tarball they ship is the one tested.
 *
 *   pnpm pack:cli "$RUNNER_TEMP/cli"
 */

const dir = resolve(process.argv[2] || "");
if (!process.argv[2]) {
	throw new Error("usage: pack-cli.mjs <output dir>");
}
mkdirSync(dir, { recursive: true });

/** @param {string[]} args */
const pnpm = (args) => execFileSync("pnpm", args, { stdio: "inherit" });
// The bundle inlines the libraries' built dist/, which their package exports name.
pnpm(["build"]);
pnpm(["--filter", "@arbitrum/litro", "bundle"]);
pnpm(["--filter", "@arbitrum/litro", "pack", "--pack-destination", dir]);

const tarball = readdirSync(dir).find((name) => /^arbitrum-litro-.+\.tgz$/.test(name));
if (!tarball) {
	throw new Error(`no arbitrum-litro-*.tgz in ${dir}`);
}
execFileSync("node", [join(import.meta.dirname, "smoke-cli-tarball.mjs"), join(dir, tarball)], {
	stdio: "inherit",
});
console.log(join(dir, tarball));
