export type ScalarInput = number | string | boolean | undefined;

export interface VariantDefinition {
	description?: string;
	name: string;
	hostPorts: { l1: number; l2: number; l2Ws: number; l3?: number; l3Ws?: number };
	l3Enabled: boolean;
	snapshotId: string;
	snapshotReleaseTag: string;
	/**
	 * Per-contracts-version snapshot bundles. When a variant ships distinct
	 * snapshots per nitro-contracts version (e.g. v2.1 vs v3.2), the override for
	 * that version is keyed here; the default version falls back to the top-level
	 * `snapshotId`/`snapshotReleaseTag`.
	 */
	snapshotsByContractsVersion?: Record<string, { snapshotId: string; snapshotReleaseTag: string }>;
	timeboostEnabled?: boolean;
	feeTokenDecimals?: number;
	supportedContractsVersions?: string[];
}

/** Optional L2 sequencer features, as callers supply them (flags, env vars, config files). */
export interface SequencerOptions {
	/** API key the Fast Feed relay accepts; empty or unset uses the dev key. */
	fastFeedApiKey?: string | undefined;
	/** Whether the relay requires `Authorization: Bearer <key>` (default true). */
	fastFeedAuth?: boolean | string | undefined;
	fastFeedDelayMs?: number | string | undefined;
	fastFeedEnabled?: boolean | string | undefined;
	/** Go duration overriding the L2 sequencer's max-block-speed, e.g. `250ms`. */
	l2MaxBlockSpeed?: string | undefined;
	/** PGA rounds per L2 block; the chain is upgraded to ArbOS 60 and collects tips. */
	pgaRoundsPerBlock?: number | string | undefined;
}

export interface FastFeedState {
	/** Key to send as `Authorization: Bearer <key>`. */
	apiKey: string;
	/** Whether the relay checks the key. */
	auth: boolean;
	/** Delay the relay adds to every frame, in milliseconds. */
	delayMs: number;
	/** Host URL of the Fast Feed relay. */
	url: string;
	/** Host URL of the sequencer feed, which carries the block hashes Fast Feed frames lack. */
	sequencerFeedUrl: string;
}

/** Resolved sequencer features; every field is unset when its feature is off. */
export interface SequencerState {
	fastFeed: FastFeedState | undefined;
	l2MaxBlockSpeed: string | undefined;
	pgaRoundsPerBlock: number | undefined;
}

/** One Fast Feed message, as the public "Use the Fast Feed" guide documents it. */
export interface FastFeedMessage {
	version: number;
	timestamp_ms: number;
	pga_round?: number;
	transaction: {
		block_number: number;
		tx_index: number;
		raw_tx: string;
		tx_hash: string;
		receipt: {
			status: number;
			gas_used: number;
			gas_used_for_l1: number;
			cumulative_gas_used: number;
			effective_gas_price: string;
			base_fee: string;
			contract_address?: string;
			logs: Array<{ address: string; topics: string[]; data: string }>;
		};
	};
}

export interface TestnodeState {
	/**
	 * The image to pull and authenticate against. Equals `imageRef` unless
	 * `nitroImage` requested a rebase, in which case it is the rebase source.
	 */
	baseImageRef: string;
	configDir: string;
	containerName: string;
	contractsVersion: string;
	/** The image to boot. */
	imageRef: string;
	/** Nitro image `baseImageRef` is rebased onto, when one was requested. */
	nitroImage: string;
	outputDir: string;
	paths: {
		l1BridgeUiConfig: string;
		l1l2Network: string;
		l2BridgeUiConfig: string;
		l2l3Network: string;
		localNetwork: string;
	};
	rpcUrls: { l1: string; l2: string; l3: string };
	sequencer: SequencerState;
	snapshotId: string;
	timeboostEnabled: boolean;
	variant: string;
	variantDefinition: VariantDefinition;
}

export interface BaseStateOptions {
	containerName?: string | undefined;
	contractsVersion?: string | undefined;
	feeTokenDecimals?: number | string | undefined;
	/**
	 * Full image reference (incl. tag) that bypasses variant/version-based image
	 * resolution without changing runtime variant selection.
	 */
	imageRef?: string | undefined;
	imageRepository?: string | undefined;
	l3Enabled?: boolean | string | undefined;
	/**
	 * When set, the resolved testnode image is rebased onto this Nitro image and
	 * the rebase is booted — letting callers exercise a Nitro build of their own.
	 */
	nitroImage?: string | undefined;
	outputDir?: string | undefined;
	sequencer?: SequencerOptions | undefined;
	timeboostEnabled?: boolean | string | undefined;
	version?: string | undefined;
}

export type ActionStateOptions = BaseStateOptions & {
	runnerTemp?: string | undefined;
	workspace?: string | undefined;
};

export type StartStateOptions = BaseStateOptions & { cwd: string };

export interface ImageRefOptions {
	contractsVersion?: string | undefined;
	imageRepository?: string | undefined;
	variant: string;
	version: string;
}

/** A container `start` ran, as `stop`, `status` and `logs` find it. */
export interface StartContainer {
	name: string;
	variant: string;
	image: string;
	/** docker's state: running, exited, created, … */
	state: string;
	/** healthy, unhealthy or "health: starting"; empty before a healthcheck reports */
	health: string;
	/** Published endpoints by name (l1, l2, l3, fastFeed, sequencerFeed) */
	endpoints: Record<string, string>;
}

export interface ContainerDiagnostics {
	inspect?: string;
	logs?: string;
	errors: string[];
}
