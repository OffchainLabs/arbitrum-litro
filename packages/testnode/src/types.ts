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

export interface TestnodeState {
	configDir: string;
	containerName: string;
	contractsVersion: string;
	imageRef: string;
	outputDir: string;
	paths: {
		l1BridgeUiConfig: string;
		l1l2Network: string;
		l2BridgeUiConfig: string;
		l2l3Network: string;
		localNetwork: string;
	};
	rpcUrls: { l1: string; l2: string; l3: string };
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
	outputDir?: string | undefined;
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

export interface ContainerDiagnostics {
	inspect?: string;
	logs?: string;
	errors: string[];
}
