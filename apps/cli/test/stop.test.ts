import { afterEach, describe, expect, it, vi } from "vitest";
import { removeContainers } from "../src/commands/stop.js";

describe("removeContainers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("still removes the container when its metrics stack cannot be removed", () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const removeMetrics = vi.fn((name: string) => {
			if (name === "a") {
				throw new Error("grafana busy");
			}
		});
		const removeContainer = vi.fn();

		const failures = removeContainers(["a", "b"], [removeMetrics, removeContainer]);

		expect(removeContainer.mock.calls).toEqual([["a"], ["b"]]);
		expect(failures).toEqual(["a: grafana busy"]);
	});
});
