import { describe, expect, it } from 'vitest';
import { ArgumentError } from './argumentError';
import {
  NOTIFICATION_ICON_IDS,
  NOTIFICATION_ICONS,
  notificationIconCode,
  notificationIconCommand,
  parseNotificationIconId,
} from './notification';
import { MAX_NOTIFICATION_ICON } from '../protocol/commands';
import { toHex } from '../protocol/hex';

describe('notification icons (#5)', () => {
  it('maps every id to a unique code 0..23, in code order', () => {
    const codes = NOTIFICATION_ICON_IDS.map((id) => NOTIFICATION_ICONS[id]);
    expect(codes).toEqual(Array.from({ length: MAX_NOTIFICATION_ICON + 1 }, (_, i) => i));
    expect(new Set(codes).size).toBe(24);
  });

  it('uses the firmware codes of the protocol table', () => {
    expect(notificationIconCode('instagram')).toBe(1);
    expect(notificationIconCode('facebook')).toBe(3);
    expect(notificationIconCode('incoming_call')).toBe(5);
    expect(notificationIconCode('missed_call')).toBe(6);
    expect(notificationIconCode('divoom')).toBe(13);
    expect(notificationIconCode('telegram')).toBe(18);
    expect(notificationIconCode('tamtam')).toBe(23);
  });

  it('builds 50 TT for an id', () => {
    expect(toHex(notificationIconCommand('telegram'))).toBe('50 12');
    expect(toHex(notificationIconCommand('kakaotalk'))).toBe('50 00');
  });

  it('accepts every id', () => {
    for (const id of NOTIFICATION_ICON_IDS) expect(parseNotificationIconId(id)).toBe(id);
  });

  it.each(['nope', '', 'Telegram', 'toString', 18, null, undefined, {}])('rejects %j', (value) => {
    expect(() => parseNotificationIconId(value)).toThrow(ArgumentError);
    expect(() => notificationIconCommand(value as never)).toThrow(RangeError);
  });
});
