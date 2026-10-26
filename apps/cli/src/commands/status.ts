import { resolve } from "node:path";
import { listStartContainers } from "@arbitrum/testnode";
import { isServiceRunning } from "@arbitrum/testnode-core/docker.js";
import {
	isPidRunning,
	loadCurrentRun,
	readEventLogTail,
} from "@arbitrum/testnode-core/run-logger.js";
import { loadState } from "@arbitrum/testnode-core/state.js";
import { Cli } from "incur";
import { tryProjectRoot } from "../project-root.js";

const RPCS = {
	l1: "http://127.0.0.1:8545",
	l2: "http://127.0.0.1:8547",
	l3: "http://127.0.0.1:8549",
};

/** The init stack's state, which lives in a checkout. */
function initStatus(root: string) {
	const CONFIG_DIR = resolve(root, "config");
	const COMPOSE_FILE = resolve(root, "docker/docker-compose.yaml");
	const DOCKER_OPTS = { composeFile: COMPOSE_FILE, projectName: "arbitrum-testnode" };
	const state = loadState(CONFIG_DIR);
	const run = loadCurrentRun(CONFIG_DIR);

	const services: Record<string, boolean> = {
		anvil: isServiceRunning("l1", DOCKER_OPTS),
		sequencer: isServiceRunning("sequencer", DOCKER_OPTS),
		validator: isServiceRunning("validator", DOCKER_OPTS),
		l3node: isServiceRunning("l3node", DOCKER_OPTS),
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
		const root = tryProjectRoot();
		return {
			containers: listStartContainers(),
			...(root === undefined ? {} : initStatus(root)),
		};
	},
});
