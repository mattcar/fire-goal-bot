import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GameTracker, DEFAULT_SWEEP_WINDOW_MS } from '../src/game-tracker.mjs';

describe('GameTracker', () => {
  it('reports newly ended matches exactly once', () => {
    const tracker = new GameTracker({ sweepWindowMs: 60_000 });
    const now = Date.now();
    assert.deepEqual(tracker.endedGames(['a', 'b'], { now }), []);
    assert.deepEqual(tracker.endedGames(['a'], { now: now + 1000 }), ['b']);
    assert.deepEqual(tracker.endedGames(['a'], { now: now + 2000 }), []);
  });

  it('re-sweeps ended matches within the window, then drops them', () => {
    const tracker = new GameTracker({ sweepWindowMs: 60_000 });
    const now = Date.now();
    tracker.endedGames(['a'], { now });
    const t1 = now + 1000;
    assert.deepEqual(tracker.gamesToSweep([], { now: t1 }), ['a']);
    assert.deepEqual(tracker.gamesToSweep([], { now: t1 + 30_000 }), ['a']);
    assert.deepEqual(tracker.gamesToSweep([], { now: t1 + 61_000 }), []);
  });

  it('a match seen live again leaves the ended set', () => {
    const tracker = new GameTracker({ sweepWindowMs: 60_000 });
    const now = Date.now();
    tracker.endedGames(['a'], { now });
    assert.deepEqual(tracker.endedGames([], { now: now + 1000 }), ['a']); // ended
    tracker.endedGames(['a'], { now: now + 2000 }); // flaky API shows it live again
    // The phantom ending must not trigger a sweep while it looks live...
    assert.deepEqual(tracker.gamesToSweep(['a'], { now: now + 3000 }), []);
    // ...but a real second ending still sweeps with a fresh timestamp.
    assert.deepEqual(tracker.gamesToSweep([], { now: now + 4000 }), ['a']);
  });

  it('round-trips a fresh snapshot', () => {
    const tracker = new GameTracker({ sweepWindowMs: 60_000 });
    const now = Date.now();
    tracker.endedGames(['a', 'b'], { now });
    const snapshot = tracker.toJSON();
    const restored = GameTracker.fromSnapshot(snapshot, {
      maxAgeMs: 4 * 60 * 60 * 1000,
      sweepWindowMs: 60_000,
      now: now + 1000,
    });
    assert.deepEqual([...restored.recentlyLive], ['a', 'b']);
  });

  it('discards stale snapshots', () => {
    const tracker = new GameTracker({ sweepWindowMs: 60_000 });
    const now = Date.now();
    tracker.endedGames(['a'], { now });
    const snapshot = { ...tracker.toJSON(), updatedAt: now - 5 * 60 * 60 * 1000 };
    const restored = GameTracker.fromSnapshot(snapshot, {
      maxAgeMs: 4 * 60 * 60 * 1000,
      sweepWindowMs: 60_000,
      now,
    });
    assert.equal(restored.recentlyLive.size, 0);
  });

  it('has a 20-minute default sweep window', () => {
    assert.equal(DEFAULT_SWEEP_WINDOW_MS, 20 * 60 * 1000);
  });
});
