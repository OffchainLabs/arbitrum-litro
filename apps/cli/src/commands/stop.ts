import { resolve } from "node:path";
import { listStartContainers, removeContainer } from "@arbitrum/testnode";
import { composeDown } from "@arbitrum/testnode-core/docker.js";
import { stopCurrentRun } from "@arbitrum/testnode-core/run-logger.js";
import { Cli, z } from "incur";
import { tryProjectRoot } from "../project-root.js";

export const stopCli = Cli.create("stop", {
	description: "Stop the testnode: containers from start, and in a checkout the init stack",
	options: z.object({
		container: z
			.string()
			.optional()
			.describe("Remove only this start container and leave the init stack running"),
	}),
	run(c) {
		const only = c.options.container;
		const containers = listStartContainers().filter(
			(container) => !only || container.name === only,
		);
		if (only && containers.length === 0) {
			return { success: false, error: `No start container named ${only}` };
		}
		const removed = containers.map((container) => {
			console.log(`[stop] Removing ${container.name}...`);
			removeContainer(container.name);
			return container.name;
		});
		const root = only ? undefined : tryProjectRoot();
		if (root !== undefined) {
			if (stopCurrentRun(resolve(root, "config"))) {
				console.log("[stop] Stopped detached init run...");
			}
			console.log("[stop] Stopping Docker services...");
			composeDown({
				composeFile: resolve(root, "docker/docker-compose.yaml"),
				projectName: "arbitrum-testnode",
			});
		}
		console.log("[stop] Done.");
		return { success: true, removed };
	},
});
