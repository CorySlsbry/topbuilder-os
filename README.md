# topbuilder os

> **Portfolio snapshot.** A sanitized, history-free copy of a private repository, published to show the work.
> Credentials, customer and lead data, internal notes and third-party material were removed, and real client
> and people names were replaced with fictional ones, so this copy is not meant to run as-is.

- **What it is:** Top Builder OS, a unified ServiceTitan plus QuickBooks Online replacement for 1-10 person trades shops.
- **Stack:** Next.js, React, Vitest, Drizzle, Zod
- **Languages:** TypeScript, SQL, JavaScript, CSS
- **Private repo history:** 121 commits, 2026-07-23 to 2026-08-24
- **This snapshot:** 566 files, 95 test files
- **Built by:** Cory Salisbury, with Claude Code

_All rights reserved. Shared for portfolio review only; no license is granted to copy, modify or redistribute this code._

---

The unified operating + financial system of record for 1–10 person trades and
construction shops — one coherent system replacing ServiceTitan (front + back
of house) and QuickBooks Online (a double-entry general ledger we own).

Greenfield. Next.js 16 + TypeScript (strict) on Cloud Run + Cloud SQL Postgres
(RLS FORCE, fail-closed) in GCP `builder-ai-497610`. Modular monolith with
CI-enforced module boundaries. See the build plan for the full architecture.

## Prerequisites
- Node ≥ 20.9 (dev on 24), pnpm 10, Docker.

## Local development
```bash
pnpm install
cp .env.example .env.local        # then fill in DATABASE_URL / MIGRATE_DATABASE_URL
pnpm db:up                        # local Postgres 16 + pgTAP (builds db/Dockerfile)
pnpm migrate                      # apply migrations/*.sql (as MIGRATE_DATABASE_URL)
pnpm dev                          # http://localhost:3000  ·  health: /healthz
```

## Verify (what CI runs)
```bash
pnpm verify   # typecheck + lint (incl. module-boundary rules) + next build
pnpm test     # vitest (money math is TDD'd first)
```

## Layout
```
src/app/        # Next.js App Router (HTTP/UI layer)
src/middleware  # per-request security headers (nonce CSP, HSTS, XFO)
src/lib/        # cross-cutting: db (withTenant), http, money, env
src/modules/    # domain modules — each exposes ONLY its index.ts port
migrations/     # forward-only SQL migrations (run as the migration role)
db/             # local/CI Postgres image (with pgTAP) + init scripts
scripts/        # migrate runner, ops scripts
docs/           # SECURITY_AUDIT.md, NEEDS-CORY.md
```

## Non-negotiables
- **We own the books:** every number is deterministic, TDD'd code — never
  AI-invented. Money is integer cents; the journal is append-only + immutable.
- **Three-level isolation:** tenant + department + role, RLS fail-closed,
  resolved server-side from the directory — never a token claim.
- **Automation-first AI:** the LLM is a bounded helper that proposes and
  narrates; it never computes a figure or drives control flow. Every action is
  human-reviewable (approve / revise / reject) and the system learns from each.
