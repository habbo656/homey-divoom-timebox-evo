// Device logic without Homey (docs/architecture.md, "Device layer"): maps the `dim`, `onoff`, colour and channel
// capabilities to the device commands and keeps them in sync with what the device reports. `TimeboxDevice` is only glue between this class, the
// `ConnectionManager` and Homey's capability/availability API. Same pattern as `pairing.ts`: everything Homey-specific
// is injected through `DeviceSurface`, the link through `LinkLike`.
import {
  MAX_CUSTOM_PAGE,
  MAX_TEXT_UNITS,
  nativeText,
  queryCustomPage,
  queryStatus,
  setBrightness,
  setCustomPage,
  setDateTime,
  setHot,
  startCountdown as countdownStartCommand,
  stopCountdown as countdownStopCommand,
  stopNativeText,
} from '../protocol/commands';
import type { CountdownTime } from '../protocol/commands';
import { toHex } from '../protocol/hex';
import type { Reply } from '../protocol/replies';
import {
  COUNTDOWN_REPORT_OPCODE,
  decodeCustomPage,
  decodeStatus,
  isCountdownEnd,
  isCustomPageReply,
} from '../protocol/status';
import type { DeviceStatus, Rgb } from '../protocol/status';
import type { ConnectFailure, ConnectionManager } from '../transport/ConnectionManager';
import { LinkLostError, NotConnectedError, RequestTimeoutError } from '../transport/errors';
import { ArgumentError, formatArgValue } from './argumentError';
import { channelCode, channelCommand, channelFromCode, otherModeName, parseChannelId } from './channel';
import type { ChannelId, ChannelOverride } from './channel';
import { CLOCK_HOUR24, clockStyleId, DEFAULT_CLOCK_COLOR, DEFAULT_CLOCK_SETTINGS, formatHexColor } from './clock';
import type { ClockFace, ClockSettings } from './clock';
import { formatCountdown } from './countdown';
import { buildImageCommand, ImageError, runImageJob } from './image';
import type { ImageFit } from './image';
import { hueSatToRgb, powerOffCommand, rgbToHueSat } from './lighting';
import { parseTextDuration, prepareText } from './scrollText';
import { fillPlaceholders } from './text';
import {
  autoSyncReason,
  formatSync,
  localDateTimeParts,
  SYNC_RETRY_MS,
  TIME_CHECK_INTERVAL_MS,
  utcOffsetMinutes,
} from './timeSync';
import type { LastSync } from './timeSync';
import { mergeWeather, weatherCommand } from './weather';
import type { Weather, WeatherSource, WeatherUpdate } from './weather';

/** The liveness (status) poll interval: fixed, there is no setting for it (#70). */
export const STATUS_POLL_INTERVAL_MS = 60_000;
/** How long the link may be down (or silent) before the device is marked unavailable. */
export const UNAVAILABLE_GRACE_MS = 30_000;
/** How long the `46` query that confirms a brightness change waits for its reply. */
export const DIM_CONFIRM_TIMEOUT_MS = 5_000;
/** How long the `74` write of a brightness change may take before the change fails (a hung write must not hang Homey). */
export const DIM_SEND_TIMEOUT_MS = 10_000;
/**
 * How long the five native-text frames (about 1.3 KB, roughly 66 BLE writes of 20 bytes on Homey) may take to be written
 * before "Show text" fails; it is twice the single-command limit because one command is a few writes and this is many.
 */
export const TEXT_SEND_TIMEOUT_MS = 20_000;
/** How long the `46` query that confirms a channel change waits for its reply. */
export const CHANNEL_CONFIRM_TIMEOUT_MS = 5_000;
/**
 * How long after entering the clock with the small style from another mode (or off) the clock command is sent once more:
 * the first one shows the default dial there (#88, protocol section 5.1); 1.5 s is the interval the probe proved.
 */
export const CLOCK_RESEND_DELAY_MS = 1_500;
/** How long the `18` time command waits for its `18 55` acknowledgement. */
export const TIME_SYNC_CONFIRM_TIMEOUT_MS = 5_000;

/** What `switchTo` takes besides the channel: the overrides of `channelCommand` and the custom page of "Show custom page". */
type SwitchOverride = ChannelOverride & {
  /** Device page 0..2, selected with `bd 17 PP` after `45 05` (custom channel only). */
  customPage?: number;
  /** The caller writes the colour tile itself (or Homey does): a mode change does not write it. */
  keepTile?: boolean;
  /**
   * Clock channel only: the style of `face` that is not the one of the settings ("Show clock", or the kept one at power on
   * and with the tile colour). It becomes the shown style (`clockStyleOverride`) once the command was sent; absent, the
   * shown style is reset.
   */
  shownStyle?: number | null;
};

/** The part of `ConnectionManager` the controller uses; the real class satisfies it. */
export type LinkLike = Pick<ConnectionManager, 'start' | 'stop' | 'send' | 'request' | 'state' | 'on' | 'off'>;

/** Everything Homey-specific, supplied by `TimeboxDevice`. Calls may return a promise; rejections are logged. */
export interface DeviceSurface {
  /** Write the capability value `dim` (0..1) to Homey. */
  setDim(dim: number): void | Promise<void>;
  /** Write the capability value `timebox_channel` to Homey (the device reported a mode, or the app left a mode that is not offered). */
  setChannel(id: ChannelId): void | Promise<void>;
  /** Write the capability value `onoff` to Homey (the panel was powered on by a display change or at the device, or the run starts). */
  setOnOff(on: boolean): void | Promise<void>;
  /** Write the capability values `light_hue` and `light_saturation` (both 0..1) to Homey: the colour of the mode that is shown (a mode change, a lighting colour the device reported, or a Flow set one). */
  setLightColor(hue: number, saturation: number): void | Promise<void>;
  /** Persist the clock colour (the app owns it: device store `clock_color`, `#RRGGBB`). A failure is logged, never propagated. */
  saveClockColor(color: Rgb): void | Promise<void>;
  /** Persist the clock style shown by "Show clock" (device store `clock_shown_style`, a device style number) or null to clear it. A failure is logged, never propagated. */
  saveShownClockStyle(style: number | null): void | Promise<void>;
  /**
   * Clear the capability value `timebox_channel` (set it to null): the device shows a mode the tile does not offer
   * (cloud, visualizer). A failure is logged, never propagated.
   */
  clearChannel(): void | Promise<void>;
  /** The mode changed (reported by the device or switched by Homey): fire the "mode changed" trigger. */
  onChannelChanged(id: ChannelId): void | Promise<void>;
  /** The device reported the end of a countdown (`71 55 03 01 01 00`): fire the "countdown ended" trigger. */
  onCountdownEnded(): void | Promise<void>;
  setAvailable(): void | Promise<void>;
  setUnavailable(message: string): void | Promise<void>;
  /** The IANA time zone of the Homey (`homey.clock.getTimezone()`), asked for at every time sync. */
  timeZone(): string;
  /** The connection state changed after the first known state (`true` = connected, `false` = disconnected). */
  onOnlineChanged(online: boolean): void | Promise<void>;
  log(message: string): void;
  error(message: string): void;
}

/** Texts shown to the user (already translated). */
export interface DeviceMessages {
  /** Unavailable: the Timebox does not answer. */
  unreachable: string;
  /** Unavailable: the paired device is not a Timebox Evo (permanent connect error). */
  notTimebox: string;
  /** Error of a capability change while the Timebox is not connected. */
  notConnected: string;
  /** Error of a display change, dim or power off the Timebox did not confirm (no `46` reply in time), see `switchTo`. */
  notConfirmed: string;
  /** Error of "Show text": nothing is left to show after removing the characters the Timebox cannot draw. */
  textEmpty: string;
  /** Error of "Show text": more than `MAX_TEXT_UNITS` characters after cleaning; `{length}` and `{max}` are filled in. */
  textTooLong: string;
  /** Error of "Start countdown": 0 minutes and 0 seconds. */
  countdownZero: string;
}

/** What the Flow action "Show text" asks for (validated in the controller). */
export interface TextRequest {
  /** The raw text of the card (any string, cleaned by `prepareText`). */
  text: unknown;
  color: Rgb;
  background: Rgb;
  /** The device speed `SP` (`parseTextSpeedId`). */
  speed: number;
  /** Seconds the text runs, 0..3600 (`parseTextDuration`); 0 = until stopped, a mode change or power off. */
  durationS: number;
}

/** What the Flow actions "Show image" and "Show image from URL" ask for (the picture is already converted). */
export interface ImageRequest {
  /** The `44` payload (`buildImageCommand`). */
  payload: Uint8Array;
  /** Distinct colours of the picture, for the log. */
  colours: number;
  /** For the log. */
  fit: ImageFit;
  /** Seconds the image is shown, 0..3600 (`parseTextDuration`); 0 = until a mode change, text, countdown or power off. */
  durationS: number;
}

/** Where the picture of "Show image" comes from; `load` is only called once the Timebox is known to be connected. */
export interface ImageSource {
  /** What the log says about the source: the host of a URL, or `token`. Never a path or query. */
  origin: string;
  /** The encoded image (PNG, JPEG or GIF); throws `ImageError`. */
  load(): Promise<Uint8Array>;
}

export interface TimeboxControllerOptions {
  unavailableGraceMs?: number;
  dimConfirmTimeoutMs?: number;
  dimSendTimeoutMs?: number;
  /** How long the native-text frames may take to be written (default `TEXT_SEND_TIMEOUT_MS`). */
  textSendTimeoutMs?: number;
  /** Clock used by the time sync (default `Date.now`). */
  now?: () => number;
  /** How often the time zone and UTC offset are compared with the last sync (default 60 s). */
  timeCheckIntervalMs?: number;
  /** How long the `18` command waits for its acknowledgement (default 5 s). */
  timeSyncConfirmTimeoutMs?: number;
  /** How long the `46` query that confirms a channel change waits (default 5 s). */
  channelConfirmTimeoutMs?: number;
  /** How long after entering the clock with the small style the clock command is re-sent (default 1.5 s). */
  clockResendDelayMs?: number;
  /** Initial value of the `time_sync` setting (default on). */
  timeSync?: boolean;
  /** The clock settings: style and page flags (default `DEFAULT_CLOCK_SETTINGS`). */
  clockSettings?: ClockSettings;
  /** The stored clock colour (default white); changed by the tile colour picker in clock mode and by "Show clock". */
  clockColor?: Rgb;
  /** The stored style of the last "Show clock" (device style number), restored at power on; default none (the style of the settings). */
  shownClockStyle?: number | null;
  /** Initial power state, the stored `onoff` capability value (default on). */
  powerOn?: boolean;
  /** The stored `timebox_channel` capability value: where "power on" returns to while no channel is known yet (default none, then the clock). */
  storedChannel?: ChannelId | null;
}

const rgbIsBlack = (c: Rgb): boolean => c.r === 0 && c.g === 0 && c.b === 0;
const sameColor = (a: Rgb, b: Rgb): boolean => a.r === b.r && a.g === b.g && a.b === b.b;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** A byte as `0xNN` for logs. */
const hexByte = (value: number): string => `0x${value.toString(16).padStart(2, '0')}`;

/** Homey `dim` (0..1) to device brightness (0..100). Throws `ArgumentError` (a `RangeError`) for anything else than a number in 0..1. */
export function dimToBrightness(dim: unknown): number {
  if (typeof dim !== 'number' || !Number.isFinite(dim) || dim < 0 || dim > 1) {
    const message = `dim must be a number between 0 and 1, got ${String(dim)}`;
    const params = { value: formatArgValue(dim) };
    if (typeof dim !== 'number' || Number.isNaN(dim)) throw new ArgumentError(message, 'invalid_number', 'dim', params);
    throw new ArgumentError(message, 'invalid_range', 'dim', { ...params, min: 0, max: 1 });
  }
  return Math.round(dim * 100);
}

/**
 * Device brightness to Homey `dim`. The device may report values outside 0..100 (a truncated `74` command left 126 once,
 * protocol section 2): clamp, and report the raw value through `onClamp`.
 */
export function brightnessToDim(brightness: number, onClamp?: (raw: number) => void): number {
  return clampBrightness(brightness, onClamp) / 100;
}

function clampBrightness(brightness: number, onClamp?: (raw: number) => void): number {
  if (!Number.isFinite(brightness)) throw new RangeError(`brightness must be a number, got ${String(brightness)}`);
  const clamped = Math.min(100, Math.max(0, brightness));
  if (clamped !== brightness) onClamp?.(brightness);
  return clamped;
}

export class TimeboxController {
  private readonly link: LinkLike;
  private readonly surface: DeviceSurface;
  private readonly messages: DeviceMessages;
  private readonly confirmTimeoutMs: number;
  private readonly sendTimeoutMs: number;
  private readonly textSendTimeoutMs: number;
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly timeCheckMs: number;
  private readonly timeConfirmMs: number;
  private readonly channelConfirmMs: number;
  private readonly clockResendMs: number;
  private readonly storedChannel: ChannelId | null;

  private stopped = false;
  private stopPromise: Promise<void> | null = null;
  /** Aborts of the acknowledgement waits in progress (`waitForReply`); `stop()` runs them. */
  private readonly ackWaits = new Set<() => void>();
  private started = false;

  /** Brightness (0..100, clamped) the device is known to have; compared in the device domain to avoid rounding loops. */
  private knownBrightness: number | null = null;
  /** Number of `setDim` calls that have not finished; device reports are ignored meanwhile (no echo loop). */
  private inFlight = 0;
  /** Incremented by every `setDim`; only the newest one confirms. */
  private generation = 0;
  /**
   * The brightness (0..100) a `dim` change asked for while the panel is off (#62). `74` lights an off panel, so the value is
   * held and sent right after the next switch on (`applyPendingBrightness`). Exists only while off; memory only.
   */
  private pendingBrightness: number | null = null;
  /** The `channelGeneration` of the newest power-off command; with `channelInFlight` it tells that an off is being sent. */
  private offGeneration = -1;

  /** Channel the device is known to be on (last `46` d0 or last successful switch); null until the first status. */
  private knownChannel: ChannelId | null = null;
  /** The last `46` status of this run (colour, visualization index and brightness for the channel commands). */
  private lastStatus: DeviceStatus | null = null;
  /** Number of `setChannel` calls that have not finished; device channel reports are ignored meanwhile (no echo loop). */
  private channelInFlight = 0;
  /** Incremented by every `setChannel`; only the newest one confirms. */
  private channelGeneration = 0;
  /** Generation and colour of the newest switch to the clock (#60); tells whether the switch in flight targets the clock. */
  private clockSwitch: { generation: number; color: Rgb } | null = null;
  /** The pending re-send of the small clock face (#88); null when none is scheduled. Cancelled by every newer switch. */
  private clockResendTimer: ReturnType<typeof setTimeout> | null = null;
  /** The origin logged by the pending re-send; carried over to a newer switch into the small clock inside the gap. */
  private clockResendOrigin: string | null = null;
  /** The frame the pending re-send will write (so "Show text" can send it ahead of the text). */
  private clockResendCommand: Uint8Array | null = null;
  /**
   * The native text this run started and that is still believed to run on the device (#28): its sequence number and the
   * timer that ends it. The text is not a mode: `46` d0 keeps reporting the channel under it. A channel command ends it
   * on the device, so there is no `6e 00` before one (protocol section 5.5); the controller only forgets it.
   */
  private textActive: { seq: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
  /** Incremented when a text sequence or a stop is queued; compared on completion to find out which one is newest. */
  private textSeq = 0;
  /** A `6e 00` that could not be sent (link down); sent after the next status reply of a session. */
  private textStopPending = false;
  /**
   * The static image this run showed and that is still believed to be on the device (#31): its sequence number and the timer
   * that ends it. Like the text it is an overlay, not a mode: the tile, the known channel and the triggers stay. A mode
   * command, a text, a countdown or power off ends it on the device (the app only forgets it); only the duration re-sends
   * the known mode.
   */
  private imageActive: { seq: number; timer: ReturnType<typeof setTimeout> | null; displaySeq: number } | null = null;
  /** Incremented by every text, countdown and image that is queued (not by "Stop text"): the expiry of an image compares it. */
  private displaySeq = 0;
  /** Incremented by every `showImage`; the newest one is the one that counts. */
  private imageSeq = 0;
  /** The newest image sequence number that a later command ended (an image confirmed after that was already replaced). */
  private imageEndedSeq = 0;
  /** Number of image sends in progress (frames queued, `imageActive` not set yet): the weather and the hot flag wait. */
  private imageSending = 0;
  /**
   * The "image shadow": the first `46` d0 reported after the image was sent (what `44` does to d0 is unmeasured, protocol
   * section 4). Reports equal to it are ignored while the image is tracked; a different known code is a mode change made
   * at the device (or a reboot), which ends the tracking and is then handled like any report. Null until the first report.
   */
  private imageShadow: number | null = null;
  /** The noise meter (`72 02 01`) was sent by this run and is believed to be on the device (#3); a mode change, power off or tile colour ends it. */
  private noiseActive = false;
  /**
   * The "noise shadow": the `46` d0 the device reports under the noise meter (unmeasured, so the design works for any
   * code), like the image shadow. Reports equal to it are ignored while the noise meter is tracked; a different known code
   * is a mode change made at the device, which ends the tracking. Null until the confirm or the first report.
   */
  private noiseShadow: number | null = null;
  /**
   * The d0 code of a mode the app does not offer (`02` cloud, `04` visualizer) while the device shows it, else null.
   * `knownChannel` then keeps the last offered mode (what "power on" returns to), `getChannel()` reports null and the
   * tile is cleared.
   */
  private otherModeCode: number | null = null;
  /**
   * Power state of the panel as the app knows it (`46` has no field known to report power, protocol section 3). While off
   * the known channel stays the channel from before off.
   */
  private power: boolean;
  /**
   * While off: the d0 code the device reported after the off command (it reports `01`, lighting, although nothing is
   * shown). Reports with this code mean "still off"; any other known code means the panel was switched on at the device.
   * Null while on (and at startup from stored off: the first report is adopted).
   */
  private offShadow: number | null = null;
  /** The first status of this run has written `onoff` to the tile. */
  private powerReported = false;
  /** The lighting colour the tile shows (the last one sent or reported); null until known, never black. */
  private knownColor: Rgb | null = null;
  /** The last unknown `46` d0 code that was logged (logged once per new code), null after a known one. */
  private unknownCode: number | null = null;

  /** Availability as last reported to Homey; null until the first decision (startup, no trigger for the first one). */
  private online: boolean | null = null;
  /** The current session has delivered a status reply (the Timebox is really there, not just GATT-connected). */
  private answered = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Why the link was last down; used in the log line of the unavailable decision. */
  private lastReason = 'no answer from the device';
  /** Unavailable because of a permanent connect error (the same decision is not repeated every retry). */
  private permanentUnavailable = false;

  /** The clock settings (style, page flags): sent with every switch to the clock channel (and applied while the clock is shown). */
  private clockSettings: ClockSettings;
  /** The clock colour: owned by the app, kept in the device store (`surface.saveClockColor`), shown on the tile in clock mode. */
  private clockColor: Rgb;
  /**
   * The clock style shown by the last "Show clock" (device style number), persisted through `surface.saveShownClockStyle`;
   * null = the style of the settings. Kept through power off/on and the tile colour; reset by a switch to the clock that
   * does not carry it (`setChannel`, the Flow action "Switch mode") and by `setClockSettings`.
   */
  private clockStyleOverride: number | null;

  /** Setting `time_sync`: automatic sync (connect, daily, zone/offset change). */
  private timeSyncEnabled: boolean;
  /** The last successful sync of this run (zone and offset it used); null until the first one. */
  private lastSync: LastSync | null = null;
  /** Time of a failed sync that is still to be retried; null if none. */
  private lastFailureAtMs: number | null = null;
  /** The sync in progress; concurrent requests share it. */
  private syncing: Promise<void> | null = null;
  private timeTimer: ReturnType<typeof setInterval> | null = null;

  /** The weather the Timebox should show (#30): the newest value from a Flow card or Open-Meteo; null until one was set. */
  private weather: Weather | null = null;
  /** The origin of the stored weather for the log: the source, plus ` temperature` / ` condition` for a partial update. */
  private weatherLabel: string = 'flow';
  /** The stored weather has not been (successfully) sent to the device of the current session yet. */
  private weatherPending = false;
  /** Incremented by every `setWeather`; a send that finds a newer version afterwards sends again. */
  private weatherVersion = 0;
  /** A weather send is in progress (the next one is queued behind it by the version check). */
  private weatherSending = false;
  /** Incremented by the first status of every session: a weather send of an older session must not clear the pending flag of the new one. */
  private weatherSession = 0;
  /** Number of native text sends in progress (frames queued, `textActive` not set yet): the weather waits like for a running text. */
  private textSending = 0;

  private readonly onStatus = (status: DeviceStatus): void => {
    const firstOfSession = !this.answered;
    this.sessionAnswered();
    // The first status reply of a session is the connect sync's trigger (also after a reconnect inside the grace period).
    if (firstOfSession && !this.stopped && this.timeSyncEnabled) this.autoSync('connect');
    if (firstOfSession && !this.stopped && this.textStopPending) void this.sendPendingTextStop();
    // The device forgets the weather at a reboot: every new session sends the stored one again.
    if (firstOfSession && !this.stopped) {
      this.weatherSession++;
      if (this.weather !== null) this.weatherPending = true;
    }
    this.lastStatus = status;
    if (!this.powerReported && !this.stopped) {
      this.powerReported = true;
      this.call(() => this.surface.setOnOff(this.power));
    }
    this.deviceBrightness(status.brightness);
    // The lighting colour first (it only updates what is known), then the mode; at most one tile write per status.
    const colorChanged = this.deviceColor(status.lightingColor);
    const wroteTile = this.deviceChannel(status.channel);
    if (colorChanged && !wroteTile && this.getChannel() === 'lighting') this.writeTile(this.knownColor);
    if (firstOfSession) void this.flushWeather('connect');
    if (firstOfSession && !this.stopped) void this.sendHotAtConnect();
  };
  private readonly onConnected = (): void => {
    this.answered = false;
  };
  private readonly onDisconnected = (reason: string): void => {
    this.answered = false;
    this.lastReason = reason;
    this.armGrace();
  };
  private readonly onConnectFailed = (failure: ConnectFailure): void => {
    this.answered = false;
    this.lastReason = failure.reason;
    if (failure.permanent) this.permanentFailure(failure.reason);
    else this.armGrace();
  };
  private readonly onReply = (reply: Reply): void => {
    if (reply.kind === 'brightness' && reply.ok && reply.data.length >= 1) this.deviceBrightness(reply.data[0]);
    else if (reply.cmd === COUNTDOWN_REPORT_OPCODE) this.countdownReport(reply);
  };

  constructor(link: LinkLike, surface: DeviceSurface, messages: DeviceMessages, opts: TimeboxControllerOptions = {}) {
    this.link = link;
    this.surface = surface;
    this.messages = messages;
    this.confirmTimeoutMs = opts.dimConfirmTimeoutMs ?? DIM_CONFIRM_TIMEOUT_MS;
    this.sendTimeoutMs = opts.dimSendTimeoutMs ?? DIM_SEND_TIMEOUT_MS;
    this.textSendTimeoutMs = opts.textSendTimeoutMs ?? TEXT_SEND_TIMEOUT_MS;
    this.graceMs = opts.unavailableGraceMs ?? UNAVAILABLE_GRACE_MS;
    this.now = opts.now ?? Date.now;
    this.timeCheckMs = opts.timeCheckIntervalMs ?? TIME_CHECK_INTERVAL_MS;
    this.timeConfirmMs = opts.timeSyncConfirmTimeoutMs ?? TIME_SYNC_CONFIRM_TIMEOUT_MS;
    this.channelConfirmMs = opts.channelConfirmTimeoutMs ?? CHANNEL_CONFIRM_TIMEOUT_MS;
    this.clockResendMs = opts.clockResendDelayMs ?? CLOCK_RESEND_DELAY_MS;
    this.timeSyncEnabled = opts.timeSync ?? true;
    this.storedChannel = opts.storedChannel ?? null;
    this.clockSettings = opts.clockSettings ?? DEFAULT_CLOCK_SETTINGS;
    this.clockColor = opts.clockColor ?? DEFAULT_CLOCK_COLOR;
    this.clockStyleOverride = opts.shownClockStyle ?? null;
    this.power = opts.powerOn ?? true;
    // Started from "off": the channel from before off is the stored one, "power on" returns to it without a trigger.
    if (!this.power) this.knownChannel = opts.storedChannel ?? null;
  }

  /**
   * The Flow condition "is connected": the device is online, i.e. the current session has answered a status query
   * (the same state as availability and the connected/disconnected triggers). False before the first answer, once the
   * grace period expired without an answered session, and after `stop()`.
   */
  isConnected(): boolean {
    return !this.stopped && this.online === true;
  }

  /**
   * Subscribe to the link and start connecting. Idempotent; a no-op after `stop()`. The device is neither available nor
   * unavailable yet: it becomes available with the first status reply, or unavailable after the grace period.
   */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.link.on('status', this.onStatus);
    this.link.on('reply', this.onReply);
    this.link.on('connected', this.onConnected);
    this.link.on('disconnected', this.onDisconnected);
    this.link.on('connectFailed', this.onConnectFailed);
    this.armGrace();
    this.timeTimer = setInterval(() => {
      this.timeCheck();
      void this.flushWeather('held');
    }, this.timeCheckMs);
    this.link.start();
  }

  /** Stop for good: removes the listeners and stops the link. Idempotent. No surface call happens afterwards. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.cancelClockResend();
    this.clearText();
    this.clearImage();
    this.clearGrace();
    if (this.timeTimer) clearInterval(this.timeTimer);
    this.timeTimer = null;
    this.link.off('status', this.onStatus);
    this.link.off('reply', this.onReply);
    this.link.off('connected', this.onConnected);
    this.link.off('disconnected', this.onDisconnected);
    this.link.off('connectFailed', this.onConnectFailed);
    for (const abort of [...this.ackWaits]) abort();
    this.stopPromise = this.link.stop();
    return this.stopPromise;
  }

  /**
   * Capability listener of `dim`: sends `74 BB`, then confirms with a `46` query. Rejects with a readable error if
   * `dim` is invalid or the Timebox is not connected (nothing is queued). It does not write the capability value:
   * Homey does that when this promise resolves. If the `46` confirm fails (#151) the optimistic brightness stays (the
   * device probably took the command), the tile is written to the requested value (Homey does not store a rejected one)
   * and it rejects with `messages.notConfirmed` (no reply in time) or `messages.notConnected` (link lost or stopped
   * during the wait). A dim superseded by a newer one during the wait resolves and writes nothing; a mismatch resolves.
   * While the panel is off (or an off is being sent) `74` would light it (protocol section 3), so nothing is sent: the
   * value is held, the newest one wins, and it is sent right after the next switch on (#62, `applyPendingBrightness`). A
   * held change resolves at once and needs no link; a stopped controller still rejects.
   */
  async setDim(dim: number): Promise<void> {
    const percent = dimToBrightness(dim);
    if (this.stopped) throw new Error(this.messages.notConnected);
    if (!this.power || this.offInFlight()) {
      this.pendingBrightness = percent;
      ++this.generation; // an older setDim still in flight skips its confirm
      this.log(`dim held while off: ${percent} (sent at power on)`);
      return;
    }
    if (this.link.state !== 'connected') throw new Error(this.messages.notConnected);

    // This value is the newest: a value held earlier (during an off that a later power change replaced) is stale.
    this.pendingBrightness = null;
    const generation = ++this.generation;
    this.inFlight++;
    try {
      try {
        await this.sendBounded(setBrightness(percent));
      } catch (e) {
        if (e instanceof NotConnectedError || e instanceof LinkLostError) throw new Error(this.messages.notConnected);
        throw e;
      }
      this.knownBrightness = percent;
      if (generation !== this.generation) {
        this.log(`dim ${percent} superseded by a newer change`);
        return;
      }
      try {
        const reply = await this.link.request(queryStatus(), 0x46, this.confirmTimeoutMs);
        const device = decodeStatus(reply).brightness;
        if (device === percent) this.log(`dim confirmed: ${device}`);
        else this.log(`dim mismatch: device ${device}, requested ${percent}`);
      } catch (e) {
        if (e instanceof RequestTimeoutError) this.log('dim confirm timeout');
        else this.log(`dim confirm failed: ${errorText(e)}`);
        const failure = this.confirmFailure(e);
        if (generation !== this.generation) {
          this.log(`dim ${percent} superseded by a newer change`);
          return;
        }
        // Homey does not store the value of a rejected listener: align the tile with the optimistic known brightness.
        if (!this.stopped) this.call(() => this.surface.setDim(brightnessToDim(percent)));
        throw new Error(failure === 'lost' ? this.messages.notConnected : this.messages.notConfirmed);
      }
    } finally {
      this.inFlight--;
    }
  }

  /**
   * Why a confirm failed (#141, #151): the link was lost or the controller was stopped during the wait (`lost`, rejects with
   * `notConnected`), else the device did not answer in time or answered wrongly (`unconfirmed`, rejects with `notConfirmed`).
   */
  private confirmFailure(e: unknown): 'unconfirmed' | 'lost' {
    return e instanceof NotConnectedError || e instanceof LinkLostError || this.stopped ? 'lost' : 'unconfirmed';
  }

  /** A power-off command is being sent and is still the newest power change. */
  private offInFlight(): boolean {
    return this.channelInFlight > 0 && this.offGeneration === this.channelGeneration;
  }

  /**
   * Send the brightness held while off (#62), right after the panel was switched on (a display command, a switch on at the
   * device, the countdown end display or an off that failed before it was sent). Nothing if none is held. The `74` is
   * queued at once, so it follows the command that lit the panel and precedes the `46` confirm of that command. Never
   * rejects: a failure is logged and the tile is written back to the brightness the device is known to have.
   */
  private applyPendingBrightness(): void {
    const percent = this.pendingBrightness;
    if (percent === null || this.stopped) return;
    this.pendingBrightness = null;
    const generation = ++this.generation;
    this.inFlight++;
    const sent = this.sendBounded(setBrightness(percent));
    void (async () => {
      try {
        await sent;
        if (generation === this.generation) this.knownBrightness = percent;
        this.log(`dim sent at power on: ${percent}`);
      } catch (e) {
        this.log(`dim not sent at power on: ${errorText(e)}`);
        // No generation guard: a newer direct dim cannot have succeeded while this send failed (a failure here means the
        // link is lost, which fails both), so the tile goes back to the brightness the device is known to have.
        const known = this.knownBrightness;
        if (known !== null && !this.stopped) this.call(() => this.surface.setDim(brightnessToDim(known)));
      } finally {
        this.inFlight--;
      }
    })();
  }

  /** Whether the app considers the panel on (the `onoff` capability). */
  isOn(): boolean {
    return this.power;
  }

  /**
   * Capability listener of `onoff` and Flow actions "Turn on/off". Off sends the lighting command with power byte `00`
   * (colour and brightness unchanged, protocol section 3), then confirms with a `46` query and remembers the d0 code the
   * device shows afterwards (the "off shadow"). The known channel stays the one from before off and nothing fires.
   * On sends the command of the channel from before off (known channel, else the stored one, else the clock; a lighting
   * restore comes back as plain colour, a clock restore with the style of the last "Show clock" if there is one) even if
   * the app thinks the panel is on. Rejects with a `RangeError` for a value
   * that is not a boolean and with a readable error if the Timebox is not connected (nothing is queued). Power on rejects with
   * `notConfirmed` like `setChannel` if the restored mode is not confirmed; so does off if its `46` confirm fails (#151):
   * the optimistic off and the shadow `01` stay (the device probably took the command), the `onoff` tile is written to
   * off, and a link lost during the wait rejects with `notConnected`. A change superseded by a newer power change resolves.
   * It does not write the
   * capability value: Homey does that when this promise resolves.
   */
  async setPower(on: boolean): Promise<void> {
    if (typeof on !== 'boolean') throw new RangeError(`onoff must be a boolean, got ${String(on)}`);
    if (on) await this.sendMode(this.restoreChannel());
    else await this.powerOff();
  }

  /** Send the command of `channel` as "power on" does: the clock with the style of the last "Show clock", else the stored face. */
  private async sendMode(channel: ChannelId): Promise<boolean> {
    if (channel === 'clock') return this.switchTo(channel, this.shownFace(), { shownStyle: this.clockStyleOverride });
    return this.switchTo(channel, this.clockFace());
  }

  /**
   * Capability listener of `light_hue` / `light_saturation` (both 0..1): the tile colour is the colour of the mode that is
   * shown. In clock mode it is the clock colour (stored, sent with the style that is shown, i.e. the one of the last "Show
   * clock" while it is kept, and the page flags); in every other state
   * (lighting, custom, cloud, visualizer, no mode known yet) it is the lighting colour and switches to lighting, which also
   * powers the panel on. A panel that is off returns to the mode from before off. Resolves with the mode the colour applies to,
   * or null if a newer change superseded it (the caller must not write the mode tile then). Rejects like `setChannel` (also
   * `notConfirmed`; the colour tile is then written to the requested colour), and
   * with a `RangeError` outside 0..1. It does not write the colour capabilities: Homey does that when this promise resolves.
   */
  async setTileColor(hue: number, saturation: number): Promise<'clock' | 'lighting' | null> {
    const color = hueSatToRgb(hue, saturation);
    const mode = this.getChannel() === 'clock' ? 'clock' : 'lighting';
    this.log(`colour for ${mode}: ${formatHexColor(color)}`);
    const completed =
      mode === 'clock'
        ? await this.switchTo(
            'clock',
            { ...this.shownFace(), color },
            { keepTile: true, shownStyle: this.clockStyleOverride },
          )
        : await this.switchTo('lighting', this.clockFace(), { lighting: { color }, keepTile: true });
    return completed ? mode : null;
  }

  /**
   * The Flow action "Set lighting": switches to the lighting channel with this colour (plain, effect 0), which also powers
   * the panel on, and writes the colour to the tile. Rejects like `setChannel` (also `notConfirmed`; the tile is then written too). Resolves `false` if a newer change superseded it: the
   * caller must not write the mode tile.
   */
  async showLighting(color: Rgb): Promise<boolean> {
    const completed = await this.switchTo('lighting', this.clockFace(), { lighting: { color }, keepTile: true });
    if (completed) this.writeTile(color);
    return completed;
  }

  /** The channel "power on" returns to: the one from before off. */
  private restoreChannel(): ChannelId {
    return this.knownChannel ?? this.storedChannel ?? 'clock';
  }

  /** The mode the device is known to be on, or null before the first status of this run and while it shows another mode (cloud, visualizer). */
  getChannel(): ChannelId | null {
    return this.otherModeCode === null ? this.knownChannel : null;
  }

  /** The device shows a mode that is not offered (cloud, visualizer); the tile is empty. */
  onOtherMode(): boolean {
    return this.otherModeCode !== null;
  }

  /**
   * Capability listener of `timebox_channel` and Flow action: switches to `id` (the command is built from the last `46`
   * status and, for the clock, from the clock face of the settings, see `channelCommand`), then confirms with a `46` query.
   * Switching to the clock resets the style of "Show clock": the configured style is used. Rejects with a `RangeError` for an unknown id and
   * with a readable error if the Timebox is not connected (nothing is queued) and, after the command was sent, with the
   * readable `notConfirmed` error if the Timebox does not answer the `46` confirm in time (`notConnected` if the link is lost
   * meanwhile, #141); the known channel, the trigger and the mode tile then show the requested mode anyway. Fires the "channel changed" trigger if
   * the channel differs from the known one. It does not write the capability value: Homey does that when this promise
   * resolves.
   */
  async setChannel(id: ChannelId): Promise<void> {
    await this.switchTo(parseChannelId(id), this.clockFace());
  }

  /**
   * Apply the clock settings (the `clock_*` settings). They are stored for every later switch to
   * the clock (with the stored clock colour). They are sent at once, by switching to the clock with the new face, when
   * the clock is the target of the newest display change (online and connected): no change in flight and the clock shown
   * with the panel on, or the change in flight is itself a switch to the clock (a tile or Flow switch, a power-on restore,
   * an earlier save; #60), which the new face supersedes with the colour of that switch kept. Otherwise (another mode,
   * a switch away from the clock or a power-off in flight, panel off) nothing is sent and the channel never changes. Never rejects:
   * the outcome is logged.
   */
  async setClockSettings(settings: ClockSettings): Promise<void> {
    this.clockSettings = settings;
    // The newest explicit choice wins: a style of "Show clock" does not outlive a change of the clock settings.
    this.setShownStyle(null);
    const face = this.clockFace();
    if (this.stopped) return;
    // A switch in flight that leaves the clock must not be superseded: only store the face then.
    // While the panel is off nothing is sent either: a clock command would switch it on.
    const pending = this.inFlightClockColor();
    const clockIsTarget = this.channelInFlight > 0 ? pending !== null : this.power && this.getChannel() === 'clock';
    if (this.online !== true || this.link.state !== 'connected' || !clockIsTarget) {
      this.log('clock settings saved, applied when the clock is shown');
      return;
    }
    try {
      // A racing "Show clock" or tile colour keeps its colour: only the face of the settings is new.
      // `keepTile`: the tiles are written below (success) or by the unconfirmed path of `switchTo` (mode and colour tile).
      const completed = pending
        ? await this.switchTo('clock', { ...face, color: pending }, { keepTile: true })
        : await this.switchTo('clock', face);
      // The switch it superseded resolved `false` and left the tiles to the newer change (this one): write them here.
      if (completed && pending) {
        this.call(() => this.surface.setChannel('clock'));
        this.writeTile(pending);
      }
      this.log(completed ? 'clock settings applied' : 'clock settings superseded by a newer change');
    } catch (e) {
      this.log(`clock settings not applied: ${errorText(e)}`);
    }
  }

  /**
   * The colour of the switch to the clock that is in flight and is still the newest display change (any later switch to
   * another mode or power off has bumped the generation), else null. Includes the clock re-send (#88) of such a switch.
   */
  private inFlightClockColor(): Rgb | null {
    const s = this.clockSwitch;
    return this.channelInFlight > 0 && s !== null && s.generation === this.channelGeneration ? s.color : null;
  }

  /**
   * The Flow action "Show clock": switches to the clock with this style (device style number 0..6) and colour, the other
   * parts of the face (page flags) from the settings. The colour becomes the clock colour (stored, written to the
   * tile unless it is black); the style is kept as the shown style (stored, restored at power on and kept by the tile
   * colour) until the clock is selected again (`setChannel`, Flow "Switch mode") or the clock settings are changed.
   * Rejects like `setChannel` (also `notConfirmed`; the tile is then written too), and with a `RangeError` for a style or colour that is not valid. Resolves `false` if a
   * newer change superseded it: the newer change owns the tile and the caller must not write the mode tile.
   */
  async showClock(style: number, color: Rgb): Promise<boolean> {
    const completed = await this.switchTo(
      'clock',
      { ...this.clockFace(), style, color },
      { keepTile: true, shownStyle: style },
    );
    if (completed) this.writeTile(color);
    return completed;
  }

  /**
   * The Flow action "Show custom page": switches to the custom channel (`45 05`, waits for its acknowledgement) and
   * selects this page (device page 0..2, `bd 17 PP`), which also powers the panel on. One-shot: the page is not stored
   * (a later switch to the custom channel shows whatever the device shows). Rejects like `setChannel` (also `notConfirmed`: the
   * page was sent but is not read back), and with a
   * `RangeError` for a page outside 0..2. Resolves `false` if a newer change superseded it before the page was sent: the
   * known channel and the trigger are then left to the newer change and the caller must not write the tile.
   */
  async showCustomPage(page: number): Promise<boolean> {
    return this.switchTo('custom', this.clockFace(), { customPage: page });
  }

  /**
   * The shared path of every display change (`setChannel`, `setClockSettings`, `showClock`, power on, `setTileColor` and the Flow
   * actions lighting and custom page): send the switch command, then confirm with `46`. Every display command also powers the panel on (protocol
   * section 3), so `onoff` is set if the app thought it was off. Resolves `false` if a newer change superseded it, else `true`.
   * If the confirm fails (#141) the optimistic state and the trigger stay (the device probably took the command), the mode
   * tile (and, for `keepTile` changes, the colour tile) is written to match, and it rejects with `messages.notConfirmed`
   * (no `46` reply, or for a custom page no `bd 17 ff` reply, in time) or `messages.notConnected` (link lost during the
   * wait); a custom page (already sent before the confirm) is not read back after a failed `46` confirm, and a page number
   * mismatch still resolves. A change still pending at `stop()` rejects with `messages.notConnected`.
   * Superseded changes still resolve `false`. A mode mismatch still resolves.
   */
  private async switchTo(channel: ChannelId, face: ClockFace, override?: SwitchOverride): Promise<boolean> {
    // Build and validate first: an invalid request throws `RangeError` without superseding a pending switch.
    const command = channelCommand(
      channel,
      this.lastStatus,
      this.pendingBrightness ?? this.knownBrightness,
      face,
      override,
    );
    const lighting = override?.lighting;
    const customPage = channel === 'custom' ? override?.customPage : undefined;
    const pageCommand = customPage === undefined ? null : setCustomPage(customPage);
    if (this.stopped || this.link.state !== 'connected') throw new Error(this.messages.notConnected);

    // The small clock face entered from another mode or from off needs one more command (#88, protocol section 5.1).
    const resendFrom = channel === 'clock' && clockStyleId(face.style) === 'small' ? this.resendOrigin() : null;
    const generation = ++this.channelGeneration;
    if (channel === 'clock') this.clockSwitch = { generation, color: face.color };
    const textAtSend = this.textSeq;
    const imageAtSend = this.imageSeq;
    this.cancelClockResend();
    this.channelInFlight++;
    try {
      try {
        if (pageCommand && customPage !== undefined) {
          // A superseded page leaves the known channel and the tile to the newer change (it is the one that shows).
          if (!(await this.sendCustomPage(command, pageCommand, generation, customPage))) {
            this.log('channel custom superseded by a newer change');
            return false;
          }
        } else {
          // The animation pages of the clock rotation are a persistent device flag, set right before every clock frame (#106).
          // Both writes are queued in the same turn (no await in between), so a text or countdown of another Flow cannot slip in between.
          const hot = channel === 'clock' ? this.sendHot(face.animations, 'switch') : null;
          await this.sendBounded(command);
          await hot;
        }
      } catch (e) {
        if (e instanceof NotConnectedError || e instanceof LinkLostError) throw new Error(this.messages.notConnected);
        throw e;
      }
      this.textEndedByCommand('mode change', textAtSend);
      this.imageEndedByCommand('mode change', imageAtSend);
      if (channel === 'noise_meter') {
        this.noiseActive = true;
        this.noiseShadow = null;
      } else {
        this.noiseEnded('mode change');
      }
      if (lighting) this.log(`lighting -> ${formatHexColor(lighting.color)}: ${toHex(command)}`);
      else if (customPage === undefined) this.log(`channel -> ${channel}: ${toHex(command)}`);
      if (lighting) this.knownColor = rgbIsBlack(lighting.color) ? this.knownColor : lighting.color;
      if (!this.power) {
        this.power = true;
        this.offShadow = null;
        this.call(() => this.surface.setOnOff(true));
        this.applyPendingBrightness();
      }
      if (channel === 'clock' && !sameColor(face.color, this.clockColor)) {
        this.clockColor = face.color;
        const saved = face.color;
        this.call(() => this.surface.saveClockColor(saved));
      }
      if (channel === 'clock') this.setShownStyle(override?.shownStyle ?? null);
      const leftOtherMode = this.otherModeCode !== null;
      if (leftOtherMode || this.knownChannel !== channel) {
        this.knownChannel = channel;
        this.otherModeCode = null;
        // The tile was cleared for the other mode: write the mode again, also if it equals the last offered one.
        if (leftOtherMode) this.call(() => this.surface.setChannel(channel));
        // The colour tile shows the colour of the mode that is shown now.
        if (!override?.keepTile) this.writeTile(this.modeColor(channel));
        this.call(() => this.surface.onChannelChanged(channel));
      }
      if (generation !== this.channelGeneration) {
        this.log(`channel ${channel} superseded by a newer change`);
        return false;
      }
      let onCustom = false;
      // Set when the device never confirmed the change: the action then fails (#141) after the tile is aligned.
      let confirmError: 'unconfirmed' | 'lost' | null = null;
      try {
        const status = decodeStatus(await this.link.request(queryStatus(), 0x46, this.channelConfirmMs));
        const device = channelFromCode(status.channel);
        const shown = device ?? otherModeName(status.channel) ?? `code ${status.channel}`;
        if (channel === 'noise_meter') {
          // The code the device reports under the noise meter is unknown: any code confirms and becomes the shadow.
          this.log(`channel confirmed: ${channel} (device reports channel code ${hexByte(status.channel)})`);
          if (this.noiseActive && generation === this.channelGeneration) this.noiseShadow = status.channel;
        } else if (device !== channel) this.log(`channel mismatch: device ${shown}, requested ${channel}`);
        else if (lighting) this.confirmLighting(status, lighting.color);
        else this.log(`channel confirmed: ${channel}`);
        if (channel === 'clock' && device === 'clock') this.confirmClockFace(status, face);
        onCustom = device === 'custom';
      } catch (e) {
        if (e instanceof RequestTimeoutError) this.log('channel confirm timeout');
        else this.log(`channel confirm failed: ${errorText(e)}`);
        confirmError = this.confirmFailure(e);
      }
      if (customPage !== undefined && onCustom && generation === this.channelGeneration) {
        confirmError = await this.confirmCustomPage(customPage);
      }
      if (resendFrom !== null && generation === this.channelGeneration) {
        // A text or stop queued after this switch (two Flows at once) must not be ended by the re-send 1.5 s later: skip it
        // (the small dial may then stay the default one after the text, #88).
        if (this.textSeq !== textAtSend)
          this.log('clock face re-send dropped: a text, countdown or stop was queued after the switch');
        else this.scheduleClockResend(command, resendFrom, textAtSend);
      }
      if (confirmError !== null) {
        if (generation !== this.channelGeneration) {
          this.log(`channel ${channel} superseded by a newer change`);
          return false;
        }
        // Homey does not store the value of a rejected listener: align the tiles with the optimistic known channel.
        // Nothing reaches the surface after stop().
        if (!this.stopped) {
          this.call(() => this.surface.setChannel(channel));
          if (override?.keepTile) this.writeTile(lighting?.color ?? face.color);
        }
        throw new Error(confirmError === 'lost' ? this.messages.notConnected : this.messages.notConfirmed);
      }
      return true;
    } finally {
      this.channelInFlight--;
    }
  }

  // --- native text (#28) ------------------------------------------------------------------------------------------

  /**
   * The Flow action "Show text": clean the text (`prepareText`), turn the panel on first if it is off (the mode from before
   * off returns), send the five native-text payloads queued in one go (a `46` poll cannot slip between them) and, for a
   * duration above 0, send `6e 00` when it has passed. A text that is already running is replaced (no `6e 00` first,
   * protocol section 5.5). The text is not a mode: the tile, the known channel and the triggers stay as they are. The text
   * content is never logged. Rejects with the `textEmpty` error if nothing is left after cleaning, with the `textTooLong`
   * error if more than `MAX_TEXT_UNITS` UTF-16 units are left (the text is never cut; nothing is sent and a running text
   * stays), with a `RangeError` for an invalid argument and with the readable `notConnected` error if the Timebox is not
   * connected. The length check comes before the connection check, like the empty check. A panel that is off is turned on
   * first with `setPower(true)`: an unconfirmed restore rejects with the `notConfirmed` error and the text is not sent.
   */
  async showText(request: TextRequest): Promise<void> {
    const prepared = prepareText(request.text);
    const durationS = parseTextDuration(request.durationS);
    if (prepared.text === '') throw new Error(this.messages.textEmpty);
    if (prepared.units > MAX_TEXT_UNITS) {
      this.log(`text rejected: ${prepared.units} units (at most ${MAX_TEXT_UNITS})`);
      throw new Error(fillPlaceholders(this.messages.textTooLong, { length: prepared.units, max: MAX_TEXT_UNITS }));
    }
    // Build (and validate speed and colours) before anything is sent or superseded.
    const frames = nativeText({
      text: prepared.text,
      color: request.color,
      background: request.background,
      speed: request.speed,
    });
    if (this.stopped || this.link.state !== 'connected') throw new Error(this.messages.notConnected);
    if (!this.power) {
      this.log('text: panel is off, turning it on first');
      await this.setPower(true);
    }

    const resend = this.takeClockResendAhead('text');
    const seq = ++this.textSeq;
    this.displaySeq++;
    const imageAtSend = this.imageSeq;
    this.clearText();
    this.textStopPending = false;
    this.textSending++;
    try {
      await this.sendAllBounded(resend === null ? frames : [resend, ...frames]);
    } catch (e) {
      // The device may hold part of this text or the previous one, or still receive the queued frames later: a `6e 00`
      // (harmless when nothing runs) ends whatever it shows. Tried at once behind the queued frames if the link is still
      // there, else after the next reconnect. Not when a newer text or stop was queued meanwhile: a stray stop behind it
      // would end that text (the newer one handles its own failure).
      if (seq === this.textSeq) {
        this.textStopPending = true;
        if (!this.stopped && this.link.state === 'connected') void this.sendPendingTextStop('after a failed send');
      }
      if (e instanceof NotConnectedError || e instanceof LinkLostError) throw new Error(this.messages.notConnected);
      throw e;
    } finally {
      this.textSending--;
    }
    if (this.stopped) return;
    this.imageEndedByCommand('text', imageAtSend);
    if (seq !== this.textSeq) {
      this.log('text superseded by a newer text, a countdown or a stop');
      return;
    }
    const timer = durationS > 0 ? setTimeout(() => void this.expireText(seq), durationS * 1000) : null;
    this.textActive = { seq, timer };
    this.log(
      `text shown: ${prepared.text.length} units, speed ${request.speed}, ${formatHexColor(request.color)} on ` +
        `${formatHexColor(request.background)}, ${durationS > 0 ? `${durationS} s` : 'until stopped'}`,
    );
  }

  /**
   * The Flow action "Stop text": always sends `6e 00` (harmless when no text runs, protocol section 5.5, and it also ends
   * a text the app lost track of, e.g. after an app restart); the previous mode shows again. Rejects with the readable
   * `notConnected` error if the Timebox is not connected; a text the app believed to run is then stopped after the next
   * reconnect.
   */
  async stopText(): Promise<void> {
    const wasActive = this.textActive !== null;
    const seq = ++this.textSeq;
    this.clearText();
    if (this.stopped || this.link.state !== 'connected') {
      if (wasActive) this.textStopPending = true;
      throw new Error(this.messages.notConnected);
    }
    try {
      await this.sendBounded(stopNativeText());
    } catch (e) {
      // Not when a newer text was queued meanwhile: a pending stop would end it at the next reconnect.
      if (wasActive && this.textSeq === seq) this.textStopPending = true;
      if (e instanceof NotConnectedError || e instanceof LinkLostError) throw new Error(this.messages.notConnected);
      throw e;
    }
    this.textStopPending = false;
    this.log(wasActive ? 'text stopped (action)' : 'text stop sent (no text was running)');
  }

  /** Whether the app believes a native text is running on the device. */
  isTextShown(): boolean {
    return this.textActive !== null;
  }

  /** The duration of text `seq` has passed: send `6e 00`, or remember to when the link is down. Never rejects. */
  private async expireText(seq: number): Promise<void> {
    if (this.stopped || this.textActive?.seq !== seq) return;
    this.textActive = null;
    if (this.link.state !== 'connected') {
      this.textStopPending = true;
      this.log('text duration over, stop pending (not connected)');
      return;
    }
    const queued = this.textSeq;
    try {
      await this.sendBounded(stopNativeText());
      this.log('text stopped (duration)');
    } catch (e) {
      if (this.textSeq === queued) this.textStopPending = true;
      this.log(`text stop failed, pending: ${errorText(e)}`);
    }
  }

  /** Send the `6e 00` that could not be sent before (after the first status of a new session, or at once after a failed text send). Never rejects. */
  private async sendPendingTextStop(when = 'after reconnect'): Promise<void> {
    const seq = this.textSeq;
    this.textStopPending = false;
    try {
      await this.sendBounded(stopNativeText());
      this.log(`text stopped (pending stop ${when})`);
    } catch (e) {
      // Only while no newer text or stop was queued: a newer text is tracked and a stray stop would end it.
      if (this.textSeq === seq) this.textStopPending = true;
      this.log(`pending text stop failed: ${errorText(e)}`);
    }
  }

  /**
   * A display command (mode change, power off) ended the text on the device itself (it answers `6e 55 00`): forget it,
   * without a `6e 00`. Only a text queued before the command (`textAtSend`) is ended.
   */
  private textEndedByCommand(reason: string, textAtSend: number): void {
    if (this.textActive === null || this.textActive.seq !== textAtSend) return;
    this.clearText();
    this.textStopPending = false;
    this.log(`text stopped (${reason})`);
  }

  // --- countdown (#33) --------------------------------------------------------------------------------------------

  /**
   * The Flow action "Start countdown": send `72 03 01 MM SS` (protocol section 5.6). The countdown is an overlay like the
   * native text: the tile, the known channel and the triggers stay as they are, a running text ends, and the app does not
   * track it or wait for its end (the device reports `71 55 03 01 01 00` itself). The panel is turned on first if it is off
   * (the mode from before off returns); a pending small-clock re-send is sent ahead of the frame. Starting again replaces
   * a running countdown. Rejects with the `countdownZero` error for 0:00 (nothing is sent), with a `RangeError` for an
   * invalid argument and with the readable `notConnected` error if the Timebox is not connected. A panel that is off is
   * turned on first with `setPower(true)`: an unconfirmed restore rejects with the `notConfirmed` error and the countdown
   * is not sent.
   */
  async startCountdown(time: CountdownTime): Promise<void> {
    if (time.minutes === 0 && time.seconds === 0) throw new Error(this.messages.countdownZero);
    const frame = countdownStartCommand(time);
    if (this.stopped || this.link.state !== 'connected') throw new Error(this.messages.notConnected);
    if (!this.power) {
      this.log('countdown: panel is off, turning it on first');
      await this.setPower(true);
    }
    const resend = this.takeClockResendAhead('countdown');
    // The countdown replaces a running text on the device (protocol section 5.6): a text that is still being sent is then
    // superseded and one that is shown is forgotten once the frame is out.
    const textAtSend = this.textSeq++;
    this.displaySeq++;
    const imageAtSend = this.imageSeq;
    try {
      await this.sendAllBounded(resend === null ? [frame] : [resend, frame]);
    } catch (e) {
      if (e instanceof NotConnectedError || e instanceof LinkLostError) throw new Error(this.messages.notConnected);
      throw e;
    }
    if (this.stopped) return;
    this.textEndedByCommand('countdown', textAtSend);
    this.imageEndedByCommand('countdown', imageAtSend);
    this.log(`countdown started: ${formatCountdown(time.minutes, time.seconds)}`);
  }

  /**
   * The Flow action "Stop countdown": send `72 03 00 00 00`, then the command of the known mode again, because the device
   * itself switches to the clock a few seconds after a stop (protocol section 5.6). Harmless when no countdown runs. A stop
   * only works while the countdown is on screen, so with the panel off nothing is sent (it would be ignored and the mode
   * would light the panel) and neither with a text shown or being sent (the text hides the countdown and the mode re-send
   * would end the text); a countdown that a mode change, a text or power off hid keeps running and shows its end. The
   * mode is not re-sent while it is unknown or the device shows another mode (cloud, visualizer). Rejects with the readable
   * `notConnected` error if the Timebox is not connected.
   */
  async stopCountdown(): Promise<void> {
    if (this.stopped || this.link.state !== 'connected') throw new Error(this.messages.notConnected);
    if (!this.power) {
      this.log('countdown stop skipped: panel off');
      return;
    }
    // A shown text (or one being sent) hides the countdown, so the device would ignore the stop (protocol section 5.6), and
    // the mode re-send would end the text (a `45` command does, section 5.5). The effect of `72 03 00` on a text is unmeasured.
    if (this.textActive !== null || this.textSending > 0) {
      this.log('countdown stop skipped: text shown');
      return;
    }
    // Same for a shown image (or one being sent): it hides the countdown, and the mode re-send would end the image.
    if (this.imageActive !== null || this.imageSending > 0) {
      this.log('countdown stop skipped: image shown');
      return;
    }
    try {
      await this.sendBounded(countdownStopCommand());
    } catch (e) {
      if (e instanceof NotConnectedError || e instanceof LinkLostError) throw new Error(this.messages.notConnected);
      throw e;
    }
    this.log('countdown stopped (action)');
    const mode = this.getChannel();
    if (mode === null) return;
    try {
      await this.sendMode(mode);
    } catch (e) {
      // The stop is out; without the re-send the device ends on the clock and the next poll tells the app.
      this.log(`countdown stop: mode re-send failed: ${errorText(e)}`);
    }
  }

  // --- static image (#31) -----------------------------------------------------------------------------------------

  /**
   * The Flow actions "Show image" / "Show image from URL": send the converted `44` payload (protocol section 4), turn the
   * panel on first if it is off (the mode from before off returns) and, for a duration above 0, send the known mode again
   * when it has passed. The image is an overlay like the text: the tile, the known channel and the triggers stay as they are,
   * a mode command, a text, a countdown or power off ends it on the device and the app only forgets it. A running native
   * text is forgotten when the image is sent (conservative: whether `44` ends it is unmeasured, protocol section 4); a new
   * image replaces the old one. Rejects with a `RangeError` for an invalid duration or payload and with the readable
   * `notConnected` error if the Timebox is not connected (nothing is queued). A panel that is off is turned on first with
   * `setPower(true)`: an unconfirmed restore rejects with the `notConfirmed` error and the image is not sent.
   */
  async showImage(request: ImageRequest): Promise<void> {
    const durationS = parseTextDuration(request.durationS);
    if (!(request.payload instanceof Uint8Array) || request.payload.length === 0 || request.payload[0] !== 0x44) {
      throw new RangeError('image payload must be a 44 command');
    }
    if (this.stopped || this.link.state !== 'connected') throw new Error(this.messages.notConnected);
    if (!this.power) {
      this.log('image: panel is off, turning it on first');
      await this.setPower(true);
    }

    const resend = this.takeClockResendAhead('image');
    const seq = ++this.imageSeq;
    // `44` may end a running text on the device (unmeasured): forget it, as for a countdown. A text still being sent is superseded.
    const textAtSend = this.textSeq++;
    const displayAtSend = ++this.displaySeq;
    this.clearImage();
    this.imageSending++;
    try {
      await this.sendAllBounded(resend === null ? [request.payload] : [resend, request.payload]);
    } catch (e) {
      if (e instanceof NotConnectedError || e instanceof LinkLostError) throw new Error(this.messages.notConnected);
      throw e;
    } finally {
      this.imageSending--;
    }
    if (this.stopped) return;
    this.textEndedByCommand('image', textAtSend);
    if (seq !== this.imageSeq) {
      this.log('image superseded by a newer image');
      return;
    }
    if (seq <= this.imageEndedSeq) {
      this.log('image ended by a later command before it was confirmed');
      return;
    }
    const timer = durationS > 0 ? setTimeout(() => void this.expireImage(seq), durationS * 1000) : null;
    this.imageActive = { seq, timer, displaySeq: displayAtSend };
    this.log(
      `image shown: ${request.colours} colours, ${request.fit}, ${durationS > 0 ? `${durationS} s` : 'until a mode change'}`,
    );
  }

  /**
   * The Flow actions "Show image" and "Show image from URL": check the arguments and the connection, load the picture,
   * convert it to the 16x16 `44` payload and show it (`showImage`). Nothing is loaded while the Timebox is not connected.
   * A load or decode failure is logged with its real cause and rejected as an `ImageError` (localised by the Flow layer);
   * the display and a running image, text or countdown stay as they are. Only the origin is logged, never a URL path.
   * Loading and decoding run one at a time for the whole app (`runImageJob`): a second card waits for the first.
   */
  async showImageFrom(source: ImageSource, fit: ImageFit, durationS: number): Promise<void> {
    parseTextDuration(durationS);
    if (this.stopped || this.link.state !== 'connected') throw new Error(this.messages.notConnected);
    let command;
    try {
      // One image at a time for the whole app: the picture is held only while it is loaded and decoded.
      command = await runImageJob(async () => {
        const bytes = await source.load();
        const started = this.now();
        const built = await buildImageCommand(bytes, fit);
        this.log(
          `image loaded: ${source.origin}, ${built.format} ${built.width}x${built.height}, ` +
            `${bytes.length} bytes, prepared in ${this.now() - started} ms`,
        );
        return built;
      });
    } catch (e) {
      if (e instanceof ImageError) this.log(`image failed (${e.kind}) from ${source.origin}: ${e.message}`);
      throw e;
    }
    await this.showImage({ payload: command.payload, colours: command.colours, fit, durationS });
  }

  /** Whether the app believes a static image is shown on the device. */
  isImageShown(): boolean {
    return this.imageActive !== null;
  }

  /**
   * The duration of image `seq` has passed: send the command of the known mode again (as the countdown stop does), which
   * ends the image. Nothing is sent when the link is down or no mode is known. Never rejects.
   */
  private async expireImage(seq: number): Promise<void> {
    if (this.stopped || this.imageActive?.seq !== seq) return;
    const { displaySeq } = this.imageActive;
    this.clearImage();
    if (this.link.state !== 'connected') {
      this.log('image duration over: not connected, nothing re-sent');
      return;
    }
    // A mode change, text or countdown that is still being sent will replace the image by itself; a mode re-send now could
    // undo it (the known mode is not yet the new one).
    if (this.channelInFlight > 0 || this.textSending > 0 || this.displaySeq !== displaySeq) {
      this.log('image duration over: another display command is in flight, nothing re-sent');
      return;
    }
    const mode = this.getChannel();
    if (mode === null) {
      this.log('image duration over: no known mode to restore');
      return;
    }
    try {
      await this.sendMode(mode);
      this.log(`image ended (duration): mode ${mode} re-sent`);
    } catch (e) {
      this.log(`image ended (duration): mode re-send failed: ${errorText(e)}`);
    }
  }

  /**
   * A display command (mode change, power off, text, countdown) ended the image on the device: forget it, nothing is sent.
   * Only an image queued before the command (`imageAtSend`) is ended; one confirmed later by `showImage` is told through
   * `imageEndedSeq`.
   */
  private imageEndedByCommand(reason: string, imageAtSend: number): void {
    this.imageEndedSeq = Math.max(this.imageEndedSeq, imageAtSend);
    if (this.imageActive === null || this.imageActive.seq > imageAtSend) return;
    this.clearImage();
    this.log(`image ended (${reason})`);
  }

  /** Forget the shown image and its timer (nothing is sent). */
  private clearImage(): void {
    if (this.imageActive?.timer) clearTimeout(this.imageActive.timer);
    this.imageActive = null;
    this.imageShadow = null;
  }

  /** A mode change or power off ended the noise meter on the device: forget it, nothing is sent. */
  private noiseEnded(reason: string): void {
    if (!this.noiseActive) return;
    this.noiseActive = false;
    this.noiseShadow = null;
    this.log(`noise meter ended (${reason})`);
  }

  /**
   * A pending small-clock re-send (#88) would arrive after a text or countdown that is sent now and end it (a `45` command
   * does): take it out of the timer and return it to send ahead of the new frames, in the same queue (the clock under the
   * text or countdown then already has its face when that ends). Null when none is pending or it no longer applies. `what`
   * only words the log.
   */
  private takeClockResendAhead(what: 'text' | 'countdown' | 'image'): Uint8Array | null {
    const resend = this.clockResendCommand;
    if (resend === null) return null;
    const origin = this.clockResendOrigin ?? 'unknown';
    this.cancelClockResend();
    // Same guard as `resendClock`: only while the panel is on and the clock is still the known mode.
    if (this.power && this.getChannel() === 'clock') {
      this.log(`clock face re-sent before the ${what} (small from ${origin}): ${toHex(resend)}`);
      return resend;
    }
    this.log(`clock face re-send dropped before the ${what}: mode changed`);
    return null;
  }

  /** Forget the running text and its timer (nothing is sent). */
  private clearText(): void {
    if (this.textActive?.timer) clearTimeout(this.textActive.timer);
    this.textActive = null;
  }

  /**
   * Queue every frame at once (the link keeps their order and nothing else slips in between), then wait for all of them
   * with the send time limit of `sendBounded`.
   */
  private async sendAllBounded(frames: Uint8Array[]): Promise<void> {
    const sendings = frames.map((frame) => this.link.send(frame));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new NotConnectedError(`send did not complete within ${this.textSendTimeoutMs} ms`)),
        this.textSendTimeoutMs,
      );
    });
    try {
      await Promise.race([Promise.all(sendings), timeout]);
    } finally {
      clearTimeout(timer);
      for (const sending of sendings) sending.catch(() => undefined); // late rejections of abandoned writes
    }
  }

  /**
   * The origin of the clock re-send of a switch into the small clock, or null if none is needed: a re-send that is still
   * pending is carried over (the newer switch cancels it and schedules its own), then off or another mode than the
   * clock, then an earlier switch that is still being sent (the known channel may be stale; an extra re-send in clock
   * mode is harmless, protocol section 5.1). Null when the clock is shown and nothing is in flight.
   */
  private resendOrigin(): string | null {
    if (this.clockResendTimer !== null && this.clockResendOrigin !== null) return this.clockResendOrigin;
    if (!this.power || this.getChannel() !== 'clock') return this.originName();
    return this.channelInFlight > 0 ? 'pending' : null;
  }

  /** Where the device is coming from, for the log of the clock re-send: off, the other mode, the known channel. */
  private originName(): string {
    if (!this.power) return 'off';
    if (this.otherModeCode !== null) return otherModeName(this.otherModeCode) ?? `code ${this.otherModeCode}`;
    return this.knownChannel ?? 'unknown';
  }

  private cancelClockResend(): void {
    if (this.clockResendTimer !== null) clearTimeout(this.clockResendTimer);
    this.clockResendTimer = null;
    this.clockResendOrigin = null;
    this.clockResendCommand = null;
  }

  private scheduleClockResend(command: Uint8Array, from: string, textAtSend: number): void {
    this.cancelClockResend();
    if (this.stopped) return;
    this.clockResendOrigin = from;
    this.clockResendCommand = command;
    this.clockResendTimer = setTimeout(() => {
      this.clockResendTimer = null;
      this.clockResendOrigin = null;
      this.clockResendCommand = null;
      void this.resendClock(command, from, textAtSend);
    }, this.clockResendMs);
  }

  /**
   * Send the clock command of the small style once more (#88): a `45 00 ... 06` that arrives from lighting or from off shows
   * the default dial although `46` reports small; a second one in clock mode applies it (protocol section 5.1). No
   * confirm, no state or tile write, never rejects. Skipped if the panel is off or not in the clock any more, or the link is down.
   */
  private async resendClock(command: Uint8Array, from: string, textAtSend: number): Promise<void> {
    if (this.stopped) return;
    if (this.textSeq !== textAtSend) {
      this.log('clock face re-send skipped: a text, countdown or stop was queued');
      return;
    }
    if (!this.power || this.getChannel() !== 'clock') {
      this.log('clock face re-send skipped: mode changed');
      return;
    }
    if (this.link.state !== 'connected') {
      this.log('clock face re-send skipped: not connected');
      return;
    }
    this.channelInFlight++;
    try {
      await this.sendBounded(command);
      this.log(`clock face re-sent (small from ${from}): ${toHex(command)}`);
    } catch (e) {
      this.log(`clock face re-send failed: ${errorText(e)}`);
    } finally {
      this.channelInFlight--;
    }
  }

  /**
   * The two steps of the Flow action "Show custom page": `45 05`, then `bd 17 PP` (no documented reply). The page
   * command is only accepted once the custom channel is shown, so the `45 55 05` acknowledgement is awaited first (up to
   * `channelConfirmMs`): only a successful `45` reply whose data is `05` counts, a late `45 55 02` or a failed `45` does not
   * (`ConnectionManager.request` would match any `45` frame). Without it the page is sent anyway
   * (`custom page: no 45 ack, sending the page anyway`). Resolves `false`, without sending the page, if a newer change
   * superseded this one meanwhile (the page would override the newer channel); the caller then touches no state.
   */
  private async sendCustomPage(
    channelCmd: Uint8Array,
    pageCmd: Uint8Array,
    generation: number,
    page: number,
  ): Promise<boolean> {
    const acked = this.waitForReply((r) => r.cmd === 0x45 && r.ok && r.data[0] === channelCode('custom'));
    try {
      await this.sendBounded(channelCmd);
      this.log(`channel -> custom: ${toHex(channelCmd)}`);
      if (!(await acked.promise)) this.log('custom page: no 45 ack, sending the page anyway');
    } finally {
      acked.cancel();
    }
    if (this.stopped) throw new Error(this.messages.notConnected);
    if (generation !== this.channelGeneration) return false;
    await this.sendBounded(pageCmd);
    this.log(`custom page -> ${page + 1}: ${toHex(pageCmd)}`);
    return true;
  }

  /**
   * Wait (up to `channelConfirmMs`) for a device frame that `matches`; resolves `true` on it, `false` on the timeout.
   * Like `link.request` it rejects with the readable `not_connected` error as soon as the link is lost (`disconnected`
   * event) or the controller is stopped, so a new session never gets the page of the old one. Registered synchronously,
   * so call it before the write whose answer it waits for. `cancel` removes the listeners and the timer (always call it).
   */
  private waitForReply(matches: (reply: Reply) => boolean): { promise: Promise<boolean>; cancel: () => void } {
    let finish: (seen: boolean) => void = () => undefined;
    let fail: (e: Error) => void = () => undefined;
    const promise = new Promise<boolean>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    promise.catch(() => undefined); // a rejection before anybody awaits it is not an unhandled rejection
    const onReply = (reply: Reply): void => {
      if (matches(reply)) finish(true);
    };
    const abort = (): void => fail(new Error(this.messages.notConnected));
    const timer = setTimeout(() => finish(false), this.channelConfirmMs);
    this.link.on('reply', onReply);
    this.link.on('disconnected', abort);
    this.ackWaits.add(abort);
    return {
      promise,
      cancel: () => {
        clearTimeout(timer);
        this.link.off('reply', onReply);
        this.link.off('disconnected', abort);
        this.ackWaits.delete(abort);
      },
    };
  }

  /**
   * An unsolicited `71` frame: `71 55 03 01 01 00` is the end of a countdown (protocol section 5.6) and fires the trigger
   * once per frame, whatever the app thinks it shows (the countdown may be hidden, or started outside Homey). The mode
   * and the tiles do not change, with one exception: with the panel off the end display lights it, so `onoff` follows
   * (`panelLitByCountdownEnd`) before the trigger fires. Every other `71` frame is only logged.
   */
  private countdownReport(reply: Reply): void {
    if (this.stopped) return;
    if (isCountdownEnd(reply)) {
      this.log('countdown ended (device)');
      if (!this.power) this.panelLitByCountdownEnd();
      this.call(() => this.surface.onCountdownEnded());
    } else {
      this.log(`countdown: unknown 71 frame ${['71', reply.ok ? '55' : 'xx', toHex(reply.data)].join(' ').trim()}`);
    }
  }

  /**
   * The end of a countdown while the app thinks the panel is off: the end display (`00:00`) lights the panel and it
   * stays lit (protocol/countdown.md P6, P7, P11), so `onoff` becomes true and the off shadow is dropped. A `46` query
   * then lets the normal status path align the mode tile, the colour tile and the "mode changed" trigger with d0. A
   * power change in flight (`channelInFlight`) decides the power itself and is left alone.
   */
  private panelLitByCountdownEnd(): void {
    if (this.channelInFlight > 0) {
      this.log('countdown end: panel lit, power left to the change in flight');
      return;
    }
    this.power = true;
    this.offShadow = null;
    this.log('power <- device: on (countdown end display)');
    this.call(() => this.surface.setOnOff(true));
    this.applyPendingBrightness();
    void this.syncAfterCountdownEnd();
  }

  /** Query the status once after a countdown end lit the panel; its reply is handled by `onStatus` (a failure is only logged). */
  private async syncAfterCountdownEnd(): Promise<void> {
    try {
      await this.link.request(queryStatus(), 0x46, this.channelConfirmMs);
    } catch (e) {
      if (e instanceof RequestTimeoutError) this.log('countdown end: status sync timeout');
      else this.log(`countdown end: status sync failed: ${errorText(e)}`);
    }
  }

  /**
   * Ask the device for the custom page (`bd 17 ff`) and compare it with the one that was requested. A mismatch is only logged
   * (null). If the device does not answer or answers wrongly (#151) the failure is returned, as for the `46` confirm.
   */
  private async confirmCustomPage(requested: number): Promise<'unconfirmed' | 'lost' | null> {
    try {
      const device = decodeCustomPage(
        await this.link.request(queryCustomPage(), 0xbd, this.channelConfirmMs, isCustomPageReply),
      );
      if (device === requested) this.log(`custom page confirmed: ${requested + 1}`);
      else {
        const shown = device >= 0 && device <= MAX_CUSTOM_PAGE ? device + 1 : `code ${hexByte(device)}`;
        this.log(`custom page mismatch: device ${shown}, requested ${requested + 1}`);
      }
      return null;
    } catch (e) {
      if (e instanceof RequestTimeoutError) this.log('custom page confirm timeout');
      else this.log(`custom page confirm failed: ${errorText(e)}`);
      return this.confirmFailure(e);
    }
  }

  /** Compare the lighting colour (`46` d3..d5) the device reports with the colour that was requested (log only). */
  private confirmLighting(status: DeviceStatus, requested: Rgb): void {
    const c = status.lightingColor;
    if (c.r === requested.r && c.g === requested.g && c.b === requested.b) {
      this.log(`lighting confirmed: ${formatHexColor(requested)}`);
    } else {
      this.log(`lighting mismatch: device ${formatHexColor(c)}, requested ${formatHexColor(requested)}`);
    }
  }

  /** The off path of `setPower`: send the power-off command, then confirm with `46` and remember the d0 code the device shows. */
  private async powerOff(): Promise<void> {
    const command = powerOffCommand(this.lastStatus, this.knownBrightness, this.knownColor);
    if (this.stopped || this.link.state !== 'connected') throw new Error(this.messages.notConnected);

    const generation = ++this.channelGeneration;
    this.offGeneration = generation;
    const textAtSend = this.textSeq;
    const imageAtSend = this.imageSeq;
    this.cancelClockResend();
    this.channelInFlight++;
    try {
      try {
        await this.sendBounded(command);
      } catch (e) {
        if (e instanceof NotConnectedError || e instanceof LinkLostError) throw new Error(this.messages.notConnected);
        throw e;
      }
      this.textEndedByCommand('power off', textAtSend);
      this.imageEndedByCommand('power off', imageAtSend);
      this.noiseEnded('power off');
      this.log(`power -> off: ${toHex(command)}`);
      this.power = false;
      this.offShadow = null;
      if (generation !== this.channelGeneration) {
        this.log('power off superseded by a newer change');
        return;
      }
      // The d0 the device reports after the off command is `01` (hardware-verified, protocol section 3). If the confirm
      // fails that is the shadow too: the pre-off d0 would make the next poll look like a switch on at the device.
      let reported = channelCode('lighting');
      let failure: 'unconfirmed' | 'lost' | null = null;
      try {
        reported = decodeStatus(await this.link.request(queryStatus(), 0x46, this.channelConfirmMs)).channel;
        const shown = channelFromCode(reported) ?? otherModeName(reported) ?? `code ${reported}`;
        this.log(`power off: device reports ${shown}`);
      } catch (e) {
        if (e instanceof RequestTimeoutError) this.log('power off confirm timeout');
        else this.log(`power off confirm failed: ${errorText(e)}`);
        failure = this.confirmFailure(e);
      }
      if (generation !== this.channelGeneration) {
        this.log('power off superseded by a newer change');
        return;
      }
      if (!this.power) this.offShadow = reported;
      if (failure !== null) {
        // Homey does not store the value of a rejected listener: align the tile with the optimistic power state (#151).
        if (!this.stopped) this.call(() => this.surface.setOnOff(false));
        throw new Error(failure === 'lost' ? this.messages.notConnected : this.messages.notConfirmed);
      }
    } finally {
      this.channelInFlight--;
      // The off failed before it was sent: the panel stays on, so a dim held meanwhile goes out now.
      if (this.power) this.applyPendingBrightness();
    }
  }

  /** Compare the style (`46` d15) and colour (d12..d14) the device reports with the face that was requested (log only). */
  private confirmClockFace(status: DeviceStatus, face: ClockFace): void {
    const requested = `style ${clockStyleId(face.style) ?? face.style} colour ${formatHexColor(face.color)}`;
    const c = status.clockColor;
    if (status.clockStyle === face.style && c.r === face.color.r && c.g === face.color.g && c.b === face.color.b) {
      this.log(`clock face confirmed: ${requested}`);
    } else {
      this.log(
        `clock face mismatch: device style ${status.clockStyle} colour ${formatHexColor(c)}, requested ${requested}`,
      );
    }
  }

  /**
   * Set the "hot" flag (`26 0X`, #106): `true` lets the clock rotate through animation pages, `false` leaves only the time and
   * the pages of the page flags. A persistent device setting, so it is sent ahead of every clock frame and once per session.
   * Never throws: a failure is logged and the caller carries on (the clock frame that follows decides the outcome).
   */
  private async sendHot(animations: boolean, origin: 'switch' | 'connect'): Promise<void> {
    try {
      const command = setHot(animations);
      await this.sendBounded(command);
      this.log(`clock animations -> ${animations ? 'on' : 'off'}: ${toHex(command)} (${origin})`);
    } catch (e) {
      this.log(`clock animations not set: ${errorText(e)}`);
    }
  }

  /**
   * First status of a session: set the animation flag once, because the device may show the clock from before without a
   * clock switch. Only while the device reports the clock (`getChannel() === 'clock'`) and the panel is on: the effect of `26`
   * was measured in the clock view, in lighting and with the panel off only (protocol section 5.1), so no other mode is touched
   * (every later switch to the clock sets it anyway). Not while a switch or a native text is in progress (a switch to the clock
   * sends it itself, and the effect of `26` on a running text was not measured).
   */
  private async sendHotAtConnect(): Promise<void> {
    if (this.stopped || !this.power || this.getChannel() !== 'clock') return;
    if (this.channelInFlight > 0 || this.textActive !== null || this.textSending > 0) return;
    if (this.imageActive !== null || this.imageSending > 0) return;
    await this.sendHot(this.clockSettings.animations, 'connect');
  }

  /** `link.send` with a time limit: a hung write rejects with `NotConnectedError` instead of hanging the capability. */
  private async sendBounded(frame: Uint8Array): Promise<void> {
    const sending = this.link.send(frame);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new NotConnectedError(`send did not complete within ${this.sendTimeoutMs} ms`)),
        this.sendTimeoutMs,
      );
    });
    try {
      await Promise.race([sending, timeout]);
    } finally {
      clearTimeout(timer);
      sending.catch(() => undefined); // a late rejection of the abandoned write is not an unhandled rejection
    }
  }

  // --- weather (#30) ----------------------------------------------------------------------------------------------

  /**
   * Set the weather the Timebox shows (`5f TT WW`): from the Flow cards or from Open-Meteo, the newest value wins. The
   * update may hold only the temperature or only the condition; it is merged into the stored weather (a part never set
   * is 0 °C / clear, see `mergeWeather`). The weather is state, not a one-shot command: it is stored and resolves at
   * once; if it cannot be sent yet (not connected, panel off, native text running) it is held and sent as soon as it can
   * (the first status of a session, the 60 s check); several held updates are sent as one merged frame. Never rejects
   * for an offline Timebox. Rejects with a `RangeError` for an empty update or an invalid temperature or condition
   * (nothing is stored then). A send failure is logged, the value stays pending.
   */
  async setWeather(update: WeatherUpdate, source: WeatherSource): Promise<void> {
    const merged = mergeWeather(this.weather, update); // validates first: a RangeError stores and sends nothing
    if (this.stopped) return;
    const parts = (update.temperatureC !== undefined ? 1 : 0) + (update.condition !== undefined ? 1 : 0);
    this.weather = merged;
    this.weatherLabel =
      parts === 2 ? source : `${source} ${update.temperatureC !== undefined ? 'temperature' : 'condition'}`;
    this.weatherPending = true;
    this.weatherVersion++;
    const hold = this.weatherHold();
    if (hold !== null) {
      this.log(`weather held (${hold}): ${this.weatherLabel}`);
      return;
    }
    await this.flushWeather(this.weatherLabel);
  }

  /** Why the weather cannot be sent now, or null if it can. */
  private weatherHold(): string | null {
    if (this.online !== true || !this.answered || this.link.state !== 'connected') return 'not connected';
    if (!this.power) return 'panel off';
    if (this.textActive !== null || this.textSending > 0) return 'text running';
    if (this.imageActive !== null || this.imageSending > 0) return 'image shown';
    if (this.noiseActive) return 'noise meter shown';
    return null;
  }

  /**
   * Send the stored weather if it is pending and nothing holds it back; silent otherwise. A value that arrives while one is
   * being sent is sent behind it. Never rejects.
   */
  private async flushWeather(origin: string): Promise<void> {
    if (this.stopped || !this.weatherPending || this.weather === null || this.weatherSending) return;
    if (this.weatherHold() !== null) return;
    this.weatherSending = true;
    let label = origin;
    try {
      for (;;) {
        const version = this.weatherVersion;
        const session = this.weatherSession;
        const weather = this.weather;
        if (weather === null) return;
        const command = weatherCommand(weather);
        let sentOk = false;
        try {
          await this.sendBounded(command);
          sentOk = true;
        } catch (e) {
          this.log(`weather send failed: ${errorText(e)}`);
        }
        if (this.stopped) return;
        if (sentOk) {
          this.log(`weather -> ${weather.temperatureC} °C ${weather.condition} (${label}): ${toHex(command)}`);
          // Only a send of the current session counts: after a reconnect the new session still needs the weather.
          if (version === this.weatherVersion && session === this.weatherSession) {
            this.weatherPending = false;
            return;
          }
        } else if (session === this.weatherSession) {
          return; // stays pending: the next status or check tries again
        }
        // A newer value arrived or a new session started during the send (its own flush was skipped while this one ran).
        if (!this.weatherPending || this.weatherHold() !== null) return;
        label = session !== this.weatherSession ? 'connect' : this.weatherLabel;
      }
    } finally {
      this.weatherSending = false;
    }
  }

  // --- time sync --------------------------------------------------------------------------------------------------

  /**
   * Apply the `time_sync` setting. Switching it on while the Timebox is online syncs at once; switching it off only
   * stops the automatic syncs.
   */
  setTimeSyncEnabled(on: boolean): void {
    const was = this.timeSyncEnabled;
    this.timeSyncEnabled = on;
    if (on && !was && !this.stopped && this.online === true && this.answered && this.link.state === 'connected') {
      this.autoSync('setting');
    }
  }

  /** Every 60 s: is an automatic sync due (retry, time zone or UTC offset change, 24 h)? Costs no BLE traffic if not. */
  private timeCheck(): void {
    if (this.stopped || !this.timeSyncEnabled || this.syncing) return;
    if (this.online !== true || !this.answered || this.link.state !== 'connected') return;
    const nowMs = this.now();
    // A failure waits for its retry delay before anything else is computed (an invalid zone is not logged every minute).
    if (this.lastFailureAtMs !== null && nowMs - this.lastFailureAtMs < SYNC_RETRY_MS) return;
    let reason;
    try {
      const zone = this.surface.timeZone();
      reason = autoSyncReason(this.lastSync, nowMs, zone, utcOffsetMinutes(nowMs, zone), this.lastFailureAtMs);
    } catch (e) {
      this.lastFailureAtMs = nowMs; // same back-off as a failed sync
      this.log(`time sync failed: ${errorText(e)}`);
      return;
    }
    if (reason) this.autoSync(reason);
  }

  /** An automatic sync: a failure is logged (and retried later), never propagated. */
  private autoSync(reason: string): void {
    this.runSync(reason).catch(() => undefined);
  }

  private runSync(reason: string): Promise<void> {
    if (this.syncing) return this.syncing;
    const sync: Promise<void> = this.doSync(reason).finally(() => {
      if (this.syncing === sync) this.syncing = null;
    });
    this.syncing = sync;
    return sync;
  }

  /** Send `18` with the local time. Logs the outcome; rejects if the time could not be sent. */
  private async doSync(reason: string): Promise<void> {
    const atMs = this.now();
    try {
      const zone = this.surface.timeZone();
      const offsetMin = utcOffsetMinutes(atMs, zone);
      const parts = localDateTimeParts(atMs, zone);
      try {
        const reply = await this.link.request(setDateTime(parts), 0x18, this.timeConfirmMs);
        if (!reply.ok) throw new Error('the Timebox rejected the time');
      } catch (e) {
        if (!(e instanceof RequestTimeoutError)) throw e;
        this.log('time sync not confirmed'); // no `18 55` in time: the Evo may not acknowledge it, or the write did not complete
      }
      this.lastSync = { atMs, zone, offsetMin };
      this.lastFailureAtMs = null;
      this.log(`time synced (${reason}): ${formatSync(parts, zone, offsetMin)}`);
    } catch (e) {
      if (this.stopped) throw e; // interrupted by stop(): not a failure
      this.lastFailureAtMs = this.now();
      this.log(`time sync failed: ${errorText(e)}`);
      throw e;
    }
  }

  // --- availability -----------------------------------------------------------------------------------------------

  /** The first status reply of a session: the Timebox answers, so it is available (and the grace period is over). */
  private sessionAnswered(): void {
    if (this.stopped) return;
    this.answered = true;
    this.clearGrace();
    if (this.online === true) return;
    const previous = this.online;
    this.online = true;
    this.permanentUnavailable = false;
    this.log('available');
    this.call(() => this.surface.setAvailable());
    // The first decision after startup is not a change: no trigger.
    if (previous !== null) this.call(() => this.surface.onOnlineChanged(true));
  }

  private armGrace(): void {
    if (this.stopped || this.graceTimer || this.online === false) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.graceExpired();
    }, this.graceMs);
  }

  private clearGrace(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  private graceExpired(): void {
    if (this.stopped || this.online === false) return;
    if (this.answered && this.link.state === 'connected') return;
    this.markUnavailable(this.messages.unreachable, this.lastReason);
  }

  private permanentFailure(reason: string): void {
    this.clearGrace();
    if (this.stopped || this.permanentUnavailable) return;
    this.permanentUnavailable = true;
    this.markUnavailable(this.messages.notTimebox, `${reason} (permanent)`);
  }

  private markUnavailable(message: string, reason: string): void {
    const previous = this.online;
    this.online = false;
    this.log(`unavailable: ${reason}`);
    this.call(() => this.surface.setUnavailable(message));
    // Only a device that was online has "disconnected"; one that never connected has not changed state.
    if (previous === true) this.call(() => this.surface.onOnlineChanged(false));
  }

  // --- status sync ------------------------------------------------------------------------------------------------

  /** A brightness the device reported (`46` status, `31` report): copy it to `dim` if it is news. */
  private deviceBrightness(raw: number): void {
    if (this.stopped || this.inFlight > 0) return;
    const clamped = clampBrightness(raw, (value) => this.log(`device brightness ${value} out of range, clamped`));
    if (clamped === this.knownBrightness) return;
    if (this.pendingBrightness !== null) {
      // A dim is held while off (#62): the tile shows it, so the device value is only remembered, not copied to `dim`.
      this.knownBrightness = clamped;
      return;
    }
    this.knownBrightness = clamped;
    this.log(`dim <- device: ${clamped}`);
    this.call(() => this.surface.setDim(brightnessToDim(clamped)));
  }

  /**
   * The mode (`46` d0) the device reported: copy it to the tile if it is news. The first value of a run only sets the
   * tile; a later change also fires the trigger. A removed mode (`02` cloud, `04` visualizer) clears the tile once and
   * fires nothing; coming back to an offered mode writes the tile and fires the trigger even if it is the mode from
   * before. Any other code (text, games, alarms, ...) leaves the tile unchanged and is logged once per new code.
   */
  private deviceChannel(code: number): boolean {
    if (this.stopped || this.channelInFlight > 0) return false;
    // A shown image is not a mode, and what `44` does to d0 is unmeasured (protocol section 4): the first report after the
    // image is its shadow and reports equal to it are ignored; a different known code means the device left the image.
    if (this.imageActive !== null || this.imageSending > 0) {
      if (this.imageSending > 0) return false; // the report may predate the image
      if (this.imageShadow === null) {
        this.imageShadow = code;
        this.log(`image shadow: device reports channel code ${hexByte(code)}`);
        return false;
      }
      if (code === this.imageShadow || (channelFromCode(code) === null && otherModeName(code) === null)) return false;
      this.log(`image ended (device mode change): channel code ${hexByte(this.imageShadow)} -> ${hexByte(code)}`);
      this.clearImage();
    }
    const id = channelFromCode(code);
    const other = otherModeName(code);
    if (!this.power) {
      // Off: the device reports the "off shadow" code (adopted from the first report at a startup from off). Another
      // known code (a mode or a removed mode) means the panel was switched on at the device.
      this.offShadow ??= code;
      if (code === this.offShadow || (!id && !other)) {
        if (!id && !other) this.logUnknownCode(code);
        return false;
      }
      this.power = true;
      this.offShadow = null;
      this.log('power <- device: on');
      this.call(() => this.surface.setOnOff(true));
      this.applyPendingBrightness();
    }
    if (this.noiseActive && this.power) {
      // The noise meter is not a `45` mode and the code `46` reports under it is unmeasured: the first report is its shadow,
      // equal reports and codes that are no mode are ignored, a different known code means the device left the noise meter.
      if (this.noiseShadow === null) {
        this.noiseShadow = code;
        this.log(`noise meter shadow: device reports channel code ${hexByte(code)}`);
        return false;
      }
      if (code === this.noiseShadow || (!id && !other)) return false;
      this.log(`noise meter ended (device mode change): channel code ${hexByte(this.noiseShadow)} -> ${hexByte(code)}`);
      this.noiseActive = false;
      this.noiseShadow = null;
    }
    if (other) {
      this.unknownCode = null;
      this.enterOtherMode(code, other);
      return false;
    }
    if (!id) {
      this.logUnknownCode(code);
      return false;
    }
    this.unknownCode = null;
    const leftOtherMode = this.otherModeCode !== null;
    if (!leftOtherMode && id === this.knownChannel) return false;
    const previous = this.knownChannel;
    this.knownChannel = id;
    this.otherModeCode = null;
    this.log(`channel <- device: ${id}`);
    this.call(() => this.surface.setChannel(id));
    // The colour tile shows the colour of the mode that is shown now (the first status of a run included).
    const wroteTile = this.writeTile(this.modeColor(id));
    if (previous !== null || leftOtherMode) this.call(() => this.surface.onChannelChanged(id));
    return wroteTile;
  }

  /** The device shows a mode that is not offered: clear the tile once, log once per new code, fire nothing. */
  private enterOtherMode(code: number, name: string): void {
    if (this.otherModeCode === code) return;
    const entering = this.otherModeCode === null;
    this.otherModeCode = code;
    this.log(`channel <- device: ${name} (mode not offered), tile cleared`);
    if (entering) this.call(() => this.surface.clearChannel());
  }

  /**
   * The lighting colour (`46` d3..d5) the device reported: remember it if it is news (never black, no echo of our own
   * command). It is only a memory here, the colour tile shows it while the lighting mode is shown (`onStatus`, mode change).
   * Returns whether the known lighting colour changed.
   */
  private deviceColor(color: Rgb): boolean {
    if (this.stopped || this.channelInFlight > 0) return false;
    if (rgbIsBlack(color)) return false;
    const known = this.knownColor;
    if (known && sameColor(known, color)) return false;
    this.knownColor = color;
    this.log(`colour <- device: ${formatHexColor(color)}`);
    return true;
  }

  // --- helpers ----------------------------------------------------------------------------------------------------

  /** The complete clock face: the settings plus the stored clock colour. */
  private clockFace(): ClockFace {
    return { ...this.clockSettings, hour24: CLOCK_HOUR24, color: this.clockColor };
  }

  /** The clock face that is shown: the settings, but with the style of the last "Show clock" while it is kept. */
  private shownFace(): ClockFace {
    return { ...this.clockFace(), style: this.clockStyleOverride ?? this.clockSettings.style };
  }

  /** Set the shown clock style (null = the style of the settings) and persist it if it changed. */
  private setShownStyle(style: number | null): void {
    if (style === this.clockStyleOverride) return;
    this.clockStyleOverride = style;
    this.call(() => this.surface.saveShownClockStyle(style));
  }

  /** The colour the tile shows for a mode: the clock colour, the lighting colour, none for custom. */
  private modeColor(mode: ChannelId): Rgb | null {
    if (mode === 'clock') return this.clockColor;
    if (mode === 'lighting') return this.knownColor;
    return null;
  }

  /** Write a colour to the colour tile (hue and saturation). Nothing for null or black (no hue to show); returns whether it wrote. */
  private writeTile(color: Rgb | null): boolean {
    const hueSat = color ? rgbToHueSat(color) : null;
    if (!hueSat) return false;
    this.call(() => this.surface.setLightColor(hueSat.hue, hueSat.saturation));
    return true;
  }

  /** Log a `46` d0 code that is not a known channel, once per new code. */
  private logUnknownCode(code: number): void {
    if (code === this.unknownCode) return;
    this.unknownCode = code;
    this.log(`channel code 0x${code.toString(16).padStart(2, '0')} is not a known channel, tile unchanged`);
  }

  /** Run a surface call; a throw or a rejection is logged, never propagated into the link logic. */
  private call(fn: () => void | Promise<void>): void {
    try {
      Promise.resolve(fn()).catch((e: unknown) => this.surface.error(`[device] surface call failed: ${errorText(e)}`));
    } catch (e) {
      this.surface.error(`[device] surface call failed: ${errorText(e)}`);
    }
  }

  private log(message: string): void {
    if (this.stopped) return; // e.g. a setDim still running when stop() was called
    this.surface.log(`[device] ${message}`);
  }
}
