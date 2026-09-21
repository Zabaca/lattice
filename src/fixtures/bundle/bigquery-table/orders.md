---
type: BigQuery Table
title: Orders table
status: deprecated
tags: [data]
sources:
  - path: users.md
    title: Users table
  - https://example.com/orders-spec
verified: { by: lattice/0.1, at: 2026-06-26T09:00:00Z }
---

# Orders table

Superseded by the purchases table.

## Columns

`order_id` is the primary key, and `user_id` joins the [Users table](users.md).
