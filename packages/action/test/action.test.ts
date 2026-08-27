import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_NITRO_CONTRACTS_VERSION,
	DEFAULT_TESTNODE_IMAGE_REPOSITORY,
	buildActionTestnodeState,
	buildTestnodeImageRef,
	normalizeNitroContractsVersion,
	rebasedTestnodeImageRef,
	resolveVariant,
	testnodeDockerRunArgs,
} from "../src/lib.mjs";

describe("action metadata", () => {
	const action = readFileSync("action.yml", "utf-8");
	const inputs = action.slice(action.indexOf("inputs:"), action.indexOf("outputs:"));

	it("defaults to the latest bundle and resolves registry behavior from the base image ref", () => {
		expect(action).toContain('description: "Published bundle version; defaults to latest"');
		expect(action).toContain('default: "latest"');
		// Gating reads baseImageRef, not the booted ref: with nitro-image set the
		// booted ref is local, and the pull still has to act on the remote source.
		expect(action).toContain("startsWith(steps.resolve.outputs.base-image-ref, 'ghcr.io/')");
		expect(action).toContain("!startsWith(steps.resolve.outputs.base-image-ref, 'local/')");
	});

	it("does not expose a second variant-selection input", () => {
		expect(inputs).not.toMatch(/^ {2}variant:\s*$/m);
		expect(action).not.toContain("INPUT_VARIANT");
	});

	it("rebases onto a supplied nitro image only when nitro-image is set", () => {
		expect(inputs).toMatch(/^ {2}nitro-image:\s*$/m);
		expect(action).toContain("if: ${{ steps.resolve.outputs.nitro-image != '' }}");
		expect(action).toContain("packages/action/src/rebase.mjs");
	});

	it("re-exports the outputs the CI validation steps consume", () => {
		// A composite action only surfaces what its outputs block re-exports;
		// a step output alone expands to "" in consumers.
		for (const output of ["base-image-ref", "image-ref", "container-name"]) {
			expect(action).toContain(`value: \${{ steps.resolve.outputs.${output} }}`);
		}
	});

	const steps = action.split(/\n {4}- /);
	const stepFor = (script: string) => {
		const step = steps.find((s) => s.includes(`packages/action/src/${script}`));
		expect(step, `no step runs ${script}`).toBeDefined();
		return step ?? "";
	};
	const inputKeys = (script: string) =>
		[...new Set(stepFor(script).match(/INPUT_[A-Z_]+(?=:)/g) ?? [])].sort();

	it("gives every state-resolving step the same INPUT_* env", () => {
		// resolve and run each rebuild testnode state from their own env block; a
		// key in one but not the other silently resolves different state (wrong
		// variant, wrong image) at that step.
		const resolveKeys = inputKeys("resolve.mjs");
		expect(resolveKeys).toContain("INPUT_NITRO_IMAGE");
		expect(resolveKeys).toContain("INPUT_TIMEBOOST_ENABLED");
		// The run step may carry boot-only extras on top of the shared set.
		const bootOnly = ["INPUT_NETWORK_CONFIG_PATH", "INPUT_STARTUP_TIMEOUT_SECONDS"];
		expect(inputKeys("run.mjs")).toEqual([...resolveKeys, ...bootOnly].sort());
	});

	it("builds the rebase from resolve's refs rather than re-deriving state", () => {
		// Re-deriving state here is what let resolve and the boot step disagree on
		// variant once already; consuming the resolved refs makes that impossible.
		const step = stepFor("rebase.mjs");
		expect(inputKeys("rebase.mjs")).toEqual([]);
		for (const output of ["base-image-ref", "image-ref", "nitro-image"]) {
			expect(step).toContain(`\${{ steps.resolve.outputs.${output} }}`);
		}
	});

	it("garbage-collects rebased images in one place, not in shell", () => {
		// GC lives in pruneStaleRebasedImages so the label and age window have a
		// single definition; a YAML copy drifts silently.
		expect(action).not.toContain("docker image prune");
	});

	it("only reads resolve step outputs that resolve.mjs actually writes", () => {
		// An unwritten output expands to "" instead of failing, so a rename here
		// is silent.
		const resolve = readFileSync("packages/action/src/resolve.mjs", "utf-8");
		const written = new Set(
			[...resolve.matchAll(/writeOutput\("([^"]+)"/g)].map((match) => match[1]),
		);
		const referenced = new Set(
			[...action.matchAll(/steps\.resolve\.outputs\.([a-z0-9-]+)/g)].map((match) => match[1]),
		);
		expect(referenced.size).toBeGreaterThan(0);
		expect([...referenced].filter((name) => !written.has(name))).toEqual([]);
	});
});

describe("bake action metadata", () => {
	const action = readFileSync("bake/action.yml", "utf-8");

	it("defaults to the latest published bundle", () => {
		expect(action).toContain("bundle-version:");
		expect(action).toContain('default: "latest"');
		expect(action).toContain("BASE_IMAGE_VERSION: ${{ inputs.bundle-version }}");
		expect(action).toContain('node apps/cli/dist/index.js bake "${args[@]}"');
	});

	it("defaults the bundle repository to the public one, so no token is needed", () => {
		expect(action).toContain(`default: "${DEFAULT_TESTNODE_IMAGE_REPOSITORY}"`);
	});

	it("never rebuilds contract sources in the consumer bake", () => {
		expect(action).not.toContain("node apps/cli/dist/index.js init");
		expect(action).not.toContain("git fetch");
		expect(action).not.toContain("yarn build");
		expect(action).not.toContain("token-bridge-ref");
		expect(action).not.toContain("nitro-contracts-ref");
	});

	it("only authenticates GHCR pulls when a token is supplied", () => {
		expect(action).toContain("inputs.github-token != ''");
	});
});

describe("published bundle metadata", () => {
	const dockerfile = readFileSync("docker/testnode.Dockerfile", "utf-8");
	const entrypoint = readFileSync("docker/testnode-entrypoint.sh", "utf-8");
	const workflow = readFileSync(".github/workflows/release-testnode-image.yml", "utf-8");

	it("records exact contract provenance and bundle identity", () => {
		expect(dockerfile).toContain("io.arbitrum.testnode.bundle.version");
		expect(dockerfile).toContain("io.arbitrum.testnode.nitro-contracts.commit");
		expect(dockerfile).toContain("io.arbitrum.testnode.token-bridge.commit");
	});

	it("persists Anvil state for derived bundle commits", () => {
		expect(entrypoint).toContain('--state "$DATA_ROOT/anvil-state/state.json"');
		expect(entrypoint).toContain("--state-interval 1");
	});

	it("publishes latest aliases only after every release image succeeds", () => {
		// Scoped to the job: the arm64 job carries a `needs:` line this would
		// otherwise match, so an unscoped assertion passes even with the alias job
		// depending on nothing.
		const job = workflow.slice(workflow.indexOf("  publish-latest-bundle:"));
		expect(job).toContain("needs: [resolve-publish-matrix, publish-testnode-image");
		expect(job).toContain("node scripts/ci/publish-latest-aliases.mjs");
	});

	it("aliases with crane so the alias and its version tag share a digest", () => {
		// `imagetools create` would re-wrap the source, giving the alias a different
		// digest than the tag it names and rebuilding the index rather than copying it.
		const aliases = readFileSync("scripts/ci/publish-latest-aliases.mjs", "utf-8");
		expect(aliases).toContain('execFileSync("crane", ["copy"');
		expect(aliases).not.toMatch(/^\s*execFileSync\("docker"/m);
	});

	it("publishes to GHCR and nowhere else", () => {
		// A second registry lets tag shapes, aliases and digests disagree about what
		// a version means.
		const aliases = readFileSync("scripts/ci/publish-latest-aliases.mjs", "utf-8");
		const refs = readFileSync("scripts/ci/resolve-publish-refs.mjs", "utf-8");
		for (const source of [workflow, aliases, refs]) {
			expect(source).not.toMatch(/dockerhub|docker\.io|DOCKERHUB/i);
		}
		expect(workflow).toContain("registry: ghcr.io");
	});

	it("derives the published repository from the constant consumers resolve", () => {
		// A rename that moved the default but not the publish target would land
		// releases under a name nothing pulls.
		const aliases = readFileSync("scripts/ci/publish-latest-aliases.mjs", "utf-8");
		const refs = readFileSync("scripts/ci/resolve-publish-refs.mjs", "utf-8");
		for (const source of [aliases, refs]) {
			expect(source).toContain("DEFAULT_TESTNODE_IMAGE_REPOSITORY");
		}
		expect(refs).toContain("buildTestnodeImageRef");
	});

	it("links the published package to this repository", () => {
		// Without image.source the package starts orphaned and this repository's
		// workflows lose access.
		expect(dockerfile).toContain("org.opencontainers.image.source");
		expect(workflow).toContain("IMAGE_SOURCE=");
	});

	it("takes every external contracts pin from external-pins.ts", () => {
		// A pasted commit is undetectable once an image ships: its labels would
		// describe contracts it does not contain.
		const pins = readFileSync("packages/core/src/external-pins.ts", "utf-8");
		const commits = [...pins.matchAll(/"([0-9a-f]{40})"/g)].map((match) => match[1]);
		expect(commits.length).toBeGreaterThan(0);

		for (const name of ["release-testnode-image.yml", "test-action.yml"]) {
			const source = readFileSync(`.github/workflows/${name}`, "utf-8");
			expect(source).toContain("scripts/ci/resolve-external-pins.ts");
			expect(source).not.toMatch(/[0-9a-f]{40}/);
			expect(source).not.toMatch(/github\.com\/OffchainLabs\/(token-bridge|nitro)-contracts/);
		}
		// The Dockerfile cannot compute a default, so the args stay bare rather than
		// carrying a copy that outlives the real pin.
		for (const arg of ["NITRO_CONTRACTS_COMMIT", "TOKENBRIDGE_COMMIT"]) {
			expect(dockerfile).toContain(`ARG ${arg}\n`);
		}
		expect(dockerfile).not.toMatch(/ARG [A-Z_]+=[0-9a-f]{40}/);
	});
});

describe("multi-arch bundles", () => {
	const workflow = readFileSync(".github/workflows/release-testnode-image.yml", "utf-8");
	const testAction = readFileSync(".github/workflows/test-action.yml", "utf-8");
	const verify = readFileSync(".github/workflows/verify-published-image.yml", "utf-8");

	it("builds arm64 on a native runner rather than under emulation", () => {
		// The token-bridge-contracts stage is per-architecture (the image copies its
		// `node` binary out) and exceeds the job budget under QEMU.
		expect(workflow).toContain("runs-on: ubuntu-24.04-arm");
		expect(workflow).not.toContain("setup-qemu-action");
		expect(workflow).not.toContain("linux/amd64,linux/arm64");
	});

	it("bakes one snapshot into both architectures", () => {
		// Chain state is architecture-neutral, so a second `init` would only risk the
		// two images under one tag disagreeing about deployed contract addresses.
		expect(workflow.match(/pnpm dev init/g)).toHaveLength(1);
		expect(workflow).toContain("actions/upload-artifact@v4");
		expect(workflow).toContain("actions/download-artifact@v4");
	});

	it("scopes the build cache per architecture", () => {
		// The cached layers hold an arch-specific `node`, so unscoped the two jobs
		// evict each other every run.
		expect(workflow).toContain("cache-to: type=gha,mode=max,scope=amd64");
		expect(workflow).toContain("cache-to: type=gha,mode=max,scope=arm64");
		expect(workflow).not.toMatch(/cache-(from|to): type=gha(,mode=max)?$/m);
	});

	it("gives the arm64 manifest no tag of its own", () => {
		// An `-arm64` tag would leave a pinnable half of a release in the package
		// listing; by digest, only the merge ever names it.
		expect(workflow).toContain("push-by-digest=true");
	});

	it("merges into the published tag and proves both platforms landed", () => {
		// `imagetools create` succeeds on a single source, so a merge that lost the
		// amd64 half publishes silently and crane copies it into the aliases.
		expect(workflow).toContain("docker buildx imagetools create --tag");
		expect(workflow).toContain("node scripts/ci/assert-image-platforms.mjs");
	});

	it("resolves both architectures' refs through one helper", () => {
		// Each job resolves its own ref; computing it the same way is the only thing
		// keeping a row's two halves under one tag.
		expect(workflow.match(/node scripts\/ci\/resolve-publish-refs\.mjs/g)).toHaveLength(2);
	});

	it("aliases only after the arm64 manifest is merged in", () => {
		// crane copies the digest a tag holds when it runs, so aliasing earlier would
		// pin the alias to the amd64-only manifest the tag briefly holds.
		expect(workflow).toContain(
			"needs: [resolve-publish-matrix, publish-testnode-image, publish-testnode-image-arm64]",
		);
	});

	it("boots arm64 in CI and against the published image", () => {
		// Publishing an arm64 manifest is not evidence it runs, and a runner with
		// binfmt would pass while emulating amd64 -- so both assert what booted.
		expect(testAction).toContain("runner: ubuntu-24.04-arm");
		expect(verify).toContain("runner: ubuntu-24.04-arm");
		expect(testAction).toContain("{{.Architecture}}");
		expect(verify).toContain("{{.Architecture}}");
	});
});

describe("resolveVariant", () => {
	it("uses l2 when l3 is disabled", () => {
		expect(resolveVariant({ l3Enabled: "false" })).toBe("l2");
	});

	it("uses l3-eth when l3 is enabled without a fee token", () => {
		expect(resolveVariant({ l3Enabled: "true" })).toBe("l3-eth");
	});

	it("uses the L2 timeboost variant when timeboost is enabled", () => {
		expect(resolveVariant({ l3Enabled: "true", timeboostEnabled: "true" })).toBe("l2-timeboost");
	});

	it("uses the custom gas token variants when decimals are provided", () => {
		expect(resolveVariant({ feeTokenDecimals: "16", l3Enabled: "true" })).toBe("l3-custom-16");
		expect(resolveVariant({ feeTokenDecimals: "18", l3Enabled: "true" })).toBe("l3-custom-18");
		expect(resolveVariant({ feeTokenDecimals: "20", l3Enabled: "true" })).toBe("l3-custom-20");
	});

	it("rejects custom fee token decimals when l3 is disabled", () => {
		expect(() => resolveVariant({ feeTokenDecimals: "18", l3Enabled: "false" })).toThrow(
			"fee-token-decimals requires L3 to be enabled",
		);
	});

	it("rejects custom fee token decimals when timeboost is enabled", () => {
		expect(() =>
			resolveVariant({ feeTokenDecimals: "18", l3Enabled: "true", timeboostEnabled: "true" }),
		).toThrow("fee-token-decimals is not supported with timeboost-enabled");
	});
});

describe("buildTestnodeImageRef", () => {
	it("uses the default repository when none is provided", () => {
		expect(
			buildTestnodeImageRef({ contractsVersion: "v3.2", variant: "l3-eth", version: "v1.2.3" }),
		).toBe(`${DEFAULT_TESTNODE_IMAGE_REPOSITORY}:v1.2.3-nc3.2-l3-eth`);
	});

	it("resolves latest without coupling the consumer to a contracts family", () => {
		expect(
			buildTestnodeImageRef({ contractsVersion: "v3.2", variant: "l3-eth", version: "latest" }),
		).toBe(`${DEFAULT_TESTNODE_IMAGE_REPOSITORY}:latest-l3-eth`);
	});
});

describe("buildActionTestnodeState", () => {
	it("builds stable paths and RPC URLs for l3 variants", () => {
		const state = buildActionTestnodeState({
			contractsVersion: "v3.2",
			l3Enabled: "true",
			runnerTemp: "/tmp/runner",
			version: "v1.2.3",
		});

		expect(state.variant).toBe("l3-eth");
		expect(state.contractsVersion).toBe("v3.2");
		expect(state.imageRef).toContain("nc3.2");
		expect(state.timeboostEnabled).toBe(false);
		expect(state.outputDir).toBe("/tmp/runner/arbitrum-testnode/v1.2.3/l3-eth");
		expect(state.paths.localNetwork).toBe(
			"/tmp/runner/arbitrum-testnode/v1.2.3/l3-eth/config/localNetwork.json",
		);
		expect(state.rpcUrls.l1).toBe("http://127.0.0.1:8545");
		expect(state.rpcUrls.l2).toBe("http://127.0.0.1:8547");
		expect(state.rpcUrls.l3).toBe("http://127.0.0.1:3347");
	});

	it("omits l3-specific outputs for l2", () => {
		const state = buildActionTestnodeState({
			contractsVersion: "v3.2",
			l3Enabled: "false",
			runnerTemp: "/tmp/runner",
			version: "v1.2.3",
		});

		expect(state.variant).toBe("l2");
		expect(state.contractsVersion).toBe("v3.2");
		expect(state.imageRef).toContain("nc3.2");
		expect(state.paths.l2BridgeUiConfig).toBe("");
		expect(state.paths.l2l3Network).toBe("");
		expect(state.rpcUrls.l3).toBe("");
	});

	it("resolves a relative output dir against the workspace", () => {
		const state = buildActionTestnodeState({
			contractsVersion: "v3.2",
			l3Enabled: "true",
			outputDir: "./shadow-testnode-output",
			version: "v1.2.3",
			workspace: "/workspace/sdk-shadow",
		});

		expect(state.outputDir).toBe("/workspace/sdk-shadow/shadow-testnode-output");
		expect(state.configDir).toBe("/workspace/sdk-shadow/shadow-testnode-output/config");
	});

	it("passes the Timeboost flag into docker run args when enabled", () => {
		const state = buildActionTestnodeState({
			contractsVersion: "v3.2",
			l3Enabled: "true",
			runnerTemp: "/tmp/runner",
			timeboostEnabled: "true",
			version: "v1.2.3",
		});

		expect(state.variant).toBe("l2-timeboost");
		expect(state.imageRef).toBe(`${DEFAULT_TESTNODE_IMAGE_REPOSITORY}:v1.2.3-nc3.2-l2-timeboost`);
		expect(state.rpcUrls.l3).toBe("");
		expect(state.timeboostEnabled).toBe(true);
		const args = testnodeDockerRunArgs(state);
		expect(args).toEqual(
			expect.arrayContaining([
				"TESTNODE_TIMEBOOST=true",
				"TESTNODE_TIMEBOOST_REDIS_URL",
				"TESTNODE_TIMEBOOST_AUCTION_CONTRACT_ADDRESS",
			]),
		);
		expect(args).not.toContain("redis://timeboost-redis:6379");
		expect(args).not.toContain("redis:7-alpine");
	});

	it("bypasses variant/version image resolution when an image-ref is given", () => {
		const state = buildActionTestnodeState({
			imageRef: "ghcr.io/acme/testnode:custom",
			l3Enabled: "false",
			runnerTemp: "/tmp/runner",
		});

		expect(state.imageRef).toBe("ghcr.io/acme/testnode:custom");
		expect(state.variant).toBe("l2");
		expect(state.rpcUrls.l3).toBe("");
		expect(state.outputDir).toBe("/tmp/runner/arbitrum-testnode/custom/l2");
	});

	it("uses the existing l3-enabled option with an image-ref for L3 ports", () => {
		const state = buildActionTestnodeState({
			imageRef: "ghcr.io/acme/testnode:custom-l3",
			l3Enabled: "true",
			runnerTemp: "/tmp/runner",
		});

		expect(state.imageRef).toBe("ghcr.io/acme/testnode:custom-l3");
		expect(state.variant).toBe("l3-eth");
		expect(state.rpcUrls.l3).toBe("http://127.0.0.1:3347");
	});

	it("keeps fee-token and Timeboost variant resolution with an image-ref", () => {
		const customFee = buildActionTestnodeState({
			feeTokenDecimals: "18",
			imageRef: "ghcr.io/acme/testnode:custom-fee",
			l3Enabled: "true",
			runnerTemp: "/tmp/runner",
		});
		const timeboost = buildActionTestnodeState({
			imageRef: "ghcr.io/acme/testnode:timeboost",
			l3Enabled: "false",
			runnerTemp: "/tmp/runner",
			timeboostEnabled: "true",
		});

		expect(customFee.variant).toBe("l3-custom-18");
		expect(customFee.imageRef).toBe("ghcr.io/acme/testnode:custom-fee");
		expect(timeboost.variant).toBe("l2-timeboost");
		expect(timeboost.imageRef).toBe("ghcr.io/acme/testnode:timeboost");
	});

	it("boots a rebased local image while keeping the resolved image as the pull source", () => {
		const state = buildActionTestnodeState({
			contractsVersion: "v3.2",
			l3Enabled: "true",
			nitroImage: "nitro-node-dev:latest",
			runnerTemp: "/tmp/runner",
			version: "v1.2.3",
		});

		expect(state.baseImageRef).toBe(`${DEFAULT_TESTNODE_IMAGE_REPOSITORY}:v1.2.3-nc3.2-l3-eth`);
		expect(state.imageRef).toBe(
			rebasedTestnodeImageRef("l3-eth", state.baseImageRef, "nitro-node-dev:latest"),
		);
		expect(state.nitroImage).toBe("nitro-node-dev:latest");
		// Only the booted ref is local. The pull and login conditions key off
		// baseImageRef, which stays the remote ref they need to act on.
		expect(state.imageRef.startsWith("local/")).toBe(true);
		expect(state.baseImageRef.startsWith("local/")).toBe(false);
		expect(testnodeDockerRunArgs(state)).toContain(state.imageRef);
	});

	it("rebases an explicit image-ref onto the nitro image", () => {
		const state = buildActionTestnodeState({
			imageRef: "ghcr.io/acme/testnode:governance",
			l3Enabled: "false",
			nitroImage: "nitro-node-dev:latest",
			runnerTemp: "/tmp/runner",
		});

		expect(state.baseImageRef).toBe("ghcr.io/acme/testnode:governance");
		expect(state.imageRef).toBe(
			rebasedTestnodeImageRef("l2", "ghcr.io/acme/testnode:governance", "nitro-node-dev:latest"),
		);
	});

	it("leaves the booted ref untouched when no nitro image is given", () => {
		const state = buildActionTestnodeState({
			l3Enabled: "false",
			nitroImage: "  ",
			runnerTemp: "/tmp/runner",
			version: "v1.2.3",
		});

		expect(state.nitroImage).toBe("");
		expect(state.imageRef).toBe(state.baseImageRef);
	});

	it("uses the latest bundle when version and image-ref are omitted", () => {
		const state = buildActionTestnodeState({
			l3Enabled: "false",
			runnerTemp: "/tmp/runner",
		});
		expect(state.imageRef).toBe(`${DEFAULT_TESTNODE_IMAGE_REPOSITORY}:latest-l2`);
	});

	it("defaults to v3.2 when contractsVersion is not provided", () => {
		const state = buildActionTestnodeState({
			l3Enabled: "true",
			runnerTemp: "/tmp/runner",
			version: "v1.2.3",
		});

		expect(state.contractsVersion).toBe(DEFAULT_NITRO_CONTRACTS_VERSION);
		expect(state.imageRef).toContain("nc3.2");
	});

	it("rejects invalid contracts versions", () => {
		expect(() => normalizeNitroContractsVersion("v9.9")).toThrow(
			"nitro-contracts-version must be one of: v2.1, v3.2",
		);
	});
});

describe("resolve.mjs", () => {
	// Executes the real entrypoint: the composite action's login/pull/rebase
	// gating reads these outputs, and a state option missing from resolve.mjs
	// (but present in rebase.mjs/run.mjs) makes the steps disagree on variant
	// and image — exactly what happened with timeboost-enabled.
	const runResolve = (env: Record<string, string>) => {
		const dir = mkdtempSync(join(tmpdir(), "resolve-outputs-"));
		const outputFile = join(dir, "output");
		execFileSync(process.execPath, ["packages/action/src/resolve.mjs"], {
			env: {
				...process.env,
				GITHUB_OUTPUT: outputFile,
				GITHUB_WORKSPACE: dir,
				RUNNER_TEMP: dir,
				...env,
			},
		});
		return Object.fromEntries(
			readFileSync(outputFile, "utf-8")
				.trim()
				.split("\n")
				.map((line) => {
					const eq = line.indexOf("=");
					return [line.slice(0, eq), line.slice(eq + 1)];
				}),
		);
	};

	it("resolves the timeboost variant so pull/rebase gating sees the right refs", () => {
		const outputs = runResolve({
			INPUT_TIMEBOOST_ENABLED: "true",
			INPUT_VERSION: "v1.2.3",
		});

		expect(outputs["variant"]).toBe("l2-timeboost");
		expect(outputs["base-image-ref"]).toBe(
			`${DEFAULT_TESTNODE_IMAGE_REPOSITORY}:v1.2.3-nc3.2-l2-timeboost`,
		);
		expect(outputs["image-ref"]).toBe(outputs["base-image-ref"]);
	});

	it("emits an empty nitro-image for blank input so the rebase step is skipped", () => {
		const outputs = runResolve({
			INPUT_NITRO_IMAGE: "  ",
			INPUT_VERSION: "v1.2.3",
		});

		expect(outputs["nitro-image"]).toBe("");
		expect(outputs["image-ref"]).toBe(outputs["base-image-ref"]);
	});
});
