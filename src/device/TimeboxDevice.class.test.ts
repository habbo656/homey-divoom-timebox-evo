import { describe, expect, it, vi } from 'vitest';

// Homey's runtime module only exists on the Homey: the device class needs just a base class here.
vi.mock('homey', () => ({ default: { Device: class {} } }));

import { TimeboxDevice } from './TimeboxDevice';

/** The device with only what `migrateDeviceClass` touches (#19). */
function fakeDevice(storedClass: string, setClass: (c: string) => Promise<void>) {
  const logs: string[] = [];
  const errors: string[] = [];
  const device = Object.create(TimeboxDevice.prototype) as Record<string, unknown>;
  Object.assign(device, {
    getClass: () => storedClass,
    setClass,
    log: (m: string) => void logs.push(m),
    error: (m: string) => void errors.push(m),
  });
  const run = () => (device as unknown as { migrateDeviceClass(): Promise<void> }).migrateDeviceClass();
  return { run, logs, errors };
}

describe('device class migration (#19)', () => {
  it('switches a device paired as "other" to "light" and logs it', async () => {
    const setClass = vi.fn(async () => {});
    const { run, logs } = fakeDevice('other', setClass);
    await run();
    expect(setClass.mock.calls).toEqual([['light']]);
    expect(logs).toEqual(['[device] device class -> light (migrated)']);
  });

  it('does nothing when the class already is "light"', async () => {
    const setClass = vi.fn(async () => {});
    const { run, logs } = fakeDevice('light', setClass);
    await run();
    expect(setClass).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it('only logs when Homey refuses the change', async () => {
    const { run, errors } = fakeDevice('other', async () => {
      throw new Error('denied');
    });
    await expect(run()).resolves.toBeUndefined();
    expect(errors).toEqual(['[device] could not set the device class: denied']);
  });
});

/** The device with only what `initTemperatureUnit` touches (#7). */
function fakeUnitDevice(o: {
  units: string;
  flag?: boolean;
  setSettings?: (s: Record<string, unknown>) => Promise<void>;
}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const store: Record<string, unknown> = o.flag ? { temperature_unit_initialised: true } : {};
  const settings: Record<string, unknown>[] = [];
  const device = Object.create(TimeboxDevice.prototype) as Record<string, unknown>;
  Object.assign(device, {
    homey: { i18n: { getUnits: () => o.units } },
    getStoreValue: (key: string) => store[key],
    setStoreValue: async (key: string, value: unknown) => void (store[key] = value),
    setSettings:
      o.setSettings ??
      (async (s: Record<string, unknown>) => {
        settings.push(s);
      }),
    log: (m: string) => void logs.push(m),
    error: (m: string) => void errors.push(m),
  });
  const run = () => (device as unknown as { initTemperatureUnit(): Promise<void> }).initTemperatureUnit();
  return { run, logs, errors, store, settings };
}

describe('temperature unit initialisation (#7)', () => {
  it('sets fahrenheit on an imperial Homey, once, and logs it', async () => {
    const { run, logs, settings, store } = fakeUnitDevice({ units: 'imperial' });
    await run();
    expect(settings).toEqual([{ temperature_unit: 'fahrenheit' }]);
    expect(store.temperature_unit_initialised).toBe(true);
    expect(logs).toEqual(['[device] temperature unit initialised: fahrenheit (imperial)']);
    await run();
    expect(settings).toHaveLength(1);
  });

  it('sets celsius on a metric Homey', async () => {
    const { run, logs, settings } = fakeUnitDevice({ units: 'metric' });
    await run();
    expect(settings).toEqual([{ temperature_unit: 'celsius' }]);
    expect(logs).toEqual(['[device] temperature unit initialised: celsius (metric)']);
  });

  it('keeps a later choice: nothing happens once the flag is set', async () => {
    const { run, logs, settings } = fakeUnitDevice({ units: 'imperial', flag: true });
    await run();
    expect(settings).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('only logs when Homey refuses the change and tries again at the next start', async () => {
    const { run, errors, store } = fakeUnitDevice({
      units: 'imperial',
      setSettings: async () => {
        throw new Error('denied');
      },
    });
    await expect(run()).resolves.toBeUndefined();
    expect(errors).toEqual(['[device] could not initialise the temperature unit: denied']);
    expect(store.temperature_unit_initialised).toBeUndefined();
  });
});

/** The device with only what the score actions and the "Score changed" trigger touch (#40). */
function fakeScoreDevice(completed: boolean) {
  const calls: string[] = [];
  const logs: string[] = [];
  const triggered: { tokens: unknown }[] = [];
  const controller = {
    setScore: async () => (calls.push('setScore'), completed),
    changeScore: async (team: string, step: number, direction: number) => (
      calls.push(`changeScore ${team} ${step} ${direction}`),
      completed
    ),
    resetScores: async () => (calls.push('resetScores'), completed),
  };
  const device = Object.create(TimeboxDevice.prototype) as Record<string, unknown>;
  Object.assign(device, {
    controller,
    homey: {
      __: (key: string) => key,
      flow: {
        getDeviceTriggerCard: (id: string) => ({
          trigger: async (_: unknown, tokens: unknown) => (calls.push(`trigger ${id}`), triggered.push({ tokens })),
        }),
      },
    },
    setCapabilityValue: async (capability: string, value: unknown) =>
      void calls.push(`tile ${capability}=${String(value)}`),
    log: (m: string) => void logs.push(m),
  });
  return { device: device as unknown as TimeboxDevice, calls, logs, triggered, raw: device };
}

describe('score actions of the device (#40)', () => {
  it('write the scoreboard tile when the change completed', async () => {
    const { device, calls } = fakeScoreDevice(true);
    await device.setScore({ red: 1 });
    await device.changeScore('red', 2, -1);
    await device.resetScores();
    expect(calls).toEqual([
      'setScore',
      'tile timebox_channel=scoreboard',
      'changeScore red 2 -1',
      'tile timebox_channel=scoreboard',
      'resetScores',
      'tile timebox_channel=scoreboard',
    ]);
  });

  it('leave the tile to a newer change when superseded', async () => {
    const { device, calls } = fakeScoreDevice(false);
    await device.resetScores();
    expect(calls).toEqual(['resetScores']);
  });

  it('reject with the readable error before the controller exists', async () => {
    const { device, raw } = fakeScoreDevice(true);
    raw.controller = null;
    await expect(device.setScore({})).rejects.toThrow('device.error.not_connected');
  });

  it('fires the "Score changed" trigger with the red and blue tokens', async () => {
    const { raw, calls, logs, triggered } = fakeScoreDevice(true);
    await (raw as unknown as { fireScoreTrigger(r: number, b: number): Promise<void> }).fireScoreTrigger(12, 34);
    expect(calls).toEqual(['trigger timebox_score_changed']);
    expect(triggered).toEqual([{ tokens: { red: 12, blue: 34 } }]);
    expect(logs).toEqual(['[device] flow trigger timebox_score_changed: 12/34']);
  });
});
