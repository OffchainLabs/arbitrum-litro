import { describe, expect, it } from "vitest";
import { createInitContext, resolveInitSnapshotId, runInitCommand } from "../src/init/runner.js";

describe("resolveInitSnapshotId", () => {
	it("defaults to the default snapshot id", () => {
		expect(resolveInitSnapshotId({})).toBe("default");
	});

	it("derives the l3-custom id from feeTokenDecimals", () => {
		expect(resolveInitSnapshotId({ feeTokenDecimals: 6 })).toBe("l3-custom-6");
	});

	it("captureId overrides the feeTokenDecimals-derived id", () => {
		expect(resolveInitSnapshotId({ feeTokenDecimals: 6, captureId: "l3-custom-6-published" })).toBe(
			"l3-custom-6-published",
		);
	});

	it("captureId overrides the default id", () => {
		expect(resolveInitSnapshotId({ captureId: "l2" })).toBe("l2");
	});
});

describe("runInitCommand --nitro-contracts-version", () => {
	it("rejects a version other than v2.1 or v3.2 before starting anything", async () => {
		await expect(
			runInitCommand({ nitroContractsVersion: "v2.2" }, createInitContext("/nonexistent")),
		).rejects.toThrow("--nitro-contracts-version must be v2.1 or v3.2");
	});
});
