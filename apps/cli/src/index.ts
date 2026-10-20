#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Cli } from "incur";
import { bakeCli } from "./commands/bake.js";
import { cleanCli } from "./commands/clean.js";
import { feedCli } from "./commands/feed.js";
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
	return Cli.create("litro", {
		description: "Local Arbitrum chains (L1 + L2 + L3) for testing",
		version,
		sync: { suggestions: ["boot a testnode with start", "capture a snapshot"] },
		// incur's default is `npx litro --mcp`, which resolves an npm package named
		// litro that this project does not own. Run the installed bin instead.
		mcp: { agents: ["claude-code"], command: "litro --mcp" },
	})
		.command(startCli)
		.command(bakeCli)
		.command(feedCli)
		.command(initCli)
		.command(logsCli)
		.command(snapshotCli)
		.command(statusCli)
		.command(stopCli)
		.command(cleanCli);
}

// An installed bin is a symlink to this file, so compare resolved paths.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	// Must be awaited: an un-awaited serve() runs the command detached, so the
	// process can exit mid-run when the event loop briefly empties between async
	// steps (observed as init exiting 0 at wait-l1 before capturing).
	await createCli().serve();
}
