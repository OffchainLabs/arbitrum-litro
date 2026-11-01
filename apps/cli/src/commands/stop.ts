import {
	listMetricsHistory,
	listStartContainers,
	removeContainer,
	removeMetricsHistory,
	removeMetricsStack,
	selectStartContainer,
} from "@arbitrum/testnode";
import { composeDown } from "@arbitrum/testnode-core/docker.js";
import { stopCurrentRun } from "@arbitrum/testnode-core/run-logger.js";
import { Cli, z } from "incur";
import { findCheckout } from "../project-root.js";

/** Stop the checkout's init run and compose stack, when the CLI runs from a checkout. */
function stopInitStack() {
	const checkout = findCheckout();
	if (!checkout) {
		return;
	}
	if (stopCurrentRun(checkout.configDir)) {
		console.log("[stop] Stopped detached init run...");
	}
	console.log("[stop] Stopping Docker services...");
	composeDown(checkout);
}

export const stopCli = Cli.create("stop", {
	description: "Stop the testnode: containers from start, and in a checkout the init stack",
	options: z.object({
		container: z
			.string()
			.optional()
			.describe("Remove only this start container and leave the init stack running"),
		forgetHistory: z
			.boolean()
			.optional()
			.describe("Also remove the Prometheus history `start --keep-history` kept"),
	}),
	run(c) {
		const containers = listStartContainers();
		const targets = c.options.container
			? [selectStartContainer(containers, c.options.container)]
			: containers;
		for (const container of targets) {
			console.log(`[stop] Removing ${container.name}...`);
			removeMetricsStack(container.name);
			removeContainer(container.name);
		}
		if (!c.options.container) {
			// Also stacks whose testnode was removed some other way.
			removeMetricsStack();
			stopInitStack();
		}
		const history = listMetricsHistory(c.options.container && targets[0]?.name);
		if (c.options.forgetHistory) {
			removeMetricsHistory(history);
		} else if (history.length > 0) {
			console.log(
				`[stop] Kept metrics history in ${history.join(", ")} (--forget-history removes it)`,
			);
		}
		console.log("[stop] Done.");
		return {
			success: true,
			removed: targets.map((container) => container.name),
			history: { volumes: history, removed: c.options.forgetHistory === true },
		};
	},
});
