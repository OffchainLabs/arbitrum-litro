import { execFileSync } from "node:child_process";

/**
 * Asserts an image's bundle labels agree with the tag it was pulled as.
 *
 * Promotion copies digests rather than rebuilding, so a mislabelled image stays
 * mislabelled all the way to the public registry. The labels are the only record
 * of which version and variant an image actually is once its tag is out of sight.
 */

function readArg(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) {
		return "";
	}
	return process.argv[index + 1] || "";
}

const imageRef = readArg("--image-ref");
if (!imageRef) {
	throw new Error("--image-ref is required");
}

const expected = {
	"io.arbitrum.testnode.bundle.variant": readArg("--variant"),
	"io.arbitrum.testnode.bundle.version": readArg("--version"),
};

const labels =
	JSON.parse(
		execFileSync("docker", ["image", "inspect", "--format", "{{json .Config.Labels}}", imageRef], {
			encoding: "utf-8",
		}),
	) ?? {};

const mismatches = Object.entries(expected)
	.filter(([label, value]) => value && labels[label] !== value)
	.map(([label, value]) => `${label} is ${labels[label] ?? "unset"}, expected ${value}`);

if (mismatches.length > 0) {
	throw new Error(`${imageRef}: ${mismatches.join("; ")}`);
}

console.log(`${imageRef} labels match: ${JSON.stringify(expected)}`);
