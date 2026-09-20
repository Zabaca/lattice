---
type: Research Note
title: Bun versus Node.js performance
description: Where Bun's startup and HTTP throughput differ from Node.js, and why.
tags: [bun, runtime, performance]
generated: { by: claude-code/research, at: 2026-09-20T00:00:00Z }
sources:
  - path: runtime-overview.md
    title: Bun and Node.js runtimes
  - https://bun.sh/docs/benchmarks
---

# Bun versus Node.js performance

## Startup

Bun's startup time is dominated by JavaScriptCore's initialisation, which is
cheaper than V8's for a short-lived process.

## Throughput

HTTP throughput differs most under many small requests, where per-request
overhead rather than the engine decides the result.

## Sources

1. [Bun benchmarks](https://bun.sh/docs/benchmarks)
