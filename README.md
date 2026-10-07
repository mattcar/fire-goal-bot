# fire-goal-bot

Posts Chicago Fire goals to Bluesky. A prototype modeled on
[mattcar/nhl-goal-bot](https://github.com/mattcar/nhl-goal-bot) — same
architecture, adapted from the NHL's official API to MLS's data sources.

**Prototype status:** polls real data and formats real goal messages, but is
not deployed anywhere and has never posted to Bluesky. Run it with
`DRY_RUN=true` to validate end-to-end without touching Bluesky.

## How it works

Every `POLL_INTERVAL_MS` (default 30s):

1. Fetch the Fire's matches from the ESPN scoreboard for today + yesterday
   (America/New_York dates, so late finishes are still caught).
2. Resolve each match to an MLS `sportecId` by fetching the match page on
   mlssoccer.com and scraping the embedded id (cached per match).
3. For every LIVE match, fetch the commentary feed from
   `stats-api.mlssoccer.com` and extract every `type == "Goal"` event.
4. Each new goal is verified after `INITIAL_DELAY_MS` (re-fetch; dropped if
   MLS took it back), then posted once. Goals are deduped by MLS event id
   in a persistent JSON store, with a fuzzy fallback for re-issued ids.
5. Posted goals are watched for corrections (scorer/assist/score changes)
   up to `MAX_UPDATES` times.
6. Every resolved match's MLS status is checked each tick; on an observed
   transition into `halfTime` the bot posts `⏸️ HT — <Home> <H>-<A>
   <Away>`, and on transition into a terminal status (`finalWhistle`,
   `fullTime`, …) it posts `⏹️ FT — …`. A match first seen already at
   HT/FT never posts — only transitions the poll loop actually observes —
   and posted flags persist across restarts, so nothing is announced twice.

Robustness patterns carried over from the NHL bot:

- **ET-midnight prune protection** — matches in progress across the ET day
  boundary never lose their goal records, or the next poll reposts
  everything as new.
- **End-of-match sweep** — matches seen live get re-swept for
  `SWEEP_WINDOW_MS` after dropping off the live list, so late-recorded
  goals aren't missed. The live set survives restarts via the store.
- **Health endpoint** on `PORT` (`/` → JSON, 200 when ready).
- **Retry-forever Bluesky login** with backoff; the health endpoint reports
  `degraded` meanwhile. `new Bot({ emitEvents: false })` — the library's
  background event poller stays off (it crashed the NHL bot on a transient
  Bluesky 502).
- **Dry-run mode** — `DRY_RUN=true` logs posts to the console and skips the
  Bluesky login and password requirement entirely.

## Data sources (no API key needed)

| Source | Use |
|---|---|
| `site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard` | Schedule + live state (`pre`/`in`/`post`) |
| `www.mlssoccer.com/.../matches/{home}vs{away}-{MM}-{DD}-{YYYY}/` | Resolve `sportecId` (date is NY-local) |
| `stats-api.mlssoccer.com/matches/{sportecId}/commentary` | Goal events (the `key_events` endpoint does NOT reliably include goals) |

Unlike the NHL's official API, all of these are reverse-engineered rather
than documented, so they can change without notice. Send a browser
User-Agent header on every request.

## Setup

```sh
cp .env.example .env   # fill in BLUESKY_PASSWORD (or use DRY_RUN=true)
npm install
npm test               # full suite
DRY_RUN=true node index.mjs
```

## Message format

```
🔥 GOAL — Chicago Fire: Jonathan Bamba (9') — assisted by Anton Salétros. CHI 1-0 VAN
```

Opponent goals use 🧤 and the opponent's name. The score line is always
`HOME x-y AWAY`.

## Files

- `index.mjs` — poll loop, health server, goal handling, sweeps
- `src/mls.mjs` — ESPN + MLS client (scoreboard, sportecId resolution, commentary)
- `src/goals.mjs` — goal extraction, identity, message formatting
- `src/store.mjs` — persistent dedupe store + ET-day pruning
- `src/bluesky.mjs` — Bluesky posting with session retry
- `src/game-tracker.mjs` — live-set tracking for end-of-match sweeps
- `src/time.mjs` — America/New_York day helpers
- `src/retry.mjs` — retry-forever with exponential backoff
- `test/` — unit tests (`npm test`)

## Open questions

- Which Bluesky account should post (identifier + app password)?
- Deploy target — Render worker (see `render.yaml`), or somewhere else?
- Scope: Fire-only (current) or all MLS goals?
