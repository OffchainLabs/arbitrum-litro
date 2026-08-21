import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

/**
 * Copies each tag from the source repository to the destination, preserving the
 * digest, and refuses to change a destination tag that already differs.
 *
 * crane rather than `docker buildx imagetools create`, which wraps a single-arch
 * source in a new index and so gives the destination a different digest than the
 * source. Matching digests keep `repo@sha256:...` valid against either registry.
 */

function readArg(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) {
		return "";
	}
	return process.argv[index + 1] || "";
}

const source = readArg("--source");
const destination = readArg("--destination");
if (!source || !destination) {
	throw new Error("--source and --destination are required");
}
const overwrite = process.argv.includes("--overwrite");

const readList = (name) =>
	(process.env[name] ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

const tags = readList("TAGS");
if (tags.length === 0) {
	throw new Error("TAGS is empty");
}
const aliases = readList("ALIASES");

const digestOf = (ref) => {
	try {
		return execFileSync("crane", ["digest", ref], { encoding: "utf-8" }).trim();
	} catch {
		return "";
	}
};

/**
 * Whether the destination tag exists, via the Hub API rather than the registry:
 * Docker Hub answers 401 for an unknown repository, which is indistinguishable
 * from bad credentials. Assumes a public destination.
 */
async function destinationExists(repository, tag) {
	const response = await fetch(`https://hub.docker.com/v2/repositories/${repository}/tags/${tag}`);
	if (response.status === 200) {
		return true;
	}
	if (response.status === 404) {
		return false;
	}
	throw new Error(`cannot tell whether ${repository}:${tag} exists (HTTP ${response.status})`);
}

function copyTag(tag, sourceDigest) {
	execFileSync("crane", ["copy", `${source}:${tag}`, `index.docker.io/${destination}:${tag}`], {
		stdio: "inherit",
	});
	const copiedDigest = digestOf(`index.docker.io/${destination}:${tag}`);
	if (copiedDigest !== sourceDigest) {
		throw new Error(`digest mismatch after copy: source ${sourceDigest}, got ${copiedDigest}`);
	}
}

const summary = [];
const failures = [];
const mirroredDigests = new Set();
let copied = 0;
let skipped = 0;
let held = 0;

for (const tag of tags) {
	const to = `${destination}:${tag}`;
	console.log(`::group::${tag}`);
	try {
		const sourceDigest = digestOf(`${source}:${tag}`);
		if (!sourceDigest) {
			throw new Error(`source missing: ${source}:${tag}`);
		}

		if (await destinationExists(destination, tag)) {
			const current = digestOf(`index.docker.io/${to}`);
			if (current === sourceDigest) {
				console.log(`already mirrored at ${sourceDigest}`);
				mirroredDigests.add(sourceDigest);
				skipped += 1;
				continue;
			}
			if (!overwrite) {
				throw new Error(
					`${to} exists at ${current}, source is ${sourceDigest}; re-run with overwrite to replace it`,
				);
			}
			console.log(`replacing ${current} with ${sourceDigest}`);
		}

		copyTag(tag, sourceDigest);
		mirroredDigests.add(sourceDigest);
		console.log(`copied ${sourceDigest}`);
		summary.push(`- \`${to}\` <- \`${sourceDigest}\``);
		copied += 1;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		failures.push(tag);
	} finally {
		console.log("::endgroup::");
	}
}

// Aliases move only when the source alias names a version this run mirrored.
// Overwriting is the point of an alias, so the guard above does not apply; the
// digest match is what keeps the destination from claiming a version is latest
// when the source does not, or when this run mirrored an older version.
for (const alias of aliases) {
	console.log(`::group::${alias}`);
	try {
		const sourceDigest = digestOf(`${source}:${alias}`);
		if (!sourceDigest) {
			console.log(`source has no ${alias}`);
			held += 1;
			continue;
		}
		if (!mirroredDigests.has(sourceDigest)) {
			console.log(`${source}:${alias} is ${sourceDigest}, which is not a version mirrored here`);
			held += 1;
			continue;
		}
		if (digestOf(`index.docker.io/${destination}:${alias}`) === sourceDigest) {
			console.log(`already mirrored at ${sourceDigest}`);
			skipped += 1;
			continue;
		}
		copyTag(alias, sourceDigest);
		console.log(`copied ${sourceDigest}`);
		summary.push(`- \`${destination}:${alias}\` <- \`${sourceDigest}\``);
		copied += 1;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		failures.push(alias);
	} finally {
		console.log("::endgroup::");
	}
}

const outcome = `copied ${copied}, skipped ${skipped} (already current), held ${held} (alias names another version), failed ${failures.length}`;
console.log(outcome);
if (process.env.GITHUB_STEP_SUMMARY) {
	appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${[...summary, outcome].join("\n")}\n`);
}

if (failures.length > 0) {
	throw new Error(`failed tags: ${failures.join(" ")}`);
}
