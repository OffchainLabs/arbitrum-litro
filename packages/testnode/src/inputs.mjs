// @ts-check

// Parsers for options that arrive as CLI flags, action inputs (always strings) or config values.
// Empty and unset mean "not provided" throughout.

/**
 * @param {import("./types.js").ScalarInput} value
 * @param {boolean} [defaultValue]
 */
export function toBoolean(value, defaultValue = false) {
	if (value === undefined || value === "") {
		return defaultValue;
	}
	return value === true || value === "true";
}

/**
 * @param {number | string | undefined} value
 * @param {string} name option name, for the error message
 * @param {{ integer?: boolean; min: number; max?: number }} rule
 * @returns {number | undefined}
 */
export function toNumber(value, name, rule) {
	if (value === undefined || value === "") {
		return undefined;
	}
	const number = Number(value);
	const { integer, min, max = Number.POSITIVE_INFINITY } = rule;
	const valid =
		Number.isFinite(number) &&
		number >= min &&
		number <= max &&
		(!integer || Number.isInteger(number));
	if (!valid) {
		const range =
			max === Number.POSITIVE_INFINITY ? `of at least ${min}` : `between ${min} and ${max}`;
		throw new Error(
			`${name} must be ${integer ? "an integer" : "a number"} ${range}, got ${value}`,
		);
	}
	return number;
}

/**
 * @param {string | undefined} value
 * @param {string} name option name, for the error message
 * @returns {string | undefined} a Go duration such as `250ms`
 */
export function toGoDuration(value, name) {
	if (value === undefined || value === "") {
		return undefined;
	}
	if (!/^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/.test(value)) {
		throw new Error(`${name} must be a Go duration such as 250ms, got ${value}`);
	}
	return value;
}
