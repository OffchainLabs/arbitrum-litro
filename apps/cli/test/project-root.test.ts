import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { findProjectRoot, projectRoot, tryProjectRoot } from "../src/project-root.js";

describe("project root", () => {
	it("finds the checkout the tests run from", () => {
		expect(tryProjectRoot()).toBe(projectRoot());
	});

	it("has no root outside a checkout", () => {
		expect(() => findProjectRoot(tmpdir())).toThrow(/project root/);
	});
});
