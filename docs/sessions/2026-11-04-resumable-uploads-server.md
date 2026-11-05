---
session: 2026-11-04
repo: photos
branch: claude/lucid-mayer-yq872n (stack of six, up to claude/lucid-mayer-yq872n-docs)
driver: Claude Code, for CJ
outcome: open
---

# Resumable uploads, server half

## Intent

Ship the server half of chunked, resumable uploads from `docs/research/chunked-uploads.md`, as small draft PRs that stock apps survive.

## What changed

- **#2**: immich-app/immich#22385 (head `41dd5fa2`) cherry-picked with mertalev's authorship, plus an adapt commit. Review: migration renamed after main's newest, with a test on ORDER.
- **#3**: optional device fields; `partial` kept out of sync; positional writes so uploads don't pin connections; a reversible migration; a truncated-retry bug fixed. Review:
  - `withUuidLock` deadlock fixed;
  - declared length enforced;
  - an `asset_upload` claim so appends, cancel and cleanup can't unlink a file mid-write;
  - retries truncate and hash the whole file.
- **#4**: `max-append-size` advertised. Review: it's now enforced (413), the sweep is scheduled plus an `upload-cleanup` job, `max-age` counts down, and a cap of 20 open uploads per user.
- **#5**: tests, plus two bugs they found (shared-link upload rights, partials as duplicates). Review:
  - uploads tied to their creating session, key or link;
  - the stock replacement takes the claim;
  - partials hidden from generic asset routes.
- **#5, pre-deploy round:**
  - the owner's devices share uploads again;
  - shared links are one-shot, so they can't hold quota or slots;
  - the integrity checker skips partials;
  - stock clients get 503 rather than a duplicate pointing at a partial.
- **#6**: tag-only ghcr workflow (not run).
- **#7**: endpoint note, rollback runbook, this record.

## Rejected in session

- A Redis lease: the `asset_upload` row gives the same exclusivity without a new repository.
- Binding uploads to one session: devices of one account deleted each other's progress.
- Answering HEAD only for partial uploads: RUFH clients HEAD a finished upload to learn it completed, and upstream tests that. Shared links get 404 instead.
- Strict caps under concurrency: the per-user cap can overshoot by the requests in flight.

## Next

A human should raise the upstream bugs found here (conventional retry, shared-link permissions, sync leak, unscheduled sweep, unenforced length); the #22385 thread is locked and `AGENTS.md` forbids LLM-written upstream comments. Upstream's workflows can't start on this fork (org allow-list and secrets), so the stack has no CI yet.
