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
