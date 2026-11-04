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

- **#2**: immich-app/immich#22385 (head `41dd5fa2`) cherry-picked onto `main` with mertalev's authorship. The 4 predicted conflicts were resolved, plus one adapt commit for newer route-guard and lint rules.
- **#3**: the report's three fixes:
  - optional device fields;
  - `partial` filtered from 15 sync queries, with completion bumping exif, metadata and album rows;
  - writes at their offset, so the advisory lock no longer spans an upload: 12 stalled uploads used to hang `/users/me`, and 40 now don't.
  - Also a reversible migration, and an upstream bug where a conventional retry kept the truncated partial file.
- **#4**: `backup.upload.maxAppendSizeBytes` (90 MiB), advertised as `max-append-size`.
- **#5**: e2e and medium tests, which found two more bugs:
  - shared links without upload rights could upload;
  - partial uploads looked like duplicates to stock clients.
- **#6**: tag-only ghcr workflow using allowed actions only (not run).
- **#7**: `docs/fork/resumable-uploads.md` and this record.

## Rejected in session

- A Redis lease for exclusivity: a new repository for little gain over positional writes.
- Enforcing `max-append-size`: it would break URLSession, which sends whole files.
- Rejecting append beyond stored length when `Upload-Length` is absent: a protocol change upstream didn't make.
- Touching upstream's e2e spec beyond the broken `/upload` path: the new tests live in their own file.

## Next

A human should raise the conventional-retry bug, the shared-link permission gap and the sync leak upstream; the #22385 thread is locked and `AGENTS.md` forbids LLM-written upstream comments. Then run the stack's CI somewhere it can run. The fork has no Actions workflows registered.
