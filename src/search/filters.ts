/**
 * The candidate set every leg of a search agrees on.
 *
 * Keyword matching, vector matching and graph expansion each reach the index
 * by a different route, and a filter that only one of them honoured would be a
 * filter the user cannot trust. So the `WHERE` fragments live here once and
 * every query that names a concept uses them.
 */

export interface SearchFilters {
	type?: string;
	tag?: string;
	dir?: string;
	status?: string;
	trust?: string;
	/** Include concepts whose status is `deprecated`, which are otherwise left out. */
	includeDeprecated?: boolean;
}

/**
 * The `WHERE` fragments and bound values every candidate query shares.
 *
 * Each fragment is emitted with its own leading `AND`, so it appends to a query
 * that already has a `WHERE`. `alias` is the concepts table's alias there.
 */
export function conceptFilters(
	filters: SearchFilters,
	alias = "c",
): { sql: string; values: string[] } {
	const clauses: string[] = [];
	const values: string[] = [];

	if (filters.type !== undefined) {
		clauses.push(`${alias}.type = ?`);
		values.push(filters.type);
	}
	if (filters.status !== undefined) {
		clauses.push(`${alias}.status = ?`);
		values.push(filters.status);
	}
	if (filters.trust !== undefined) {
		clauses.push(`${alias}.trust = ?`);
		values.push(filters.trust);
	}
	if (filters.dir !== undefined) {
		// A directory filter covers the directory itself and everything under it.
		clauses.push(`(${alias}.dir = ? OR ${alias}.dir LIKE ? || '/%')`);
		values.push(filters.dir, filters.dir);
	}
	if (filters.tag !== undefined) {
		clauses.push(
			`EXISTS (SELECT 1 FROM tags t WHERE t.concept_id = ${alias}.id AND t.tag = ?)`,
		);
		values.push(filters.tag);
	}
	// A deprecated concept is retired, not deleted: it stays out of the way
	// unless it is the thing being asked for.
	if (filters.includeDeprecated !== true && filters.status === undefined) {
		clauses.push(
			`(${alias}.status IS NULL OR ${alias}.status <> 'deprecated')`,
		);
	}

	return { sql: clauses.map((clause) => ` AND ${clause}`).join(""), values };
}
