/**
 * fire-goal-bot — polls MLS/ESPN data for Chicago Fire matches and posts
 * goals to Bluesky.
 *
 * Loop: every POLL_INTERVAL_MS, fetch the Fire's matches from the ESPN
 * scoreboard (today + yesterday, to catch late finishes), resolve each to
 * an MLS sportecId via the match page, and for each LIVE match fetch the
 * commentary feed and handle every type=="Goal" event. Each goal is
 * verified (re-fetched after INITIAL_DELAY_MS to catch quick corrections),
 * posted once, then watched for corrections up to MAX_UPDATES times.
 * Games that drop out of the live list get a final sweep — re-run for a
 * while afterwards — so end-of-game goals are not missed when the MLS
 * feed is slow to record them.
 *
 * State persists in GOAL_STORE_PATH so restarts don't repost goals.
 *
 * DRY_RUN=true posts to the console only (no Bluesky login, no password
 * required) — the safe way to validate against the live feeds.
 */

import http from 'node:http';
import { loadConfig } from './src/config.mjs';
import { MlsClient, liveMatchIds, nyDateKey } from './src/mls.mjs';
import {
  extractGoals,
  goalKey,
  isSameGoal,
  changedFields,
  formatGoalMessage,
  formatCorrectionMessage,
  formatHTMessage,
  formatFTMessage,
} from './src/goals.mjs';
import { GoalStore, pruneOldGoals } from './src/store.mjs';
import { BlueskyPoster } from './src/bluesky.mjs';
import { GameTracker } from './src/game-tracker.mjs';
import { retryForever } from './src/retry.mjs';
import { etDayKey, isSameETDay, formatET } from './src/time.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message, data) => {
  if (data === undefined) console.log(`[${formatET()}] ${message}`);
  else console.log(`[${formatET()}] ${message}`, data);
};

/** Drop-in poster for DRY_RUN: logs instead of posting to Bluesky. */
class ConsolePoster {
  async login() {}
  async post(text) {
    log('[dry-run] would post:', text);
    return { uri: 'dry-run:console' };
  }
}

function dateKeysToScan() {
  const now = Date.now();
  const today = nyDateKey(now);
  const yesterday = nyDateKey(now - 24 * 60 * 60 * 1000);
  return today === yesterday ? [today] : [yesterday, today];
}

async function main() {
  const config = loadConfig();
  const mls = new MlsClient({
    espnBaseUrl: config.espnBaseUrl,
    mlsStatsBaseUrl: config.mlsStatsBaseUrl,
    season: config.mlsSeason,
  });
  const poster = config.dryRun
    ? new ConsolePoster()
    : new BlueskyPoster({
        identifier: config.blueskyIdentifier,
        password: config.blueskyPassword,
      });
  const store = await new GoalStore(config.storePath).load();

  // Protect currently-live games from the prune below: a restart landing
  // across ET midnight must not wipe a game in progress — the next poll
  // would repost every goal as new. Best-effort; a fetch failure just
  // falls back to the unprotected prune.
  let liveNow = [];
  try {
    const matches = await mls.getFireMatches(dateKeysToScan());
    for (const match of matches) {
      const sportecId = await mls.resolveSportecId(match);
      if (match.state === 'in' && sportecId) liveNow.push(sportecId);
    }
  } catch (err) {
    log(`Startup: couldn't fetch live games to protect from prune: ${err.message}`);
  }
  pruneOldGoals(store, config, liveNow);
  await store.save();

  // Health reporting starts before anything that can fail and kill the
  // process, so a bad deploy or an upstream outage is visible instead of
  // just a crash loop. 200 = ready, 503 = still starting or degraded.
  const health = {
    state: 'starting', // starting | ready | degraded
    startedAt: Date.now(),
    lastTickAt: null,
    lastTickOk: null,
    goalsPosted: 0,
  };
  const server = http.createServer((req, res) => {
    const body = JSON.stringify({
      status: health.state === 'ready' ? 'ok' : health.state,
      uptimeSec: Math.floor((Date.now() - health.startedAt) / 1000),
      lastTickAt: health.lastTickAt ? new Date(health.lastTickAt).toISOString() : null,
      lastTickOk: health.lastTickOk,
      goalsPosted: health.goalsPosted,
      dryRun: config.dryRun,
    });
    res.writeHead(health.state === 'ready' ? 200 : 503, {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'",
    });
    res.end(body);
  });
  server.listen(config.port, () => log(`Health check listening on port ${config.port}`));

  // A failed login used to be fatal in the NHL bot (exit 1 -> Render
  // restart -> crash loop if Bluesky is down or the password is wrong).
  // Here we stay up and keep retrying with backoff; the health endpoint
  // reports "degraded" meanwhile. Skipped entirely in dry-run mode.
  if (!config.dryRun) {
    await retryForever(() => poster.login(), {
      onError: (err, waitMs, attempt) => {
        health.state = 'degraded';
        log(`Bluesky login failed (attempt ${attempt}), retrying in ${Math.round(waitMs / 1000)}s: ${err.message}`);
      },
    });
  } else {
    log('DRY_RUN: skipping Bluesky login, posts go to the console');
  }
  health.state = 'ready';
  log('Ready');

  /** Goal keys currently being handled; the poll loop never awaits these. */
  const inFlight = new Set();

  /**
   * Matches seen LIVE, so just-ended matches get a final sweep — re-run
   * for a while afterwards in case the MLS feed is slow to record
   * last-second goals. The live set is restored from the store so a
   * restart landing exactly on a match ending doesn't skip that match's
   * final sweep. Stale snapshots (long downtime) are discarded by
   * fromSnapshot — sweeping those matches could repost goals whose
   * records were already pruned.
   */
  const gameTracker = GameTracker.fromSnapshot(store.getMeta('gameTracker'), {
    maxAgeMs: config.scoreMaxAgeMs,
    sweepWindowMs: config.sweepWindowMs,
  });
  if (gameTracker.recentlyLive.size > 0) {
    log('Restored game tracker live set', [...gameTracker.recentlyLive]);
  }

  /** Exact key hit, else a fuzzy match for a re-issued event id. */
  function findRecord(matchId, goal) {
    const exact = store.get(goalKey(matchId, goal));
    if (exact) return exact;
    for (const [key, record] of store.entries()) {
      if (key.startsWith(`${matchId}:`) && isSameGoal(record.goal, goal)) {
        return record;
      }
    }
    return undefined;
  }

  async function handleGoal(matchId, goal, teams) {
    const key = goalKey(matchId, goal);
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      const record = findRecord(matchId, goal);

      if (record?.posted) {
        await maybePostCorrection(key, record, goal, teams);
        return;
      }

      let rec = record;
      if (!rec) {
        rec = {
          goal,
          posted: false,
          updateCount: 0,
          firstSeen: Date.now(),
          timestamp: Date.now(),
        };
        store.set(key, rec);
        await store.save();
        log(`New goal ${key}, verifying in ${config.initialDelayMs / 1000}s`);
        await delay(config.initialDelayMs);

        // Re-fetch: skip goals MLS already took back, and never
        // double-post if another handler got here first.
        const fresh = extractGoals(await mls.getCommentary(matchId));
        const stillThere = fresh.some((g) => g.eventId === goal.eventId);
        const current = store.get(key);
        if (!stillThere) {
          log(`Goal ${key} vanished on re-check, dropping`);
          store.delete(key);
          await store.save();
          return;
        }
        if (!current || current.posted) return;
        rec = current;
      }

      const response = await poster.post(formatGoalMessage(goal, teams));
      rec.posted = true;
      rec.timestamp = Date.now();
      health.goalsPosted += 1;
      await store.save();
      log(`Posted goal ${key}`, { uri: response.uri });
      await delay(config.postDelayMs);
    } catch (err) {
      log(`Goal handler failed for ${key}: ${err.message}`);
    } finally {
      inFlight.delete(key);
    }
  }

  async function maybePostCorrection(key, record, goal, teams) {
    if (record.updateCount >= config.maxUpdates) return;
    if (!isSameETDay(record.timestamp)) return;
    const fields = changedFields(record.goal, goal);
    if (fields.length === 0) return;

    record.updateCount += 1;
    const response = await poster.post(formatCorrectionMessage(goal, record.goal, teams));
    record.goal = goal;
    record.timestamp = Date.now();
    await store.save();
    log(`Posted correction for ${key}`, { uri: response.uri, fields });
  }

  async function pollGames() {
    const matches = await mls.getFireMatches(dateKeysToScan());
    // Resolve every match to a sportecId (cached); unresolvable ones are
    // skipped gracefully — a wrong slug guess must never kill the poll.
    const resolved = [];
    for (const match of matches) {
      try {
        const sportecId = await mls.resolveSportecId(match);
        if (sportecId) resolved.push({ ...match, sportecId });
        else log(`Skipping match ${match.espnId} (${match.away.abbrev} at ${match.home.abbrev}): no sportecId`);
      } catch (err) {
        log(`Skipping match ${match.espnId}: ${err.message}`);
      }
    }
    const teamsByMatch = new Map(
      resolved.map((m) => [m.sportecId, { home: m.home, away: m.away }]),
    );
    const liveIds = liveMatchIds(resolved);
    if (liveIds.length > 0) log('Live matches:', liveIds);

    // Final sweep for matches that just ended — re-run for a while
    // afterwards. The MLS feed can lag on late goals; a single sweep at
    // full time misses those. Re-sweeping is safe: posted goals are
    // never posted twice.
    for (const matchId of gameTracker.gamesToSweep(liveIds)) {
      try {
        const teams = teamsByMatch.get(matchId) ?? { home: {}, away: {} };
        log(`Sweeping ended match ${matchId}`);
        for (const goal of extractGoals(await mls.getCommentary(matchId))) {
          // Fire and forget, same as the live loop below.
          handleGoal(matchId, goal, teams).catch((err) =>
            log(`Goal handler crashed: ${err.message}`),
          );
        }
      } catch (err) {
        log(`Sweep failed for match ${matchId}: ${err.message}`);
      }
    }

    for (const matchId of liveIds) {
      try {
        const teams = teamsByMatch.get(matchId) ?? { home: {}, away: {} };
        for (const goal of extractGoals(await mls.getCommentary(matchId))) {
          // Fire and forget: slow per-goal delays must not stall the poll loop.
          handleGoal(matchId, goal, teams).catch((err) =>
            log(`Goal handler crashed: ${err.message}`),
          );
        }
      } catch (err) {
        log(`Skipping match ${matchId}: ${err.message}`);
      }
    }

    // Half-time / full-time posts: check every resolved match's MLS
    // status (not just ESPN-live ones — ESPN can flip a match to "post"
    // between our polls while MLS still shows the transition). A post
    // fires only on a transition the poll loop actually observes; a
    // match already at halfTime/fullTime when first seen never posts.
    const statuses = new Map();
    for (const match of resolved) {
      try {
        const detail = await mls.getMatchDetail(match.sportecId);
        statuses.set(match.sportecId, {
          status: detail.match_status,
          homeScore: detail.home_team_goals,
          awayScore: detail.away_team_goals,
          homeName: detail.homeName || match.home.name,
          awayName: detail.awayName || match.away.name,
        });
      } catch (err) {
        log(`Skipping status check for ${match.sportecId}: ${err.message}`);
      }
    }
    for (const transition of gameTracker.updateMatchStatuses(statuses)) {
      try {
        const text =
          transition.kind === 'ht'
            ? formatHTMessage(transition)
            : formatFTMessage(transition);
        const response = await poster.post(text);
        log(`Posted ${transition.kind.toUpperCase()} for ${transition.matchId}`, {
          uri: response.uri,
        });
        await delay(config.postDelayMs);
      } catch (err) {
        log(`HT/FT post failed for ${transition.matchId}: ${err.message}`);
      }
    }
  }

  // Prune once per ET day, then poll.
  let lastDay = etDayKey();
  async function tick() {
    try {
      const today = etDayKey();
      if (today !== lastDay) {
        lastDay = today;
        // Matches seen live on the previous poll may still be in progress
        // across the ET midnight boundary — never prune their records, or
        // the next poll reposts every goal as new.
        const removed = pruneOldGoals(store, config, gameTracker.recentlyLive);
        await store.save();
        log(`New ET day, pruned ${removed} old goal record(s)`);
      }
      await pollGames();
      health.lastTickAt = Date.now();
      health.lastTickOk = true;
    } catch (err) {
      health.lastTickAt = Date.now();
      health.lastTickOk = false;
      log(`Poll cycle failed: ${err.message}`);
    }
    // Persist the live set every cycle (tiny atomic write) so a restart
    // keeps final-sweep coverage for matches ending around the restart.
    store.setMeta('gameTracker', gameTracker.toJSON());
    await store.save();
  }

  await tick();
  const timer = setInterval(tick, config.pollIntervalMs);

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      log(`${signal} received, shutting down`);
      clearInterval(timer);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

main().catch((err) => {
  console.error('Fatal startup error:', err.message);
  process.exit(1);
});
