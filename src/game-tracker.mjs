/**
 * Tracks which games have been seen LIVE so the poll loop can run a final
 * sweep when a game drops out of the live list — plus re-sweeps for games
 * that ended recently.
 *
 * Why: the bot only processes LIVE games, but the NHL API records last-second
 * goals (late regulation, OT winners) right as the game state flips away
 * from LIVE, and on busy nights the API can take several more minutes to
 * record them. A single sweep at the final horn misses those goals, so ended
 * games stay eligible for re-sweeps for a configurable window. Re-sweeping
 * is safe: posted goals are never posted twice.
 *
 * The live set is serializable so a restart doesn't lose it: if the process
 * restarts while a game is ending, the restored tracker still triggers the
 * final sweep for that game.
 */

import { isSameETDay } from './time.mjs';

/** Default re-sweep window: keep sweeping ended games for 20 minutes. */
export const DEFAULT_SWEEP_WINDOW_MS = 20 * 60 * 1000;

/**
 * MLS match statuses that mean half time, normalized to lowercase.
 * The feed has been observed using "halfTime".
 */
export const HALF_TIME_STATUS = 'halftime';

/**
 * MLS match statuses that mean the match is over, normalized to
 * lowercase. The feed has been observed using "finalWhistle" for a
 * finished match (not "fullTime"); the set is intentionally broad and
 * matched case-insensitively so a new terminal status degrades to a
 * missed post, never a crash.
 */
export const FULL_TIME_STATUSES = new Set([
  'fulltime',
  'finalwhistle',
  'finished',
  'ended',
  'complete',
  'ft',
  'aet',
  'afterextratime',
]);

/** Normalize a raw MLS match_status for comparison; '' when missing. */
export function normalizeStatus(status) {
  return String(status ?? '').toLowerCase();
}

/** Score/team fields carried on an HT/FT transition event. */
function scoreFields(current) {
  return {
    homeScore: current?.homeScore ?? null,
    awayScore: current?.awayScore ?? null,
    homeName: current?.homeName ?? '',
    awayName: current?.awayName ?? '',
  };
}

export class GameTracker {
  constructor({ sweepWindowMs = DEFAULT_SWEEP_WINDOW_MS } = {}) {
    /** Game ids seen LIVE on the most recent poll. */
    this.recentlyLive = new Set();
    /** Game ids that ended recently: id -> ms epoch when first seen ended. */
    this.recentlyEnded = new Map();
    /** When the live set was last refreshed (ms epoch). */
    this.updatedAt = Date.now();
    /** How long after a game ends it stays eligible for re-sweeps. */
    this.sweepWindowMs = sweepWindowMs;
    /**
     * Last observed MLS match status per game id:
     * id -> { status (normalized), htPosted, ftPosted }.
     * A post fires only on a transition the poll loop actually observes:
     * the previous status must be known and different, and the matching
     * posted flag must be unset. This keeps a restart from posting HT/FT
     * for a game that was already there — the restored map shows no
     * transition, and the posted flags survive in the snapshot.
     */
    this.matchStatuses = new Map();
  }

  /**
   * Given the ids currently LIVE, return ids that were live on the previous
   * poll but are not anymore (presumed just ended). Each ended id is
   * reported exactly once; the live set is replaced for the next call.
   * Newly ended games are stamped into the recently-ended set so
   * gamesToSweep() can re-sweep them while the NHL API catches up.
   */
  endedGames(liveIds, { now = Date.now() } = {}) {
    const live = new Set(liveIds);
    const ended = [...this.recentlyLive].filter((id) => !live.has(id));
    this.recentlyLive = live;
    this.updatedAt = now;
    for (const id of ended) {
      if (!this.recentlyEnded.has(id)) this.recentlyEnded.set(id, now);
    }
    // A game seen live again (e.g. schedule API flakiness) leaves the
    // recently-ended set; if it ends again it gets a fresh timestamp.
    for (const id of live) this.recentlyEnded.delete(id);
    return ended;
  }

  /**
   * Ids to sweep on this poll: newly ended games plus games that ended
   * within the sweep window. Games whose window expired are dropped.
   */
  gamesToSweep(liveIds, { now = Date.now() } = {}) {
    this.endedGames(liveIds, { now });
    const targets = [];
    for (const [id, endedAt] of this.recentlyEnded) {
      if (now - endedAt <= this.sweepWindowMs) targets.push(id);
      else this.recentlyEnded.delete(id);
    }
    return targets;
  }

  /**
   * Observe the current MLS match status of each game and report
   * half-time / full-time transitions the poll loop should post.
   *
   * `statuses`: Map of game id -> { status, homeScore, awayScore,
   * homeName, awayName } with the raw (unnormalized) status string.
   *
   * Returns an array of { matchId, kind: 'ht' | 'ft', from, to,
   * homeScore, awayScore, homeName, awayName }. Each transition is
   * reported exactly once: the posted flag is set before returning, and
   * a game with no previously recorded status never fires (it may have
   * been sitting at that status since before the bot started). Unknown
   * statuses are recorded without posting and never throw.
   */
  updateMatchStatuses(statuses) {
    const transitions = [];
    for (const [matchId, current] of statuses) {
      const to = normalizeStatus(current?.status);
      const prev = this.matchStatuses.get(matchId);
      if (prev) {
        if (!prev.htPosted && to === HALF_TIME_STATUS && prev.status !== HALF_TIME_STATUS) {
          prev.htPosted = true;
          transitions.push({ matchId, kind: 'ht', from: prev.status, to, ...scoreFields(current) });
        }
        if (
          !prev.ftPosted &&
          FULL_TIME_STATUSES.has(to) &&
          !FULL_TIME_STATUSES.has(prev.status)
        ) {
          prev.ftPosted = true;
          transitions.push({ matchId, kind: 'ft', from: prev.status, to, ...scoreFields(current) });
        }
        prev.status = to;
      } else {
        // First sighting: record silently. Posting here would announce a
        // half time / full time the bot never saw begin.
        this.matchStatuses.set(matchId, { status: to, htPosted: false, ftPosted: false });
      }
    }
    return transitions;
  }

  /** Serializable snapshot of the live set, for the durable store. */
  toJSON() {
    return {
      recentlyLive: [...this.recentlyLive],
      recentlyEnded: [...this.recentlyEnded],
      updatedAt: this.updatedAt,
      matchStatuses: [...this.matchStatuses],
    };
  }

  /**
   * Rebuild a tracker from a snapshot (or start empty when there is none).
   *
   * Stale snapshots are discarded: after a long downtime, the goal records a
   * final sweep would consult may already have been pruned, and sweeping
   * those games would repost old goals. A snapshot is fresh only when it is
   * younger than maxAgeMs and from the same ET day — the two conditions on
   * which goal records are pruned.
   */
  static fromSnapshot(snapshot, { maxAgeMs, sweepWindowMs, now = Date.now() } = {}) {
    const tracker = new GameTracker({ sweepWindowMs });
    const age = snapshot ? now - snapshot.updatedAt : NaN;
    const fresh =
      snapshot &&
      Array.isArray(snapshot.recentlyLive) &&
      Number.isFinite(maxAgeMs) &&
      age >= 0 &&
      age <= maxAgeMs &&
      isSameETDay(snapshot.updatedAt, now);
    if (fresh) {
      tracker.recentlyLive = new Set(snapshot.recentlyLive);
      const ended = snapshot.recentlyEnded;
      tracker.recentlyEnded = new Map(
        Array.isArray(ended)
          ? ended.filter((e) => Array.isArray(e) && e.length === 2)
          : [],
      );
      // Restore per-match status + posted flags so a restart never
      // reposts an HT/FT it already announced. Malformed entries are
      // dropped defensively.
      const statuses = snapshot.matchStatuses;
      tracker.matchStatuses = new Map(
        Array.isArray(statuses)
          ? statuses.filter(
              (e) =>
                Array.isArray(e) &&
                e.length === 2 &&
                typeof e[0] === 'string' &&
                e[1] &&
                typeof e[1] === 'object',
            )
          : [],
      );
      tracker.updatedAt = snapshot.updatedAt;
    }
    return tracker;
  }
}
