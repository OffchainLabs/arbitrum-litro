import {
	DEFAULT_FAST_FEED_API_KEY,
	FAST_FEED_HOST_PORT,
	type FastFeedMessage,
	decodeFastFeedMessage,
	endpointUrl,
	openFastFeed,
} from "@arbitrum/testnode";
import { Cli, z } from "incur";

type FeedResult = { success: true; url: string; frames: FastFeedMessage[]; timedOut: boolean };

/** Collect up to `count` frames; rejects when the feed refuses or drops the connection. */
export function readFastFeed(options: {
	apiKey: string;
	count: number;
	timeoutMs: number;
	url: string;
}): Promise<FeedResult> {
	return new Promise((resolve, reject) => {
		const socket = openFastFeed(options.url, options.apiKey);
		const frames: FastFeedMessage[] = [];
		let settled = false;
		const finish = (outcome: FeedResult | Error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			socket.close();
			outcome instanceof Error ? reject(outcome) : resolve(outcome);
		};
		const timer = setTimeout(
			() => finish({ success: true, url: options.url, frames, timedOut: true }),
			options.timeoutMs,
		);
		socket.onmessage = (event) => {
			frames.push(decodeFastFeedMessage(event.data));
			if (frames.length >= options.count) {
				finish({ success: true, url: options.url, frames, timedOut: false });
			}
		};
		socket.onerror = () =>
			finish(
				new Error(
					`Could not subscribe to ${options.url}: check the testnode was started with fastFeedEnabled and the API key matches (401 = wrong or missing key, 429 = key already connected)`,
				),
			);
		socket.onclose = (event) => {
			if (event.code !== 1000) {
				finish(new Error(`Fast Feed closed the connection: ${event.code} ${event.reason}`));
			}
		};
	});
}

export const feedCli = Cli.create("feed", {
	description: "Read transactions from the testnode's Fast Feed, the way a production client does",
	options: z.object({
		url: z
			.string()
			.optional()
			.describe(`Fast Feed URL (default: ws://127.0.0.1:${FAST_FEED_HOST_PORT}/)`),
		apiKey: z
			.string()
			.optional()
			.describe(
				`API key sent as "Authorization: Bearer <key>" (default: ${DEFAULT_FAST_FEED_API_KEY})`,
			),
		count: z.number().optional().describe("Stop after this many transactions (default: 5)"),
		timeoutSeconds: z
			.number()
			.optional()
			.describe("Stop after this long even if fewer transactions arrived (default: 30)"),
	}),
	run(c) {
		const count = c.options.count ?? 5;
		const timeoutSeconds = c.options.timeoutSeconds ?? 30;
		if (!Number.isInteger(count) || count <= 0) {
			throw new Error("count must be a positive integer");
		}
		if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
			throw new Error("timeout-seconds must be a positive number");
		}
		return readFastFeed({
			apiKey: c.options.apiKey ?? DEFAULT_FAST_FEED_API_KEY,
			count,
			timeoutMs: timeoutSeconds * 1000,
			url: c.options.url ?? endpointUrl(9646, FAST_FEED_HOST_PORT),
		});
	},
});
