# Lattice - Knowledge Graph CLI

A CLI that indexes a bundle of OKF markdown documents into SQLite and searches it by keyword and by meaning at once.

## Architecture

- **Backend**: SQLite via `bun:sqlite` (embedded, no external dependencies)
- **Keyword search**: SQLite FTS5 over chunks (`chunks_fts`)
- **Vector search**: a cosine scan over `chunk_embeddings` — no index extension
- **Embeddings**: in-process, behind the `EmbeddingProvider` seam in `src/embed/provider.ts`. The default `local` provider runs a real ONNX model in the command's own process from weights cached under the Lattice home — no daemon, no API key, and no network after the first download. The `hash` provider is the deterministic alternative the test suite uses: 512 dimensions derived from a hash of the text, needing no model on disk.
- **Runtime**: Bun

## Key Commands

```bash
lattice init     # Create the home directory and index, and download the embedding model
lattice status   # Show documents needing sync
lattice sync     # Index the bundle, then embed whatever has no vector
lattice embed    # Embed the backlog alone (`--retry-failed` retries permanent failures,
                 # `--reembed` rebuilds the index after a model change)
lattice search   # Hybrid search: keyword and meaning fused, then expanded one hop
lattice sql      # Raw SQL queries
lattice rels     # Show a concept's links, backlinks and unresolved links
lattice web      # Search the web through Exa, for the research skill
lattice run      # A judged search loop: plan, search index and web, judge, rewrite
```

`lattice rels <concept>` takes either an OKF identifier (`bigquery-table/users`)
or a bundle path (`bigquery-table/users.md`), and `--json` prints the same three
relations machine-readably. Sharing a directory is not a relation.

A document lives in the directory named by its `type` (`typeDirectory` in
`src/sync/okf.ts`: lowercased, non-alphanumeric runs to `-`), so `type: BigQuery
Table` files under `bigquery-table/`. `status` and `sync` report a document
filed anywhere else as a frontmatter problem, alongside a missing `type`.

## Storage

All data is stored under one home directory, resolved by `resolvePaths` in
`src/utils/paths.ts`: `LATTICE_HOME` when it is set, otherwise `~/.lattice`.

```
~/.lattice/
├── docs/          # The markdown bundle
├── lattice.db     # The SQLite index (plus SQLite's own -wal/-shm sidecars)
├── models/        # Cached embedding weights (`LATTICE_MODEL_DIR` moves it)
└── .sync.lock     # Held while a sync is running
```

`lattice init` creates the home directory, `docs/` and `lattice.db`, and fills
`models/` with the weights the `local` provider needs; the lock file appears
only while a sync holds it.

Configuration is environment variables only — there is no config file and no
sync manifest. `resolvePaths` still names an `.env` under the home directory,
but nothing reads it. Sync state is the content hash stored per concept in the
index.

### Database

The index (`lattice.db`, SQLite — see `src/db/schema.ts`) holds
`concepts`, `tags`, `chunks`, `chunks_fts`, `chunk_embeddings`,
`concept_embeddings`, the two embedding failure tables and `links`. The four embedding tables are
keyed by `(target, model, dim)`, which is what lets two vector spaces coexist
while a re-embed is in flight.

## Embeddings

The embed phase runs at the end of `lattice sync` and is the whole of
`lattice embed`; there is one code path either way. A chunk or concept with no
vector is simply a row missing from `chunk_embeddings` / `concept_embeddings`,
so an interruption leaves a backlog rather than a half-written document.

A provider failure is recorded per target in `chunk_embed_failures` /
`concept_embed_failures` as retryable or permanent. Retryable failures are
picked up by the next run; permanent ones only under
`lattice embed --retry-failed`. Both tables hang off their target, so
re-chunking a document takes its stale failure rows with it.

### Models and model changes

`src/embed/registry.ts` describes every model Lattice can run: its hub
repository, how its token vectors are pooled, the prefixes it was trained to
expect for a passage as against a query, its native and stored dimensions, and
its context ceiling. The default is `nomic-embed-text-v1.5` stored at 512 of
its native 768 dimensions — a truncation only models trained for it (Matryoshka)
are allowed, and the vector is re-normalised afterwards so a dot product is
still a cosine similarity. `bge-small-en-v1.5` and `mxbai-embed-large-v1` are
also registered.

A model name is normalised before it is compared or stored, so `nomic-ai/…`,
`hf.co/…`, a `:latest` tag and a capital letter are all the same model.

A **vector space** is a `(model, dim)` pair, and the space the index is in is
recorded in `meta.embedding_model` / `meta.embedding_dim` — not inferred from the rows.
`sync`, `embed` and `search` refuse when the configured model is not the one
the index is in, naming both, the number of chunks affected, where the new name
came from, and the one command that proceeds: `lattice embed --reembed`. That
command writes the new space's vectors beside the old ones and only when the
new set is complete does a single transaction move the pointer and delete the
old rows — so an interrupted re-embed still searches correctly on the old
vectors and resumes where it stopped.

Environment:

| Variable | Meaning |
|---|---|
| `LATTICE_EMBED_PROVIDER` | `local` (the default: a real model, in-process) or `hash` (deterministic, no model, what the tests use). An unknown name is an error, never a silent fallback. |
| `LATTICE_EMBED_MODEL` | Which registered model to run. An unregistered name is an error listing the registered ones. |
| `LATTICE_EMBED_DIM` | Stored vector width. For `hash` it is simply the width, and the model name carries it (`hash-512`). For `local` it may only go below the model's native width when the model was trained for truncation. |
| `LATTICE_MODEL_DIR` | Where weights are cached; defaults to `models` under the Lattice home. |
| `LATTICE_OFFLINE` / `HF_HUB_OFFLINE` | Never download. A model already cached is used; a missing one is an error naming the directory and the files to place there. |
| `LATTICE_HF_MIRROR` | Where a download comes from, when not the hub (`HF_ENDPOINT` is honoured as a fallback). |
| `LATTICE_EMBED_FAIL` | Fault injection for tests: `retryable:<substring>` or `permanent:<substring>` makes the hash provider fail on any text containing the substring. |
| `LATTICE_E2E_MODEL` | Set to run `src/embed/local.e2e.test.ts`, the one test that downloads and runs the real model. It is skipped otherwise. |

## Search

`lattice search` runs two legs over one filtered candidate set — the FTS5
keyword index over chunks, and a cosine scan over `chunk_embeddings` — and
fuses their rankings with reciprocal rank fusion, because a tier score and a
cosine are not comparable quantities. A similarity below `SIMILARITY_FLOOR`
(0.25) is noise and never enters the fusion, which is why the non-semantic
`hash` provider leaves passage ranking exactly as keyword search left it.

`concept_embeddings` is a tiebreak in passage search and nothing more: the
nudge is sized against the smallest gap between two distinct fused scores, so
it can close a tie and can never cross one. In `--concepts` mode it is a leg of
its own, because there the question is which document rather than which passage.

The top hits are then expanded one hop over `links` (outbound and inbound).
Directory siblings are not neighbours. Neighbours are deduplicated against the answers,
capped by `--expand` (default 3, `--no-expand` disables), and always scored
below the weakest direct hit.

When no query vector is usable — unknown provider, a provider that threw, or
nothing in the index embedded with that model — the result is keyword-only and
says so: `--json` carries `degraded` and `degradedReason`, and
`--require-embeddings` turns that into a non-zero exit.

### Reranking

An optional stage between fusion and expansion, behind `Reranker` in
`src/rerank/provider.ts` (the same shape of seam as the embedding provider).
With `LATTICE_RERANK_PROVIDER` unset nothing changes and nothing touches the
network. `jev` sends the fused top `--candidates` (default 20, never below
`--limit`) to TypeSafe's Jev in one request with one Noul per candidate —
title plus the shown passages in full, or in `--concepts` mode title,
description and opening passage — and reorders by the returned probability,
fused score as tiebreak. A reranked hit's `score` is that probability and
`fusedScore` keeps the pre-rerank score; expansion then hangs off the reranked
answers, so its floor is the lowest probability (possibly 0). The result
carries `reranked`, `rerank: { provider, model, candidates, inputTokens } |
null` and `rerankReason` when a configured reranker fell back. A configuration
error (unknown name, `jev` without `TYPESAFE_API_KEY` or with one the service
rejects, malformed stub) is a hard error; a request failure degrades to the
fused order and says so, and
`--require-rerank` turns that into a non-zero exit. Semantic degradation and
rerank degradation are independent: a keyword-only search is still reranked.

| Variable | Meaning |
|---|---|
| `LATTICE_EMBED_STUB` | With `LATTICE_EMBED_PROVIDER=stub`, a JSON array of phrase groups; a text's vector has one dimension per group it mentions. For tests and demonstrations — it is the only way to show a paraphrase matching without a real model. |
| `LATTICE_RERANK_PROVIDER` | Unset (no reranking), `jev` (TypeSafe, needs `TYPESAFE_API_KEY`; `TYPESAFE_BASE_URL` is honoured) or `stub`. Anything else is an error. |
| `LATTICE_RERANK_MODEL` | The Jev model to ask for; default `jev-latest`. |
| `LATTICE_RERANK_STUB` | With `stub`, a JSON object of phrase → probability; a candidate scores the highest phrase its text contains, 0 if none. Malformed is an error. |
| `LATTICE_RERANK_FAIL` | With `stub`, a substring; a query containing it makes the request throw, to exercise the fallback. |

## Web

`lattice web <query>` is the one command that searches outside the index: one
`POST /search` to Exa, behind the `WebSearcher` seam in `src/web/provider.ts`
(the same shape as the reranker seam). It exists for the `/research` skill's
web step and nothing else in Lattice calls it. The result is the pages Exa
found with the highlights it picked out, so the skill can cite a URL without
fetching it; `--json` carries `{ query, type, results: [{ title, url,
publishedDate, author, highlights, text? }], cost, searchTime, requestId }`.
`--type` is Exa's own enum (`auto` by default), `--limit` is 1 to 100,
`--since` an ISO date, `--domain` repeats, `--text` adds page text capped at
4000 characters.

There is no degradation contract: nothing inside the command can stand in for
the web, so a missing or rejected key (401/402 name `EXA_API_KEY`), a rate
limit or server error (Exa's `error` and `tag`) and a network failure are all
exit 1 with the reason, and the skill falls back to WebSearch. The CLI never
reads `secrets.yaml`; the skill says how to export the key.

| Variable | Meaning |
|---|---|
| `EXA_API_KEY` | Required by the `exa` searcher. |
| `EXA_BASE_URL` | Where the request goes; default `https://api.exa.ai`. |
| `LATTICE_WEB_PROVIDER` | Unset or `exa` (the real one) or `stub`. Anything else is an error. |
| `LATTICE_WEB_STUB` | With `stub`, a JSON array of `{ title, url, highlights }` returned in that order. Malformed is an error. |
| `LATTICE_WEB_FAIL` | With `stub`, a substring; a query containing it makes the request throw. |

## Runner

`lattice run <question>` is the search loop as a state machine
(`src/run/runner.ts`): code drives, Jev judges, and a language model is called
only in the two states that turn prose into queries. It exists so the
`/search` and `/research` skills spend one command, not several agent turns,
finding what to cite. All states run in one process:

| State | Runs | Then |
|---|---|---|
| `plan` | the LLM writes two queries; skipped when `--tried` gives them | `search` |
| `search` | each query over `search()` (limit 5, no expand) and, unless `--no-web`, the web searcher (limit 5, type `fast`); merged, first occurrence kept | `judge` |
| `judge` | one Jev request: a Noul per candidate, a four-level completeness Score, a repeating Noul, a Choice `answer\|rewrite\|give_up` | the policy |
| `rewrite` | the LLM writes two new queries from the tried list and the reason | `search` |

The judge reads everything kept so far plus the round's new finds, so
completeness is about the whole set; a candidate's own relevance is settled
the first time it is read, because Jev's verdict on a page flips between
reads. Index hits dedupe by path, web pages by canonical URL (scheme, `www.`,
trailing slash and fragment dropped, host lowercased).

The policy (`transition`), in order:

1. Completeness below 2 with Choice `answer` is treated as `rewrite` — the
   early-stop correction. This override is code's, so rule 2 does not apply to it.
2. Choice confidence below 0.6 exits `decide`: the caller reads the distribution.
3. `answer` and `give_up` exit as themselves.
4. `rewrite` with no rewrites left, or after at least one rewrite with
   repeating ≥ 0.7, stops rewriting: exit `answer` if the kept set is
   non-empty, else `give_up`. The repeating check is skipped before the first
   rewrite because two planned queries on one topic always look alike.
5. Otherwise `rewrite`, up to `--max-rewrites` (default 2).

A web leg that cannot be built or fails mid-run is `webReason`, and the run
goes on over the index, as `search` does without its semantic leg. No index
is exit 1; no judge or no model is exit 1 naming the variable; a TypeSafe
key the service rejects is a hard error, as in the reranker. `--json` is
`{ question, exit, tried, completeness, completenessLabel, kept: [{ source,
title, ref, text }], records: [...], cost: { llmUsd, llmCalls,
jevInputTokens, webUsd }, webReason }`, one record per judge visit.

The `claude` text provider runs the Claude Agent SDK with the minimal option
set from zbc's `@zabaca/agent` (`tools: []`, `settingSources: []`, thinking
off, no MCP, no memory or connectors). `settingSources: []` stops the process
reading the user's settings, which is where an OAuth login keeps its token,
so `CLAUDE_CODE_OAUTH_TOKEN` is forwarded explicitly from the CLI's
environment.

| Variable | Meaning |
|---|---|
| `LATTICE_LLM_PROVIDER` | Unset or `claude` (the Agent SDK) or `stub`. Anything else is an error. |
| `LATTICE_LLM_MODEL` | The model to plan and rewrite with; default `claude-haiku-4-5`, whose queries were as good as Opus's. |
| `LATTICE_LLM_STUB` | With `stub`, a JSON array of completions returned in order; the last repeats. Malformed is an error. |
| `LATTICE_CLAUDE_PATH` | `pathToClaudeCodeExecutable` for the SDK, when set. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Required by `claude` unless `ANTHROPIC_API_KEY` is set; missing both is an error naming both. |
| `LATTICE_JUDGE_PROVIDER` | Unset or `jev` (TypeSafe, needs `TYPESAFE_API_KEY`; model from `LATTICE_RERANK_MODEL`) or `stub`. Anything else is an error. |
| `LATTICE_JUDGE_STUB` | With `stub`, a JSON array of `{ keep: [ref substrings], completeness, repeating, next, confidence }` consumed in order; the last repeats. Malformed is an error. |

## Links

`links` records the edges an author wrote: markdown links and wikilinks in a
document's body, plus the frontmatter `sources:` citations that point inside the
bundle (`kind = 'source'`). Links in fenced code blocks and links to external
URLs are not edges. A link whose target is not indexed keeps its `target_path`
with a NULL `target_concept_id` — an OKF unresolved link, standing for knowledge
not written yet. Every sync re-resolves the whole table at the end, so writing
the missing document repairs the edge and deleting a target returns its inbound
links to unresolved.

## Development Notes

- No external services: SQLite is embedded and the default embedding provider runs in-process
- `bun run check` is `tsc --noEmit && biome check .`; `bun test` is the whole suite
- Path resolution lives in `src/utils/paths.ts` — never build a storage path by hand

## Testing Philosophy

### One seam

The suite drives a single seam: `runCli` in `src/cli/run.ts`. It takes argv and
an environment and returns `{ code, stdout, stderr }`. It never reads
`process.argv`, `process.env` or the real home directory, and it never throws.
Tests live in `src/cli/run.test.ts` and go through it — argv in, exit code and
output out.

A test gets an isolated home by passing `LATTICE_HOME` pointed at a fresh
temporary directory, so there is no shared connection to manage, nothing to
truncate between tests, and no order dependence.

### Rules

1. **Test through the CLI, not around it.** Assert on what a command prints and
   the code it exits with. Prefer `--json` output to parsing a rendered table.
   Never open the database directly from a test; `lattice sql` is a command, and
   using it is driving the CLI.
2. **Use the highest interface that can show the behavior.** If `lattice search
   --json` can show it, do not reach for `lattice sql`.
3. **Expected values come from an independent source of truth** — a known-good
   literal, a worked example, the spec — never recomputed the way the code
   computes them.
4. **Pure functions may be tested directly** in a `*.test.ts` beside the source
   when the logic genuinely has no CLI-visible behavior of its own. That is the
   exception, not the default.

### Example

```typescript
function invoke(argv: string[], home: string = freshHome()) {
  return runCli({ argv, env: { LATTICE_HOME: home } });
}

test("sync reports what it indexed", async () => {
  const home = freshHome();
  await invoke(["init"], home);
  cpSync(FIXTURE_BUNDLE, join(home, "docs"), { recursive: true });

  const result = await invoke(["sync"], home);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Indexed");
});
```
