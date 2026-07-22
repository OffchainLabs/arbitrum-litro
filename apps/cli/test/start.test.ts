import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_START_IMAGE_VERSION, resolveStartInput, runStart } from "../src/commands/start.js";

describe("resolveStartInput", () => {
	it("uses start defaults without a config file", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "start-defaults-"));

		const resolved = resolveStartInput({}, cwd);

		expect(resolved.configPath).toBeUndefined();
		expect(resolved.l3Enabled).toBe(true);
		expect(resolved.timeboostEnabled).toBe(false);
		expect(resolved.startupTimeoutSeconds).toBe(120);
		expect(resolved.networkConfigPaths).toEqual([]);
		expect(resolved.version).toBe(DEFAULT_START_IMAGE_VERSION);
	});

	it("derives the built-in default image version from the CLI package version", () => {
		const cliPackage = JSON.parse(fs.readFileSync("apps/cli/package.json", "utf-8")) as {
			version?: string;
		};
		const catalog = JSON.parse(fs.readFileSync("config/testnodes.json", "utf-8")) as {
			testnodes?: { default?: { version?: string } };
		};

		expect(DEFAULT_START_IMAGE_VERSION).toBe(`v${cliPackage.version}`);
		expect(catalog.testnodes?.default?.version).toBeUndefined();
	});

	it("loads the default config file and resolves relative paths from its directory", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "start-config-"));
		const configPath = path.join(cwd, "testnode.start.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				version: "v1.2.3",
				l3Enabled: false,
				outputDir: "./exports",
				networkConfigPath: ["./net/a.json", "./net/b.json"],
				startupTimeoutSeconds: 45,
			}),
		);

		const resolved = resolveStartInput({}, cwd);

		expect(resolved.configPath).toBe(configPath);
		expect(resolved.l3Enabled).toBe(false);
		expect(resolved.timeboostEnabled).toBe(false);
		expect(resolved.outputDir).toBe(path.join(cwd, "exports"));
		expect(resolved.networkConfigPaths).toEqual([
			path.join(cwd, "net/a.json"),
			path.join(cwd, "net/b.json"),
		]);
		expect(resolved.startupTimeoutSeconds).toBe(45);
	});

	it("loads timeboost from explicit config", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "start-timeboost-config-"));
		fs.writeFileSync(
			path.join(cwd, "testnode.start.json"),
			JSON.stringify({
				version: "v1.2.3",
				timeboostEnabled: true,
			}),
		);

		const resolved = resolveStartInput({}, cwd);

		expect(resolved.timeboostEnabled).toBe(true);
	});

	it("lets CLI flags override file config and resolves those paths from cwd", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "start-overrides-"));
		fs.writeFileSync(
			path.join(cwd, "testnode.start.json"),
			JSON.stringify({
				version: "v1.0.0",
				l3Enabled: false,
				outputDir: "./from-config",
				networkConfigPath: "./from-config/network.json",
			}),
		);

		const resolved = resolveStartInput(
			{
				l3Enabled: true,
				networkConfigPath: "./from-cli/network.json, ./second/network.json",
				outputDir: "./from-cli",
				imageVersion: "v2.0.0",
				timeboostEnabled: false,
			},
			cwd,
		);

		expect(resolved.version).toBe("v2.0.0");
		expect(resolved.l3Enabled).toBe(true);
		expect(resolved.timeboostEnabled).toBe(false);
		expect(resolved.outputDir).toBe(path.join(cwd, "from-cli"));
		expect(resolved.networkConfigPaths).toEqual([
			path.join(cwd, "from-cli/network.json"),
			path.join(cwd, "second/network.json"),
		]);
	});

	it("reads image-ref and variant from CLI options", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "start-image-ref-"));

		const resolved = resolveStartInput(
			{ imageRef: "ghcr.io/acme/testnode:custom", variant: "l3-eth" },
			cwd,
		);

		expect(resolved.imageRef).toBe("ghcr.io/acme/testnode:custom");
		expect(resolved.variant).toBe("l3-eth");
	});

	it("reads image-ref and variant from the config file", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "start-image-ref-file-"));
		fs.writeFileSync(
			path.join(cwd, "testnode.start.json"),
			JSON.stringify({ imageRef: "ghcr.io/acme/testnode:from-file", variant: "l2" }),
		);

		const resolved = resolveStartInput({}, cwd);

		expect(resolved.imageRef).toBe("ghcr.io/acme/testnode:from-file");
		expect(resolved.variant).toBe("l2");
	});

	it("uses the default image version when flags and config omit one", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "start-version-"));
		expect(resolveStartInput({}, cwd).version).toBe(DEFAULT_START_IMAGE_VERSION);
	});
});

describe("runStart", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("boots the testnode image and copies localNetwork.json to requested paths", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "start-run-"));
		const bootTestnode = vi.fn(() => ["localNetwork.json", "l1l2_network.json"]);
		const collectContainerDiagnostics = vi.fn(() => ({ errors: [] }));
		const copyNetworkConfigPaths = vi.fn();

		const result = runStart(
			{
				configPath: undefined,
				containerName: undefined,
				cwd,
				feeTokenDecimals: undefined,
				imageRepository: undefined,
				l3Enabled: true,
				networkConfigPaths: [path.join(cwd, "sdk/localNetwork.json")],
				nitroContractsVersion: undefined,
				outputDir: undefined,
				startupTimeoutSeconds: 120,
				timeboostEnabled: true,
				version: "v1.2.3",
			},
			{
				bootTestnode,
				collectContainerDiagnostics,
				copyNetworkConfigPaths,
			},
		);

		expect(bootTestnode).toHaveBeenCalledWith(
			expect.objectContaining({
				containerName: "arbitrum-testnode-l2-timeboost",
				outputDir: path.join(cwd, ".arbitrum-testnode/v1.2.3/l2-timeboost"),
				timeboostEnabled: true,
				variant: "l2-timeboost",
			}),
			120_000,
		);
		expect(copyNetworkConfigPaths).toHaveBeenCalledWith(
			path.join(cwd, ".arbitrum-testnode/v1.2.3/l2-timeboost/config/localNetwork.json"),
			[path.join(cwd, "sdk/localNetwork.json")],
		);
		expect(result.success).toBe(true);
		expect(result.localNetworkPath).toBe(
			path.join(cwd, ".arbitrum-testnode/v1.2.3/l2-timeboost/config/localNetwork.json"),
		);
	});

	it("rejects non-positive startup timeouts", () => {
		expect(() =>
			runStart({
				configPath: undefined,
				containerName: undefined,
				cwd: "/tmp/project",
				feeTokenDecimals: undefined,
				imageRepository: undefined,
				l3Enabled: true,
				networkConfigPaths: [],
				nitroContractsVersion: undefined,
				outputDir: undefined,
				startupTimeoutSeconds: 0,
				timeboostEnabled: false,
				version: "v1.2.3",
			}),
		).toThrow("startup-timeout-seconds must be a positive number");
	});
});
