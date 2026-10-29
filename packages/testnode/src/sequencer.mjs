// @ts-check

// Optional L2 sequencer features the published image supports: the Fast Feed, PGA rounds and the
// block speed. The image owns their behavior (docker/sequencer-features.sh); this module turns
// caller options into the container settings that switch them on.

import { endpointUrl } from "./endpoints.mjs";
import { toBoolean, toGoDuration, toNumber } from "./inputs.mjs";

/**
 * @typedef {import("./types.js").SequencerOptions} SequencerOptions
 * @typedef {import("./types.js").SequencerState} SequencerState
 */

/** The relay's own default (docker/fast-feed-relay.mjs); a test keeps the two equal. */
export const DEFAULT_FAST_FEED_API_KEY = "litro-fast-feed-dev-key";
export const FAST_FEED_HOST_PORT = 9646;
export const SEQUENCER_FEED_HOST_PORT = 9642;

/**
 * @param {SequencerOptions} [options]
 * @returns {SequencerState}
 */
export function resolveSequencerOptions(options = {}) {
	return {
		fastFeed: toBoolean(options.fastFeedEnabled) ? resolveFastFeed(options) : undefined,
		l2MaxBlockSpeed: toGoDuration(options.l2MaxBlockSpeed, "l2-max-block-speed"),
		pgaRoundsPerBlock: toNumber(options.pgaRoundsPerBlock, "pga-rounds-per-block", {
			integer: true,
			min: 1,
		}),
	};
}

/** @param {SequencerOptions} options */
function resolveFastFeed(options) {
	const apiKey = options.fastFeedApiKey || DEFAULT_FAST_FEED_API_KEY;
	if (/[\s,]/.test(apiKey)) {
		throw new Error("fast-feed-api-key must not contain whitespace or commas");
	}
	return {
		apiKey,
		auth: toBoolean(options.fastFeedAuth, true),
		delayMs: toNumber(options.fastFeedDelayMs, "fast-feed-delay-ms", { min: 0 }) ?? 0,
		url: endpointUrl(9646, FAST_FEED_HOST_PORT),
		sequencerFeedUrl: endpointUrl(9642, SEQUENCER_FEED_HOST_PORT),
	};
}

/**
 * Whether a feature finishes setting up after the RPCs answer (the Fast Feed relay, PGA's ArbOS
 * upgrade). The image starts its config server, and so turns healthy, only once they are ready.
 *
 * @param {SequencerState} state
 */
export function needsHealthyContainer(state) {
	return state.fastFeed !== undefined || state.pgaRoundsPerBlock !== undefined;
}

/**
 * The `docker run` settings that switch the features on, as image environment variables.
 *
 * @param {SequencerState} state
 * @returns {Record<string, string>}
 */
export function sequencerEnvironment(state) {
	/** @type {Record<string, string>} */
	const env = {};
	if (state.fastFeed) {
		env["TESTNODE_FAST_FEED"] = "true";
		env["TESTNODE_FAST_FEED_API_KEYS"] = state.fastFeed.apiKey;
		if (!state.fastFeed.auth) {
			env["TESTNODE_FAST_FEED_AUTH"] = "none";
		}
		if (state.fastFeed.delayMs > 0) {
			env["TESTNODE_FAST_FEED_DELAY_MS"] = String(state.fastFeed.delayMs);
		}
	}
	if (state.pgaRoundsPerBlock !== undefined) {
		env["TESTNODE_PGA_ROUNDS_PER_BLOCK"] = String(state.pgaRoundsPerBlock);
	}
	if (state.l2MaxBlockSpeed !== undefined) {
		env["TESTNODE_L2_MAX_BLOCK_SPEED"] = state.l2MaxBlockSpeed;
	}
	return env;
}

/**
 * `docker run` arguments for the features: their environment, and the two feed ports.
 *
 * @param {SequencerState} state
 * @returns {string[]}
 */
export function sequencerDockerArgs(state) {
	const ports = state.fastFeed
		? [`127.0.0.1:${FAST_FEED_HOST_PORT}:9646`, `127.0.0.1:${SEQUENCER_FEED_HOST_PORT}:9642`]
		: [];
	return [
		...ports.flatMap((port) => ["-p", port]),
		...Object.entries(sequencerEnvironment(state)).flatMap(([key, value]) => [
			"-e",
			`${key}=${value}`,
		]),
	];
}
