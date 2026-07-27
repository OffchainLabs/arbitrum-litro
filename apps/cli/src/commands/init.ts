import { createInitContext, runInitCommand } from "@arbitrum/testnode-core/init-runner.js";
import { Cli, z } from "incur";
import { projectRoot } from "../project-root.js";

export const initCli = Cli.create("init", {
	description: "Initialize the testnode (L1 + L2 + L3 with bridges)",
	options: z.object({
		background: z
			.boolean()
			.optional()
			.describe("Start init in the background and return the run metadata"),
		captureId: z
			.string()
			.optional()
			.describe("Capture the snapshot under this id instead of the variant-derived default"),
		feeTokenDecimals: z
			.number()
			.optional()
			.describe("Deploy a custom fee token ERC20 on L2 with this many decimals (6, 16, 18, or 20)"),
		foreground: z.boolean().optional().describe("Internal worker mode for detached init runs"),
		rebuild: z
			.boolean()
			.optional()
			.describe("Force a full rebuild instead of restoring the default snapshot"),
		skipPostCaptureVerify: z
			.boolean()
			.optional()
			.describe("Skip the post-capture verify-restart after capturing the snapshot"),
		snapshotVersion: z
			.string()
			.optional()
			.describe("Snapshot release tag to install when the default snapshot is missing"),
		timeboostEnabled: z
			.boolean()
			.optional()
			.describe("Deploy Timeboost contracts and restart L2 with Timeboost enabled"),
	}),
	async run(c) {
		return runInitCommand(c.options, createInitContext(projectRoot()));
	},
});
