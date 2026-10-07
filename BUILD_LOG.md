# fire-goal-bot — build log

Built 2026-10-06 (evening) as a prototype. Not deployed, never posted to
Bluesky, no GitHub repo/PR created.

## What was built

Node.js bot in `~/workspace/fire-goal-bot/` mirroring the architecture of
`mattcar/nhl-goal-bot` (main branch), adapted from the NHL's official API
to MLS's reverse-engineered data sources:

- `package.json` — `@skyware/bot ^0.4.1`, `node --test "test/*.test.mjs"`
- `index.mjs` — poll loop (~30s), health server, per-goal verify-then-post,
  correction handling, ET-day pruning, end-of-match sweeps, DRY_RUN console poster
- `src/config.mjs` — env config; `BLUESKY_PASSWORD` required unless `DRY_RUN=true`
- `src/mls.mjs` — ESPN scoreboard client (today+yesterday, NY dates),
  mlssoccer.com sportecId resolution (cached, defensive on bad slugs),
  stats-api commentary + match detail
- `src/goals.mjs` — goal extraction from commentary text, fuzzy identity,
  message formatting
- `src/store.mjs`, `src/bluesky.mjs`, `src/game-tracker.mjs`,
  `src/time.mjs`, `src/retry.mjs` — copied verbatim from nhl-goal-bot
  (persistent JSON store w/ queued atomic saves, `new Bot({ emitEvents: false })`,
  restart-safe sweep tracking, NY day helpers, retry-forever)
- `test/` — 8 test files, 61 tests total
- `.env.example`, `render.yaml` (worker + persistent disk), `.gitignore`, `README.md`

Key NHL-bot lessons carried over: emitEvents:false, persistent dedupe store,
ET-midnight prune protection for in-progress matches, end-of-match re-sweep
window, health endpoint before login, retry-forever login, dry-run mode.

## Data sources (all verified live 2026-10-06, no key, browser UA header)

1. `site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard?dates=YYYYMMDD`
   — Fire matches, live state (`pre`/`in`/`post`)
2. `www.mlssoccer.com/.../matches/{home}vs{away}-{MM}-{DD}-{YYYY}/`
   — sportecId scrape; site is case-insensitive on slugs; URL date is NY-local
3. `stats-api.mlssoccer.com/matches/{sportecId}/commentary?per_page=100`
   — goal events (type == "Goal"). The sibling `key_events` endpoint does
   NOT reliably include goals, so commentary is the source of truth.

## Test results

`npm test`: **61/61 pass, 0 fail** (22 suites).

Fixtures use the real verified feed shape. Two test-only bugs found and
fixed during the build (fuzzy-match test kept the same eventId; game-tracker
re-live test mis-sequenced) — source code was correct in both cases.

## Live dry-run results (DRY_RUN=true, 2026-10-06 ~8:30 PM CT)

Ran ~90s against the live feeds during CHI vs VAN (live, 45'+4' at start).
The bot resolved sportecId `MLS-MAT-0009H7`, extracted the goal, verified it
on re-fetch, and "posted" to console. Dedupe confirmed: the store recorded
`MLS-MAT-0009H7:1228300000136 -> posted: true`, so a restart would not repost.

End-to-end extraction from the real feed produced exactly the target format:

```
🔥 GOAL — Chicago Fire: Jonathan Bamba (9') — assisted by Anton Salétros. CHI 1-0 VAN
```

(44 commentary items → 1 goal extracted.) The dry-run store file was
deleted afterwards so the tree starts clean.

## Open questions

1. Which Bluesky account posts? (identifier + app password — Matt's personal
   handle or a dedicated bot account)
2. Deploy target — Render worker per `render.yaml`, or elsewhere?
3. Scope: Fire-only (current) or all MLS goals?
4. MLS sources are unofficial/reverse-engineered and can change without
   notice — worth a periodic health check if this goes to production.

## Update 2026-10-07 — HT/FT score posts

Matt asked the bot to also post half-time and full-time scores, not just
goals. Added (prototype only, still nothing posted/deployed):

- `src/game-tracker.mjs` — per-match last-seen MLS status map
  (`matchStatuses`: id -> { status, htPosted, ftPosted }), persisted in the
  tracker's store snapshot. `updateMatchStatuses()` reports each observed
  transition into `halfTime` / a terminal status exactly once. Statuses are
  matched case-insensitively; terminal set = fullTime, finalWhistle (the
  value the feed actually uses — observed on the finished CHI-VAN match),
  finished, ended, complete, ft, aet, afterextratime. Unknown statuses
  (e.g. hypothetical extraTime/shootout) are recorded without posting and
  never throw. A match first seen already at HT/FT never posts — only
  transitions the poll loop actually observes.
- `src/goals.mjs` — `formatHTMessage()` / `formatFTMessage()`:
  `⏸️ HT — Chicago Fire 1-0 Vancouver Whitecaps`,
  `⏹️ FT — Chicago Fire 3-1 Vancouver Whitecaps` (home team first, FC
  suffix stripped like goal messages).
- `src/mls.mjs` — `getMatchDetail()` now also returns `homeName`/`awayName`
  from the match detail response.
- `index.mjs` — each tick fetches match detail for every resolved match
  (not just ESPN-live ones, since ESPN can flip to "post" between polls)
  and posts HT/FT transitions via the same poster (console in DRY_RUN).
- `test/match-status.test.mjs` — 17 new tests: HT on firstHalf->halfTime,
  FT on secondHalf->fullTime and ->finalWhistle, no post on first sight at
  HT/FT, no dupes after restart (snapshot round-trip), FT-only when
  halfTime was never observed, unknown statuses safe, case-insensitivity,
  exact message formats, and a fixture test against the recorded real
  `finalWhistle` 3-1 detail payload.

`npm test`: **78/78 pass, 0 fail** (27 suites).

Dry-run validation against the real API (2026-10-07, finished CHI-VAN
match `MLS-MAT-0009H7`, 3-1, status `finalWhistle`):
- Seeded-tracker simulation (prev status secondHalf -> real API detail):
  posted exactly `⏹️ FT — Chicago Fire 3-1 Vancouver Whitecaps`;
  re-observation produced 0 transitions (no dupe).
- Full bot in DRY_RUN observed the finished match fresh and correctly
  posted nothing (status recorded silently as `finalwhistle` in the
  persisted tracker snapshot) — the no-post-on-startup rule holds
  end-to-end.

Matt's decisions recorded 2026-10-07 (from main agent): dedicated new
Bluesky account (Matt will create it), deploy on Render like the NHL bot,
Fire-only scope.
