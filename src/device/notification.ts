// Notification icon model (docs/architecture/notification.md, #5): the stable icon ids of the Flow card and their
// firmware icon codes `TT` of `50 TT` (protocol section 5.5, docs/protocol/notifications.md). Pure, no Homey and no link.
import { ArgumentError, formatArgValue } from './argumentError';
import { notificationIcon } from '../protocol/commands';

/**
 * Icon id (stable, never translated; the dropdown value of the Flow card) → firmware icon code `TT` 0..23, in code
 * order. The labels are the app names of the firmware icon table (protocol KB, command 0x50).
 */
export const NOTIFICATION_ICONS = {
  kakaotalk: 0,
  instagram: 1,
  snapchat: 2,
  facebook: 3,
  twitter: 4,
  incoming_call: 5,
  missed_call: 6,
  whatsapp: 7,
  sms: 8,
  skype: 9,
  line: 10,
  wechat: 11,
  qq: 12,
  divoom: 13,
  viber: 14,
  messenger: 15,
  ok_ru: 16,
  vk: 17,
  telegram: 18,
  tiktok: 19,
  discord: 20,
  groupme: 21,
  douyin: 22,
  tamtam: 23,
} as const satisfies Readonly<Record<string, number>>;

export type NotificationIconId = keyof typeof NOTIFICATION_ICONS;

/** The icon ids in code order. */
export const NOTIFICATION_ICON_IDS = Object.keys(NOTIFICATION_ICONS) as NotificationIconId[];

/** Validate an icon id from a Flow card. Throws `ArgumentError` (a `RangeError`) listing the allowed ids. */
export function parseNotificationIconId(value: unknown): NotificationIconId {
  const id = NOTIFICATION_ICON_IDS.find((candidate) => candidate === value);
  if (!id) {
    throw new ArgumentError(
      `icon must be one of ${NOTIFICATION_ICON_IDS.join(', ')}, got ${String(value)}`,
      'invalid_choice',
      'icon',
      { value: formatArgValue(value), allowed: NOTIFICATION_ICON_IDS.join(', ') },
    );
  }
  return id;
}

/** The firmware icon code `TT` of an icon id. Throws `ArgumentError` for an unknown id. */
export function notificationIconCode(id: NotificationIconId): number {
  return NOTIFICATION_ICONS[parseNotificationIconId(id)];
}

/** The `50 TT` payload of an icon id. Throws `ArgumentError` (a `RangeError`) for an unknown id. */
export function notificationIconCommand(id: NotificationIconId): Uint8Array {
  return notificationIcon(notificationIconCode(id));
}
