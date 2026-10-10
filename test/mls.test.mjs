import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMatchUrl,
  slugFor,
  nyUrlDateParts,
  nyDateKey,
  extractSportecId,
  liveMatchIds,
  MlsClient,
} from '../src/mls.mjs';

const season = '2026';
// 2026-10-07T00:40:47.07Z is 2026-10-06 20:40 America/New_York.
const kickoff = new Date('2026-10-07T00:40:47.07Z');

describe('slugFor', () => {
  it('maps known abbreviations', () => {
    assert.equal(slugFor('CHI'), 'chi');
    assert.equal(slugFor('VAN'), 'van');
    assert.equal(slugFor('LAFC'), 'lafc');
  });
  it('maps every MLS club, so no Fire match is silently skipped', () => {
    // Regression: NYC was missing, so the bot skipped the entire
    // 2026-10-10 CHI vs NYCFC match (zero posts in a 2-1 Fire win).
    assert.equal(slugFor('NYC'), 'nyc');
    assert.equal(slugFor('ATL'), 'atl');
    assert.equal(slugFor('NE'), 'ne');
    assert.equal(slugFor('SKC'), 'skc');
  });
  it('returns null for unknown abbreviations', () => {
    assert.equal(slugFor('XXX'), null);
  });
});

describe('nyUrlDateParts / nyDateKey', () => {
  it('uses the America/New_York date, not UTC', () => {
    // 00:40 UTC Oct 7 is still Oct 6 in New York.
    assert.deepEqual(nyUrlDateParts(kickoff), { mm: '10', dd: '06', yyyy: '2026' });
    assert.equal(nyDateKey(kickoff), '20261006');
  });
});

describe('buildMatchUrl', () => {
  it('builds the verified CHI-VAN URL shape', () => {
    const url = buildMatchUrl(
      { homeAbbrev: 'CHI', awayAbbrev: 'VAN', date: kickoff },
      season,
    );
    assert.equal(
      url,
      'https://www.mlssoccer.com/competitions/mls-regular-season/2026/matches/chivsvan-10-06-2026/',
    );
  });

  it('returns null when a slug is unknown', () => {
    assert.equal(
      buildMatchUrl({ homeAbbrev: 'CHI', awayAbbrev: 'XXX', date: kickoff }, season),
      null,
    );
  });

  it('builds the CHI-NYC URL for the 2026-10-10 match (official mlssoccer.com shape)', () => {
    // Official recap URL: .../matches/chivsnyc-10-10-2026/
    const url = buildMatchUrl(
      { homeAbbrev: 'CHI', awayAbbrev: 'NYC', date: new Date('2026-10-10T18:30:00Z') },
      season,
    );
    assert.equal(
      url,
      'https://www.mlssoccer.com/competitions/mls-regular-season/2026/matches/chivsnyc-10-10-2026/',
    );
  });
});

describe('extractSportecId', () => {
  it('finds the sportecId in match-page HTML', () => {
    const html = '<script>var x = "MLS-MAT-0009H7";</script>';
    assert.equal(extractSportecId(html), 'MLS-MAT-0009H7');
  });
  it('returns null when absent', () => {
    assert.equal(extractSportecId('<html>nothing here</html>'), null);
    assert.equal(extractSportecId(null), null);
  });
});

describe('liveMatchIds', () => {
  it('returns sportecIds of live matches only', () => {
    const resolved = [
      { sportecId: 'MLS-MAT-0009H7', state: 'in' },
      { sportecId: 'MLS-MAT-0009H8', state: 'post' },
      { sportecId: null, state: 'in' },
    ];
    assert.deepEqual(liveMatchIds(resolved), ['MLS-MAT-0009H7']);
  });
});

function mockFetch(routes) {
  // routes: array of [urlSubstring, { json } | { text }] or a thrown error
  return async (url) => {
    for (const [substr, response] of routes) {
      if (url.includes(substr)) {
        if (response instanceof Error) throw response;
        return {
          ok: true,
          json: async () => response.json,
          text: async () => response.text,
        };
      }
    }
    throw new Error(`unexpected URL in test: ${url}`);
  };
}

const espnBoard = {
  events: [
    {
      id: '12345',
      name: 'Vancouver Whitecaps FC at Chicago Fire FC',
      date: '2026-10-07T00:40:47.07Z',
      competitions: [
        {
          competitors: [
            { homeAway: 'home', score: '1', team: { abbreviation: 'CHI', displayName: 'Chicago Fire FC' } },
            { homeAway: 'away', score: '0', team: { abbreviation: 'VAN', displayName: 'Vancouver Whitecaps FC' } },
          ],
          status: { type: { state: 'in', shortDetail: "45'+1'" } },
        },
      ],
    },
    {
      id: '99999',
      name: 'LA Galaxy vs LAFC',
      date: '2026-10-07T02:30:00.000Z',
      competitions: [
        {
          competitors: [
            { homeAway: 'home', score: '0', team: { abbreviation: 'LAG', displayName: 'LA Galaxy' } },
            { homeAway: 'away', score: '0', team: { abbreviation: 'LAFC', displayName: 'Los Angeles FC' } },
          ],
          status: { type: { state: 'pre', shortDetail: '7:30 PM' } },
        },
      ],
    },
  ],
};

describe('MlsClient request headers', () => {
  it('sends User-Agent and Connection: close (stale-socket workaround)', async () => {
    let seen;
    const client = new MlsClient({
      espnBaseUrl: 'https://espn.example',
      mlsStatsBaseUrl: 'https://mls.example',
      season,
      fetchFn: async (url, opts) => {
        seen = opts?.headers;
        return { ok: true, json: async () => ({}) };
      },
    });
    await client.getJson('https://espn.example/x');
    assert.ok(seen['User-Agent'].includes('Mozilla'), `no User-Agent: ${JSON.stringify(seen)}`);
    assert.equal(seen.Connection, 'close');
  });
});

describe('MlsClient.getFireMatches', () => {
  it('finds only matches involving CHI', async () => {
    const client = new MlsClient({
      espnBaseUrl: 'https://espn.example',
      mlsStatsBaseUrl: 'https://mls.example',
      season,
      fetchFn: mockFetch([['scoreboard', { json: espnBoard }]]),
    });
    const matches = await client.getFireMatches(['20261006']);
    assert.equal(matches.length, 1);
    const [match] = matches;
    assert.equal(match.espnId, '12345');
    assert.equal(match.state, 'in');
    assert.equal(match.shortDetail, "45'+1'");
    assert.equal(match.home.abbrev, 'CHI');
    assert.equal(match.away.abbrev, 'VAN');
    assert.equal(match.home.name, 'Chicago Fire FC');
  });

  it('throws a useful error when the scoreboard fetch fails', async () => {
    const client = new MlsClient({
      espnBaseUrl: 'https://espn.example',
      mlsStatsBaseUrl: 'https://mls.example',
      season,
      fetchFn: async () => ({ ok: false, status: 500 }),
    });
    await assert.rejects(() => client.getFireMatches(['20261006']), /scoreboard 20261006/);
  });
});

describe('MlsClient.resolveSportecId', () => {
  const match = {
    espnId: '12345',
    home: { abbrev: 'CHI' },
    away: { abbrev: 'VAN' },
    date: '2026-10-07T00:40:47.07Z',
  };

  it('scrapes the sportecId from the match page', async () => {
    let calls = 0;
    const client = new MlsClient({
      espnBaseUrl: 'https://espn.example',
      mlsStatsBaseUrl: 'https://mls.example',
      season,
      fetchFn: async (url) => {
        calls += 1;
        assert.ok(url.includes('chivsvan-10-06-2026'), `unexpected match URL: ${url}`);
        return { ok: true, text: async () => '<div data="MLS-MAT-0009H7"></div>' };
      },
    });
    assert.equal(await client.resolveSportecId(match), 'MLS-MAT-0009H7');
    // Second call hits the cache, not the network.
    assert.equal(await client.resolveSportecId(match), 'MLS-MAT-0009H7');
    assert.equal(calls, 1);
  });

  it('returns null (skips gracefully) when the slug is unknown', async () => {
    const client = new MlsClient({
      espnBaseUrl: 'https://espn.example',
      mlsStatsBaseUrl: 'https://mls.example',
      season,
      fetchFn: mockFetch([]),
    });
    const bad = { ...match, away: { abbrev: 'XXX' } };
    assert.equal(await client.resolveSportecId(bad), null);
  });

  it('returns null when the page has no sportecId', async () => {
    const client = new MlsClient({
      espnBaseUrl: 'https://espn.example',
      mlsStatsBaseUrl: 'https://mls.example',
      season,
      fetchFn: mockFetch([['mlssoccer.com', { text: '<html>no id here</html>' }]]),
    });
    assert.equal(await client.resolveSportecId(match), null);
  });
});

describe('MlsClient.getCommentary', () => {
  it('returns the commentary array', async () => {
    const payload = { commentary: [{ type: 'Goal' }, { type: 'Foul' }] };
    const client = new MlsClient({
      espnBaseUrl: 'https://espn.example',
      mlsStatsBaseUrl: 'https://mls.example',
      season,
      fetchFn: mockFetch([['commentary', { json: payload }]]),
    });
    assert.deepEqual(await client.getCommentary('MLS-MAT-0009H7'), payload.commentary);
  });

  it('returns [] when the payload has no commentary array', async () => {
    const client = new MlsClient({
      espnBaseUrl: 'https://espn.example',
      mlsStatsBaseUrl: 'https://mls.example',
      season,
      fetchFn: mockFetch([['commentary', { json: {} }]]),
    });
    assert.deepEqual(await client.getCommentary('MLS-MAT-0009H7'), []);
  });
});
