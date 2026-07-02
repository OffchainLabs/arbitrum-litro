import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { waitForRpc } from "../docker.js";
import {
	finishActiveRun,
	logRunEvent,
	startDetachedInitRun,
	startInlineRunLogging,
	startRunLoggingFromEnv,
	updateRunStep,
} from "../run-logger.js";
import { resetRuntime, startL1Container, startNitroFromSnapshot, stopRuntime } from "../runtime.js";
import { installSnapshotRelease } from "../snapshot-release.js";
import {
	ANVIL_STATE_FILENAME,
	DEFAULT_SNAPSHOT_ID,
	captureSnapshot,
	getAnvilStateDir,
	hasSnapshot,
	restoreSnapshot,
	verifySnapshotSemanticState,
} from "../snapshot.js";
import { createState, getNextPendingStep, loadState, markStepFailed, saveState } from "../state.js";
import { makeStepRunners } from "./chain-steps.js";
import { type InitContext, type InitRuntime, createInitRuntime } from "./context.js";
import { INIT_STEP_NAMES, getInitSteps } from "./steps.js";

export { createInitContext, type InitContext } from "./context.js";

const L1_RPC = "http://127.0.0.1:8545";
const L2_RPC = "http://127.0.0.1:8547";
const L3_RPC = "http://127.0.0.1:8549";
const ANVIL_STATE_CAPTURE_WAIT_MS = 30_000;
const ANVIL_STATE_CAPTURE_POLL_MS = 250;

function isNonEmptyFile(path: string): boolean {
	if (!existsSync(path)) {
		return false;
	}
	const stats = statSync(path);
	return stats.isFile() && stats.size > 0;
}

async function waitForAnvilStateFile(configDir: string): Promise<void> {
	const statePath = join(getAnvilStateDir(configDir), ANVIL_STATE_FILENAME);
	const deadline = Date.now() + ANVIL_STATE_CAPTURE_WAIT_MS;
	while (Date.now() < deadline) {
		if (isNonEmptyFile(statePath)) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, ANVIL_STATE_CAPTURE_POLL_MS));
	}
	throw new Error(
		`Snapshot source missing non-empty Anvil state file after waiting ${ANVIL_STATE_CAPTURE_WAIT_MS}ms: ${statePath}`,
	);
}

async function runInitLoop(
	runtime: InitRuntime,
	feeTokenDecimals?: number,
	rebuild?: boolean,
	timeboostEnabled?: boolean,
	nitroContractsVersion?: string,
): Promise<{
	success: boolean;
	failedStep?: string;
	error?: string;
	timings?: Record<string, number>;
	steps: string[];
}> {
	let state = rebuild ? createState() : (loadState(runtime.configDir) ?? createState());
	const runners = makeStepRunners(runtime, feeTokenDecimals, nitroContractsVersion);
	const steps = getInitSteps({ timeboostEnabled });
	const timings: Record<string, number> = {};

	let nextStep = getNextPendingStep(state, steps);
	while (nextStep !== null) {
		const stepStart = Date.now();
		console.log(`[init] Running step: ${nextStep}`);
		updateRunStep(nextStep);
		logRunEvent("info", "step.started", `Running step ${nextStep}`, { step: nextStep });
		const runner = runners[nextStep];
		if (!runner) {
			throw new Error(`Unknown step: ${nextStep}`);
		}
		try {
			state = await runner(state);
			const elapsed = Date.now() - stepStart;
			timings[nextStep] = elapsed;
			saveState(runtime.configDir, state);
			console.log(`[init] Step done: ${nextStep} (${(elapsed / 1000).toFixed(1)}s)`);
			logRunEvent("info", "step.completed", `Step ${nextStep} completed`, {
				step: nextStep,
				elapsedMs: elapsed,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			state = markStepFailed(state, nextStep, msg);
			saveState(runtime.configDir, state);
			console.error(`[init] Step failed: ${nextStep} - ${msg}`);
			logRunEvent("error", "step.failed", `Step ${nextStep} failed`, {
				step: nextStep,
				error: msg,
			});
			return { success: false, failedStep: nextStep, error: msg, timings, steps };
		}
		nextStep = getNextPendingStep(state, steps);
	}

	return { success: true, timings, steps };
}

export { INIT_STEP_NAMES };

export interface InitCommandOptions {
	background?: boolean | undefined;
	captureId?: string | undefined;
	feeTokenDecimals?: number | undefined;
	foreground?: boolean | undefined;
	nitroContractsVersion?: string | undefined;
	rebuild?: boolean | undefined;
	skipPostCaptureVerify?: boolean | undefined;
	snapshotVersion?: string | undefined;
	timeboostEnabled?: boolean | undefined;
}

/**
 * Resolve the snapshot id init captures under. `captureId` (used by the publish
 * pipeline to capture directly under a variant id) takes precedence over the
 * default feeTokenDecimals-derived id.
 */
export function resolveInitSnapshotId(options: {
	captureId?: string | undefined;
	feeTokenDecimals?: number | undefined;
}): string {
	if (options.captureId) {
		return options.captureId;
	}
	return options.feeTokenDecimals !== undefined
		? `l3-custom-${options.feeTokenDecimals}`
		: DEFAULT_SNAPSHOT_ID;
}

export async function runInitCommand(options: InitCommandOptions, context: InitContext) {
	const runtime = createInitRuntime(context);
	const { feeTokenDecimals } = options;
	assertValidFeeTokenDecimals(feeTokenDecimals);
	const snapshotId = resolveInitSnapshotId(options);

	if (options.background && !options.foreground) {
		return startBackgroundInit(runtime, {
			snapshotVersion: options.snapshotVersion,
			feeTokenDecimals,
			timeboostEnabled: options.timeboostEnabled,
			nitroContractsVersion: options.nitroContractsVersion,
		});
	}

	// Hold the event loop open for the whole foreground init. Some async steps
	// (notably wait-l1's first fetch, right after the synchronous docker
	// spawnSync in start-l1) leave a brief window with no registered libuv
	// handle; without this keep-alive Node exits mid-run (silently as exit 0, or
	// as an unsettled-top-level-await exit 13), which is flaky under CI load.
	const keepAlive = setInterval(() => {}, 1 << 30);
	try {
		return await runInitForeground(runtime, options, snapshotId, feeTokenDecimals);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		finishActiveRun("failed", { exitCode: 1, error: message });
		throw err;
	} finally {
		clearInterval(keepAlive);
	}
}

async function runInitForeground(
	runtime: InitRuntime,
	options: {
		foreground?: boolean | undefined;
		nitroContractsVersion?: string | undefined;
		rebuild?: boolean | undefined;
		skipPostCaptureVerify?: boolean | undefined;
		snapshotVersion?: string | undefined;
		timeboostEnabled?: boolean | undefined;
	},
	snapshotId: string,
	feeTokenDecimals: number | undefined,
) {
	const totalStart = Date.now();
	const hasExistingInitState = loadState(runtime.configDir) !== null;
	await ensureSnapshotInstalledIfNeeded(
		runtime,
		snapshotId,
		options.rebuild || hasExistingInitState,
		options.snapshotVersion,
	);
	const shouldRestoreSnapshot =
		!options.rebuild && !hasExistingInitState && hasSnapshot(runtime.configDir, snapshotId);
	const logArgs = options.foreground ? ["init", "--foreground"] : ["init"];

	if (shouldRestoreSnapshot) {
		return runSnapshotRestoreFlow(runtime, snapshotId, logArgs, totalStart);
	}

	if (options.rebuild) {
		console.log("[init] Resetting runtime data for rebuild...");
		resetRuntime({
			composeFile: runtime.composeFile,
			projectName: runtime.projectName,
			configDir: runtime.configDir,
		});
	}

	startRunLoggingFromEnv(runtime.configDir) ?? startInlineRunLogging(runtime.configDir, logArgs);
	const result = await runInitLoop(
		runtime,
		feeTokenDecimals,
		options.rebuild,
		options.timeboostEnabled,
		options.nitroContractsVersion,
	);
	const totalElapsed = Date.now() - totalStart;
	logInitTimeline(result.timings, totalElapsed);

	if (!result.success) {
		finishFailedInit(result);
	}

	return finalizeFreshInit(
		runtime,
		snapshotId,
		totalStart,
		result.steps,
		options.skipPostCaptureVerify,
	);
}

export class InitFailedError extends Error {
	readonly failedStep: string | undefined;
	constructor(failedStep: string | undefined, cause: string | undefined) {
		super(`init failed at step ${failedStep ?? "unknown"}${cause ? `: ${cause}` : ""}`);
		this.name = "InitFailedError";
		this.failedStep = failedStep;
	}
}

export function finishFailedInit(result: {
	error?: string | undefined;
	failedStep?: string | undefined;
}): never {
	finishActiveRun("failed", {
		exitCode: 1,
		...(result.error ? { error: result.error } : {}),
		...(result.failedStep ? { failedStep: result.failedStep } : {}),
	});
	throw new InitFailedError(result.failedStep, result.error);
}

function assertValidFeeTokenDecimals(feeTokenDecimals: number | undefined): void {
	if (
		feeTokenDecimals !== undefined &&
		feeTokenDecimals !== 6 &&
		feeTokenDecimals !== 16 &&
		feeTokenDecimals !== 18 &&
		feeTokenDecimals !== 20
	) {
		throw new Error("--fee-token-decimals must be 6, 16, 18, or 20");
	}
}

function startBackgroundInit(
	runtime: InitRuntime,
	params: {
		snapshotVersion: string | undefined;
		feeTokenDecimals: number | undefined;
		timeboostEnabled: boolean | undefined;
		nitroContractsVersion: string | undefined;
	},
) {
	const extraArgs = [
		...(params.snapshotVersion ? ["--snapshot-version", params.snapshotVersion] : []),
		...(params.feeTokenDecimals !== undefined
			? ["--fee-token-decimals", String(params.feeTokenDecimals)]
			: []),
		...(params.timeboostEnabled ? ["--timeboost-enabled"] : []),
		...(params.nitroContractsVersion
			? ["--nitro-contracts-version", params.nitroContractsVersion]
			: []),
	];
	const run = startDetachedInitRun(runtime.configDir, runtime.projectRoot, extraArgs);
	return {
		success: true as const,
		detached: true,
		runId: run.runId,
		pid: run.pid,
		status: run.status,
		logFile: run.paths.logFile,
		eventsFile: run.paths.eventsFile,
	};
}

async function ensureSnapshotInstalledIfNeeded(
	runtime: InitRuntime,
	snapshotId: string,
	rebuild: boolean | undefined,
	snapshotVersion: string | undefined,
): Promise<void> {
	if (rebuild || hasSnapshot(runtime.configDir, snapshotId)) {
		return;
	}
	console.log(`[init] Installing snapshot release ${snapshotVersion ?? "latest"}...`);
	const install = await installSnapshotRelease({
		composeFile: runtime.composeFile,
		configDir: runtime.configDir,
		...(snapshotVersion ? { version: snapshotVersion } : {}),
	});
	console.log(
		`[init] Installed snapshot ${install.releaseTag ?? install.archiveName} from ${install.sourceUrl}`,
	);
}

async function runSnapshotRestoreFlow(
	runtime: InitRuntime,
	snapshotId: string,
	logArgs: string[],
	totalStart: number,
) {
	console.log(`[init] Restoring snapshot: ${snapshotId}`);
	stopRuntime({
		composeFile: runtime.composeFile,
		projectName: "arbitrum-testnode",
		configDir: runtime.configDir,
	});
	restoreSnapshot(runtime.configDir, snapshotId);
	startRunLoggingFromEnv(runtime.configDir) ?? startInlineRunLogging(runtime.configDir, logArgs);
	startL1Container(runtime);
	await waitForRpc(L1_RPC);
	await startNitroFromSnapshot(
		{
			composeFile: runtime.composeFile,
			projectName: "arbitrum-testnode",
			configDir: runtime.configDir,
		},
		{ l1: L1_RPC, l2: L2_RPC, l3: L3_RPC },
	);
	await verifySnapshotSemanticState(runtime.configDir, { l1: L1_RPC, l2: L2_RPC, l3: L3_RPC });
	const totalElapsed = Date.now() - totalStart;
	finishActiveRun("completed", { exitCode: 0 });
	return {
		success: true as const,
		restoredSnapshot: snapshotId,
		totalSeconds: totalElapsed / 1000,
	};
}

function logInitTimeline(timings: Record<string, number> | undefined, totalElapsed: number): void {
	if (!timings) {
		return;
	}
	console.log("\n[init] Timeline:");
	for (const [step, ms] of Object.entries(timings)) {
		console.log(`  ${step}: ${(ms / 1000).toFixed(1)}s`);
	}
	console.log(`  TOTAL: ${(totalElapsed / 1000).toFixed(1)}s`);
}

async function finalizeFreshInit(
	runtime: InitRuntime,
	snapshotId: string,
	totalStart: number,
	steps: string[],
	skipPostCaptureVerify?: boolean,
) {
	stopRuntime({
		composeFile: runtime.composeFile,
		projectName: "arbitrum-testnode",
		configDir: runtime.configDir,
	});
	await waitForAnvilStateFile(runtime.configDir);
	const snapshot = captureSnapshot(runtime.configDir, runtime.composeFile, snapshotId);
	if (skipPostCaptureVerify) {
		const totalElapsed = Date.now() - totalStart;
		finishActiveRun("completed", { exitCode: 0 });
		return {
			success: true as const,
			stepsCompleted: steps.length,
			totalSeconds: totalElapsed / 1000,
			snapshotId: snapshot.snapshotId,
		};
	}
	startL1Container(runtime);
	await waitForRpc(L1_RPC);
	await startNitroFromSnapshot(
		{
			composeFile: runtime.composeFile,
			projectName: "arbitrum-testnode",
			configDir: runtime.configDir,
		},
		{ l1: L1_RPC, l2: L2_RPC, l3: L3_RPC },
	);
	await verifySnapshotSemanticState(runtime.configDir, { l1: L1_RPC, l2: L2_RPC, l3: L3_RPC });
	const totalElapsed = Date.now() - totalStart;
	finishActiveRun("completed", { exitCode: 0 });
	return {
		success: true as const,
		stepsCompleted: steps.length,
		totalSeconds: totalElapsed / 1000,
		snapshotId: snapshot.snapshotId,
	};
}
