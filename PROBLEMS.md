# Known problems

What is wrong with `lattice research` as it stands, found by running it and
reading what it wrote rather than by reasoning about it. Each entry says what
happens, the evidence, where the code is, and what would fix it. Fixing one
should mean deleting its entry.

The order is the order I would fix them in: the first two are cheap and
account for most of what went wrong in the worst run observed, and the third
stops the corpus taking on fiction.

## 1. The planner is blind to the index

`runLoop` plans its queries in the first state, before anything has been
searched (`src/run/runner.ts`). So the queries are written from the question
alone, and whatever the bundle already knows about the subject arrives too
late to shape them. The web loop compounds it by reusing the index run's
queries (`tried: index.tried` in `src/run/research.ts`), so a bad plan is
paid for twice.

**Evidence.** Researching "how new upcoming features can be helpful for
agentgit" against a bundle that *did* hold `topic/agentgit.md`, the index run
found and kept that hub — and the planner still wrote six queries hunting the
bare name, because it ran first. The web leg then kept nineteen pages, of
which eighteen were unrelated projects that happen to share the name.

**Fix.** Re-plan the web queries from what the index kept instead of reusing
its queries. One extra call to the planner model, about $0.001.

## 2. Seed-then-plan over-corrects

A URL in the topic is now fetched before planning and the planner is shown
it. The instruction telling it what to do with that page says to write
queries "for what it leaves out" (`planPrompt` in `src/run/runner.ts`), which
sends it after whatever the source does not cover — including parts of the
question no source can answer.

**Evidence.** Seeded with an LWN article about Git 2.56, the planner
correctly inferred that the article says nothing about agentgit and went
looking for agentgit, which is a private tool with a dozen public namesakes.
A probe over the same seed showed a wording that keeps the queries on the
source's own subject produces "Git 2.56 new features improvements workflow
efficiency" where the current one produces a name hunt.

**Fix.** Reword to keep queries on the seed's subject: corroborate, extend,
explain what it names in passing. Do not chase a name in the question the
source does not discuss.

## 3. A created hub invents what it cannot know

When no existing hub fits, the writer is required to end its draft with
`hub: <Subject> — <one sentence describing the subject>` (`NAME_HUB` in
`src/write/prompt.ts`), and a draft without that line is rejected, costs the
single retry, and on a second miss exits 1 with nothing written
(`checkDraft` in `src/run/research.ts`). The same prompt also says "do not
invent facts it does not support", but nothing enforces that. Faced with a
subject no source describes, the writer has no way to say so and every
reason to invent.

**Evidence.** `topic/agentgit.md` in the live bundle describes agentgit as
"in the lineage of LLMinus and Sashiko". Not one of the five sources behind
the document that created it mentions agentgit; the lineage is inferred from
the tools the article happened to discuss. The research document hedged with
"presumed to"; the hub dropped the hedge. A later run then kept that hub as
indexed context, so the guess is now feeding research as established fact.

**Fix.** Let the trailer name a subject without describing it, and write a
hub that says plainly that no source here describes this subject. That keeps
the graph connected, which was the point, and fails loudly instead of
quietly.

## 4. A name match reads as relevance

The judge is asked whether a candidate is relevant to answering the question
(`candidateQuestion` in `src/run/jev-judge.ts`). A page about a different
tool with the same name looks relevant by that test, and nothing downstream
can tell the two apart.

**Evidence.** Eighteen pages kept for agentgit, spanning at least six
unrelated projects, which the writer then turned into disambiguation nodes:
`tool/agentgit-btucker`, `tool/agent-git-hub`, `tool/agentgit-tryboy869`,
`tool/agentgit-arxiv`.

**Fix.** Unclear, and worth thinking about before acting. Options include
giving the judge what the bundle knows the subject to be, or refusing to mint
a node whose name only differs from the subject by a disambiguator.

## 5. Nothing acts on unresolved links

An unresolved wikilink is the graph recording that a document is wanted, and
that works. But there is no way to see what the bundle is asking for across
all documents, and no way to act on it. `lattice rels` shows one concept's
unresolved links at a time.

**Evidence.** `tool/llminus` is wanted three times and `tool/sashiko` twice
from a single document, both real tools with real coverage, and nothing
surfaces that.

**Fix.** A command that lists unresolved targets across the bundle, ordered
by how many documents want them. Filling one is then just running the
existing command on it.

## 6. External citations are not edges

A `sources:` entry that is a URL is kept as a citation and creates no link
row (`src/sync/links.ts`). Two documents rest on the same article and share
nothing traversable.

**Fix.** Record external citations in `links` under their own kind rather
than adding a document type for sources. A source is an artifact, not a
concept, and forty of them per five documents would make the bundle mostly
bibliography stubs.

## 7. Project context has no route in

The command reads the bundle and the web. Knowledge that lives in the repo it
was invoked from does not reach it.

This is unresolved rather than decided. Loading the Agent SDK's project
setting sources is the obvious lever and carries a real hazard: a settings
file's `env` block overrides one passed programmatically, which is how this
command forwards its own credential. Passing the text explicitly through the
`context` option that seeds already use avoids that. And the evidence in
problem 1 suggests much of what looked like missing project context was
really the planner running too early.

## 8. The harness measures links, not whether they point at anything

The five-topic harness counts outgoing, incoming and unresolved links per
document. A document hung off an invented hub scores as a success by that
measure.

**Evidence.** Problem 3 survived a full harness round unnoticed, because
every document had a hub and a backlink and the numbers looked right.

**Fix.** Check that a created hub's description is supported by a kept
source, and report created hubs separately from found ones. `hubFrom` in the
result already distinguishes them.

## 9. Documents are long

Between 6.7 KB and 15.2 KB each, written as reference articles rather than
answers. They synthesise their sources well and have no opinions of their
own.

## 10. Seeding is expensive

The seeded run spent $0.21 on the web and $0.20 on the writer, against about
$0.13 for a whole unseeded run, mostly on ten queries chasing a name.
Problems 1 and 2 are the cause, so fixing those should fix this.

---

Fixed in this round, for context: documents that were leaves with no links,
a topic whose web run gave up every time and wrote nothing, a result that
reported process without ever stating the answer, and a note in this repo
about `bm25()` and window functions that was wrong.
