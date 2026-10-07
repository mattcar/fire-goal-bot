/**
 * MLS + ESPN data client for the fire-goal-bot.
 *
 * Three sources, all working without an API key as of 2026-10-06 (send a
 * browser User-Agent):
 *
 *  1. ESPN scoreboard (schedule/scores):
 *     GET {espnBaseUrl}/scoreboard?dates=YYYYMMDD
 *     competitions[0].competitors -> team.abbreviation ("CHI" = Chicago Fire),
 *     homeAway home/away, score. status.type.state is "pre"/"in"/"post".
 *  2. MLS match page -> sportecId:
 *     https://www.mlssoccer.com/competitions/mls-regular-season/{season}/matches/{homeSlug}vs{awaySlug}-{MM}-{DD}-{YYYY}/
 *     The date in the URL is America/New_York (not UTC). The page HTML
 *     contains the sportecId (e.g. "MLS-MAT-0009H7").
 *  3. stats-api.mlssoccer.com:
 *     GET /matches/{sportecId}                       -> match_information (status, result)
 *     GET /matches/{sportecId}/commentary?per_page=N -> commentary[] goal events
 *
 * Note the goal events live in the commentary endpoint — the sibling
 * key_events endpoint does NOT reliably include goals, so commentary is
 * the goal source of truth.
 */

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** ESPN abbreviation -> mlssoccer.com match-page slug. Slugs beyond the
 *  well-trodden ones are best guesses — resolution is defensive so a wrong
 *  slug just skips that match gracefully (the site is case-insensitive). */
export const ESPN_ABBREV_TO_SLUG = {
  CHI: 'chi',
  VAN: 'van',
  LAFC: 'lafc',
  POR: 'por',
  RBNY: 'rbny',
  SEA: 'sea',
  SJ: 'sj',
  DAL: 'dal',
  ORL: 'orl',
  PHI: 'phi',
  HOU: 'hou',
  TOR: 'tor',
  LAG: 'lag',
  RSL: 'rsl',
  COL: 'col',
  MIN: 'min',
  CLB: 'clb',
  MTL: 'mtl',
  DC: 'dc',
  CIN: 'cin',
  MIA: 'mia',
  NSH: 'nsh',
  ATX: 'atx',
  CLT: 'clt',
  STL: 'stl',
  SD: 'sd',
};

export const FIRE_ABBREV = 'CHI';

const NY = 'America/New_York';

const nyDateFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: NY,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** "20261006" style date key for the America/New_York day containing `value`. */
export function nyDateKey(value = new Date()) {
  const parts = Object.fromEntries(
    nyDateFmt.formatToParts(value instanceof Date ? value : new Date(value)).map((p) => [p.type, p.value]),
  );
  return `${parts.year}${parts.month}${parts.day}`;
}

/** { mm, dd, yyyy } in America/New_York for the mlssoccer.com URL. */
export function nyUrlDateParts(value) {
  const key = nyDateKey(value);
  return {
    mm: key.slice(4, 6),
    dd: key.slice(6, 8),
    yyyy: key.slice(0, 4),
  };
}

export function slugFor(abbrev) {
  return ESPN_ABBREV_TO_SLUG[abbrev] ?? null;
}

/**
 * Build the mlssoccer.com match page URL, or null when either team's slug
 * is unknown. `date` is the kickoff date; the URL date is NY-local.
 */
export function buildMatchUrl({ homeAbbrev, awayAbbrev, date }, season) {
  const home = slugFor(homeAbbrev);
  const away = slugFor(awayAbbrev);
  if (!home || !away) return null;
  const { mm, dd, yyyy } = nyUrlDateParts(date);
  return (
    `https://www.mlssoccer.com/competitions/mls-regular-season/${season}` +
    `/matches/${home}vs${away}-${mm}-${dd}-${yyyy}/`
  );
}

const SPORTEC_RE = /MLS-MAT-[A-Za-z0-9]+/;

/** Pull the sportecId out of match-page HTML; null when not found. */
export function extractSportecId(html) {
  const match = String(html ?? '').match(SPORTEC_RE);
  return match ? match[0] : null;
}

export class MlsClient {
  constructor({ espnBaseUrl, mlsStatsBaseUrl, season, fetchFn = fetch } = {}) {
    this.espnBaseUrl = espnBaseUrl;
    this.mlsStatsBaseUrl = mlsStatsBaseUrl;
    this.season = season;
    this.fetchFn = fetchFn;
    /** ESPN event id -> sportecId (or null when unresolvable). */
    this.sportecCache = new Map();
  }

  async getJson(url) {
    const res = await this.fetchFn(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return res.json();
  }

  async getText(url) {
    const res = await this.fetchFn(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return res.text();
  }

  async getScoreboard(dateKey) {
    return this.getJson(`${this.espnBaseUrl}/scoreboard?dates=${dateKey}`);
  }

  /**
   * Every Chicago Fire match on the ESPN scoreboard for the given NY date
   * keys (pass today + yesterday to catch late finishes). Each match:
   * { espnId, state, shortDetail, date, home: {abbrev,name}, away: {abbrev,name} }
   */
  async getFireMatches(dateKeys) {
    const matches = [];
    for (const dateKey of dateKeys) {
      let board;
      try {
        board = await this.getScoreboard(dateKey);
      } catch (err) {
        throw new Error(`scoreboard ${dateKey}: ${err.message}`);
      }
      for (const event of board.events ?? []) {
        const comp = event.competitions?.[0];
        const competitors = comp?.competitors ?? [];
        if (!competitors.some((c) => c.team?.abbreviation === FIRE_ABBREV)) continue;
        const pick = (side) => {
          const c = competitors.find((x) => x.homeAway === side);
          return {
            abbrev: c?.team?.abbreviation ?? '?',
            name: c?.team?.displayName ?? c?.team?.shortDisplayName ?? '?',
            score: c?.score ?? null,
          };
        };
        matches.push({
          espnId: String(event.id),
          state: comp?.status?.type?.state ?? 'unknown',
          shortDetail: comp?.status?.type?.shortDetail ?? '',
          date: event.date,
          home: pick('home'),
          away: pick('away'),
        });
      }
    }
    return matches;
  }

  /**
   * Resolve a Fire match to its MLS sportecId by fetching the match page
   * and scraping the embedded id. Cached per ESPN event id; null when the
   * slug is unknown or the page yields nothing (caller skips the match).
   */
  async resolveSportecId(match) {
    if (this.sportecCache.has(match.espnId)) return this.sportecCache.get(match.espnId);
    const url = buildMatchUrl(
      { homeAbbrev: match.home.abbrev, awayAbbrev: match.away.abbrev, date: match.date },
      this.season,
    );
    let sportecId = null;
    if (url) {
      try {
        sportecId = extractSportecId(await this.getText(url));
      } catch {
        sportecId = null; // defensive: a bad slug or a flaky page just skips
      }
    }
    this.sportecCache.set(match.espnId, sportecId);
    return sportecId;
  }

  /**
   * Match detail: { match_status, minute_of_play, result, home_team_goals,
   * away_team_goals, match_title, homeName, awayName }. Team names come
   * from the home/away sections of the same response.
   */
  async getMatchDetail(sportecId) {
    const data = await this.getJson(`${this.mlsStatsBaseUrl}/matches/${sportecId}`);
    const info = data?.match_information ?? {};
    return {
      ...info,
      homeName: data?.home?.team_name ?? '',
      awayName: data?.away?.team_name ?? '',
    };
  }

  /** Raw commentary items; the caller filters for type === 'Goal'. */
  async getCommentary(sportecId, perPage = 100) {
    const data = await this.getJson(
      `${this.mlsStatsBaseUrl}/matches/${sportecId}/commentary?per_page=${perPage}`,
    );
    return Array.isArray(data?.commentary) ? data.commentary : [];
  }
}

/** SportecIds currently LIVE (ESPN state "in") from resolved Fire matches. */
export function liveMatchIds(resolvedMatches) {
  return resolvedMatches
    .filter((m) => m.state === 'in' && m.sportecId)
    .map((m) => m.sportecId);
}
