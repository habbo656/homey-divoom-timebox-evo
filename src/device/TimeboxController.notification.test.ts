// #5: the Flow action "Show notification icon" sends `50 TT` and waits for the `50 55` reply.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from '../protocol/hex';
import { MESSAGES, rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';
import { DIM_CONFIRM_TIMEOUT_MS } from './TimeboxController';
import type { ImageRequest, TextRequest } from './TimeboxController';
import type { NotificationIconId } from './notification';

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** A started controller whose first status reply (channel `initialChannel`) has been processed. */
async function online(initialChannel = 0): Promise<Rig> {
  const r = rig();
  r.device.channel = initialChannel;
  r.c.start();
  await flush();
  expect(r.m.state).toBe('connected');
  r.t.writes.length = 0;
  r.surface.logs.length = 0;
  for (const list of [r.surface.channels, r.surface.channelChanges, r.surface.colors, r.surface.onoffs, r.surface.dims])
    list.length = 0;
  return r;
}

/** The payloads (hex) written since the last reset, chunks joined back into envelopes. */
function payloads(r: Rig): string[] {
  const all = Uint8Array.from(r.t.writes.flatMap((w) => [...w]));
  const out: string[] = [];
  for (let at = 0; at < all.length;) {
    const len = all[at + 4] | (all[at + 5] << 8);
    out.push(toHex(all.subarray(at + 11, at + 6 + len - 2)));
    at += 6 + len;
  }
  return out;
}
const opcodes = (r: Rig): string[] => payloads(r).map((p) => p.slice(0, 2));

/** Settle the action, letting the confirm timeout elapse, and return what it rejected with (or 'resolved'). */
async function outcome(action: Promise<unknown>): Promise<string> {
  const settled = action.then(
    () => 'resolved',
    (e: unknown) => (e as Error).message,
  );
  await advance(DIM_CONFIRM_TIMEOUT_MS);
  return settled;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('showNotificationIcon (#5)', () => {
  it('sends exactly 50 TT, waits for 50 55 and logs the icon', async () => {
    const r = await online();
    await r.c.showNotificationIcon('telegram');
    expect(payloads(r)).toEqual(['50 12']);
    expect(r.device.icons).toEqual([18]);
    expect(r.surface.logs).toEqual(['[device] notification icon shown: telegram (code 18)']);
  });

  it.each<[NotificationIconId, string]>([
    ['kakaotalk', '50 00'],
    ['instagram', '50 01'],
    ['facebook', '50 03'],
    ['missed_call', '50 06'],
    ['tamtam', '50 17'],
  ])('%s sends %s', async (id, hex) => {
    const r = await online();
    await r.c.showNotificationIcon(id);
    expect(payloads(r)).toEqual([hex]);
  });

  it('is an overlay: no tile write, no trigger, the known channel stays', async () => {
    const r = await online(5);
    await r.c.showNotificationIcon('facebook');
    expect(r.c.getChannel()).toBe('custom');
    expect(r.c.isOn()).toBe(true);
    expect(r.surface.channels).toEqual([]);
    expect(r.surface.channelChanges).toEqual([]);
    expect(r.surface.colors).toEqual([]);
    expect(r.surface.onoffs).toEqual([]);
    expect(r.surface.dims).toEqual([]);
  });

  it('leaves a shown text tracked', async () => {
    const r = await online();
    const text: TextRequest = {
      text: 'Hallo',
      color: { r: 255, g: 255, b: 0 },
      background: { r: 0, g: 0, b: 128 },
      speed: 5,
      durationS: 0,
    };
    await r.c.showText(text);
    r.t.writes.length = 0;
    await r.c.showNotificationIcon('sms');
    expect(opcodes(r)).toEqual(['50']);
    expect(r.c.isTextShown()).toBe(true);
  });

  it('leaves a shown image tracked', async () => {
    const r = await online();
    const image: ImageRequest = {
      payload: Uint8Array.from({ length: 1036 }, (_, i) => (i === 0 ? 0x44 : i % 251)),
      colours: 3,
      fit: 'cover',
      durationS: 0,
    };
    await r.c.showImage(image);
    r.t.writes.length = 0;
    await r.c.showNotificationIcon('whatsapp');
    expect(opcodes(r)).toEqual(['50']);
    expect(r.c.isImageShown()).toBe(true);
  });

  it('turns the panel on first when it is off (the mode from before off returns)', async () => {
    const r = await online(5);
    await r.c.setPower(false);
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    r.surface.onoffs.length = 0;
    await r.c.showNotificationIcon('telegram');
    expect(opcodes(r)).toEqual(['45', '46', '50']);
    expect(payloads(r)[0].slice(0, 5)).toBe('45 05');
    expect(r.c.isOn()).toBe(true);
    expect(r.surface.onoffs).toEqual([true]);
    expect(r.surface.logs).toContain('[device] notification: panel is off, turning it on first');
    expect(r.surface.logs).toContain('[device] notification icon shown: telegram (code 18)');
  });

  describe('rejections', () => {
    it('an unknown id rejects with a RangeError and sends nothing', async () => {
      const r = await online();
      await expect(r.c.showNotificationIcon('nope' as NotificationIconId)).rejects.toThrow(RangeError);
      expect(r.t.writes).toHaveLength(0);
      expect(r.surface.logs).toEqual([]);
    });

    it('not connected rejects with the readable error', async () => {
      const r = rig();
      await expect(r.c.showNotificationIcon('telegram')).rejects.toThrow(MESSAGES.notConnected);
      expect(r.t.writes).toHaveLength(0);
    });

    it('a stopped controller rejects with the readable error', async () => {
      const r = await online();
      await r.c.stop();
      r.t.writes.length = 0;
      await expect(r.c.showNotificationIcon('telegram')).rejects.toThrow(MESSAGES.notConnected);
      expect(r.t.writes).toHaveLength(0);
    });

    it('no 50 reply within the confirm timeout rejects with not_confirmed', async () => {
      const r = await online();
      r.device.answerIcon = false;
      expect(await outcome(r.c.showNotificationIcon('telegram'))).toBe(MESSAGES.notConfirmed);
      expect(payloads(r)).toEqual(['50 12']);
      expect(r.surface.logs).toContain('[device] notification icon confirm timeout: telegram (code 18)');
      expect(r.surface.logs.some((l) => l.includes('notification icon shown'))).toBe(false);
      expect(r.surface.errors).toEqual([]);
    });

    it('a link lost during the wait rejects with not_connected', async () => {
      const r = await online();
      r.device.answerIcon = false;
      const settled = r.c.showNotificationIcon('telegram').then(
        () => 'resolved',
        (e: Error) => e.message,
      );
      await flush();
      r.t.dropLink();
      await flush();
      expect(await settled).toBe(MESSAGES.notConnected);
      expect(r.surface.logs.some((l) => l.startsWith('[device] notification icon confirm failed:'))).toBe(true);
    });

    it('an unconfirmed power on rejects with not_confirmed and sends no 50', async () => {
      const r = await online();
      await r.c.setPower(false);
      r.device.answer = false;
      r.t.writes.length = 0;
      expect(await outcome(r.c.showNotificationIcon('telegram'))).toBe(MESSAGES.notConfirmed);
      expect(opcodes(r)).not.toContain('50');
      expect(r.device.icons).toEqual([]);
    });
  });
});
