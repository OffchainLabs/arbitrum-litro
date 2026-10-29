import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		// From source, so the suite runs in a checkout nobody has built (Verify Published Image).
		alias: {
			"@arbitrum/testnode": fileURLToPath(
				new URL("packages/testnode/src/index.ts", import.meta.url),
			),
		},
	},
	test: {
		include: ["apps/*/test/integration/**/*.test.ts", "packages/*/test/integration/**/*.test.ts"],
		environment: "node",
		testTimeout: 60_000,
	},
});
