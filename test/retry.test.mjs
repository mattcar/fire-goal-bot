import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { retryForever } from '../src/retry.mjs';

describe('retryForever', () => {
  it('returns the first success', async () => {
    const result = await retryForever(async () => 'ok');
    assert.equal(result, 'ok');
  });

  it('retries until success and reports attempts', async () => {
    let calls = 0;
    const seen = [];
    const result = await retryForever(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('boom');
        return 'ok';
      },
      {
        initialDelayMs: 1,
        maxDelayMs: 2,
        onError: (err, waitMs, attempt) => seen.push({ message: err.message, waitMs, attempt }),
      },
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
    assert.deepEqual(
      seen.map((s) => s.attempt),
      [1, 2],
    );
  });
});
