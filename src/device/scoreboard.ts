// Scoreboard model (docs/architecture/modes.md, #40): the two scores, the validation of the Flow card arguments and the
// pure score arithmetic. The scores are tracked by the app (no read command is used); they are clamped to 0..999. Pure,
// no Homey and no link.
import { MAX_SCORE } from '../protocol/commands';
import { ArgumentError, formatArgValue } from './argumentError';
import type { ArgumentField } from './argumentError';

/** The scores of the scoreboard: red is shown at the bottom, blue at the top. */
export interface Scores {
  red: number;
  blue: number;
}

/** The team ids of the Flow dropdown (stable, never translated). */
export const TEAM_IDS = ['red', 'blue'] as const;
export type TeamId = (typeof TEAM_IDS)[number];

/** Both scores 0 ("Reset scores" and the start value). */
export const RESET: Readonly<Scores> = Object.freeze({ red: 0, blue: 0 });

/** The step of "Increase score" and "Decrease score" when the argument is left empty (owner, #40). */
export const DEFAULT_STEP = 1;

/** A card argument that was left empty. */
function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** Validate a team id of a Flow card. Throws `ArgumentError` (a `RangeError`) for anything else. */
export function parseTeam(value: unknown): TeamId {
  const team = TEAM_IDS.find((candidate) => candidate === value);
  if (!team) {
    throw new ArgumentError(
      `team must be one of ${TEAM_IDS.join(', ')}, got ${String(value)}`,
      'invalid_choice',
      'team',
      {
        value: formatArgValue(value),
        allowed: TEAM_IDS.join(', '),
      },
    );
  }
  return team;
}

function finite(field: ArgumentField, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ArgumentError(`${field} must be a number, got ${String(value)}`, 'invalid_number', field, {
      value: formatArgValue(value),
    });
  }
  return value;
}

/** Round to a whole number; `+ 0` turns -0 into 0. */
function whole(value: number): number {
  return Math.round(value) + 0;
}

function clampScore(value: number): number {
  return Math.min(MAX_SCORE, Math.max(0, value));
}

/**
 * Validate one score of "Set score": an empty argument gives null (keep the current value), a finite number is rounded
 * and clamped to 0..999. Throws `ArgumentError` (a `RangeError`) for anything else.
 */
export function parseScoreArg(field: 'red' | 'blue', value: unknown): number | null {
  if (isEmpty(value)) return null;
  return clampScore(whole(finite(field, value)));
}

/**
 * Validate the step of "Increase score" / "Decrease score": empty gives `DEFAULT_STEP`, a finite number is rounded and
 * must be within 1..999. Throws `ArgumentError` (a `RangeError`) for anything else.
 */
export function parseStep(value: unknown): number {
  if (isEmpty(value)) return DEFAULT_STEP;
  const step = whole(finite('step', value));
  if (step < 1 || step > MAX_SCORE) {
    throw new ArgumentError(`step must be within 1..${MAX_SCORE}, got ${String(value)}`, 'invalid_range', 'step', {
      value: formatArgValue(value),
      min: 1,
      max: MAX_SCORE,
    });
  }
  return step;
}

/** "Set score": a null value keeps the current score of that team. */
export function applySet(current: Scores, red: number | null, blue: number | null): Scores {
  return { red: red ?? current.red, blue: blue ?? current.blue };
}

/** "Increase score" (`direction` 1) and "Decrease score" (-1): one team changes by `step`, clamped to 0..999. */
export function applyStep(current: Scores, team: TeamId, step: number, direction: 1 | -1): Scores {
  return { ...current, [team]: clampScore(current[team] + direction * step) };
}

/** The scores of a stored value (device store, #40): anything that is not a valid pair starts at 0/0. */
export function resolveStoredScores(stored: unknown): Scores {
  if (typeof stored === 'object' && stored !== null) {
    const { red, blue } = stored as Record<string, unknown>;
    if (isScore(red) && isScore(blue)) return { red, blue };
  }
  return { ...RESET };
}

function isScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_SCORE;
}

/** Whether two score pairs are equal. */
export function sameScores(a: Scores, b: Scores): boolean {
  return a.red === b.red && a.blue === b.blue;
}
