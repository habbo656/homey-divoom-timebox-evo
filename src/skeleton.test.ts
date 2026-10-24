import { describe, expect, it } from 'vitest';

const modules = [
  './protocol/envelope',
  './protocol/replies',
  './protocol/commands',
  './protocol/status',
  './transport/Transport',
  './transport/BleTransport',
  './transport/MockTransport',
  './transport/ConnectionManager',
  './transport/errors',
  './transport/chunk',
  './dev/FaultTransport',
  './dev/devHarness',
  './device/TimeboxController',
  './device/weather',
  './device/openMeteo',
  './flow/index',
];

describe('rebuild skeleton', () => {
  it.each(modules)('%s loads', async (path) => {
    expect(await import(path)).toBeDefined();
  });
});

describe('image decoder dependencies (ADR 0009)', () => {
  it.each(['pngjs', 'jpeg-js', 'omggif'])('%s loads', async (name) => {
    expect(await import(name)).toBeDefined();
  });
});
