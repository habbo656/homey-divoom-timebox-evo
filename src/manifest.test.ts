import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARGUMENT_ERROR_KINDS, ARGUMENT_FIELDS } from './device/argumentError';
import { IMAGE_FIT_IDS } from './device/image';
import { IMAGE_ERROR_KINDS } from './device/imageError';
import { NOTIFICATION_ICON_IDS } from './device/notification';
import type { ArgumentField } from './device/argumentError';
import { TEXT_SPEED_IDS } from './device/scrollText';
import { COUNTDOWN_MAX_MINUTES } from './protocol/commands';
import { TEMPERATURE_RANGE, WEATHER_CONDITION_IDS, WEATHER_INTERVAL_IDS } from './device/weather';
import { FLOW_TRIGGER_COUNTDOWN_ENDED, registerTimeboxFlowCards } from './flow';
import type { FlowLike } from './flow';

// The Homey Compose files of the driver are the manifest source: the settings the user sees and the Flow cards that exist.
const driverDir = join(__dirname, '..', 'drivers', 'timebox');
const readJson = <T>(file: string): T => JSON.parse(readFileSync(join(driverDir, file), 'utf8')) as T;

interface SettingNode {
  id?: string;
  type: string;
  children?: SettingNode[];
}
interface CardNode {
  id: string;
}
interface FlowCompose {
  triggers: CardNode[];
  conditions: CardNode[];
  actions: CardNode[];
}

const settingIds = (nodes: SettingNode[]): string[] =>
  nodes.flatMap((n) => (n.type === 'group' ? settingIds(n.children ?? []) : n.id ? [n.id] : []));

describe('driver manifest (#70)', () => {
  const flowCompose = readJson<FlowCompose>('driver.flow.compose.json');

  it('offers exactly the remaining settings', () => {
    const settings = readJson<SettingNode[]>('driver.settings.compose.json');
    expect(settingIds(settings)).toEqual([
      'clock_style',
      'clock_weather',
      'clock_temperature',
      'clock_calendar',
      'clock_animations',
      'time_sync',
      'weather_auto',
      'weather_interval',
    ]);
    expect(settings.every((n) => n.type === 'group')).toBe(true);
    expect(settings).toHaveLength(2); // Clock, Weather: no "Advanced" group, no "Light" group (#19)
    expect(settings.map((g) => (g as unknown as { label: { en: string } }).label.en)).toEqual(['Clock', 'Weather']);
  });

  it('is always a light: the driver class is light and there is no "Use as a light" setting (#19)', () => {
    expect(readJson<{ class: string }>('driver.compose.json').class).toBe('light');
    const built = JSON.parse(readFileSync(join(__dirname, '..', 'app.json'), 'utf8')) as {
      drivers: { class: string; settings: SettingNode[] }[];
    };
    expect(built.drivers[0].class).toBe('light');
    expect(settingIds(built.drivers[0].settings)).not.toContain('use_as_light');
    for (const lang of ['en', 'de']) {
      const text = readFileSync(join(__dirname, '..', 'locales', `${lang}.json`), 'utf8');
      expect(text, lang).not.toContain('class_not_changed');
    }
  });

  it('declares every card the app registers a listener for', () => {
    const registered: { kind: 'condition' | 'action'; id: string }[] = [];
    const flow: FlowLike = {
      getConditionCard: (id) => ({ registerRunListener: () => void registered.push({ kind: 'condition', id }) }),
      getActionCard: (id) => ({ registerRunListener: () => void registered.push({ kind: 'action', id }) }),
    };
    registerTimeboxFlowCards(flow, (key) => key);
    expect(registered.length).toBeGreaterThan(0);
    const declared = {
      condition: flowCompose.conditions.map((c) => c.id),
      action: flowCompose.actions.map((c) => c.id),
    };
    for (const { kind, id } of registered) expect(declared[kind], `${kind} ${id}`).toContain(id);
  });

  it('offers the noise meter in the mode picker and both mode dropdowns with English and German labels (#3)', () => {
    type Value = { id: string; title?: Record<string, string>; label?: Record<string, string> };
    const capability = JSON.parse(
      readFileSync(join(__dirname, '..', '.homeycompose', 'capabilities', 'timebox_channel.json'), 'utf8'),
    ) as { values: Value[] };
    const flow = readJson<{
      conditions: { args?: { values?: Value[] }[] }[];
      actions: { args?: { values?: Value[] }[] }[];
    }>('driver.flow.compose.json');
    const dropdowns = [...flow.conditions, ...flow.actions]
      .flatMap((card) => card.args ?? [])
      .flatMap((arg) => arg.values ?? [])
      .filter((value) => value.id === 'noise_meter');
    expect(dropdowns).toHaveLength(2);
    for (const value of [...dropdowns, capability.values.find((v) => v.id === 'noise_meter')]) {
      expect(value?.label ?? value?.title).toEqual({ en: 'Noise meter', de: 'Lärmmesser' });
    }
  });

  it('declares the "Countdown ended" trigger without tokens, in English and German (#101)', () => {
    const triggers = readJson<{
      triggers: { id: string; title: Record<string, string>; hint?: Record<string, string>; tokens?: unknown[] }[];
    }>('driver.flow.compose.json').triggers;
    const ended = triggers.find((t) => t.id === FLOW_TRIGGER_COUNTDOWN_ENDED);
    expect(ended).toBeDefined();
    expect(ended!.id).toBe('timebox_countdown_ended');
    expect(ended!.title.en).toBe('Countdown ended');
    expect(ended!.title.de).toBe('Countdown abgelaufen');
    expect(ended!.hint!.en).toBeTruthy();
    expect(ended!.hint!.de).toBeTruthy();
    expect(ended!.tokens ?? []).toEqual([]);
  });

  it('has no "Sync time now" card', () => {
    const ids = [...flowCompose.triggers, ...flowCompose.conditions, ...flowCompose.actions].map((c) => c.id);
    expect(ids).not.toContain('timebox_sync_time');
  });
});

// The native text cards (#28): the compose files are what the user sees, so they are checked against the code.
describe('native text Flow cards (#28)', () => {
  interface Arg {
    type: string;
    name: string;
    min?: number;
    max?: number;
    required?: boolean;
    values?: { id: string; label: Record<string, string> }[];
  }
  interface ActionNode {
    id: string;
    title: Record<string, string>;
    titleFormatted?: Record<string, string>;
    hint?: Record<string, string>;
    args?: Arg[];
  }
  const actions = readJson<{ actions: ActionNode[] }>('driver.flow.compose.json').actions;
  const show = actions.find((a) => a.id === 'timebox_show_text');
  const stop = actions.find((a) => a.id === 'timebox_stop_text');

  it('declares Show text with text, two colours, the speed dropdown and a 0..3600 s duration', () => {
    expect(show).toBeDefined();
    expect(show!.args!.map((a) => [a.name, a.type])).toEqual([
      ['text', 'text'],
      ['color', 'color'],
      ['background', 'color'],
      ['speed', 'dropdown'],
      ['duration', 'number'],
    ]);
    const duration = show!.args!.find((a) => a.name === 'duration')!;
    expect([duration.min, duration.max]).toEqual([0, 3600]);
    expect(duration.required).toBe(false); // a blank field means 0 (until stopped)
    expect(show!.args!.find((a) => a.name === 'speed')!.values!.map((v) => v.id)).toEqual([...TEXT_SPEED_IDS]);
  });

  it('states the 64 character limit in the hint and no longer says that texts are cut (#107)', () => {
    const hint = show!.hint;
    for (const lang of ['en', 'de']) {
      expect(hint![lang], lang).toContain('64');
      expect(hint![lang], lang).not.toMatch(/cut|gekürzt/);
    }
  });

  it('declares Stop text without arguments', () => {
    expect(stop).toBeDefined();
    expect(stop!.args ?? []).toEqual([]);
  });

  it('titles every part in English and German, and the formatted title uses every argument', () => {
    for (const card of [show!, stop!]) {
      expect(card.title.en, card.id).toBeTruthy();
      expect(card.title.de, card.id).toBeTruthy();
    }
    for (const lang of ['en', 'de']) {
      for (const arg of show!.args!)
        expect(show!.titleFormatted![lang], `${lang} ${arg.name}`).toContain(`[[${arg.name}]]`);
    }
    for (const arg of show!.args!.filter((a) => a.type === 'dropdown')) {
      for (const value of arg.values!) {
        expect(value.label.en).toBeTruthy();
        expect(value.label.de).toBeTruthy();
      }
    }
  });

  it('has the localised empty-text error in both languages', () => {
    for (const lang of ['en', 'de']) {
      const locale = JSON.parse(readFileSync(join(__dirname, '..', 'locales', `${lang}.json`), 'utf8')) as {
        device: { error: Record<string, string> };
      };
      expect(locale.device.error.text_empty, lang).toBeTruthy();
    }
  });
});

// The weather card and settings (#30): the compose files are checked against the code and the manifest.
describe('weather (#30)', () => {
  interface Arg {
    type: string;
    name: string;
    min?: number;
    max?: number;
    values?: { id: string; label: Record<string, string> }[];
  }
  interface ActionNode {
    id: string;
    title: Record<string, string>;
    titleFormatted?: Record<string, string>;
    hint?: Record<string, string>;
    args?: Arg[];
  }
  interface SettingLeaf extends SettingNode {
    label?: Record<string, string>;
    hint?: Record<string, string>;
    value?: unknown;
    values?: { id: string; label: Record<string, string> }[];
  }
  const actions = readJson<{ actions: ActionNode[] }>('driver.flow.compose.json').actions;
  const card = actions.find((a) => a.id === 'timebox_set_weather');
  const temperatureCard = actions.find((a) => a.id === 'timebox_set_temperature');
  const leaves = (nodes: SettingLeaf[]): SettingLeaf[] =>
    nodes.flatMap((n) => (n.type === 'group' ? leaves(n.children ?? []) : [n]));
  const setting = (id: string): SettingLeaf => {
    const found = leaves(readJson<SettingLeaf[]>('driver.settings.compose.json')).find((s) => s.id === id);
    expect(found, id).toBeDefined();
    return found!;
  };

  it('declares Set temperature with the temperature number only', () => {
    expect(temperatureCard).toBeDefined();
    expect(temperatureCard!.args!.map((a) => [a.name, a.type])).toEqual([['temperature', 'number']]);
    const temperature = temperatureCard!.args![0];
    expect([temperature.min, temperature.max]).toEqual([TEMPERATURE_RANGE.min, TEMPERATURE_RANGE.max]);
  });

  it('declares Set weather with the condition dropdown only', () => {
    expect(card).toBeDefined();
    expect(card!.args!.map((a) => [a.name, a.type])).toEqual([['condition', 'dropdown']]);
    expect(card!.args![0].values!.map((v) => v.id)).toEqual([...WEATHER_CONDITION_IDS]);
  });

  it('is available in English and German, with every argument in the formatted title', () => {
    for (const lang of ['en', 'de']) {
      for (const c of [card!, temperatureCard!]) {
        expect(c.title[lang], `${c.id} ${lang}`).toBeTruthy();
        expect(c.hint![lang], `${c.id} ${lang}`).toBeTruthy();
        for (const arg of c.args!) {
          expect(c.titleFormatted![lang], `${c.id} ${lang} ${arg.name}`).toContain(`[[${arg.name}]]`);
        }
      }
      expect(card!.title[lang]).not.toBe(temperatureCard!.title[lang]);
    }
    expect(card!.title).toEqual({ en: 'Set weather', de: 'Wetter setzen' });
    expect(temperatureCard!.title).toEqual({ en: 'Set temperature', de: 'Temperatur setzen' });
    for (const value of card!.args!.find((a) => a.name === 'condition')!.values!) {
      expect(value.label.en).toBeTruthy();
      expect(value.label.de).toBeTruthy();
    }
  });

  it('explains in the hints which clock page shows the value and that Open-Meteo overwrites it', () => {
    expect(card!.hint!.en).toContain('"Show weather"');
    expect(card!.hint!.en).toContain('"Show temperature"'); // turn it off if the temperature is not set
    expect(temperatureCard!.hint!.en).toContain('"Show temperature"');
    expect(temperatureCard!.hint!.en).toContain('"Show weather"');
    expect(card!.hint!.de).toContain('„Wetter anzeigen“');
    expect(temperatureCard!.hint!.de).toContain('„Temperatur anzeigen“');
    for (const c of [card!, temperatureCard!]) {
      for (const lang of ['en', 'de']) expect(c.hint![lang], `${c.id} ${lang}`).toContain('Open-Meteo');
    }
  });

  it('has the automatic weather off by default and the interval ids of the code', () => {
    const auto = setting('weather_auto');
    expect(auto.type).toBe('checkbox');
    expect(auto.value).toBe(false);
    const interval = setting('weather_interval');
    expect(interval.type).toBe('dropdown');
    expect(interval.value).toBe('30');
    expect(interval.values!.map((v) => v.id)).toEqual([...WEATHER_INTERVAL_IDS]);
    for (const s of [auto, interval, ...interval.values!]) {
      const label = s.label as Record<string, string>;
      expect(label.en).toBeTruthy();
      expect(label.de).toBeTruthy();
    }
    expect(auto.hint!.en).toContain('Open-Meteo.com (CC BY 4.0)');
    expect(auto.hint!.de).toContain('Open-Meteo.com (CC BY 4.0)');
  });

  it('offers "Show animation pages" after the calendar: a checkbox, off by default, in the Clock group (#106)', () => {
    const settings = readJson<SettingNode[]>('driver.settings.compose.json');
    const clockGroup = settings[0].children ?? [];
    const ids = settingIds(clockGroup);
    expect(ids.indexOf('clock_animations')).toBe(ids.indexOf('clock_calendar') + 1);
    const animations = setting('clock_animations') as unknown as { type: string; value: boolean };
    expect(animations.type).toBe('checkbox');
    expect(animations.value).toBe(false);
    const label = setting('clock_animations').label as { en: string; de: string };
    expect(label).toEqual({ en: 'Show animation pages', de: 'Animationsseiten zeigen' });
    const hint = setting('clock_animations').hint!;
    expect(hint.en).toContain('Gallery pictures');
    expect(hint.de).toContain('Galeriebilder');
  });

  it('tells where the clock weather comes from', () => {
    const hint = setting('clock_weather').hint!;
    expect(hint.en).toMatch(/Set weather.*Open-Meteo/);
    expect(hint.de).toMatch(/Wetter setzen.*Open-Meteo/);
  });

  it('tells where the clock temperature comes from', () => {
    const hint = setting('clock_temperature').hint!;
    expect(hint.en).toMatch(/Set temperature.*Open-Meteo/);
    expect(hint.de).toMatch(/Temperatur setzen.*Open-Meteo/);
  });

  it('declares the geolocation permission in the compose file and the built manifest', () => {
    for (const file of ['.homeycompose/app.json', 'app.json']) {
      const manifest = JSON.parse(readFileSync(join(__dirname, '..', file), 'utf8')) as { permissions: string[] };
      expect(manifest.permissions, file).toContain('homey:manager:geolocation');
      expect(manifest.permissions, file).toContain('homey:wireless:ble');
    }
  });

  it('is part of the built manifest', () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'app.json'), 'utf8')) as {
      drivers: { settings: SettingLeaf[] }[];
      flow: { actions: ActionNode[] };
    };
    expect(manifest.flow.actions.map((a) => a.id)).toEqual(
      expect.arrayContaining(['timebox_set_weather', 'timebox_set_temperature']),
    );
    const built = (id: string) => manifest.flow.actions.find((a) => a.id === id)!;
    expect(built('timebox_set_weather').args!.map((a) => a.name)).toEqual(['device', 'condition']);
    expect(built('timebox_set_temperature').args!.map((a) => a.name)).toEqual(['device', 'temperature']);
    expect(leaves(manifest.drivers[0].settings).map((s) => s.id)).toEqual(
      expect.arrayContaining(['weather_auto', 'weather_interval']),
    );
  });
});

describe('countdown cards (#33)', () => {
  interface Arg {
    type: string;
    name: string;
    min?: number;
    max?: number;
    step?: number;
  }
  interface ActionNode {
    id: string;
    title: Record<string, string>;
    titleFormatted?: Record<string, string>;
    hint?: Record<string, string>;
    args?: Arg[];
  }
  const actions = readJson<{ actions: ActionNode[] }>('driver.flow.compose.json').actions;
  const start = actions.find((a) => a.id === 'timebox_start_countdown');
  const stop = actions.find((a) => a.id === 'timebox_stop_countdown');

  it('declares Start countdown with whole minutes 0..99 and seconds 0..59', () => {
    expect(start).toBeDefined();
    expect(start!.args!.map((a) => [a.name, a.type])).toEqual([
      ['minutes', 'number'],
      ['seconds', 'number'],
    ]);
    const [minutes, seconds] = start!.args!;
    expect([minutes.min, minutes.max, minutes.step]).toEqual([0, COUNTDOWN_MAX_MINUTES, 1]);
    expect([seconds.min, seconds.max, seconds.step]).toEqual([0, 59, 1]);
  });

  it('declares Stop countdown without arguments', () => {
    expect(stop).toBeDefined();
    expect(stop!.args ?? []).toEqual([]);
  });

  it('titles both cards in English and German and uses both arguments in the formatted title', () => {
    expect(start!.title).toEqual({ en: 'Start countdown', de: 'Countdown starten' });
    expect(stop!.title).toEqual({ en: 'Stop countdown', de: 'Countdown beenden' });
    for (const lang of ['en', 'de']) {
      expect(start!.titleFormatted![lang]).toContain('[[minutes]]');
      expect(start!.titleFormatted![lang]).toContain('[[seconds]]');
      expect(start!.hint![lang]).toBeTruthy();
      expect(stop!.hint![lang]).toBeTruthy();
    }
  });

  it('tells in the hints what hides and what ends the countdown', () => {
    expect(start!.hint!.en).toContain('keeps running');
    expect(stop!.hint!.en).toContain('cannot be stopped');
    expect(stop!.hint!.de).toContain('lässt sich nicht beenden');
  });

  it('has the localised zero-countdown error', () => {
    for (const lang of ['en', 'de']) {
      const locale = JSON.parse(readFileSync(join(__dirname, '..', 'locales', `${lang}.json`), 'utf8')) as {
        device: { error: Record<string, string> };
      };
      expect(locale.device.error.countdown_zero, lang).toBeTruthy();
    }
  });

  it('is part of the built manifest', () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'app.json'), 'utf8')) as {
      flow: { actions: ActionNode[] };
    };
    const built = (id: string) => manifest.flow.actions.find((a) => a.id === id)!;
    expect(built('timebox_start_countdown').args!.map((a) => a.name)).toEqual(['device', 'minutes', 'seconds']);
    expect(built('timebox_stop_countdown').args!.map((a) => a.name)).toEqual(['device']);
  });
});

describe('Show notification icon card (#5)', () => {
  interface Value {
    id: string;
    label: Record<string, string>;
  }
  interface ActionNode {
    id: string;
    title: Record<string, string>;
    titleFormatted?: Record<string, string>;
    hint?: Record<string, string>;
    args?: { type: string; name: string; title?: Record<string, string>; values?: Value[] }[];
  }
  const actions = readJson<{ actions: ActionNode[] }>('driver.flow.compose.json').actions;
  const card = actions.find((a) => a.id === 'timebox_show_notification_icon');

  it('declares the icon dropdown with the 24 ids of the code, in code order', () => {
    expect(card).toBeDefined();
    expect(card!.args!.map((a) => [a.name, a.type])).toEqual([['icon', 'dropdown']]);
    const values = card!.args![0].values!;
    expect(values).toHaveLength(24);
    expect(values.map((v) => v.id)).toEqual(NOTIFICATION_ICON_IDS);
  });

  it('labels every icon in English and German; brand names stay, the generic ones are translated', () => {
    const values = card!.args![0].values!;
    for (const value of values) {
      expect(value.label.en, value.id).toBeTruthy();
      expect(value.label.de, value.id).toBeTruthy();
    }
    const label = (id: string) => values.find((v) => v.id === id)!.label;
    expect(label('telegram')).toEqual({ en: 'Telegram', de: 'Telegram' });
    expect(label('sms')).toEqual({ en: 'SMS', de: 'SMS' });
    expect(label('incoming_call')).toEqual({ en: 'Incoming call', de: 'Eingehender Anruf' });
    expect(label('missed_call')).toEqual({ en: 'Missed call', de: 'Verpasster Anruf' });
  });

  it('has the title, the formatted title with [[icon]] and the hint in English and German', () => {
    expect(card!.title).toEqual({ en: 'Show notification icon', de: 'Benachrichtigungssymbol anzeigen' });
    for (const lang of ['en', 'de']) {
      expect(card!.titleFormatted![lang]).toContain('[[icon]]');
      expect(card!.hint![lang]).toBeTruthy();
    }
    expect(card!.hint!.en).toContain('about 2 seconds');
    expect(card!.hint!.en).toContain('previous view returns');
    expect(card!.hint!.de).toContain('etwa 2 Sekunden');
  });

  it('is part of the built manifest', () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'app.json'), 'utf8')) as {
      flow: { actions: ActionNode[] };
    };
    const built = manifest.flow.actions.find((a) => a.id === 'timebox_show_notification_icon')!;
    expect(built.args!.map((a) => a.name)).toEqual(['device', 'icon']);
    expect(built.args![1].values!.map((v) => v.id)).toEqual(NOTIFICATION_ICON_IDS);
  });
});

// Settings and Flow cards removed in #70 must not survive in any text the user can see (hints, titles, locales, manifest).
describe('user-visible text (#78)', () => {
  const root = join(__dirname, '..');
  const capabilityDir = join(root, '.homeycompose', 'capabilities');
  const files = [
    'drivers/timebox/driver.compose.json',
    'drivers/timebox/driver.settings.compose.json',
    'drivers/timebox/driver.flow.compose.json',
    '.homeycompose/app.json',
    ...readdirSync(capabilityDir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => `.homeycompose/capabilities/${f}`),
    'locales/en.json',
    'locales/de.json',
    'app.json',
  ];
  const forbidden: RegExp[] = [
    /12\s*\/\s*24/,
    /24[- ]hour/i,
    /\b(12|24)[- ]Stunden/i,
    /clock_24h/,
    /poll_interval/,
    /status check interval/i,
    /Intervall der Statusabfrage/,
    /Sync time now/i,
    /Uhrzeit jetzt synchronisieren/,
    /timebox_sync_time/,
  ];

  it.each(files)('%s mentions no removed setting or card', (file) => {
    const text = readFileSync(join(root, file), 'utf8');
    for (const pattern of forbidden) {
      expect(pattern.test(text), `${file} matches ${String(pattern)}`).toBe(false);
    }
  });
});

describe('locales and argument errors (#108)', () => {
  type Tree = { [key: string]: string | Tree };
  const readLocale = (language: string): Tree =>
    JSON.parse(readFileSync(join(__dirname, '..', 'locales', `${language}.json`), 'utf8')) as Tree;
  const locales = { en: readLocale('en'), de: readLocale('de') };

  const leaves = (node: Tree, prefix = ''): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string') out.set(`${prefix}${key}`, value);
      else for (const [k, v] of leaves(value, `${prefix}${key}.`)) out.set(k, v);
    }
    return out;
  };
  const strings = { en: leaves(locales.en), de: leaves(locales.de) };
  const tokens = (text: string): string[] => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

  it('has the same keys in en and de', () => {
    expect([...strings.de.keys()].sort()).toEqual([...strings.en.keys()].sort());
  });

  it('has the same {tokens} in en and de for every key', () => {
    for (const [key, en] of strings.en) expect(tokens(strings.de.get(key) ?? ''), key).toEqual(tokens(en));
  });

  it('has a non-empty text for every argument error kind and field, in en and de', () => {
    for (const language of ['en', 'de'] as const) {
      for (const kind of ARGUMENT_ERROR_KINDS) {
        expect(strings[language].get(`device.error.${kind}`)?.trim(), `${language} ${kind}`).toBeTruthy();
      }
      for (const field of ARGUMENT_FIELDS) {
        expect(strings[language].get(`device.field.${field}`)?.trim(), `${language} ${field}`).toBeTruthy();
      }
    }
  });

  it('has only {field} and the params the kind provides in the error texts', () => {
    const allowed: Record<string, string[]> = {
      invalid_range: ['field', 'max', 'min', 'value'],
      invalid_number: ['field', 'value'],
      invalid_choice: ['allowed', 'field', 'value'],
      invalid_color: ['field', 'value'],
      invalid_text: ['field'],
      invalid_url: ['field', 'max', 'value'],
    };
    for (const kind of ARGUMENT_ERROR_KINDS) {
      expect(tokens(strings.en.get(`device.error.${kind}`) ?? ''), kind).toEqual(allowed[kind]);
    }
  });

  // The field label is the title of the card argument the user sees, so the message names what they filled in.
  const fieldOfArgument: Record<string, ArgumentField> = {
    'timebox_set_channel.channel': 'channel',
    'timebox_channel_is.channel': 'channel',
    'timebox_show_clock.style': 'style',
    'timebox_show_clock.color': 'color',
    'timebox_set_lighting.color': 'color',
    'timebox_show_custom_page.page': 'page',
    'timebox_show_text.text': 'text',
    'timebox_show_text.color': 'text_color',
    'timebox_show_text.background': 'background',
    'timebox_show_text.speed': 'speed',
    'timebox_show_text.duration': 'duration',
    'timebox_show_image.fit': 'fit',
    'timebox_show_image.duration': 'duration',
    'timebox_show_image_url.url': 'url',
    'timebox_show_image_url.fit': 'fit',
    'timebox_show_image_url.duration': 'duration',
    'timebox_start_countdown.minutes': 'minutes',
    'timebox_start_countdown.seconds': 'seconds',
    'timebox_set_temperature.temperature': 'temperature',
    'timebox_set_weather.condition': 'condition',
    'timebox_show_notification_icon.icon': 'icon',
  };

  it('labels every field like the card argument title (en, de)', () => {
    const compose = readJson<{
      conditions: { id: string; args?: { name: string; title?: Record<string, string> }[] }[];
      actions: { id: string; args?: { name: string; title?: Record<string, string> }[] }[];
    }>('driver.flow.compose.json');
    const seen: string[] = [];
    for (const card of [...compose.conditions, ...compose.actions]) {
      for (const arg of card.args ?? []) {
        if (arg.name === 'device') continue;
        const key = `${card.id}.${arg.name}`;
        const field = fieldOfArgument[key];
        expect(field, `no field for argument ${key}`).toBeDefined();
        seen.push(key);
        for (const language of ['en', 'de'] as const) {
          expect(strings[language].get(`device.field.${field}`), `${key} ${language}`).toBe(arg.title?.[language]);
        }
      }
    }
    expect(seen.sort()).toEqual(Object.keys(fieldOfArgument).sort());
  });
});

describe('Show image actions (#31)', () => {
  interface Arg {
    name: string;
    type: string;
    min?: number;
    max?: number;
    required?: boolean;
    values?: { id: string; label: Record<string, string> }[];
  }
  interface ActionNode {
    id: string;
    title: Record<string, string>;
    titleFormatted?: Record<string, string>;
    hint?: Record<string, string>;
    droptoken?: string[];
    args?: Arg[];
  }
  const actions = readJson<{ actions: ActionNode[] }>('driver.flow.compose.json').actions;
  const token = actions.find((a) => a.id === 'timebox_show_image')!;
  const url = actions.find((a) => a.id === 'timebox_show_image_url')!;

  it('declares Show image with an image droptoken, the fit dropdown and a 0..3600 s duration', () => {
    expect(token.droptoken).toEqual(['image']);
    expect(token.args!.map((a) => [a.name, a.type])).toEqual([
      ['fit', 'dropdown'],
      ['duration', 'number'],
    ]);
  });

  it('declares Show image from URL with a text URL, the fit dropdown and the duration', () => {
    expect(url.droptoken).toBeUndefined();
    expect(url.args!.map((a) => [a.name, a.type])).toEqual([
      ['url', 'text'],
      ['fit', 'dropdown'],
      ['duration', 'number'],
    ]);
  });

  it.each([token, url])('$id: fit is cover first (the default) then contain, duration is optional 0..3600', (card) => {
    const fit = card.args!.find((a) => a.name === 'fit')!;
    expect(fit.values!.map((v) => v.id)).toEqual([...IMAGE_FIT_IDS]);
    expect(fit.values![0].id).toBe('cover');
    const duration = card.args!.find((a) => a.name === 'duration')!;
    expect([duration.min, duration.max, duration.required]).toEqual([0, 3600, false]);
  });

  it('titles, hints and labels exist in English and German, and the formatted title uses every argument', () => {
    for (const card of [token, url]) {
      for (const lang of ['en', 'de']) {
        expect(card.title[lang], `${card.id} ${lang}`).toBeTruthy();
        for (const arg of card.args!)
          expect(card.titleFormatted![lang], `${card.id} ${arg.name}`).toContain(`[[${arg.name}]]`);
        for (const v of card.args!.find((a) => a.name === 'fit')!.values!) expect(v.label[lang]).toBeTruthy();
        const hint = card.hint![lang];
        for (const part of ['PNG', 'JPEG', 'GIF', '5 MB', '16x16'])
          expect(hint, `${card.id} ${lang} ${part}`).toContain(part);
      }
    }
    expect(token.titleFormatted!.en).toContain('[[droptoken]]');
    expect(token.titleFormatted!.de).toContain('[[droptoken]]');
  });

  it('is part of the built manifest', () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'app.json'), 'utf8')) as {
      flow: { actions: ActionNode[] };
    };
    const built = (id: string) => manifest.flow.actions.find((a) => a.id === id)!;
    expect(built('timebox_show_image').args!.map((a) => a.name)).toEqual(['device', 'fit', 'duration']);
    expect(built('timebox_show_image').droptoken).toEqual(['image']);
    expect(built('timebox_show_image_url').args!.map((a) => a.name)).toEqual(['device', 'url', 'fit', 'duration']);
  });

  it('has a localised text for every image error kind with the tokens of its limits', () => {
    for (const lang of ['en', 'de']) {
      const locale = JSON.parse(readFileSync(join(__dirname, '..', 'locales', `${lang}.json`), 'utf8')) as {
        device: { error: Record<string, string> };
      };
      for (const kind of IMAGE_ERROR_KINDS)
        expect(locale.device.error[`image_${kind}`], `${lang} ${kind}`).toBeTruthy();
      expect(locale.device.error.image_too_large).toContain('{max_mb}');
      expect(locale.device.error.image_too_large).toContain('{max_mp}');
      expect(locale.device.error.image_too_large).toContain('{max_side}');
    }
  });
});

// Store readiness (#37): everything a user can read in the manifest and the pairing views exists in English and German.
describe('store i18n (#37)', () => {
  type Text = Record<string, string> | undefined;
  interface I18nArg {
    type: string;
    name: string;
    title?: Text;
    placeholder?: Text;
    values?: { id: string; label?: Text }[];
  }
  interface I18nToken {
    name: string;
    title?: Text;
    example?: Text;
  }
  interface I18nCard {
    id: string;
    title?: Text;
    titleFormatted?: Text;
    hint?: Text;
    args?: I18nArg[];
    droptoken?: string[];
    tokens?: I18nToken[];
  }
  interface I18nSetting {
    id?: string;
    type: string;
    label?: Text;
    hint?: Text;
    values?: { id: string; label?: Text }[];
    children?: I18nSetting[];
  }
  interface I18nCapability {
    title?: Text;
    values?: { id: string; title?: Text }[];
  }

  const LOCALES = ['en', 'de'] as const;
  const root = join(__dirname, '..');
  const flow = readJson<{ triggers: I18nCard[]; conditions: I18nCard[]; actions: I18nCard[] }>(
    'driver.flow.compose.json',
  );
  const cards = [...flow.triggers, ...flow.conditions, ...flow.actions];
  // The "device" argument is the driver filter; Homey renders it itself.
  const userArgs = (card: I18nCard): I18nArg[] => (card.args ?? []).filter((a) => a.type !== 'device');

  /** The problems of a localised text: one entry per locale where it is missing or blank. */
  const missing = (what: string, text: Text): string[] =>
    LOCALES.filter((l) => typeof text?.[l] !== 'string' || text[l].trim() === '').map((l) => `${what} (${l})`);

  it('finds the cards, so the checks below are not vacuous', () => {
    expect(cards.length).toBeGreaterThanOrEqual(18);
  });

  it('gives every Flow card a title and a hint', () => {
    const problems = cards.flatMap((c) => [...missing(`${c.id} title`, c.title), ...missing(`${c.id} hint`, c.hint)]);
    expect(problems).toEqual([]);
  });

  it('gives every card with arguments or a droptoken a titleFormatted with every placeholder', () => {
    const problems: string[] = [];
    for (const card of cards) {
      const names = userArgs(card).map((a) => a.name);
      const hasDroptoken = (card.droptoken ?? []).length > 0;
      if (names.length === 0 && !hasDroptoken) continue;
      problems.push(...missing(`${card.id} titleFormatted`, card.titleFormatted));
      for (const locale of LOCALES) {
        const formatted = card.titleFormatted?.[locale] ?? '';
        const expected = [...names, ...(hasDroptoken ? ['droptoken'] : [])];
        for (const name of expected) {
          if (!formatted.includes(`[[${name}]]`))
            problems.push(`${card.id} titleFormatted (${locale}) lacks [[${name}]]`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('gives every argument a title, every dropdown value a label and every text or number argument a placeholder', () => {
    const problems: string[] = [];
    for (const card of cards) {
      for (const arg of userArgs(card)) {
        problems.push(...missing(`${card.id}.${arg.name} title`, arg.title));
        if (arg.type === 'text' || arg.type === 'number') {
          problems.push(...missing(`${card.id}.${arg.name} placeholder`, arg.placeholder));
        }
        if (arg.type === 'dropdown') {
          expect((arg.values ?? []).length, `${card.id}.${arg.name} values`).toBeGreaterThan(0);
          for (const value of arg.values ?? []) {
            problems.push(...missing(`${card.id}.${arg.name}=${value.id} label`, value.label));
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('gives every trigger token a title and an example', () => {
    const problems = cards.flatMap((c) =>
      (c.tokens ?? []).flatMap((t) => [
        ...missing(`${c.id}.${t.name} token title`, t.title),
        ...missing(`${c.id}.${t.name} token example`, t.example),
      ]),
    );
    expect(problems).toEqual([]);
  });

  it('gives every settings group, setting, hint and dropdown value a text', () => {
    const settings = readJson<I18nSetting[]>('driver.settings.compose.json');
    const problems: string[] = [];
    const walk = (nodes: I18nSetting[]): void => {
      for (const node of nodes) {
        if (node.type === 'group') {
          problems.push(...missing(`group ${node.label?.en ?? '?'} label`, node.label));
          walk(node.children ?? []);
          continue;
        }
        problems.push(...missing(`${node.id} label`, node.label), ...missing(`${node.id} hint`, node.hint));
        for (const value of node.values ?? []) problems.push(...missing(`${node.id}=${value.id} label`, value.label));
      }
    };
    walk(settings);
    expect(problems).toEqual([]);
    expect(settingIds(settings).length).toBeGreaterThan(0);
  });

  it('gives every custom capability and enum value a title', () => {
    const dir = join(root, '.homeycompose', 'capabilities');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const file of files) {
      const capability = JSON.parse(readFileSync(join(dir, file), 'utf8')) as I18nCapability;
      problems.push(...missing(`${file} title`, capability.title));
      for (const value of capability.values ?? []) problems.push(...missing(`${file}=${value.id} title`, value.title));
    }
    expect(problems).toEqual([]);
  });

  it('tells the user what to do when the search or adding fails, and keeps the cause (#36)', () => {
    const guidance = {
      en: { scan_failed: [/Bluetooth/, /search again/], add_failed: [/Divoom app/, /try again/] },
      de: { scan_failed: [/Bluetooth/, /suche dann erneut/], add_failed: [/Divoom-App/, /versuche es erneut/] },
    } as const;
    for (const locale of LOCALES) {
      const strings = JSON.parse(readFileSync(join(root, 'locales', `${locale}.json`), 'utf8')) as {
        pair: { scan: Record<string, string> };
      };
      for (const key of ['scan_failed', 'add_failed'] as const) {
        const text = strings.pair.scan[key];
        expect(text, `${key} (${locale})`).toContain('{error}');
        expect(text, `${key} (${locale}) has a TimeBox hint`).toMatch(/TimeBox/);
        for (const pattern of guidance[locale as 'en' | 'de'][key]) expect(text, `${key} (${locale})`).toMatch(pattern);
      }
    }
  });

  it('has every pairing view string in locales/en.json and locales/de.json', () => {
    const pairDir = join(root, 'drivers', 'timebox', 'pair');
    const keys = new Set<string>();
    for (const file of readdirSync(pairDir).filter((f) => f.endsWith('.html'))) {
      const html = readFileSync(join(pairDir, file), 'utf8');
      for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) keys.add(m[1]);
      // scan.html resolves t('<key>') to pair.scan.<key>
      if (file === 'scan.html') for (const m of html.matchAll(/\bt\('([a-z_]+)'/g)) keys.add(`pair.scan.${m[1]}`);
    }
    expect(keys.size).toBeGreaterThan(10);
    const problems: string[] = [];
    for (const locale of LOCALES) {
      const strings = JSON.parse(readFileSync(join(root, 'locales', `${locale}.json`), 'utf8')) as unknown;
      for (const key of keys) {
        const value = key
          .split('.')
          .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], strings);
        if (typeof value !== 'string' || value.trim() === '') problems.push(`${key} (${locale})`);
      }
    }
    expect(problems).toEqual([]);
  });
});

// Consistent spelling (#133): users read "TimeBox" (and "TimeBox Evo" where the product or app is named), never "Timebox".
// Ids, file names, code identifiers and developer-only messages keep their spelling and are not checked here.
describe('TimeBox spelling (#133)', () => {
  const root = join(__dirname, '..');
  const readJsonFile = (file: string): unknown => JSON.parse(readFileSync(join(root, file), 'utf8')) as unknown;

  /** Paths of the string leaves below `node` that contain "Timebox" (case-sensitive). */
  const wrong = (node: unknown, path: string): string[] => {
    if (typeof node === 'string') return /Timebox/.test(node) ? [`${path}: ${node}`] : [];
    if (Array.isArray(node)) return node.flatMap((child, i) => wrong(child, `${path}[${i}]`));
    if (node && typeof node === 'object')
      return Object.entries(node).flatMap(([key, child]) => wrong(child, path ? `${path}.${key}` : key));
    return [];
  };
  /** Same, but only for the texts of the manifest: strings below an `en` or `de` key at any depth. */
  const wrongI18n = (node: unknown, path: string, inText = false): string[] => {
    if (typeof node === 'string') return inText ? wrong(node, path) : [];
    if (Array.isArray(node)) return node.flatMap((child, i) => wrongI18n(child, `${path}[${i}]`, inText));
    if (node && typeof node === 'object')
      return Object.entries(node).flatMap(([key, child]) =>
        wrongI18n(child, path ? `${path}.${key}` : key, inText || key === 'en' || key === 'de'),
      );
    return [];
  };

  it('spells it TimeBox in the manifest sources and the generated app.json', () => {
    const files = [
      'drivers/timebox/driver.compose.json',
      'drivers/timebox/driver.flow.compose.json',
      'drivers/timebox/driver.settings.compose.json',
      '.homeycompose/app.json',
      ...readdirSync(join(root, '.homeycompose', 'capabilities')).map((f) => `.homeycompose/capabilities/${f}`),
      'app.json',
    ];
    expect(files.length).toBeGreaterThan(5);
    const problems = files.flatMap((file) => wrongI18n(readJsonFile(file), file));
    expect(problems).toEqual([]);
  });

  it('spells it TimeBox in every locale string', () => {
    const problems = (['en', 'de'] as const).flatMap((l) =>
      wrong(readJsonFile(`locales/${l}.json`), `locales/${l}.json`),
    );
    expect(problems).toEqual([]);
  });

  it('spells it TimeBox in the store readme', () => {
    for (const file of ['README.txt', 'README.de.txt']) {
      const text = readFileSync(join(root, file), 'utf8');
      expect(wrong(text, file), file).toEqual([]);
    }
  });

  it('names the product "TimeBox Evo" as the driver name and in the pairing title', () => {
    const driver = readJsonFile('drivers/timebox/driver.compose.json') as { name: Record<string, string> };
    for (const locale of ['en', 'de'] as const) {
      expect(driver.name[locale], `driver.compose.json name.${locale}`).toBe('TimeBox Evo');
      const strings = readJsonFile(`locales/${locale}.json`) as { pair: { title: string } };
      expect(strings.pair.title, `locales/${locale}.json pair.title`).toContain('TimeBox Evo');
    }
  });
});
