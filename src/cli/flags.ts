/**
 * Reading a parsed flag as a value of a particular kind.
 *
 * `parseArgs` only knows that a flag was given, and with what text; these
 * decide what the text means and refuse it when it cannot mean that.
 */

/** A flag's value as text; `--flag` with no value is not a value. */
export function text(flag: string | true | undefined): string | undefined {
	return typeof flag === "string" ? flag : undefined;
}

/** A positive whole number, or the reason it was refused. */
export function count(
	flag: string | true | undefined,
	fallback: number,
	name: string,
): number {
	if (flag === undefined) {
		return fallback;
	}
	const value = typeof flag === "string" ? Number(flag) : Number.NaN;
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${name} expects a positive whole number, got: ${flag}`);
	}
	return value;
}
