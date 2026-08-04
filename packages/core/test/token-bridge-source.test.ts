import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_TOKEN_BRIDGE_COMMIT,
	prepareTokenBridgeSource,
	resolveTokenBridgeSource,
	validateTokenBridgeWorkspace,
} from "../src/token-bridge-source.js";

const tempDirs: string[] = [];

function makeProject(): { root: string; parent: string } {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "token-bridge-source-test-"));
	tempDirs.push(parent);
	const root = path.join(parent, "arbitrum-testnode");
	fs.mkdirSync(root);
	return { root, parent };
}

function makeWorkspace(dir: string, options: { dependencies?: boolean; version?: string } = {}) {
	fs.mkdirSync(path.join(dir, "scripts/deployment"), { recursive: true });
	fs.mkdirSync(path.join(dir, "lib/forge-std/src"), { recursive: true });
	fs.mkdirSync(path.join(dir, "lib/nitro-contracts/src"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({
			name: "@arbitrum/token-bridge-contracts",
			version: options.version ?? "1.2.5",
			scripts: { build: "hardhat compile" },
		}),
	);
	fs.writeFileSync(path.join(dir, "yarn.lock"), "");
	fs.writeFileSync(path.join(dir, "scripts/deployment/deployTokenBridgeCreator.ts"), "");
	if (options.dependencies ?? true) {
		fs.mkdirSync(path.join(dir, "node_modules/ts-node/dist"), { recursive: true });
		fs.writeFileSync(path.join(dir, "node_modules/ts-node/dist/bin.js"), "");
	}
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("resolveTokenBridgeSource", () => {
	it("prefers the explicit prepared workspace", () => {
		const { root, parent } = makeProject();
		makeWorkspace(path.join(parent, "token-bridge-contracts"));
		const explicit = makeWorkspace(path.join(parent, "custom-token-bridge"));
		const source = resolveTokenBridgeSource(root, { TOKEN_BRIDGE_LOCAL_DIR: explicit });
		expect(source).toMatchObject({ kind: "workspace", path: explicit });
	});

	it("uses the prepared sibling checkout", () => {
		const { root, parent } = makeProject();
		const sibling = makeWorkspace(path.join(parent, "token-bridge-contracts"));
		expect(resolveTokenBridgeSource(root, {})).toMatchObject({
			kind: "workspace",
			path: sibling,
		});
	});

	it("falls back to the commit-keyed managed cache", () => {
		const { root } = makeProject();
		const source = resolveTokenBridgeSource(root, {});
		expect(source).toEqual({
			kind: "managed",
			path: path.join(
				root,
				".cache",
				"contract-sources",
				"token-bridge-contracts",
				DEFAULT_TOKEN_BRIDGE_COMMIT,
			),
			dockerContext: `https://github.com/OffchainLabs/token-bridge-contracts.git#${DEFAULT_TOKEN_BRIDGE_COMMIT}`,
			identity: `commit:${DEFAULT_TOKEN_BRIDGE_COMMIT}`,
		});
	});
});

describe("prepareTokenBridgeSource", () => {
	it("reuses a complete managed cache entry", () => {
		const { root } = makeProject();
		const source = resolveTokenBridgeSource(root, {});
		makeWorkspace(source.path);
		expect(prepareTokenBridgeSource(source)).toMatchObject({
			kind: "managed",
			path: source.path,
			packageVersion: "1.2.5",
		});
	});

	it("rejects caller-managed workspaces without installed dependencies", () => {
		const { parent } = makeProject();
		const workspace = makeWorkspace(path.join(parent, "incomplete"), { dependencies: false });
		expect(() => validateTokenBridgeWorkspace(workspace, { requireDependencies: true })).toThrow(
			/node_modules\/ts-node/,
		);
	});

	it("rejects unsupported package families", () => {
		const { parent } = makeProject();
		const workspace = makeWorkspace(path.join(parent, "future"), { version: "2.0.0" });
		expect(() => validateTokenBridgeWorkspace(workspace)).toThrow(/Unsupported/);
	});
});

describe("Token Bridge Docker sources", () => {
	const tokenbridge = fs.readFileSync(path.resolve("docker/tokenbridge.Dockerfile"), "utf8");
	const testnode = fs.readFileSync(path.resolve("docker/testnode.Dockerfile"), "utf8");
	const deployer = fs.readFileSync(path.resolve("docker/contract-deployer.Dockerfile"), "utf8");

	it("uses named contexts instead of fetching independent refs", () => {
		for (const contents of [tokenbridge, testnode]) {
			expect(contents).toContain("FROM scratch AS tokenbridge");
			expect(contents).toContain("COPY --from=tokenbridge . /workspace");
			expect(contents).not.toContain("github.com/OffchainLabs/token-bridge-contracts");
		}
	});

	it("does not embed an unused Token Bridge build in the Nitro deployer", () => {
		expect(deployer).not.toContain("token-bridge-builder");
		expect(deployer).not.toContain("token-bridge-contracts");
	});
});
