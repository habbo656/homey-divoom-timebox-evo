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
