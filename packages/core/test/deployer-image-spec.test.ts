import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertNitroContractsLocalDir, resolveDeployerImageSpec } from "../src/init/chain-steps.js";

const ENV_KEYS = ["NITRO_CONTRACTS_BRANCH", "NITRO_CONTRACTS_LOCAL_DIR"] as const;

describe("resolveDeployerImageSpec", () => {
	const saved: Record<string, string | undefined> = {};
	const tempDirs: string[] = [];

	function makeLocalCheckout(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nitro-local-"));
		tempDirs.push(dir);
		fs.writeFileSync(path.join(dir, "package.json"), "{}");
		return dir;
	}

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = saved[key];
			}
		}
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("defaults to the pinned v3.2 :latest image with no overrides", () => {
		const spec = resolveDeployerImageSpec();
		expect(spec).toEqual({
			image: "nitro-testnode-contract-deployer:latest",
			dockerfile: "docker/contract-deployer.Dockerfile",
			buildArgs: [],
			buildContexts: [],
			skipInspectCache: false,
		});
	});

	it("selects the v2.1 image/dockerfile when isV21", () => {
		const spec = resolveDeployerImageSpec({ isV21: true });
		expect(spec.image).toBe("nitro-testnode-contract-deployer-v2.1:latest");
		expect(spec.dockerfile).toBe("docker/contract-deployer-v2.1.Dockerfile");
		expect(spec.skipInspectCache).toBe(false);
	});

	it("overrides the source with a branch/commit and forces a fresh build", () => {
		process.env["NITRO_CONTRACTS_BRANCH"] = "abc123";
		const spec = resolveDeployerImageSpec();
		expect(spec.image).toMatch(/^nitro-testnode-contract-deployer:nc-abc123-[a-f0-9]{12}$/);
		expect(spec.buildArgs).toEqual(["--build-arg", "NITRO_CONTRACTS_BRANCH=abc123"]);
		expect(spec.buildContexts).toEqual([]);
		expect(spec.skipInspectCache).toBe(true);
	});

	it("sanitizes branch names into a valid image tag component", () => {
		process.env["NITRO_CONTRACTS_BRANCH"] = "feature/My_Branch";
		const spec = resolveDeployerImageSpec();
		expect(spec.image).toMatch(
			/^nitro-testnode-contract-deployer:nc-feature-my_branch-[a-f0-9]{12}$/,
		);
		expect(spec.buildArgs).toEqual(["--build-arg", "NITRO_CONTRACTS_BRANCH=feature/My_Branch"]);
	});

	it("keeps refs with the same sanitized slug on distinct image tags", () => {
		const slash = resolveDeployerImageSpec({ nitroContractsBranch: "feature/foo" });
		const colon = resolveDeployerImageSpec({ nitroContractsBranch: "feature:foo" });
		expect(slash.image).not.toBe(colon.image);
	});

	it("prefers an explicit branch option over the environment fallback", () => {
		process.env["NITRO_CONTRACTS_BRANCH"] = "from-env";
		const spec = resolveDeployerImageSpec({ nitroContractsBranch: "from-cli" });
		expect(spec.buildArgs).toEqual(["--build-arg", "NITRO_CONTRACTS_BRANCH=from-cli"]);
	});

	it("keeps the branch override on the v2.1 image", () => {
		process.env["NITRO_CONTRACTS_BRANCH"] = "deadbeef";
		const spec = resolveDeployerImageSpec({ isV21: true });
		expect(spec.image).toMatch(/^nitro-testnode-contract-deployer-v2\.1:nc-deadbeef-[a-f0-9]{12}$/);
		expect(spec.dockerfile).toBe("docker/contract-deployer-v2.1.Dockerfile");
	});

	it("overrides the source with a local checkout via --build-context", () => {
		const dir = makeLocalCheckout();
		process.env["NITRO_CONTRACTS_LOCAL_DIR"] = dir;
		const spec = resolveDeployerImageSpec();
		expect(spec.image).toMatch(/^nitro-testnode-contract-deployer:local-.+-[a-f0-9]{12}$/);
		expect(spec.buildArgs).toEqual(["--build-arg", "NITRO_CONTRACTS_SOURCE=local"]);
		expect(spec.buildContexts).toEqual(["--build-context", `nitrocontracts=${dir}`]);
		expect(spec.skipInspectCache).toBe(true);
	});

	it("prefers the local checkout over a branch when both are set", () => {
		const dir = makeLocalCheckout();
		process.env["NITRO_CONTRACTS_LOCAL_DIR"] = dir;
		process.env["NITRO_CONTRACTS_BRANCH"] = "abc123";
		const spec = resolveDeployerImageSpec();
		expect(spec.image).toContain("nitro-testnode-contract-deployer:local-");
		expect(spec.buildContexts).toEqual(["--build-context", `nitrocontracts=${dir}`]);
	});

	it("treats empty override env vars as unset", () => {
		process.env["NITRO_CONTRACTS_BRANCH"] = "";
		process.env["NITRO_CONTRACTS_LOCAL_DIR"] = "";
		expect(resolveDeployerImageSpec().image).toBe("nitro-testnode-contract-deployer:latest");
	});
});

describe("assertNitroContractsLocalDir", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("passes for a directory containing package.json", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nitro-local-"));
		tempDirs.push(dir);
		fs.writeFileSync(path.join(dir, "package.json"), "{}");
		expect(() => assertNitroContractsLocalDir(dir)).not.toThrow();
	});

	it("throws an actionable error naming the env var when package.json is missing", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nitro-empty-"));
		tempDirs.push(dir);
		expect(() => assertNitroContractsLocalDir(dir)).toThrow(/NITRO_CONTRACTS_LOCAL_DIR/);
	});
});

describe.each([
	{
		dockerfile: "docker/contract-deployer.Dockerfile",
		pinnedRef: "cd4eb69e3c4cb87161b1433ad238902ea5c32ebd",
	},
	{
		dockerfile: "docker/contract-deployer-v2.1.Dockerfile",
		pinnedRef: "f9cd1aa4b5bba209211e8df9993e0eba89eaedda",
	},
])("$dockerfile source selection", ({ dockerfile, pinnedRef }) => {
	const contents = fs.readFileSync(path.resolve(dockerfile), "utf8");

	it("retains the pinned default ref", () => {
		expect(contents).toContain(`ARG NITRO_CONTRACTS_BRANCH=${pinnedRef}`);
	});

	it("quotes the caller-provided git ref", () => {
		expect(contents).toContain('git fetch --depth 1 origin "$NITRO_CONTRACTS_BRANCH"');
	});

	it("supports a named local build context", () => {
		expect(contents).toContain("FROM scratch AS nitrocontracts");
		expect(contents).toContain("COPY --from=nitrocontracts . /workspace/nitro-contracts");
		expect(contents).toContain("FROM nitro-src-${NITRO_CONTRACTS_SOURCE} AS nitro-src");
	});
});
