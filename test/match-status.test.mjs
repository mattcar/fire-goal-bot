import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GameTracker,
  normalizeStatus,
  HALF_TIME_STATUS,
  FULL_TIME_STATUSES,
} from '../src/game-tracker.mjs';
import { formatHTMessage, formatFTMessage } from '../src/goals.mjs';

const MATCH = 'MLS-MAT-0009H7';

function statusReport(status, overrides = {}) {
  return {
    status,
    homeScore: 1,
    awayScore: 0,
    homeName: 'Chicago Fire FC',
    awayName: 'Vancouver Whitecaps FC',
    ...overrides,
  };
}

describe('normalizeStatus', () => {
  it('lowercases and tolerates missing values', () => {
    assert.equal(normalizeStatus('halfTime'), 'halftime');
    assert.equal(normalizeStatus('FinalWhistle'), 'finalwhistle');
    assert.equal(normalizeStatus(undefined), '');
    assert.equal(normalizeStatus(null), '');
  });

  it('knows the observed half-time and full-time statuses', () => {
    assert.equal(HALF_TIME_STATUS, 'halftime');
    assert.ok(FULL_TIME_STATUSES.has('fulltime'));
    assert.ok(FULL_TIME_STATUSES.has('finalwhistle'));
  });
});

describe('HT transitions', () => {
  it('posts HT on firstHalf -> halfTime', () => {
    const tracker = new GameTracker();
    assert.deepEqual(tracker.updateMatchStatuses(new Map([[MATCH, statusReport('firstHalf')]])), []);
    const transitions = tracker.updateMatchStatuses(new Map([[MATCH, statusReport('halfTime')]]));
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].kind, 'ht');
    assert.equal(transitions[0].matchId, MATCH);
    assert.equal(transitions[0].from, 'firsthalf');
    assert.equal(transitions[0].to, 'halftime');
    assert.equal(transitions[0].homeScore, 1);
    assert.equal(transitions[0].awayScore, 0);
  });

  it('does not post HT when the match is already at halfTime on first sight', () => {
    const tracker = new GameTracker();
    // Fresh start mid-match: the bot never observed the transition in.
    const transitions = tracker.updateMatchStatuses(new Map([[MATCH, statusReport('halfTime')]]));
    assert.deepEqual(transitions, []);
  });

  it('posts HT only once even if halfTime is observed repeatedly', () => {
    const tracker = new GameTracker();
    tracker.updateMatchStatuses(new Map([[MATCH, statusReport('firstHalf')]]));
    assert.equal(tracker.updateMatchStatuses(new Map([[MATCH, statusReport('halfTime')]])).length, 1);
    assert.deepEqual(tracker.updateMatchStatuses(new Map([[MATCH, statusReport('halfTime')]])), []);
    assert.deepEqual(tracker.updateMatchStatuses(new Map([[MATCH, statusReport('secondHalf')]])), []);
  });

  it('does not repost HT after a restart (posted flag survives the snapshot)', () => {
    const tracker = new GameTracker();
    const now = Date.now();
    tracker.updateMatchStatuses(new Map([[MATCH, statusReport('firstHalf')]]));
    tracker.updateMatchStatuses(new Map([[MATCH, statusReport('halfTime')]]));
    const snapshot = { ...tracker.toJSON(), updatedAt: now };
    const restored = GameTracker.fromSnapshot(snapshot, {
      maxAgeMs: 4 * 60 * 60 * 1000,
      sweepWindowMs: 60_000,
      now: now + 1000,
    });
    const transitions = restored.updateMatchStatuses(
      new Map([[MATCH, statusReport('halfTime')]]),
    );
    assert.deepEqual(transitions, []);
  });
});

describe('FT transitions', () => {
  it('posts FT on secondHalf -> fullTime', () => {
    const tracker = new GameTracker();
    tracker.updateMatchStatuses(new Map([[MATCH, statusReport('secondHalf')]]));
    const transitions = tracker.updateMatchStatuses(
      new Map([[MATCH, statusReport('fullTime', { homeScore: 3, awayScore: 1 })]]),
    );
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].kind, 'ft');
    assert.equal(transitions[0].homeScore, 3);
    assert.equal(transitions[0].awayScore, 1);
  });

  it('posts FT on the real observed terminal status finalWhistle', () => {
    const tracker = new GameTracker();
    tracker.updateMatchStatuses(new Map([[MATCH, statusReport('secondHalf')]]));
    const transitions = tracker.updateMatchStatuses(
      new Map([[MATCH, statusReport('finalWhistle', { homeScore: 3, awayScore: 1 })]]),
    );
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].kind, 'ft');
  });

  it('posts FT without HT when halfTime was never observed', () => {
    const tracker = new GameTracker();
    tracker.updateMatchStatuses(new Map([[MATCH, statusReport('secondHalf')]]));
    const transitions = tracker.updateMatchStatuses(new Map([[MATCH, statusReport('fullTime')]]));
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].kind, 'ft');
  });

  it('does not post FT when already at fullTime on first sight', () => {
    const tracker = new GameTracker();
    assert.deepEqual(
      tracker.updateMatchStatuses(new Map([[MATCH, statusReport('fullTime')]])),
      [],
    );
  });

  it('matches statuses case-insensitively', () => {
    const tracker = new GameTracker();
    tracker.updateMatchStatuses(new Map([[MATCH, statusReport('FirstHalf')]]));
    const transitions = tracker.updateMatchStatuses(new Map([[MATCH, statusReport('HalfTime')]]));
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].kind, 'ht');
  });

  it('treats unknown statuses defensively: records, never posts, never throws', () => {
    const tracker = new GameTracker();
    tracker.updateMatchStatuses(new Map([[MATCH, statusReport('secondHalf')]]));
    // Hypothetical extra-time / shootout statuses: no post, no crash.
    assert.deepEqual(
      tracker.updateMatchStatuses(new Map([[MATCH, statusReport('extraTime')]])),
      [],
    );
    assert.deepEqual(
      tracker.updateMatchStatuses(new Map([[MATCH, statusReport('penaltyShootout')]])),
      [],
    );
    // ...but the eventual real full time still posts exactly once.
    const transitions = tracker.updateMatchStatuses(
      new Map([[MATCH, statusReport('finalWhistle')]]),
    );
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].kind, 'ft');
    assert.deepEqual(
      tracker.updateMatchStatuses(new Map([[MATCH, statusReport('finalWhistle')]])),
      [],
    );
  });

  it('does not repost FT after a restart', () => {
    const tracker = new GameTracker();
    const now = Date.now();
    tracker.updateMatchStatuses(new Map([[MATCH, statusReport('secondHalf')]]));
    tracker.updateMatchStatuses(new Map([[MATCH, statusReport('finalWhistle')]]));
    const snapshot = { ...tracker.toJSON(), updatedAt: now };
    const restored = GameTracker.fromSnapshot(snapshot, {
      maxAgeMs: 4 * 60 * 60 * 1000,
      sweepWindowMs: 60_000,
      now: now + 1000,
    });
    assert.deepEqual(
      restored.updateMatchStatuses(new Map([[MATCH, statusReport('finalWhistle')]])),
      [],
    );
  });
});

describe('recorded real API response', () => {
  // Detail payload recorded from stats-api.mlssoccer.com for the finished
  // Chicago Fire vs Vancouver Whitecaps match on 2026-10-06
  // (sportecId MLS-MAT-0009H7): final score 3-1, status "finalWhistle".
  const recordedDetail = {
    match_status: 'finalWhistle',
    home_team_goals: 3,
    away_team_goals: 1,
    homeName: 'Chicago Fire FC',
    awayName: 'Vancouver Whitecaps FC',
  };

  it('produces the FT post for the recorded finished match', () => {
    // Same raw -> normalized mapping index.mjs applies to getMatchDetail().
    const normalize = (detail) => ({
      status: detail.match_status,
      homeScore: detail.home_team_goals,
      awayScore: detail.away_team_goals,
      homeName: detail.homeName,
      awayName: detail.awayName,
    });
    const tracker = new GameTracker();
    tracker.updateMatchStatuses(new Map([[MATCH, statusReport('secondHalf')]]));
    const transitions = tracker.updateMatchStatuses(new Map([[MATCH, normalize(recordedDetail)]]));
    assert.equal(transitions.length, 1);
    assert.equal(
      formatFTMessage(transitions[0]),
      '⏹️ FT — Chicago Fire 3-1 Vancouver Whitecaps',
    );
  });
});

describe('formatHTMessage / formatFTMessage', () => {
  const score = {
    homeName: 'Chicago Fire FC',
    awayName: 'Vancouver Whitecaps FC',
    homeScore: 1,
    awayScore: 0,
  };

  it('formats the half-time post, home team first', () => {
    assert.equal(formatHTMessage(score), '⏸️ HT — Chicago Fire 1-0 Vancouver Whitecaps');
  });

  it('formats the full-time post, home team first', () => {
    assert.equal(
      formatFTMessage({ ...score, homeScore: 2, awayScore: 1 }),
      '⏹️ FT — Chicago Fire 2-1 Vancouver Whitecaps',
    );
  });

  it('strips the FC suffix like the goal messages do', () => {
    assert.equal(
      formatHTMessage({ homeName: 'Chicago Fire FC', awayName: 'LA Galaxy', homeScore: 0, awayScore: 0 }),
      '⏸️ HT — Chicago Fire 0-0 LA Galaxy',
    );
  });
});
