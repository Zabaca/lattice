/**
 * Search-quality baseline on a SciFact subsample.
 *
 * SciFact (BEIR) is a corpus of scientific abstracts with human relevance
 * judgments per query. This script samples it, files each abstract as a
 * Lattice document, syncs it with the real embedding model and scores
 * `lattice search` against the judgments — hit@k and MRR@10 at document
 * level. Every Lattice command goes through `runCli`, the seam the tests use.
 *
 *   bun run eval:scifact [--docs 1000] [--queries 100] [--seed 42]
 *                        [--limit 10] [--expand] [--fresh] [--json]
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { runCli } from "../cli/run.js";
import { resolvePaths } from "../utils/paths.js";

const DATASET_URL =
	"https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip";
const CACHE_DIR = resolve(import.meta.dir, "../../eval-cache");
const DATASET_DIR = join(CACHE_DIR, "scifact");
const DOC_TYPE = "Abstract";
const DOC_DIR = "abstract";

interface Options {
	docs: number;
	queries: number;
	seed: number;
	limit: number;
	expand: boolean;
	fresh: boolean;
	json: boolean;
	home: string;
}

interface CorpusDoc {
	id: string;
	title: string;
	text: string;
}

interface Query {
	id: string;
	text: string;
}

interface QueryResult {
	id: string;
	rank: number | null;
	degraded: boolean;
	ms: number;
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const log = (line: string) => {
		if (!options.json) console.error(line);
	};

	await ensureDataset(log);
	const corpus = readCorpus();
	const queries = readQueries();
	const qrels = readQrels();

	const testQueries = queries.filter((query) => qrels.has(query.id));
	const rng = mulberry32(options.seed);
	const sampledQueries = shuffle(testQueries, rng).slice(0, options.queries);
	const sampledDocs = sampleDocs(corpus, sampledQueries, qrels, options, rng);

	const env: Record<string, string | undefined> = {
		...process.env,
		LATTICE_HOME: options.home,
		LATTICE_EMBED_PROVIDER: "local",
		// One weights cache for every eval home, so a new sample size does not
		// download the model again.
		LATTICE_MODEL_DIR:
			process.env.LATTICE_MODEL_DIR ?? join(CACHE_DIR, "models"),
	};
	const paths = resolvePaths(env);

	if (options.fresh && existsSync(paths.home)) {
		rmSync(paths.home, { recursive: true, force: true });
	}
	if (!existsSync(paths.database)) {
		await buildHome(env, paths.docs, sampledDocs, log);
	}

	const status = await runCli({ argv: ["status"], env });
	if (status.code !== 0)
		throw new Error(`lattice status failed: ${status.stderr}`);
	if (!status.stdout.includes("Up to date.")) {
		throw new Error(`Eval home is not synced:\n${status.stdout}`);
	}
	if (status.stdout.includes("Frontmatter problems")) {
		throw new Error(`Eval home has frontmatter problems:\n${status.stdout}`);
	}
	const model = /^Model:\s+(.+)$/m.exec(status.stdout)?.[1] ?? "unknown";

	log(`Searching ${sampledQueries.length} queries...`);
	const results: QueryResult[] = [];
	for (const query of sampledQueries) {
		const argv = [
			"search",
			query.text,
			"--json",
			"--limit",
			String(options.limit),
		];
		if (!options.expand) argv.push("--no-expand");
		const started = performance.now();
		const result = await runCli({ argv, env });
		const ms = performance.now() - started;
		if (result.code !== 0) {
			throw new Error(`search failed for ${query.id}: ${result.stderr}`);
		}
		const parsed = JSON.parse(result.stdout) as {
			degraded: boolean;
			hits: Array<{ path: string }>;
		};
		const relevant = qrels.get(query.id) ?? new Set<string>();
		const ids = parsed.hits.map((hit) => basename(hit.path, ".md"));
		const index = ids.findIndex((id) => relevant.has(id));
		results.push({
			id: query.id,
			rank: index === -1 ? null : index + 1,
			degraded: parsed.degraded,
			ms,
		});
	}

	const metrics = score(results);
	const record = {
		dataset: "scifact",
		docs: sampledDocs.length,
		queries: sampledQueries.length,
		seed: options.seed,
		limit: options.limit,
		expand: options.expand,
		model,
		...metrics,
	};

	if (options.json) {
		console.log(JSON.stringify(record, null, 2));
	} else {
		console.log(renderTable(record));
	}
	if (metrics.degraded > 0) process.exitCode = 1;
}

function parseOptions(argv: string[]): Options {
	const flags = new Map<string, string | true>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
		const name = arg.slice(2);
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			flags.set(name, next);
			i++;
		} else {
			flags.set(name, true);
		}
	}
	const int = (name: string, fallback: number): number => {
		const raw = flags.get(name);
		if (raw === undefined) return fallback;
		const n = Number(raw);
		if (!Number.isInteger(n) || n <= 0) {
			throw new Error(`--${name} must be a positive integer`);
		}
		return n;
	};
	const docs = int("docs", 1000);
	const queries = int("queries", 100);
	const homeFlag = flags.get("home");
	return {
		docs,
		queries,
		seed: int("seed", 42),
		limit: int("limit", 10),
		expand: flags.has("expand"),
		fresh: flags.has("fresh"),
		json: flags.has("json"),
		home:
			typeof homeFlag === "string"
				? resolve(homeFlag)
				: join(CACHE_DIR, `home-${docs}-${queries}-${int("seed", 42)}`),
	};
}

async function ensureDataset(log: (line: string) => void): Promise<void> {
	if (existsSync(join(DATASET_DIR, "corpus.jsonl"))) return;
	mkdirSync(CACHE_DIR, { recursive: true });
	const zip = join(CACHE_DIR, "scifact.zip");
	if (!existsSync(zip)) {
		log(`Downloading ${DATASET_URL}...`);
		const response = await fetch(DATASET_URL);
		if (!response.ok) {
			throw new Error(
				`Download failed: ${response.status} ${response.statusText}`,
			);
		}
		await Bun.write(zip, await response.arrayBuffer());
	}
	log("Extracting...");
	const unzip = Bun.spawnSync(["unzip", "-oq", zip, "-d", CACHE_DIR]);
	if (unzip.exitCode !== 0) {
		throw new Error(`unzip failed: ${unzip.stderr.toString()}`);
	}
	if (!existsSync(join(DATASET_DIR, "corpus.jsonl"))) {
		throw new Error(
			`Archive did not contain scifact/corpus.jsonl under ${CACHE_DIR}`,
		);
	}
}

function readJsonl<T>(file: string): T[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as T);
}

function readCorpus(): CorpusDoc[] {
	return readJsonl<{ _id: string; title: string; text: string }>(
		join(DATASET_DIR, "corpus.jsonl"),
	).map((row) => ({ id: String(row._id), title: row.title, text: row.text }));
}

function readQueries(): Query[] {
	return readJsonl<{ _id: string; text: string }>(
		join(DATASET_DIR, "queries.jsonl"),
	).map((row) => ({ id: String(row._id), text: row.text }));
}

/** Query id to the set of corpus ids judged relevant (score > 0). */
function readQrels(): Map<string, Set<string>> {
	const qrels = new Map<string, Set<string>>();
	const lines = readFileSync(join(DATASET_DIR, "qrels", "test.tsv"), "utf8")
		.split("\n")
		.slice(1);
	for (const line of lines) {
		if (line.trim() === "") continue;
		const [queryId, corpusId, score] = line.split("\t");
		if (Number(score) <= 0) continue;
		let set = qrels.get(queryId);
		if (set === undefined) {
			set = new Set();
			qrels.set(queryId, set);
		}
		set.add(corpusId);
	}
	return qrels;
}

/** Every judged-relevant abstract, padded with random ones up to `--docs`. */
function sampleDocs(
	corpus: CorpusDoc[],
	queries: Query[],
	qrels: Map<string, Set<string>>,
	options: Options,
	rng: () => number,
): CorpusDoc[] {
	const required = new Set<string>();
	for (const query of queries) {
		for (const id of qrels.get(query.id) ?? []) required.add(id);
	}
	const byId = new Map(corpus.map((doc) => [doc.id, doc]));
	const chosen: CorpusDoc[] = [];
	for (const id of required) {
		const doc = byId.get(id);
		if (doc !== undefined) chosen.push(doc);
	}
	const rest = shuffle(
		corpus.filter((doc) => !required.has(doc.id)),
		rng,
	);
	for (const doc of rest) {
		if (chosen.length >= options.docs) break;
		chosen.push(doc);
	}
	return chosen;
}

async function buildHome(
	env: Record<string, string | undefined>,
	docs: string,
	sampled: CorpusDoc[],
	log: (line: string) => void,
): Promise<void> {
	// A previous home with the same parameters is the cheapest model cache.
	const init = await runCli({ argv: ["init"], env, onProgress: log });
	if (init.code !== 0) throw new Error(`lattice init failed: ${init.stderr}`);

	const dir = join(docs, DOC_DIR);
	mkdirSync(dir, { recursive: true });
	for (const doc of sampled) {
		writeFileSync(join(dir, `${doc.id}.md`), renderDoc(doc));
	}
	log(`Wrote ${sampled.length} abstracts to ${dir}. Syncing...`);

	const sync = await runCli({ argv: ["sync"], env, onProgress: log });
	if (sync.code !== 0) throw new Error(`lattice sync failed: ${sync.stderr}`);
	log(sync.stdout.trim());
}

function renderDoc(doc: CorpusDoc): string {
	const title = doc.title.trim() || `Abstract ${doc.id}`;
	return [
		"---",
		`type: ${DOC_TYPE}`,
		`title: ${yamlString(title)}`,
		`description: ${yamlString(firstSentence(doc.text))}`,
		"---",
		"",
		`# ${title}`,
		"",
		doc.text.trim(),
		"",
	].join("\n");
}

function firstSentence(text: string): string {
	const match = /^.*?[.!?](?=\s|$)/s.exec(text.trim());
	return (match?.[0] ?? text.trim().slice(0, 200)).replace(/\s+/g, " ");
}

function yamlString(value: string): string {
	return JSON.stringify(value);
}

function score(results: QueryResult[]) {
	const n = results.length;
	const hitAt = (k: number) =>
		results.filter((r) => r.rank !== null && r.rank <= k).length / n;
	const mrr =
		results.reduce((sum, r) => sum + (r.rank === null ? 0 : 1 / r.rank), 0) / n;
	const totalMs = results.reduce((sum, r) => sum + r.ms, 0);
	return {
		hitAt1: hitAt(1),
		hitAt5: hitAt(5),
		hitAt10: hitAt(10),
		mrrAt10: mrr,
		degraded: results.filter((r) => r.degraded).length,
		msPerQuery: totalMs / n,
	};
}

function renderTable(
	record: ReturnType<typeof score> & Record<string, unknown>,
) {
	const rows: Array<[string, string]> = [
		["Documents", String(record.docs)],
		["Queries", String(record.queries)],
		["Seed", String(record.seed)],
		["Model", String(record.model)],
		["Expand", record.expand ? "on" : "off"],
		["hit@1", record.hitAt1.toFixed(3)],
		["hit@5", record.hitAt5.toFixed(3)],
		["hit@10", record.hitAt10.toFixed(3)],
		["MRR@10", record.mrrAt10.toFixed(3)],
		["Degraded", String(record.degraded)],
		["ms/query", record.msPerQuery.toFixed(0)],
	];
	const width = Math.max(...rows.map(([label]) => label.length));
	return rows
		.map(([label, value]) => `${label.padEnd(width)}  ${value}`)
		.join("\n");
}

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffle<T>(items: T[], rng: () => number): T[] {
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy;
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
