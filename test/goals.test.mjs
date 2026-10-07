import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractGoals,
  goalKey,
  isSameGoal,
  changedFields,
  formatGoalMessage,
  formatCorrectionMessage,
  scoringTeamLabel,
} from '../src/goals.mjs';

// Real fixture shape from the verified CHI-VAN 2026-10-06 feed.
const bambaGoalItem = {
  event_id: '1228300000136',
  event_time: '2026-10-07T00:49:02Z',
  minute_of_play: "9'",
  minute: 8,
  second: 15,
  game_section: 'firstHalf',
  version: 6,
  type: 'Goal',
  commentary:
    'Goal! 1:0. Jonathan Bamba (Chicago Fire FC) scored with right footed shot from the central position outside the box with an xG of 5% to the middle right zone. Assisted by Anton Salétros.',
  team_id: 'MLS-CLU-00000F',
  team_short_name: 'Chicago',
  team_three_letter_code: 'CHI',
  created: '2026-10-07T00:49:09.72Z',
  updated: '2026-10-07T00:50:10.952Z',
  sub_type: 'SuccessfulShot',
  player_id: 'MLS-OBJ-0007XK',
  second_player_id: 'MLS-OBJ-000CEG',
};

const shotItem = {
  event_id: '1228300000135',
  minute_of_play: "7'",
  minute: 7,
  type: 'ShotAtGoal',
  commentary: 'Attempt saved. Jonathan Bamba (Chicago Fire FC) right footed shot from outside the box is saved.',
  team_three_letter_code: 'CHI',
  team_short_name: 'Chicago',
};

const unassistedGoalItem = {
  event_id: '1228300000140',
  minute_of_play: "52'",
  minute: 52,
  type: 'Goal',
  commentary:
    'Goal! 2:0. Hugo Cuypers (Chicago Fire FC) scored with a header from the centre of the box to the top left corner.',
  team_three_letter_code: 'CHI',
  team_short_name: 'Chicago',
};

const opponentGoalItem = {
  event_id: '1228300000150',
  minute_of_play: "67'",
  minute: 67,
  type: 'Goal',
  commentary:
    'Goal! 2:1. Brian White (Vancouver Whitecaps FC) scored with right footed shot from very close range to the centre of the goal. Assisted by Ryan Gauld.',
  team_three_letter_code: 'VAN',
  team_short_name: 'Vancouver',
};

const malformedGoalItem = {
  event_id: '1228300000160',
  minute_of_play: "80'",
  type: 'Goal',
  commentary: 'Goal confirmed after VAR review.', // no parseable scorer/score
  team_three_letter_code: 'CHI',
  team_short_name: 'Chicago',
};

const teams = {
  home: { abbrev: 'CHI', name: 'Chicago Fire FC' },
  away: { abbrev: 'VAN', name: 'Vancouver Whitecaps FC' },
};

describe('extractGoals', () => {
  it('parses a real Fire goal item', () => {
    const [goal] = extractGoals([bambaGoalItem]);
    assert.equal(goal.eventId, '1228300000136');
    assert.equal(goal.scorer, 'Jonathan Bamba');
    assert.equal(goal.assists, 'Anton Salétros');
    assert.equal(goal.minute, "9'");
    assert.equal(goal.teamAbbrev, 'CHI');
    assert.equal(goal.homeScore, 1);
    assert.equal(goal.awayScore, 0);
  });

  it('ignores non-goal commentary types', () => {
    assert.deepEqual(extractGoals([shotItem]), []);
  });

  it('handles unassisted goals', () => {
    const [goal] = extractGoals([unassistedGoalItem]);
    assert.equal(goal.scorer, 'Hugo Cuypers');
    assert.equal(goal.assists, '');
    assert.equal(goal.homeScore, 2);
    assert.equal(goal.awayScore, 0);
  });

  it('parses opponent goals', () => {
    const [goal] = extractGoals([opponentGoalItem]);
    assert.equal(goal.scorer, 'Brian White');
    assert.equal(goal.assists, 'Ryan Gauld');
    assert.equal(goal.teamAbbrev, 'VAN');
    assert.equal(goal.homeScore, 2);
    assert.equal(goal.awayScore, 1);
  });

  it('drops goal items whose text cannot be parsed', () => {
    assert.deepEqual(extractGoals([malformedGoalItem]), []);
  });

  it('handles empty and missing input', () => {
    assert.deepEqual(extractGoals([]), []);
    assert.deepEqual(extractGoals(undefined), []);
  });
});

describe('goalKey', () => {
  it('scopes the event id to the match', () => {
    assert.equal(goalKey('MLS-MAT-0009H7', { eventId: '1228300000136' }), 'MLS-MAT-0009H7:1228300000136');
  });
});

describe('isSameGoal', () => {
  const [goal] = extractGoals([bambaGoalItem]);
  it('matches on exact event id', () => {
    assert.ok(isSameGoal(goal, { ...goal }));
  });
  it('fuzzy-matches a re-issued event id', () => {
    const reissued = { ...goal, eventId: '9999999999999' };
    assert.ok(isSameGoal(goal, reissued));
  });
  it('rejects a different goal', () => {
    const other = { ...goal, eventId: '9999999999999', scorer: 'Hugo Cuypers' };
    assert.ok(!isSameGoal(goal, other));
  });
});

describe('changedFields', () => {
  const [goal] = extractGoals([bambaGoalItem]);
  it('reports scorer and assist changes', () => {
    const changed = { ...goal, scorer: 'Hugo Cuypers', assists: 'Philip Zinckernagel' };
    assert.deepEqual(changedFields(goal, changed).sort(), ['assists', 'scorer']);
  });
  it('reports score changes', () => {
    const changed = { ...goal, homeScore: 2 };
    assert.deepEqual(changedFields(goal, changed), ['score']);
  });
  it('is empty when nothing changed', () => {
    assert.deepEqual(changedFields(goal, { ...goal }), []);
  });
});

describe('scoringTeamLabel', () => {
  const [fireGoal] = extractGoals([bambaGoalItem]);
  const [oppGoal] = extractGoals([opponentGoalItem]);
  it('labels Fire goals as Chicago Fire', () => {
    assert.equal(scoringTeamLabel(fireGoal, teams), 'Chicago Fire');
  });
  it('labels opponent goals with the opponent name', () => {
    assert.equal(scoringTeamLabel(oppGoal, teams), 'Vancouver Whitecaps');
  });
});

describe('formatGoalMessage', () => {
  const [fireGoal] = extractGoals([bambaGoalItem]);
  const [unassisted] = extractGoals([unassistedGoalItem]);
  const [oppGoal] = extractGoals([opponentGoalItem]);

  it('formats a Fire goal with assist', () => {
    assert.equal(
      formatGoalMessage(fireGoal, teams),
      "🔥 GOAL — Chicago Fire: Jonathan Bamba (9') — assisted by Anton Salétros. CHI 1-0 VAN",
    );
  });

  it('formats a Fire goal without assist', () => {
    assert.equal(
      formatGoalMessage(unassisted, teams),
      "🔥 GOAL — Chicago Fire: Hugo Cuypers (52'). CHI 2-0 VAN",
    );
  });

  it('formats an opponent goal with the glove emoji', () => {
    assert.equal(
      formatGoalMessage(oppGoal, teams),
      "🧤 GOAL — Vancouver Whitecaps: Brian White (67') — assisted by Ryan Gauld. CHI 2-1 VAN",
    );
  });
});

describe('formatCorrectionMessage', () => {
  const [goal] = extractGoals([bambaGoalItem]);
  it('notes a scorer credit change', () => {
    const previous = { ...goal, scorer: 'Hugo Cuypers' };
    const message = formatCorrectionMessage(goal, previous, teams);
    assert.ok(message.startsWith('CORRECTION: '));
    assert.ok(message.includes('Goal now credited to Jonathan Bamba (previously Hugo Cuypers)'));
    assert.ok(message.includes("Time: 9'"));
  });
});
