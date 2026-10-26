import { resolve } from "node:path";
import { type StartContainer, listStartContainers, readContainerLogs } from "@arbitrum/testnode";
import {
	loadCurrentRun,
	readEventLogTail,
	readTextLogTail,
} from "@arbitrum/testnode-core/run-logger.js";
import { Cli, z } from "incur";
import { tryProjectRoot } from "../project-root.js";

/** The named container, else the only running one, else the only one. */
function pickContainer(containers: StartContainer[], name: string | undefined) {
	if (name) {
		return containers.find((container) => container.name === name);
	}
	const running = containers.filter((container) => container.state === "running");
	const candidates = running.length > 0 ? running : containers;
	return candidates.length === 1 ? candidates[0] : undefined;
}

function containerLogs(tail: number, name: string | undefined) {
	const containers = listStartContainers();
	const container = pickContainer(containers, name);
	if (!container) {
		return {
			success: false,
			error:
				containers.length === 0
					? "No init run or start container found"
					: `Pick a container with --container: ${containers.map((c) => c.name).join(", ")}`,
		};
	}
	return {
		success: true,
		container: container.name,
		lines: readContainerLogs(container.name, tail),
	};
}

export const logsCli = Cli.create("logs", {
	description: "Show the latest init run logs, or a start container's logs",
	options: z.object({
		tail: z.string().optional().describe("Number of lines or events to read (default: 50)"),
		raw: z.boolean().optional().describe("Read the plain text output log instead of JSON events"),
		container: z
			.string()
			.optional()
			.describe("Start container to read, when more than one exists (reads it over an init run)"),
	}),
	run(c) {
		const tail = c.options.tail ? Number(c.options.tail) : 50;
		if (!Number.isFinite(tail) || tail <= 0) {
			return { success: false, error: "tail must be a positive number" };
		}

		const root = tryProjectRoot();
		const run =
			root === undefined || c.options.container ? null : loadCurrentRun(resolve(root, "config"));
		if (!run) {
			return containerLogs(tail, c.options.container);
		}

		if (c.options.raw) {
			return {
				success: true,
				runId: run.runId,
				status: run.status,
				logFile: run.paths.logFile,
				lines: readTextLogTail(run.paths.logFile, tail),
			};
		}

		return {
			success: true,
			runId: run.runId,
			status: run.status,
			eventsFile: run.paths.eventsFile,
			events: readEventLogTail(run.paths.eventsFile, tail),
		};
	},
});
