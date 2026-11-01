import { listStartContainers, readContainerLogs, selectStartContainer } from "@arbitrum/testnode";
import {
	loadCurrentRun,
	readEventLogTail,
	readTextLogTail,
} from "@arbitrum/testnode-core/run-logger.js";
import { Cli, z } from "incur";
import { findCheckout } from "../project-root.js";

/** The checkout's latest init run, unless a container was asked for. */
function initRun(container: string | undefined) {
	const checkout = findCheckout();
	return checkout && !container ? loadCurrentRun(checkout.configDir) : null;
}

export const logsCli = Cli.create("logs", {
	description: "Show the latest init run logs, or a start container's logs",
	options: z.object({
		tail: z.string().optional().describe("Number of lines or events to read (default: 50)"),
		raw: z.boolean().optional().describe("Read the plain text output log instead of JSON events"),
		container: z
			.string()
			.optional()
			.describe("Read this start container's logs (default: the init run, else the running one)"),
	}),
	run(c) {
		const tail = c.options.tail ? Number(c.options.tail) : 50;
		if (!Number.isFinite(tail) || tail <= 0) {
			throw new Error("tail must be a positive number");
		}

		const run = initRun(c.options.container);
		if (!run) {
			const container = selectStartContainer(listStartContainers(), c.options.container);
			return {
				success: true,
				container: container.name,
				lines: readContainerLogs(container.name, tail),
			};
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
