/**
 * Goal extraction, identity, and message formatting for MLS commentary.
 * Pure functions — no I/O — so they're easy to unit test.
 *
 * Commentary goal text format (consistent across the feed):
 *   "Goal! 1:0. Jonathan Bamba (Chicago Fire FC) scored with right footed
 *    shot from the central position outside the box with an xG of 5% to the
 *    middle right zone. Assisted by Anton Salétros."
 * The trailing "Assisted by <Name>." sentence is absent for unassisted goals.
 */

import { FIRE_ABBREV } from './mls.mjs';

const SCORE_RE = /Goal!\s*(\d+)\s*:\s*(\d+)/;
const SCORER_RE = /Goal!\s*\d+\s*:\s*\d+\.\s*([^()]+?)\s*\(/;
const ASSIST_RE = /Assisted by\s*([^.]+)\./;

function parseGoalItem(item) {
  const text = item.commentary ?? '';
  const score = text.match(SCORE_RE);
  const scorer = text.match(SCORER_RE);
  if (!score || !scorer) return null;
  const assist = text.match(ASSIST_RE);
  return {
    eventId: String(item.event_id ?? ''),
    scorer: scorer[1].trim(),
    assists: assist ? assist[1].trim() : '',
    minute: String(item.minute_of_play ?? ''),
    minuteNumber: Number.parseInt(item.minute, 10) || null,
    teamAbbrev: item.team_three_letter_code ?? '',
    teamShortName: item.team_short_name ?? '',
    homeScore: Number(score[1]),
    awayScore: Number(score[2]),
  };
}

/** Every goal event in a commentary payload, as plain goal objects. */
export function extractGoals(commentaryItems) {
  return (commentaryItems ?? [])
    .filter((item) => item?.type === 'Goal')
    .map(parseGoalItem)
    .filter(Boolean);
}

/** Stable identity for a goal: MLS's event id, scoped to the match. */
export function goalKey(matchId, goal) {
  return `${matchId}:${goal.eventId}`;
}

/**
 * Fuzzy identity for when MLS re-issues an event id for the same goal
 * (e.g. after a scoring correction). Same minute, scorer, and score.
 */
export function isSameGoal(a, b) {
  if (a.eventId && a.eventId === b.eventId) return true;
  return (
    a.minute === b.minute &&
    a.scorer === b.scorer &&
    a.homeScore === b.homeScore &&
    a.awayScore === b.awayScore
  );
}

/** Field names whose values changed between two snapshots of a goal. */
export function changedFields(oldGoal, newGoal) {
  const fields = [];
  for (const field of ['scorer', 'assists']) {
    if (oldGoal[field] !== newGoal[field]) fields.push(field);
  }
  if (oldGoal.homeScore !== newGoal.homeScore || oldGoal.awayScore !== newGoal.awayScore) {
    fields.push('score');
  }
  return fields;
}

function cleanTeamName(name) {
  return String(name ?? '').replace(/\s+FC$/, '').trim() || 'Unknown Team';
}

/** Display name of the scoring side: Chicago Fire, or the opponent's name. */
export function scoringTeamLabel(goal, teams) {
  if (goal.teamAbbrev === FIRE_ABBREV) return 'Chicago Fire';
  const { home = {}, away = {} } = teams ?? {};
  if (goal.teamAbbrev && goal.teamAbbrev === home.abbrev) return cleanTeamName(home.name);
  if (goal.teamAbbrev && goal.teamAbbrev === away.abbrev) return cleanTeamName(away.name);
  return cleanTeamName(goal.teamShortName);
}

function scoreLine(goal, teams) {
  const home = teams?.home?.abbrev ?? 'HOME';
  const away = teams?.away?.abbrev ?? 'AWAY';
  return `${home} ${goal.homeScore}-${goal.awayScore} ${away}`;
}

export function formatGoalMessage(goal, teams) {
  const isFire = goal.teamAbbrev === FIRE_ABBREV;
  const emoji = isFire ? '🔥' : '🧤';
  let message = `${emoji} GOAL — ${scoringTeamLabel(goal, teams)}: ${goal.scorer} (${goal.minute})`;
  if (goal.assists) {
    message += ` — assisted by ${goal.assists}`;
  }
  message += `. ${scoreLine(goal, teams)}`;
  return message;
}

/**
 * Half-time post. `score` is { homeName, awayName, homeScore, awayScore };
 * names come from the MLS match detail, home team first.
 * Example: "⏸️ HT — Chicago Fire 1-0 Vancouver Whitecaps"
 */
export function formatHTMessage(score) {
  return `⏸️ HT — ${cleanTeamName(score.homeName)} ${score.homeScore}-${score.awayScore} ${cleanTeamName(score.awayName)}`;
}

/**
 * Full-time post.
 * Example: "⏹️ FT — Chicago Fire 3-1 Vancouver Whitecaps"
 */
export function formatFTMessage(score) {
  return `⏹️ FT — ${cleanTeamName(score.homeName)} ${score.homeScore}-${score.awayScore} ${cleanTeamName(score.awayName)}`;
}

export function formatCorrectionMessage(goal, previousGoal, teams) {
  let message = 'CORRECTION: ';
  if (goal.scorer !== previousGoal.scorer) {
    message += `Goal now credited to ${goal.scorer} (previously ${previousGoal.scorer})\n`;
  }
  message += `${scoringTeamLabel(goal, teams)} — ${scoreLine(goal, teams)}\n`;
  if (goal.assists) {
    message += `Assists: ${goal.assists}\n`;
  }
  message += `Time: ${goal.minute}\n`;
  message += `Score: ${goal.homeScore}-${goal.awayScore}`;
  return message;
}
