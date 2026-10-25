import { describe, expect, it } from 'vitest';
import { translator } from '../device/__fixtures__/translator';
import { ImageError } from '../device/imageError';
import { prepareText } from '../device/scrollText';
import {
  FLOW_ACTION_SET_CHANNEL,
  FLOW_ACTION_SET_LIGHTING,
  FLOW_ACTION_SET_TEMPERATURE,
  FLOW_ACTION_SET_WEATHER,
  FLOW_ACTION_SHOW_CLOCK,
  FLOW_ACTION_SHOW_CUSTOM_PAGE,
  FLOW_ACTION_SHOW_IMAGE,
  FLOW_ACTION_SHOW_IMAGE_URL,
  FLOW_ACTION_SHOW_NOTIFICATION_ICON,
  FLOW_ACTION_SHOW_TEXT,
  FLOW_ACTION_START_COUNTDOWN,
  FLOW_ACTION_STOP_COUNTDOWN,
  FLOW_ACTION_STOP_TEXT,
  FLOW_CONDITION_CHANNEL_IS,
  FLOW_CONDITION_IS_CONNECTED,
  registerTimeboxFlowCards,
} from './index';
import type { FlowLike } from './index';

// The listeners are stored untyped: each test passes the argument shape of its card.
// With the identity translator the localised message is the key of the error kind.
const INVALID = /^device\.error\.invalid_/;

type Listener = (args: unknown) => boolean | Promise<boolean>;
type ActionListener = (args: unknown) => void | Promise<void>;

function fakeFlow() {
  const listeners = new Map<string, Listener>();
  const actions = new Map<string, ActionListener>();
  const flow: FlowLike = {
    getConditionCard: (id) => ({
      registerRunListener: (listener) => {
        listeners.set(id, listener as Listener);
      },
    }),
    getActionCard: (id) => ({
      registerRunListener: (listener) => {
        actions.set(id, listener as ActionListener);
      },
    }),
  };
  return { flow, listeners, actions };
}

describe('registerTimeboxFlowCards', () => {
  it('registers the is-connected condition, which returns device.isConnected()', async () => {
    const { flow, listeners } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    expect([...listeners.keys()]).toEqual([FLOW_CONDITION_IS_CONNECTED, FLOW_CONDITION_CHANNEL_IS]);
    const run = listeners.get(FLOW_CONDITION_IS_CONNECTED)!;
    expect(await run({ device: { isConnected: () => true } })).toBe(true);
    expect(await run({ device: { isConnected: () => false } })).toBe(false);
  });

  it('registers the action cards (no sync-time action)', () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    expect([...actions.keys()]).toEqual([
      FLOW_ACTION_SET_CHANNEL,
      FLOW_ACTION_SHOW_CLOCK,
      FLOW_ACTION_SET_LIGHTING,
      FLOW_ACTION_SHOW_CUSTOM_PAGE,
      FLOW_ACTION_SHOW_TEXT,
      FLOW_ACTION_STOP_TEXT,
      FLOW_ACTION_SHOW_IMAGE,
      FLOW_ACTION_SHOW_IMAGE_URL,
      FLOW_ACTION_START_COUNTDOWN,
      FLOW_ACTION_STOP_COUNTDOWN,
      FLOW_ACTION_SET_WEATHER,
      FLOW_ACTION_SET_TEMPERATURE,
      FLOW_ACTION_SHOW_NOTIFICATION_ICON,
    ]);
  });

  it('registers the channel-is condition, which compares the device channel with the argument', async () => {
    const { flow, listeners } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    const run = listeners.get(FLOW_CONDITION_CHANNEL_IS)!;
    const device = (channel: string | null) => ({ getChannel: () => channel });
    expect(await run({ device: device('lighting'), channel: 'lighting' })).toBe(true);
    expect(await run({ device: device('clock'), channel: 'lighting' })).toBe(false);
    expect(await run({ device: device(null), channel: 'clock' })).toBe(false);
    await expect(Promise.resolve().then(() => run({ device: device('clock'), channel: 'games' }))).rejects.toThrow(
      INVALID,
    );
  });

  it('registers the set-channel action, which switches the device and passes its rejection on', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    const run = actions.get(FLOW_ACTION_SET_CHANNEL)!;
    const switched: string[] = [];
    await run({ device: { switchChannel: async (id: string) => void switched.push(id) }, channel: 'custom' });
    expect(switched).toEqual(['custom']);
    await expect(
      run({
        device: {
          switchChannel: async () => {
            throw new Error('not connected text');
          },
        },
        channel: 'custom',
      }),
    ).rejects.toThrow('not connected text');
    await expect(run({ device: { switchChannel: async () => undefined }, channel: 'bogus' })).rejects.toThrow(INVALID);
    expect(switched).toEqual(['custom']);
  });

  it('registers the show-clock action, which parses style and colour and passes the device rejection on', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    const run = actions.get(FLOW_ACTION_SHOW_CLOCK)!;
    const shown: unknown[] = [];
    const device = { showClock: async (style: number, color: unknown) => void shown.push([style, color]) };
    await run({ device, style: 'analog_square', color: '#0000ff' });
    await run({ device, style: 'full_screen', color: '#FF8000' });
    expect(shown).toEqual([
      [3, { r: 0, g: 0, b: 255 }],
      [0, { r: 255, g: 128, b: 0 }],
    ]);
    await expect(
      run({
        device: {
          showClock: async () => {
            throw new Error('not connected text');
          },
        },
        style: 'boxed',
        color: '#00ff00',
      }),
    ).rejects.toThrow('not connected text');
  });

  it('show-clock rejects an unknown style or an invalid colour before the device is called', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    const run = actions.get(FLOW_ACTION_SHOW_CLOCK)!;
    let calls = 0;
    const device = { showClock: async () => void calls++ };
    for (const args of [
      { style: 'sideways', color: '#ffffff' },
      { style: 2, color: '#ffffff' },
      { style: 'boxed', color: 'red' },
      { style: 'boxed', color: undefined },
    ]) {
      await expect(Promise.resolve().then(() => run({ device, ...args }))).rejects.toThrow(INVALID);
    }
    expect(calls).toBe(0);
  });

  it('L1: registers the set-lighting action, which parses the colour, ignores a stale effect argument and passes the device rejection on', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    const run = actions.get(FLOW_ACTION_SET_LIGHTING)!;
    const set: unknown[][] = [];
    const device = { setLighting: async (...args: unknown[]) => void set.push(args) };
    await run({ device, color: '#ff00ff' });
    await run({ device, color: '#FF8000', effect: 'love' }); // an old Flow still carries its effect
    await run({ device, color: '00ff00', effect: 'bogus' });
    expect(set).toEqual([[{ r: 255, g: 0, b: 255 }], [{ r: 255, g: 128, b: 0 }], [{ r: 0, g: 255, b: 0 }]]);
    await expect(
      run({
        device: {
          setLighting: async () => {
            throw new Error('not connected text');
          },
        },
        color: '#00ff00',
      }),
    ).rejects.toThrow('not connected text');
  });

  it('set-lighting rejects an invalid colour before the device is called', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    const run = actions.get(FLOW_ACTION_SET_LIGHTING)!;
    let calls = 0;
    const device = { setLighting: async () => void calls++ };
    for (const args of [{ color: 'red' }, { color: undefined }, { color: '#fff', effect: 'plain' }, { color: 5 }]) {
      await expect(Promise.resolve().then(() => run({ device, ...args }))).rejects.toThrow(INVALID);
    }
    expect(calls).toBe(0);
  });

  it('never requests the removed show-visualization action card', () => {
    const requested: string[] = [];
    const flow: FlowLike = {
      getConditionCard: (id) => ({ registerRunListener: () => void requested.push(id) }),
      getActionCard: (id) => ({ registerRunListener: () => void requested.push(id) }),
    };
    registerTimeboxFlowCards(flow, (key) => key);
    expect(requested).not.toContain('timebox_show_visualization');
  });

  it('registers the show-custom-page action, which maps the 1-based id to the device page and passes the rejection on', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    const run = actions.get(FLOW_ACTION_SHOW_CUSTOM_PAGE)!;
    const shown: number[] = [];
    const device = { showCustomPage: async (page: number) => void shown.push(page) };
    for (const id of ['1', '2', '3']) await run({ device, page: id });
    expect(shown).toEqual([0, 1, 2]);
    await expect(
      run({
        device: {
          showCustomPage: async () => {
            throw new Error('not connected text');
          },
        },
        page: '2',
      }),
    ).rejects.toThrow('not connected text');
  });

  it('show-custom-page rejects an unknown id before the device is called', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    const run = actions.get(FLOW_ACTION_SHOW_CUSTOM_PAGE)!;
    let calls = 0;
    const device = { showCustomPage: async () => void calls++ };
    for (const page of ['0', '4', '', 2, 1, null, undefined]) {
      await expect(Promise.resolve().then(() => run({ device, page }))).rejects.toThrow(INVALID);
    }
    expect(calls).toBe(0);
  });

  it('registers the show-text action, which parses colours, speed and duration and passes the device rejection on', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    const run = actions.get(FLOW_ACTION_SHOW_TEXT)!;
    const shown: unknown[] = [];
    const device = { showText: async (request: unknown) => void shown.push(request) };
    await run({ device, text: 'Hallo Homey', color: '#ffff00', background: '#000080', speed: 'normal', duration: 10 });
    await run({ device, text: 'Grüße', color: '#FF0000', background: '#000000', speed: 'fast', duration: undefined });
    await run({ device, text: 'x', color: '00ff00', background: '#0000ff', speed: 'slow', duration: '2.6' });
    expect(shown).toEqual([
      {
        text: 'Hallo Homey',
        color: { r: 255, g: 255, b: 0 },
        background: { r: 0, g: 0, b: 128 },
        speed: 5,
        durationS: 10,
      },
      { text: 'Grüße', color: { r: 255, g: 0, b: 0 }, background: { r: 0, g: 0, b: 0 }, speed: 10, durationS: 0 },
      { text: 'x', color: { r: 0, g: 255, b: 0 }, background: { r: 0, g: 0, b: 255 }, speed: 3, durationS: 3 },
    ]);
    await expect(
      run({
        device: {
          showText: async () => {
            throw new Error('text empty text');
          },
        },
        text: '   ',
        color: '#ffffff',
        background: '#000000',
        speed: 'normal',
        duration: 0,
      }),
    ).rejects.toThrow('text empty text');
  });

  it('show-text rejects a bad colour, speed or duration before the device is called', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    const run = actions.get(FLOW_ACTION_SHOW_TEXT)!;
    let calls = 0;
    const device = { showText: async () => void calls++ };
    const good = { device, text: 'a', color: '#ffffff', background: '#000000', speed: 'normal', duration: 5 };
    for (const bad of [
      { color: 'white' },
      { background: undefined },
      { speed: 'turbo' },
      { speed: 5 },
      { duration: -1 },
      { duration: 3601 },
      { duration: 'soon' },
    ]) {
      await expect(Promise.resolve().then(() => run({ ...good, ...bad }))).rejects.toThrow(INVALID);
    }
    expect(calls).toBe(0);
  });

  it('registers the stop-text action, which stops the text and passes the device rejection on', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    const run = actions.get(FLOW_ACTION_STOP_TEXT)!;
    let stops = 0;
    await run({ device: { stopText: async () => void stops++ } });
    expect(stops).toBe(1);
    await expect(
      run({
        device: {
          stopText: async () => {
            throw new Error('not connected text');
          },
        },
      }),
    ).rejects.toThrow('not connected text');
  });

  it('registers the show-image action, which passes the token, the fit and the duration to the device', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    const run = actions.get(FLOW_ACTION_SHOW_IMAGE)!;
    const shown: unknown[] = [];
    const device = { showImageToken: async (...args: unknown[]) => void shown.push(args) };
    const image = { getStream: async () => undefined };
    await run({ device, droptoken: image, fit: 'contain', duration: 10 });
    await run({ device, droptoken: image, fit: 'cover', duration: undefined });
    await run({ device, droptoken: undefined, fit: 'cover', duration: '2.6' });
    expect(shown).toEqual([
      [image, 'contain', 10],
      [image, 'cover', 0],
      [undefined, 'cover', 3],
    ]);
  });

  it('registers the show-image-from-url action, which passes the normalised url, the fit and the duration', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    const run = actions.get(FLOW_ACTION_SHOW_IMAGE_URL)!;
    const shown: unknown[] = [];
    const device = { showImageFromUrl: async (...args: unknown[]) => void shown.push(args) };
    await run({ device, url: ' HTTPS://Example.com/a.png ', fit: 'cover', duration: 15 });
    await run({ device, url: 'http://192.168.1.5/cam.jpg', fit: 'contain', duration: null });
    expect(shown).toEqual([
      ['https://example.com/a.png', 'cover', 15],
      ['http://192.168.1.5/cam.jpg', 'contain', 0],
    ]);
  });

  it('the image actions reject a bad url, fit or duration before the device is called', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    let calls = 0;
    const device = { showImageFromUrl: async () => void calls++, showImageToken: async () => void calls++ };
    const url = actions.get(FLOW_ACTION_SHOW_IMAGE_URL)!;
    const token = actions.get(FLOW_ACTION_SHOW_IMAGE)!;
    const good = { device, url: 'https://example.com/a.png', fit: 'cover', duration: 5 };
    for (const bad of [
      { url: 'ftp://example.com/a.png' },
      { url: '' },
      { url: undefined },
      { fit: 'stretch' },
      { fit: undefined },
      { duration: -1 },
      { duration: 3601 },
      { duration: 'soon' },
    ]) {
      await expect(Promise.resolve().then(() => url({ ...good, ...bad }))).rejects.toThrow(INVALID);
    }
    for (const bad of [{ fit: 'stretch' }, { duration: 4000 }]) {
      await expect(Promise.resolve().then(() => token({ device, fit: 'cover', duration: 5, ...bad }))).rejects.toThrow(
        INVALID,
      );
    }
    expect(calls).toBe(0);
  });

  it('the image actions pass an ImageError on as the localised message', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    const run = actions.get(FLOW_ACTION_SHOW_IMAGE_URL)!;
    const device = {
      showImageFromUrl: async () => {
        throw new ImageError('HTTP 404 from the server', 'unreachable');
      },
    };
    await expect(run({ device, url: 'https://example.com/a.png', fit: 'cover', duration: 0 })).rejects.toThrow(
      expect.objectContaining({ message: 'device.error.image_unreachable', name: 'Error' }),
    );
  });

  it('registers the start-countdown action, which validates and rounds minutes and seconds', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    const run = actions.get(FLOW_ACTION_START_COUNTDOWN)!;
    const seen: unknown[] = [];
    const device = { startCountdown: async (t: unknown) => void seen.push(t) };
    await run({ device, minutes: 5, seconds: 0 });
    await run({ device, minutes: 0, seconds: 29.6 });
    await run({ device, minutes: 99, seconds: 59 });
    await run({ device, minutes: 0, seconds: 0 }); // 0:00 is rejected by the device with a localised message
    expect(seen).toEqual([
      { minutes: 5, seconds: 0 },
      { minutes: 0, seconds: 30 },
      { minutes: 99, seconds: 59 },
      { minutes: 0, seconds: 0 },
    ]);
  });

  it('rejects an invalid countdown before the device is called', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    const run = actions.get(FLOW_ACTION_START_COUNTDOWN)!;
    let calls = 0;
    const device = { startCountdown: async () => void calls++ };
    for (const bad of [
      { minutes: 100, seconds: 0 },
      { minutes: -1, seconds: 0 },
      { minutes: 1, seconds: 60 },
      { minutes: 1, seconds: 59.6 },
      { minutes: '5', seconds: 0 },
      { minutes: 5, seconds: undefined },
      { minutes: NaN, seconds: 0 },
    ]) {
      await expect(Promise.resolve().then(() => run({ device, ...bad }))).rejects.toThrow(INVALID);
    }
    expect(calls).toBe(0);
  });

  it('passes the device rejection of the start-countdown action on', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    const run = actions.get(FLOW_ACTION_START_COUNTDOWN)!;
    const device = {
      startCountdown: async () => {
        throw new Error('countdown zero text');
      },
    };
    await expect(run({ device, minutes: 0, seconds: 0 })).rejects.toThrow('countdown zero text');
  });

  it('registers the stop-countdown action, which stops it and passes the device rejection on', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    const run = actions.get(FLOW_ACTION_STOP_COUNTDOWN)!;
    let stops = 0;
    await run({ device: { stopCountdown: async () => void stops++ } });
    expect(stops).toBe(1);
    await expect(
      run({
        device: {
          stopCountdown: async () => {
            throw new Error('not connected text');
          },
        },
      }),
    ).rejects.toThrow('not connected text');
  });

  it('registers the set-weather action, which passes only the condition on', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    const run = actions.get(FLOW_ACTION_SET_WEATHER)!;
    const seen: unknown[] = [];
    const device = { setWeather: async (w: unknown) => void seen.push(w) };
    await run({ device, condition: 'rain' });
    await run({ device, condition: 'thunder', temperature: 30 }); // a stale temperature argument is ignored
    expect(seen).toEqual([{ condition: 'rain' }, { condition: 'thunder' }]);
    await expect(
      run({
        device: {
          setWeather: async () => {
            throw new Error('not connected text');
          },
        },
        condition: 'clear',
      }),
    ).rejects.toThrow('not connected text');
  });

  it('registers the set-temperature action, which passes only the rounded temperature on', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    const run = actions.get(FLOW_ACTION_SET_TEMPERATURE)!;
    const seen: unknown[] = [];
    const device = { setWeather: async (w: unknown) => void seen.push(w) };
    await run({ device, temperature: 21.5 });
    await run({ device, temperature: -0.4 });
    await run({ device, temperature: -99 });
    expect(seen).toEqual([{ temperatureC: 22 }, { temperatureC: 0 }, { temperatureC: -99 }]);
    expect(Object.is((seen[1] as { temperatureC: number }).temperatureC, -0)).toBe(false);
    await expect(
      run({
        device: {
          setWeather: async () => {
            throw new Error('not connected text');
          },
        },
        temperature: 5,
      }),
    ).rejects.toThrow('not connected text');
  });

  it('the weather cards reject bad input before the device is called', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    let calls = 0;
    const device = { setWeather: async () => void calls++ };
    for (const temperature of [99.6, -100, NaN, 'warm', undefined]) {
      await expect(
        Promise.resolve().then(() => actions.get(FLOW_ACTION_SET_TEMPERATURE)!({ device, temperature })),
      ).rejects.toThrow(INVALID);
    }
    for (const condition of ['sunny', undefined, 1]) {
      await expect(
        Promise.resolve().then(() => actions.get(FLOW_ACTION_SET_WEATHER)!({ device, condition })),
      ).rejects.toThrow(INVALID);
    }
    expect(calls).toBe(0);
  });
});

describe('Show notification icon (#5)', () => {
  it('registers the action, which passes the validated icon id on and passes the device rejection on', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    const run = actions.get(FLOW_ACTION_SHOW_NOTIFICATION_ICON)!;
    const seen: unknown[] = [];
    const device = { showNotificationIcon: async (id: unknown) => void seen.push(id) };
    await run({ device, icon: 'telegram' });
    await run({ device, icon: 'incoming_call' });
    expect(seen).toEqual(['telegram', 'incoming_call']);
    await expect(
      run({
        device: {
          showNotificationIcon: async () => {
            throw new Error('not confirmed text');
          },
        },
        icon: 'facebook',
      }),
    ).rejects.toThrow('not confirmed text');
  });

  it('rejects an unknown icon before the device is called', async () => {
    const { flow, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, (key) => key);
    let calls = 0;
    const device = { showNotificationIcon: async () => void calls++ };
    for (const icon of ['nope', 'Telegram', '', 18, undefined]) {
      await expect(
        Promise.resolve().then(() => actions.get(FLOW_ACTION_SHOW_NOTIFICATION_ICON)!({ device, icon })),
      ).rejects.toThrow(INVALID);
    }
    expect(calls).toBe(0);
  });
});

// Localised validation errors (#108): the translator reads the real German locale like `homey.__` does.
describe('localised argument errors', () => {
  const de = translator('de');

  function register() {
    const { flow, listeners, actions } = fakeFlow();
    registerTimeboxFlowCards(flow, de);
    return { listeners, actions };
  }

  // Every device method counts its calls: an invalid argument must not reach the device.
  const calls: string[] = [];
  const spy = (name: string) => async () => void calls.push(name);
  const device = {
    showText: spy('showText'),
    showImageToken: spy('showImageToken'),
    showImageFromUrl: spy('showImageFromUrl'),
    startCountdown: spy('startCountdown'),
    setWeather: spy('setWeather'),
    showClock: spy('showClock'),
    setLighting: spy('setLighting'),
    showCustomPage: spy('showCustomPage'),
    switchChannel: spy('switchChannel'),
    showNotificationIcon: spy('showNotificationIcon'),
    getChannel: () => 'clock',
  };
  const goodText = { text: 'a', color: '#ffffff', background: '#000000', speed: 'normal', duration: 5 };

  const cases: [string, string, Record<string, unknown>, string][] = [
    [
      'show_text duration 4000',
      FLOW_ACTION_SHOW_TEXT,
      { ...goodText, duration: 4000 },
      'Dauer (s): 4000 liegt außerhalb des erlaubten Bereichs von 0 bis 3600.',
    ],
    [
      'show_text duration "abc"',
      FLOW_ACTION_SHOW_TEXT,
      { ...goodText, duration: 'abc' },
      'Dauer (s): "abc" ist keine Zahl.',
    ],
    [
      'show_text speed "turbo"',
      FLOW_ACTION_SHOW_TEXT,
      { ...goodText, speed: 'turbo' },
      'Geschwindigkeit: "turbo" ist keine gültige Auswahl. Erlaubt sind: slow, normal, fast.',
    ],
    [
      'show_text colour "red"',
      FLOW_ACTION_SHOW_TEXT,
      { ...goodText, color: 'red' },
      'Textfarbe: "red" ist keine Farbe. Verwende eine Hex-Farbe wie #FF8000.',
    ],
    [
      'show_text background "#12345"',
      FLOW_ACTION_SHOW_TEXT,
      { ...goodText, background: '#12345' },
      'Hintergrundfarbe: "#12345" ist keine Farbe. Verwende eine Hex-Farbe wie #FF8000.',
    ],
    [
      'show_image_url "ftp://x/a.png"',
      FLOW_ACTION_SHOW_IMAGE_URL,
      { url: 'ftp://x/a.png', fit: 'cover', duration: 0 },
      expect.stringMatching(/^URL: "ftp:\/\/x\/a\.png" ist keine Webadresse.*2048 Zeichen/),
    ],
    [
      'show_image_url fit "stretch"',
      FLOW_ACTION_SHOW_IMAGE_URL,
      { url: 'https://x/a.png', fit: 'stretch', duration: 0 },
      'Einpassen: "stretch" ist keine gültige Auswahl. Erlaubt sind: cover, contain.',
    ],
    [
      'show_image duration 4000',
      FLOW_ACTION_SHOW_IMAGE,
      { fit: 'cover', duration: 4000 },
      'Dauer (s): 4000 liegt außerhalb des erlaubten Bereichs von 0 bis 3600.',
    ],
    [
      'start_countdown minutes 100',
      FLOW_ACTION_START_COUNTDOWN,
      { minutes: 100, seconds: 0 },
      'Minuten: 100 liegt außerhalb des erlaubten Bereichs von 0 bis 99.',
    ],
    [
      'start_countdown seconds 60',
      FLOW_ACTION_START_COUNTDOWN,
      { minutes: 1, seconds: 60 },
      'Sekunden: 60 liegt außerhalb des erlaubten Bereichs von 0 bis 59.',
    ],
    [
      'set_temperature 150',
      FLOW_ACTION_SET_TEMPERATURE,
      { temperature: 150 },
      'Temperatur (°C): 150 liegt außerhalb des erlaubten Bereichs von -99 bis 99.',
    ],
    ['set_temperature NaN', FLOW_ACTION_SET_TEMPERATURE, { temperature: NaN }, 'Temperatur (°C): NaN ist keine Zahl.'],
    [
      'set_weather "sunny"',
      FLOW_ACTION_SET_WEATHER,
      { condition: 'sunny' },
      'Wetter: "sunny" ist keine gültige Auswahl. Erlaubt sind: clear, cloudy, thunder, rain, snow, fog.',
    ],
    [
      'show_clock style "x"',
      FLOW_ACTION_SHOW_CLOCK,
      { style: 'x', color: '#ffffff' },
      'Stil: "x" ist keine gültige Auswahl. Erlaubt sind: full_screen, rainbow, boxed, analog_square, negative, analog_round, small.',
    ],
    [
      'show_clock colour "red"',
      FLOW_ACTION_SHOW_CLOCK,
      { style: 'boxed', color: 'red' },
      'Farbe: "red" ist keine Farbe. Verwende eine Hex-Farbe wie #FF8000.',
    ],
    [
      'set_lighting "blue"',
      FLOW_ACTION_SET_LIGHTING,
      { color: 'blue' },
      'Farbe: "blue" ist keine Farbe. Verwende eine Hex-Farbe wie #FF8000.',
    ],
    [
      'show_custom_page "4"',
      FLOW_ACTION_SHOW_CUSTOM_PAGE,
      { page: '4' },
      'Seite: "4" ist keine gültige Auswahl. Erlaubt sind: 1, 2, 3.',
    ],
    [
      'set_channel "cloud"',
      FLOW_ACTION_SET_CHANNEL,
      { channel: 'cloud' },
      'Modus: "cloud" ist keine gültige Auswahl. Erlaubt sind: clock, lighting, custom, noise_meter.',
    ],
    [
      'show_notification_icon "nope"',
      FLOW_ACTION_SHOW_NOTIFICATION_ICON,
      { icon: 'nope' },
      expect.stringMatching(
        /^Symbol: "nope" ist keine gültige Auswahl\. Erlaubt sind: kakaotalk, instagram, .*, tamtam\.$/,
      ),
    ],
  ];

  it.each(cases)('%s gives the German message and sends nothing', async (_name, card, args, message) => {
    const { actions } = register();
    calls.length = 0;
    const run = actions.get(card)!;
    await expect(Promise.resolve().then(() => run({ device, ...args }))).rejects.toThrow(
      expect.objectContaining({ message, name: 'Error' }),
    );
    expect(calls).toEqual([]);
  });

  it('the condition channel_is "cloud" gives the German message', async () => {
    const { listeners } = register();
    const run = listeners.get(FLOW_CONDITION_CHANNEL_IS)!;
    await expect(Promise.resolve().then(() => run({ device, channel: 'cloud' }))).rejects.toThrow(
      'Modus: "cloud" ist keine gültige Auswahl. Erlaubt sind: clock, lighting, custom, noise_meter.',
    );
  });

  it('a long invalid value is cut in the message', async () => {
    const { actions } = register();
    const run = actions.get(FLOW_ACTION_SET_LIGHTING)!;
    await expect(Promise.resolve().then(() => run({ device, color: 'x'.repeat(50) }))).rejects.toThrow(
      `Farbe: "${'x'.repeat(32)}…" ist keine Farbe.`,
    );
  });

  it('passes another device error through unchanged', async () => {
    const { actions } = register();
    const failure = new Error('x');
    const run = actions.get(FLOW_ACTION_SET_CHANNEL)!;
    await expect(
      run({
        device: {
          switchChannel: async () => {
            throw failure;
          },
        },
        channel: 'clock',
      }),
    ).rejects.toBe(failure);
  });

  it('localises an ArgumentError thrown inside the device', async () => {
    const { actions } = register();
    const run = actions.get(FLOW_ACTION_SHOW_TEXT)!;
    await expect(
      run({
        device: {
          showText: async () => {
            prepareText(42); // as the controller does for a non-string text
          },
        },
        ...goodText,
      }),
    ).rejects.toThrow('Text muss ein Text sein.');
  });
});
