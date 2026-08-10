import { readFileSync } from "node:fs";

interface PackageMetadata {
	version: string;
}

function readPackageMetadata(): PackageMetadata {
	const raw = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
	) as Partial<PackageMetadata>;
	if (!raw.version) {
		throw new Error("apps/cli/package.json is missing version");
	}
	return { version: raw.version };
}

export const PACKAGE_METADATA = readPackageMetadata();
export const DEFAULT_START_IMAGE_VERSION = "latest";
