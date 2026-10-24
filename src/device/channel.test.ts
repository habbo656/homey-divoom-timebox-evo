import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from '../protocol/hex';
import { decodeSppFrame, parseReply } from '../protocol/replies';
import { decodeStatus } from '../protocol/status';
import type { DeviceStatus } from '../protocol/status';
import { STATUS_CLOCK_B50, STATUS_LIGHTING_GREEN_B100 } from '../protocol/__fixtures__/golden';
import { DEFAULT_CLOCK_FACE } from './clock';
import {
  CHANNEL_IDS,
  CUSTOM_PAGE_IDS,
  channelCode,
  channelCommand,
  channelFromCode,
  otherModeName,
  parseChannelId,
  parseCustomPageId,
} from './channel';
import type { CodedChannelId } from './channel';

const FACE = DEFAULT_CLOCK_FACE;
const status = (hex: string): DeviceStatus => decodeStatus(parseReply(decodeSppFrame(fromHex(hex))));

describe('channel ids and codes', () => {
  it('maps every id to its device code and back', () => {
    const coded = CHANNEL_IDS.filter((id): id is CodedChannelId => id !== 'noise_meter');
    expect(coded.map(channelCode)).toEqual([0, 1, 5]);
    for (const id of coded) expect(channelFromCode(channelCode(id))).toBe(id);
  });

  it('never maps a device code to the noise meter', () => {
    for (let code = 0; code <= 255; code++) expect(channelFromCode(code)).not.toBe('noise_meter');
  });

  it.each([2, 3, 4, 6, 7, 8, 0xff, -1, 1.5, NaN])('has no mode for code %s', (code) => {
    expect(channelFromCode(code)).toBeNull();
  });

  it('names the removed modes cloud (02) and visualizer (04), nothing else', () => {
    expect(otherModeName(0x02)).toBe('cloud');
    expect(otherModeName(0x04)).toBe('visualizer');
    for (const code of [0, 1, 3, 5, 6, 7, 0xff, -1, 1.5, NaN]) expect(otherModeName(code)).toBeNull();
  });

  it('parses valid ids and rejects everything else, also the removed modes', () => {
    for (const id of CHANNEL_IDS) expect(parseChannelId(id)).toBe(id);
    for (const bad of ['', 'Clock', 'game', 'text', 'cloud', 'visualizer', 'scoreboard', 1, null, undefined, {}]) {
      expect(() => parseChannelId(bad)).toThrow(RangeError);
    }
  });
});

describe('channelCommand', () => {
  it('noise_meter: 72 02 01, whatever the stored state', () => {
    expect(toHex(channelCommand('noise_meter', null, null, FACE))).toBe('72 02 01');
    expect(toHex(channelCommand('noise_meter', status(STATUS_CLOCK_B50), 50, FACE))).toBe('72 02 01');
  });

  const clock = status(STATUS_CLOCK_B50); // colour red, brightness 50, last visualization 3
  const lighting = status(STATUS_LIGHTING_GREEN_B100); // colour green, brightness 100, last visualization 11

  it('lighting: stored colour, known brightness, effect 0, on', () => {
    expect(toHex(channelCommand('lighting', clock, 50, FACE))).toBe('45 01 ff 00 00 32 00 01 00 00 00');
    expect(toHex(channelCommand('lighting', lighting, 100, FACE))).toBe('45 01 00 ff 00 64 00 01 00 00 00');
  });

  it('lighting: the known brightness wins over the status brightness, which wins over 100', () => {
    expect(toHex(channelCommand('lighting', clock, 20, FACE))).toBe('45 01 ff 00 00 14 00 01 00 00 00');
    expect(toHex(channelCommand('lighting', clock, null, FACE))).toBe('45 01 ff 00 00 32 00 01 00 00 00');
    expect(toHex(channelCommand('lighting', null, null, FACE))).toBe('45 01 ff ff ff 64 00 01 00 00 00');
  });

  it('lighting: black becomes white, brightness is clamped to 0..100', () => {
    const black: DeviceStatus = { ...clock, lightingColor: { r: 0, g: 0, b: 0 } };
    expect(toHex(channelCommand('lighting', black, 50, FACE))).toBe('45 01 ff ff ff 32 00 01 00 00 00');
    expect(toHex(channelCommand('lighting', clock, 126, FACE))).toBe('45 01 ff 00 00 64 00 01 00 00 00');
    expect(toHex(channelCommand('lighting', clock, -5, FACE))).toBe('45 01 ff 00 00 00 00 01 00 00 00');
  });

  it('lighting: an override replaces the stored colour (always effect 0), the brightness stays', () => {
    const override = { color: { r: 255, g: 0, b: 255 } };
    expect(toHex(channelCommand('lighting', clock, 100, FACE, { lighting: override }))).toBe(
      '45 01 ff 00 ff 64 00 01 00 00 00',
    );
    expect(toHex(channelCommand('lighting', null, null, FACE, { lighting: override }))).toBe(
      '45 01 ff 00 ff 64 00 01 00 00 00',
    );
  });

  it('an override is ignored by the other channels', () => {
    const override = { color: { r: 255, g: 0, b: 255 } };
    expect(toHex(channelCommand('custom', clock, 50, FACE, { lighting: override }))).toBe('45 05');
  });

  it('clock: the full form from the clock face, independent of the last status', () => {
    expect(toHex(channelCommand('clock', clock, 50, FACE))).toBe('45 00 01 00 01 00 00 00 ff ff ff');
    const face = { ...FACE, hour24: false, style: 2, calendar: true, color: { r: 0, g: 255, b: 0 } };
    expect(toHex(channelCommand('clock', null, null, face))).toBe('45 00 00 02 01 00 00 01 00 ff 00');
  });

  it('custom sends 45 05 and no mode sends 45 03', () => {
    expect(toHex(channelCommand('custom', clock, 50, FACE))).toBe('45 05');
    for (const id of CHANNEL_IDS) {
      expect(toHex(channelCommand(id, clock, 50, FACE))).not.toBe('45 03');
    }
  });
});

describe('custom page ids', () => {
  it('maps the 1-based ids to the device index', () => {
    expect(CUSTOM_PAGE_IDS.map(parseCustomPageId)).toEqual([0, 1, 2]);
  });

  it.each(['0', '4', '', 2, 1, null, undefined, {}])('rejects custom page %j', (bad) => {
    expect(() => parseCustomPageId(bad)).toThrow(RangeError);
  });

  it('names the allowed ids in the error', () => {
    expect(() => parseCustomPageId('4')).toThrow(/1, 2, 3/);
  });
});

describe('manifest', () => {
  const json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const ids = (values: unknown) => (values as { id: string }[]).map((v) => v.id);

  it('lists the same channels in the capability and in both Flow card dropdowns', () => {
    const capability = json('.homeycompose/capabilities/timebox_channel.json');
    expect(ids(capability.values)).toEqual([...CHANNEL_IDS]);
    const flow = json('drivers/timebox/driver.flow.compose.json') as {
      conditions: { id: string; args?: { values: unknown }[] }[];
      actions: { id: string; args?: { values: unknown }[] }[];
    };
    const condition = flow.conditions.find((c) => c.id === 'timebox_channel_is');
    const action = flow.actions.find((a) => a.id === 'timebox_set_channel');
    expect(ids(condition?.args?.[0].values)).toEqual([...CHANNEL_IDS]);
    expect(ids(action?.args?.[0].values)).toEqual([...CHANNEL_IDS]);
  });

  it('lists the custom page ids in the Flow card dropdown', () => {
    const flow = json('drivers/timebox/driver.flow.compose.json') as {
      actions: { id: string; args?: { values: unknown }[] }[];
    };
    const values = (id: string) => ids(flow.actions.find((a) => a.id === id)?.args?.[0].values);
    expect(flow.actions.some((a) => a.id === 'timebox_show_visualization')).toBe(false);
    expect(values('timebox_show_custom_page')).toEqual([...CUSTOM_PAGE_IDS]);
  });

  it('says "mode", never "channel" or "Kanal", in any en or de text of the capability, Flow cards and settings', () => {
    const files = [
      '.homeycompose/capabilities/timebox_channel.json',
      'drivers/timebox/driver.flow.compose.json',
      'drivers/timebox/driver.settings.compose.json',
    ];
    const texts: string[] = [];
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(collect);
      else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if ((key === 'en' || key === 'de') && typeof value === 'string') texts.push(value);
          else collect(value);
        }
      }
    };
    for (const file of files) collect(json(file));
    expect(texts.length).toBeGreaterThan(20);
    // `[[channel]]` is the argument name of the Flow cards, not a text.
    const visible = texts.map((t) => t.replace(/\[\[[^\]]*\]\]/g, ''));
    expect(visible.filter((t) => /channel|kanal/i.test(t))).toEqual([]);
  });
});
