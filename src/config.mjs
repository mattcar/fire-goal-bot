/**
 * Configuration, loaded from environment variables with validation.
 * Throws on missing/invalid values so misconfiguration fails fast at startup.
 *
 * A `.env` file in the working directory is loaded first (if present) so
 * `cp .env.example .env` just works. Real environment variables take
 * precedence over `.env` values.
 *
 * DRY_RUN=true skips the Bluesky password requirement and posts go to the
 * console only — the safe way to test against the live MLS/ESPN feeds.
 */

import { readFileSync } from 'node:fs';

function loadDotEnv(path = '.env') {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const truthy = (value) =>
  value != null && ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());

export function loadConfig(env = process.env) {
  if (env === process.env) loadDotEnv();
  const num = (name, def) => {
    const raw = env[name];
    if (raw == null || raw === '') return def;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`${name} must be a non-negative number (got "${raw}")`);
    }
    return n;
  };

  const dryRun = truthy(env.DRY_RUN);
  const blueskyPassword = env.BLUESKY_PASSWORD;
  if (!blueskyPassword && !dryRun) {
    throw new Error(
      'BLUESKY_PASSWORD environment variable is required (or set DRY_RUN=true)',
    );
  }

  return {
    dryRun,
    blueskyIdentifier: env.BLUESKY_IDENTIFIER || 'fire-goal-bot.bsky.social',
    blueskyPassword: blueskyPassword || '',
    pollIntervalMs: num('POLL_INTERVAL_MS', 30_000),
    initialDelayMs: num('INITIAL_DELAY_MS', 45_000),
    postDelayMs: num('POST_DELAY_MS', 60_000),
    maxUpdates: num('MAX_UPDATES', 2),
    espnBaseUrl:
      env.ESPN_API_BASE_URL || 'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1',
    mlsStatsBaseUrl: env.MLS_API_BASE_URL || 'https://stats-api.mlssoccer.com',
    mlsSeason: env.MLS_SEASON || String(new Date().getFullYear()),
    scoreMaxAgeMs: num('SCORE_MAX_AGE_MS', 4 * 60 * 60 * 1000),
    sweepWindowMs: num('SWEEP_WINDOW_MS', 20 * 60 * 1000),
    storePath: env.GOAL_STORE_PATH || './data/posted-goals.json',
    port: num('PORT', 10_000),
  };
}
