// Pure helpers of the automatic time sync (docs/architecture.md, "Time sync"): Homey's local time in its time zone as
// the parts of the `18` command, and the decision when to sync again. No clock, no Homey, no timers here.
import type { DateTimeParts } from '../protocol/commands';

/** A successful sync is repeated after this long (the device clock drifts). */
export const DAILY_SYNC_MS = 24 * 60 * 60 * 1000;
/** After a failed sync the next automatic attempt waits this long. */
export const SYNC_RETRY_MS = 15 * 60 * 1000;
/** How often the controller compares the current UTC offset and time zone with the last sync (no BLE traffic). */
export const TIME_CHECK_INTERVAL_MS = 60 * 1000;

/** The time zone is unknown to `Intl` (or yields no usable time); distinguishes it from other `RangeError`s. */
export class TimeZoneError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'TimeZoneError';
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch (e) {
      // Nothing is cached for an unknown zone.
      throw new TimeZoneError(`unknown time zone "${timeZone}": ${e instanceof Error ? e.message : String(e)}`);
    }
    formatters.set(timeZone, f);
  }
  return f;
}

/**
 * The wall-clock date and time of `instant` (a `Date` or epoch milliseconds) in the IANA zone `timeZone`
 * (e.g. `Europe/Berlin`), DST included. Throws `TimeZoneError` (a `RangeError`) for an unknown zone, `RangeError` for an invalid instant.
 */
export function localDateTimeParts(instant: Date | number, timeZone: string): DateTimeParts {
  const ms = typeof instant === 'number' ? instant : instant.getTime();
  if (!Number.isFinite(ms)) throw new RangeError(`invalid instant ${String(ms)}`);
  const values: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  const { year, month, day, hour, minute, second } = values;
  if (![year, month, day, hour, minute, second].every(Number.isInteger)) {
    throw new TimeZoneError(`could not determine the local time in ${timeZone}`);
  }
  // Some engines print midnight as hour 24 even with the h23 cycle.
  return { year, month, day, hour: hour === 24 ? 0 : hour, minute, second };
}

/** The UTC offset of `timeZone` at `instant` in minutes (Berlin in summer: 120, Kolkata: 330, New York in winter: -300). */
export function utcOffsetMinutes(instant: Date | number, timeZone: string): number {
  const ms = typeof instant === 'number' ? instant : instant.getTime();
  const p = localDateTimeParts(ms, timeZone);
  const local = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((local - Math.floor(ms / 1000) * 1000) / 60_000);
}

const two = (n: number): string => String(n).padStart(2, '0');

/** `2026-10-06 13:45:30 Europe/Berlin UTC+02:00`, the text of the sync log line. */
export function formatSync(parts: DateTimeParts, timeZone: string, offsetMin: number): string {
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return (
    `${parts.year}-${two(parts.month)}-${two(parts.day)} ${two(parts.hour)}:${two(parts.minute)}:${two(parts.second)} ` +
    `${timeZone} UTC${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`
  );
}

/** The device setting `time_sync`: on unless it is explicitly `false` (default on, also for a missing value). */
export function resolveTimeSyncSetting(raw: unknown): boolean {
  return raw !== false;
}

/** What the last successful sync was based on. */
export interface LastSync {
  atMs: number;
  zone: string;
  offsetMin: number;
}

export type AutoSyncReason = 'retry' | 'zone change' | 'offset change' | 'daily';

/**
 * Whether an automatic sync is due, and why. `last` is the last successful sync (null: none in this run, the connect
 * sync takes care of that), `lastFailureAtMs` the time of a failed attempt that is still to be retried (null: none).
 * While a failure is pending only the retry delay counts; otherwise a changed zone or offset (DST) wins over the daily sync.
 */
export function autoSyncReason(
  last: LastSync | null,
  nowMs: number,
  zone: string,
  offsetMin: number,
  lastFailureAtMs: number | null,
): AutoSyncReason | null {
  if (lastFailureAtMs !== null) return nowMs - lastFailureAtMs >= SYNC_RETRY_MS ? 'retry' : null;
  if (!last) return null;
  if (zone !== last.zone) return 'zone change';
  if (offsetMin !== last.offsetMin) return 'offset change';
  if (nowMs - last.atMs >= DAILY_SYNC_MS) return 'daily';
  return null;
}
