import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TEXT_UNITS } from '../protocol/commands';
import { toHex } from '../protocol/hex';
import { statusFrame } from '../transport/__fixtures__/frames';
import { rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';
import { DIM_SEND_TIMEOUT_MS } from './TimeboxController';
import type { TextRequest } from './TimeboxController';

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
  return r;
}

/** The payloads written since the last reset, chunks joined back into envelopes (opcode first, as hex). */
function payloads(r: Rig): Uint8Array[] {
  const all = Uint8Array.from(r.t.writes.flatMap((w) => [...w]));
  const out: Uint8Array[] = [];
  for (let at = 0; at < all.length;) {
    const len = all[at + 4] | (all[at + 5] << 8);
    out.push(all.subarray(at + 11, at + 6 + len - 2));
    at += 6 + len;
  }
  return out;
}
const opcodes = (r: Rig): string[] => payloads(r).map((p) => p[0].toString(16).padStart(2, '0'));
const hex = (p: Uint8Array): string => toHex(p.subarray(0, 4));

const YELLOW = { r: 255, g: 255, b: 0 };
const NAVY = { r: 0, g: 0, b: 128 };
const request = (over: Partial<TextRequest> = {}): TextRequest => ({
  text: 'Hallo Homey 123',
  color: YELLOW,
  background: NAVY,
  speed: 5,
  durationS: 0,
  ...over,
});

/** Keep the link down for `ms`: every reconnect attempt in that time fails. */
async function downFor(r: Rig, ms: number): Promise<void> {
  for (let waited = 0; waited < ms; waited += 250) {
    r.t.failNextOpen();
    await advance(250);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('showText', () => {
  it('queues the five native-text payloads in one go, with no status poll between them', async () => {
    const r = await online();
    await r.c.showText(request());
    expect(opcodes(r)).toEqual(['6e', '86', '86', '6c', '6c']);
    const p = payloads(r);
    expect(hex(p[0])).toBe('6e 01');
    expect(toHex(p[1].subarray(0, 3))).toBe('86 01 0f');
    expect(toHex(p[2])).toBe('86 00 05');
    expect([p[3].length, p[4].length]).toEqual([1036, 268]);
    expect(r.c.isTextShown()).toBe(true);
  });

  it('logs length, speed, colours and duration but never the text', async () => {
    const r = await online();
    await r.c.showText(request({ text: 'Secret Message', durationS: 12 }));
    const shown = r.surface.logs.filter((l) => l.includes('text shown'));
    expect(shown).toEqual(['[device] text shown: 14 units, speed 5, #FFFF00 on #000080, 12 s']);
    expect(r.surface.logs.join('\n')).not.toContain('Secret');
  });

  it('does not touch the tile, the known channel or the triggers', async () => {
    const r = await online(5);
    await r.c.showText(request());
    expect(r.c.getChannel()).toBe('custom');
    expect(r.surface.channels).toEqual(['custom']);
    expect(r.surface.channelChanges).toEqual([]);
  });

  it('cleans the text: emoji stripped, umlauts kept', async () => {
    const r = await online();
    await r.c.showText(request({ text: 'Grüße 😀 Welt' }));
    const p = payloads(r);
    expect(p[1][2]).toBe('Grüße  Welt'.length);
    expect(toHex(p[1].subarray(3, 13))).toBe('47 00 72 00 fc 00 df 00 65 00'); // "Grüße"
  });

  it('shows exactly the maximum of 64 characters without a cut', async () => {
    const r = await online();
    await r.c.showText(request({ text: 'x'.repeat(MAX_TEXT_UNITS) }));
    expect(payloads(r)[1][2]).toBe(MAX_TEXT_UNITS);
    expect(r.c.isTextShown()).toBe(true);
    expect(r.surface.logs.some((l) => l.includes('text shown: 64 units, speed'))).toBe(true);
    expect(r.surface.logs.join('\n')).not.toContain('cut from');
  });

  it.each([
    ['65 x', 'x'.repeat(MAX_TEXT_UNITS + 1), 65],
    ['umlauts and emoji, then 100 x', `Grüße 😀 ${'x'.repeat(100)}`, 107],
  ])('rejects a text over the maximum (%s) with the localised error and sends nothing', async (_name, text, units) => {
    const r = await online();
    await expect(r.c.showText(request({ text }))).rejects.toThrow(`text too long ${units}/64`);
    expect(r.t.writes).toHaveLength(0);
    expect(r.c.isTextShown()).toBe(false);
    expect(r.surface.logs).toContain(`[device] text rejected: ${units} units (at most 64)`);
    expect(r.surface.logs.join('\n')).not.toContain('Grüße');
  });

  it('keeps a running text active when a too long text is rejected', async () => {
    const r = await online();
    await r.c.showText(request({ text: 'running' }));
    r.t.writes.length = 0;
    await expect(r.c.showText(request({ text: 'x'.repeat(65) }))).rejects.toThrow('text too long 65/64');
    await advance(1000);
    expect(r.t.writes).toHaveLength(0);
    expect(opcodes(r)).not.toContain('6e');
    expect(r.c.isTextShown()).toBe(true);
    expect(r.surface.logs.some((l) => l.includes('superseded'))).toBe(false);
  });

  it('reports a too long text before the not-connected error while the link is down', async () => {
    const r = rig();
    await expect(r.c.showText(request({ text: 'x'.repeat(65) }))).rejects.toThrow('text too long 65/64');
    expect(r.t.writes).toHaveLength(0);
  });

  it('still reports an emoji-only text as empty, not as too long', async () => {
    const r = await online();
    await expect(r.c.showText(request({ text: '😀'.repeat(100) }))).rejects.toThrow('text empty text');
  });

  it('fails with the localised error when nothing is left, and sends nothing', async () => {
    const r = await online();
    for (const text of ['', '   ', '\n\t', '😀😀', '​']) {
      await expect(r.c.showText(request({ text }))).rejects.toThrow('text empty text');
    }
    expect(r.t.writes).toHaveLength(0);
    expect(r.c.isTextShown()).toBe(false);
  });

  it('rejects invalid arguments with a RangeError before anything is sent', async () => {
    const r = await online();
    await expect(r.c.showText(request({ text: 5 }))).rejects.toThrow(RangeError);
    await expect(r.c.showText(request({ speed: 0 }))).rejects.toThrow(RangeError);
    await expect(r.c.showText(request({ speed: 51 }))).rejects.toThrow(RangeError);
    await expect(r.c.showText(request({ durationS: -1 }))).rejects.toThrow(RangeError);
    await expect(r.c.showText(request({ durationS: 3601 }))).rejects.toThrow(RangeError);
    await expect(r.c.showText(request({ color: { r: 256, g: 0, b: 0 } }))).rejects.toThrow(RangeError);
    expect(r.t.writes).toHaveLength(0);
  });

  it('rejects with the not-connected error while the link is down', async () => {
    const r = rig();
    await expect(r.c.showText(request())).rejects.toThrow('not connected text');
    expect(r.t.writes).toHaveLength(0);
  });

  it('turns a panel that is off on first (the mode from before off returns), then shows the text', async () => {
    const r = await online(5);
    await r.c.setPower(false);
    r.t.writes.length = 0;
    await r.c.showText(request());
    expect(opcodes(r).slice(0, 2)).toEqual(['45', '46']); // restore of the custom channel and its confirm
    expect(opcodes(r).slice(2)).toEqual(['6e', '86', '86', '6c', '6c']);
    expect(payloads(r)[0].subarray(0, 2)).toEqual(Uint8Array.of(0x45, 0x05));
    expect(r.c.isOn()).toBe(true);
    expect(r.surface.onoffs.at(-1)).toBe(true);
  });
});

describe('duration', () => {
  it('sends 6e 00 when the duration is over and logs it', async () => {
    const r = await online();
    await r.c.showText(request({ durationS: 10 }));
    r.t.writes.length = 0;
    await advance(9_999);
    expect(r.t.writes).toHaveLength(0);
    expect(r.c.isTextShown()).toBe(true);
    await advance(1);
    expect(payloads(r).map(toHex)).toEqual(['6e 00']);
    expect(r.c.isTextShown()).toBe(false);
    expect(r.surface.logs).toContain('[device] text stopped (duration)');
  });

  it('0 runs until stopped: nothing is sent however long it takes', async () => {
    const r = await online();
    await r.c.showText(request({ durationS: 0 }));
    r.t.writes.length = 0;
    await advance(3_600_000);
    expect(opcodes(r).filter((o) => o === '6e')).toEqual([]);
    expect(r.c.isTextShown()).toBe(true);
  });

  it('a new text replaces the running one and its timer: only the newest duration counts', async () => {
    const r = await online();
    await r.c.showText(request({ durationS: 10 }));
    await advance(5_000);
    r.t.writes.length = 0;
    await r.c.showText(request({ text: 'B', durationS: 0 }));
    expect(opcodes(r)).toEqual(['6e', '86', '86', '6c', '6c']); // no 6e 00 first
    expect(hex(payloads(r)[0])).toBe('6e 01');
    r.t.writes.length = 0;
    await advance(60_000);
    expect(opcodes(r).filter((o) => o === '6e')).toEqual([]);
  });

  it('a second text with a duration restarts the timer', async () => {
    const r = await online();
    await r.c.showText(request({ durationS: 10 }));
    await advance(8_000);
    await r.c.showText(request({ text: 'B', durationS: 10 }));
    r.t.writes.length = 0;
    await advance(9_000);
    expect(r.t.writes).toHaveLength(0);
    await advance(1_000);
    expect(payloads(r).map(toHex)).toEqual(['6e 00']);
  });
});

describe('stopText', () => {
  it('sends 6e 00, clears the timer and logs it', async () => {
    const r = await online();
    await r.c.showText(request({ durationS: 10 }));
    r.t.writes.length = 0;
    await r.c.stopText();
    expect(payloads(r).map(toHex)).toEqual(['6e 00']);
    expect(r.c.isTextShown()).toBe(false);
    expect(r.surface.logs).toContain('[device] text stopped (action)');
    r.t.writes.length = 0;
    await advance(60_000);
    expect(opcodes(r).filter((o) => o === '6e')).toEqual([]); // the timer is gone
  });

  it('always sends 6e 00, also when the app knows of no text (it may have lost track of one)', async () => {
    const r = await online();
    await r.c.stopText();
    expect(payloads(r).map(toHex)).toEqual(['6e 00']);
    expect(r.surface.logs).toContain('[device] text stop sent (no text was running)');
  });

  it('rejects with the not-connected error while the link is down', async () => {
    const r = rig();
    await expect(r.c.stopText()).rejects.toThrow('not connected text');
  });
});

describe('a display change ends the text without 6e 00', () => {
  it('a mode change from the tile or a Flow only forgets it', async () => {
    const r = await online();
    await r.c.showText(request({ durationS: 10 }));
    r.t.writes.length = 0;
    await r.c.setChannel('custom');
    expect(opcodes(r)).toEqual(['45', '46']);
    expect(r.c.isTextShown()).toBe(false);
    expect(r.surface.logs).toContain('[device] text stopped (mode change)');
    r.t.writes.length = 0;
    await advance(60_000);
    expect(opcodes(r).filter((o) => o === '6e')).toEqual([]); // the duration timer does not fire any more
  });

  it('power off ends it too', async () => {
    const r = await online();
    await r.c.showText(request({ durationS: 30 }));
    r.t.writes.length = 0;
    await r.c.setPower(false);
    expect(opcodes(r)).toEqual(['45', '46']);
    expect(r.c.isTextShown()).toBe(false);
    expect(r.surface.logs).toContain('[device] text stopped (power off)');
    r.t.writes.length = 0;
    await advance(60_000);
    expect(opcodes(r).filter((o) => o === '6e')).toEqual([]);
  });

  it('a mode change that was queued before the text does not end it', async () => {
    const r = await online();
    const switching = r.c.setChannel('custom');
    const showing = r.c.showText(request());
    await Promise.all([switching, showing]);
    expect(r.c.isTextShown()).toBe(true);
    expect(opcodes(r).slice(0, 1)).toEqual(['45']);
  });

  it('a mode change reported by the device does not end the tracking: the duration timer still stops it (harmless if it already ended)', async () => {
    const r = await online(0);
    await r.c.showText(request({ durationS: 10 }));
    r.device.channel = 5; // somebody pressed a button at the device
    r.t.emitData(statusFrame(50, 5));
    await flush();
    expect(r.c.isTextShown()).toBe(true);
    r.t.writes.length = 0;
    await advance(10_000);
    expect(payloads(r).map(toHex)).toContain('6e 00');
  });

  it('the status poll leaves a running text alone (d0 is the channel under it)', async () => {
    const r = await online(0);
    await r.c.showText(request());
    await advance(61_000);
    expect(r.c.isTextShown()).toBe(true);
    expect(r.surface.logs.filter((l) => l.includes('text stopped'))).toEqual([]);
  });
});

describe('the link goes down', () => {
  it('a duration that ends while disconnected is stopped after the reconnect', async () => {
    const r = await online();
    await r.c.showText(request({ durationS: 5 }));
    r.t.dropLink();
    await flush();
    await downFor(r, 5_000);
    expect(r.surface.logs).toContain('[device] text duration over, stop pending (not connected)');
    r.t.writes.length = 0;
    await advance(10_000); // reconnect, first status reply
    expect(r.m.state).toBe('connected');
    expect(opcodes(r)).toContain('6e');
    expect(payloads(r).map(toHex)).toContain('6e 00');
    expect(r.surface.logs).toContain('[device] text stopped (pending stop after reconnect)');
  });

  it('a Stop text while disconnected fails, and the stop is sent after the reconnect', async () => {
    const r = await online();
    await r.c.showText(request());
    r.t.dropLink();
    await flush();
    await expect(r.c.stopText()).rejects.toThrow('not connected text');
    r.t.writes.length = 0;
    await advance(10_000);
    expect(r.m.state).toBe('connected');
    expect(payloads(r).map(toHex)).toContain('6e 00');
  });

  it('a new text cancels a pending stop', async () => {
    const r = await online();
    await r.c.showText(request({ durationS: 5 }));
    r.t.holdWrites(); // the stop at the end of A hangs and times out while the link stays up
    await advance(5_000 + DIM_SEND_TIMEOUT_MS);
    expect(r.surface.logs.some((l) => l.includes('text stop failed, pending'))).toBe(true);
    r.t.releaseWrites();
    await flush();
    await r.c.showText(request({ text: 'B' })); // clears the pending stop
    r.t.writes.length = 0;
    r.t.dropLink();
    await flush();
    await advance(10_000); // reconnect and its first status reply
    expect(r.m.state).toBe('connected');
    expect(payloads(r).map(toHex)).not.toContain('6e 00');
    expect(r.c.isTextShown()).toBe(true);
  });
});

describe('a failed text send', () => {
  it('a link drop during the send leaves a pending stop that is sent after the reconnect', async () => {
    const r = await online();
    await r.c.showText(request({ durationS: 0 }));
    r.t.holdWrites();
    const b = r.c.showText(request({ text: 'B' }));
    const rejected = expect(b).rejects.toThrow('not connected text');
    await flush();
    r.t.dropLink();
    r.t.releaseWrites();
    await flush();
    await rejected;
    expect(r.c.isTextShown()).toBe(false);
    r.t.writes.length = 0;
    await advance(10_000);
    expect(r.m.state).toBe('connected');
    expect(payloads(r).map(toHex)).toContain('6e 00');
    expect(r.surface.logs).toContain('[device] text stopped (pending stop after reconnect)');
  });

  it('a send timeout while connected queues a stop behind the frames, so a late text is ended', async () => {
    const r = rig({}, { textSendTimeoutMs: 2_000 });
    r.c.start();
    await flush();
    r.t.writes.length = 0;
    r.t.holdWrites();
    const shown = r.c.showText(request({ text: 'B' }));
    const rejected = expect(shown).rejects.toThrow('not connected text');
    await advance(2_000);
    await rejected;
    r.t.releaseWrites();
    await advance(1_000);
    const ops = opcodes(r);
    expect(ops.slice(0, 5)).toEqual(['6e', '86', '86', '6c', '6c']);
    expect(payloads(r).map(toHex).at(-1)).toBe('6e 00');
    expect(r.surface.logs).toContain('[device] text stopped (pending stop after a failed send)');
    expect(r.c.isTextShown()).toBe(false);
  });
});

describe('a failed stop or text with a newer text queued behind it', () => {
  it('a failed text B does not queue a stop that lands behind the newer text C', async () => {
    const r = rig({}, { textSendTimeoutMs: 15_000 });
    r.c.start();
    await flush();
    r.t.writes.length = 0;
    r.t.holdWrites();
    const b = r.c.showText(request({ text: 'B' }));
    const bRejected = expect(b).rejects.toThrow('not connected text');
    await advance(5_000);
    const c = r.c.showText(request({ text: 'C' }));
    await advance(10_000); // B times out while C waits behind the held frames
    await bRejected;
    r.t.releaseWrites();
    await c;
    await flush();
    expect(r.c.isTextShown()).toBe(true);
    expect(payloads(r).map(toHex).at(-1)).not.toBe('6e 00');
    expect(r.surface.logs).not.toContain('[device] text stopped (pending stop after a failed send)');
  });

  it('a stop action that times out does not become pending when a newer text C was queued', async () => {
    const r = rig({}, { textSendTimeoutMs: 15_000 });
    r.c.start();
    await flush();
    await r.c.showText(request({ text: 'A' }));
    r.t.holdWrites();
    const stop = r.c.stopText();
    const stopRejected = expect(stop).rejects.toThrow();
    const c = r.c.showText(request({ text: 'C' }));
    await advance(10_000); // the stop times out
    await stopRejected;
    r.t.releaseWrites();
    await c;
    expect(r.c.isTextShown()).toBe(true);
    r.t.writes.length = 0;
    r.t.dropLink();
    await flush();
    await advance(10_000);
    expect(r.m.state).toBe('connected');
    expect(payloads(r).map(toHex)).not.toContain('6e 00');
    expect(r.c.isTextShown()).toBe(true);
  });

  it('a stop action that times out without a newer text is still stopped after the reconnect', async () => {
    const r = rig();
    r.c.start();
    await flush();
    await r.c.showText(request({ text: 'A' }));
    r.t.holdWrites();
    const stop = r.c.stopText();
    const stopRejected = expect(stop).rejects.toThrow();
    await advance(10_000);
    await stopRejected;
    r.t.releaseWrites();
    await flush();
    r.t.writes.length = 0;
    r.t.dropLink();
    await flush();
    await advance(10_000);
    expect(payloads(r).map(toHex)).toContain('6e 00');
  });
});

describe('a stop that fails after a newer text was queued', () => {
  it('does not become pending again, so the reconnect does not end the newer text', async () => {
    const r = rig({}, { textSendTimeoutMs: 15_000 });
    r.c.start();
    await flush();
    r.t.holdWrites();
    const b = r.c.showText(request({ text: 'B' }));
    const bRejected = expect(b).rejects.toThrow('not connected text');
    await advance(15_000); // B times out, its stop is queued behind the held frames
    await bRejected;
    const c = r.c.showText(request({ text: 'C' })); // newer text, also behind the held writes
    await advance(10_000); // the queued stop times out (10 s) while C is still waiting
    r.t.releaseWrites();
    await c;
    expect(r.c.isTextShown()).toBe(true);
    r.t.writes.length = 0;
    r.t.dropLink();
    await flush();
    await advance(10_000);
    expect(r.m.state).toBe('connected');
    expect(payloads(r).map(toHex)).not.toContain('6e 00');
    expect(r.c.isTextShown()).toBe(true);
  });
});

describe('a pending small clock re-send (#88)', () => {
  const SMALL = { style: 6, weather: false, temperature: false, calendar: false, animations: false };

  it('is sent ahead of the text, so it cannot end the text 1.5 s later (panel off, small clock restored)', async () => {
    const r = rig({}, { clockSettings: SMALL });
    r.device.channel = 0;
    r.c.start();
    await flush();
    await r.c.setPower(false);
    r.t.writes.length = 0;
    await r.c.showText(request());
    expect(opcodes(r)).toEqual(['26', '45', '46', '45', '6e', '86', '86', '6c', '6c']); // the re-send does not repeat the 26 flag
    expect(r.surface.logs.some((l) => l.includes('clock face re-sent before the text'))).toBe(true);
    r.t.writes.length = 0;
    await advance(5_000);
    expect(opcodes(r).filter((o) => o === '45')).toEqual([]);
    expect(r.c.isTextShown()).toBe(true);
  });

  it('is sent ahead of the text after a Show clock (small) in the same moment', async () => {
    const r = rig({}, { clockSettings: SMALL });
    r.device.channel = 5;
    r.c.start();
    await flush();
    await r.c.showClock(6, { r: 255, g: 255, b: 255 });
    r.t.writes.length = 0;
    await r.c.showText(request());
    expect(opcodes(r)).toEqual(['45', '6e', '86', '86', '6c', '6c']);
    r.t.writes.length = 0;
    await advance(5_000);
    expect(opcodes(r).filter((o) => o === '45')).toEqual([]);
    expect(r.c.isTextShown()).toBe(true);
  });

  it('is not scheduled when a text is queued while the switch is still being confirmed (two Flows at once)', async () => {
    const r = rig({}, { clockSettings: SMALL });
    r.device.channel = 5;
    r.c.start();
    await flush();
    r.t.writes.length = 0;
    const clock = r.c.showClock(6, { r: 255, g: 255, b: 255 }); // not awaited: its 46 confirm is pending
    const text = r.c.showText(request());
    await Promise.all([clock, text]);
    expect(opcodes(r)).toEqual(['26', '45', '6e', '86', '86', '6c', '6c', '46']);
    expect(r.surface.logs).toContain(
      '[device] clock face re-send dropped: a text, countdown or stop was queued after the switch',
    );
    r.t.writes.length = 0;
    await advance(5_000);
    expect(opcodes(r).filter((o) => o === '45')).toEqual([]);
    expect(r.c.isTextShown()).toBe(true);
  });

  it('is dropped, not sent, before the text when the clock is no longer the known mode', async () => {
    const r = rig({}, { clockSettings: SMALL });
    r.device.channel = 5;
    r.c.start();
    await flush();
    await r.c.showClock(6, { r: 255, g: 255, b: 255 }); // schedules the re-send
    r.t.emitData(statusFrame(50, 5)); // the device reports the custom channel again
    await flush();
    r.t.writes.length = 0;
    await r.c.showText(request());
    expect(opcodes(r)).toEqual(['6e', '86', '86', '6c', '6c']);
    expect(r.surface.logs).toContain('[device] clock face re-send dropped before the text: mode changed');
    await advance(5_000);
    expect(opcodes(r).filter((o) => o === '45')).toEqual([]);
  });

  it('nothing is added when no re-send is pending', async () => {
    const r = rig({}, { clockSettings: SMALL });
    r.c.start();
    await flush();
    r.t.writes.length = 0;
    await r.c.showText(request());
    expect(opcodes(r)).toEqual(['6e', '86', '86', '6c', '6c']);
  });
});

describe('stopping the controller', () => {
  it('clears the duration timer', async () => {
    const r = await online();
    await r.c.showText(request({ durationS: 5 }));
    r.t.writes.length = 0;
    await r.c.stop();
    await advance(10_000);
    expect(r.t.writes).toHaveLength(0);
  });
});
