import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { execOrThrow } from "./exec.js";
import {
	ANVIL_STATE_DIRNAME,
	ANVIL_STATE_FILENAME,
	DEFAULT_SNAPSHOT_ID,
	type SnapshotManifest,
	getSnapshotDir,
	getSnapshotsDir,
	invalidateSnapshot,
	readNitroNodeImage,
	verifySnapshotManifest,
} from "./snapshot.js";

const GITHUB_API_BASE = "https://api.github.com";
const SNAPSHOT_RELEASE_PREFIX = "arbitrum-testnode-snapshot";
const GITHUB_API_VERSION = "2022-11-28";

interface GitHubReleaseAsset {
	name: string;
	url: string;
}

interface GitHubReleaseResponse {
	tag_name: string;
	assets: GitHubReleaseAsset[];
}

export interface SnapshotPackOptions {
	outDir: string;
	snapshotId?: string;
	tag: string;
}

export interface SnapshotPackResult {
	archiveName: string;
	archivePath: string;
	checksum: string;
	checksumName: string;
	checksumPath: string;
	snapshotId: string;
	tag: string;
}

export interface SnapshotInstallOptions {
	composeFile: string;
	configDir: string;
	force?: boolean;
	repo?: string;
	snapshotId?: string;
	token?: string;
	url?: string;
	version?: string;
}

export interface SnapshotInstallResult {
	archiveName: string;
	manifest: SnapshotManifest;
	releaseTag?: string;
	snapshotId: string;
	sourceRepo?: string;
	sourceUrl: string;
}

interface SnapshotDownloadSource {
	archiveHeaders?: Record<string, string>;
	archiveName: string;
	archiveUrl: string;
	checksumHeaders?: Record<string, string>;
	checksumUrl: string;
	releaseTag?: string;
	sourceRepo?: string;
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function buildSnapshotArchiveName(tag: string): string {
	return `${SNAPSHOT_RELEASE_PREFIX}-${tag}.tgz`;
}

function buildSnapshotChecksumName(tag: string): string {
	return `${SNAPSHOT_RELEASE_PREFIX}-${tag}.sha256`;
}

function readSingleDirectory(path: string): string {
	const directories = readdirSync(path).filter((entry) => {
		const fullPath = join(path, entry);
		return statSync(fullPath).isDirectory();
	});
	if (directories.length !== 1) {
		throw new Error(`Expected exactly one snapshot directory in ${path}`);
	}
	const [directory] = directories;
	if (!directory) {
		throw new Error(`Expected exactly one snapshot directory in ${path}`);
	}
	return directory;
}

function checksumFileContents(checksum: string, archiveName: string): string {
	return `${checksum}  ${archiveName}\n`;
}

function parseChecksumFile(contents: string): string {
	const line = contents.split(/\r?\n/u).find((entry) => entry.trim().length > 0);
	if (!line) {
		throw new Error("Snapshot checksum file is empty");
	}
	const match = line.match(/^([a-fA-F0-9]{64})\b/u);
	if (!match) {
		throw new Error("Snapshot checksum file does not contain a valid sha256");
	}
	const [checksum] = match.slice(1);
	if (!checksum) {
		throw new Error("Snapshot checksum file does not contain a valid sha256");
	}
	return checksum.toLowerCase();
}

function requireGitHubRepo(repo = process.env["TESTNODE_SNAPSHOT_GH_REPO"]): string {
	if (!repo) {
		throw new Error("Set TESTNODE_SNAPSHOT_GH_REPO or pass --repo to locate snapshot releases");
	}
	if (!/^[^/]+\/[^/]+$/u.test(repo)) {
		throw new Error(`Invalid GitHub repo "${repo}". Expected owner/repo`);
	}
	return repo;
}

function requireGitHubToken(token = process.env["GITHUB_TOKEN"]): string {
	if (!token) {
		throw new Error("Set GITHUB_TOKEN to download snapshots from a private GitHub release");
	}
	return token;
}

function releaseApiUrl(repo: string, version?: string): string {
	return version
		? `${GITHUB_API_BASE}/repos/${repo}/releases/tags/${version}`
		: `${GITHUB_API_BASE}/repos/${repo}/releases/latest`;
}

function githubApiHeaders(token: string): Record<string, string> {
	return {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
	};
}

function githubAssetHeaders(token: string): Record<string, string> {
	return {
		Accept: "application/octet-stream",
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
	};
}

async function fetchOrThrow(url: string, headers?: Record<string, string>): Promise<Response> {
	const response = await fetch(url, headers ? { headers } : undefined);
	if (response.ok) {
		return response;
	}
	const message = (await response.text()).trim() || response.statusText;
	throw new Error(`Request failed for ${url}: ${response.status} ${message}`);
}

async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
	const response = await fetchOrThrow(url, headers);
	return (await response.json()) as T;
}

async function downloadText(url: string, headers?: Record<string, string>): Promise<string> {
	const response = await fetchOrThrow(url, headers);
	return response.text();
}

async function downloadFile(
	url: string,
	outputPath: string,
	headers?: Record<string, string>,
): Promise<void> {
	const response = await fetchOrThrow(url, headers);
	const body = Buffer.from(await response.arrayBuffer());
	writeFileSync(outputPath, body);
}

function findRequiredAsset(assets: GitHubReleaseAsset[], name: string): GitHubReleaseAsset {
	const asset = assets.find((entry) => entry.name === name);
	if (!asset) {
		throw new Error(`Release is missing required asset ${name}`);
	}
	return asset;
}

async function resolveGitHubSnapshotSource(
	repo: string,
	version: string | undefined,
	token: string,
): Promise<SnapshotDownloadSource> {
	const release = await fetchJson<GitHubReleaseResponse>(
		releaseApiUrl(repo, version),
		githubApiHeaders(token),
	);
	const archiveName = buildSnapshotArchiveName(release.tag_name);
	const checksumName = buildSnapshotChecksumName(release.tag_name);
	const archiveAsset = findRequiredAsset(release.assets, archiveName);
	const checksumAsset = findRequiredAsset(release.assets, checksumName);
	return {
		archiveHeaders: githubAssetHeaders(token),
		archiveName,
		archiveUrl: archiveAsset.url,
		checksumHeaders: githubAssetHeaders(token),
		checksumUrl: checksumAsset.url,
		releaseTag: release.tag_name,
		sourceRepo: repo,
	};
}

function deriveChecksumUrl(url: string): string {
	if (url.endsWith(".tgz")) {
		return `${url.slice(0, -4)}.sha256`;
	}
	return `${url}.sha256`;
}

function resolveDirectSnapshotSource(url: string): SnapshotDownloadSource {
	return {
		archiveName: basename(new URL(url).pathname) || `${SNAPSHOT_RELEASE_PREFIX}.tgz`,
		archiveUrl: url,
		checksumUrl: deriveChecksumUrl(url),
	};
}

async function resolveSnapshotDownloadSource(
	options: SnapshotInstallOptions,
): Promise<SnapshotDownloadSource> {
	if (options.url) {
		return resolveDirectSnapshotSource(options.url);
	}
	const repo = requireGitHubRepo(options.repo);
	const token = requireGitHubToken(options.token);
	return resolveGitHubSnapshotSource(repo, options.version, token);
}

function assertSnapshotImageCompatibility(manifest: SnapshotManifest, composeFile: string): void {
	const currentNitroImage = readNitroNodeImage(composeFile);
	if (manifest.nitroNodeImage !== currentNitroImage) {
		throw new Error(
			`Snapshot Nitro image ${manifest.nitroNodeImage} does not match compose image ${currentNitroImage}`,
		);
	}
}

export function packageSnapshotRelease(
	configDir: string,
	options: SnapshotPackOptions,
): SnapshotPackResult {
	const snapshotId = options.snapshotId ?? DEFAULT_SNAPSHOT_ID;
	verifySnapshotManifest(configDir, snapshotId);
	mkdirSync(options.outDir, { recursive: true });
	const archiveName = buildSnapshotArchiveName(options.tag);
	const checksumName = buildSnapshotChecksumName(options.tag);
	const archivePath = resolve(join(options.outDir, archiveName));
	const checksumPath = resolve(join(options.outDir, checksumName));
	execOrThrow("tar", ["-czf", archivePath, "-C", getSnapshotsDir(configDir), snapshotId]);
	const checksum = sha256File(archivePath);
	writeFileSync(checksumPath, checksumFileContents(checksum, archiveName));
	return {
		archiveName,
		archivePath,
		checksum,
		checksumName,
		checksumPath,
		snapshotId,
		tag: options.tag,
	};
}

export function installSnapshotArchive(
	configDir: string,
	composeFile: string,
	archivePath: string,
	options?: {
		force?: boolean;
		snapshotId?: string;
	},
): SnapshotManifest {
	const snapshotId = options?.snapshotId ?? DEFAULT_SNAPSHOT_ID;
	const targetSnapshotDir = getSnapshotDir(configDir, snapshotId);
	if (existsSync(targetSnapshotDir) && !options?.force) {
		throw new Error(`Snapshot ${snapshotId} already exists; pass --force to replace it`);
	}

	const extractRoot = mkdtempSync(join(tmpdir(), "arbitrum-testnode-install-"));
	try {
		execOrThrow("tar", ["-xzf", archivePath, "-C", extractRoot]);
		const extractedDirName = readSingleDirectory(extractRoot);
		const extractedDir = join(extractRoot, extractedDirName);
		mkdirSync(getSnapshotsDir(configDir), { recursive: true });
		if (existsSync(targetSnapshotDir)) {
			invalidateSnapshot(configDir, snapshotId);
		}
		cpSync(extractedDir, targetSnapshotDir, { recursive: true });
		normalizeLegacyAnvilStateFile(targetSnapshotDir);
		try {
			const manifest = verifySnapshotManifest(configDir, snapshotId);
			assertSnapshotImageCompatibility(manifest, composeFile);
			return manifest;
		} catch (error) {
			invalidateSnapshot(configDir, snapshotId);
			throw error;
		}
	} finally {
		rmSync(extractRoot, { recursive: true, force: true });
	}
}

function normalizeLegacyAnvilStateFile(snapshotDir: string): void {
	const anvilStatePath = join(snapshotDir, ANVIL_STATE_DIRNAME);
	if (!existsSync(anvilStatePath) || !statSync(anvilStatePath).isFile()) {
		return;
	}

	const legacyStatePath = `${anvilStatePath}.legacy`;
	renameSync(anvilStatePath, legacyStatePath);
	mkdirSync(anvilStatePath, { recursive: true });
	renameSync(legacyStatePath, join(anvilStatePath, ANVIL_STATE_FILENAME));
}

export async function installSnapshotRelease(
	options: SnapshotInstallOptions,
): Promise<SnapshotInstallResult> {
	const snapshotId = options.snapshotId ?? DEFAULT_SNAPSHOT_ID;
	const source = await resolveSnapshotDownloadSource(options);
	const tempDir = mkdtempSync(join(tmpdir(), "arbitrum-testnode-release-"));
	try {
		const archivePath = join(tempDir, source.archiveName);
		await downloadFile(source.archiveUrl, archivePath, source.archiveHeaders);
		const checksumContents = await downloadText(source.checksumUrl, source.checksumHeaders);
		const expectedChecksum = parseChecksumFile(checksumContents);
		const actualChecksum = sha256File(archivePath);
		if (expectedChecksum !== actualChecksum) {
			throw new Error(
				`Snapshot checksum mismatch for ${source.archiveName}: expected ${expectedChecksum}, received ${actualChecksum}`,
			);
		}
		const manifest = installSnapshotArchive(options.configDir, options.composeFile, archivePath, {
			snapshotId,
			...(options.force !== undefined ? { force: options.force } : {}),
		});
		return {
			archiveName: source.archiveName,
			manifest,
			...(source.releaseTag ? { releaseTag: source.releaseTag } : {}),
			snapshotId,
			...(source.sourceRepo ? { sourceRepo: source.sourceRepo } : {}),
			sourceUrl: source.archiveUrl,
		};
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}
