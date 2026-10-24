import { describe, expect, it } from 'vitest';
import { setDateTime } from '../protocol/commands';
import { toHex } from '../protocol/hex';
import {
  autoSyncReason,
  DAILY_SYNC_MS,
  formatSync,
  localDateTimeParts,
  resolveTimeSyncSetting,
  SYNC_RETRY_MS,
  TimeZoneError,
  TIME_CHECK_INTERVAL_MS,
  utcOffsetMinutes,
} from './timeSync';
import type { LastSync } from './timeSync';

const at = (iso: string): number => Date.parse(iso);

describe('localDateTimeParts', () => {
  it('Berlin in summer time (UTC+2)', () => {
    expect(localDateTimeParts(at('2026-07-01T10:15:20Z'), 'Europe/Berlin')).toEqual({
      year: 2026,
      month: 7,
      day: 1,
      hour: 12,
      minute: 15,
      second: 20,
    });
  });

  it('Berlin in winter time (UTC+1), accepts a Date', () => {
    expect(localDateTimeParts(new Date('2026-01-15T10:15:20Z'), 'Europe/Berlin')).toMatchObject({
      hour: 11,
      minute: 15,
    });
  });

  it('DST end in Berlin: the last second of summer time and the first of winter time', () => {
    // 2026-10-25: 03:00 CEST becomes 02:00 CET at 01:00 UTC.
    expect(localDateTimeParts(at('2026-10-25T00:59:59Z'), 'Europe/Berlin')).toMatchObject({
      hour: 2,
      minute: 59,
      second: 59,
    });
    expect(localDateTimeParts(at('2026-10-25T01:00:00Z'), 'Europe/Berlin')).toMatchObject({
      hour: 2,
      minute: 0,
      second: 0,
    });
  });

  it('DST start in Berlin: 02:00 CET becomes 03:00 CEST at 01:00 UTC', () => {
    expect(localDateTimeParts(at('2026-03-29T00:59:59Z'), 'Europe/Berlin')).toMatchObject({
      hour: 1,
      minute: 59,
      second: 59,
    });
    expect(localDateTimeParts(at('2026-03-29T01:00:00Z'), 'Europe/Berlin')).toMatchObject({
      hour: 3,
      minute: 0,
      second: 0,
    });
  });

  it('New York, Kolkata and UTC', () => {
    expect(localDateTimeParts(at('2026-01-10T03:00:00Z'), 'America/New_York')).toMatchObject({ day: 9, hour: 22 });
    expect(localDateTimeParts(at('2026-01-10T03:00:00Z'), 'Asia/Kolkata')).toMatchObject({
      day: 10,
      hour: 8,
      minute: 30,
    });
    expect(localDateTimeParts(at('2026-01-10T03:00:00Z'), 'UTC')).toMatchObject({ day: 10, hour: 3, minute: 0 });
  });

  it('local midnight is hour 0, never 24', () => {
    expect(localDateTimeParts(at('2026-06-30T22:00:00Z'), 'Europe/Berlin')).toEqual({
      year: 2026,
      month: 7,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
    });
    expect(localDateTimeParts(at('2026-06-30T00:00:00Z'), 'UTC').hour).toBe(0);
  });

  it('rolls the year over in the local zone', () => {
    expect(localDateTimeParts(at('2026-12-31T23:30:00Z'), 'Europe/Berlin')).toMatchObject({
      year: 2027,
      month: 1,
      day: 1,
      hour: 0,
      minute: 30,
    });
    expect(localDateTimeParts(at('2027-01-01T03:00:00Z'), 'America/New_York')).toMatchObject({
      year: 2026,
      month: 12,
      day: 31,
      hour: 22,
    });
  });

  it('the weekday follows the local date (Tokyo is already on Wednesday when UTC is still Tuesday)', () => {
    const parts = localDateTimeParts(at('2026-10-06T20:00:00Z'), 'Asia/Tokyo');
    expect(parts).toMatchObject({ day: 7, hour: 5 });
    expect(setDateTime(parts)[8]).toBe(3); // Wednesday
    expect(setDateTime(localDateTimeParts(at('2026-10-06T20:00:00Z'), 'UTC'))[8]).toBe(2); // Tuesday
  });

  it('golden: 2026-10-06T11:45:30Z in Berlin is the command for 13:45:30 on Tuesday', () => {
    expect(toHex(setDateTime(localDateTimeParts(at('2026-10-06T11:45:30Z'), 'Europe/Berlin')))).toBe(
      '18 1a 14 0a 06 0d 2d 1e 02',
    );
  });

  it('ignores the milliseconds', () => {
    expect(localDateTimeParts(at('2026-10-06T11:45:30Z') + 999, 'UTC').second).toBe(30);
  });

  it('rejects an unknown zone with RangeError, every time', () => {
    expect(() => localDateTimeParts(0, 'Mars/Olympus')).toThrow(TimeZoneError);
    expect(() => localDateTimeParts(0, 'Mars/Olympus')).toThrow(RangeError);
    expect(() => localDateTimeParts(0, '')).toThrow(TimeZoneError);
  });

  it('rejects an invalid instant', () => {
    expect(() => localDateTimeParts(NaN, 'UTC')).toThrow(RangeError);
    expect(() => localDateTimeParts(NaN, 'UTC')).not.toThrow(TimeZoneError);
  });
});

describe('utcOffsetMinutes', () => {
  it.each([
    ['Europe/Berlin', '2026-07-01T10:00:00Z', 120],
    ['Europe/Berlin', '2026-01-01T10:00:00Z', 60],
    ['America/New_York', '2026-01-01T10:00:00Z', -300],
    ['America/New_York', '2026-07-01T10:00:00Z', -240],
    ['Asia/Kolkata', '2026-01-01T10:00:00Z', 330],
    ['UTC', '2026-01-01T10:00:00Z', 0],
  ])('%s at %s is %i minutes', (zone, iso, minutes) => {
    expect(utcOffsetMinutes(at(iso), zone)).toBe(minutes);
  });

  it('changes exactly at the DST edge', () => {
    expect(utcOffsetMinutes(at('2026-10-25T00:59:59Z'), 'Europe/Berlin')).toBe(120);
    expect(utcOffsetMinutes(at('2026-10-25T01:00:00Z'), 'Europe/Berlin')).toBe(60);
    expect(utcOffsetMinutes(at('2026-03-29T00:59:59Z'), 'Europe/Berlin')).toBe(60);
    expect(utcOffsetMinutes(at('2026-03-29T01:00:00Z'), 'Europe/Berlin')).toBe(120);
  });

  it('is independent of the milliseconds', () => {
    expect(utcOffsetMinutes(at('2026-07-01T10:00:00Z') + 750, 'Europe/Berlin')).toBe(120);
  });

  it('rejects an unknown zone with RangeError', () => {
    expect(() => utcOffsetMinutes(0, 'Nowhere/Land')).toThrow(RangeError);
  });
});

describe('formatSync', () => {
  const parts = { year: 2026, month: 10, day: 6, hour: 13, minute: 5, second: 3 };
  it('prints date, time, zone and offset', () => {
    expect(formatSync(parts, 'Europe/Berlin', 120)).toBe('2026-10-06 13:05:03 Europe/Berlin UTC+02:00');
    expect(formatSync(parts, 'Asia/Kolkata', 330)).toBe('2026-10-06 13:05:03 Asia/Kolkata UTC+05:30');
    expect(formatSync(parts, 'America/New_York', -300)).toBe('2026-10-06 13:05:03 America/New_York UTC-05:00');
    expect(formatSync(parts, 'UTC', 0)).toBe('2026-10-06 13:05:03 UTC UTC+00:00');
  });
});

describe('resolveTimeSyncSetting', () => {
  it('is on unless explicitly false', () => {
    expect(resolveTimeSyncSetting(true)).toBe(true);
    expect(resolveTimeSyncSetting(undefined)).toBe(true);
    expect(resolveTimeSyncSetting(null)).toBe(true);
    expect(resolveTimeSyncSetting(false)).toBe(false);
  });
});

describe('autoSyncReason', () => {
  const T0 = at('2026-10-06T10:00:00Z');
  const last: LastSync = { atMs: T0, zone: 'Europe/Berlin', offsetMin: 120 };
  const reason = (
    nowMs: number,
    zone = 'Europe/Berlin',
    offset = 120,
    failure: number | null = null,
    l: LastSync | null = last,
  ) => autoSyncReason(l, nowMs, zone, offset, failure);

  it('has the documented constants', () => {
    expect(DAILY_SYNC_MS).toBe(86_400_000);
    expect(SYNC_RETRY_MS).toBe(900_000);
    expect(TIME_CHECK_INTERVAL_MS).toBe(60_000);
  });

  it('is null while nothing changed and the day is not over', () => {
    expect(reason(T0 + 60_000)).toBeNull();
    expect(reason(T0 + DAILY_SYNC_MS - 1)).toBeNull();
  });

  it('is daily after 24 h', () => {
    expect(reason(T0 + DAILY_SYNC_MS)).toBe('daily');
  });

  it('detects a DST offset change', () => {
    expect(reason(T0 + 1000, 'Europe/Berlin', 60)).toBe('offset change');
  });

  it('detects a zone change, also with the same offset, and prefers it over the offset change and daily', () => {
    expect(reason(T0 + 1000, 'Europe/Paris', 120)).toBe('zone change');
    expect(reason(T0 + DAILY_SYNC_MS, 'Asia/Kolkata', 330)).toBe('zone change');
    expect(reason(T0 + DAILY_SYNC_MS, 'Europe/Berlin', 60)).toBe('offset change');
  });

  it('is null without a previous sync and without a failure (the connect sync does that)', () => {
    expect(reason(T0, 'Europe/Berlin', 120, null, null)).toBeNull();
  });

  it('retries a failure after 15 min, and only then, even without a previous sync', () => {
    const f = T0 + 1000;
    expect(reason(f + SYNC_RETRY_MS - 1, 'Europe/Berlin', 120, f)).toBeNull();
    expect(reason(f + SYNC_RETRY_MS, 'Europe/Berlin', 120, f)).toBe('retry');
    expect(reason(f + SYNC_RETRY_MS, 'Europe/Berlin', 120, f, null)).toBe('retry');
    // a changed offset does not skip the back-off
    expect(reason(f + 1000, 'Europe/Berlin', 60, f)).toBeNull();
  });
});
