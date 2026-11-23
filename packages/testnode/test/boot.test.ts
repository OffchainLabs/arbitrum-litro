import type { ExecFileSyncOptions } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ContainerState,
	buildStartTestnodeState,
	collectContainerDiagnostics,
	describeContainerState,
	diagnosticLines,
	exportTestnodeConfig,
	filterContainerLogs,
	isConfigExportFailure,
	pullMissingImage,
	readContainerLogs,
	testnodeDockerRunArgs,
	waitForTestnodeReady,
} from "../src/index.js";
import type { LogCaptureResult } from "../src/types.js";

const containerState = (over: Partial<ContainerState> = {}): ContainerState => ({
	running: true,
	status: "running",
	exitCode: 0,
	oomKilled: false,
	health: "",
	...over,
});
const running = () => containerState();
const exited = (exitCode: number) => containerState({ running: false, status: "exited", exitCode });

const spawnReturning = (over: Partial<LogCaptureResult> = {}) =>
	vi.fn(
		(_file: string, _args: string[], _options: Record<string, unknown>): LogCaptureResult => ({
			status: 0,
			signal: null,
			stdout: "",
			stderr: "",
			...over,
		}),
	);

describe("readContainerLogs", () => {
	it("merges the container's two streams in the child", () => {
		const spawn = spawnReturning({ stdout: "entrypoint: starting\npanic: nitro died\n" });

		const { logs, notes } = readContainerLogs("testnode", 100, spawn);

		const [file, args] = spawn.mock.calls[0] ?? [];
		expect(file).toBe("sh");
		expect(args?.[1]).toContain("2>&1");
		expect(args).toContain("testnode");
		expect(logs).toBe("entrypoint: starting\npanic: nitro died");
		expect(notes).toEqual([]);
	});

	it("throws docker's own error rather than presenting it as container output", () => {
		const spawn = spawnReturning({
			status: 1,
			stdout: "Error response from daemon: No such container: testnode\n",
		});

		expect(() => readContainerLogs("testnode", 100, spawn)).toThrow(
			"docker logs exited with code 1: Error response from daemon: No such container: testnode",
		);
	});

	it("names docker's error from the end of a stream it failed partway through", () => {
		const spawn = spawnReturning({
			status: 1,
			stdout: "INFO starting nitro\nerror from daemon in stream: Error grabbing logs: bad\n",
		});

		expect(() => readContainerLogs("testnode", 100, spawn)).toThrow(
			"docker logs exited with code 1: error from daemon in stream: Error grabbing logs: bad",
		);
	});

	it("keeps what a timed-out or killed capture read, oldest first", () => {
		for (const [over, reason] of [
			[
				{ error: Object.assign(new Error("spawnSync sh ETIMEDOUT"), { code: "ETIMEDOUT" }) },
				/timed out after 30000ms/,
			],
			[{ signal: "SIGKILL" as const }, /killed by SIGKILL/],
		] as const) {
			const spawn = spawnReturning({ status: null, stdout: "a\nb\nc\n", ...over });

			const { logs, notes } = readContainerLogs("testnode", 2, spawn);

			expect(logs).toBe("a\nb");
			expect(notes).toHaveLength(1);
			expect(notes[0]).toMatch(reason);
		}
	});

	it("does not claim a silent container when the capture timed out empty", () => {
		const spawn = spawnReturning({
			status: null,
			error: Object.assign(new Error("spawnSync sh ETIMEDOUT"), { code: "ETIMEDOUT" }),
		});

		expect(readContainerLogs("testnode", 100, spawn).notes).toEqual([
			expect.stringMatching(/^log capture truncated/),
		]);
	});

	it("throws when the capture could not run at all", () => {
		const spawn = spawnReturning({
			status: null,
			stdout: null,
			stderr: null,
			error: Object.assign(new Error("spawnSync sh ENOENT"), { code: "ENOENT" }),
		});

		expect(() => readContainerLogs("testnode", 100, spawn)).toThrow("ENOENT");
	});

	it("says a truncated capture shows the oldest lines, and slices from the head", () => {
		const spawn = spawnReturning({
			status: null,
			error: Object.assign(new Error("spawnSync sh ENOBUFS"), { code: "ENOBUFS" }),
			stdout: "line1\nline2\nline3\n",
		});

		const { logs, notes } = readContainerLogs("testnode", 2, spawn);

		expect(logs).toBe("line1\nline2");
		expect(notes[0]).toMatch(/truncated .*OLDEST 2 lines read, not the tail/);
	});

	it("tells a silent container from one filtered down to nothing", () => {
		expect(readContainerLogs("testnode", 100, spawnReturning()).notes).toEqual([
			"container produced no output on either stream",
		]);
		const spam = spawnReturning({ stdout: "    Block Number: 1\n    Block Hash: 0xabc\n" });
		expect(readContainerLogs("testnode", 100, spam).notes).toEqual([
			"container logs were empty after filtering blank lines and block-progress spam",
		]);
	});
});

describe("filterContainerLogs", () => {
	it("drops anvil's block stanza but keeps a fatal that mentions a block", () => {
		const logs = [
			"    Block Number: 12",
			"    Block Hash: 0xabc",
			"    Block Time: Wed",
			"",
			"panic: bad Block Hash at height 12",
		].join("\n");

		expect(filterContainerLogs(logs, 100)).toBe("panic: bad Block Hash at height 12");
	});

	it("filters before trimming, so spam cannot take the whole window", () => {
		const logs = [...Array.from({ length: 500 }, () => "    Block Number: 1"), "panic"].join("\n");

		expect(filterContainerLogs(logs, 2)).toBe("panic");
	});
});

describe("collectContainerDiagnostics", () => {
	const readLogs = () => ({ logs: "panic: nitro died", notes: ["a caveat"] });

	it("describes the container state and keeps capture caveats with the logs", () => {
		const diagnostics = collectContainerDiagnostics("testnode", {
			inspect: () => exited(137),
			readLogs,
		});

		expect(diagnostics).toEqual({
			inspect: "exited exit=137 oom=false",
			logs: "panic: nitro died",
			errors: ["a caveat"],
		});
	});

	it("keeps the inspect line when the log dump is skipped", () => {
		const read = vi.fn(readLogs);
		const diagnostics = collectContainerDiagnostics("testnode", {
			inspect: running,
			readLogs: read,
			skipLogs: true,
		});

		expect(diagnostics).toEqual({ inspect: "running exit=0 oom=false", errors: [] });
		expect(read).not.toHaveBeenCalled();
	});

	it("records a failed inspect or capture without losing the other", () => {
		const diagnostics = collectContainerDiagnostics("testnode", {
			inspect: () => {
				throw new Error("daemon unreachable");
			},
			readLogs: () => {
				throw new Error("docker logs exited with code 1");
			},
		});

		expect(diagnostics.errors).toEqual([
			"inspect failed: daemon unreachable",
			"log collection failed: docker logs exited with code 1",
		]);
	});
});

describe("diagnosticLines", () => {
	it("puts the capture caveats before the logs they qualify", () => {
		expect(
			diagnosticLines({ inspect: "exited exit=1 oom=false", errors: ["truncated"], logs: "panic" }),
		).toEqual(["container state: exited exit=1 oom=false", "truncated", "container logs:\npanic"]);
	});

	it("reports the health status only when the image has a healthcheck", () => {
		expect(describeContainerState(containerState({ health: "unhealthy" }))).toBe(
			"running exit=0 oom=false health=unhealthy",
		);
		expect(describeContainerState(containerState())).toBe("running exit=0 oom=false");
	});
});

describe("config server port", () => {
	const stateWith = (configServerPort?: string) =>
		buildStartTestnodeState({
			configServerPort,
			cwd: "/workspace/project",
			l3Enabled: false,
			version: "v1.2.3",
		});

	it("publishes the config server on the requested host port, 8080 by default", () => {
		expect(testnodeDockerRunArgs(stateWith("9091"))).toContain("127.0.0.1:9091:8080");
		expect(testnodeDockerRunArgs(stateWith())).toContain("127.0.0.1:8080:8080");
	});

	it("rejects a port that is not an integer between 1 and 65535", () => {
		for (const port of ["70000", "0", "-1", "8080.5", "abc"]) {
			expect(() => stateWith(port)).toThrow(
				`config-server-port must be an integer between 1 and 65535, got ${port}`,
			);
		}
	});
});

describe("waitForTestnodeReady", () => {
	const stateFor = (options: { l3Enabled: boolean; fastFeedEnabled?: boolean }) =>
		buildStartTestnodeState({
			cwd: "/workspace/project",
			l3Enabled: options.l3Enabled,
			sequencer: { fastFeedEnabled: options.fastFeedEnabled },
			version: "v1.2.3",
		});
	const l2 = stateFor({ l3Enabled: false });

	afterEach(() => {
		vi.useRealTimers();
	});

	it("waits for each chain RPC in order, and only the variant's", () => {
		const probed: string[] = [];
		const probe = (url: string) => {
			probed.push(url);
			return true;
		};

		waitForTestnodeReady(l2, 1000, { inspect: running, probe, sleep: vi.fn() });
		waitForTestnodeReady(stateFor({ l3Enabled: true }), 1000, {
			inspect: running,
			probe,
			sleep: vi.fn(),
		});

		expect(probed).toEqual([
			"http://127.0.0.1:8545",
			"http://127.0.0.1:8547",
			"http://127.0.0.1:8545",
			"http://127.0.0.1:8547",
			"http://127.0.0.1:3347",
		]);
	});

	it("fails at once, naming what it waited for, when the container stops", () => {
		const sleep = vi.fn();

		expect(() =>
			waitForTestnodeReady(l2, 120_000, {
				inspect: () => exited(137),
				probe: (url) => url.endsWith(":8545"),
				sleep,
			}),
		).toThrow(
			"container arbitrum-testnode-l2 stopped while waiting for RPC at http://127.0.0.1:8547 (exited exit=137 oom=false)",
		);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("reports a crash rather than a timeout when the container dies on the last pass", () => {
		expect(() =>
			waitForTestnodeReady(l2, 0, {
				inspect: () => exited(139),
				probe: () => false,
				sleep: vi.fn(),
			}),
		).toThrow(/stopped while waiting/);
	});

	it("shares one deadline across everything it waits for", () => {
		vi.useFakeTimers();
		// L1 needs two retries and L2 never answers. Under a shared 3s budget L2 gets only what L1
		// left; a fresh budget per RPC would sleep five times, not three.
		let l1Probes = 0;
		const sleep = vi.fn(() => {
			vi.advanceTimersByTime(1000);
		});

		expect(() =>
			waitForTestnodeReady(l2, 3000, {
				inspect: running,
				probe: (url) => url.endsWith(":8545") && ++l1Probes >= 3,
				sleep,
			}),
		).toThrow("RPC at http://127.0.0.1:8547 not ready after 3000ms");
		expect(sleep).toHaveBeenCalledTimes(3);
	});

	it("waits for the healthcheck after the RPCs when a sequencer feature needs it", () => {
		const health = ["starting", "starting", "healthy"];
		const sleep = vi.fn();

		waitForTestnodeReady(stateFor({ l3Enabled: false, fastFeedEnabled: true }), 120_000, {
			inspect: () => containerState({ health: health.shift() ?? "healthy" }),
			probe: () => true,
			sleep,
		});

		expect(health).toEqual([]);
	});

	it("keeps waiting through a transient inspect failure", () => {
		let inspects = 0;
		let l1Up = false;

		waitForTestnodeReady(l2, 120_000, {
			inspect: () => {
				inspects += 1;
				if (inspects === 1) {
					throw new Error("Cannot connect to the Docker daemon");
				}
				l1Up = true;
				return containerState();
			},
			probe: () => l1Up,
			sleep: vi.fn(),
		});

		expect(inspects).toBeGreaterThan(1);
	});

	it("gives up once inspect fails several times in a row, saying what it waited for", () => {
		const inspect = vi.fn((): ContainerState => {
			throw new Error("Cannot connect to the Docker daemon");
		});

		expect(() =>
			waitForTestnodeReady(l2, 120_000, { inspect, probe: () => false, sleep: vi.fn() }),
		).toThrow(
			"cannot inspect container arbitrum-testnode-l2 while waiting for RPC at http://127.0.0.1:8545: Cannot connect to the Docker daemon",
		);
		expect(inspect).toHaveBeenCalledTimes(3);
	});

	it("counts only consecutive inspect failures", () => {
		const outcomes = ["fail", "fail", "ok", "fail", "fail", "ok"];
		let passes = 0;

		waitForTestnodeReady(l2, 120_000, {
			inspect: () => {
				passes += 1;
				if (outcomes.shift() === "fail") {
					throw new Error("Cannot connect to the Docker daemon");
				}
				return containerState();
			},
			probe: () => passes >= 6,
			sleep: vi.fn(),
		});

		expect(outcomes).toEqual([]);
	});
});

describe("exportTestnodeConfig", () => {
	const stateIn = (configDir: string) => ({ configDir, containerName: "testnode" }) as never;
	const freshDir = () => mkdtempSync(join(tmpdir(), "testnode-export-"));
	const copyFailing = (stderr: string) => () => {
		throw Object.assign(new Error("Command failed: docker cp"), { stderr });
	};
	const exportError = (copy: () => void, inspect: () => ContainerState = running): Error => {
		try {
			exportTestnodeConfig(stateIn(freshDir()), { copy, inspect });
		} catch (error) {
			return error as Error;
		}
		throw new Error("expected the export to fail");
	};

	it("returns the exported entries", () => {
		const dir = freshDir();
		const copy = () => writeFileSync(join(dir, "localNetwork.json"), "{}");

		expect(exportTestnodeConfig(stateIn(dir), { copy, inspect: running })).toEqual([
			"localNetwork.json",
		]);
	});

	it("tags a host-side copy failure against a running container as export-only", () => {
		const error = exportError(copyFailing("Error response from daemon: no space left on device"));

		expect(isConfigExportFailure(error)).toBe(true);
		expect(error.message).toContain("after successful boot");
	});

	it("treats config the container never produced as a node failure", () => {
		for (const stderr of [
			"Error response from daemon: Could not find the file /opt/arbitrum-testnode/export-config/. in container testnode",
			"Error: no such file or directory",
		]) {
			const error = exportError(copyFailing(stderr));
			expect(isConfigExportFailure(error)).toBe(false);
			expect(error.message).toContain("the container produced no config");
		}
		const empty = exportError(() => {});
		expect(isConfigExportFailure(empty)).toBe(false);
		expect(empty.message).toContain("no config files exported");
	});

	it("keeps the log dump when the container stopped or its state is unknown", () => {
		const copy = copyFailing("Error response from daemon: copy failed");

		expect(isConfigExportFailure(exportError(copy, () => exited(137)))).toBe(false);
		expect(
			isConfigExportFailure(
				exportError(copy, () => {
					throw new Error("daemon unreachable");
				}),
			),
		).toBe(false);
	});
});

describe("pullMissingImage", () => {
	const stateFor = (imageRef: string) => ({ imageRef }) as never;
	const runner = (present: boolean) =>
		vi.fn((args: string[], _options?: ExecFileSyncOptions): string => {
			if (args[0] === "image" && !present) {
				throw new Error("Error: No such image");
			}
			return "";
		});

	it("pulls an image the host lacks, progress on stderr, on a fetch-sized budget", () => {
		const run = runner(false);
		pullMissingImage(stateFor("ghcr.io/offchainlabs/arbitrum-litro:latest-l2"), run);

		const pull = run.mock.calls.find(([args]) => args[0] === "pull");
		expect(pull?.[0]).toEqual(["pull", "ghcr.io/offchainlabs/arbitrum-litro:latest-l2"]);
		expect(pull?.[1]).toMatchObject({ stdio: ["ignore", 2, "inherit"] });
		expect(pull?.[1]?.timeout).toBeGreaterThan(120_000);
	});

	it("does not pull an image already on the host", () => {
		const run = runner(true);
		pullMissingImage(stateFor("ghcr.io/offchainlabs/arbitrum-litro:latest-l2"), run);

		expect(run.mock.calls.some(([args]) => args[0] === "pull")).toBe(false);
	});

	it("never pulls a rebased local ref", () => {
		const run = runner(false);
		pullMissingImage(stateFor("local/arbitrum-testnode-rebase:l2-abc123"), run);

		expect(run).not.toHaveBeenCalled();
	});
});
