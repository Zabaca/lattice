/**
 * Opening the note store.
 */

import type { Database } from "bun:sqlite";
import { openDatabase, type SchemaSpec } from "../db/open.js";
import { STORE_SCHEMA_SQL, STORE_SCHEMA_VERSION } from "./schema.js";

export const STORE_SCHEMA: SchemaSpec = {
	version: STORE_SCHEMA_VERSION,
	sql: STORE_SCHEMA_SQL,
	label: "note store",
	kind: "note store",
	remedy:
		"restart the session so it runs the current Lattice, or run `lattice import` into a fresh home",
};

/**
 * Open the store at `path`. Throws when it is missing and `create` was not
 * asked for, and when it is in a schema version this build does not know.
 */
export function openStore(
	path: string,
	options: { create?: boolean } = {},
): Database {
	return openDatabase(path, { create: options.create, schema: STORE_SCHEMA });
}
