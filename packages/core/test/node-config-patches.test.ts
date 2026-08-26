import { describe, expect, it } from "vitest";
import {
	patchGeneratedL2NodeConfig,
	patchGeneratedL3NodeConfig,
} from "../src/node-config-patches.js";

describe("patchGeneratedL2NodeConfig", () => {
	it("relaxes batch poster L1-bound settings for the local L2 runtime", () => {
		const input = {
			chain: {
				"info-json": JSON.stringify([
					{
						rollup: {
							"stake-token": "0x0000000000000000000000000000000000000000",
						},
					},
				]),
			},
			node: {
				"batch-poster": {
					enable: true,
					"max-size": 90000,
					"parent-chain-wallet": {
						"private-key": "old-key",
					},
				},
				staker: {
					"parent-chain-wallet": {
						"private-key": "old-validator",
					},
				},
				"delayed-sequencer": {
					enable: true,
					"finalize-distance": 1,
				},
				dangerous: {
					"disable-blob-reader": false,
				},
			},
			execution: {},
		};

		const result = patchGeneratedL2NodeConfig(
			input,
			"0xnew-key",
			"0x1111111111111111111111111111111111111111",
			"0xvalidator-key",
		);

		expect(result["chain"]).toEqual({
			"info-json": JSON.stringify([
				{
					rollup: {
						"stake-token": "0x1111111111111111111111111111111111111111",
					},
				},
			]),
		});
		expect(result["node"]).toEqual({
			"batch-poster": {
				enable: true,
				"max-size": 90000,
				"parent-chain-wallet": {
					"private-key": "new-key",
				},
				"l1-block-bound": "ignore",
				"max-delay": "100ms",
				"poll-interval": "100ms",
				"error-delay": "100ms",
				"wait-for-max-delay": false,
				"data-poster": {
					"wait-for-l1-finality": false,
				},
			},
			"delayed-sequencer": {
				enable: true,
				"finalize-distance": 0,
			},
			staker: {
				"disable-challenge": true,
				"parent-chain-wallet": {
					"private-key": "validator-key",
				},
				"use-smart-contract-wallet": true,
			},
			dangerous: {
				"disable-blob-reader": false,
			},
		});
		expect(result["execution"]).toEqual({
			sequencer: {
				"max-block-speed": "100ms",
			},
		});
	});
});

describe("patchGeneratedL3NodeConfig", () => {
	it("converts the generated config into the L3 runtime shape", () => {
		const input = {
			chain: {
				"info-json": '[{"chain-id":333333}]',
				name: "orbit-dev-test",
			},
			"parent-chain": {
				connection: {
					url: "http://host.docker.internal:8547",
				},
			},
			node: {
				"batch-poster": {
					enable: true,
				},
				dangerous: {
					"disable-blob-reader": false,
				},
				"delayed-sequencer": {
					enable: true,
					"finalize-distance": 1,
				},
			},
			http: {
				addr: "0.0.0.0",
			},
			execution: {},
		};

		const result = patchGeneratedL3NodeConfig(
			input,
			"http://sequencer:8547",
			false,
			"0xposter-key",
		);

		expect(result["ensure-rollup-deployment"]).toBe(false);
		expect(result["chain"]).toEqual({
			id: 333333,
			"info-files": ["/config/l3_chain_info.json"],
			name: "orbit-dev-test",
		});
		expect(result["parent-chain"]).toEqual({
			connection: {
				url: "http://sequencer:8547",
			},
		});
		expect(result["node"]).toEqual({
			"batch-poster": {
				enable: true,
				"parent-chain-wallet": {
					"private-key": "poster-key",
				},
				"l1-block-bound": "ignore",
				"max-delay": "100ms",
				"poll-interval": "100ms",
				"error-delay": "100ms",
				"wait-for-max-delay": false,
				"redis-url": "",
				"data-poster": {
					"wait-for-l1-finality": false,
				},
			},
			bold: {
				"rpc-block-number": "latest",
				"assertion-posting-interval": "100ms",
				"assertion-confirming-interval": "100ms",
				"assertion-scanning-interval": "100ms",
				"minimum-gap-to-parent-assertion": "100ms",
				"parent-chain-block-time": "100ms",
			},
			dangerous: {
				"disable-blob-reader": true,
			},
			"delayed-sequencer": {
				enable: true,
				"finalize-distance": 0,
			},
			staker: {
				enable: false,
				"use-smart-contract-wallet": true,
				"disable-challenge": true,
				"staker-interval": "100ms",
				"make-assertion-interval": "100ms",
			},
		});
		expect(result["execution"]).toEqual({
			"forwarding-target": "null",
			sequencer: {
				"max-block-speed": "333ms",
			},
		});
		expect(result["persistent"]).toEqual({ chain: "local" });
		expect(result["ws"]).toEqual({ addr: "0.0.0.0" });
	});
});
