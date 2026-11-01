import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoalStore, pruneOldGoals } from '../src/store.mjs';
import { GameTracker } from '../src/game-tracker.mjs';

describe('GoalStore', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fire-goal-bot-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const storePath = () => join(dir, 'store.json');

  it('starts empty when no file exists', async () => {
    const store = await new GoalStore(storePath()).load();
    assert.equal(store.size, 0);
    assert.equal(store.get('x'), undefined);
  });

  it('round-trips records through save/load', async () => {
    const path = storePath();
    const store = await new GoalStore(path).load();
    store.set('MLS-MAT-0009H7:1', { goal: { scorer: 'A' }, posted: true, timestamp: Date.now() });
    await store.save();

    const reloaded = await new GoalStore(path).load();
    assert.equal(reloaded.size, 1);
    assert.deepEqual(reloaded.get('MLS-MAT-0009H7:1').goal, { scorer: 'A' });
  });

  it('keeps metadata out of size and entries', async () => {
    const path = storePath();
    const store = await new GoalStore(path).load();
    store.set('MLS-MAT-0009H7:1', { goal: {}, posted: true, timestamp: Date.now() });
    store.setMeta('gameTracker', { recentlyLive: ['MLS-MAT-0009H7'] });
    await store.save();

    const reloaded = await new GoalStore(path).load();
    assert.equal(reloaded.size, 1);
    assert.deepEqual([...reloaded.entries()].map(([k]) => k), ['MLS-MAT-0009H7:1']);
    assert.deepEqual(reloaded.getMeta('gameTracker'), { recentlyLive: ['MLS-MAT-0009H7'] });
  });

  it('prunes by predicate and reports the count', async () => {
    const store = await new GoalStore(storePath()).load();
    store.set('a:1', { timestamp: 1 });
    store.set('b:2', { timestamp: 2 });
    const removed = store.prune((record) => record.timestamp === 1);
    assert.equal(removed, 1);
    assert.ok(!store.has('a:1'));
    assert.ok(store.has('b:2'));
  });

  it('serializes concurrent saves without crashing', async () => {
    const store = await new GoalStore(storePath()).load();
    store.set('a:1', { goal: {}, posted: true, timestamp: Date.now() });
    await Promise.all([store.save(), store.save(), store.save()]);
    const reloaded = await new GoalStore(store.path).load();
    assert.equal(reloaded.size, 1);
  });
});

describe('pruneOldGoals', () => {
  it('prunes records from a previous ET day', () => {
    const store = new GoalStore('/nonexistent');
    // 2026-10-05 12:00 ET vs "now" 2026-10-06 12:00 ET.
    const old = new Date('2026-10-05T16:00:00Z').getTime();
    const now = new Date('2026-10-06T16:00:00Z').getTime();
    store.set('m:1', { timestamp: old });
    store.set('m:2', { timestamp: now });
    const removed = pruneOldGoals(store, { scoreMaxAgeMs: 4 * 60 * 60 * 1000 }, [], { now });
    assert.equal(removed, 1);
    assert.ok(!store.has('m:1'));
    assert.ok(store.has('m:2'));
  });

  it('protects live matches from pruning', () => {
    const store = new GoalStore('/nonexistent');
    const old = new Date('2026-10-05T16:00:00Z').getTime();
    const now = new Date('2026-10-06T16:00:00Z').getTime();
    store.set('MLS-MAT-0009H7:1', { timestamp: old });
    const removed = pruneOldGoals(
      store,
      { scoreMaxAgeMs: 4 * 60 * 60 * 1000 },
      ['MLS-MAT-0009H7'],
      { now },
    );
    assert.equal(removed, 0);
    assert.ok(store.has('MLS-MAT-0009H7:1'));
  });

  it('prunes records older than the max age', () => {
    const store = new GoalStore('/nonexistent');
    const now = Date.now();
    store.set('m:1', { timestamp: now - 5 * 60 * 60 * 1000 });
    const removed = pruneOldGoals(store, { scoreMaxAgeMs: 4 * 60 * 60 * 1000 }, [], { now });
    assert.equal(removed, 1);
  });

  it('protects a match still in its sweep window across ET midnight (2026-10-31 regression)', () => {
    // The Colorado match ended 10 minutes before ET midnight; the
    // midnight prune wiped its records and the same tick re-swept it,
    // reposting all six goals. A match still in its sweep window must
    // survive the prune even when its records are previous-day.
    const tracker = new GameTracker({ sweepWindowMs: 20 * 60 * 1000 });
    const endedAt = new Date('2026-11-01T03:50:00Z').getTime(); // 11:50 PM ET Oct 31
    const now = new Date('2026-11-01T04:00:30Z').getTime(); // 12:00:30 AM ET Nov 1
    tracker.endedGames(['m'], { now: endedAt - 60_000 });
    tracker.endedGames([], { now: endedAt }); // m ended
    const store = new GoalStore('/nonexistent');
    // A goal posted during the match: previous ET day, but only 90
    // minutes old, so only the day boundary makes it prunable.
    store.set('m:1', { timestamp: new Date('2026-11-01T02:30:00Z').getTime() });
    const removed = pruneOldGoals(
      store,
      { scoreMaxAgeMs: 4 * 60 * 60 * 1000 },
      tracker.protectedGameIds({ now }),
      { now },
    );
    assert.equal(removed, 0);
    assert.ok(store.has('m:1'));
    // Control: without the sweep-window protection, the same record
    // is pruned.
    const removedUnprotected = pruneOldGoals(
      store,
      { scoreMaxAgeMs: 4 * 60 * 60 * 1000 },
      [],
      { now },
    );
    assert.equal(removedUnprotected, 1);
    assert.ok(!store.has('m:1'));
  });
});
