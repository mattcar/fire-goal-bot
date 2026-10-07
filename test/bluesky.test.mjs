import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BlueskyPoster } from '../src/bluesky.mjs';

describe('BlueskyPoster', () => {
  it('leaves the library event poller off', () => {
    const poster = new BlueskyPoster({ identifier: 'x', password: 'y' });
    // With emitEvents: false the Bot must not be an active event emitter.
    assert.equal(poster.bot.listenerCount('error'), 0);
  });

  it('classifies session failures', () => {
    const poster = new BlueskyPoster({ identifier: 'x', password: 'y' });
    assert.ok(poster.isSessionFailure(new Error('UpstreamFailure')));
    assert.ok(poster.isSessionFailure(Object.assign(new Error('x'), { status: 502 })));
    assert.ok(poster.isSessionFailure(Object.assign(new Error('x'), { status: 401 })));
    assert.ok(poster.isSessionFailure(null)); // no-URI case
    assert.ok(!poster.isSessionFailure(new Error('rate limited')));
  });

  it('logs in again and retries once on a session failure', async () => {
    const poster = new BlueskyPoster({ identifier: 'x', password: 'y' });
    let logins = 0;
    poster.login = async () => {
      logins += 1;
    };
    let posts = 0;
    poster.bot = {
      post: async () => {
        posts += 1;
        if (posts === 1) throw Object.assign(new Error('session expired'), { status: 401 });
        return { uri: 'at://x/y' };
      },
    };
    const response = await poster.post('hello');
    assert.equal(response.uri, 'at://x/y');
    assert.equal(logins, 1);
    assert.equal(posts, 2);
  });

  it('rethrows non-session failures without retrying', async () => {
    const poster = new BlueskyPoster({ identifier: 'x', password: 'y' });
    let logins = 0;
    poster.login = async () => {
      logins += 1;
    };
    poster.bot = {
      post: async () => {
        throw new Error('rate limited');
      },
    };
    await assert.rejects(() => poster.post('hello'), /rate limited/);
    assert.equal(logins, 0);
  });
});
