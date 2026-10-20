import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const HELPER = resolve("docker/sequencer-features.sh");
const NITRO_V312_FLAGS = [
	"--execution.transaction-feed.enable",
	"--execution.sequencer.pga.rounds-per-block",
].join("\n");

/** Source the helper with `env` and run sequencer_feature_args, as the entrypoint does. */
function featureArgs(env: Record<string, string>, nitroHelp = NITRO_V312_FLAGS) {
	const bin = mkdtempSync(join(tmpdir(), "sequencer-features-"));
	writeFileSync(join(bin, "fast-feed-relay.mjs"), "");
	try {
		const out = execFileSync(
			"sh",
			[
				"-c",
				`. "${HELPER}"; sequencer_feature_args > /dev/null; printf '%s\\n%s' "$SEQUENCER_HTTP_API" "$(echo $SEQUENCER_FEATURE_ARGS)"`,
			],
			{
				encoding: "utf-8",
				env: {
					PATH: process.env["PATH"],
					CONFIG_ROOT: bin,
					NITRO_HELP: nitroHelp,
					SEQUENCER_HTTP_API: "net,web3,eth",
					TESTNODE_BIN: bin,
					...env,
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const [api, args] = out.split("\n");
		return { ok: true as const, api, args: args?.split(" ").filter(Boolean) ?? [] };
	} catch (error) {
		return { ok: false as const, stderr: String((error as { stderr?: string }).stderr) };
	}
}

describe("sequencer_feature_args", () => {
	it("adds nothing when no feature is on", () => {
		expect(featureArgs({})).toEqual({ ok: true, api: "net,web3,eth", args: [] });
	});

	it("serves Nitro's transaction feed on loopback behind the relay", () => {
		expect(featureArgs({ TESTNODE_FAST_FEED: "true" }).args).toEqual([
			"--execution.transaction-feed.enable",
			"--execution.transaction-feed.addr=127.0.0.1",
			"--execution.transaction-feed.port=19646",
		]);
	});

	it("sets PGA rounds", () => {
		expect(featureArgs({ TESTNODE_PGA_ROUNDS_PER_BLOCK: "2" }).args).toEqual([
			"--execution.sequencer.pga.rounds-per-block=2",
		]);
	});

	it("keeps Timeboost's flags and HTTP APIs", () => {
		const result = featureArgs({
			TESTNODE_TIMEBOOST: "true",
			TESTNODE_TIMEBOOST_AUCTION_CONTRACT_ADDRESS: "0xabc",
			TESTNODE_TIMEBOOST_REDIS_URL: "redis://r:6379",
		});
		expect(result.api).toBe("net,web3,eth,timeboost,auctioneer");
		expect(result.args).toEqual([
			"--execution.sequencer.timeboost.enable",
			"--execution.sequencer.timeboost.redis-url=redis://r:6379",
			"--execution.sequencer.timeboost.auction-contract-address=0xabc",
			"--execution.sequencer.timeboost.auctioneer-address=0x46225F4cee2b4A1d506C7f894bb3dAeB21BF1596",
		]);
	});

	it("still requires Timeboost's Redis URL", () => {
		const result = featureArgs({
			TESTNODE_TIMEBOOST: "true",
			TESTNODE_TIMEBOOST_AUCTION_CONTRACT_ADDRESS: "0xabc",
		});
		expect(result.ok).toBe(false);
	});

	it("refuses the Fast Feed and PGA on a Nitro without the flags", () => {
		const fastFeed = featureArgs({ TESTNODE_FAST_FEED: "true" }, "");
		expect(fastFeed).toMatchObject({ ok: false });
		expect(fastFeed.ok === false && fastFeed.stderr).toContain("needs Nitro >= v3.12");
		expect(featureArgs({ TESTNODE_PGA_ROUNDS_PER_BLOCK: "2" }, "")).toMatchObject({ ok: false });
	});
});
