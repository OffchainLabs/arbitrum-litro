import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	configureSequencer,
	renameBatchMaxSize,
	setMaxBlockSpeed,
} from "../docker/configure-sequencer.mjs";

describe("renameBatchMaxSize", () => {
	it("moves batch-poster.max-size to max-calldata-batch-size", () => {
		expect(
			renameBatchMaxSize({ node: { "batch-poster": { "max-size": 90000, enable: true } } }),
		).toEqual({ node: { "batch-poster": { "max-calldata-batch-size": 90000, enable: true } } });
	});

	it("keeps an explicit max-calldata-batch-size", () => {
		const config = { node: { "batch-poster": { "max-size": 1, "max-calldata-batch-size": 2 } } };
		expect(renameBatchMaxSize(config).node?.["batch-poster"]).toEqual({
			"max-calldata-batch-size": 2,
		});
	});

	it("leaves a config without max-size alone", () => {
		const config = { node: { sequencer: true } };
		expect(renameBatchMaxSize(config)).toBe(config);
	});
});

describe("configureSequencer", () => {
	function configRoot() {
		const root = mkdtempSync(join(tmpdir(), "configure-sequencer-"));
		const node = { node: { "batch-poster": { "max-size": 90000 } } };
		writeFileSync(
			join(root, "l2-nodeConfig.json"),
			JSON.stringify({
				...node,
				execution: { sequencer: { enable: true, "max-block-speed": "100ms" } },
			}),
		);
		writeFileSync(join(root, "l3-nodeConfig.json"), JSON.stringify(node));
		return root;
	}
	const read = (root: string, name: string) => JSON.parse(readFileSync(join(root, name), "utf8"));

	it("renames on both chains and sets the block speed on L2 only", () => {
		const root = configRoot();
		configureSequencer(root, { renameBatchMaxSize: true, l2MaxBlockSpeed: "250ms" });
		expect(read(root, "l2-nodeConfig.json")).toEqual({
			node: { "batch-poster": { "max-calldata-batch-size": 90000 } },
			execution: { sequencer: { enable: true, "max-block-speed": "250ms" } },
		});
		expect(read(root, "l3-nodeConfig.json")).toEqual({
			node: { "batch-poster": { "max-calldata-batch-size": 90000 } },
		});
	});

	it("changes nothing for an older Nitro with no block speed set", () => {
		const root = configRoot();
		configureSequencer(root, { renameBatchMaxSize: false });
		expect(read(root, "l2-nodeConfig.json").node["batch-poster"]).toEqual({ "max-size": 90000 });
		expect(read(root, "l2-nodeConfig.json").execution.sequencer["max-block-speed"]).toBe("100ms");
	});

	it("sets the block speed under an empty execution section", () => {
		expect(setMaxBlockSpeed({}, "250ms")).toEqual({
			execution: { sequencer: { "max-block-speed": "250ms" } },
		});
	});
});
