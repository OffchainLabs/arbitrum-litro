import { describe, expect, it } from "vitest";
import {
	DEFAULT_FAST_FEED_API_KEY,
	needsHealthyContainer,
	resolveSequencerOptions,
	sequencerDockerArgs,
	sequencerEnvironment,
} from "../src/sequencer.mjs";

describe("resolveSequencerOptions", () => {
	it("turns every feature off when nothing is set", () => {
		expect(resolveSequencerOptions()).toEqual({
			fastFeed: undefined,
			l2MaxBlockSpeed: undefined,
			pgaRoundsPerBlock: undefined,
		});
	});

	it("enables the Fast Feed with the dev key and auth on", () => {
		expect(resolveSequencerOptions({ fastFeedEnabled: true }).fastFeed).toEqual({
			apiKey: DEFAULT_FAST_FEED_API_KEY,
			auth: true,
			delayMs: 0,
			url: "ws://127.0.0.1:9646/",
			sequencerFeedUrl: "ws://127.0.0.1:9642/feed",
		});
	});

	it("reads action-style string inputs, where empty means unset", () => {
		const state = resolveSequencerOptions({
			fastFeedApiKey: "",
			fastFeedAuth: "",
			fastFeedDelayMs: "12",
			fastFeedEnabled: "true",
			l2MaxBlockSpeed: "250ms",
			pgaRoundsPerBlock: "2",
		});
		expect(state.fastFeed).toMatchObject({
			apiKey: DEFAULT_FAST_FEED_API_KEY,
			auth: true,
			delayMs: 12,
		});
		expect(state.pgaRoundsPerBlock).toBe(2);
		expect(state.l2MaxBlockSpeed).toBe("250ms");
	});

	it("turns auth off only when asked to", () => {
		expect(
			resolveSequencerOptions({ fastFeedEnabled: true, fastFeedAuth: false }).fastFeed?.auth,
		).toBe(false);
		expect(
			resolveSequencerOptions({ fastFeedEnabled: true, fastFeedAuth: "false" }).fastFeed?.auth,
		).toBe(false);
	});

	it("rejects invalid settings", () => {
		expect(() => resolveSequencerOptions({ fastFeedEnabled: true, fastFeedApiKey: "a,b" })).toThrow(
			"fast-feed-api-key",
		);
		expect(() => resolveSequencerOptions({ fastFeedEnabled: true, fastFeedDelayMs: -1 })).toThrow(
			"fast-feed-delay-ms",
		);
		expect(() => resolveSequencerOptions({ pgaRoundsPerBlock: 0 })).toThrow("pga-rounds-per-block");
		expect(() => resolveSequencerOptions({ pgaRoundsPerBlock: 1.5 })).toThrow(
			"pga-rounds-per-block",
		);
		expect(() => resolveSequencerOptions({ l2MaxBlockSpeed: "250" })).toThrow("l2-max-block-speed");
	});
});

describe("sequencer container settings", () => {
	it("publishes both feeds and sets the image's variables", () => {
		const state = resolveSequencerOptions({
			fastFeedApiKey: "my-key",
			fastFeedDelayMs: 12,
			fastFeedEnabled: true,
			l2MaxBlockSpeed: "250ms",
			pgaRoundsPerBlock: 2,
		});
		expect(sequencerEnvironment(state)).toEqual({
			TESTNODE_FAST_FEED: "true",
			TESTNODE_FAST_FEED_API_KEYS: "my-key",
			TESTNODE_FAST_FEED_DELAY_MS: "12",
			TESTNODE_L2_MAX_BLOCK_SPEED: "250ms",
			TESTNODE_PGA_ROUNDS_PER_BLOCK: "2",
		});
		expect(sequencerDockerArgs(state).slice(0, 4)).toEqual([
			"-p",
			"127.0.0.1:9646:9646",
			"-p",
			"127.0.0.1:9642:9642",
		]);
	});

	it("tells the relay to skip auth when auth is off", () => {
		const env = sequencerEnvironment(
			resolveSequencerOptions({ fastFeedEnabled: true, fastFeedAuth: false }),
		);
		expect(env["TESTNODE_FAST_FEED_AUTH"]).toBe("none");
	});

	it("adds nothing when every feature is off", () => {
		expect(sequencerDockerArgs(resolveSequencerOptions())).toEqual([]);
	});

	it("waits for a healthy container only for features that finish after the RPC is up", () => {
		expect(needsHealthyContainer(resolveSequencerOptions())).toBe(false);
		expect(needsHealthyContainer(resolveSequencerOptions({ l2MaxBlockSpeed: "250ms" }))).toBe(
			false,
		);
		expect(needsHealthyContainer(resolveSequencerOptions({ fastFeedEnabled: true }))).toBe(true);
		expect(needsHealthyContainer(resolveSequencerOptions({ pgaRoundsPerBlock: 2 }))).toBe(true);
	});
});
