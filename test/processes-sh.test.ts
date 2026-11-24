import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const HELPER = resolve("docker/processes.sh");

function runShell(body: string) {
	const started = Date.now();
	const result = spawnSync("sh", ["-c", `set -eu; . "${HELPER}"; ${body}`], {
		encoding: "utf-8",
		timeout: 20_000,
	});
	return { status: result.status, stderr: result.stderr, seconds: (Date.now() - started) / 1000 };
}

describe("processes.sh", () => {
	it("exits with the status of the process that died and names it", () => {
		const { status, stderr, seconds } = runShell(
			"start_background crasher sh -c 'exit 3'; start_background sleeper sleep 30; monitor_pids",
		);

		expect(status).toBe(3);
		expect(stderr).toMatch(/^testnode: crasher \(pid \d+\) exited with status 3$/m);
		// The EXIT trap killed the sleeper rather than waiting out its 30s.
		expect(seconds).toBeLessThan(15);
	});

	it("still fails when the process that stopped exited 0", () => {
		const { status, stderr } = runShell(
			"start_background finisher true; start_background sleeper sleep 30; monitor_pids",
		);

		expect(status).toBe(1);
		expect(stderr).toMatch(/testnode: finisher \(pid \d+\) exited with status 0/);
	});

	it("says what a startup wait was waiting for", () => {
		const { status, stderr } = runShell(
			`start_background sequencer sh -c 'exit 2'
			while true; do exit_if_a_process_exited "RPC at http://127.0.0.1:8547"; sleep 0.2; done`,
		);

		expect(status).toBe(2);
		expect(stderr).toMatch(
			/testnode: sequencer \(pid \d+\) exited with status 2 while waiting for RPC at http:\/\/127\.0\.0\.1:8547/,
		);
	});

	it("exits 143 on SIGTERM without blaming a process", async () => {
		const child = spawn(
			"sh",
			["-c", `set -eu; . "${HELPER}"; start_background sleeper sleep 30; monitor_pids`],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
		child.kill("SIGTERM");
		const code = await new Promise<number | null>((resolveExit) => child.on("exit", resolveExit));

		expect(code).toBe(143);
		expect(stderr).not.toContain("testnode:");
	});
});
