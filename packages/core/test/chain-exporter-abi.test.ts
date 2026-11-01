import { rollupABI } from "@arbitrum/chain-sdk/contracts/Rollup/v3.2.js";
import { sequencerInboxABI } from "@arbitrum/chain-sdk/contracts/SequencerInbox/v3.1.js";
import { type Abi, toEventSelector, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { SELECTORS, TOPICS } from "../../../docker/chain-exporter.mjs";

// The chain exporter is dependency-free, so it carries these as constants; this pins them to the
// nitro-contracts ABIs the testnode deploys.
const eventSelector = (abi: Abi, name: string) => {
	const event = abi.find((item) => item.type === "event" && item.name === name);
	if (!event || event.type !== "event") {
		throw new Error(`no ${name} event`);
	}
	return toEventSelector(event);
};

describe("chain-exporter constants", () => {
	it("match the nitro-contracts event topics", () => {
		expect(TOPICS).toEqual({
			sequencerBatchDelivered: eventSelector(sequencerInboxABI as Abi, "SequencerBatchDelivered"),
			assertionCreated: eventSelector(rollupABI as Abi, "AssertionCreated"),
			assertionConfirmed: eventSelector(rollupABI as Abi, "AssertionConfirmed"),
			// IBridge.sol; the chain SDK ships no Bridge ABI.
			messageDelivered: toEventSelector(
				"event MessageDelivered(uint256 indexed messageIndex, bytes32 indexed beforeInboxAcc, address inbox, uint8 kind, address sender, bytes32 messageDataHash, uint256 baseFeeL1, uint64 timestamp)",
			),
		});
	});

	it("match the function selectors it calls", () => {
		expect(SELECTORS).toEqual(
			Object.fromEntries(
				Object.keys(SELECTORS).map((name) => [name, toFunctionSelector(`${name}()`)]),
			),
		);
	});
});
