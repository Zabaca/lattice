#!/bin/sh
set -e

# Bootstrap a fresh worktree of @zabaca/lattice.
# Run by Fredrin with `sh` from the worktree root after checkout.

# Install dependencies (bun.lock is the committed lockfile).
bun install

# Materialize local config from the committed template, without clobbering.
[ -f .env ] || cp .env.example .env
