import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { findCheckout, findProjectRoot, projectRoot } from "../src/project-root.js";

describe("project root", () => {
	it("finds the checkout the tests run from, with its init stack", () => {
		expect(findCheckout()).toEqual({
			projectRoot: projectRoot(),
			configDir: `${projectRoot()}/config`,
			composeFile: `${projectRoot()}/docker/docker-compose.yaml`,
			projectName: "arbitrum-testnode",
		});
	});

	it("has no root outside a checkout", () => {
		expect(() => findProjectRoot(tmpdir())).toThrow(/project root/);
	});
});
