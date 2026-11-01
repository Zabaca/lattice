/**
 * The Lattice MCP server: the note store's tools for an agent.
 *
 * One server runs per Claude Code session and opens the one shared store. It
 * holds no state of its own beyond the open database and the embedding
 * provider, and the provider loads its model only when a question first needs
 * a vector. Every call re-checks the store's schema version, so a server
 * started before the layout changed refuses instead of misreading it.
 *
 * Every tool answers in compact JSON. A refusal is an error result carrying
 * what happened and what to do next.
 */

import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type EmbeddingProvider, selectProvider } from "../embed/provider.js";
import {
	RerankConfigurationError,
	selectReranker,
} from "../rerank/provider.js";
import { openStore } from "../store/open.js";
import {
	history,
	isRefusal,
	listNotes,
	noteLinks,
	type Refusal,
	readNote,
} from "../store/read.js";
import { recall } from "../store/recall.js";
import { STORE_SCHEMA_VERSION } from "../store/schema.js";
import { collectStats } from "../store/stats.js";
import { type LatticePaths, resolvePaths } from "../utils/paths.js";

export interface ServerOptions {
	env: Record<string, string | undefined>;
	/**
	 * The folder the session runs in, recorded with each question. Claude Code
	 * starts a server in the session's folder (checked 2026-11-01), so this is
	 * the process's own working directory.
	 */
	project?: string;
}

export interface LatticeServer {
	server: McpServer;
	/** Release the database. */
	close(): void;
}

const NAME = "lattice";

const INSTRUCTIONS =
	"Lattice is the store of what has already been researched and written down. " +
	"Ask first: call recall with your question before you research or answer from memory. " +
	"Read the notes it points to with read_note, and ask for long notes by section id. " +
	"A passage marked old comes from Lattice 1 and may be out of date; unchecked means nobody has confirmed it yet.";

export function createLatticeServer(options: ServerOptions): LatticeServer {
	const paths = resolvePaths(options.env);
	const store = new StoreHandle(paths);
	const mcp = new McpServer(
		{ name: NAME, version: "3.0.0-dev" },
		{ instructions: INSTRUCTIONS },
	);

	let provider: EmbeddingProvider | { unavailable: string } | undefined;
	const embedding = (): EmbeddingProvider | { unavailable: string } => {
		if (provider === undefined) {
			try {
				provider = selectProvider(options.env);
			} catch (error) {
				provider = {
					unavailable: error instanceof Error ? error.message : String(error),
				};
			}
		}
		return provider;
	};

	/** Run a tool against the store, turning a refusal or a failure into an error result. */
	const answer = async (
		work: (db: Database) => unknown | Promise<unknown>,
	): Promise<CallToolResult> => {
		try {
			const db = store.open();
			const out = await work(db);
			return isRefusal(out) ? refusal(out) : ok(out);
		} catch (error) {
			if (error instanceof Refused) {
				return refusal(error.refusal);
			}
			if (error instanceof RerankConfigurationError) {
				return refusal({
					refused: error.message,
					next: "Unset LATTICE_RERANK_PROVIDER, or fix its configuration, and restart the session.",
				});
			}
			const message = error instanceof Error ? error.message : String(error);
			return refusal({
				refused: `Lattice failed: ${message}`,
				next: "Try again; if it keeps failing, run `lattice status --store` in a terminal.",
			});
		}
	};

	const readOnly = { readOnlyHint: true, openWorldHint: false };

	mcp.registerTool(
		"recall",
		{
			description:
				"Ask what is already known before you research or answer from memory. Returns the best passages (or notes) with their note, section id, checked/old/stale marks, and whether search ran in full. Start here.",
			inputSchema: {
				question: z
					.string()
					.min(1)
					.describe("What you want to know, in words."),
				best: z
					.enum(["passages", "notes"])
					.optional()
					.describe(
						"passages (default) or notes, to find which notes cover a subject.",
					),
				limit: z
					.number()
					.int()
					.min(1)
					.max(25)
					.optional()
					.describe("Default 5."),
				type: z.string().optional().describe("Only notes of this type."),
				tag: z.string().optional().describe("Only notes with this tag."),
				notes: z
					.array(z.string())
					.optional()
					.describe("Only within these note names."),
				include_archived: z.boolean().optional(),
			},
			annotations: readOnly,
		},
		(args) =>
			answer((db) => {
				const client = store.clientOf(mcp);
				const reranker = selectReranker(options.env);
				return recall(
					{ db, provider: embedding, reranker },
					{
						question: args.question,
						best: args.best,
						limit: args.limit,
						type: args.type,
						tag: args.tag,
						notes: args.notes,
						includeArchived: args.include_archived,
					},
				).then((result) => {
					store.logQuestion(db, {
						project: options.project,
						client,
						question: args.question,
						results: (result.passages ?? result.notes ?? []).length,
						degraded: result.search !== "full",
					});
					return result;
				});
			}),
	);

	mcp.registerTool(
		"read_note",
		{
			description:
				"Read a note: fields, an outline (section ids, headings, sizes, checked marks) and its text. A short note comes whole; a long one gives the outline and its first section, so ask for more with sections. version reads it as it was.",
			inputSchema: {
				name: z
					.string()
					.describe(
						"The note's name, such as research/jev-as-a-lattice-reranker.",
					),
				sections: z
					.array(z.string())
					.optional()
					.describe('Section ids to return, such as ["s2"].'),
				version: z
					.number()
					.int()
					.optional()
					.describe("An earlier version of the note."),
			},
			annotations: readOnly,
		},
		(args) =>
			answer((db) =>
				readNote(db, args.name, {
					sections: args.sections,
					version: args.version,
				}),
			),
	);

	mcp.registerTool(
		"list_notes",
		{
			description:
				"Browse notes: name, title and one line each, filtered by type or tag, paged.",
			inputSchema: {
				type: z.string().optional(),
				tag: z.string().optional(),
				include_archived: z.boolean().optional(),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe("Default 20."),
				offset: z.number().int().min(0).optional(),
			},
			annotations: readOnly,
		},
		(args) =>
			answer((db) =>
				listNotes(db, {
					type: args.type,
					tag: args.tag,
					includeArchived: args.include_archived,
					limit: args.limit,
					offset: args.offset,
				}),
			),
	);

	mcp.registerTool(
		"links",
		{
			description:
				"A note's links out, links in (with the sentence each was written in), and links to notes nobody has written yet.",
			inputSchema: { name: z.string() },
			annotations: readOnly,
		},
		(args) => answer((db) => noteLinks(db, args.name)),
	);

	mcp.registerTool(
		"stats",
		{
			description:
				"Counts, unchecked sections, recent changes, search health, the notes most wanted, and how often Lattice is asked.",
			inputSchema: {},
			annotations: readOnly,
		},
		() =>
			answer((db) => {
				const configured = embedding();
				return collectStats(
					db,
					"unavailable" in configured
						? undefined
						: { model: configured.model, dim: configured.dim },
					"unavailable" in configured ? configured.unavailable : undefined,
				);
			}),
	);

	mcp.registerTool(
		"history",
		{
			description:
				"Who changed what, and when: changes to one note or the whole store, newest first. Give change for one change's full before and after.",
			inputSchema: {
				note: z.string().optional().describe("Only this note's changes."),
				who: z
					.string()
					.optional()
					.describe("Part of a client, project or name."),
				since: z.string().optional().describe("A date, such as 2026-11-01."),
				change: z
					.number()
					.int()
					.optional()
					.describe("A change id, for its full detail."),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe("Default 20."),
			},
			annotations: readOnly,
		},
		(args) =>
			answer((db) =>
				history(db, {
					note: args.note,
					who: args.who,
					since: args.since,
					change: args.change,
					limit: args.limit,
				}),
			),
	);

	return { server: mcp, close: () => store.close() };
}

function ok(value: unknown): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function refusal(value: Refusal): CallToolResult {
	return {
		isError: true,
		content: [{ type: "text", text: JSON.stringify(value) }],
	};
}

/** Thrown inside `StoreHandle.open` to end a call with a refusal. */
class Refused extends Error {
	constructor(readonly refusal: Refusal) {
		super(refusal.refused);
	}
}

/**
 * The server's hold on the store file.
 *
 * It opens lazily, reopens if the file was replaced (as the cutover does), and
 * on every call checks that the store is still in the layout this build knows.
 */
class StoreHandle {
	private db?: Database;
	private inode?: number;

	constructor(private readonly paths: LatticePaths) {}

	open(): Database {
		if (!existsSync(this.paths.store)) {
			throw new Refused({
				refused: `There is no store at ${this.paths.store}.`,
				next: "Run `lattice import` in a terminal to build it.",
			});
		}

		const inode = statSync(this.paths.store).ino;
		if (this.db !== undefined && inode !== this.inode) {
			this.close();
		}
		if (this.db === undefined) {
			try {
				this.db = openStore(this.paths.store);
			} catch (error) {
				throw new Refused({
					refused: error instanceof Error ? error.message : String(error),
					next: "Restart your session so it runs the current Lattice.",
				});
			}
			this.inode = inode;
		}

		const version = Number(
			this.db
				.query<{ value: string }, []>(
					"SELECT value FROM meta WHERE key = 'schema_version'",
				)
				.get()?.value,
		);
		if (version !== STORE_SCHEMA_VERSION) {
			throw new Refused({
				refused: `The store is now in layout ${version}; this server knows layout ${STORE_SCHEMA_VERSION}.`,
				next: "Restart your session so it runs the current Lattice.",
			});
		}
		return this.db;
	}

	/** The client as its handshake named it: "claude-code 2.1.316". */
	clientOf(mcp: McpServer): string | undefined {
		const client = mcp.server.getClientVersion();
		return client === undefined
			? undefined
			: `${client.name} ${client.version}`;
	}

	/**
	 * Note that a question was asked. The record only feeds `stats`, so a
	 * failure to write it (a busy database) never costs the answer.
	 */
	logQuestion(
		db: Database,
		entry: {
			project?: string;
			client?: string;
			question: string;
			results: number;
			degraded: boolean;
		},
	): void {
		try {
			db.query(
				`INSERT INTO recall_log (at, project, client, question, results, degraded)
				VALUES (?, ?, ?, ?, ?, ?)`,
			).run(
				new Date().toISOString(),
				entry.project ?? null,
				entry.client ?? null,
				entry.question,
				entry.results,
				entry.degraded ? 1 : 0,
			);
		} catch {
			// Bookkeeping only.
		}
	}

	close(): void {
		this.db?.close();
		this.db = undefined;
		this.inode = undefined;
	}
}
