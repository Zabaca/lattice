---
type: Guide
title: Chunking guide
tags: [guide]
---

# Chunking guide

This document exists so the chunker can be checked against a file whose lines
are known. It holds a section short enough to be merged forward, a section long
enough to be split, and a fenced code block larger than the cap that must
survive whole.

## Short

Tiny.

## Merged target

This section is where the short section above ends up. It is long enough to
stand on its own, so the merge stops here instead of running on into the next
section and taking its heading with it.

## Long section

Retrieval quality depends on passages large enough to answer a question and small enough to embed without losing their meaning, which is why a section over the cap is broken at paragraph boundaries rather than at a fixed number of characters. Paragraph number 1.

Retrieval quality depends on passages large enough to answer a question and small enough to embed without losing their meaning, which is why a section over the cap is broken at paragraph boundaries rather than at a fixed number of characters. Paragraph number 2.

Retrieval quality depends on passages large enough to answer a question and small enough to embed without losing their meaning, which is why a section over the cap is broken at paragraph boundaries rather than at a fixed number of characters. Paragraph number 3.

Retrieval quality depends on passages large enough to answer a question and small enough to embed without losing their meaning, which is why a section over the cap is broken at paragraph boundaries rather than at a fixed number of characters. Paragraph number 4.

Retrieval quality depends on passages large enough to answer a question and small enough to embed without losing their meaning, which is why a section over the cap is broken at paragraph boundaries rather than at a fixed number of characters. Paragraph number 5.

Retrieval quality depends on passages large enough to answer a question and small enough to embed without losing their meaning, which is why a section over the cap is broken at paragraph boundaries rather than at a fixed number of characters. Paragraph number 6.

Retrieval quality depends on passages large enough to answer a question and small enough to embed without losing their meaning, which is why a section over the cap is broken at paragraph boundaries rather than at a fixed number of characters. Paragraph number 7.

Retrieval quality depends on passages large enough to answer a question and small enough to embed without losing their meaning, which is why a section over the cap is broken at paragraph boundaries rather than at a fixed number of characters. Paragraph number 8.

Retrieval quality depends on passages large enough to answer a question and small enough to embed without losing their meaning, which is why a section over the cap is broken at paragraph boundaries rather than at a fixed number of characters. Paragraph number 9.

Retrieval quality depends on passages large enough to answer a question and small enough to embed without losing their meaning, which is why a section over the cap is broken at paragraph boundaries rather than at a fixed number of characters. Paragraph number 10.

## Fenced code

```ts
// A fenced block longer than the cap is emitted whole, never split.
# this line is not a heading, it is a comment inside the fence
export const sampleIdentifierNumber1 = computeSomethingUseful(1, 'a long literal argument');
export const sampleIdentifierNumber2 = computeSomethingUseful(2, 'a long literal argument');
export const sampleIdentifierNumber3 = computeSomethingUseful(3, 'a long literal argument');
export const sampleIdentifierNumber4 = computeSomethingUseful(4, 'a long literal argument');
export const sampleIdentifierNumber5 = computeSomethingUseful(5, 'a long literal argument');
export const sampleIdentifierNumber6 = computeSomethingUseful(6, 'a long literal argument');
export const sampleIdentifierNumber7 = computeSomethingUseful(7, 'a long literal argument');
export const sampleIdentifierNumber8 = computeSomethingUseful(8, 'a long literal argument');
export const sampleIdentifierNumber9 = computeSomethingUseful(9, 'a long literal argument');
export const sampleIdentifierNumber10 = computeSomethingUseful(10, 'a long literal argument');
export const sampleIdentifierNumber11 = computeSomethingUseful(11, 'a long literal argument');
export const sampleIdentifierNumber12 = computeSomethingUseful(12, 'a long literal argument');
export const sampleIdentifierNumber13 = computeSomethingUseful(13, 'a long literal argument');
export const sampleIdentifierNumber14 = computeSomethingUseful(14, 'a long literal argument');
export const sampleIdentifierNumber15 = computeSomethingUseful(15, 'a long literal argument');
export const sampleIdentifierNumber16 = computeSomethingUseful(16, 'a long literal argument');
export const sampleIdentifierNumber17 = computeSomethingUseful(17, 'a long literal argument');
export const sampleIdentifierNumber18 = computeSomethingUseful(18, 'a long literal argument');
export const sampleIdentifierNumber19 = computeSomethingUseful(19, 'a long literal argument');
export const sampleIdentifierNumber20 = computeSomethingUseful(20, 'a long literal argument');
export const sampleIdentifierNumber21 = computeSomethingUseful(21, 'a long literal argument');
export const sampleIdentifierNumber22 = computeSomethingUseful(22, 'a long literal argument');
export const sampleIdentifierNumber23 = computeSomethingUseful(23, 'a long literal argument');
export const sampleIdentifierNumber24 = computeSomethingUseful(24, 'a long literal argument');
export const sampleIdentifierNumber25 = computeSomethingUseful(25, 'a long literal argument');
export const sampleIdentifierNumber26 = computeSomethingUseful(26, 'a long literal argument');
export const sampleIdentifierNumber27 = computeSomethingUseful(27, 'a long literal argument');
export const sampleIdentifierNumber28 = computeSomethingUseful(28, 'a long literal argument');
export const sampleIdentifierNumber29 = computeSomethingUseful(29, 'a long literal argument');
export const sampleIdentifierNumber30 = computeSomethingUseful(30, 'a long literal argument');
```

