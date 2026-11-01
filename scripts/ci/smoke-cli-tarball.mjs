import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Installs the packed CLI the way a user does, in a directory outside any
 * checkout, and proves the installed `litro` runs.
 *
 * The bundle must carry everything itself: a missing inlined library, a bin
 * that never reaches serve() through npm's symlink, or a lookup that needs the
 * repo would each pass every in-repo test.
 *
 *   node scripts/ci/smoke-cli-tarball.mjs apps/cli/arbitrum-litro-0.4.0.tgz
 */

const tarball = process.argv[2] ? resolve(process.argv[2]) : "";
if (!tarball || !existsSync(tarball)) {
	throw new Error("usage: smoke-cli-tarball.mjs <path to arbitrum-litro-*.tgz>");
}

const dir = mkdtempSync(join(tmpdir(), "litro-smoke-"));
writeFileSync(join(dir, "package.json"), '{ "private": true }\n');
execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], {
	cwd: dir,
	stdio: "inherit",
});

const pkg = JSON.parse(
	readFileSync(join(dir, "node_modules/@arbitrum/litro/package.json"), "utf8"),
);
const bin = join(dir, "node_modules/.bin/litro");

/** @param {string[]} args */
function litro(args) {
	const result = spawnSync(bin, args, { cwd: dir, encoding: "utf8" });
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/**
 * @param {boolean} ok
 * @param {string} what
 * @param {string} [detail]
 */
function check(ok, what, detail = "") {
	console.log(`${ok ? "ok" : "FAIL"} - ${what}`);
	if (!ok) {
		throw new Error(`${what}\n${detail}`);
	}
}

const version = litro(["--version"]);
check(version.output.trim() === pkg.version, `litro --version is ${pkg.version}`, version.output);

const help = litro(["start", "--help"]);
check(
	help.status === 0 && help.output.includes("--fast-feed-enabled"),
	"litro start --help",
	help.output,
);

const status = litro(["status", "--format", "json"]);
check(
	status.status === 0 && Array.isArray(JSON.parse(status.output).containers),
	"litro status runs outside a checkout",
	status.output,
);

const init = litro(["init"]);
check(
	init.status !== 0 && init.output.includes("arbitrum-litro checkout"),
	"litro init asks for a checkout",
	init.output,
);

// What `litro mcp add` registers: an MCP server on stdio exposing each command.
const mcp = spawnSync(bin, ["--mcp"], {
	cwd: dir,
	encoding: "utf8",
	timeout: 15_000,
	input: `${[
		{
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "smoke", version: "0" },
			},
		},
		{ jsonrpc: "2.0", method: "notifications/initialized" },
		{ jsonrpc: "2.0", id: 2, method: "tools/list" },
	]
		.map((message) => JSON.stringify(message))
		.join("\n")}\n`,
});
const tools = mcp.stdout
	.split("\n")
	.filter((line) => line.startsWith("{"))
	.map((line) => JSON.parse(line))
	.find((message) => message.id === 2)?.result?.tools;
check(
	Array.isArray(tools) && tools.some((tool) => tool.name === "start"),
	"litro --mcp lists the commands as tools",
	`${mcp.stdout}${mcp.stderr}`,
);

check(
	existsSync(join(dir, "node_modules/@arbitrum/litro/bundle/testnode-rebase.Dockerfile")),
	"the bundle ships the rebase Dockerfile",
);
