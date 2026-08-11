import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureContractDeployerImage } from "../src/init/chain-steps.js";
import {
	DEFAULT_NITRO_CONTRACTS_COMMIT,
	DEFAULT_NITRO_CONTRACTS_RELEASE,
	resolveDeployerImageSpec,
	resolveNitroContractsSource,
	validateNitroContractsWorkspace,
} from "../src/init/nitro-contracts-source.js";

const tempDirs: string[] = [];

function makeProject(): { root: string; parent: string } {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nitro-source-test-"));
	tempDirs.push(parent);
	const root = path.join(parent, "arbitrum-testnode");
	fs.mkdirSync(root);
	return { root, parent };
}

function makeWorkspace(
	dir: string,
	overrides: { name?: string; version?: string; scripts?: Record<string, string> } = {},
): string {
	fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
	fs.mkdirSync(path.join(dir, "src/precompiles"), { recursive: true });
	fs.mkdirSync(path.join(dir, "lib/forge-std/src"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({
			name: overrides.name ?? "@arbitrum/nitro-contracts",
			version: overrides.version ?? "3.2.0",
			scripts: overrides.scripts ?? { build: "hardhat compile", "build:all": "yarn build" },
		}),
	);
	fs.writeFileSync(path.join(dir, "yarn.lock"), "");
	fs.writeFileSync(path.join(dir, "scripts/config.example.ts"), "export default {};");
	fs.writeFileSync(path.join(dir, "src/precompiles/ArbGasInfo.sol"), "");
	fs.writeFileSync(path.join(dir, "lib/forge-std/src/Test.sol"), "");
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("resolveNitroContractsSource", () => {
	it("defaults to the pinned stable release", () => {
		const { root } = makeProject();
		const source = resolveNitroContractsSource(root, {});
		expect(source).toEqual({
			kind: "release",
			family: "v3.2",
			release: DEFAULT_NITRO_CONTRACTS_RELEASE,
			commit: DEFAULT_NITRO_CONTRACTS_COMMIT,
			buildContext: `https://github.com/OffchainLabs/nitro-contracts.git#${DEFAULT_NITRO_CONTRACTS_COMMIT}`,
			identity: `release:${DEFAULT_NITRO_CONTRACTS_RELEASE}@${DEFAULT_NITRO_CONTRACTS_COMMIT}`,
		});
	});

	it("prefers an explicit workspace over the sibling checkout", () => {
		const { root, parent } = makeProject();
		makeWorkspace(path.join(parent, "nitro-contracts"));
		const explicit = makeWorkspace(path.join(parent, "custom-nitro"), { version: "3.9.1" });
		const source = resolveNitroContractsSource(root, { NITRO_CONTRACTS_LOCAL_DIR: explicit });
		expect(source.kind).toBe("workspace");
		if (source.kind === "workspace") {
			expect(source.path).toBe(explicit);
			expect(source.packageVersion).toBe("3.9.1");
		}
	});

	it("uses a valid sibling checkout when no override is set", () => {
		const { root, parent } = makeProject();
		const sibling = makeWorkspace(path.join(parent, "nitro-contracts"));
		const source = resolveNitroContractsSource(root, {});
		expect(source.kind).toBe("workspace");
		if (source.kind === "workspace") {
			expect(source.path).toBe(sibling);
		}
	});

	it("does not silently ignore an invalid sibling checkout", () => {
		const { root, parent } = makeProject();
		fs.mkdirSync(path.join(parent, "nitro-contracts"));
		expect(() => resolveNitroContractsSource(root, {})).toThrow(/missing package.json/);
	});
});

describe("validateNitroContractsWorkspace", () => {
	it("rejects an unrelated package", () => {
		const { parent } = makeProject();
		const workspace = makeWorkspace(path.join(parent, "wrong"), { name: "not-nitro" });
		expect(() => validateNitroContractsWorkspace(workspace)).toThrow(/@arbitrum\/nitro-contracts/);
	});

	it("rejects legacy and unsupported future families", () => {
		const { parent } = makeProject();
		const legacy = makeWorkspace(path.join(parent, "legacy"), { version: "2.1.3" });
		const future = makeWorkspace(path.join(parent, "future"), { version: "4.0.0" });
		expect(() => validateNitroContractsWorkspace(legacy)).toThrow(/expected a 3.x checkout/);
		expect(() => validateNitroContractsWorkspace(future)).toThrow(/expected a 3.x checkout/);
	});

	it("rejects malformed versions and incomplete workspaces", () => {
		const { parent } = makeProject();
		const malformed = makeWorkspace(path.join(parent, "malformed"), { version: "main" });
		expect(() => validateNitroContractsWorkspace(malformed)).toThrow(/Unsupported/);

		const incomplete = makeWorkspace(path.join(parent, "incomplete"));
		fs.rmSync(path.join(incomplete, "scripts/config.example.ts"));
		expect(() => validateNitroContractsWorkspace(incomplete)).toThrow(/scripts\/config.example.ts/);
	});
});

describe("resolveDeployerImageSpec", () => {
	it("reuses an immutable release image", () => {
		const { root } = makeProject();
		const spec = resolveDeployerImageSpec(resolveNitroContractsSource(root, {}));
		expect(spec.image).toMatch(/^nitro-testnode-contract-deployer:v3\.2\.0-[a-f0-9]{12}$/);
		expect(spec.buildContext).toContain(DEFAULT_NITRO_CONTRACTS_COMMIT);
		expect(spec.reuseImage).toBe(true);
	});

	it("always rebuilds a workspace image so BuildKit sees content changes", () => {
		const { root, parent } = makeProject();
		const workspace = makeWorkspace(path.join(parent, "workspace"));
		const source = resolveNitroContractsSource(root, { NITRO_CONTRACTS_LOCAL_DIR: workspace });
		const spec = resolveDeployerImageSpec(source);
		expect(spec.buildContext).toBe(workspace);
		expect(spec.reuseImage).toBe(false);
	});

	it("builds a workspace image only once per init run", async () => {
		const { root, parent } = makeProject();
		const workspace = makeWorkspace(path.join(parent, "workspace"));
		const source = resolveNitroContractsSource(root, { NITRO_CONTRACTS_LOCAL_DIR: workspace });
		const spec = resolveDeployerImageSpec(source);
		const exec = vi.fn();
		const execOrThrow = vi.fn();
		const runtime = { projectRoot: root } as never;
		const commands = { exec: exec as never, execOrThrow: execOrThrow as never };

		await ensureContractDeployerImage(runtime, spec, false, commands);
		await ensureContractDeployerImage(runtime, spec, false, commands);

		expect(exec).not.toHaveBeenCalled();
		expect(execOrThrow).toHaveBeenCalledTimes(1);
	});
});

describe("contract deployer Dockerfile", () => {
	const contents = fs.readFileSync(path.resolve("docker/contract-deployer.Dockerfile"), "utf8");

	it("consumes the caller-provided named context", () => {
		expect(contents).toContain("FROM scratch AS nitrocontracts");
		expect(contents).toContain("COPY --from=nitrocontracts . /workspace/nitro-contracts");
	});

	it("contains no hidden Nitro ref or dynamic source selector", () => {
		expect(contents).not.toContain("NITRO_CONTRACTS_BRANCH");
		expect(contents).not.toContain("NITRO_CONTRACTS_SOURCE");
		expect(contents).not.toContain("github.com/OffchainLabs/nitro-contracts");
		expect(fs.existsSync(path.resolve("docker/contract-deployer-v2.1.Dockerfile"))).toBe(false);
	});
});
