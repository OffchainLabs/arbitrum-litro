#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { Cli } from "incur";
import { bakeCli } from "./commands/bake.js";
import { cleanCli } from "./commands/clean.js";
import { initCli } from "./commands/init.js";
import { logsCli } from "./commands/logs.js";
import { snapshotCli } from "./commands/snapshot.js";
import { startCli } from "./commands/start.js";
import { statusCli } from "./commands/status.js";
import { stopCli } from "./commands/stop.js";

const { version } = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export function createCli() {
	return Cli.create("testnode", {
		description: "Arbitrum testnode (L1 + L2 + L3)",
		version,
		sync: { suggestions: ["boot a testnode with start", "capture a snapshot"] },
		mcp: { agents: ["claude-code"] },
	})
		.command(startCli)
		.command(bakeCli)
		.command(initCli)
		.command(logsCli)
		.command(snapshotCli)
		.command(statusCli)
		.command(stopCli)
		.command(cleanCli);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	// Must be awaited: an un-awaited serve() runs the command detached, so the
	// process can exit mid-run when the event loop briefly empties between async
	// steps (observed as init exiting 0 at wait-l1 before capturing).
	await createCli().serve();
}
