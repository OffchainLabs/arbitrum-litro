import { cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

// One file for the release tarball: the workspace libraries are inlined, so the package depends
// only on what npm can install. It builds into bundle/, apart from tsc's dist/, so neither build
// overwrites the other.
export default defineConfig({
	entry: ["src/index.ts"],
	outDir: "bundle",
	format: "esm",
	target: "node20",
	platform: "node",
	clean: true,
	noExternal: [/^@arbitrum\/testnode/],
	onSuccess: async () => {
		// findAsset looks beside the bundle, under the same paths as in the repo, before looking for
		// a checkout.
		for (const asset of ["docker/testnode-rebase.Dockerfile", "metrics/dashboards"]) {
			cpSync(
				fileURLToPath(new URL(`../../${asset}`, import.meta.url)),
				fileURLToPath(new URL(`bundle/${asset}`, import.meta.url)),
				{ recursive: true },
			);
		}
	},
});
