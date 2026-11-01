import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_FAST_FEED_API_KEY,
	DEFAULT_TESTNODE_IMAGE_REPOSITORY,
	START_CONTAINER_LABEL,
	buildStartTestnodeState,
	findRebaseDockerfile,
	hasVariantSnapshot,
	pruneStaleRebasedImages,
	rebaseTestnodeImage,
	rebasedTestnodeImageRef,
	resolvePublishMatrix,
	resolveVariantSnapshot,
	selectStartContainer,
	snapshotIdForContractsVersion,
	testnodeDockerRunArgs,
	testnodeRebaseBuildArgs,
	toStartContainer,
} from "../src/index.js";

describe("hasVariantSnapshot", () => {
	it("is true for every variant at the default contracts version (v3.2)", () => {
		expect(hasVariantSnapshot("l2", "v3.2")).toBe(true);
		expect(hasVariantSnapshot("l3-eth", "v3.2")).toBe(true);
		expect(hasVariantSnapshot("l3-custom-16", "v3.2")).toBe(true);
		expect(hasVariantSnapshot("l3-custom-18", "v3.2")).toBe(true);
	});

	it("is true only for variants with a declared bundle at v2.1", () => {
		expect(hasVariantSnapshot("l3-custom-18", "v2.1")).toBe(true);
		expect(hasVariantSnapshot("l3-custom-6", "v2.1")).toBe(true);
	});

	it("is false for variants with no bundle at a non-default version", () => {
		expect(hasVariantSnapshot("l2", "v2.1")).toBe(false);
		expect(hasVariantSnapshot("l3-eth", "v2.1")).toBe(false);
		expect(hasVariantSnapshot("l3-custom-16", "v2.1")).toBe(false);
		expect(hasVariantSnapshot("l3-custom-20", "v2.1")).toBe(false);
	});

	it("is false for an unknown variant", () => {
		expect(hasVariantSnapshot("nope", "v3.2")).toBe(false);
	});
});

describe("resolveVariantSnapshot", () => {
	it("returns the base bundle for the default contracts version (v3.2)", () => {
		expect(resolveVariantSnapshot("l3-custom-18", "v3.2")).toEqual({
			snapshotId: "l3-custom-18",
			snapshotReleaseTag: "l3-custom-18",
		});
		expect(resolveVariantSnapshot("l2", "v3.2")).toEqual({
			snapshotId: "l2",
			snapshotReleaseTag: "v0.1.6",
		});
	});

	it("returns the per-version bundle for v2.1 custom-gas variants", () => {
		expect(resolveVariantSnapshot("l3-custom-18", "v2.1")).toEqual({
			snapshotId: "l3-custom-18-v2.1",
			snapshotReleaseTag: "l3-custom-18-v2.1",
		});
		expect(resolveVariantSnapshot("l3-custom-6", "v2.1")).toEqual({
			snapshotId: "l3-custom-6-v2.1",
			snapshotReleaseTag: "l3-custom-6-v2.1",
		});
	});

	it("throws on an unknown variant", () => {
		expect(() => resolveVariantSnapshot("nope", "v3.2")).toThrow(/Unknown variant/);
	});
});

describe("buildStartTestnodeState", () => {
	it("defaults to the local L3 variant and cwd-scoped output dir", () => {
		const state = buildStartTestnodeState({
			cwd: "/workspace/project",
			l3Enabled: true,
			version: "v1.2.3",
		});

		expect(state.variant).toBe("l3-eth");
		expect(state.outputDir).toBe("/workspace/project/.arbitrum-testnode/v1.2.3/l3-eth");
		expect(state.configDir).toBe("/workspace/project/.arbitrum-testnode/v1.2.3/l3-eth/config");
		expect(state.rpcUrls.l1).toBe("http://127.0.0.1:8545");
		expect(state.rpcUrls.l2).toBe("http://127.0.0.1:8547");
		expect(state.rpcUrls.l3).toBe("http://127.0.0.1:3347");
	});

	it("supports the local L2-only variant", () => {
		const state = buildStartTestnodeState({
			cwd: "/workspace/project",
			l3Enabled: false,
			version: "v1.2.3",
		});

		expect(state.variant).toBe("l2");
		expect(state.rpcUrls.l3).toBe("");
		expect(state.paths.l2BridgeUiConfig).toBe("");
		expect(state.paths.l2l3Network).toBe("");
	});

	it("boots a full image-ref without changing variant resolution", () => {
		const state = buildStartTestnodeState({
			cwd: "/workspace/project",
			imageRef: "ghcr.io/acme/testnode:custom",
			l3Enabled: false,
			version: "v1.2.3",
		});

		expect(state.imageRef).toBe("ghcr.io/acme/testnode:custom");
		expect(state.variant).toBe("l2");
		expect(state.rpcUrls.l1).toBe("http://127.0.0.1:8545");
		expect(state.rpcUrls.l2).toBe("http://127.0.0.1:8547");
		expect(state.rpcUrls.l3).toBe("");
		const args = testnodeDockerRunArgs(state);
		expect(args).toEqual(expect.arrayContaining(["TESTNODE_VARIANT=l2"]));
		expect(args).toContain("ghcr.io/acme/testnode:custom");
		expect(args).toEqual(expect.arrayContaining(["--label", `${START_CONTAINER_LABEL}=l2`]));
	});

	it("uses the existing l3-enabled option with an image-ref", () => {
		const state = buildStartTestnodeState({
			cwd: "/workspace/project",
			imageRef: "ghcr.io/acme/testnode:custom-l3",
			l3Enabled: true,
			version: "v1.2.3",
		});

		expect(state.imageRef).toBe("ghcr.io/acme/testnode:custom-l3");
		expect(state.variant).toBe("l3-eth");
		expect(state.rpcUrls.l3).toBe("http://127.0.0.1:3347");
		expect(testnodeDockerRunArgs(state)).toEqual(
			expect.arrayContaining(["TESTNODE_VARIANT=l3-eth"]),
		);
	});

	it("enables Timeboost", () => {
		const state = buildStartTestnodeState({
			containerName: "custom-testnode",
			cwd: "/workspace/project",
			l3Enabled: true,
			timeboostEnabled: true,
			version: "v1.2.3",
		});

		expect(state.variant).toBe("l2-timeboost");
		expect(state.outputDir).toBe("/workspace/project/.arbitrum-testnode/v1.2.3/l2-timeboost");
		expect(state.imageRef).toBe(`${DEFAULT_TESTNODE_IMAGE_REPOSITORY}:v1.2.3-nc3.2-l2-timeboost`);
		expect(state.rpcUrls.l3).toBe("");
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

	it("leaves the sequencer features off by default", () => {
		const state = buildStartTestnodeState({ cwd: "/workspace/project", version: "v1.2.3" });

		expect(state.sequencer).toEqual({
			fastFeed: undefined,
			l2MaxBlockSpeed: undefined,
			pgaRoundsPerBlock: undefined,
		});
		const args = testnodeDockerRunArgs(state).join(" ");
		expect(args).not.toContain("9646");
		expect(args).not.toContain("TESTNODE_FAST_FEED");
		expect(args).not.toContain("TESTNODE_PGA");
	});

	it("carries the sequencer features into the container's settings", () => {
		const state = buildStartTestnodeState({
			cwd: "/workspace/project",
			l3Enabled: false,
			sequencer: { fastFeedEnabled: true, pgaRoundsPerBlock: 2, l2MaxBlockSpeed: "250ms" },
			version: "v1.2.3",
		});

		expect(state.variant).toBe("l2");
		expect(state.sequencer.fastFeed?.url).toBe("ws://127.0.0.1:9646/");
		const args = testnodeDockerRunArgs(state);
		expect(args).toEqual(
			expect.arrayContaining([
				"127.0.0.1:9646:9646",
				"127.0.0.1:9642:9642",
				"TESTNODE_FAST_FEED=true",
				`TESTNODE_FAST_FEED_API_KEYS=${DEFAULT_FAST_FEED_API_KEY}`,
				"TESTNODE_PGA_ROUNDS_PER_BLOCK=2",
				"TESTNODE_L2_MAX_BLOCK_SPEED=250ms",
			]),
		);
		expect(args.at(-1)).toBe(state.imageRef);
	});
});

describe("nitro image rebase", () => {
	const stateFor = (nitroImage: string, l3Enabled = false) =>
		buildStartTestnodeState({
			cwd: "/workspace/project",
			l3Enabled,
			nitroImage,
			version: "v1.2.3",
		});

	it("boots the rebased tag and keeps the resolved image as the rebase source", () => {
		const state = stateFor("nitro-node-dev:latest");

		expect(state.baseImageRef).toBe(`${DEFAULT_TESTNODE_IMAGE_REPOSITORY}:v1.2.3-nc3.2-l2`);
		expect(state.imageRef).toBe(
			rebasedTestnodeImageRef("l2", state.baseImageRef, "nitro-node-dev:latest"),
		);
		expect(testnodeDockerRunArgs(state)).toContain(state.imageRef);
	});

	it("scopes the rebased tag by variant and rebase inputs so runs cannot collide", () => {
		const base = `${DEFAULT_TESTNODE_IMAGE_REPOSITORY}:v1.2.3-nc3.2-l2`;
		const state = stateFor("nitro-node-dev:latest", true);

		expect(state.imageRef).toBe(
			rebasedTestnodeImageRef("l3-eth", state.baseImageRef, "nitro-node-dev:latest"),
		);
		expect(rebasedTestnodeImageRef("l3-eth", base, "nitro:a")).not.toBe(
			rebasedTestnodeImageRef("l2", base, "nitro:a"),
		);
		expect(rebasedTestnodeImageRef("l2", base, "nitro:a")).not.toBe(
			rebasedTestnodeImageRef("l2", base, "nitro:b"),
		);
		expect(rebasedTestnodeImageRef("l2", "base:v1", "nitro:a")).not.toBe(
			rebasedTestnodeImageRef("l2", "base:v2", "nitro:a"),
		);
	});

	it("marks the rebased tag as local so it is never pulled", () => {
		expect(rebasedTestnodeImageRef("l2", "base:v1", "nitro:a").startsWith("local/")).toBe(true);
	});

	it("builds the rebase with both images as build args and an unused context", () => {
		expect(
			testnodeRebaseBuildArgs({
				baseImageRef: `${DEFAULT_TESTNODE_IMAGE_REPOSITORY}:v1.2.3-nc3.2-l2`,
				contextDir: "/tmp/empty",
				dockerfile: "/repo/docker/testnode-rebase.Dockerfile",
				imageRef: "local/arbitrum-testnode-rebase:l2",
				nitroImage: "nitro-node-dev:latest",
			}),
		).toEqual([
			"build",
			"-f",
			"/repo/docker/testnode-rebase.Dockerfile",
			"--build-arg",
			`TESTNODE_IMAGE=${DEFAULT_TESTNODE_IMAGE_REPOSITORY}:v1.2.3-nc3.2-l2`,
			"--build-arg",
			"NITRO_IMAGE=nitro-node-dev:latest",
			"-t",
			"local/arbitrum-testnode-rebase:l2",
			"/tmp/empty",
		]);
	});

	it("passes the resolved state through to the docker build", () => {
		const runner = vi.fn();
		const state = stateFor("nitro-node-dev:latest");

		expect(
			rebaseTestnodeImage(state, {
				contextDir: "/tmp/empty",
				dockerfile: "/repo/docker/testnode-rebase.Dockerfile",
				runner,
			}),
		).toBe(state.imageRef);
		expect(runner).toHaveBeenCalledWith(
			expect.arrayContaining([
				`TESTNODE_IMAGE=${state.baseImageRef}`,
				"NITRO_IMAGE=nitro-node-dev:latest",
				state.imageRef,
			]),
		);
	});

	it("refuses to rebase a state that has no nitro image", () => {
		expect(() => rebaseTestnodeImage(stateFor(""), { runner: vi.fn() })).toThrow(
			"nitroImage is required to rebase a testnode image",
		);
	});

	it("cleans up a context dir it created and leaves a caller's alone", () => {
		const state = stateFor("nitro-node-dev:latest");
		let ownedContextDir = "";
		rebaseTestnodeImage(state, {
			dockerfile: "/repo/docker/testnode-rebase.Dockerfile",
			runner: (args) => {
				ownedContextDir = args[args.length - 1] as string;
				expect(existsSync(ownedContextDir)).toBe(true);
			},
		});

		expect(ownedContextDir).not.toBe("");
		expect(existsSync(ownedContextDir)).toBe(false);
	});

	it("propagates a build failure and still cleans up its context dir", () => {
		const state = stateFor("nitro-node-dev:latest");
		let ownedContextDir = "";

		expect(() =>
			rebaseTestnodeImage(state, {
				dockerfile: "/repo/docker/testnode-rebase.Dockerfile",
				runner: (args) => {
					ownedContextDir = args[args.length - 1] as string;
					throw new Error("docker build exited with code 1");
				},
			}),
		).toThrow("docker build exited with code 1");
		expect(ownedContextDir).not.toBe("");
		expect(existsSync(ownedContextDir)).toBe(false);
	});

	it("prunes stale rebased images with a labeled, age-bounded, best-effort prune", () => {
		const runner = vi.fn(() => "");
		pruneStaleRebasedImages(runner);
		expect(runner).toHaveBeenCalledWith([
			"image",
			"prune",
			"--all",
			"--force",
			"--filter",
			"label=org.offchainlabs.testnode-rebase=true",
			"--filter",
			"until=168h",
		]);

		expect(() =>
			pruneStaleRebasedImages(
				vi.fn(() => {
					throw new Error("docker daemon unreachable");
				}),
			),
		).not.toThrow();
	});

	it("finds the rebase Dockerfile from the built package layout", () => {
		expect(existsSync(findRebaseDockerfile())).toBe(true);
	});

	it("prefers a Dockerfile beside the module, as the CLI bundle ships it", () => {
		const dir = mkdtempSync(join(tmpdir(), "litro-bundle-"));
		writeFileSync(join(dir, "testnode-rebase.Dockerfile"), "FROM scratch\n");
		expect(findRebaseDockerfile(dir)).toBe(join(dir, "testnode-rebase.Dockerfile"));
	});

	it("fails loudly when no repo root is above the start directory", () => {
		// The resolver used to prove the Dockerfile existed by searching for it;
		// resolving it from the repo root instead has to keep that guarantee.
		expect(() => findRebaseDockerfile(tmpdir())).toThrow(/project root/);
	});
});

describe("toStartContainer", () => {
	const inspected = (overrides: Record<string, unknown> = {}) => ({
		Name: "/my-node",
		Config: { Image: "img", Labels: { a: "b", [START_CONTAINER_LABEL]: "l2" } },
		State: { Status: "running", Health: { Status: "healthy" } },
		HostConfig: {
			PortBindings: {
				"8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }],
				"8545/tcp": [{ HostIp: "127.0.0.1", HostPort: "8545" }],
				"8547/tcp": [{ HostIp: "127.0.0.1", HostPort: "8547" }],
				"8549/tcp": null,
				"9642/tcp": [{ HostIp: "127.0.0.1", HostPort: "9642" }],
				"9646/tcp": [{ HostIp: "127.0.0.1", HostPort: "9646" }],
			},
		},
		...overrides,
	});

	it("reads the variant, health and published endpoints from docker inspect", () => {
		expect(toStartContainer(inspected())).toEqual({
			name: "my-node",
			variant: "l2",
			image: "img",
			state: "running",
			health: "healthy",
			endpoints: {
				l1: "http://127.0.0.1:8545",
				l2: "http://127.0.0.1:8547",
				fastFeed: "ws://127.0.0.1:9646/",
				sequencerFeed: "ws://127.0.0.1:9642/feed",
			},
		});
	});

	it("uses the published host port, and localhost for an all-interfaces binding", () => {
		const container = toStartContainer(
			inspected({
				State: { Status: "exited" },
				HostConfig: { PortBindings: { "8547/tcp": [{ HostIp: "", HostPort: "28547" }] } },
			}),
		);
		expect(container.health).toBe("");
		expect(container.endpoints).toEqual({ l2: "http://127.0.0.1:28547" });
	});
});

describe("selectStartContainer", () => {
	const container = (name: string, state: string) => ({
		name,
		variant: "l2",
		image: "img",
		state,
		health: "",
		endpoints: {},
	});

	it("picks the named container, else the only running one, else the only one", () => {
		const containers = [container("a", "exited"), container("b", "running")];
		expect(selectStartContainer(containers, "a").name).toBe("a");
		expect(selectStartContainer(containers, undefined).name).toBe("b");
		expect(selectStartContainer([container("a", "exited")], undefined).name).toBe("a");
	});

	it("refuses to guess, and names what it could have meant", () => {
		const running = [container("a", "running"), container("b", "running")];
		expect(() => selectStartContainer(running, undefined)).toThrow(/--container: a, b/);
		expect(() => selectStartContainer(running, "c")).toThrow(/No start container named c/);
		expect(() => selectStartContainer([], undefined)).toThrow(/No start container found/);
	});
});

describe("snapshotIdForContractsVersion", () => {
	it("returns the base snapshot id for the default contracts version (v3.2)", () => {
		expect(snapshotIdForContractsVersion("l3-custom-16", "v3.2")).toBe("l3-custom-16");
		expect(snapshotIdForContractsVersion("l2", "v3.2")).toBe("l2");
	});

	it("suffixes the snapshot id for non-default versions (v2.1)", () => {
		expect(snapshotIdForContractsVersion("l3-custom-16", "v2.1")).toBe("l3-custom-16-v2.1");
		expect(snapshotIdForContractsVersion("l3-custom-6", "v2.1")).toBe("l3-custom-6-v2.1");
	});

	it("agrees with the declared snapshotsByContractsVersion overrides", () => {
		expect(snapshotIdForContractsVersion("l3-custom-6", "v2.1")).toBe(
			resolveVariantSnapshot("l3-custom-6", "v2.1").snapshotId,
		);
		expect(snapshotIdForContractsVersion("l3-custom-18", "v2.1")).toBe(
			resolveVariantSnapshot("l3-custom-18", "v2.1").snapshotId,
		);
	});

	it("throws on an unknown variant", () => {
		expect(() => snapshotIdForContractsVersion("nope", "v3.2")).toThrow(/Unknown variant/);
	});
});

describe("resolvePublishMatrix", () => {
	const key = (row: { variant: string; contractsVersion: string }) =>
		`${row.variant}@${row.contractsVersion}`;

	it("emits only current-family rows for new publishes", () => {
		const rows = resolvePublishMatrix("all", "all");
		expect(new Set(rows.map(key))).toEqual(
			new Set([
				"l2@v3.2",
				"l2-timeboost@v3.2",
				"l3-eth@v3.2",
				"l3-custom-6@v3.2",
				"l3-custom-16@v3.2",
				"l3-custom-18@v3.2",
				"l3-custom-20@v3.2",
			]),
		);
		expect(rows).toHaveLength(7);
	});

	it("does not emit a v2.1 row for l2, l2-timeboost, or l3-eth", () => {
		const rows = resolvePublishMatrix("all", "all");
		const v21 = new Set(rows.filter((r) => r.contractsVersion === "v2.1").map((r) => r.variant));
		expect(v21.has("l2")).toBe(false);
		expect(v21.has("l2-timeboost")).toBe(false);
		expect(v21.has("l3-eth")).toBe(false);
	});

	it("marks the timeboost row and sets null fee-token decimals", () => {
		const rows = resolvePublishMatrix("all", "all");
		const row = rows.find((r) => r.variant === "l2-timeboost");
		expect(row).toMatchObject({
			contractsVersion: "v3.2",
			feeTokenDecimals: null,
			timeboostEnabled: true,
		});
	});

	it("does not produce new legacy rows", () => {
		const rows = resolvePublishMatrix("l3-custom-20", "v2.1");
		expect(rows).toEqual([]);
	});

	it("returns no rows when the version is unsupported for the variant", () => {
		expect(resolvePublishMatrix("l2", "v2.1")).toEqual([]);
	});

	it("throws on an unknown variant filter", () => {
		expect(() => resolvePublishMatrix("nope", "all")).toThrow(/Unknown variant/);
	});
});
