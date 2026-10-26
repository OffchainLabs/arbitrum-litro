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
 * @param {{ integer?: boolean; min: number }} rule
 * @returns {number | undefined}
 */
export function toNumber(value, name, rule) {
	if (value === undefined || value === "") {
		return undefined;
	}
	const number = Number(value);
	const valid =
		Number.isFinite(number) && number >= rule.min && (!rule.integer || Number.isInteger(number));
	if (!valid) {
		throw new Error(
			`${name} must be ${rule.integer ? "an integer" : "a number"} of at least ${rule.min}, got ${value}`,
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
