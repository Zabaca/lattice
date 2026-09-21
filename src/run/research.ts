/**
 * The research skill as a state machine.
 *
 *   index → assess → { answered | web → write → check → link → sync → verify }
 *
 * `lattice run` found what to cite; what a research-jev session then spent
 * its turns on was reading the kept passages back, deciding whether to
 * write, writing, and following ten steps of OKF rules unevenly. Those
 * steps are these states. Code drives: the index loop is `runLoop` over the
 * index alone, the decision is a rule over what it kept, the web loop is
 * `runLoop` over the web alone on the same queries, one writer call turns
 * the kept passages into a document, and code checks the document, files
 * it under its type, links it from its hub, syncs and reads the relations
 * back. The kept text goes to the writer and never to the caller.
 *
 * Everything that touches a model, the web or the disk comes in through
 * `ResearchDeps`, so the command wires it and a test scripts it.
 */

import { posix } from "node:path";
import matter from "gray-matter";
import type { TextProvider } from "../llm/provider.js";
import type { SyncReport } from "../sync/index.js";
import { normalizeTarget } from "../sync/links.js";
import {
	conceptProblem,
	type OkfConcept,
	parseConcept,
	typeDirectory,
} from "../sync/okf.js";
import {
	type Decision,
	HUB_TRAILER,
	retryPrompt,
	writePrompt,
} from "../write/prompt.js";
import type { Writer } from "../write/provider.js";
import {
	type Candidate,
	COMPLETENESS_LEVELS,
	type HubCandidate,
	type Judge,
} from "./judge.js";
import {
	canonicalUrl,
	type Exit,
	type PageRead,
	type RunResult,
	runLoop,
	type WebSearch,
} from "./runner.js";

/** Where a research document is filed: the directory of `type: Research`. */
export const RESEARCH_DIR = "research";
/** Where a hub is filed: the directory of `type: Topic`. */
export const TOPIC_DIR = "topic";
/** The provenance the written document carries. */
export const GENERATED_BY = "agent:lattice/research";
/** The hub section a new document is linked from. */
const HUB_SECTION = "## Research";

export interface DocumentRelations {
	outlinks: string[];
	backlinks: string[];
	unresolved: string[];
}

export interface ResearchDeps {
	searchIndex(query: string): Promise<Candidate[]>;
	/** The few hubs the index ranks highest for the topic, for the judge to place it under. */
	listHubs(topic: string): Promise<HubCandidate[]>;
	/** Absent when no web searcher could be built; `options.webReason` says why. */
	searchWeb?(query: string, round: number): Promise<WebSearch>;
	readPage?(question: string, url: string): Promise<PageRead>;
	judge: Judge;
	llm: TextProvider;
	writer: Writer;
	bundle: {
		/** A document's text by bundle path, or undefined when there is no file. */
		read(path: string): string | undefined;
		write(path: string, text: string): void;
		exists(path: string): boolean;
	};
	/** Index the bundle after the write. Null when nothing needed indexing: an extension that changed nothing. */
	sync(): Promise<SyncReport | null>;
	/** The written document's relations, as paths; undefined when it is not indexed. */
	relations(path: string): DocumentRelations | undefined;
	now?(): Date;
}

export interface ResearchOptions {
	topic: string;
	maxRewrites: number;
	/** Why there is no web leg, when `searchWeb` is absent. */
	webReason?: string;
}

interface LoopSummary {
	exit: Exit;
	tried: string[];
	completeness: number;
	completenessLabel: string;
}

export interface ResearchResult {
	topic: string;
	decision: Decision;
	index: LoopSummary & { kept: string[] };
	web:
		| (LoopSummary & {
				kept: Array<{ ref: string; leg?: string; read?: boolean }>;
		  })
		| null;
	document: {
		path: string;
		action: "written" | "extended";
		title: string;
		hub: string | null;
		/** Where the hub came from: kept by the index run, placed by the judge, or written by this run from the writer's naming of the subject. */
		hubFrom: "index" | "judge" | "created" | null;
		/** The judge's probability for the best shortlisted hub, when it was asked; below the bar it is why the writer named one. */
		hubProbability: number | null;
		sources: string[];
		/** Citations the writer invented, removed before the write. */
		droppedSources: string[];
		outlinks: string[];
		backlinks: string[];
		unresolved: string[];
	} | null;
	/** Why nothing was written, when nothing was. */
	reason: string | null;
	cost: {
		llmUsd: number;
		llmCalls: number;
		jevInputTokens: number;
		webUsd: number;
		writeUsd: number;
		writeCalls: number;
	};
	webReason: string | null;
	/** The writer's last document and what was wrong with it, when it was refused. */
	draft?: { text: string; problems: string[] };
}

export async function researchLoop(
	deps: ResearchDeps,
	options: ResearchOptions,
): Promise<ResearchResult> {
	const { topic, maxRewrites } = options;
	const cost = {
		llmUsd: 0,
		llmCalls: 0,
		jevInputTokens: 0,
		webUsd: 0,
		writeUsd: 0,
		writeCalls: 0,
	};
	const add = (run: RunResult): void => {
		cost.llmUsd += run.cost.llmUsd;
		cost.llmCalls += run.cost.llmCalls;
		cost.jevInputTokens += run.cost.jevInputTokens;
		cost.webUsd += run.cost.webUsd;
	};

	// index: the question at this point is whether the bundle already has
	// the answer, so the web is not searched.
	const index = await runLoop(
		{ searchIndex: deps.searchIndex, judge: deps.judge, llm: deps.llm },
		{ question: topic, maxRewrites },
	);
	add(index);

	// assess: a rule over what the judge kept, so no second judge request.
	const assessment = assess(index);
	const result: ResearchResult = {
		topic,
		decision: assessment.decision,
		index: { ...summarise(index), kept: index.kept.map((c) => c.ref) },
		web: null,
		document: null,
		reason: null,
		cost,
		webReason: null,
	};
	if (assessment.decision === "answered") {
		result.reason = `the index already holds ${quote(index.completenessLabel)}`;
		return result;
	}
	if (deps.searchWeb === undefined) {
		result.reason = `no web searcher: ${options.webReason ?? "none configured"}`;
		return result;
	}

	// web: the same queries, so the plan state is skipped and no second
	// planning call is paid; a rewrite re-plans if the round falls short.
	const web = await runLoop(
		{
			searchWeb: deps.searchWeb,
			readPage: deps.readPage,
			judge: deps.judge,
			llm: deps.llm,
		},
		{ question: topic, tried: index.tried, maxRewrites },
	);
	add(web);
	result.web = {
		...summarise(web),
		kept: web.kept.map((c) => ({
			ref: c.ref,
			...(c.leg === undefined ? {} : { leg: c.leg }),
			...(c.read === undefined ? {} : { read: c.read }),
		})),
	};
	result.webReason = web.webReason;
	if (web.exit === "give_up") {
		result.reason = `the web run gave up at ${quote(web.completenessLabel)}`;
		return result;
	}
	if (web.kept.length === 0) {
		result.reason = "the web run kept nothing";
		return result;
	}

	// hub: when the index run kept none, the judge places the question under
	// one of the few hubs the index ranks highest, so a hub the queries never
	// surfaced is still found and "none fits" is a verdict, not an absence.
	let hub = assessment.hub;
	let hubFrom: "index" | "judge" | "created" | null =
		hub === null ? null : "index";
	let hubProbability: number | null = null;
	if (hub === null) {
		const hubs = await deps.listHubs(topic);
		if (hubs.length > 0) {
			const placement = await deps.judge.place(topic, hubs);
			cost.jevInputTokens += placement.inputTokens;
			hubProbability = placement.probability;
			if (placement.hub !== null) {
				hub = placement.hub;
				hubFrom = "judge";
			}
		}
	}

	// write: one call, with the kept passages and the rules; the check
	// gives it one more if the document breaks them.
	const existingPath = assessment.existing;
	const existingRaw =
		existingPath === undefined ? undefined : deps.bundle.read(existingPath);
	if (existingPath !== undefined && existingRaw === undefined) {
		throw new Error(
			`${existingPath} is indexed but not in the bundle; run \`lattice sync\` and try again.`,
		);
	}
	const existing =
		existingRaw === undefined ? undefined : parseConcept(existingRaw);
	const hubCitation = hub === null ? undefined : citationOf(hub);
	const allowed = allowedSources(index.kept, web.kept, existingPath);
	const prompt = writePrompt({
		topic,
		decision: assessment.decision,
		existing: existingRaw,
		web: web.kept,
		index: index.kept,
		allowedSources: [...allowed.paths.values(), ...allowed.urls.values()],
		hub: hubCitation,
	});
	const now = (deps.now?.() ?? new Date())
		.toISOString()
		.replace(/\.\d{3}Z$/, "Z");
	const checkInput = {
		decision: assessment.decision,
		existingPath,
		existing,
		allowed,
		hub,
		exists: deps.bundle.exists,
		now,
	};
	let completion = await deps.writer.write(prompt);
	cost.writeUsd += completion.costUsd;
	cost.writeCalls++;
	let checked = checkDraft(completion.text, checkInput);
	if (!checked.ok) {
		completion = await deps.writer.write(
			retryPrompt(prompt, completion.text, checked.problems),
		);
		cost.writeUsd += completion.costUsd;
		cost.writeCalls++;
		checked = checkDraft(completion.text, checkInput);
	}
	if (!checked.ok) {
		result.reason = `the writer's document was refused twice: ${checked.problems.join("; ")}`;
		result.draft = { text: completion.text, problems: checked.problems };
		return result;
	}

	// link: the file under its type directory, and a line in the hub so the
	// document has a backlink and the hub stays where a reader starts. A hub
	// the writer named is written first, from its name and one sentence.
	deps.bundle.write(checked.path, checked.text);
	if (checked.hub !== null) {
		hub = checked.hub.path;
		if (checked.hub.create !== undefined) {
			hubFrom = "created";
			deps.bundle.write(
				hub,
				hubDocument(
					checked.hub.create.title,
					checked.hub.create.description,
					now,
				),
			);
		} else if (hubFrom === null) {
			// The writer named a hub that exists but the shortlist missed.
			hubFrom = "judge";
		}
		const hubRaw = deps.bundle.read(hub);
		if (hubRaw !== undefined) {
			const linked = linkFromHub(
				hubRaw,
				slugOf(checked.path),
				checked.description,
			);
			if (linked !== hubRaw) {
				deps.bundle.write(hub, linked);
			}
		}
	}

	// sync and verify: through the same code the sync command runs, then
	// the relations read back from the index rather than assumed. A null
	// report is an extension the writer left byte-for-byte as it was, which
	// is already indexed.
	const report = await deps.sync();
	const problems = (report?.problems ?? []).filter(
		(problem) => problem.path === checked.path || problem.path === hub,
	);
	if (problems.length > 0) {
		throw new Error(
			`Frontmatter problems after the write: ${problems.map((p) => `${p.path}: ${p.problem}`).join("; ")}`,
		);
	}
	const relations = deps.relations(checked.path);
	if (relations === undefined) {
		throw new Error(`${checked.path} was written but is not indexed.`);
	}
	result.document = {
		path: checked.path,
		action: assessment.decision === "extend" ? "extended" : "written",
		title: checked.title,
		hub,
		hubFrom,
		hubProbability,
		sources: checked.sources,
		droppedSources: checked.dropped,
		...relations,
	};
	return result;
}

interface Assessment {
	decision: Decision;
	/** The research document to extend. */
	existing?: string;
	/** The topic hub the document belongs to, when the judge kept one. */
	hub: string | null;
}

/**
 * The decision, from the index run alone. The judge's label on the whole
 * kept set says whether the bundle already answers; if not, the first
 * research document it kept is extended — `kept` is first-kept-first and by
 * rank within a round, so that is the best one — and a hub is never
 * extended. The hub is the first topic document kept, and the command never
 * creates one: the writer may name a missing hub as a wikilink, which stays
 * unresolved as the graph's record that it is wanted. A `decide` exit falls
 * through on `kept` the same way, as the runner's own override does.
 */
export function assess(index: RunResult): Assessment {
	const hub =
		index.kept.find(
			(c) => c.source === "index" && c.ref.startsWith(`${TOPIC_DIR}/`),
		)?.ref ?? null;
	if (index.completenessLabel === COMPLETENESS_LEVELS[3]) {
		return { decision: "answered", hub };
	}
	const existing = index.kept.find(
		(c) => c.source === "index" && c.ref.startsWith(`${RESEARCH_DIR}/`),
	)?.ref;
	return existing === undefined
		? { decision: "new", hub }
		: { decision: "extend", existing, hub };
}

interface AllowedSources {
	/** Resolved bundle path → the citation as it should be written from `research/`. */
	paths: Map<string, string>;
	/** Canonical URL → the URL as the run kept it. */
	urls: Map<string, string>;
}

/** What the document may cite: the kept documents, relative to `research/`, and the kept pages. A document does not cite itself. */
function allowedSources(
	indexKept: Candidate[],
	webKept: Candidate[],
	self: string | undefined,
): AllowedSources {
	const paths = new Map<string, string>();
	for (const candidate of indexKept) {
		if (candidate.source === "index" && candidate.ref !== self) {
			paths.set(candidate.ref, posix.relative(RESEARCH_DIR, candidate.ref));
		}
	}
	const urls = new Map<string, string>();
	for (const candidate of webKept) {
		if (candidate.source === "web") {
			urls.set(canonicalUrl(candidate.ref), candidate.ref);
		}
	}
	return { paths, urls };
}

interface CheckInput {
	decision: Exclude<Decision, "answered">;
	existingPath?: string;
	existing?: OkfConcept;
	allowed: AllowedSources;
	/** The hub found for the document, or null when the draft must name one. */
	hub: string | null;
	exists(path: string): boolean;
	now: string;
}

type Checked =
	| {
			ok: true;
			path: string;
			text: string;
			title: string;
			description: string;
			sources: string[];
			dropped: string[];
			/** The hub cited, and what to write when it does not exist yet. */
			hub: {
				path: string;
				create?: { title: string; description: string };
			} | null;
	  }
	| { ok: false; problems: string[] };

/**
 * The document as it will be written, or why it cannot be. Nothing here
 * touches the disk. A wrapping fence is stripped first, because the
 * frontmatter pattern is anchored at the file's start and a fence would
 * fail every draft the same way. The frontmatter is then rebuilt: the
 * promoted fields in a fixed order, the rest as the writer had them, the
 * sources filtered to what the run read, the hub cited, and provenance
 * that names this command. An extension keeps its path and its sources as
 * they were, and goes back to `draft` because its content changed. Without
 * a hub the draft's last line must name one; the hub is then the existing
 * document of that name, or a new one for the caller to write.
 */
export function checkDraft(raw: string, input: CheckInput): Checked {
	const { text, trailer } = splitTrailer(unfence(raw));
	const concept = parseConcept(text);
	const title = concept.title?.trim() ?? "";
	const path =
		input.existingPath ??
		freshPath(title === "" ? "untitled" : title, input.exists);
	const problems: string[] = [];
	const problem = conceptProblem(path, concept);
	if (problem !== undefined) {
		problems.push(problem);
	}
	if (title === "") {
		problems.push("frontmatter has no `title`");
	}
	if (!concept.description?.trim()) {
		problems.push("frontmatter has no `description`");
	}
	if (concept.body.trim() === "") {
		problems.push("the body is empty");
	} else if (!hasWikilink(concept.body)) {
		problems.push(
			"the body has no wikilink: link the concepts it leans on, as `[[/{type}/{name}]]` when unwritten",
		);
	}
	let hub: NonNullable<Extract<Checked, { ok: true }>["hub"]> | null =
		input.hub === null ? null : { path: input.hub };
	if (input.hub === null) {
		const named = trailer === undefined ? null : HUB_TRAILER.exec(trailer);
		if (named === null) {
			problems.push(
				"no hub named: end with one line `hub: <Subject name> — <one sentence>`",
			);
		} else {
			const hubTitle = named[1].trim();
			const hubPath = `${TOPIC_DIR}/${slug(hubTitle) || "untitled"}.md`;
			hub = input.exists(hubPath)
				? { path: hubPath }
				: {
						path: hubPath,
						create: { title: hubTitle, description: named[2].trim() },
					};
		}
	}
	if (problems.length > 0) {
		return { ok: false, problems };
	}
	const description = (concept.description ?? "").trim();

	// sources: what the run read, and for an extension what was already
	// cited; anything else the writer made up. Compared by where a citation
	// resolves, so `../topic/x.md` and `/topic/x` are one entry.
	const dir = posix.dirname(path);
	const sources: Array<string | Record<string, unknown>> = [];
	const seen = new Set<string>();
	const dropped: string[] = [];
	const consider = (
		entry: string | Record<string, unknown>,
		asWritten: boolean,
	): void => {
		const rawTarget = citationTarget(entry);
		const key = rawTarget === undefined ? undefined : sourceKey(rawTarget, dir);
		if (rawTarget === undefined || key === undefined) {
			dropped.push(rawTarget ?? JSON.stringify(entry));
			return;
		}
		if (seen.has(key)) {
			return;
		}
		if (
			asWritten ||
			input.allowed.paths.has(key) ||
			input.allowed.urls.has(key)
		) {
			seen.add(key);
			sources.push(entry);
		} else {
			dropped.push(rawTarget);
		}
	};
	for (const entry of input.existing?.sources ?? []) {
		consider(entry, true);
	}
	for (const entry of concept.sources) {
		consider(entry, false);
	}
	if (hub !== null && !seen.has(hub.path)) {
		sources.unshift(citationOf(hub.path));
		seen.add(hub.path);
	}

	const rest = { ...input.existing?.rest, ...concept.rest };
	delete rest.sources;
	delete rest.generated;
	const staleAfter = concept.staleAfter ?? input.existing?.staleAfter;
	const tags =
		concept.tags.length > 0 ? concept.tags : (input.existing?.tags ?? []);
	const data = {
		type: concept.type,
		title,
		description,
		status: "draft",
		...(staleAfter === undefined ? {} : { stale_after: staleAfter }),
		tags,
		...rest,
		sources,
		generated: { by: GENERATED_BY, at: input.now },
	};
	// A wikilink to the subject itself under some other type — `[[/tool/x]]`
	// for a document whose hub is `topic/x` — is the hub, so it resolves there
	// rather than standing unresolved beside the citation.
	const linked =
		hub === null ? concept.body : subjectLinksToHub(concept.body, hub.path);
	const body = `${linked.startsWith("\n") ? "" : "\n"}${linked.replace(/\s*$/, "\n")}`;
	return {
		ok: true,
		path,
		text: matter.stringify({ content: body }, data),
		title,
		description,
		sources: sources.map((entry) => citationTarget(entry) ?? ""),
		dropped,
		hub,
	};
}

/** The draft without its last line when that line is a hub trailer, which is not part of the document. */
function splitTrailer(text: string): { text: string; trailer?: string } {
	const trimmed = text.replace(/\s*$/, "");
	const cut = trimmed.lastIndexOf("\n");
	const last = trimmed.slice(cut + 1);
	if (!HUB_TRAILER.test(last)) {
		return { text };
	}
	return { text: `${trimmed.slice(0, cut)}\n`, trailer: last };
}

/** Every wikilink whose name is the hub's, whatever type it was filed under, aimed at the hub. */
function subjectLinksToHub(body: string, hubPath: string): string {
	const name = slugOf(hubPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return body.replace(
		new RegExp(
			`\\[\\[(?:/[^/\\]|]+/|\\.\\./[^/\\]|]+/)?${name}(?:\\.md)?(\\||#|\\]\\])`,
			"g",
		),
		(_, tail) => `[[/${hubPath.replace(/\.md$/, "")}${tail}`,
	);
}

/** Whether the body writes any wikilink outside a fenced block. */
function hasWikilink(body: string): boolean {
	let fenced = false;
	for (const line of body.split("\n")) {
		if (/^\s*```/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (!fenced && /\[\[[^\]]+\]\]/.test(line)) {
			return true;
		}
	}
	return false;
}

/** A hub as a research document cites it: relative to `research/`. */
function citationOf(hubPath: string): string {
	return posix.relative(RESEARCH_DIR, hubPath);
}

/**
 * A new hub: a Topic document that says what the subject is and has a
 * `## Research` section for the loop to link the document from. It is the
 * skill's hub rule made mechanical, with the writer's sentence as the
 * description.
 */
export function hubDocument(
	title: string,
	description: string,
	now: string,
): string {
	return matter.stringify(
		{ content: `\n# ${title}\n\n${description}\n\n${HUB_SECTION}\n` },
		{
			type: "Topic",
			title,
			description,
			status: "draft",
			tags: [slug(title)],
			generated: { by: GENERATED_BY, at: now },
		},
	);
}

/** A model's document, without the code fence it may have wrapped it in and the blank lines before it. */
function unfence(raw: string): string {
	const trimmed = raw.replace(/^\s+/, "");
	const fenced = /^```[^\n]*\n([\s\S]*?)\n```\s*$/.exec(trimmed);
	return (fenced === null ? trimmed : fenced[1]).replace(/^\s+/, "");
}

/** The target a citation names, in either of the shapes an author writes. */
function citationTarget(
	entry: string | Record<string, unknown>,
): string | undefined {
	if (typeof entry === "string") {
		return entry.trim() === "" ? undefined : entry.trim();
	}
	for (const key of ["path", "url", "href", "source"]) {
		const value = entry[key];
		if (typeof value === "string" && value.trim() !== "") {
			return value.trim();
		}
	}
	return undefined;
}

/** What makes two citations the same: a canonical URL, or the bundle path a relative target resolves to. */
function sourceKey(target: string, dir: string): string | undefined {
	if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) {
		return canonicalUrl(target);
	}
	return normalizeTarget(target.split("#")[0], dir);
}

/** A title as a filename: the type-directory rule, so a document and its directory are named alike. */
export function slug(title: string): string {
	return typeDirectory(title);
}

/** `research/<slug>.md`, or the first of `-2`, `-3`… that is not taken. */
function freshPath(title: string, exists: (path: string) => boolean): string {
	const base = slug(title) || "untitled";
	let path = `${RESEARCH_DIR}/${base}.md`;
	for (let n = 2; exists(path); n++) {
		path = `${RESEARCH_DIR}/${base}-${n}.md`;
	}
	return path;
}

function slugOf(path: string): string {
	return posix.basename(path, ".md");
}

/**
 * The hub with one more line in its `## Research` section: a wikilink to
 * the document and its description, after the section's last line, or in
 * a new section at the end when the hub has none. A hub that already links
 * the document is returned as it was.
 */
export function linkFromHub(
	hub: string,
	slug: string,
	description: string,
): string {
	const target = `[[/${RESEARCH_DIR}/${slug}]]`;
	if (hub.includes(target)) {
		return hub;
	}
	const line = `- ${target} — ${description}`;
	const lines = hub.split("\n");
	const heading = lines.findIndex((text) =>
		new RegExp(`^${HUB_SECTION}\\s*$`).test(text),
	);
	if (heading === -1) {
		const trimmed = hub.replace(/\s*$/, "");
		return `${trimmed}\n\n${HUB_SECTION}\n\n${line}\n`;
	}
	let end = lines.findIndex(
		(text, index) => index > heading && /^#{1,2}\s/.test(text),
	);
	if (end === -1) {
		end = lines.length;
	}
	let last = end - 1;
	while (last > heading && lines[last].trim() === "") {
		last--;
	}
	const inserted = [
		...lines.slice(0, last + 1),
		// The first entry of an empty section sits a blank line below the heading.
		...(last === heading ? [""] : []),
		line,
		...(end < lines.length ? [""] : []),
		...lines.slice(end),
	];
	let text = inserted.join("\n");
	if (!text.endsWith("\n")) {
		text = `${text}\n`;
	}
	return text;
}

function summarise(run: RunResult): LoopSummary {
	return {
		exit: run.exit,
		tried: run.tried,
		completeness: run.completeness,
		completenessLabel: run.completenessLabel,
	};
}

function quote(label: string): string {
	return `"${label}"`;
}
