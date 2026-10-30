import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bumpReadmePins } from "../scripts/release.mjs";

const MANIFESTS = [
	"package.json",
	"apps/cli/package.json",
	"packages/action/package.json",
	"packages/core/package.json",
	"packages/testnode/package.json",
];

describe("bumpReadmePins", () => {
	it("moves action pins and their version inputs, and leaves pinned lines alone", () => {
		const readme = [
			"- uses: OffchainLabs/arbitrum-litro@v0.2.10",
			"  with:",
			"    version: v0.2.10",
			"- uses: OffchainLabs/arbitrum-litro/bake@v0.2.6",
			"- uses: OffchainLabs/arbitrum-litro@v0.2.10  # pinned: old",
			"    version: v0.2.9  # pinned",
			"version: v0.2.3",
		].join("\n");
		expect(bumpReadmePins(readme, "1.2.3").split("\n")).toEqual([
			"- uses: OffchainLabs/arbitrum-litro@v1.2.3",
			"  with:",
			"    version: v1.2.3",
			"- uses: OffchainLabs/arbitrum-litro/bake@v1.2.3",
			"- uses: OffchainLabs/arbitrum-litro@v0.2.10  # pinned: old",
			"    version: v0.2.9  # pinned",
			"version: v0.2.3",
		]);
	});

	it("leaves the committed README already at the package version", () => {
		const readme = readFileSync("README.md", "utf-8");
		const { version } = JSON.parse(readFileSync("package.json", "utf-8"));
		expect(bumpReadmePins(readme, version)).toBe(readme);
	});
});

describe("release.mjs", () => {
	it("commits and tags under a signing git config, as every release has been tagged", () => {
		const repo = mkdtempSync(join(tmpdir(), "litro-release-"));
		for (const file of [...MANIFESTS, "README.md", "scripts/release.mjs"]) {
			mkdirSync(dirname(join(repo, file)), { recursive: true });
			cpSync(file, join(repo, file));
		}
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: repo, encoding: "utf-8" }).trim();
		git("init", "-q", "-b", "main");
		git("config", "user.email", "release@test");
		git("config", "user.name", "release test");
		git("config", "commit.gpgSign", "false");
		git("config", "tag.gpgSign", "true");
		git("add", ".");
		git("commit", "-q", "-m", "init");

		execFileSync("node", [resolve(repo, "scripts/release.mjs"), "9.9.9"], { cwd: repo });

		expect(git("cat-file", "-t", "v9.9.9")).toBe("commit");
		expect(git("log", "-1", "--format=%s")).toBe("chore(release): v9.9.9");
		expect(git("status", "--porcelain")).toBe("");
		expect(readFileSync(join(repo, "README.md"), "utf-8")).toContain("arbitrum-litro@v9.9.9");
	});
});
