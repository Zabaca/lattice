---
type: BigQuery Table
title: Users table
description: One row per registered account.
status: stable
tags: [data, core]
stale_after: 2027-01-01T00:00:00Z
resource: bigquery://project/dataset/users
generated: { by: human:ahormati, at: 2026-06-20T09:00:00Z }
verified:
  - by: human:ahormati
    at: 2026-06-25T09:00:00Z
---

# Users table

The canonical account record. Every row here has matching rows in the
[Orders table](orders.md). The [Sessions table](sessions.md) has not been
written yet. The published schema is at [the upstream docs](https://example.com/users).

## Columns

`user_id` is the primary key, and the [order columns](orders.md#columns) are
keyed by it too.

## Example

```sql
-- [Not a link](nowhere.md) — this is inside a fence.
SELECT user_id FROM users;
```
