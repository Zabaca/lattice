/**
 * What the store's tests share: a fresh home, notes written into it, a store
 * built by the CLI's own `import`, and an in-process MCP client on the server.
 * Not part of the shipped build; nothing in `src/main.ts` reaches it.
 */

import { expect } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runCli } from "../cli/run.js";
import { createLatticeServer } from "../mcp/server.js";
import { resolvePaths } from "../utils/paths.js";

/** The deterministic provider every test runs on unless it says otherwise. */
export const HASH_ENV = { LATTICE_EMBED_PROVIDER: "hash" };

export function freshHome(): string {
	return mkdtempSync(join(tmpdir(), "lattice-store-test-"));
}

/** Write files (path to text) under a folder of the home. */
export function writeFiles(
	home: string,
	folder: string,
	files: Record<string, string>,
): void {
	for (const [path, text] of Object.entries(files)) {
		const full = join(home, folder, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
}

/** A note file: frontmatter lines, a blank line, then the body. */
export function note(front: string[], body: string): string {
	return `---\n${front.join("\n")}\n---\n\n${body}`;
}

const LONG_SECTION = `${"Fusion keeps the best of two rankings without trusting either's scores. ".repeat(40)}\n`;

/**
 * The reranker note's three sections, each long enough to be a passage of its
 * own (the chunker folds a section under about 160 characters into the next).
 */
export const RERANKER_SECTIONS = [
	"# Jev as a reranker\n\nThis note records where Jev fits in a search pipeline: the candidate generator stays as it is, and Jev judges only the shortlist the fusion step hands it.\n\n",
	"## Key findings\n\nReciprocal rank fusion merges two rankings without trusting either one's scores. Jev then rereads the shortlist and judges whether each passage actually answers the question asked.\n\n",
	"## Cost\n\nA reranker call costs a fraction of a cent for a whole shortlist, because input is billed per million tokens and output is free. See [[/topic/jev]] for the model itself.\n",
];

/** Today's shape: typed notes in type folders, one long, one citing another. */
export const BUNDLE: Record<string, string> = {
	"topic/jev.md": note(
		[
			"type: Topic",
			"title: Jev",
			"description: TypeSafe's System One model, which returns typed judgments.",
			"status: draft",
			"tags: [jev, typesafe]",
			"generated: { by: agent:claude-code/research, at: 2026-09-21T13:29:37Z }",
		],
		"# Jev\n\nJev returns typed answers with a probability.\n\n## Research\n\n- [Jev as a reranker](../research/jev-reranker.md)\n\n- [[/research/jev-costs]] has not been written.\n",
	),
	"research/jev-reranker.md": note(
		[
			"type: Research",
			"title: Jev as a reranker",
			"description: Where Jev fits in a search pipeline.",
			"status: draft",
			"tags: [jev, search]",
			"sources:",
			"  - ../topic/jev.md",
			"  - https://example.com/jev",
		],
		RERANKER_SECTIONS.join(""),
	),
	"research/exa-limits.md": note(
		[
			"type: Research",
			"title: What Exa search is not good for",
			"description: |-\n  Exa misses exact phrases.\n  Second line of the description.",
			"tags: [exa]",
		],
		"# What Exa search is not good for\n\nExa neural search cannot match an exact quoted phrase.\n",
	),
	"research/long-note.md": note(
		["type: Research", "title: A long note", "tags: [long]"],
		`# A long note\n\nOpening.\n\n## One\n\n${LONG_SECTION}\n## Two\n\n${LONG_SECTION}\n## Three\n\n${LONG_SECTION}`,
	),
};

/**
 * Lattice 2's file index of `BUNDLE`, as `~/.lattice/lattice.db` was before the
 * cutover. It is a binary built by Lattice 2's own sync (main at 5949d1d, with
 * LATTICE_EMBED_PROVIDER=hash: init, then sync, on a home holding `BUNDLE`; then
 * VACUUMed to 1 KiB pages to keep the file small), kept because the code that
 * built the index is gone and the import still reads one: it copies the vectors
 * and measures search against it. Change `BUNDLE` and the import tests that copy
 * its vectors fail until it is rebuilt that way.
 */
export const FILE_INDEX = join(
	import.meta.dir,
	"..",
	"fixtures",
	"index",
	"lattice.db",
);

/** Put Lattice 2's file index of `BUNDLE` in the home. */
export function writeFileIndex(home: string): void {
	copyFileSync(FILE_INDEX, resolvePaths({ LATTICE_HOME: home }).fileIndex);
}

/** Lattice 1's shape: no types, subject folders, an index.md, a stub, a dead link. */
export const LIBRARY = {
	docs: {
		"jev/reranking.md": note(
			[
				"title: Reranking with Jev",
				"description: An early look at reranking search results.",
				"tags: [jev, reranker]",
				"created: 2026-01-05",
				"original_path: /old/jev/reranking.md",
				"status: archived",
			],
			"An early paragraph on reranking before any heading.\n\n## Reranking\n\nA reranker rereads the shortlist. See [limits](../exa/limits.md) and [gone](missing.md).\n",
		),
		"exa/limits.md": note(
			["title: Exa limits", "tags: [exa]", "status: archived"],
			"# Exa limits\n\nExa neural search misses exact phrases.\n",
		),
		"problems/index.md": note(
			["title: Problems", "status: archived"],
			"# Problems\n\nA list of old problems.\n",
		),
		"README.md": note(
			["title: Library", "status: archived"],
			"# Library\n\nGenerated index of titles zzgenerated.\n",
		),
	},
	lost: {
		"jev/gone.md": note(
			[
				"title: Gone",
				"description: Summary only.",
				"full_text: lost",
				"status: archived",
			],
			"# Gone\n\n> Full text lost. Only the metadata below survives.\n",
		),
	},
};

/** Write the library fixture under the home's `archive/v1`. */
export function writeLibrary(home: string): void {
	writeFiles(home, "archive/v1/docs", LIBRARY.docs);
	writeFiles(home, "archive/v1/lost", LIBRARY.lost);
}

/** A home with the bundle written, and the library when asked, and its store built. */
export async function storeHome(
	options: { library?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<string> {
	const home = freshHome();
	writeFiles(home, "docs", BUNDLE);
	if (options.library === true) {
		writeLibrary(home);
	}
	await buildStore(home, [], options.env);
	return home;
}

export function cli(
	home: string,
	argv: string[],
	env: Record<string, string | undefined> = {},
) {
	return runCli({
		argv,
		env: { ...HASH_ENV, ...env, LATTICE_HOME: home },
	});
}

/** Build the home's store with `lattice import`, which must succeed. */
export async function buildStore(
	home: string,
	argv: string[] = [],
	env: Record<string, string | undefined> = {},
): Promise<void> {
	const result = await cli(home, ["import", ...argv], env);
	if (result.code !== 0) {
		throw new Error(`import failed:\n${result.stdout}${result.stderr}`);
	}
	expect(result.stderr).toBe("");
}

export interface Connected {
	client: Client;
	/** Call a tool; the answer parsed from its JSON text. */
	call(
		name: string,
		args?: Record<string, unknown>,
	): Promise<{ isError: boolean; body: Body }>;
	close(): Promise<void>;
}

/** A tool's answer, parsed. Read deeper into it with `at`. */
export type Body = Record<string, unknown>;

/** The value at a path of keys and indexes in a tool's answer. */
export function at(value: unknown, ...path: Array<string | number>): unknown {
	let here = value;
	for (const step of path) {
		if (typeof here !== "object" || here === null) {
			return undefined;
		}
		here = (here as Record<string | number, unknown>)[step];
	}
	return here;
}

/** An MCP client talking to a fresh server on the home, over the real protocol. */
export async function connect(
	home: string,
	options: {
		env?: Record<string, string | undefined>;
		project?: string;
	} = {},
): Promise<Connected> {
	const { server, close } = createLatticeServer({
		env: { ...HASH_ENV, ...options.env, LATTICE_HOME: home },
		project: options.project,
	});
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-client", version: "1.2.3" });
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

	return {
		client,
		async call(name, args = {}) {
			const result = await client.callTool({ name, arguments: args });
			const content = result.content as Array<{ type: string; text: string }>;
			return {
				isError: result.isError === true,
				body: JSON.parse(content[0].text),
			};
		},
		async close() {
			await client.close();
			await server.close();
			close();
		},
	};
}
