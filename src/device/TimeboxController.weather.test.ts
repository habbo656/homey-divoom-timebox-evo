import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from '../protocol/hex';
import { statusFrame } from '../transport/__fixtures__/frames';
import { rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';
import { DIM_SEND_TIMEOUT_MS } from './TimeboxController';
import type { TextRequest } from './TimeboxController';
import type { Weather } from './weather';

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** A started controller whose first status reply has been processed, writes and logs cleared. */
async function online(): Promise<Rig> {
  const r = rig();
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
const weatherFrames = (r: Rig): string[] => sent(r).filter((p) => p.startsWith('5f'));
const weatherLogs = (r: Rig): string[] => r.surface.logs.filter((l) => l.includes('weather'));

const RAIN: Weather = { temperatureC: 21, condition: 'rain' };
const SNOW: Weather = { temperatureC: -5, condition: 'snow' };
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

describe('setWeather while the Timebox is on', () => {
  it('sends 5f TT WW and logs it', async () => {
    const r = await online();
    await r.c.setWeather(RAIN, 'flow');
    expect(weatherFrames(r)).toEqual(['5f 15 06']);
    expect(weatherLogs(r)).toEqual(['[device] weather -> 21 °C rain (flow): 5f 15 06']);
    await advance(120_000);
    expect(weatherFrames(r)).toEqual(['5f 15 06']); // sent once, not every minute
  });

  it('sends a negative temperature as a signed byte', async () => {
    const r = await online();
    await r.c.setWeather(SNOW, 'open-meteo');
    expect(weatherFrames(r)).toEqual(['5f fb 08']);
    expect(weatherLogs(r)).toEqual(['[device] weather -> -5 °C snow (open-meteo): 5f fb 08']);
  });

  it('rejects invalid input and sends nothing, then or later', async () => {
    const r = await online();
    await expect(r.c.setWeather({ temperatureC: 200, condition: 'rain' }, 'flow')).rejects.toThrow(RangeError);
    await expect(r.c.setWeather({ temperatureC: 1.5, condition: 'rain' }, 'flow')).rejects.toThrow(RangeError);
    await expect(r.c.setWeather({ temperatureC: 5, condition: 'sunny' as never }, 'flow')).rejects.toThrow(RangeError);
    await advance(120_000);
    r.t.dropLink();
    await flush();
    await advance(10_000);
    expect(weatherFrames(r)).toEqual([]);
    expect(weatherLogs(r)).toEqual([]);
  });
});

describe('a weather that cannot be sent yet is held', () => {
  it('while not connected: resolves, then is sent with the first status of the session', async () => {
    const r = rig();
    await r.c.setWeather(RAIN, 'flow');
    expect(r.t.writes).toHaveLength(0);
    expect(r.surface.logs).toContain('[device] weather held (not connected): flow');
    r.c.start();
    await flush();
    expect(weatherFrames(r)).toEqual(['5f 15 06']);
    expect(weatherLogs(r)).toContain('[device] weather -> 21 °C rain (connect): 5f 15 06');
  });

  it('while the panel is off: sent by the check after power on', async () => {
    const r = await online();
    await r.c.setPower(false);
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    await r.c.setWeather(RAIN, 'flow');
    expect(weatherLogs(r)).toEqual(['[device] weather held (panel off): flow']);
    await advance(120_000);
    expect(weatherFrames(r)).toEqual([]);
    await r.c.setPower(true);
    await advance(60_000);
    expect(weatherFrames(r)).toEqual(['5f 15 06']);
    expect(weatherLogs(r)).toContain('[device] weather -> 21 °C rain (held): 5f 15 06');
  });

  it('while the text frames are still being sent: queued behind nothing, sent after the text was stopped', async () => {
    const r = await online();
    r.t.holdWrites();
    const showing = r.c.showText(text());
    await flush();
    await r.c.setWeather(RAIN, 'flow');
    expect(weatherLogs(r)).toEqual(['[device] weather held (text running): flow']);
    r.t.releaseWrites();
    await showing;
    await flush();
    expect(sent(r).map((p) => p.slice(0, 2))).toEqual(['6e', '86', '86', '6c', '6c']); // no 5f between or behind the frames
    await r.c.stopText();
    r.t.writes.length = 0;
    await advance(60_000);
    expect(weatherFrames(r)).toEqual(['5f 15 06']);
  });

  it('while a native text runs: sent after the text was stopped', async () => {
    const r = await online();
    await r.c.showText(text());
    r.surface.logs.length = 0;
    await r.c.setWeather(RAIN, 'open-meteo');
    expect(weatherLogs(r)).toEqual(['[device] weather held (text running): open-meteo']);
    await advance(120_000);
    expect(weatherFrames(r)).toEqual([]);
    await r.c.stopText();
    await advance(60_000);
    expect(weatherFrames(r)).toEqual(['5f 15 06']);
  });

  it('is logged as held once, not at every check', async () => {
    const r = rig();
    await r.c.setWeather(RAIN, 'flow');
    await advance(300_000);
    expect(r.surface.logs.filter((l) => l.includes('weather held'))).toHaveLength(1);
  });
});

describe('the stored weather follows the session', () => {
  it('is sent again after a reconnect (the device forgets it at a reboot)', async () => {
    const r = await online();
    await r.c.setWeather(RAIN, 'flow');
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    r.t.dropLink();
    await flush();
    await advance(10_000);
    expect(r.m.state).toBe('connected');
    expect(weatherFrames(r)).toEqual(['5f 15 06']);
    expect(weatherLogs(r)).toEqual(['[device] weather -> 21 °C rain (connect): 5f 15 06']);
  });

  it('a failed send stays pending and is retried by the next check', async () => {
    const r = await online();
    r.t.holdWrites();
    const setting = r.c.setWeather(RAIN, 'flow');
    await advance(DIM_SEND_TIMEOUT_MS);
    await setting; // never an error for a failed send
    expect(r.surface.logs.some((l) => l.startsWith('[device] weather send failed:'))).toBe(true);
    r.t.releaseWrites();
    await flush(); // the abandoned write may still reach the device
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    await advance(60_000);
    expect(weatherFrames(r)).toEqual(['5f 15 06']);
    expect(weatherLogs(r)).toEqual(['[device] weather -> 21 °C rain (held): 5f 15 06']);
    r.t.writes.length = 0;
    await advance(120_000);
    expect(weatherFrames(r)).toEqual([]);
  });

  it('a send of the old session that ends after the new first status does not leave the new session without the weather', async () => {
    const r = await online();
    r.t.holdWrites();
    const setting = r.c.setWeather(RAIN, 'flow'); // in flight, the write hangs
    await flush();
    r.m.emit('connected'); // a new session starts while the old send is still running ...
    r.t.emitData(statusFrame(50, 0)); // ... and answers its first status
    await flush();
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    r.t.releaseWrites(); // the old send now completes
    await setting;
    await flush();
    // the old send, then the one of the new session (it is not "done" for the new session)
    expect(weatherFrames(r)).toEqual(['5f 15 06', '5f 15 06']);
    expect(weatherLogs(r).at(-1)).toBe('[device] weather -> 21 °C rain (connect): 5f 15 06');
    r.t.writes.length = 0;
    await advance(120_000);
    expect(weatherFrames(r)).toEqual([]);
  });

  it('the newest value wins while held', async () => {
    const r = rig();
    await r.c.setWeather(RAIN, 'flow');
    await r.c.setWeather(SNOW, 'open-meteo');
    r.c.start();
    await flush();
    expect(weatherFrames(r)).toEqual(['5f fb 08']);
  });

  it('a value set while another is being sent is sent behind it', async () => {
    const r = await online();
    const a = r.c.setWeather(RAIN, 'flow');
    const b = r.c.setWeather(SNOW, 'open-meteo');
    await Promise.all([a, b]);
    expect(weatherFrames(r)).toEqual(['5f 15 06', '5f fb 08']);
    r.t.writes.length = 0;
    await advance(120_000);
    expect(weatherFrames(r)).toEqual([]);
  });
});

describe('partial updates (#98)', () => {
  it('a temperature alone is sent with the default condition and logged as such', async () => {
    const r = await online();
    await r.c.setWeather({ temperatureC: 23 }, 'flow');
    expect(weatherFrames(r)).toEqual(['5f 17 01']);
    expect(weatherLogs(r)).toEqual(['[device] weather -> 23 °C clear (flow temperature): 5f 17 01']);
  });

  it('a condition then keeps the temperature', async () => {
    const r = await online();
    await r.c.setWeather({ temperatureC: 23 }, 'flow');
    await r.c.setWeather({ condition: 'snow' }, 'flow');
    expect(weatherFrames(r)).toEqual(['5f 17 01', '5f 17 08']);
    expect(weatherLogs(r).at(-1)).toBe('[device] weather -> 23 °C snow (flow condition): 5f 17 08');
  });

  it('a condition alone is sent with the default temperature', async () => {
    const r = await online();
    await r.c.setWeather({ condition: 'rain' }, 'flow');
    expect(weatherFrames(r)).toEqual(['5f 00 06']);
    expect(weatherLogs(r)).toEqual(['[device] weather -> 0 °C rain (flow condition): 5f 00 06']);
  });

  it('Open-Meteo after Flow parts overwrites both', async () => {
    const r = await online();
    await r.c.setWeather({ temperatureC: 23 }, 'flow');
    await r.c.setWeather({ condition: 'snow' }, 'flow');
    await r.c.setWeather(RAIN, 'open-meteo');
    expect(weatherFrames(r).at(-1)).toBe('5f 15 06');
    expect(weatherLogs(r).at(-1)).toBe('[device] weather -> 21 °C rain (open-meteo): 5f 15 06');
  });

  it('a Flow temperature after Open-Meteo keeps its condition', async () => {
    const r = await online();
    await r.c.setWeather(SNOW, 'open-meteo');
    await r.c.setWeather({ temperatureC: 2 }, 'flow');
    expect(weatherFrames(r)).toEqual(['5f fb 08', '5f 02 08']);
    expect(weatherLogs(r).at(-1)).toBe('[device] weather -> 2 °C snow (flow temperature): 5f 02 08');
  });

  it('an invalid or empty partial update stores and sends nothing', async () => {
    const r = await online();
    await r.c.setWeather(RAIN, 'flow');
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    await expect(r.c.setWeather({ temperatureC: 1.5 }, 'flow')).rejects.toThrow(RangeError);
    await expect(r.c.setWeather({ temperatureC: 200 }, 'flow')).rejects.toThrow(RangeError);
    await expect(r.c.setWeather({ condition: 'sunny' as never }, 'flow')).rejects.toThrow(RangeError);
    await expect(r.c.setWeather({}, 'flow')).rejects.toThrow(RangeError);
    r.t.dropLink();
    await flush();
    await advance(10_000);
    // only the re-send of the unchanged stored weather after the reconnect
    expect(weatherFrames(r)).toEqual(['5f 15 06']);
  });

  it('two held partial updates are sent as one merged frame', async () => {
    const r = rig();
    await r.c.setWeather({ temperatureC: 23 }, 'flow');
    await r.c.setWeather({ condition: 'snow' }, 'flow');
    expect(weatherLogs(r)).toEqual([
      '[device] weather held (not connected): flow temperature',
      '[device] weather held (not connected): flow condition',
    ]);
    r.c.start();
    await flush();
    expect(weatherFrames(r)).toEqual(['5f 17 08']);
    expect(weatherLogs(r).at(-1)).toBe('[device] weather -> 23 °C snow (connect): 5f 17 08');
  });

  it('a reconnect sends the merged value again', async () => {
    const r = await online();
    await r.c.setWeather({ temperatureC: 23 }, 'flow');
    await r.c.setWeather({ condition: 'snow' }, 'flow');
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    r.t.dropLink();
    await flush();
    await advance(10_000);
    expect(weatherFrames(r)).toEqual(['5f 17 08']);
    expect(weatherLogs(r)).toEqual(['[device] weather -> 23 °C snow (connect): 5f 17 08']);
  });
});

describe('after stop()', () => {
  it('sends and logs nothing, and ignores new values', async () => {
    const r = rig();
    await r.c.setWeather(RAIN, 'flow');
    r.c.start();
    await r.c.stop();
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    await r.c.setWeather(SNOW, 'flow');
    await advance(300_000);
    expect(r.t.writes).toHaveLength(0);
    expect(r.surface.logs).toEqual([]);
  });
});
