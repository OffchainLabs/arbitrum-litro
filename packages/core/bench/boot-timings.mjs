// Measures how long a testnode container takes from `docker run` to each chain answering, the
// container healthcheck passing, and the first newly confirmed assertion on each rollup.
//
//   node packages/core/bench/boot-timings.mjs --image <ref> [--runs 3] [--variant l3-eth]
//     [--env KEY=VALUE ...] [--mount host:container ...] [--timeout 300] [--label name]
//     [--port-shift 30000] [--keep]
//
// Prints one JSON line per run with seconds since `docker run` started. Rollup addresses come from
// .testnode-context/export-config/localNetwork.json, so run it after prepare-testnode-context.mjs
// for the same variant. Host ports are shifted by --port-shift so it can run beside a testnode
// already on the default ports.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { http, createPublicClient, parseAbi } from "viem";
import { buildStartTestnodeState, testnodeDockerRunArgs } from "../../testnode/src/runtime.mjs";

const CONTAINER = "litro-bench";
const rollupAbi = parseAbi(["function latestConfirmed() view returns (bytes32)"]);

const argv = process.argv.slice(2);
/** @param {string} name @param {string} [fallback] */
function arg(name, fallback = "") {
	const i = argv.indexOf(name);
	return i === -1 ? fallback : (argv[i + 1] ?? fallback);
}
/** @param {string} name */
function args(name) {
	return argv.flatMap((a, i) => (a === name ? [argv[i + 1] ?? ""] : []));
}

const image = arg("--image");
if (!image) {
	throw new Error("--image is required");
}
const variant = arg("--variant", "l3-eth");
const l3 = variant !== "l2";
const portShift = Number(arg("--port-shift", "30000"));
const label = arg("--label", image);

/** @param {string} url */
function shiftUrl(url) {
	return url.replace(/:(\d+)$/, (_, p) => `:${Number(p) + portShift}`);
}

const state = buildStartTestnodeState({
	containerName: CONTAINER,
	cwd: process.cwd(),
	imageRef: image,
	l3Enabled: l3,
});
const runArgs = testnodeDockerRunArgs(state).map((a) =>
	a.replace(/^127\.0\.0\.1:(\d+):/, (_, p) => `127.0.0.1:${Number(p) + portShift}:`),
);
runArgs.splice(
	runArgs.length - 1,
	0,
	...args("--env").flatMap((e) => ["-e", e]),
	...args("--mount").flatMap((m) => ["-v", m]),
);

const net = JSON.parse(readFileSync(".testnode-context/export-config/localNetwork.json", "utf8"));
/** @type {{ name: string, url: string, rollup?: `0x${string}`, parent?: string }[]} */
const chains = [
	{ name: "l1", url: shiftUrl(state.rpcUrls.l1) },
	{
		name: "l2",
		parent: "l1",
		rollup: net.l2Network.ethBridge.rollup,
		url: shiftUrl(state.rpcUrls.l2),
	},
];
if (l3) {
	chains.push({
		name: "l3",
		parent: "l2",
		rollup: net.l3Network.ethBridge.rollup,
		url: shiftUrl(state.rpcUrls.l3),
	});
}
const clients = Object.fromEntries(
	chains.map((c) => [c.name, createPublicClient({ transport: http(c.url) })]),
);

/** @param {string} url */
async function answers(url) {
	try {
		const res = await fetch(url, {
			body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "eth_chainId", params: [] }),
			headers: { "content-type": "application/json" },
			method: "POST",
			signal: AbortSignal.timeout(1000),
		});
		return res.ok && "result" in (await res.json());
	} catch {
		return false;
	}
}

function health() {
	try {
		return execFileSync("docker", ["inspect", "-f", "{{.State.Health.Status}}", CONTAINER], {
			encoding: "utf8",
		}).trim();
	} catch {
		return "gone";
	}
}

/** @param {{ parent?: string, rollup?: `0x${string}` }} chain */
async function latestConfirmed(chain) {
	try {
		return await clients[chain.parent ?? ""].readContract({
			abi: rollupAbi,
			address: chain.rollup ?? "0x",
			functionName: "latestConfirmed",
		});
	} catch {
		return undefined;
	}
}

/**
 * One poll of every milestone not yet reached. `initial` holds each rollup's latestConfirmed as
 * first read, so a later different value is a newly confirmed assertion.
 *
 * @param {Record<string, number>} result
 * @param {Record<string, string>} initial
 * @param {() => number} since
 */
async function poll(result, initial, since) {
	for (const c of chains) {
		if (!(`${c.name}_rpc` in result) && (await answers(c.url))) {
			result[`${c.name}_rpc`] = since();
		}
	}
	if (!("healthy" in result) && health() === "healthy") {
		result["healthy"] = since();
	}
	for (const c of chains) {
		if (c.rollup && !(`${c.name}_confirmed` in result) && `${c.parent}_rpc` in result) {
			await pollConfirmed(c, result, initial, since);
		}
	}
}

/**
 * @param {{ name: string, parent?: string, rollup?: `0x${string}` }} chain
 * @param {Record<string, number>} result
 * @param {Record<string, string>} initial
 * @param {() => number} since
 */
async function pollConfirmed(chain, result, initial, since) {
	const hash = await latestConfirmed(chain);
	if (hash === undefined) {
		return;
	}
	initial[chain.name] ??= hash;
	if (hash !== initial[chain.name]) {
		result[`${chain.name}_confirmed`] = since();
	}
}

/** @param {number} timeoutS */
async function runOnce(timeoutS) {
	execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
	const t0 = performance.now();
	const since = () => Number(((performance.now() - t0) / 1000).toFixed(2));
	execFileSync("docker", runArgs, { stdio: "ignore" });
	/** @type {Record<string, number>} */
	const result = { run_s: since() };
	const want = [
		...chains.map((c) => `${c.name}_rpc`),
		"healthy",
		...chains.filter((c) => c.rollup).map((c) => `${c.name}_confirmed`),
	];
	const initial = {};
	const deadline = Date.now() + timeoutS * 1000;
	while (Date.now() < deadline && !want.every((k) => k in result) && health() !== "gone") {
		await poll(result, initial, since);
		await new Promise((r) => setTimeout(r, 100));
	}
	return { label, ...result, missing: want.filter((k) => !(k in result)) };
}

const runs = Number(arg("--runs", "1"));
const timeoutS = Number(arg("--timeout", "300"));
for (let i = 0; i < runs; i++) {
	console.log(JSON.stringify(await runOnce(timeoutS)));
}
if (!argv.includes("--keep")) {
	execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
}
