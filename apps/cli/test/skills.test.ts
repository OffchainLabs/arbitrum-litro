import { Cli } from "incur";
import { describe, expect, it } from "vitest";
import { createCli } from "../src/index.js";

describe("root cli", () => {
	it("registers every top-level command", () => {
		const commands = Cli.toCommands.get(createCli());
		const names = [...(commands?.keys() ?? [])].sort();
		expect(names).toEqual(
			["bake", "clean", "init", "logs", "snapshot", "start", "status", "stop"].sort(),
		);
	});
});
