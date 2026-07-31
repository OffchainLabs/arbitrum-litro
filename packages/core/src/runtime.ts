import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { composeDown, composeUp, waitForRpc } from "./docker.js";
import { exec } from "./exec.js";
import { SNAPSHOTS_DIRNAME, getAnvilStateDir } from "./snapshot.js";

export interface RuntimeRpcs {
	l1: string;
	l2: string;
	l3: string;
}

// Booting nitro from a snapshot can exceed the default 120s on cold/loaded CI
// runners; TESTNODE_RPC_TIMEOUT_MS lets a caller extend the readiness budget.
function rpcTimeoutMs(): number {
	const raw = process.env["TESTNODE_RPC_TIMEOUT_MS"];
	const parsed = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

export interface RuntimeOptions {
	composeFile: string;
	projectName: string;
	configDir: string;
}

const STATIC_CONFIG_FILES = new Set([SNAPSHOTS_DIRNAME, "testnodes.json"]);

export function stopRuntime(options: RuntimeOptions): void {
	composeDown({ composeFile: options.composeFile, projectName: options.projectName });
}

export function resetRuntime(options: RuntimeOptions): void {
	exec("docker", ["compose", "-f", options.composeFile, "-p", options.projectName, "down", "-v"]);

	if (!existsSync(options.configDir)) {
		return;
	}

	for (const entry of readdirSync(options.configDir)) {
		if (STATIC_CONFIG_FILES.has(entry)) {
			continue;
		}
		rmSync(join(options.configDir, entry), { recursive: true, force: true });
	}
}

/**
 * Start the L1 anvil chain as the `l1` Docker compose service. The host
 * `config/anvil-state` dir is bind-mounted into the container, so it is created
 * first to keep snapshot capture/restore working against the host fs.
 */
export function startL1Container(options: RuntimeOptions): void {
	mkdirSync(getAnvilStateDir(options.configDir), { recursive: true });
	const result = composeUp(["l1"], {
		composeFile: options.composeFile,
		projectName: options.projectName,
	});
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.trim() || "failed to start l1 service");
	}
}

export async function startNitroFromSnapshot(
	options: RuntimeOptions,
	rpcs: RuntimeRpcs,
): Promise<void> {
	const l2Result = composeUp(["sequencer", "validator"], {
		composeFile: options.composeFile,
		projectName: options.projectName,
	});
	if (l2Result.exitCode !== 0) {
		throw new Error(l2Result.stderr.trim() || "failed to start L2 services");
	}
	await waitForRpc(rpcs.l2, rpcTimeoutMs());

	const l3Result = composeUp(["l3node"], {
		composeFile: options.composeFile,
		projectName: options.projectName,
	});
	if (l3Result.exitCode !== 0) {
		throw new Error(l3Result.stderr.trim() || "failed to start l3node");
	}
	await waitForRpc(rpcs.l3, rpcTimeoutMs());
}
