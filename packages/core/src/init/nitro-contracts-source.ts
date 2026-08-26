import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
	DEFAULT_NITRO_CONTRACTS_COMMIT,
	DEFAULT_NITRO_CONTRACTS_RELEASE,
	NITRO_CONTRACTS_REPOSITORY,
} from "../external-pins.js";

export { DEFAULT_NITRO_CONTRACTS_COMMIT, DEFAULT_NITRO_CONTRACTS_RELEASE };
export const NITRO_CONTRACTS_FAMILY = "v3.2";
const NITRO_CONTRACTS_PACKAGE = "@arbitrum/nitro-contracts";

export type NitroContractsSource =
	| {
			kind: "release";
			family: typeof NITRO_CONTRACTS_FAMILY;
			release: typeof DEFAULT_NITRO_CONTRACTS_RELEASE;
			commit: typeof DEFAULT_NITRO_CONTRACTS_COMMIT;
			buildContext: string;
			identity: string;
	  }
	| {
			kind: "workspace";
			family: typeof NITRO_CONTRACTS_FAMILY;
			path: string;
			packageVersion: string;
			buildContext: string;
			identity: string;
	  };

interface NitroContractsPackageJson {
	name?: unknown;
	version?: unknown;
	scripts?: Record<string, unknown> | undefined;
}

function readPackageJson(workspace: string): NitroContractsPackageJson {
	const path = resolve(workspace, "package.json");
	if (!existsSync(path)) {
		throw new Error(
			`Nitro contracts workspace is missing package.json: ${path}. Set NITRO_CONTRACTS_LOCAL_DIR to a nitro-contracts checkout.`,
		);
	}
	try {
		return JSON.parse(readFileSync(path, "utf8")) as NitroContractsPackageJson;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to parse Nitro contracts package.json at ${path}: ${message}`);
	}
}

function assertRequiredPath(workspace: string, relativePath: string): void {
	const path = resolve(workspace, relativePath);
	if (!existsSync(path)) {
		throw new Error(`Nitro contracts workspace is missing ${relativePath}: ${path}`);
	}
}

export function validateNitroContractsWorkspace(workspace: string): {
	path: string;
	packageVersion: string;
} {
	const path = resolve(workspace);
	const packageJson = readPackageJson(path);
	if (packageJson.name !== NITRO_CONTRACTS_PACKAGE) {
		throw new Error(
			`Expected ${NITRO_CONTRACTS_PACKAGE} in ${resolve(path, "package.json")}, ` +
				`found ${JSON.stringify(packageJson.name)}`,
		);
	}
	if (typeof packageJson.version !== "string") {
		throw new Error(`Nitro contracts package version must be a semantic version string: ${path}`);
	}
	const versionMatch = /^(\d+)\.(\d+)\.(\d+)(?:[-+].+)?$/.exec(packageJson.version);
	if (!versionMatch) {
		throw new Error(`Unsupported Nitro contracts package version ${packageJson.version}`);
	}
	if (Number(versionMatch[1]) !== 3) {
		throw new Error(
			`Nitro contracts ${packageJson.version} is not supported for new builds; expected a 3.x checkout`,
		);
	}
	if (typeof packageJson.scripts?.["build"] !== "string") {
		throw new Error(`Nitro contracts workspace does not define the required build script: ${path}`);
	}
	if (typeof packageJson.scripts?.["build:all"] !== "string") {
		throw new Error(
			`Nitro contracts workspace does not define the required build:all script: ${path}`,
		);
	}
	assertRequiredPath(path, "yarn.lock");
	assertRequiredPath(path, "scripts/config.example.ts");
	assertRequiredPath(path, "src/precompiles/ArbGasInfo.sol");
	assertRequiredPath(path, "lib/forge-std/src/Test.sol");
	return { path, packageVersion: packageJson.version };
}

function workspaceSource(workspace: string): NitroContractsSource {
	const validated = validateNitroContractsWorkspace(workspace);
	return {
		kind: "workspace",
		family: NITRO_CONTRACTS_FAMILY,
		path: validated.path,
		packageVersion: validated.packageVersion,
		buildContext: validated.path,
		identity: `workspace:${validated.path}`,
	};
}

export function resolveNitroContractsSource(
	projectRoot: string,
	env: NodeJS.ProcessEnv = process.env,
): NitroContractsSource {
	const configured = env["NITRO_CONTRACTS_LOCAL_DIR"]?.trim();
	if (configured) {
		return workspaceSource(configured);
	}

	const sibling = resolve(projectRoot, "..", "nitro-contracts");
	if (existsSync(sibling)) {
		return workspaceSource(sibling);
	}

	return {
		kind: "release",
		family: NITRO_CONTRACTS_FAMILY,
		release: DEFAULT_NITRO_CONTRACTS_RELEASE,
		commit: DEFAULT_NITRO_CONTRACTS_COMMIT,
		buildContext: `${NITRO_CONTRACTS_REPOSITORY}#${DEFAULT_NITRO_CONTRACTS_COMMIT}`,
		identity: `release:${DEFAULT_NITRO_CONTRACTS_RELEASE}@${DEFAULT_NITRO_CONTRACTS_COMMIT}`,
	};
}

export interface DeployerImageSpec {
	image: string;
	dockerfile: string;
	buildContext: string;
	reuseImage: boolean;
}

export function resolveDeployerImageSpec(source: NitroContractsSource): DeployerImageSpec {
	const identityHash = createHash("sha256").update(source.identity).digest("hex").slice(0, 12);
	const label = source.kind === "release" ? source.release : source.packageVersion;
	return {
		image: `nitro-testnode-contract-deployer:${label}-${identityHash}`,
		dockerfile: "docker/contract-deployer.Dockerfile",
		buildContext: source.buildContext,
		reuseImage: source.kind === "release",
	};
}
