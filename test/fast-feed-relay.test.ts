import { createHash } from "node:crypto";
import { type Server, createServer, request } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_FAST_FEED_API_KEY,
	FrameDecoder,
	closePayload,
	connectWebSocket,
	encodeFrame,
	relayOptionsFromEnv,
	startFastFeedRelay,
} from "../docker/fast-feed-relay.mjs";
import { DEFAULT_FAST_FEED_API_KEY as PACKAGE_DEFAULT_FAST_FEED_API_KEY } from "../packages/testnode/src/sequencer.mjs";

type Relay = Awaited<ReturnType<typeof startFastFeedRelay>>;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()?.();
	}
});

/** A stand-in for Nitro's transaction feed server: accepts any upgrade and pushes binary frames. */
async function startUpstream() {
	const sockets = new Set<Socket>();
	const server: Server = createServer();
	server.on("upgrade", (req, socket: Socket) => {
		const accept = createHash("sha1")
			.update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => socket.destroy());
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	cleanups.push(
		() =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) {
					socket.destroy();
				}
				server.close(() => resolve());
			}),
	);
	return {
		url: `ws://127.0.0.1:${port}`,
		connected: () => sockets.size,
		dropAll() {
			for (const socket of sockets) {
				socket.destroy();
			}
		},
		push(message: string) {
			for (const socket of sockets) {
				socket.write(encodeFrame(2, Buffer.from(message)));
			}
		},
	};
}

async function waitFor(condition: () => boolean, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function startRelay(options: Partial<Parameters<typeof startFastFeedRelay>[0]> = {}) {
	const upstream = await startUpstream();
	const relay: Relay = await startFastFeedRelay({
		host: "127.0.0.1",
		port: 0,
		upstreamUrl: upstream.url,
		...options,
	});
	cleanups.push(() => relay.close());
	await waitFor(() => upstream.connected() === 1);
	return { relay, upstream, url: `ws://127.0.0.1:${relay.port}/` };
}

function subscribe(url: string, key: string | undefined = DEFAULT_FAST_FEED_API_KEY) {
	const messages: string[] = [];
	const closes: Array<{ code: number; reason: string }> = [];
	return connectWebSocket(url, {
		headers: key ? { Authorization: `Bearer ${key}` } : {},
		onMessage: (payload) => messages.push(payload.toString()),
		onClose: (code, reason) => closes.push({ code, reason }),
	}).then((connection) => {
		cleanups.push(() => {
			connection.socket.destroy();
		});
		return { ...connection, messages, closes };
	});
}

async function upgradeStatus(url: string, headers: Record<string, string>) {
	try {
		await connectWebSocket(url, { headers });
		return 101;
	} catch (error) {
		return (error as { statusCode?: number }).statusCode;
	}
}

describe("fast feed relay", () => {
	it("forwards upstream frames to an authenticated client unchanged", async () => {
		const { upstream, url } = await startRelay();
		const client = await subscribe(url);
		const frame = JSON.stringify({ version: 1, timestamp_ms: 1, transaction: { tx_index: 0 } });
		upstream.push(frame);
		await waitFor(() => client.messages.length === 1);
		expect(client.messages).toEqual([frame]);
	});

	it("rejects missing and unknown keys with 401", async () => {
		const { url } = await startRelay();
		expect(await upgradeStatus(url, {})).toBe(401);
		expect(await upgradeStatus(url, { Authorization: "Bearer wrong" })).toBe(401);
		expect(await upgradeStatus(url, { Authorization: DEFAULT_FAST_FEED_API_KEY })).toBe(401);
	});

	it("accepts any client when auth is off", async () => {
		const { url } = await startRelay({ auth: false });
		expect(await upgradeStatus(url, {})).toBe(101);
	});

	it("limits connections per key to its tickets with 429", async () => {
		const { url } = await startRelay({ apiKeys: ["k1"], ticketsPerKey: 1 });
		await subscribe(url, "k1");
		expect(await upgradeStatus(url, { Authorization: "Bearer k1" })).toBe(429);
	});

	it("answers a plain HTTP request with 426", async () => {
		const { relay } = await startRelay();
		const status = await new Promise<number | undefined>((resolve, reject) => {
			request({ host: "127.0.0.1", port: relay.port, path: "/" }, (res) => {
				res.resume();
				resolve(res.statusCode);
			})
				.on("error", reject)
				.end();
		});
		expect(status).toBe(426);
	});

	it("closes a client that sends a data frame with 1003", async () => {
		const { url } = await startRelay();
		const client = await subscribe(url);
		client.send(1, Buffer.from("hello"));
		await waitFor(() => client.closes.length === 1);
		expect(client.closes[0]).toEqual({ code: 1003, reason: "unexpected client message" });
	});

	it("closes a client that falls too far behind with 1013", async () => {
		const { relay, upstream, url } = await startRelay({ maxLag: 4 });
		const client = await subscribe(url);
		client.socket.pause();
		const big = "x".repeat(256 * 1024);
		for (let i = 0; i < 64 && relay.clientCount() > 0; i++) {
			upstream.push(big);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(relay.clientCount()).toBe(0);
		client.socket.resume();
		await waitFor(() => client.closes.length === 1, 10_000);
		expect(client.closes[0]?.code).toBe(1013);
	});

	it("expires connections at the end of a round with 1008", async () => {
		const { url } = await startRelay({ roundSeconds: 0.2 });
		const client = await subscribe(url);
		await waitFor(() => client.closes.length === 1);
		expect(client.closes[0]).toEqual({ code: 1008, reason: "authentication expired" });
	});

	it("closes clients with 1011 on shutdown", async () => {
		const { relay, url } = await startRelay();
		const client = await subscribe(url);
		await relay.close();
		await waitFor(() => client.closes.length === 1);
		expect(client.closes[0]).toEqual({ code: 1011, reason: "server shutting down" });
	});

	it("delays each frame by delayMs", async () => {
		const { upstream, url } = await startRelay({ delayMs: 150 });
		const client = await subscribe(url);
		const sentAt = Date.now();
		upstream.push("delayed");
		await waitFor(() => client.messages.length === 1);
		expect(Date.now() - sentAt).toBeGreaterThanOrEqual(140);
	});

	it("reconnects to the upstream feed after it drops, keeping clients subscribed", async () => {
		const { relay, upstream, url } = await startRelay();
		const client = await subscribe(url);
		upstream.dropAll();
		await waitFor(() => !relay.stats.upstreamConnected);
		await waitFor(() => upstream.connected() === 1);
		upstream.push("after reconnect");
		await waitFor(() => client.messages.length === 1);
		expect(client.messages).toEqual(["after reconnect"]);
		expect(client.closes).toEqual([]);
	});
});

describe("websocket framing", () => {
	it("round-trips masked and unmasked frames of every length class", () => {
		for (const length of [0, 125, 126, 65535, 65536]) {
			for (const mask of [false, true]) {
				const payload = Buffer.alloc(length, 7);
				const decoder = new FrameDecoder();
				const encoded = encodeFrame(2, payload, mask);
				const frames = [
					...decoder.push(encoded.subarray(0, 3)),
					...decoder.push(encoded.subarray(3)),
				];
				expect(frames).toHaveLength(1);
				expect(frames[0]?.opcode).toBe(2);
				expect(frames[0]?.payload.equals(payload)).toBe(true);
			}
		}
	});

	it("encodes close codes", () => {
		const payload = closePayload(1013, "client lagged");
		expect(payload.readUInt16BE(0)).toBe(1013);
		expect(payload.subarray(2).toString()).toBe("client lagged");
	});
});

describe("relay defaults", () => {
	it("uses the same dev key the CLI and action report", () => {
		expect(DEFAULT_FAST_FEED_API_KEY).toBe(PACKAGE_DEFAULT_FAST_FEED_API_KEY);
	});
});

describe("relayOptionsFromEnv", () => {
	it("defaults to bearer auth with the dev key on 9646", () => {
		expect(relayOptionsFromEnv({})).toEqual({
			port: 9646,
			upstreamUrl: "ws://127.0.0.1:19646",
			auth: true,
			apiKeys: [],
			ticketsPerKey: 1,
			delayMs: 0,
			roundSeconds: 0,
		});
	});

	it("parses keys, delay, and auth mode", () => {
		const options = relayOptionsFromEnv({
			TESTNODE_FAST_FEED_API_KEYS: "a, b",
			TESTNODE_FAST_FEED_AUTH: "none",
			TESTNODE_FAST_FEED_DELAY_MS: "12",
		});
		expect(options.apiKeys).toEqual(["a", "b"]);
		expect(options.auth).toBe(false);
		expect(options.delayMs).toBe(12);
	});

	it("rejects invalid values", () => {
		expect(() => relayOptionsFromEnv({ TESTNODE_FAST_FEED_AUTH: "basic" })).toThrow();
		expect(() => relayOptionsFromEnv({ TESTNODE_FAST_FEED_DELAY_MS: "-1" })).toThrow();
		expect(() => relayOptionsFromEnv({ TESTNODE_FAST_FEED_TICKETS_PER_KEY: "0" })).toThrow();
	});
});
