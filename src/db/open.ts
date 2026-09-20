/**
 * Opening the Lattice index.
 *
 * Every connection applies the same pragmas, and every freshly created
 * database gets the full schema plus its version stamp.
 */

import { Database } from "bun:sqlite";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

/** How long a second process waits for a lock before giving up. */
const BUSY_TIMEOUT_MS = 5000;

/**
 * 16 KiB pages. Chunk rows and embedding blobs are both large enough that the
 * default 4 KiB page spreads a single row across several pages.
 */
const PAGE_SIZE = 16384;

export interface OpenOptions {
	/** Create the file and apply the schema when it does not exist. */
	create?: boolean;
}

/**
 * Open the index at `path`.
 *
 * Throws when the file is missing and `create` was not requested, and when an
 * existing database carries a schema version this build does not understand.
 */
export function openDatabase(
	path: string,
	options: OpenOptions = {},
): Database {
	const db = new Database(path, {
		create: options.create ?? false,
		readwrite: true,
	});

	// page_size must be set before the first page is written, and before WAL:
	// on an established database it is silently ignored.
	db.exec(`PRAGMA page_size = ${PAGE_SIZE}`);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

	try {
		applySchema(db);
	} catch (error) {
		db.close();
		throw error;
	}

	return db;
}

/**
 * Apply the schema if it is absent, and verify the version if it is present.
 */
function applySchema(db: Database): void {
	const existing = readSchemaVersion(db);

	if (existing === undefined) {
		db.exec(SCHEMA_SQL);
		db.query("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
			String(SCHEMA_VERSION),
		);
		return;
	}

	if (existing !== SCHEMA_VERSION) {
		throw new Error(
			`Database schema version ${existing} does not match the expected version ${SCHEMA_VERSION}. ` +
				"This build of Lattice cannot read it; remove the database and run `lattice init` again.",
		);
	}
}

/**
 * The recorded schema version, or undefined when the database is empty.
 */
function readSchemaVersion(db: Database): number | undefined {
	const metaExists = db
		.query<{ name: string }, []>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
		)
		.get();
	if (metaExists === null) {
		return undefined;
	}

	const row = db
		.query<{ value: string }, []>(
			"SELECT value FROM meta WHERE key = 'schema_version'",
		)
		.get();
	if (row === null) {
		return undefined;
	}

	const parsed = Number.parseInt(row.value, 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}
