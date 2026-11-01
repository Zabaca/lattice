/**
 * The Lattice MCP server: the note store's tools for an agent.
 *
 * One server runs per Claude Code session and opens the one shared store. It
 * holds no state of its own beyond the open database and the embedding
 * provider, and the provider loads its model only when a question or a write
 * first needs a vector. Every call re-checks the store's schema version, so a
 * server started before the layout changed refuses instead of misreading it.
 * Several servers write the same file at once; each write is a short
 * transaction that checks its guard inside it (see `store/write.ts`).
 *
 * Every tool answers in compact JSON. A refusal is an error result carrying
 * what happened and what to do next.
 *
 * Every session carries the tools' descriptions, so they are written short and
 * the list is sent without the schema boilerplate the SDK would add.
 */

import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	type CallToolResult,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type EmbeddingProvider, selectProvider } from "../embed/provider.js";
import {
	RerankConfigurationError,
	selectReranker,
} from "../rerank/provider.js";
import { dailyBackup, localDay } from "../store/backup.js";
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
import { revert } from "../store/undo.js";
import type { WriteContext, Written } from "../store/write.js";
import {
	archiveNote,
	confirmSections,
	createNewNote,
	renameNote,
	setFields,
} from "../store/write-note.js";
import {
	addSection,
	appendFinding,
	editNote,
	moveSection,
	removeSection,
} from "../store/write-text.js";
import { type LatticePaths, resolvePaths } from "../utils/paths.js";

export interface ServerOptions {
	env: Record<string, string | undefined>;
	/**
	 * The folder the process was started in, recorded with each question and
	 * change. Claude Code starts a server in the session's folder (checked
	 * 2026-11-01), so this is the process's own working directory. When it is
	 * not a project (the home folder, the root), the session's folder comes from
	 * `CLAUDE_PROJECT_DIR` and then from the client's roots.
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
	"Lattice holds what has been researched. Ask first: recall before researching or answering from memory. " +
	"Write back what you learn: create_note, append, edit. " +
	"Writes count at once, unchecked until confirmed; revert undoes one. " +
	"Old means from Lattice 1, maybe out of date.";

/** How long to wait for a client to list its roots. */
const ROOTS_TIMEOUT_MS = 2000;

interface ToolEntry {
	name: string;
	description: string;
	shape: z.ZodRawShape;
	readOnly: boolean;
}

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

	let project: { value: string | undefined } | undefined;
	/** The folder the session works in: the process's, else the environment's, else the client's roots. */
	const projectOf = async (): Promise<string | undefined> => {
		if (project === undefined) {
			project = { value: await findProject(mcp, options) };
		}
		return project.value;
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

	let backedUpOn = "";
	/** A write: the day's first one takes the day's snapshot before it changes anything. */
	const write = (
		work: (ctx: WriteContext) => Promise<Written | Refusal>,
	): Promise<CallToolResult> =>
		answer(async (db) => {
			let backup: string | undefined;
			const today = localDay(new Date());
			if (backedUpOn !== today) {
				try {
					dailyBackup(db, paths.backups);
					backedUpOn = today;
				} catch (error) {
					backup = `no snapshot today: ${error instanceof Error ? error.message : String(error)}`;
				}
			}
			const client = store.clientOf(mcp);
			const out = await work({
				db,
				provider: embedding,
				who: { client, project: await projectOf() },
			});
			return backup === undefined || isRefusal(out) ? out : { ...out, backup };
		});

	const listing: ToolEntry[] = [];
	const defineTool = <Shape extends z.ZodRawShape>(
		name: string,
		description: string,
		shape: Shape,
		run: (args: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>,
		readOnly = false,
	): void => {
		listing.push({ name, description, shape, readOnly });
		mcp.registerTool(
			name,
			{
				description,
				inputSchema: shape,
				annotations: readOnly ? { readOnlyHint: true } : undefined,
			},
			((args: z.infer<z.ZodObject<Shape>>) => run(args)) as never,
		);
	};

	// `reason` is a line on why; `by` is the caller's own name. The names say it.
	// Only the writes that add or judge content take them: the structural ones
	// (sections, fields, rename, archive) record the client and folder alone.
	const why = { reason: z.string().optional(), by: z.string().optional() };
	const note = z.string();

	// -- reading -------------------------------------------------------------

	defineTool(
		"recall",
		"Ask what is already known, before researching. Returns passages (or notes) with checked/old marks, and whether search ran in full.",
		{
			question: z.string().min(1),
			best: z.enum(["passages", "notes"]).optional(),
			limit: z.number().optional().describe("Default 5."),
			type: z.string().optional(),
			tag: z.string().optional(),
			notes: z.array(z.string()).optional().describe("Only these."),
			include_archived: z.boolean().optional(),
		},
		(args) =>
			answer(async (db) => {
				const client = store.clientOf(mcp);
				const result = await recall(
					{ db, provider: embedding, reranker: selectReranker(options.env) },
					{
						question: args.question,
						best: args.best,
						limit: args.limit,
						type: args.type,
						tag: args.tag,
						notes: args.notes,
						includeArchived: args.include_archived,
					},
				);
				store.logQuestion(db, {
					project: await projectOf(),
					client,
					question: args.question,
					results: (result.passages ?? result.notes ?? []).length,
					degraded: result.search !== "full",
				});
				return result;
			}),
		true,
	);

	defineTool(
		"read_note",
		"A note's outline (section ids, sizes, checked) and text. A long note gives only its first section; ask for more by id. version: an earlier version.",
		{
			name: note,
			sections: z.array(z.string()).optional(),
			version: z.number().optional(),
		},
		(args) =>
			answer((db) =>
				readNote(db, args.name, {
					sections: args.sections,
					version: args.version,
				}),
			),
		true,
	);

	defineTool(
		"list_notes",
		"Browse notes by type or tag, paged.",
		{
			type: z.string().optional(),
			tag: z.string().optional(),
			include_archived: z.boolean().optional(),
			limit: z.number().optional().describe("Default 20."),
			offset: z.number().optional(),
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
		true,
	);

	defineTool(
		"links",
		"A note's links out, links in, and links to notes not written yet.",
		{ name: note },
		(args) => answer((db) => noteLinks(db, args.name)),
		true,
	);

	defineTool(
		"stats",
		"Counts, search health, recent changes, notes most wanted, last backup.",
		{},
		() =>
			answer((db) => {
				const configured = embedding();
				return collectStats(
					db,
					"unavailable" in configured
						? undefined
						: { model: configured.model, dim: configured.dim },
					"unavailable" in configured ? configured.unavailable : undefined,
					paths.backups,
				);
			}),
		true,
	);

	defineTool(
		"history",
		"Changes to a note or the whole store, newest first. change gives one in full.",
		{
			note: z.string().optional(),
			who: z.string().optional(),
			since: z.string().optional(),
			change: z.number().optional(),
			limit: z.number().optional(),
		},
		(args) => answer((db) => history(db, args)),
		true,
	);

	// -- writing -------------------------------------------------------------

	defineTool(
		"create_note",
		"Create a note, named from its type and title; refused if taken.",
		{
			type: z.string(),
			title: z.string(),
			description: z.string().optional(),
			text: z.string().optional(),
			tags: z.array(z.string()).optional(),
			sources: z.array(z.string()).optional(),
			...why,
		},
		(args) => write((ctx) => createNewNote(ctx, args)),
	);

	defineTool(
		"edit",
		"All or none. Each edit replaces a quoted passage (old, new; must occur once) or a whole section (section, text with heading, version read).",
		{
			note,
			edits: z.array(
				z.object({
					section: z.string().optional(),
					old: z.string().optional(),
					new: z.string().optional(),
					text: z.string().optional(),
					version: z.number().optional(),
				}),
			),
			...why,
		},
		(args) => write((ctx) => editNote(ctx, args)),
	);

	defineTool(
		"add_section",
		'Add a section after one, or at "start" or "end" (default).',
		{
			note,
			heading: z.string(),
			text: z.string().optional(),
			after: z.string().optional(),
			depth: z.number().optional(),
		},
		(args) => write((ctx) => addSection(ctx, args)),
	);

	defineTool(
		"remove_section",
		"Remove a section (and its subsections if with_subsections). version: refused if it changed.",
		{
			note,
			section: z.string(),
			with_subsections: z.boolean().optional(),
			version: z.number().optional(),
		},
		(args) => write((ctx) => removeSection(ctx, args)),
	);

	defineTool(
		"move_section",
		"Move a section and its subsections after another.",
		{
			note,
			section: z.string(),
			after: z.string(),
		},
		(args) => write((ctx) => moveSection(ctx, args)),
	);

	defineTool(
		"append",
		"Add a finding to a section (default Key findings, else the last). A source joins the note's sources.",
		{
			note,
			text: z.string(),
			section: z.string().optional(),
			source: z.string().optional(),
			...why,
		},
		(args) => write((ctx) => appendFinding(ctx, args)),
	);

	defineTool(
		"set_fields",
		"Set title, description, status, stale_after (empty clears) or tags; add_ and remove_ adjust tags and sources. version: refused if the note moved on.",
		{
			note,
			version: z.number().optional(),
			title: z.string().optional(),
			description: z.string().optional(),
			status: z.string().optional(),
			stale_after: z.string().optional(),
			tags: z.array(z.string()).optional(),
			add_tags: z.array(z.string()).optional(),
			remove_tags: z.array(z.string()).optional(),
			add_sources: z.array(z.string()).optional(),
			remove_sources: z.array(z.string()).optional(),
		},
		(args) => write((ctx) => setFields(ctx, args)),
	);

	defineTool(
		"rename_note",
		"New title or type, so a new name. The old name keeps working.",
		{ note, title: z.string().optional(), type: z.string().optional() },
		(args) => write((ctx) => renameNote(ctx, args)),
	);

	defineTool(
		"archive_note",
		"Hide a note from recall and list_notes; revert brings it back.",
		{ note },
		(args) => write((ctx) => archiveNote(ctx, args)),
	);

	defineTool(
		"confirm",
		"Mark sections checked (id and the version you read), once confirmed against sources. james_said: his words, only if James confirmed it in this session.",
		{
			note,
			sections: z.array(z.object({ id: z.string(), version: z.number() })),
			james_said: z.string().optional(),
			...why,
		},
		(args) => write((ctx) => confirmSections(ctx, args)),
	);

	defineTool(
		"revert",
		"Undo one change, or put a note back as at a version (note, version, and current: the version you read). Refused if a later change touched the same section or field.",
		{
			change: z.number().optional(),
			note: z.string().optional(),
			version: z.number().optional(),
			current: z.number().optional(),
			...why,
		},
		(args) => write((ctx) => revert(ctx, args)),
	);

	// The SDK would add a `$schema` and `additionalProperties: false` to every
	// tool; across the list that is hundreds of characters every session carries
	// for nothing, so the list is sent without them.
	mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: listing.map((entry) => ({
			name: entry.name,
			description: entry.description,
			inputSchema: plainSchema(entry.shape),
			...(entry.readOnly ? { annotations: { readOnlyHint: true } } : {}),
		})),
	}));

	return { server: mcp, close: () => store.close() };
}

/** A tool's input as plain JSON Schema, without the boilerplate. */
function plainSchema(shape: z.ZodRawShape): {
	type: "object";
	properties: Record<string, unknown>;
	required?: string[];
} {
	const full = z.toJSONSchema(z.object(shape), { io: "input" }) as Record<
		string,
		unknown
	>;
	const strip = (value: unknown): unknown => {
		if (Array.isArray(value)) {
			return value.map(strip);
		}
		if (value !== null && typeof value === "object") {
			const out: Record<string, unknown> = {};
			for (const [key, entry] of Object.entries(value)) {
				if (key === "$schema" || key === "additionalProperties") {
					continue;
				}
				out[key] = strip(entry);
			}
			return out;
		}
		return value;
	};
	return strip(full) as ReturnType<typeof plainSchema>;
}

/**
 * The folder the session works in. Claude Code starts a user-scope server in
 * it, so the process's own folder is the answer unless it is clearly not a
 * project (the home folder or the root); then the environment's
 * `CLAUDE_PROJECT_DIR`, then the first root the client reports.
 */
async function findProject(
	mcp: McpServer,
	options: ServerOptions,
): Promise<string | undefined> {
	const plausible = (dir: string | undefined): dir is string =>
		dir !== undefined && dir !== "" && dir !== "/" && dir !== homedir();
	if (plausible(options.project)) {
		return options.project;
	}
	const fromEnv = options.env.CLAUDE_PROJECT_DIR?.trim();
	if (plausible(fromEnv)) {
		return fromEnv;
	}
	if (mcp.server.getClientCapabilities()?.roots !== undefined) {
		try {
			const { roots } = await mcp.server.listRoots(undefined, {
				timeout: ROOTS_TIMEOUT_MS,
			});
			const first = roots.find((root) => root.uri.startsWith("file://"));
			if (first !== undefined) {
				return fileURLToPath(first.uri);
			}
		} catch {
			// The client would not say; the change records only who it was.
		}
	}
	return undefined;
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
