import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DASHBOARDS, dashboard } from "../metrics/build-dashboards.mjs";

const DIR = "metrics/dashboards";

/** Metric names a dashboard may query, by where they come from. */
function knownMetrics() {
	const nitro = readFileSync("test/fixtures/nitro-metrics-v3.12.1.txt", "utf-8")
		.split("\n")
		.filter((line) => line && !line.startsWith("#"));
	const families = (file: string, pattern: RegExp) =>
		[...readFileSync(file, "utf-8").matchAll(pattern)].map((match) => match[1] as string);
	return new Set([
		...nitro,
		...families("docker/chain-exporter.mjs", /family\(\s*"([a-z_]+)"/g),
		...families("docker/fast-feed-relay.mjs", /metric\(\s*"([a-z_]+)"/g),
		// Prometheus's own series about each scrape.
		"up",
	]);
}

/** Every metric name a PromQL expression selects, ignoring functions, labels and keywords. */
function metricsIn(expr: string) {
	const withoutLabels = expr
		.replace(/\{[^}]*\}/g, "")
		.replace(/\[[^\]]*\]/g, "")
		.replace(/\b(by|on|without|ignoring|group_left|group_right)\s*\([^)]*\)/g, "");
	const keywords = new Set([
		"by",
		"on",
		"group_right",
		"group_left",
		"time",
		"rate",
		"increase",
		"max",
		"count",
		"sum",
	]);
	return [...withoutLabels.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g)]
		.map((match) => match[1] as string)
		.filter((name) => !keywords.has(name) && !/^\d/.test(name));
}

describe("metrics dashboards", () => {
	it("are committed exactly as build-dashboards.mjs writes them", () => {
		expect(readdirSync(DIR).sort()).toEqual(Object.keys(DASHBOARDS).sort());
		for (const [file, spec] of Object.entries(DASHBOARDS)) {
			expect(readFileSync(join(DIR, file), "utf-8"), file).toBe(
				`${JSON.stringify(dashboard(spec), null, "\t")}\n`,
			);
		}
	});

	it("query only metrics that Nitro, the chain exporter or the relay actually export", () => {
		const known = knownMetrics();
		const queries = Object.entries(DASHBOARDS).flatMap(([file, spec]) => {
			const built = dashboard(spec) as { panels: Array<{ targets?: Array<{ expr: string }> }> };
			return built.panels
				.flatMap((panel) => panel.targets ?? [])
				.map((target) => ({ file, expr: target.expr }));
		});
		const unknown = queries.flatMap(({ file, expr }) =>
			metricsIn(expr.replace(/\$[a-z]+/g, ""))
				.filter((name) => !known.has(name))
				.map((name) => `${file}: ${name} in ${expr}`),
		);
		expect(unknown).toEqual([]);
	});

	it("explain every panel, so the dashboard says what each graph is for", () => {
		for (const [file, spec] of Object.entries(DASHBOARDS)) {
			const built = dashboard(spec) as {
				panels: Array<{ type: string; title: string; description?: string }>;
			};
			for (const panel of built.panels.filter((p) => p.type !== "row" && p.title !== "$metric")) {
				expect(panel.description, `${file}: ${panel.title}`).toBeTruthy();
			}
		}
	});
});
