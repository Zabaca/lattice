# Known problems

What is wrong with Lattice's links as they stand. Each entry says what
happens, the evidence, where the code is, and what would fix it. Fixing one
should mean deleting its entry.

## External citations are not edges

A `sources` entry that is a URL is kept as a citation and creates no link
row (`src/markdown/links.ts`). Two notes that rest on the same article share
nothing traversable.

**Fix.** Record external citations in `links` under their own kind rather
than adding a note type for sources. A source is an artifact, not a note, and
forty of them per five notes would make the store mostly bibliography stubs.
