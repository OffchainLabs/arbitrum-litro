import { request } from "node:http";
import {
	DEFAULT_FAST_FEED_API_KEY,
	type FastFeedMessage,
	decodeFastFeedMessage,
	openFastFeed,
} from "@arbitrum/testnode";
import { type Hex, keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { accounts } from "../../src/accounts.js";

// Runs against a testnode booted with the Fast Feed on, e.g.
//   pnpm dev start --fast-feed-enabled --pga-rounds-per-block 2 --l2-max-block-speed 250ms
//   FAST_FEED_EXPECT_PGA=true pnpm vitest run -c vitest.integration.config.ts fast-feed
// It talks to the feed the way the public "Use the Fast Feed" guide's client does.

const FEED_URL = process.env["FAST_FEED_URL"] || "ws://127.0.0.1:9646/";
const SEQUENCER_FEED_URL = process.env["SEQUENCER_FEED_URL"] || "ws://127.0.0.1:9642/feed";
const L2_RPC_URL = process.env["L2_RPC_URL"] || "http://127.0.0.1:8547";
const API_KEY = process.env["FAST_FEED_API_KEY"] || DEFAULT_FAST_FEED_API_KEY;
const EXPECT_PGA = process.env["FAST_FEED_EXPECT_PGA"] === "true";

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
	const response = await fetch(L2_RPC_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const body = (await response.json()) as { result?: T; error?: { message: string } };
	if (body.error) {
		throw new Error(`${method}: ${body.error.message}`);
	}
	return body.result as T;
}

/** Subscribe (with a Bearer key when given) and collect frames by transaction hash. */
async function subscribe(url: string, apiKey?: string) {
	const frames = new Map<string, FastFeedMessage>();
	const kinds = new Set<string>();
	const socket = openFastFeed(url, apiKey);
	socket.onmessage = (event) => {
		kinds.add(typeof event.data === "string" ? "text" : "binary");
		const frame = decodeFastFeedMessage(event.data);
		if (frame.transaction) {
			frames.set(frame.transaction.tx_hash.toLowerCase(), frame);
		}
	};
	await new Promise<void>((resolve, reject) => {
		socket.onopen = () => resolve();
		socket.onerror = () => reject(new Error(`could not subscribe to ${url}`));
	});
	return { socket, frames, kinds };
}

/** HTTP status of a WebSocket upgrade attempt (101 when it succeeds). */
function upgradeStatus(url: string, headers: Record<string, string>): Promise<number | undefined> {
	const target = new URL(url);
	return new Promise((resolve, reject) => {
		const req = request({
			host: target.hostname,
			port: target.port,
			path: target.pathname,
			headers: {
				...headers,
				Connection: "Upgrade",
				Upgrade: "websocket",
				"Sec-WebSocket-Version": "13",
				"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
			},
		});
		req.on("upgrade", (_res, socket) => {
			socket.destroy();
			resolve(101);
		});
		req.on("response", (res) => {
			res.resume();
			resolve(res.statusCode);
		});
		req.on("error", reject);
		req.end();
	});
}

async function waitFor(condition: () => boolean, timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	while (!condition() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function signTransfer(options: {
	privateKey: Hex;
	nonce: number;
	maxPriorityFeePerGas: bigint;
	maxFeePerGas: bigint;
}) {
	const account = privateKeyToAccount(options.privateKey);
	const chainId = Number(await rpc<string>("eth_chainId", []));
	const raw = await account.signTransaction({
		chainId,
		type: "eip1559",
		to: account.address,
		value: 1n,
		nonce: options.nonce,
		gas: 100_000n,
		maxFeePerGas: options.maxFeePerGas,
		maxPriorityFeePerGas: options.maxPriorityFeePerGas,
	});
	return { raw, hash: keccak256(raw).toLowerCase() };
}

async function nextNonce(address: string) {
	return Number(await rpc<string>("eth_getTransactionCount", [address, "pending"]));
}

const descending = (a: bigint, b: bigint) => (a < b ? 1 : a > b ? -1 : 0);

/** Fund each address from the testnode funnel account. */
async function fund(addresses: Hex[]) {
	const funder = privateKeyToAccount(accounts.funnel.privateKey);
	const chainId = Number(await rpc<string>("eth_chainId", []));
	const gasPrice = BigInt(await rpc<string>("eth_gasPrice", []));
	const nonce = await nextNonce(funder.address);
	const sends = addresses.map(async (to, i) => {
		const raw = await funder.signTransaction({
			chainId,
			type: "eip1559",
			to,
			value: 10n ** 17n,
			nonce: nonce + i,
			gas: 100_000n,
			maxFeePerGas: gasPrice * 2n,
			maxPriorityFeePerGas: 0n,
		});
		return rpc("eth_sendRawTransaction", [raw]);
	});
	await Promise.all(sends);
}

/**
 * Sign `count` bursts of one transfer per key. Within a burst the tip rises with send order,
 * so first-come ordering and tip ordering disagree.
 */
async function signBursts(keys: Hex[], count: number) {
	const gasPrice = BigInt(await rpc<string>("eth_gasPrice", []));
	const nonces = await Promise.all(keys.map((key) => nextNonce(privateKeyToAccount(key).address)));
	const tips = new Map<string, bigint>();
	const bursts: Array<Array<{ raw: Hex; hash: string }>> = [];
	for (let burst = 0; burst < count; burst++) {
		bursts.push(
			await Promise.all(
				keys.map(async (key, i) => {
					const tip = BigInt(i + 1) * 1_000_000n;
					const tx = await signTransfer({
						privateKey: key,
						nonce: (nonces[i] as number) + burst,
						maxPriorityFeePerGas: tip,
						maxFeePerGas: gasPrice * 2n + tip,
					});
					tips.set(tx.hash, tip);
					return tx;
				}),
			),
		);
	}
	return { bursts, tips };
}

/**
 * eth_sendRawTransaction returns only once the transaction is sequenced, so sends are not
 * awaited per burst: bursts keep landing in both halves of each block.
 */
async function sendBursts(bursts: Array<Array<{ raw: Hex }>>) {
	const pending: Promise<unknown>[] = [];
	for (const burst of bursts) {
		for (const { raw } of burst) {
			pending.push(rpc("eth_sendRawTransaction", [raw]));
		}
		await new Promise((resolve) => setTimeout(resolve, 30 + Math.random() * 40));
	}
	await Promise.all(pending);
}

/** Frames grouped by (block, PGA round), in block order, keeping groups of two or more. */
function groupByBlockRound(frames: FastFeedMessage[]) {
	const groups = new Map<string, FastFeedMessage[]>();
	for (const frame of frames) {
		const id = `${frame.transaction.block_number}/${frame.pga_round}`;
		groups.set(id, [...(groups.get(id) ?? []), frame]);
	}
	return [...groups.values()]
		.filter((group) => group.length > 1)
		.map((group) => group.sort((a, b) => a.transaction.tx_index - b.transaction.tx_index));
}

describe("Fast Feed", () => {
	it("enforces the documented connection rules", async () => {
		expect(await upgradeStatus(FEED_URL, {})).toBe(401);
		expect(await upgradeStatus(FEED_URL, { Authorization: "Bearer not-a-key" })).toBe(401);
		expect((await fetch(FEED_URL.replace(/^ws/, "http"))).status).toBe(426);

		const first = await subscribe(FEED_URL, API_KEY);
		expect(await upgradeStatus(FEED_URL, { Authorization: `Bearer ${API_KEY}` })).toBe(429);
		const closed = new Promise<number>((resolve) => {
			first.socket.onclose = (event) => resolve(event.code);
		});
		first.socket.send("data frames are not allowed");
		expect(await closed).toBe(1003);
	});

	it("streams every transaction with a receipt matching the node's", async () => {
		const feed = await subscribe(FEED_URL, API_KEY);
		const sequencerFeed = await subscribe(SEQUENCER_FEED_URL);
		let sequencerMessages = 0;
		sequencerFeed.socket.onmessage = () => {
			sequencerMessages++;
		};
		try {
			const gasPrice = BigInt(await rpc<string>("eth_gasPrice", []));
			let nonce = await nextNonce(accounts.funnel.address);
			const hashes: string[] = [];
			for (let i = 0; i < 20; i++) {
				const { raw, hash } = await signTransfer({
					privateKey: accounts.funnel.privateKey,
					nonce: nonce++,
					maxFeePerGas: gasPrice * 2n,
					maxPriorityFeePerGas: 0n,
				});
				await rpc("eth_sendRawTransaction", [raw]);
				hashes.push(hash);
			}
			await waitFor(() => hashes.every((hash) => feed.frames.has(hash)), 10_000);

			expect(hashes.filter((hash) => feed.frames.has(hash))).toHaveLength(hashes.length);
			expect([...feed.kinds]).toEqual(["binary"]);
			for (const hash of hashes) {
				const frame = feed.frames.get(hash) as FastFeedMessage;
				const receipt = await rpc<Record<string, string>>("eth_getTransactionReceipt", [hash]);
				expect(frame.version).toBe(1);
				expect(frame.transaction.receipt).not.toHaveProperty("block_hash");
				expect({
					block: frame.transaction.block_number,
					index: frame.transaction.tx_index,
					status: frame.transaction.receipt.status,
					gasUsed: frame.transaction.receipt.gas_used,
					cumulativeGasUsed: frame.transaction.receipt.cumulative_gas_used,
					effectiveGasPrice: BigInt(frame.transaction.receipt.effective_gas_price),
				}).toEqual({
					block: Number(receipt["blockNumber"]),
					index: Number(receipt["transactionIndex"]),
					status: Number(receipt["status"]),
					gasUsed: Number(receipt["gasUsed"]),
					cumulativeGasUsed: Number(receipt["cumulativeGasUsed"]),
					effectiveGasPrice: BigInt(receipt["effectiveGasPrice"] as string),
				});
			}
			expect(sequencerMessages).toBeGreaterThan(0);
		} finally {
			feed.socket.close();
			sequencerFeed.socket.close();
		}
	});

	it.runIf(EXPECT_PGA)(
		"orders each PGA round by priority tip and uses both rounds",
		async () => {
			const keys = Array.from({ length: 8 }, (_, i) =>
				keccak256(stringToHex(`litro-fast-feed-pga-${i}`)),
			);
			await fund(keys.map((key) => privateKeyToAccount(key).address));
			const { bursts, tips } = await signBursts(keys, 30);

			const feed = await subscribe(FEED_URL, API_KEY);
			try {
				await sendBursts(bursts);
				await waitFor(() => [...tips.keys()].every((hash) => feed.frames.has(hash)), 10_000);
			} finally {
				feed.socket.close();
			}

			const ours = [...tips.keys()].flatMap((hash) => feed.frames.get(hash) ?? []);
			expect(ours).toHaveLength(tips.size);
			expect(new Set(ours.map((frame) => frame.pga_round))).toEqual(new Set([1, 2]));
			const groups = groupByBlockRound(ours);
			expect(groups.length).toBeGreaterThan(0);
			for (const group of groups) {
				const tipOrder = group.map(
					(frame) => tips.get(frame.transaction.tx_hash.toLowerCase()) as bigint,
				);
				expect(tipOrder).toEqual([...tipOrder].sort(descending));
			}
		},
		120_000,
	);
});
