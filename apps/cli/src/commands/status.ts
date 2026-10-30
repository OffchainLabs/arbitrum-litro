import { listStartContainers } from "@arbitrum/testnode";
import { isServiceRunning } from "@arbitrum/testnode-core/docker.js";
import type { InitContext } from "@arbitrum/testnode-core/init-runner.js";
import {
	isPidRunning,
	loadCurrentRun,
	readEventLogTail,
} from "@arbitrum/testnode-core/run-logger.js";
import { loadState } from "@arbitrum/testnode-core/state.js";
import { Cli } from "incur";
import { findCheckout } from "../project-root.js";

const RPCS = {
	l1: "http://127.0.0.1:8545",
	l2: "http://127.0.0.1:8547",
	l3: "http://127.0.0.1:8549",
};

/** The init stack's state, which lives in a checkout. */
function initStatus(checkout: InitContext) {
	const state = loadState(checkout.configDir);
	const run = loadCurrentRun(checkout.configDir);

	const services: Record<string, boolean> = {
		anvil: isServiceRunning("l1", checkout),
		sequencer: isServiceRunning("sequencer", checkout),
		validator: isServiceRunning("validator", checkout),
		l3node: isServiceRunning("l3node", checkout),
	};

	return {
		initialized: state !== null,
		services,
		rpcs: RPCS,
		run: run
			? {
					...run,
					alive: isPidRunning(run.pid),
					recentEvents: readEventLogTail(run.paths.eventsFile, 10),
				}
			: null,
		initSteps: state?.steps ?? {},
	};
}

export const statusCli = Cli.create("status", {
	description: "Show testnode status",
	run() {
		const checkout = findCheckout();
		return {
			containers: listStartContainers(),
			...(checkout ? initStatus(checkout) : {}),
		};
	},
});
