import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { etDayKey, isSameETDay, ageMinutes } from '../src/time.mjs';

describe('ET day helpers', () => {
  it('etDayKey follows America/New_York, not UTC', () => {
    // 2026-10-07T03:30:00Z is 2026-10-06 23:30 in New York (EDT).
    assert.equal(etDayKey(new Date('2026-10-07T03:30:00Z')), '2026-10-6');
  });

  it('isSameETDay splits at ET midnight', () => {
    const before = new Date('2026-10-07T03:59:59Z'); // 23:59:59 EDT Oct 6
    const after = new Date('2026-10-07T04:00:00Z'); // 00:00:00 EDT Oct 7
    assert.ok(isSameETDay(before, new Date('2026-10-07T03:00:00Z')));
    assert.ok(!isSameETDay(before, after));
  });

  it('ageMinutes rounds to whole minutes', () => {
    const now = Date.now();
    assert.equal(ageMinutes(now - 90_000, now), 2);
    assert.equal(ageMinutes(now, now), 0);
  });
});
