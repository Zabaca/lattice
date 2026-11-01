# Known problems

What is wrong with Lattice's index and links as they stand. Each entry says what
happens, the evidence, where the code is, and what would fix it. Fixing one
should mean deleting its entry.

The numbering is not stable: entries are deleted as they are fixed, and the
rest keep their headings.

## 5. Nothing acts on unresolved links

An unresolved wikilink is the graph recording that a document is wanted, and
that works. But there is no way to see what the bundle is asking for across
all documents, and no way to act on it. `lattice rels` shows one concept's
unresolved links at a time.

**Evidence.** `tool/llminus` is wanted three times and `tool/sashiko` twice
from a single document, both real tools with real coverage, and nothing
surfaces that.

**Fix.** A command that lists unresolved targets across the bundle, ordered
by how many documents want them.

## 6. External citations are not edges

A `sources:` entry that is a URL is kept as a citation and creates no link
row (`src/sync/links.ts`). Two documents rest on the same article and share
nothing traversable.

**Fix.** Record external citations in `links` under their own kind rather
than adding a document type for sources. A source is an artifact, not a
concept, and forty of them per five documents would make the bundle mostly
bibliography stubs.
