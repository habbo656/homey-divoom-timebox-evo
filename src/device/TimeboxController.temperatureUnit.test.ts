import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from '../protocol/hex';
import { statusFrame } from '../transport/__fixtures__/frames';
import { rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';
import { DIM_SEND_TIMEOUT_MS } from './TimeboxController';
import type { TextRequest } from './TimeboxController';

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** A started controller whose first status reply has been processed, writes and logs cleared. */
async function online(opts: Parameters<typeof rig>[1] = {}): Promise<Rig> {
  const r = rig({}, opts);
  r.c.start();
  await flush();
  expect(r.m.state).toBe('connected');
  r.t.writes.length = 0;
  r.surface.logs.length = 0;
  return r;
}

/** The payloads written since the last reset, chunks joined back into envelopes, as hex. */
function sent(r: Rig): string[] {
  const all = Uint8Array.from(r.t.writes.flatMap((w) => [...w]));
  const out: string[] = [];
  for (let at = 0; at < all.length;) {
    const len = all[at + 4] | (all[at + 5] << 8);
    out.push(toHex(all.subarray(at + 11, at + 6 + len - 2)));
    at += 6 + len;
  }
  return out;
}
const unitFrames = (r: Rig): string[] => sent(r).filter((p) => p.startsWith('2b'));
const unitLogs = (r: Rig): string[] => r.surface.logs.filter((l) => l.includes('temperature unit'));
const text = (): TextRequest => ({
  text: 'Hi',
  color: { r: 255, g: 255, b: 0 },
  background: { r: 0, g: 0, b: 128 },
  speed: 5,
  durationS: 0,
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the temperature unit at connect (#7)', () => {
  it('is sent with the first status of the session, in °C by default', async () => {
    const r = rig();
    r.c.start();
    await flush();
    expect(unitFrames(r)).toEqual(['2b 00']);
    expect(unitLogs(r)).toEqual(['[device] temperature unit -> °C (connect): 2b 00']);
  });

  it('sends the unit of the option', async () => {
    const r = rig({}, { temperatureUnit: 'fahrenheit' });
    r.c.start();
    await flush();
    expect(unitFrames(r)).toEqual(['2b 01']);
    expect(unitLogs(r)).toEqual(['[device] temperature unit -> °F (connect): 2b 01']);
  });

  it('is sent again after every reconnect, once per session', async () => {
    const r = await online({ temperatureUnit: 'fahrenheit' });
    await advance(120_000);
    expect(unitFrames(r)).toEqual([]);
    r.t.dropLink();
    await flush();
    await advance(10_000);
    expect(r.m.state).toBe('connected');
    expect(unitFrames(r)).toEqual(['2b 01']);
    expect(unitLogs(r)).toEqual(['[device] temperature unit -> °F (connect): 2b 01']);
    r.t.writes.length = 0;
    await advance(120_000);
    expect(unitFrames(r)).toEqual([]);
  });

  it('is sent before the weather, which is still sent', async () => {
    const r = rig({}, { temperatureUnit: 'fahrenheit' });
    await r.c.setWeather({ temperatureC: 24, condition: 'clear' }, 'flow');
    r.c.start();
    await flush();
    expect(sent(r).filter((p) => p.startsWith('2b') || p.startsWith('5f'))).toEqual(['2b 01', '5f 18 01']);
  });
});

describe('setTemperatureUnit while the Timebox is on', () => {
  it('sends 2b UU and logs it', async () => {
    const r = await online();
    await r.c.setTemperatureUnit('fahrenheit');
    expect(unitFrames(r)).toEqual(['2b 01']);
    expect(unitLogs(r)).toEqual(['[device] temperature unit -> °F (setting): 2b 01']);
    await r.c.setTemperatureUnit('celsius');
    expect(unitFrames(r)).toEqual(['2b 01', '2b 00']);
    expect(unitLogs(r).at(-1)).toBe('[device] temperature unit -> °C (setting): 2b 00');
    await advance(120_000);
    expect(unitFrames(r)).toEqual(['2b 01', '2b 00']); // not every minute
  });

  it('rejects an invalid unit and sends nothing', async () => {
    const r = await online();
    await expect(r.c.setTemperatureUnit('kelvin' as never)).rejects.toThrow(RangeError);
    await advance(120_000);
    expect(unitFrames(r)).toEqual([]);
  });

  it('a unit set while another is being sent is sent behind it: the newest wins', async () => {
    const r = await online();
    const a = r.c.setTemperatureUnit('fahrenheit');
    const b = r.c.setTemperatureUnit('celsius');
    await Promise.all([a, b]);
    expect(unitFrames(r)).toEqual(['2b 01', '2b 00']);
    r.t.writes.length = 0;
    await advance(120_000);
    expect(unitFrames(r)).toEqual([]);
  });
});

describe('a unit that cannot be sent yet is held', () => {
  it('while not connected: resolves, then the connect sends the newest', async () => {
    const r = rig();
    await r.c.setTemperatureUnit('fahrenheit');
    expect(r.t.writes).toHaveLength(0);
    expect(unitLogs(r)).toEqual(['[device] temperature unit held (not connected)']);
    r.c.start();
    await flush();
    expect(unitFrames(r)).toEqual(['2b 01']);
  });

  it('while the panel is off: logged once, sent by the check after power on', async () => {
    const r = await online();
    await r.c.setPower(false);
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    await r.c.setTemperatureUnit('fahrenheit');
    expect(unitLogs(r)).toEqual(['[device] temperature unit held (panel off)']);
    await advance(300_000);
    expect(unitFrames(r)).toEqual([]);
    expect(unitLogs(r)).toHaveLength(1);
    await r.c.setPower(true);
    await advance(60_000);
    expect(unitFrames(r)).toEqual(['2b 01']);
    expect(unitLogs(r).at(-1)).toBe('[device] temperature unit -> °F (held): 2b 01');
  });

  it('while a native text runs: sent after the text was stopped', async () => {
    const r = await online();
    await r.c.showText(text());
    r.surface.logs.length = 0;
    r.t.writes.length = 0;
    await r.c.setTemperatureUnit('fahrenheit');
    expect(unitLogs(r)).toEqual(['[device] temperature unit held (text running)']);
    await advance(120_000);
    expect(unitFrames(r)).toEqual([]);
    await r.c.stopText();
    r.t.writes.length = 0;
    await advance(60_000);
    expect(unitFrames(r)).toEqual(['2b 01']);
  });

  it('while the text frames are still being sent: nothing interleaves with them', async () => {
    const r = await online();
    r.t.holdWrites();
    const showing = r.c.showText(text());
    await flush();
    await r.c.setTemperatureUnit('fahrenheit');
    expect(unitLogs(r)).toEqual(['[device] temperature unit held (text running)']);
    r.t.releaseWrites();
    await showing;
    await flush();
    expect(unitFrames(r)).toEqual([]);
  });
});

describe('failures and sessions', () => {
  it('a failed send stays pending and is retried by the next check', async () => {
    const r = await online();
    r.t.holdWrites();
    const setting = r.c.setTemperatureUnit('fahrenheit');
    await advance(DIM_SEND_TIMEOUT_MS);
    await setting; // never an error for a failed send
    expect(r.surface.logs.some((l) => l.startsWith('[device] temperature unit send failed:'))).toBe(true);
    r.t.releaseWrites();
    await flush(); // the abandoned write may still reach the device
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    await advance(60_000);
    expect(unitFrames(r)).toEqual(['2b 01']);
    expect(unitLogs(r)).toEqual(['[device] temperature unit -> °F (held): 2b 01']);
    r.t.writes.length = 0;
    await advance(120_000);
    expect(unitFrames(r)).toEqual([]);
  });

  it('a send of the old session that ends after the new first status does not leave the new session without the unit', async () => {
    const r = await online();
    r.t.holdWrites();
    const setting = r.c.setTemperatureUnit('fahrenheit'); // in flight, the write hangs
    await flush();
    r.m.emit('connected'); // a new session starts while the old send is still running ...
    r.t.emitData(statusFrame(50, 0)); // ... and answers its first status
    await flush();
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    r.t.releaseWrites(); // the old send now completes
    await setting;
    await flush();
    expect(unitFrames(r)).toEqual(['2b 01', '2b 01']);
    expect(unitLogs(r).at(-1)).toBe('[device] temperature unit -> °F (connect): 2b 01');
    r.t.writes.length = 0;
    await advance(120_000);
    expect(unitFrames(r)).toEqual([]);
  });
});

describe('after stop()', () => {
  it('sends and logs nothing, and ignores new units', async () => {
    const r = rig();
    await r.c.setTemperatureUnit('fahrenheit');
    r.c.start();
    await r.c.stop();
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    await r.c.setTemperatureUnit('celsius');
    await advance(300_000);
    expect(r.t.writes).toHaveLength(0);
    expect(r.surface.logs).toEqual([]);
  });
});
