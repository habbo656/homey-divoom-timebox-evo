import Homey from 'homey';
import {
  FLOW_TRIGGER_CHANNEL_CHANGED,
  FLOW_TRIGGER_CONNECTED,
  FLOW_TRIGGER_COUNTDOWN_ENDED,
  FLOW_TRIGGER_DISCONNECTED,
} from '../flow';
import { attachDevLink, detachDevLink } from '../dev/devHarness';
import type { DevLink } from '../dev/devHarness';
import { FaultTransport } from '../dev/FaultTransport';
import { asBleManager, BleTransport } from '../transport/BleTransport';
import { ConnectionManager } from '../transport/ConnectionManager';
import type { Transport } from '../transport/Transport';
import { STATUS_POLL_INTERVAL_MS, TimeboxController } from './TimeboxController';
import type { DeviceSurface, TextRequest } from './TimeboxController';
import { CHANNEL_IDS, parseChannelId } from './channel';
import type { ChannelId } from './channel';
import {
  CLOCK_SETTING_KEYS,
  CLOCK_STYLE_IDS,
  formatHexColor,
  resolveClockSettings,
  resolveStoredClockColor,
  resolveStoredShownStyle,
} from './clock';
import type { ClockSettings } from './clock';
import type { CountdownTime } from '../protocol/commands';
import type { Rgb } from '../protocol/status';
import { localiseError } from './argumentError';
import { onoffSetOnDimDisabled } from './lighting';
import { resolveTimeSyncSetting } from './timeSync';
import { WeatherUpdater } from './openMeteo';
import type { FetchLike } from './openMeteo';
import type { ImageFit } from './image';
import { downloadImage, loadImageToken, urlForLog } from './imageSource';
import type { ImageFetchLike } from './imageSource';
import { resolveWeatherSettings, WEATHER_SETTING_KEYS } from './weather';
import type { WeatherUpdate } from './weather';

/** The channel picker (`.homeycompose/capabilities/timebox_channel.json`). */
const CHANNEL_CAPABILITY = 'timebox_channel';
/** Capabilities added after the first release: devices paired earlier get them in `onInit`. */
const MIGRATED_CAPABILITIES = ['onoff', 'light_hue', 'light_saturation'] as const;
/** The device class: the manifest class (#19); devices paired before keep the stored class `other` until migrated. */
const DEVICE_CLASS = 'light';
/** Store key of the clock colour (`#RRGGBB`): owned by the app, follows the tile colour picker in clock mode. */
const CLOCK_COLOR_STORE = 'clock_color';
/** Store key of the clock style of the last "Show clock" (a style id): restored at power on; absent = the style of the settings. */
const CLOCK_SHOWN_STYLE_STORE = 'clock_shown_style';

/**
 * Homey glue around `TimeboxController` (docs/architecture.md, "Device layer"): builds the BLE link of this device,
 * forwards the `dim` capability, availability and Flow triggers. The logic lives in the controller.
 */
export class TimeboxDevice extends Homey.Device {
  private controller: TimeboxController | null = null;
  /** The automatic weather from Open-Meteo (#30); null until `setup()` built it. */
  private weatherUpdater: WeatherUpdater | null = null;
  /** Registered with the dev harness under DEBUG=1 (docs/pipeline.md). */
  private devLink: DevLink | null = null;
  /** `onUninit`/`onDeleted` ran: nothing is reported (started, unavailable) for a setup that finishes or fails afterwards. */
  private deinitialised = false;

  async onInit(): Promise<void> {
    // First, before anything that can fail: Homey rejects a capability change without a listener
    // ("Missing Capability Listener: dim").
    this.registerCapabilityListener('dim', async (value: number) => {
      if (!this.controller) throw new Error(this.homey.__('device.error.not_connected'));
      const controller = this.controller;
      await this.localiseErrors(() => controller.setDim(value));
    });

    // Devices paired before a capability existed get it here (channel picker #24, power and colour #26). A failure of one must
    // not stop the setup or the others.
    for (const capability of [CHANNEL_CAPABILITY, ...MIGRATED_CAPABILITIES]) {
      try {
        if (!this.hasCapability(capability)) await this.addCapability(capability);
      } catch (e) {
        this.error(`[device] could not add capability ${capability}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // A mode that was removed (cloud, visualizer, scoreboard) may still be stored: clear the tile instead of showing it.
    try {
      const stored: unknown = this.hasCapability(CHANNEL_CAPABILITY)
        ? this.getCapabilityValue(CHANNEL_CAPABILITY)
        : null;
      if (stored !== null && stored !== undefined && !CHANNEL_IDS.some((id) => id === stored)) {
        await this.setCapabilityValue(CHANNEL_CAPABILITY, null);
        this.log(`[device] mode tile: removed mode ${String(stored)} cleared`);
      }
    } catch (e) {
      this.error(`[device] could not clear the mode tile: ${e instanceof Error ? e.message : String(e)}`);
    }
    // `dim` must not switch `onoff` on (a brightness write is not a display change); the manifest option only applies to new devices.
    try {
      if (this.hasCapability('onoff') && !onoffSetOnDimDisabled(() => this.getCapabilityOptions('onoff'))) {
        await this.setCapabilityOptions('onoff', { setOnDim: false });
      }
    } catch (e) {
      this.error(`[device] could not set the onoff options: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.registerCapabilityListener('onoff', async (value: boolean) => {
      if (!this.controller) throw new Error(this.homey.__('device.error.not_connected'));
      await this.controller.setPower(value);
    });
    // Homey writes hue and saturation separately; the 300 ms debounce delivers a colour change as one call. A value that is
    // missing from the call is the one the tile shows (hue 0, saturation 1 before the first colour).
    this.registerMultipleCapabilityListener(
      ['light_hue', 'light_saturation'],
      async (values: Record<string, unknown>) => {
        if (!this.controller) throw new Error(this.homey.__('device.error.not_connected'));
        const hue = values.light_hue ?? this.getCapabilityValue('light_hue') ?? 0;
        const saturation = values.light_saturation ?? this.getCapabilityValue('light_saturation') ?? 1;
        const controller = this.controller;
        const mode = await this.localiseErrors(() => controller.setTileColor(hue as number, saturation as number));
        // The mode the colour applies to (null: superseded, the newer change owns the mode tile).
        if (mode) await this.writeChannelTile(mode);
      },
      300,
    );
    this.registerCapabilityListener(CHANNEL_CAPABILITY, async (value: string) => {
      if (!this.controller) throw new Error(this.homey.__('device.error.not_connected'));
      const controller = this.controller;
      await this.localiseErrors(() => controller.setChannel(parseChannelId(value)));
    });

    await this.migrateClockColor();

    await this.migrateDeviceClass();

    try {
      await this.setup();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.error(`[device] setup failed: ${message}`);
      if (this.deinitialised) return;
      await this.setUnavailable(this.homey.__('device.unavailable.setup_failed'));
    }
  }

  /** Runs `run`; an invalid argument it rejects with is rethrown with the localised message (docs/architecture.md, "User-facing errors"). */
  private async localiseErrors<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      throw localiseError(e, (key) => this.homey.__(key));
    }
  }

  /**
   * The clock colour moved from the `clock_color` setting to the device store (#69): take a valid legacy setting over once,
   * else start white. Nothing happens once a valid value is stored.
   */
  private async migrateClockColor(): Promise<void> {
    try {
      let legacy: unknown;
      try {
        legacy = this.getSetting('clock_color');
      } catch {
        legacy = undefined; // the setting is gone from the manifest
      }
      const { color, source } = resolveStoredClockColor(this.getStoreValue(CLOCK_COLOR_STORE), legacy);
      if (source === 'store') return;
      await this.setStoreValue(CLOCK_COLOR_STORE, formatHexColor(color));
      if (source === 'setting') this.log(`[device] clock colour migrated from the setting: ${formatHexColor(color)}`);
      else this.log(`[device] clock colour initialised: ${formatHexColor(color)}`);
    } catch (e) {
      this.error(`[device] could not migrate the clock colour: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * The device is always a light (#19). Homey keeps the stored class of devices paired while the manifest class was `other`,
   * so switch them over once; nothing happens when the class already is `light`. A failure only logs and never stops the setup.
   */
  private async migrateDeviceClass(): Promise<void> {
    try {
      if (this.getClass() === DEVICE_CLASS) return;
      await this.setClass(DEVICE_CLASS);
      this.log(`[device] device class -> ${DEVICE_CLASS} (migrated)`);
    } catch (e) {
      this.error(`[device] could not set the device class: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async setup(): Promise<void> {
    const uuid = String(this.getData().id);
    const log = (message: string): void => this.log(message);

    let transport: Transport = new BleTransport(asBleManager(this.homey.ble), uuid, log);
    let fault: FaultTransport | null = null;
    if (process.env.DEBUG === '1') transport = fault = new FaultTransport(transport);

    const clock = resolveClockSettings(this.getSettings() as Record<string, unknown>);
    const clockColor = resolveStoredClockColor(this.getStoreValue(CLOCK_COLOR_STORE), undefined).color;
    for (const key of clock.invalid) this.log(`[device] invalid ${key} setting, using the default`);
    const shown = resolveStoredShownStyle(this.getStoreValue(CLOCK_SHOWN_STYLE_STORE));
    if (shown.invalid) this.log('[device] invalid stored clock style, using the setting');
    const link = new ConnectionManager(transport, {
      pollIntervalMs: STATUS_POLL_INTERVAL_MS,
      log,
      error: (message) => this.error(message),
    });

    const surface: DeviceSurface = {
      setDim: (dim) => this.setCapabilityValue('dim', dim),
      setOnOff: (on) => this.setCapabilityValue('onoff', on),
      setLightColor: async (hue, saturation) => {
        await this.setCapabilityValue('light_hue', hue);
        await this.setCapabilityValue('light_saturation', saturation);
      },
      saveClockColor: (color) => this.setStoreValue(CLOCK_COLOR_STORE, formatHexColor(color)),
      saveShownClockStyle: (style) =>
        this.setStoreValue(CLOCK_SHOWN_STYLE_STORE, style === null ? null : CLOCK_STYLE_IDS[style]),
      setChannel: (id) => this.setCapabilityValue(CHANNEL_CAPABILITY, id),
      clearChannel: () => this.setCapabilityValue(CHANNEL_CAPABILITY, null),
      onChannelChanged: (id) => this.fireChannelTrigger(id),
      onCountdownEnded: () => this.fireCountdownEndedTrigger(),
      setAvailable: () => this.setAvailable(),
      setUnavailable: (message) => this.setUnavailable(message),
      timeZone: () => this.homey.clock.getTimezone(),
      onOnlineChanged: (online) => this.fireConnectionTrigger(online),
      log,
      error: (message) => this.error(message),
    };
    // A local reference: onUninit/onDeleted may null the field while attachDevLink is awaited (start after stop is a no-op).
    const controller = new TimeboxController(
      link,
      surface,
      {
        unreachable: this.homey.__('device.unavailable.unreachable'),
        notTimebox: this.homey.__('device.unavailable.not_timebox'),
        notConnected: this.homey.__('device.error.not_connected'),
        notConfirmed: this.homey.__('device.error.not_confirmed'),
        textEmpty: this.homey.__('device.error.text_empty'),
        textTooLong: this.homey.__('device.error.text_too_long'),
        countdownZero: this.homey.__('device.error.countdown_zero'),
      },
      {
        timeSync: resolveTimeSyncSetting(this.getSetting('time_sync')),
        clockSettings: clock.settings,
        clockColor,
        shownClockStyle: shown.style,
        powerOn: !this.hasCapability('onoff') || this.getCapabilityValue('onoff') !== false,
        storedChannel: this.getChannelCapability(),
      },
    );
    this.controller = controller;
    const updater = new WeatherUpdater({
      fetch: globalThis.fetch as FetchLike,
      location: () => ({
        latitude: this.homey.geolocation.getLatitude(),
        longitude: this.homey.geolocation.getLongitude(),
      }),
      onWeather: (weather) => controller.setWeather(weather, 'open-meteo'),
      log,
    });
    this.weatherUpdater = updater;
    if (fault) {
      // The dev harness acts on this link (drop/mute/poll/brightness); its own link is stopped first.
      this.devLink = { manager: link, fault, label: uuid };
      await attachDevLink(this.devLink);
    }
    controller.start();
    if (this.deinitialised) return;
    const weather = resolveWeatherSettings(this.getSettings() as Record<string, unknown>);
    for (const key of weather.invalid) this.log(`[device] invalid ${key} setting, using the default`);
    updater.configure(weather.settings);
    this.log(`[device] started (${uuid}), poll interval ${STATUS_POLL_INTERVAL_MS / 1000} s`);
  }

  /** Used by the Flow condition "is connected". */
  isConnected(): boolean {
    return this.controller?.isConnected() ?? false;
  }

  /** Used by the Flow condition "mode is": the mode the device is on (null while unknown or while it shows cloud or visualizer). */
  getChannel(): ChannelId | null {
    if (this.controller?.onOtherMode()) return null;
    return this.controller?.getChannel() ?? this.getChannelCapability();
  }

  /** The value of the channel tile as a channel id (null if never set). */
  private getChannelCapability(): ChannelId | null {
    if (!this.hasCapability(CHANNEL_CAPABILITY)) return null;
    const stored: unknown = this.getCapabilityValue(CHANNEL_CAPABILITY);
    return CHANNEL_IDS.find((id) => id === stored) ?? null;
  }

  /** The mode tile shows the mode a colour change applied to (written directly: the capability listener would send a second command). */
  private async writeChannelTile(mode: ChannelId): Promise<void> {
    try {
      await this.setCapabilityValue(CHANNEL_CAPABILITY, mode);
    } catch (e) {
      this.error(`[device] could not write the channel tile: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Used by the Flow action "Switch channel": the same path as the tile (capability listener), then the tile shows the
   * new value (verified on hardware: the tile follows after a Flow switch; the explicit write is harmless).
   */
  async switchChannel(id: ChannelId): Promise<void> {
    await this.triggerCapabilityListener(CHANNEL_CAPABILITY, id);
    await this.setCapabilityValue(CHANNEL_CAPABILITY, id);
  }

  /**
   * Used by the Flow action "Show clock": switches to the clock with this style (device style number) and colour, then
   * the tile shows `clock` (written directly, so the capability listener does not send a second command). A change that a
   * newer one superseded leaves the tile to the newer change.
   */
  async showClock(style: number, color: Rgb): Promise<void> {
    if (!this.controller) throw new Error(this.homey.__('device.error.not_connected'));
    const completed = await this.controller.showClock(style, color);
    if (completed) await this.setCapabilityValue(CHANNEL_CAPABILITY, 'clock');
  }

  /**
   * Used by the Flow action "Set lighting": switches to the lighting channel with this colour, which also powers the
   * panel on, then the tile shows `lighting` and the controller has written the colour. A change that a
   * newer one superseded leaves the tile to the newer change.
   */
  async setLighting(color: Rgb): Promise<void> {
    if (!this.controller) throw new Error(this.homey.__('device.error.not_connected'));
    const completed = await this.controller.showLighting(color);
    if (completed) await this.setCapabilityValue(CHANNEL_CAPABILITY, 'lighting');
  }

  /**
   * Used by the Flow action "Show custom page": switches to the custom channel with this page (device page 0..2), then
   * the tile shows `custom` (written directly, so the capability listener does not send a second command).
   */
  async showCustomPage(page: number): Promise<void> {
    if (!this.controller) throw new Error(this.homey.__('device.error.not_connected'));
    const completed = await this.controller.showCustomPage(page);
    // Superseded before the page was sent: the newer change owns the tile.
    if (completed) await this.setCapabilityValue(CHANNEL_CAPABILITY, 'custom');
  }

  /**
   * Used by the Flow action "Show text": the native scrolling text with these colours, device speed and duration (0 =
   * until stopped). The text is not a mode: the tile and the triggers are not touched.
   */
  async showText(request: TextRequest): Promise<void> {
    if (!this.controller) throw new Error(this.homey.__('device.error.not_connected'));
    await this.controller.showText(request);
  }

  /**
   * Used by the Flow action "Show image from URL": downloads the picture (only when the Timebox is connected), converts it
   * to 16x16 and shows it as an overlay (not a mode: the tile and the triggers are not touched). `url` is already validated.
   */
  async showImageFromUrl(url: string, fit: ImageFit, durationS: number): Promise<void> {
    if (!this.controller) throw new Error(this.homey.__('device.error.not_connected'));
    const fetch = globalThis.fetch as ImageFetchLike;
    await this.controller.showImageFrom(
      { origin: urlForLog(url), load: () => downloadImage(fetch, url) },
      fit,
      durationS,
    );
  }

  /** Used by the Flow action "Show image": the same for the image token that was dropped onto the card (`image`). */
  async showImageToken(image: unknown, fit: ImageFit, durationS: number): Promise<void> {
    if (!this.controller) throw new Error(this.homey.__('device.error.not_connected'));
    await this.controller.showImageFrom({ origin: 'token', load: () => loadImageToken(image) }, fit, durationS);
  }

  /** Used by the Flow action "Stop text": ends the native text, the previous mode shows again. */
  async stopText(): Promise<void> {
    if (!this.controller) throw new Error(this.homey.__('device.error.not_connected'));
    await this.controller.stopText();
  }

  /**
   * Used by the Flow action "Start countdown": the countdown overlay (not a mode: the tile and the triggers are not
   * touched); a turned-off Timebox is turned on first.
   */
  async startCountdown(time: CountdownTime): Promise<void> {
    if (!this.controller) throw new Error(this.homey.__('device.error.not_connected'));
    await this.controller.startCountdown(time);
  }

  /** Used by the Flow action "Stop countdown": ends the countdown, the previous mode shows again. */
  async stopCountdown(): Promise<void> {
    if (!this.controller) throw new Error(this.homey.__('device.error.not_connected'));
    await this.controller.stopCountdown();
  }

  /**
   * Used by the Flow actions "Set temperature" and "Set weather": merges the given part into the stored weather and sends
   * it as soon as the Timebox is on and connected (never an error for an offline Timebox); the automatic weather
   * replaces it at its next update.
   */
  async setWeather(update: WeatherUpdate): Promise<void> {
    if (!this.controller) throw new Error(this.homey.__('device.error.not_connected'));
    await this.controller.setWeather(update, 'flow');
  }

  private async fireChannelTrigger(id: ChannelId): Promise<void> {
    this.log(`[device] flow trigger ${FLOW_TRIGGER_CHANNEL_CHANGED}: ${id}`);
    await this.homey.flow.getDeviceTriggerCard(FLOW_TRIGGER_CHANNEL_CHANGED).trigger(this, { channel: id });
  }

  private async fireCountdownEndedTrigger(): Promise<void> {
    this.log(`[device] flow trigger ${FLOW_TRIGGER_COUNTDOWN_ENDED}`);
    await this.homey.flow.getDeviceTriggerCard(FLOW_TRIGGER_COUNTDOWN_ENDED).trigger(this);
  }

  private async fireConnectionTrigger(online: boolean): Promise<void> {
    const id = online ? FLOW_TRIGGER_CONNECTED : FLOW_TRIGGER_DISCONNECTED;
    this.log(`[device] flow trigger ${id}`);
    await this.homey.flow.getDeviceTriggerCard(id).trigger(this);
  }

  async onSettings({
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<void> {
    let clockSettings: ClockSettings | null = null;
    if (changedKeys.some((key) => (CLOCK_SETTING_KEYS as readonly string[]).includes(key))) {
      const clock = resolveClockSettings(newSettings);
      for (const key of clock.invalid) this.log(`[device] invalid ${key} setting, using the default`);
      clockSettings = clock.settings;
    }
    if (changedKeys.includes('time_sync')) {
      this.controller?.setTimeSyncEnabled(resolveTimeSyncSetting(newSettings.time_sync));
    }
    if (changedKeys.some((key) => (WEATHER_SETTING_KEYS as readonly string[]).includes(key))) {
      const weather = resolveWeatherSettings(newSettings);
      for (const key of weather.invalid) this.log(`[device] invalid ${key} setting, using the default`);
      this.weatherUpdater?.configure(weather.settings);
    }
    // Not awaited: the controller never rejects, and the save must not wait for the Timebox.
    if (clockSettings) {
      if (this.controller) void this.controller.setClockSettings(clockSettings);
      else void this.clearShownClockStyle(); // setup failed: the stored "Show clock" style must not come back at the next start
    }
  }

  /** Clear the stored style of "Show clock" without a controller (#85): the newest explicit choice, the clock settings, wins. */
  private async clearShownClockStyle(): Promise<void> {
    try {
      await this.setStoreValue(CLOCK_SHOWN_STYLE_STORE, null);
    } catch (e) {
      this.error(`[device] could not clear the stored clock style: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  onDeleted(): void {
    void this.stopController();
  }

  async onUninit(): Promise<void> {
    await this.stopController();
  }

  private async stopController(): Promise<void> {
    this.deinitialised = true;
    const controller = this.controller;
    this.controller = null;
    this.weatherUpdater?.stop();
    this.weatherUpdater = null;
    if (this.devLink) detachDevLink(this.devLink);
    this.devLink = null;
    try {
      await controller?.stop();
    } catch (e) {
      this.error(`[device] stop failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
