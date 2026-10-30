import {
	findMetricsStack,
	listMetrics,
	listStartContainers,
	metricsSummary,
	parseDuration,
	queryInstant,
	queryRange,
	selectStartContainer,
} from "@arbitrum/testnode";
import { Cli, z } from "incur";

const target = {
	container: z
		.string()
		.optional()
		.describe("Start container whose metrics to read, when more than one is running"),
	prometheusUrl: z
		.string()
		.optional()
		.describe("Read from this Prometheus instead of the one `litro start --metrics` runs"),
};

/** The Prometheus to read: the one given, else the metrics stack of the selected container. */
function prometheusUrl(options: {
	container?: string | undefined;
	prometheusUrl?: string | undefined;
}) {
	if (options.prometheusUrl) {
		return options.prometheusUrl.replace(/\/$/, "");
	}
	const container = selectStartContainer(listStartContainers(), options.container);
	const stack = findMetricsStack(container.name);
	if (!stack) {
		throw new Error(
			`${container.name} runs without metrics; start it with \`litro start --metrics\``,
		);
	}
	return stack.prometheusUrl;
}

export const metricsCli = Cli.create("metrics", {
	description:
		"Read a running testnode's metrics (start it with `litro start --metrics`): a summary of its health, the catalog of metrics, or any PromQL query over time",
});

metricsCli.command("summary", {
	description:
		"Current health in one JSON object: per chain the RPC, head block, transactions and failures per second, time since the last transaction; per rollup the batches, deposits waiting, assertion ages; per Nitro node how far it trails the sequencer, CPU and memory; and the Fast Feed relay's clients and delivery latency",
	options: z.object(target),
	async run(c) {
		return metricsSummary(prometheusUrl(c.options));
	},
});

metricsCli.command("list", {
	description:
		"Every metric the testnode exports, with its type, what it measures and which source reports it (a Nitro node, the chain exporter, the Fast Feed relay). Use it to find names for `litro metrics query`",
	options: z.object({
		...target,
		filter: z
			.string()
			.optional()
			.describe(
				"Regex the metric name must match in full, e.g. arb_sequencer_.* or litro_rollup_.*",
			),
	}),
	async run(c) {
		return { metrics: await listMetrics(prometheusUrl(c.options), c.options.filter) };
	},
});

metricsCli.command("query", {
	description:
		"Run a PromQL query: its current value per series, or with --since its values over that window. Labels: chain (l1, l2, l3), node (l2-sequencer, l2-validator, l3), job (nitro, chain, fast-feed)",
	args: z.object({
		promql: z.string().describe('PromQL, e.g. rate(litro_transactions_total{chain="l2"}[1m])'),
	}),
	options: z.object({
		...target,
		since: z
			.string()
			.optional()
			.describe("Return values over this window instead of now: 30s, 15m, 2h or 1d"),
		step: z.string().optional().describe("Spacing of the values with --since (default: 15s)"),
	}),
	async run(c) {
		const url = prometheusUrl(c.options);
		if (!c.options.since) {
			return { series: await queryInstant(url, c.args.promql) };
		}
		return {
			series: await queryRange(url, c.args.promql, {
				sinceSeconds: parseDuration(c.options.since, "since"),
				stepSeconds: parseDuration(c.options.step ?? "15s", "step"),
			}),
		};
	},
});
