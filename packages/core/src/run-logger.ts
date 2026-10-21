import { spawn } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { format } from "node:util";

export type RunStatus = "starting" | "running" | "completed" | "failed" | "stopped";
export type RunLevel = "info" | "warn" | "error";

export interface RunRecord {
	runId: string;
	status: RunStatus;
	command: string;
	args: string[];
	startedAt: string;
	finishedAt?: string;
	pid?: number;
	currentStep?: string;
	failedStep?: string;
	error?: string;
	exitCode?: number;
	lastEvent?: {
		at: string;
		level: RunLevel;
		event: string;
		message: string;
	};
	paths: {
		metaFile: string;
		logFile: string;
		eventsFile: string;
	};
}

export interface RunEvent {
	at: string;
	level: RunLevel;
	event: string;
	message: string;
	data?: Record<string, unknown>;
}

const RUNS_DIRNAME = "runs";
const CURRENT_RUN_FILENAME = "current-run.json";
const RUN_META_FILENAME = "run.json";
const RUN_LOG_FILENAME = "output.log";
const RUN_EVENTS_FILENAME = "events.jsonl";

type ActiveRunContext = {
	run: RunRecord;
	restoreConsole: () => void;
};

let activeRunContext: ActiveRunContext | null = null;

function nowIso(): string {
	return new Date().toISOString();
}

function createRunId(): string {
	return nowIso().replaceAll(/[:.]/g, "-");
}

function getCurrentRunFile(configDir: string): string {
	return resolve(configDir, CURRENT_RUN_FILENAME);
}

function getRunPaths(configDir: string, runId: string): RunRecord["paths"] {
	const runDir = resolve(configDir, RUNS_DIRNAME, runId);
	return {
		metaFile: resolve(runDir, RUN_META_FILENAME),
		logFile: resolve(runDir, RUN_LOG_FILENAME),
		eventsFile: resolve(runDir, RUN_EVENTS_FILENAME),
	};
}

function getConfigDirFromRun(run: RunRecord): string {
	return dirname(dirname(dirname(run.paths.metaFile)));
}

function saveRunRecord(configDir: string, run: RunRecord): void {
	mkdirSync(resolve(configDir, RUNS_DIRNAME, run.runId), { recursive: true });
	writeFileSync(run.paths.metaFile, `${JSON.stringify(run, null, 2)}\n`, "utf-8");
	writeFileSync(getCurrentRunFile(configDir), `${JSON.stringify(run, null, 2)}\n`, "utf-8");
}

function appendRunEventToRecord(run: RunRecord, event: RunEvent): void {
	appendFileSync(run.paths.eventsFile, `${JSON.stringify(event)}\n`, "utf-8");
}

function appendTextLine(run: RunRecord, line: string): void {
	appendFileSync(run.paths.logFile, `${line}\n`, "utf-8");
}

function patchConsoleForRun(run: RunRecord): () => void {
	const original = {
		info: console.info,
		log: console.log,
		warn: console.warn,
		error: console.error,
	};

	const patch = (method: keyof typeof original, level: RunLevel, event: string) => {
		console[method] = (...args: unknown[]) => {
			original[method](...args);
			appendRunEventToRecord(run, {
				at: nowIso(),
				level,
				event,
				message: format(...args),
			});
		};
	};

	patch("info", "info", "console.info");
	patch("log", "info", "console.log");
	patch("warn", "warn", "console.warn");
	patch("error", "error", "console.error");

	return () => {
		console.info = original.info;
		console.log = original.log;
		console.warn = original.warn;
		console.error = original.error;
	};
}

function activateRun(run: RunRecord): RunRecord {
	activeRunContext?.restoreConsole();
	const restoreConsole = patchConsoleForRun(run);
	activeRunContext = { run, restoreConsole };
	return run;
}

function getScriptEntry(projectRoot: string): string {
	return process.argv[1] ?? resolve(projectRoot, "apps/cli/src/index.ts");
}

export function createRunRecord(configDir: string, command: string, args: string[]): RunRecord {
	const runId = createRunId();
	const paths = getRunPaths(configDir, runId);
	const run: RunRecord = {
		runId,
		status: "starting",
		command,
		args,
		startedAt: nowIso(),
		paths,
	};
	saveRunRecord(configDir, run);
	return run;
}

export function loadCurrentRun(configDir: string): RunRecord | null {
	const file = getCurrentRunFile(configDir);
	if (!existsSync(file)) {
		return null;
	}
	return JSON.parse(readFileSync(file, "utf-8")) as RunRecord;
}

export function isPidRunning(pid?: number): boolean {
	if (!pid) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function startInlineRunLogging(configDir: string, args: string[]): RunRecord {
	const run = activateRun(createRunRecord(configDir, "litro", args));
	run.status = "running";
	run.pid = process.pid;
	saveRunRecord(configDir, run);
	logRunEvent("info", "run.started", "Init run started", { pid: process.pid, args });
	return run;
}

export function startRunLoggingFromEnv(configDir: string): RunRecord | null {
	const metaFile = process.env["TESTNODE_RUN_META"];
	if (!metaFile || !existsSync(metaFile)) {
		return null;
	}
	const run = activateRun(JSON.parse(readFileSync(metaFile, "utf-8")) as RunRecord);
	run.status = "running";
	run.pid = process.pid;
	saveRunRecord(configDir, run);
	logRunEvent("info", "run.started", "Detached init worker started", { pid: process.pid });
	return run;
}

export function logRunEvent(
	level: RunLevel,
	event: string,
	message: string,
	data?: Record<string, unknown>,
): void {
	if (!activeRunContext) {
		return;
	}
	const { run } = activeRunContext;
	const payload: RunEvent = { at: nowIso(), level, event, message };
	if (data !== undefined) {
		payload.data = data;
	}
	appendRunEventToRecord(run, payload);
	if (!event.startsWith("console.")) {
		appendTextLine(run, `[${payload.at}] [${level}] ${event} ${message}`);
	}
	run.lastEvent = {
		at: payload.at,
		level: payload.level,
		event: payload.event,
		message: payload.message,
	};
	saveRunRecord(getConfigDirFromRun(run), run);
}

export function updateRunStep(step?: string): void {
	if (!activeRunContext) {
		return;
	}
	if (step === undefined) {
		// biome-ignore lint/performance/noDelete: exactOptionalPropertyTypes forbids assigning undefined to optional properties
		delete activeRunContext.run.currentStep;
	} else {
		activeRunContext.run.currentStep = step;
	}
	saveRunRecord(getConfigDirFromRun(activeRunContext.run), activeRunContext.run);
}

export function finishActiveRun(
	status: RunStatus,
	options?: {
		exitCode?: number;
		error?: string;
		failedStep?: string;
	},
): void {
	if (!activeRunContext) {
		return;
	}
	const { run, restoreConsole } = activeRunContext;
	run.status = status;
	run.finishedAt = nowIso();
	// biome-ignore lint/performance/noDelete: exactOptionalPropertyTypes forbids assigning undefined to optional properties
	delete run.currentStep;
	if (options?.exitCode !== undefined) {
		run.exitCode = options.exitCode;
	} else {
		// biome-ignore lint/performance/noDelete: exactOptionalPropertyTypes forbids assigning undefined to optional properties
		delete run.exitCode;
	}
	if (options?.error !== undefined) {
		run.error = options.error;
	} else {
		// biome-ignore lint/performance/noDelete: exactOptionalPropertyTypes forbids assigning undefined to optional properties
		delete run.error;
	}
	if (options?.failedStep !== undefined) {
		run.failedStep = options.failedStep;
	} else {
		// biome-ignore lint/performance/noDelete: exactOptionalPropertyTypes forbids assigning undefined to optional properties
		delete run.failedStep;
	}
	logRunEvent(
		status === "failed" ? "error" : "info",
		`run.${status}`,
		`Init run ${status}`,
		options?.error ? { error: options.error } : undefined,
	);
	saveRunRecord(getConfigDirFromRun(run), run);
	restoreConsole();
	activeRunContext = null;
}

export function startDetachedInitRun(
	configDir: string,
	projectRoot: string,
	extraArgs: string[] = [],
): RunRecord {
	const runArgs = ["init", "--foreground", ...extraArgs];
	const run = createRunRecord(configDir, "litro", runArgs);
	const entry = getScriptEntry(projectRoot);
	const useTsx = entry.endsWith(".ts");
	const command = useTsx ? "npx" : process.execPath;
	const args = useTsx ? ["tsx", entry, ...runArgs] : [entry, ...runArgs];
	const stdout = openSync(run.paths.logFile, "a");
	const stderr = openSync(run.paths.logFile, "a");
	const child = spawn(command, args, {
		cwd: projectRoot,
		detached: true,
		stdio: ["ignore", stdout, stderr],
		env: {
			...process.env,
			TESTNODE_RUN_META: run.paths.metaFile,
		},
	});
	child.unref();
	if (child.pid !== undefined) {
		run.pid = child.pid;
	}
	saveRunRecord(configDir, run);
	return run;
}

export function readTextLogTail(logFile: string, lines = 50): string[] {
	if (!existsSync(logFile)) {
		return [];
	}
	return readFileSync(logFile, "utf-8").trimEnd().split("\n").slice(-lines);
}

export function readEventLogTail(eventsFile: string, lines = 50): RunEvent[] {
	if (!existsSync(eventsFile)) {
		return [];
	}
	return readFileSync(eventsFile, "utf-8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.slice(-lines)
		.map((line) => JSON.parse(line) as RunEvent);
}

export function stopCurrentRun(configDir: string): boolean {
	const run = loadCurrentRun(configDir);
	const pid = run?.pid;
	if (!run || pid === undefined || !isPidRunning(pid)) {
		return false;
	}
	process.kill(pid, "SIGTERM");
	run.status = "stopped";
	run.finishedAt = nowIso();
	// biome-ignore lint/performance/noDelete: exactOptionalPropertyTypes forbids assigning undefined to optional properties
	delete run.currentStep;
	run.lastEvent = {
		at: nowIso(),
		level: "warn",
		event: "run.stopped",
		message: "Stopped by user",
	};
	saveRunRecord(configDir, run);
	appendRunEventToRecord(run, {
		at: nowIso(),
		level: "warn",
		event: "run.stopped",
		message: "Stopped by user",
	});
	appendTextLine(run, `[${nowIso()}] [warn] run.stopped Stopped by user`);
	return true;
}
