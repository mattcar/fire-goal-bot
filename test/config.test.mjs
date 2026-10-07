import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';

describe('loadConfig', () => {
  it('throws without BLUESKY_PASSWORD unless DRY_RUN is set', () => {
    assert.throws(() => loadConfig({}), /BLUESKY_PASSWORD/);
    const config = loadConfig({ DRY_RUN: 'true' });
    assert.equal(config.dryRun, true);
    assert.equal(config.blueskyPassword, '');
  });

  it('applies defaults', () => {
    const config = loadConfig({ BLUESKY_PASSWORD: 'secret' });
    assert.equal(config.dryRun, false);
    assert.equal(config.blueskyIdentifier, 'fire-goal-bot.bsky.social');
    assert.equal(config.pollIntervalMs, 30_000);
    assert.equal(config.initialDelayMs, 45_000);
    assert.equal(config.postDelayMs, 60_000);
    assert.equal(config.maxUpdates, 2);
    assert.ok(config.espnBaseUrl.includes('espn.com'));
    assert.equal(config.mlsStatsBaseUrl, 'https://stats-api.mlssoccer.com');
    assert.equal(config.storePath, './data/posted-goals.json');
    assert.equal(config.port, 10_000);
  });

  it('honors overrides', () => {
    const config = loadConfig({
      BLUESKY_PASSWORD: 'secret',
      BLUESKY_IDENTIFIER: 'custom.bsky.social',
      POLL_INTERVAL_MS: '15000',
      DRY_RUN: '1',
    });
    assert.equal(config.blueskyIdentifier, 'custom.bsky.social');
    assert.equal(config.pollIntervalMs, 15_000);
    assert.equal(config.dryRun, true);
  });

  it('rejects invalid numbers', () => {
    assert.throws(() => loadConfig({ BLUESKY_PASSWORD: 'x', POLL_INTERVAL_MS: 'abc' }), /POLL_INTERVAL_MS/);
    assert.throws(() => loadConfig({ BLUESKY_PASSWORD: 'x', PORT: '-1' }), /PORT/);
  });
});
