# Known problems

What is wrong with `lattice research` as it stands, found by running it and
reading what it wrote rather than by reasoning about it. Each entry says what
happens, the evidence, where the code is, and what would fix it. Fixing one
should mean deleting its entry.

The order is the order I would fix them in. The numbering is not stable:
entries are deleted as they are fixed, and the rest keep their headings.

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

The web planner now searches in the words the bundle uses to describe the
subject rather than its bare name, so fewer namesakes reach the judge. That
is upstream of this and does not close it: the judge is still asked only
whether a candidate answers the question, so a namesake that does reach it
still reads as relevant.

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
`context` option that seeds and the bundle's own knowledge already use
avoids that. And the evidence behind the blind-planner problem, now fixed,
suggests much of what looked like missing project context was really the
planner running too early.

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
$0.13 for a whole unseeded run, mostly on ten queries chasing a name. The
blind planner and the seed wording were the cause and are fixed; whether the
cost followed them down is unmeasured.

---

Fixed since this file was written: a writer forced to describe a subject its
sources never mention — the hub trailer's sentence is now optional, and a hub
written without one says that no source describes the subject instead of
guessing. Also a planner blind to the index, whose web
loop reused the queries the index run planned before anything had been
searched, and a seed instruction that sent the planner after what its source
left out. Both are now the `PlanContext` the web loop plans with.

Fixed in the round before, for context: documents that were leaves with no links,
a topic whose web run gave up every time and wrote nothing, a result that
reported process without ever stating the answer, and a note in this repo
about `bm25()` and window functions that was wrong.
