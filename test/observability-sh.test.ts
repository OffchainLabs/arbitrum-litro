import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const HELPER = resolve("docker/observability.sh");

/** Source the helper with `env` and print one Nitro process's flags, as the entrypoint does. */
function nitroArgs(env: Record<string, string>, metricsPort = 6072, pprofPort = 6073) {
	return execFileSync(
		"sh",
		["-c", `. "${HELPER}"; nitro_observability_args ${metricsPort} ${pprofPort}`],
		{
			encoding: "utf-8",
			env: { PATH: process.env["PATH"], ...env },
		},
	).trim();
}

/** Source the helper and report what start_observability would start. */
function started(env: Record<string, string>) {
	return execFileSync(
		"sh",
		["-c", `start_background() { echo "$@"; }; . "${HELPER}"; start_observability`],
		{ encoding: "utf-8", env: { PATH: process.env["PATH"], TESTNODE_BIN: "/bin-dir", ...env } },
	).trim();
}

describe("observability.sh", () => {
	it("adds nothing when metrics and pprof are off", () => {
		expect(nitroArgs({})).toBe("");
		expect(started({})).toBe("");
	});

	it("serves metrics on every interface at the node's port", () => {
		expect(nitroArgs({ TESTNODE_METRICS: "true" })).toBe(
			"--metrics --metrics-server.addr=0.0.0.0 --metrics-server.port=6072",
		);
		expect(started({ TESTNODE_METRICS: "true" })).toBe("node /bin-dir/chain-exporter.mjs");
	});

	it("serves pprof on its own port, alone or beside metrics", () => {
		expect(nitroArgs({ TESTNODE_PPROF: "true" })).toBe(
			"--pprof --pprof-cfg.addr=0.0.0.0 --pprof-cfg.port=6073",
		);
		expect(nitroArgs({ TESTNODE_METRICS: "true", TESTNODE_PPROF: "true" })).toBe(
			"--metrics --metrics-server.addr=0.0.0.0 --metrics-server.port=6072 --pprof --pprof-cfg.addr=0.0.0.0 --pprof-cfg.port=6073",
		);
	});
});
