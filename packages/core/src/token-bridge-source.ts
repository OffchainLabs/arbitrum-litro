import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { execOrThrow } from "./exec.js";

export const DEFAULT_TOKEN_BRIDGE_COMMIT = "5975d8f7360816341be7f94fd333ef240f4aec23";

const TOKEN_BRIDGE_REPOSITORY = "https://github.com/OffchainLabs/token-bridge-contracts.git";
const TOKEN_BRIDGE_PACKAGE = "@arbitrum/token-bridge-contracts";
const TOKEN_BRIDGE_CREATOR_SCRIPT = "scripts/deployment/deployTokenBridgeCreator.ts";
const TOKEN_BRIDGE_TS_NODE = "node_modules/ts-node/dist/bin.js";
const TOKEN_BRIDGE_SUBMODULE_PATHS = ["lib/forge-std/src", "lib/nitro-contracts/src"] as const;

export interface TokenBridgeSource {
	kind: "managed" | "workspace";
	path: string;
	dockerContext: string;
	identity: string;
	packageVersion?: string | undefined;
}

interface TokenBridgePackageJson {
	name?: unknown;
	version?: unknown;
	scripts?: Record<string, unknown> | undefined;
}

function readPackageJson(workspace: string): TokenBridgePackageJson {
	const path = resolve(workspace, "package.json");
	if (!existsSync(path)) {
		throw new Error(`Token Bridge contracts workspace is missing package.json: ${path}`);
	}
	try {
		return JSON.parse(readFileSync(path, "utf8")) as TokenBridgePackageJson;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to parse Token Bridge contracts package.json at ${path}: ${message}`);
	}
}

function assertPath(workspace: string, relativePath: string): void {
	const path = resolve(workspace, relativePath);
	if (!existsSync(path)) {
		throw new Error(`Token Bridge contracts workspace is missing ${relativePath}: ${path}`);
	}
}

export function validateTokenBridgeWorkspace(
	workspace: string,
	options: { requireDependencies?: boolean } = {},
): { path: string; packageVersion: string } {
	const path = resolve(workspace);
	const packageJson = readPackageJson(path);
	if (packageJson.name !== TOKEN_BRIDGE_PACKAGE) {
		throw new Error(
			`Expected ${TOKEN_BRIDGE_PACKAGE} in ${resolve(path, "package.json")}, found ${JSON.stringify(packageJson.name)}`,
		);
	}
	if (
		typeof packageJson.version !== "string" ||
		!/^1\.\d+\.\d+(?:[-+].+)?$/.test(packageJson.version)
	) {
		throw new Error(
			`Unsupported Token Bridge contracts package version ${String(packageJson.version)}`,
		);
	}
	if (typeof packageJson.scripts?.["build"] !== "string") {
		throw new Error(
			`Token Bridge contracts workspace does not define the required build script: ${path}`,
		);
	}
	assertPath(path, "yarn.lock");
	assertPath(path, TOKEN_BRIDGE_CREATOR_SCRIPT);
	for (const submodulePath of TOKEN_BRIDGE_SUBMODULE_PATHS) {
		assertPath(path, submodulePath);
	}
	if (options.requireDependencies) {
		assertPath(path, TOKEN_BRIDGE_TS_NODE);
	}
	return { path, packageVersion: packageJson.version };
}

function workspaceSource(workspace: string, dockerContext?: string): TokenBridgeSource {
	const validated = validateTokenBridgeWorkspace(workspace, { requireDependencies: true });
	return {
		kind: "workspace",
		path: validated.path,
		dockerContext: dockerContext?.trim() || validated.path,
		packageVersion: validated.packageVersion,
		identity: `workspace:${validated.path}`,
	};
}

export function resolveTokenBridgeSource(
	projectRoot: string,
	env: NodeJS.ProcessEnv = process.env,
): TokenBridgeSource {
	const configured = env["TOKEN_BRIDGE_LOCAL_DIR"]?.trim();
	if (configured) {
		return workspaceSource(configured, env["TOKEN_BRIDGE_DOCKER_CONTEXT"]);
	}

	const sibling = resolve(projectRoot, "..", "token-bridge-contracts");
	if (existsSync(sibling)) {
		return workspaceSource(sibling, env["TOKEN_BRIDGE_DOCKER_CONTEXT"]);
	}

	return {
		kind: "managed",
		path: resolve(
			projectRoot,
			".cache",
			"contract-sources",
			"token-bridge-contracts",
			DEFAULT_TOKEN_BRIDGE_COMMIT,
		),
		dockerContext: `${TOKEN_BRIDGE_REPOSITORY}#${DEFAULT_TOKEN_BRIDGE_COMMIT}`,
		identity: `commit:${DEFAULT_TOKEN_BRIDGE_COMMIT}`,
	};
}

function cloneManagedSource(destination: string): void {
	const temp = `${destination}.tmp-${process.pid}`;
	rmSync(temp, { recursive: true, force: true });
	mkdirSync(temp, { recursive: true });
	try {
		execOrThrow("git", ["init", "."], { cwd: temp });
		execOrThrow("git", ["remote", "add", "origin", TOKEN_BRIDGE_REPOSITORY], { cwd: temp });
		execOrThrow("git", ["fetch", "--depth", "1", "origin", DEFAULT_TOKEN_BRIDGE_COMMIT], {
			cwd: temp,
			timeout: 300_000,
		});
		execOrThrow("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: temp });
		execOrThrow("git", ["submodule", "update", "--init", "--recursive", "--depth", "1"], {
			cwd: temp,
			timeout: 300_000,
		});
		execOrThrow("yarn", ["install", "--frozen-lockfile"], { cwd: temp, timeout: 900_000 });
		execOrThrow("yarn", ["build"], { cwd: temp, timeout: 900_000 });
		validateTokenBridgeWorkspace(temp, { requireDependencies: true });
		mkdirSync(resolve(destination, ".."), { recursive: true });
		renameSync(temp, destination);
	} catch (error) {
		rmSync(temp, { recursive: true, force: true });
		throw error;
	}
}

export function prepareTokenBridgeSource(source: TokenBridgeSource): TokenBridgeSource {
	if (source.kind === "workspace") {
		validateTokenBridgeWorkspace(source.path, { requireDependencies: true });
		return source;
	}

	try {
		const validated = validateTokenBridgeWorkspace(source.path, { requireDependencies: true });
		return { ...source, packageVersion: validated.packageVersion };
	} catch {
		rmSync(source.path, { recursive: true, force: true });
		cloneManagedSource(source.path);
		const validated = validateTokenBridgeWorkspace(source.path, { requireDependencies: true });
		return { ...source, packageVersion: validated.packageVersion };
	}
}
