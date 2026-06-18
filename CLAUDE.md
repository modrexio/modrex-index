# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## What this is

TypeScript build pipeline that downloads every mod file from modworkshop.net for PD2, PDTH, and PD3, hashes each `.pak` with SHA256, and stores the results in `index.db` (SQLite). The database is published as a GitHub Release asset (`modrexio/modrex-index`, tag `latest-index`) — never committed to git. `modrex-main` downloads it on startup with a 1-hour TTL cached in `app_data_dir()`.

## Commands

```bash
pnpm install
pnpm build-index                         # Build index.db for all games
pnpm build-index -- --concurrency=10    # Higher concurrency (careful: rate limits)
node check-pak.mjs <path>               # Inspect a single .pak file (reads local app DB, not index.db)
node check-index.mjs                    # Stats + duplicate summary (reads local app DB, not index.db)
node lookup-mod.mjs <name-or-id>        # Look up a mod by name or remote_id (reads local app DB)
```

> The three `*.mjs` dev utils hardcode a path to the installed app's cached DB (`C:/Users/oleh/AppData/…`). To query a freshly built `index.db` instead, edit the `APP_DB` constant at the top of each file.

## Architecture

```
build-index.ts    ← main build script (TypeScript, run via tsx)
check-pak.mjs     ← dev util: inspect a single .pak file
check-index.mjs   ← dev util: query the built index.db
lookup-mod.mjs    ← dev util: look up a mod by SHA256
```

### SQLite schema

```sql
games         (id, name, slug)                                      -- "PAYDAY 3"/"pd3", "PAYDAY 2"/"pd2", "PAYDAY: The Heist"/"pdth"
sources       (id, game_id, name, base_url, game_ref)               -- modworkshop source per game
mods          (id, source_id, remote_id, name, url)                 -- one row per mod
file_contents (sha256)                                              -- deduplication; sha256 is PK
files         (id, mod_id, remote_id, version, sha256, entry_name)  -- one row per .pak file; sha256 FK → file_contents
metadata      (key, value)                                          -- last_run_at timestamp
```

`entry_name` is the pak's path inside its archive (forward slashes; the download's filename for bare paks). Rows indexed before the column existed hold `''` — run `pnpm build-index -- --backfill` once to fill them (it re-downloads only files whose rows lack names). `modrex-main` uses it to list a mod's full pak set for the reinstall-missing-files UI.

`modrex-main` queries via `files → mods → sources → games` filtered by `games.name`. Cross-game isolation is enforced: a PD2 SHA256 never matches a PD3 mod.

### GitHub Actions workflow

Triggered via `workflow_dispatch` (no built-in cron). Hashes mod files from modworkshop, writes `index.db`, uploads as a release asset to the `latest-index` tag (always overwrites — one tag, one asset, consumers always hit the same URL).

The workflow downloads the previous `index.db` from the release before running so the build is incremental. Download is retried up to 5× with an integrity check (`PRAGMA integrity_check`) because the release CDN can briefly serve a stale copy after an asset is replaced. Concurrent runs are queued, not cancelled (`cancel-in-progress: false`), to avoid splitting the shared 90 req/min API budget.

**Run modes** (`workflow_dispatch` inputs / CLI flags):

- _default_ — incremental and **time-windowed**: `listModsSince(lastRunAt)` only examines mods updated since the previous run, and skips files already in `files`.
- `--backfill` — scans **all** mods (`since = null`), still skipping already-indexed files. **Required after any coverage change** (a new archive format, a new game, or raising `PD2_MAX_FULL_DOWNLOAD_BYTES`): the default run never revisits older mods, so previously-skipped files only get picked up by a backfill.
- `--repair-versions` — rewrites the `version` column from the listings; no downloads.

PD2/PDTH mods aren't `.pak` — for them the indexer hashes one representative marker file per mod (`mod.txt` / `main.xml` / wrapper-relative first file via `selectMarkerPath`, chosen to match `modrex-main`'s `first_file_in_dir`). ZIPs use HTTP Range to fetch only that file; RAR/7z have no such trick, so they're fully downloaded and gated by `PD2_MAX_FULL_DOWNLOAD_BYTES` (50 MB) — larger ones are skipped. This is what lets `modrex-main` identify marker-less asset/background packs (incl. recovered host packs) by SHA256.

## Rules

- Commit messages must follow conventional commits: `type(scope): subject`
- Never run any git command that touches the remote. Write out the commands for the user to run.
- Never run `git commit` unless explicitly asked.
