import { createHash, randomBytes } from "node:crypto";
import { createServer, request } from "node:http";
import { pathToFileURL } from "node:url";

// Unofficial local stand-in for the Fast Feed endpoint, written from the public "Use the Fast
// Feed" guide (docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/use-fast-feed). Nitro's
// transaction feed server accepts any client; the documented endpoint requires a Bearer API key
// backed by a ticket. This relay applies the documented rules in front of Nitro's feed so a
// client written against the docs runs unchanged against the testnode:
//   HTTP 401  missing Authorization header or unknown key
//   HTTP 429  the key already holds as many connections as it has tickets
//   HTTP 426  not a WebSocket upgrade
//   close 1008 "authentication expired"  round ended (only when roundSeconds is set)
//   close 1013 "client lagged"           client fell more than 2048 messages behind
//   close 1003 "unexpected client message"  client sent a data frame
//   close 1011 "server shutting down"
// Frames are forwarded byte for byte as binary messages, one transaction per message.

export const DEFAULT_FAST_FEED_API_KEY = "litro-fast-feed-dev-key";
export const MAX_CLIENT_LAG = 2048;

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPCODE = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 };

/**
 * @typedef {{ opcode: number; payload: Buffer }} Message
 * @typedef {import("node:stream").Duplex} Duplex
 * @typedef {{ headers?: Record<string, string>; onMessage?: (payload: Buffer) => void;
 *   onClose?: (code: number, reason: string) => void }} ClientHandlers
 * @typedef {{ socket: Duplex; send: (opcode: number, payload?: Buffer) => void; close: () => void }} ClientConnection
 * @typedef {{ socket: Duplex; key: string | undefined; pending: number; closing: boolean }} RelayClient
 */

/**
 * @param {number} opcode
 * @param {Buffer} [payload]
 * @param {boolean} [mask] client-to-server frames must be masked
 */
export function encodeFrame(opcode, payload = Buffer.alloc(0), mask = false) {
	const length = payload.length;
	const headerLength = length < 126 ? 2 : length < 65536 ? 4 : 10;
	const header = Buffer.alloc(headerLength + (mask ? 4 : 0));
	header[0] = 0x80 | opcode;
	if (length < 126) {
		header[1] = length;
	} else if (length < 65536) {
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	if (!mask) {
		return Buffer.concat([header, payload]);
	}
	header[1] |= 0x80;
	const key = randomBytes(4);
	key.copy(header, headerLength);
	const masked = Buffer.alloc(length);
	for (let i = 0; i < length; i++) {
		masked[i] = /** @type {number} */ (payload[i]) ^ /** @type {number} */ (key[i % 4]);
	}
	return Buffer.concat([header, masked]);
}

/**
 * @param {number} code
 * @param {string} [reason]
 */
export function closePayload(code, reason = "") {
	const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
	payload.writeUInt16BE(code, 0);
	payload.write(reason, 2);
	return payload;
}

/** Incremental WebSocket frame decoder; handles masked and unmasked frames. */
export class FrameDecoder {
	/** @type {Buffer} */
	#buffer = Buffer.alloc(0);
	/** @type {Buffer[]} */
	#fragments = [];
	#fragmentOpcode = 0;

	/**
	 * @param {Buffer} chunk
	 * @returns {Message[]} complete messages and control frames
	 */
	push(chunk) {
		this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
		/** @type {Message[]} */
		const messages = [];
		for (;;) {
			const frame = this.#next();
			if (!frame) {
				return messages;
			}
			if (frame.opcode >= OPCODE.close) {
				messages.push(frame);
				continue;
			}
			if (frame.opcode !== OPCODE.continuation) {
				this.#fragmentOpcode = frame.opcode;
			}
			this.#fragments.push(frame.payload);
			if (frame.fin) {
				messages.push({ opcode: this.#fragmentOpcode, payload: Buffer.concat(this.#fragments) });
				this.#fragments = [];
			}
		}
	}

	#next() {
		const buffer = this.#buffer;
		const header = readFrameHeader(buffer);
		if (!header || buffer.length < header.payloadOffset + header.length) {
			return undefined;
		}
		const end = header.payloadOffset + header.length;
		const payload = Buffer.from(buffer.subarray(header.payloadOffset, end));
		if (header.maskOffset !== undefined) {
			for (let i = 0; i < payload.length; i++) {
				payload[i] =
					/** @type {number} */ (payload[i]) ^
					/** @type {number} */ (buffer[header.maskOffset + (i % 4)]);
			}
		}
		this.#buffer = buffer.subarray(end);
		const first = /** @type {number} */ (buffer[0]);
		return { fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload };
	}
}

/**
 * Payload length and offsets of the frame at the start of `buffer`, once its header is complete.
 * @param {Buffer} buffer
 * @returns {{ length: number; maskOffset: number | undefined; payloadOffset: number } | undefined}
 */
function readFrameHeader(buffer) {
	const second = buffer[1];
	if (second === undefined) {
		return undefined;
	}
	const lengthCode = second & 0x7f;
	const lengthBytes = EXTENDED_LENGTH_BYTES[lengthCode] ?? 0;
	const maskOffset = 2 + lengthBytes;
	const maskBytes = (second & 0x80) !== 0 ? 4 : 0;
	if (buffer.length < maskOffset + maskBytes) {
		return undefined;
	}
	return {
		length: lengthBytes === 0 ? lengthCode : readExtendedLength(buffer, lengthBytes),
		maskOffset: maskBytes ? maskOffset : undefined,
		payloadOffset: maskOffset + maskBytes,
	};
}

/** @type {Record<number, number>} */
const EXTENDED_LENGTH_BYTES = { 126: 2, 127: 8 };

/**
 * @param {Buffer} buffer
 * @param {number} lengthBytes
 */
function readExtendedLength(buffer, lengthBytes) {
	return lengthBytes === 2 ? buffer.readUInt16BE(2) : Number(buffer.readBigUInt64BE(2));
}

/** @param {string} key */
function acceptKey(key) {
	return createHash("sha1")
		.update(key + WS_GUID)
		.digest("base64");
}

/**
 * @param {Duplex} socket
 * @param {number} status
 * @param {string} message
 */
function rejectUpgrade(socket, status, message) {
	socket.end(
		`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
	);
}

/** @param {string | undefined} header */
function bearerKey(header) {
	const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
	return match?.[1]?.trim();
}

/**
 * Wire an upgraded client-side socket: answer pings, surface messages, report the close.
 * @param {Duplex} socket
 * @param {Buffer} head
 * @param {ClientHandlers} handlers
 * @returns {ClientConnection}
 */
function openClientSocket(socket, head, handlers) {
	const decoder = new FrameDecoder();
	let closed = false;
	/** @type {(code: number, reason: string) => void} */
	const finish = (code, reason) => {
		if (!closed) {
			closed = true;
			handlers.onClose?.(code, reason);
		}
	};
	/** @type {(opcode: number, payload?: Buffer) => void} */
	const send = (opcode, payload) => {
		if (!socket.destroyed) {
			socket.write(encodeFrame(opcode, payload, true));
		}
	};
	/** @param {Message} frame */
	const onFrame = (frame) => {
		if (frame.opcode === OPCODE.ping) {
			send(OPCODE.pong, frame.payload);
		} else if (frame.opcode === OPCODE.close) {
			const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
			send(OPCODE.close, frame.payload.subarray(0, 2));
			socket.end();
			finish(code, frame.payload.subarray(2).toString());
		} else if (frame.opcode === OPCODE.text || frame.opcode === OPCODE.binary) {
			handlers.onMessage?.(frame.payload);
		}
	};
	/** @param {Buffer} chunk */
	const onData = (chunk) => {
		for (const frame of decoder.push(chunk)) {
			onFrame(frame);
		}
	};
	socket.on("data", onData);
	socket.on("close", () => finish(1006, ""));
	socket.on("error", () => socket.destroy());
	if (head.length > 0) {
		onData(head);
	}
	return {
		socket,
		send,
		close: () => {
			send(OPCODE.close, closePayload(1000));
			socket.end();
		},
	};
}

/** @param {import("node:http").IncomingMessage} req */
function isWebSocketUpgrade(req) {
	return (
		(req.headers.upgrade ?? "").toLowerCase() === "websocket" &&
		Boolean(req.headers["sec-websocket-key"])
	);
}

/**
 * Open a WebSocket client connection (used for the Nitro upstream and by tests).
 * @param {string} url ws:// URL
 * @param {ClientHandlers} [handlers]
 * @returns {Promise<ClientConnection>}
 */
export function connectWebSocket(url, handlers = {}) {
	const target = new URL(url);
	const key = randomBytes(16).toString("base64");
	return new Promise((resolve, reject) => {
		const req = request({
			host: target.hostname,
			port: target.port || 80,
			path: `${target.pathname}${target.search}`,
			headers: {
				Connection: "Upgrade",
				Upgrade: "websocket",
				"Sec-WebSocket-Key": key,
				"Sec-WebSocket-Version": "13",
				...handlers.headers,
			},
		});
		req.on("response", (res) => {
			res.resume();
			reject(
				Object.assign(new Error(`WebSocket upgrade rejected: HTTP ${res.statusCode}`), {
					statusCode: res.statusCode,
				}),
			);
		});
		req.on("error", reject);
		req.on("upgrade", (res, socket, head) => {
			if (res.headers["sec-websocket-accept"] !== acceptKey(key)) {
				socket.destroy();
				reject(new Error("WebSocket upgrade returned a bad accept key"));
				return;
			}
			resolve(openClientSocket(socket, head, handlers));
		});
		req.end();
	});
}

/**
 * @param {{
 *   port?: number; host?: string; upstreamUrl: string;
 *   apiKeys?: string[]; auth?: boolean; ticketsPerKey?: number;
 *   delayMs?: number; roundSeconds?: number; maxLag?: number;
 *   log?: (message: string) => void;
 * }} options
 * @returns {Promise<{ port: number; stats: { forwarded: number; upstreamConnected: boolean };
 *   clientCount: () => number; close: () => Promise<void> }>}
 */
export function startFastFeedRelay(options) {
	const log = options.log ?? (() => {});
	const auth = options.auth ?? true;
	const apiKeys = new Set(options.apiKeys?.length ? options.apiKeys : [DEFAULT_FAST_FEED_API_KEY]);
	const ticketsPerKey = options.ticketsPerKey ?? 1;
	const delayMs = options.delayMs ?? 0;
	const maxLag = options.maxLag ?? MAX_CLIENT_LAG;
	/** @type {Set<RelayClient>} */
	const clients = new Set();
	const stats = { forwarded: 0, upstreamConnected: false };
	let stopped = false;
	/** @type {ClientConnection | undefined} */
	let upstream;
	/** @type {NodeJS.Timeout | undefined} */
	let reconnectTimer;
	/** @type {NodeJS.Timeout | undefined} */
	let roundTimer;

	/** @type {(client: RelayClient, code: number, reason: string) => void} */
	const closeClient = (client, code, reason) => {
		if (client.closing) {
			return;
		}
		client.closing = true;
		clients.delete(client);
		client.socket.write(encodeFrame(OPCODE.close, closePayload(code, reason)));
		client.socket.end();
		setTimeout(() => client.socket.destroy(), 1000).unref();
	};

	/** @param {Buffer} payload */
	const broadcast = (payload) => {
		stats.forwarded++;
		const frame = encodeFrame(OPCODE.binary, payload);
		for (const client of clients) {
			if (client.pending >= maxLag) {
				closeClient(client, 1013, "client lagged");
				continue;
			}
			client.pending++;
			client.socket.write(frame, () => {
				client.pending--;
			});
		}
	};

	/** @param {Buffer} payload */
	const onUpstreamMessage = (payload) => {
		if (delayMs > 0) {
			setTimeout(() => broadcast(payload), delayMs);
		} else {
			broadcast(payload);
		}
	};

	const connectUpstream = () => {
		if (stopped) {
			return;
		}
		connectWebSocket(options.upstreamUrl, {
			onMessage: onUpstreamMessage,
			onClose: () => {
				stats.upstreamConnected = false;
				upstream = undefined;
				if (!stopped) {
					log("upstream transaction feed disconnected; reconnecting");
					reconnectTimer = setTimeout(connectUpstream, 500);
				}
			},
		}).then(
			(connection) => {
				if (stopped) {
					connection.close();
					return;
				}
				upstream = connection;
				stats.upstreamConnected = true;
				log(`connected to upstream transaction feed ${options.upstreamUrl}`);
			},
			() => {
				reconnectTimer = setTimeout(connectUpstream, 500);
			},
		);
	};

	const server = createServer((_req, res) => {
		res.writeHead(426, { "Content-Type": "text/plain", Upgrade: "websocket" });
		res.end("Upgrade Required");
	});

	/**
	 * @param {import("node:http").IncomingMessage} req
	 * @returns {{ key: string | undefined } | { status: number; message: string }}
	 */
	const admit = (req) => {
		if (!isWebSocketUpgrade(req)) {
			return { status: 426, message: "Upgrade Required" };
		}
		if (!auth) {
			return { key: undefined };
		}
		const key = bearerKey(req.headers.authorization);
		if (!key || !apiKeys.has(key)) {
			return { status: 401, message: "Unauthorized" };
		}
		const open = [...clients].filter((client) => client.key === key).length;
		if (open >= ticketsPerKey) {
			return { status: 429, message: "Too Many Requests" };
		}
		return { key };
	};

	/** @type {(client: RelayClient, frame: Message) => void} */
	const onClientFrame = (client, frame) => {
		if (frame.opcode === OPCODE.ping) {
			client.socket.write(encodeFrame(OPCODE.pong, frame.payload));
		} else if (frame.opcode === OPCODE.close) {
			clients.delete(client);
			client.closing = true;
			client.socket.end(encodeFrame(OPCODE.close, frame.payload.subarray(0, 2)));
		} else if (frame.opcode !== OPCODE.pong) {
			closeClient(client, 1003, "unexpected client message");
		}
	};

	server.on("upgrade", (req, socket) => {
		socket.on("error", () => socket.destroy());
		const admission = admit(req);
		if ("status" in admission) {
			rejectUpgrade(socket, admission.status, admission.message);
			return;
		}
		const { key } = admission;
		/** @type {import("node:net").Socket} */ (socket).setNoDelay(true);
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(req.headers["sec-websocket-key"] ?? "")}\r\n\r\n`,
		);
		/** @type {RelayClient} */
		const client = { socket, key, pending: 0, closing: false };
		clients.add(client);
		const decoder = new FrameDecoder();
		socket.on("data", (/** @type {Buffer} */ chunk) => {
			for (const frame of decoder.push(chunk)) {
				onClientFrame(client, frame);
			}
		});
		socket.on("close", () => clients.delete(client));
	});

	if (options.roundSeconds && options.roundSeconds > 0) {
		roundTimer = setInterval(() => {
			for (const client of [...clients]) {
				closeClient(client, 1008, "authentication expired");
			}
		}, options.roundSeconds * 1000);
		roundTimer.unref();
	}

	connectUpstream();

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 9646, options.host ?? "0.0.0.0", () => {
			const address = server.address();
			resolve({
				port: typeof address === "object" && address ? address.port : (options.port ?? 9646),
				stats,
				clientCount: () => clients.size,
				close: () =>
					new Promise((/** @type {(value?: void) => void} */ done) => {
						stopped = true;
						clearTimeout(reconnectTimer);
						clearInterval(roundTimer);
						upstream?.close();
						for (const client of [...clients]) {
							closeClient(client, 1011, "server shutting down");
						}
						server.close(() => done());
					}),
			});
		});
	});
}

/** @param {NodeJS.ProcessEnv} env */
export function relayOptionsFromEnv(env) {
	/** @type {(name: string, fallback: number) => number} */
	const number = (name, fallback) => {
		const raw = env[name];
		if (raw === undefined || raw === "") {
			return fallback;
		}
		const value = Number(raw);
		if (!Number.isFinite(value) || value < 0) {
			throw new Error(`${name} must be a non-negative number, got ${raw}`);
		}
		return value;
	};
	const auth = (env["TESTNODE_FAST_FEED_AUTH"] ?? "bearer").toLowerCase();
	if (auth !== "bearer" && auth !== "none") {
		throw new Error(
			`TESTNODE_FAST_FEED_AUTH must be bearer or none, got ${env["TESTNODE_FAST_FEED_AUTH"]}`,
		);
	}
	const ticketsPerKey = number("TESTNODE_FAST_FEED_TICKETS_PER_KEY", 1);
	if (!Number.isInteger(ticketsPerKey) || ticketsPerKey < 1) {
		throw new Error("TESTNODE_FAST_FEED_TICKETS_PER_KEY must be a positive integer");
	}
	return {
		port: number("TESTNODE_FAST_FEED_PORT", 9646),
		upstreamUrl: env["TESTNODE_FAST_FEED_UPSTREAM_URL"] || "ws://127.0.0.1:19646",
		auth: auth === "bearer",
		apiKeys: (env["TESTNODE_FAST_FEED_API_KEYS"] ?? "")
			.split(",")
			.map((key) => key.trim())
			.filter(Boolean),
		ticketsPerKey,
		delayMs: number("TESTNODE_FAST_FEED_DELAY_MS", 0),
		roundSeconds: number("TESTNODE_FAST_FEED_ROUND_SECONDS", 0),
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const options = relayOptionsFromEnv(process.env);
	const log = (/** @type {string} */ message) => console.log(`fast-feed: ${message}`);
	const relay = await startFastFeedRelay({ ...options, log });
	// Nothing derived from the keys: a caller's key can be a real secret.
	log(
		`listening on ws://0.0.0.0:${relay.port}/ (auth ${options.auth ? "bearer" : "none"}, delay ${options.delayMs}ms)`,
	);
	const shutdown = () => relay.close().then(() => process.exit(0));
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}
