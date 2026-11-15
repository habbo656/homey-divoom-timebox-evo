import { describe, expect, it } from 'vitest';
import { ArgumentError } from './argumentError';
import {
  DEFAULT_STEP,
  RESET,
  TEAM_IDS,
  applySet,
  applyStep,
  parseScoreArg,
  parseStep,
  parseTeam,
  resolveStoredScores,
  sameScores,
} from './scoreboard';

describe('parseTeam', () => {
  it('accepts red and blue', () => {
    expect([...TEAM_IDS]).toEqual(['red', 'blue']);
    expect(parseTeam('red')).toBe('red');
    expect(parseTeam('blue')).toBe('blue');
  });

  it.each(['', 'Red', 'green', 1, null, undefined, {}])('rejects %s', (bad) => {
    const error = (() => {
      try {
        parseTeam(bad);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ArgumentError);
    expect(error).toMatchObject({ kind: 'invalid_choice', field: 'team' });
  });
});

describe('parseScoreArg', () => {
  it('gives null for an empty argument', () => {
    for (const empty of [undefined, null, '']) expect(parseScoreArg('red', empty)).toBeNull();
  });

  it('rounds and clamps to 0..999', () => {
    expect(parseScoreArg('red', 12)).toBe(12);
    expect(parseScoreArg('red', 12.5)).toBe(13);
    expect(parseScoreArg('blue', 0)).toBe(0);
    expect(parseScoreArg('blue', -0.2)).toBe(0);
    expect(Object.is(parseScoreArg('blue', -0.2), 0)).toBe(true);
    expect(parseScoreArg('red', -5)).toBe(0);
    expect(parseScoreArg('red', 999)).toBe(999);
    expect(parseScoreArg('red', 5000)).toBe(999);
  });

  it.each([NaN, Infinity, -Infinity, '12', true, {}])('rejects %s with invalid_number and the field', (bad) => {
    expect(() => parseScoreArg('blue', bad)).toThrow(ArgumentError);
    expect(() => parseScoreArg('blue', bad)).toThrow(
      expect.objectContaining({ kind: 'invalid_number', field: 'blue' }),
    );
  });
});

describe('parseStep', () => {
  it('is 1 for an empty argument', () => {
    expect(DEFAULT_STEP).toBe(1);
    for (const empty of [undefined, null, '']) expect(parseStep(empty)).toBe(1);
  });

  it('rounds and accepts 1..999', () => {
    expect(parseStep(1)).toBe(1);
    expect(parseStep(5)).toBe(5);
    expect(parseStep(4.6)).toBe(5);
    expect(parseStep(999)).toBe(999);
  });

  it.each([0, 0.4, -1, 1000, 999.6])('rejects %s as out of range', (bad) => {
    expect(() => parseStep(bad)).toThrow(expect.objectContaining({ kind: 'invalid_range', field: 'step' }));
  });

  it.each([NaN, Infinity, 'x', true])('rejects %s as not a number', (bad) => {
    expect(() => parseStep(bad)).toThrow(expect.objectContaining({ kind: 'invalid_number', field: 'step' }));
  });
});

describe('score arithmetic', () => {
  const now = { red: 12, blue: 34 };

  it('set keeps the value of an empty argument', () => {
    expect(applySet(now, 5, null)).toEqual({ red: 5, blue: 34 });
    expect(applySet(now, null, 7)).toEqual({ red: 12, blue: 7 });
    expect(applySet(now, null, null)).toEqual(now);
    expect(applySet(now, 0, 0)).toEqual({ red: 0, blue: 0 });
  });

  it('steps one team and clamps to 0..999', () => {
    expect(applyStep(now, 'blue', 1, 1)).toEqual({ red: 12, blue: 35 });
    expect(applyStep(now, 'red', 5, -1)).toEqual({ red: 7, blue: 34 });
    expect(applyStep(now, 'red', 999, 1)).toEqual({ red: 999, blue: 34 });
    expect(applyStep({ red: 0, blue: 0 }, 'red', 1, -1)).toEqual({ red: 0, blue: 0 });
    expect(applyStep({ red: 3, blue: 0 }, 'red', 10, -1)).toEqual({ red: 0, blue: 0 });
  });

  it('does not change its input', () => {
    const input = { red: 1, blue: 2 };
    applyStep(input, 'red', 1, 1);
    applySet(input, 9, 9);
    expect(input).toEqual({ red: 1, blue: 2 });
  });

  it('RESET is 0/0 and frozen', () => {
    expect(RESET).toEqual({ red: 0, blue: 0 });
    expect(Object.isFrozen(RESET)).toBe(true);
  });

  it('compares scores', () => {
    expect(sameScores({ red: 1, blue: 2 }, { red: 1, blue: 2 })).toBe(true);
    expect(sameScores({ red: 1, blue: 2 }, { red: 2, blue: 1 })).toBe(false);
  });
});

describe('resolveStoredScores', () => {
  it('returns a valid stored pair', () => {
    expect(resolveStoredScores({ red: 5, blue: 999 })).toEqual({ red: 5, blue: 999 });
  });

  it.each([
    undefined,
    null,
    'x',
    5,
    {},
    { red: 1 },
    { red: -1, blue: 0 },
    { red: 1000, blue: 0 },
    { red: 1.5, blue: 0 },
    { red: '1', blue: 0 },
    { red: NaN, blue: 0 },
  ])('falls back to 0/0 for %j', (bad) => {
    expect(resolveStoredScores(bad)).toEqual({ red: 0, blue: 0 });
  });

  it('returns a fresh object, never the shared RESET', () => {
    expect(resolveStoredScores(null)).not.toBe(RESET);
  });
});
