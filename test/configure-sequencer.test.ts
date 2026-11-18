import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	configureSequencer,
	dropDataAvailabilityL1Keys,
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

describe("dropDataAvailabilityL1Keys", () => {
	const aggregators = {
		"rest-aggregator": { enable: true, urls: ["http://localhost:9877"] },
		"rpc-aggregator": { enable: true, "assumed-honest": 1, backends: "[]" },
	};
	const anyTrust = {
		node: {
			"batch-poster": { enable: true },
			"data-availability": {
				enable: true,
				"sequencer-inbox-address": "0x00000000000000000000000000000000000000aa",
				"parent-chain-node-url": "http://sequencer:8547",
				...aggregators,
			},
		},
	};

	it("drops only the keys Nitro >= v3.10 rejects", () => {
		expect(dropDataAvailabilityL1Keys(anyTrust)).toEqual({
			node: {
				"batch-poster": { enable: true },
				"data-availability": { enable: true, ...aggregators },
			},
		});
	});

	it("leaves a config without data-availability alone", () => {
		const config = { node: { sequencer: true } };
		expect(dropDataAvailabilityL1Keys(config)).toBe(config);
	});

	it("drops them from the L3 config only when asked", () => {
		const root = mkdtempSync(join(tmpdir(), "configure-sequencer-"));
		const write = () => {
			writeFileSync(join(root, "l2-nodeConfig.json"), JSON.stringify({ node: {} }));
			writeFileSync(join(root, "l3-nodeConfig.json"), JSON.stringify(anyTrust));
		};
		const da = () =>
			JSON.parse(readFileSync(join(root, "l3-nodeConfig.json"), "utf8")).node["data-availability"];

		write();
		configureSequencer(root, { renameBatchMaxSize: false });
		expect(da()).toEqual(anyTrust.node["data-availability"]);

		write();
		configureSequencer(root, { renameBatchMaxSize: false, dropDataAvailabilityL1Keys: true });
		expect(da()).toEqual({ enable: true, ...aggregators });
	});
});
