# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## What this is

TypeScript build pipeline that downloads every mod file from modworkshop.net for PD2, PDTH, and PD3, hashes each `.pak` with SHA256, and stores the results in `index.db` (SQLite). The database is published as a GitHub Release asset (`modrexio/modrex-index`, tag `latest-index`) — never committed to git. `modrex-main` downloads it on startup with a 1-hour TTL cached in `app_data_dir()`.

## Commands

```bash
pnpm install
pnpm build-index                         # Build index.db for all games
pnpm build-index -- --concurrency=10    # Higher concurrency (careful: rate limits)
node check-pak.mjs <path>               # Inspect a single .pak file
node check-index.mjs <sha256>           # Query the built index.db
node lookup-mod.mjs <sha256>            # Look up a mod by SHA256
```

## Architecture

```
build-index.ts    ← main build script (TypeScript, run via tsx)
check-pak.mjs     ← dev util: inspect a single .pak file
check-index.mjs   ← dev util: query the built index.db
lookup-mod.mjs    ← dev util: look up a mod by SHA256
```

### SQLite schema

```sql
games   (id, name)                                            -- "PAYDAY 3", "PAYDAY 2", "PAYDAY: The Heist"
sources (id, game_id, source_name)                            -- modworkshop source per game
mods    (id, source_id, remote_id, name)                      -- one row per mod
files   (id, mod_id, remote_id, version, sha256, entry_name)  -- one row per .pak file
```

`entry_name` is the pak's path inside its archive (forward slashes; the download's filename for bare paks). Rows indexed before the column existed hold `''` — run `pnpm build-index -- --backfill` once to fill them (it re-downloads only files whose rows lack names). `modrex-main` uses it to list a mod's full pak set for the reinstall-missing-files UI.

`modrex-main` queries via `files → mods → sources → games` filtered by `games.name`. Cross-game isolation is enforced: a PD2 SHA256 never matches a PD3 mod.

### GitHub Actions workflow

Runs hourly. Downloads all mod files from modworkshop, hashes each `.pak`, writes `index.db`, uploads as a release asset to the `latest-index` tag (always overwrites — one tag, one asset, consumers always hit the same URL).

## Rules

- Commit messages must follow conventional commits: `type(scope): subject`
- Never run any git command that touches the remote. Write out the commands for the user to run.
- Never run `git commit` unless explicitly asked.
