import { copyFileSync } from "node:fs";
import { defineConfig } from "tsup";

// One file for the release tarball: the workspace libraries are inlined, so the
// package depends only on what npm can install.
export default defineConfig({
	entry: ["src/index.ts"],
	format: "esm",
	target: "node20",
	platform: "node",
	clean: true,
	noExternal: [/^@arbitrum\/testnode/],
	onSuccess: async () => {
		// findRebaseDockerfile looks beside the bundle before looking for a checkout.
		copyFileSync("../../docker/testnode-rebase.Dockerfile", "dist/testnode-rebase.Dockerfile");
	},
});
