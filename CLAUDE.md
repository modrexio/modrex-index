# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## What this is

TypeScript build pipeline that downloads every mod file from modworkshop.net for PD2, PDTH, PD3, Crime Boss: Rockay City, and RAID: World War II, hashes the relevant content with SHA256, and stores the results in `index.db` (SQLite). The database is published as a GitHub Release asset (`modrexio/modrex-index`, tag `latest-index`) — never committed to git. A tiny `index-stats.json` asset is published beside it for website counters; it also carries `lastRunAt` — the incremental window — because it's uploaded on every run, unlike `index.db` (a no-op exit-2 run skips the DB upload, so the DB's own `last_run_at` metadata can be stale; the indexer takes the later of the two at startup). `modrex-main` downloads `index.db` on startup with a 1-hour TTL cached in `app_data_dir()`.

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

`7z` must be on `PATH` — used for 7z and RAR extraction and `.pdmod` decryption. Windows: install from 7-zip.org. Ubuntu CI: `sudo apt-get install p7zip-full` (required for RAR support).

## Architecture

```
build-index.ts    ← main build script (TypeScript, run via tsx)
check-pak.mjs     ← dev util: inspect a single .pak file
check-index.mjs   ← dev util: query the built index.db
lookup-mod.mjs    ← dev util: look up a mod by SHA256
```

### SQLite schema

```sql
games         (id, name, slug)                                      -- "PAYDAY 3"/"pd3", "PAYDAY 2"/"pd2", "PAYDAY: The Heist"/"pdth", "Crime Boss: Rockay City"/"cb", "RAID: World War II"/"raid"
sources       (id, game_id, name, base_url, game_ref)               -- modworkshop source per game
mods          (id, source_id, remote_id, name, url)                 -- one row per mod
file_contents (sha256)                                              -- deduplication; sha256 is PK
files         (id, mod_id, remote_id, version, sha256, entry_name)  -- one row per hashed file; sha256 FK → file_contents
metadata      (key, value)                                          -- last_run_at timestamp
```

`entry_name` is the file's path inside its archive (forward slashes; the download's filename for bare files). Rows indexed before the column existed hold `''` — run `pnpm build-index -- --backfill` once to fill them (it re-downloads only files whose rows lack names). `modrex-main` uses it to list a mod's full pak set for the reinstall-missing-files UI.

`modrex-main` queries via `files → mods → sources → games` filtered by `games.name`. Cross-game isolation is enforced: a PD2 SHA256 never matches a PD3 mod. The `games.name` string is load-bearing, not cosmetic — it must match `modrex-main`'s `ModEngineConfig.index_game_name` exactly (e.g. Crime Boss's row is `"Crime Boss: Rockay City"`, matching `CRIMEBOSS_ENGINE.index_game_name`).

### GitHub Actions workflow

Triggered via `workflow_dispatch` (no built-in cron). Hashes mod files from modworkshop, writes `index.db` and `index-stats.json`, uploads both as release assets to the `latest-index` tag (always overwrites — one tag, consumers always hit the same URLs).

The workflow downloads the previous `index.db` from the release before running so the build is incremental. Download is retried up to 5× with an integrity check (`PRAGMA integrity_check`) because the release CDN can briefly serve a stale copy after an asset is replaced. Concurrent runs are queued, not cancelled (`cancel-in-progress: false`), to avoid splitting the shared 90 req/min API budget.

Exit code `2` means "nothing new — skip upload"; the workflow gates the release-asset upload on exit code `0`. Exit `1` means an unhandled error.

**Run modes** (`workflow_dispatch` inputs / CLI flags):

- _default_ — incremental and **time-windowed**: `listModsSince(lastRunAt)` only examines mods updated since the previous run, and skips files already in `files`.
- `--backfill` — scans **all** mods (`since = null`), skipping already-indexed files and mods whose `mod_checks` state is current (see builder state below). Cheap to re-run: a backfill where nothing changed costs roughly the listing pages (~10 min), not the historical ~2 h.
- `--recheck-all` — ignores `mod_checks` entirely; every listed mod is re-examined (the pre-check-state backfill cost). **Required after any coverage change** (a new archive format, a new game, or raising `PD2_MAX_FULL_DOWNLOAD_BYTES`): a plain backfill skips checked mods, so previously-skipped files only get picked up by `--backfill --recheck-all`. Also the escape hatch if a mod was wrongly memoized (corrupt download recorded as zero-yield, or a mod change that didn't touch its `updated_at`).
- `--repair-versions` — rewrites the `version` column from the listings; no downloads.

### Builder state (`builder-state.db`)

A second SQLite DB published as its own asset on the same `latest-index` release — CI bookkeeping only, never downloaded by the app. One table: `mod_checks(source_id, remote_id, updated_at, file_ids, checked_at)` — per mod, the listing `updated_at` it was last fully processed at and which file remote_ids that pass yielded. A mod is skipped (zero API calls, zero downloads) when its listing `updated_at` matches the recorded one **and** every recorded file id is still present in `files` — the second condition means a stale `index.db` restored from the release CDN can never be masked by newer check state (state only accelerates; `index.db` stays authoritative). Checks are recorded only for mods that processed without errors, so failures stay retryable. Kept out of `index.db` deliberately: zero-yield mods must never become `mods` rows, because `modrex-main`'s `query_by_name` identifies a mod only when exactly one `LIKE` match exists — bloating `mods` with unindexable entries would silently break name-based identification in the app. The workflow's download of it is best-effort (missing/corrupt state degrades to a full recheck, never a failed job) and it's uploaded on exit 0 and 2 alike, so check state advances even on no-new-files runs.

PD3 and Crime Boss are both UE pak-based with no marker-file shortcut available, so they share one extraction path (`buildContentTasks`, parameterized per game): the whole archive is downloaded and `extractContentEntries` pulls out every entry matching `CONTENT_EXTENSIONS` (`.pak`, `.ucas`, `.utoc`, `.lua`) — not just `.pak`. `.ucas`/`.utoc` are UE IoStore's other two pieces of a mod's cooked content (present for nearly every Crime Boss mod, less often for PD3); `.lua` is a UE4SS Lua sub-mod's script entry point, added so `modrex-main`'s ambient scan can eventually identify standalone UE4SS sub-mods by SHA256 the same way it identifies `.pak` mods. **Known caveat**: `modrex-main`'s `hashable_file_for_mod_dir` picks a Directory-unit mod's representative file via `first_pak_file_in_dir` → `first_file_in_dir` (alphabetically-first file, depth-first) when there's no `.pak`/`main.xml`. For a UE4SS sub-mod shaped exactly like `Scripts/main.lua` with nothing else at the root, that already resolves to the same file this indexer hashes — but a sub-mod with other root-level files/folders sorting before `Scripts` would hash something different on each side, and the SHA256 wouldn't match. This hasn't been fixed on the `modrex-main` side; it's a known partial limitation, not a bug here.

`detectFormat` also recognizes RAR by magic bytes (`Rar!\x1a\x07`) for this path — found missing after a live backfill showed several real Crime Boss mods (e.g. character cosmetic mods distributed as `.rar`) silently produced zero indexed files: `shouldDownload` didn't recognize the `"rar"` modworkshop file type at all, so the file was skipped before download ever started. Both gaps are fixed (`shouldDownload` now includes `rar`; the RAR branch shells out to the same `7z` CLI `extractPd2FromFull` already uses for PD2/PDTH, extracting everything and filtering by `CONTENT_EXTENSIONS` in JS rather than relying on 7z's RAR mask support, which is less reliable than for zip/7z). **Verify after the next backfill**: a real RAR-only mod (e.g. modworkshop id `56889`, "Hideo Kojima") should go from 0 indexed files to its expected count.

PD2/PDTH/RAID mods aren't `.pak` — for them the indexer hashes one representative marker file per mod (`mod.txt` / `main.xml` / `supermod.xml` / `mod.xml` / wrapper-relative first file via `selectMarkerPath`, chosen to match `modrex-main`'s `hashable_file_for_mod_dir`). `supermod.xml` (RAID-SuperBLT) and `mod.xml` (legacy RaidBLT) are RAID's markers — the RAID BLT fork has no `mod.txt`; they sit below the PD2/PDTH markers in the preference order so archives shipping both keep their existing pick. ZIPs use HTTP Range to fetch only that file; RAR/7z have no such trick, so they're fully downloaded and gated by `PD2_MAX_FULL_DOWNLOAD_BYTES` (50 MB) — larger ones are skipped. This is what lets `modrex-main` identify marker-less asset/background packs (incl. recovered host packs) by SHA256.

PDTH additionally handles `.pdmod` files: decrypted via `7z` with a hardcoded password, then the `pdmod.json` manifest's `BundlePath`/`BundleExtension` uint64 fields are resolved against `pdmod_hashlist.txt` (committed, 130k entries, Bob Jenkins lookup8) to recover asset paths — the alphabetically-first resolved path's replacement file is hashed. `pdmod_hashlist.txt` must stay committed; without it all `.pdmod` mods produce zero indexed files.

## Agent skills

Reusable skills live in `.agents/skills/` at the workspace root (`C:\local\modrexio`) — this repo has no `.claude/` or `.agents/` of its own, so the slash commands are only available in a session started at that root, passing `modrex-index` as the argument:

- `/commit modrex-index` — read the current diff and propose a conventional commit message; waits for confirmation before committing.
- `/deslop modrex-index` — audit the diff for AI-generated slop and fix each issue found.

## Rules

- Commit messages must follow conventional commits: `type(scope): subject`
- Never run any git command that touches the remote. Write out the commands for the user to run.
- Never run `git commit` unless explicitly asked.
