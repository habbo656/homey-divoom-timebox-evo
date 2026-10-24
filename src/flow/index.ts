// Registration of Flow card listeners (docs/architecture.md, "Flow cards"). Homey is not imported: the Flow manager is
// described structurally (`FlowLike`) so the registration is unit tested with a fake.
import type Homey from 'homey';
import { localiseError } from '../device/argumentError';
import { parseChannelId, parseCustomPageId } from '../device/channel';
import type { ChannelId } from '../device/channel';
import { parseClockStyleId, parseHexColor } from '../device/clock';
import { parseCountdownArgs } from '../device/countdown';
import { parseImageFitId } from '../device/image';
import type { ImageFit } from '../device/image';
import { parseImageUrl } from '../device/imageSource';
import { parseTextDurationArg, parseTextSpeedId } from '../device/scrollText';
import type { TextRequest } from '../device/TimeboxController';
import { parseTemperatureArg, parseWeatherConditionId } from '../device/weather';
import type { WeatherUpdate } from '../device/weather';
import type { CountdownTime } from '../protocol/commands';
import type { Rgb } from '../protocol/status';

export const FLOW_TRIGGER_CONNECTED = 'timebox_connected';
export const FLOW_TRIGGER_DISCONNECTED = 'timebox_disconnected';
export const FLOW_TRIGGER_CHANNEL_CHANGED = 'timebox_channel_changed';
export const FLOW_TRIGGER_COUNTDOWN_ENDED = 'timebox_countdown_ended';
export const FLOW_CONDITION_IS_CONNECTED = 'timebox_is_connected';
export const FLOW_CONDITION_CHANNEL_IS = 'timebox_channel_is';
export const FLOW_ACTION_SET_CHANNEL = 'timebox_set_channel';
export const FLOW_ACTION_SHOW_CLOCK = 'timebox_show_clock';
export const FLOW_ACTION_SET_LIGHTING = 'timebox_set_lighting';
export const FLOW_ACTION_SHOW_CUSTOM_PAGE = 'timebox_show_custom_page';
export const FLOW_ACTION_SHOW_TEXT = 'timebox_show_text';
export const FLOW_ACTION_STOP_TEXT = 'timebox_stop_text';
export const FLOW_ACTION_START_COUNTDOWN = 'timebox_start_countdown';
export const FLOW_ACTION_STOP_COUNTDOWN = 'timebox_stop_countdown';
export const FLOW_ACTION_SHOW_IMAGE = 'timebox_show_image';
export const FLOW_ACTION_SHOW_IMAGE_URL = 'timebox_show_image_url';
export const FLOW_ACTION_SET_WEATHER = 'timebox_set_weather';
export const FLOW_ACTION_SET_TEMPERATURE = 'timebox_set_temperature';

/** What the condition needs from the device argument. */
export interface ConnectableDevice {
  isConnected(): boolean;
}

/** What the condition "channel is" needs from the device argument. */
export interface ChannelReadableDevice {
  /** The channel the device is on, or null while unknown. */
  getChannel(): ChannelId | null;
}

/** What the action "Switch channel" needs from the device argument. */
export interface ChannelSwitchableDevice {
  /** Switches the Timebox to the channel; rejects with a readable error if that is not possible. */
  switchChannel(id: ChannelId): Promise<void>;
}

/** What the action "Show clock" needs from the device argument. */
export interface ClockShowableDevice {
  /** Switches the Timebox to the clock with this device style number and colour; rejects with a readable error if that is not possible. */
  showClock(style: number, color: Rgb): Promise<void>;
}

/** The arguments of the action "Show clock": the style dropdown id and the colour (`#RRGGBB`), both validated before use. */
export interface ShowClockArgs {
  style: unknown;
  color: unknown;
}

/** What the action "Set lighting" needs from the device argument. */
export interface LightingSettableDevice {
  /** Switches the Timebox to the lighting channel with this colour and turns it on; rejects with a readable error if that is not possible. */
  setLighting(color: Rgb): Promise<void>;
}

/** The argument of the action "Set lighting": the colour (`#RRGGBB`), validated before use. A stale `effect` argument of an old Flow is ignored. */
export interface SetLightingArgs {
  color: unknown;
}

/** What the action "Show custom page" needs from the device argument. */
export interface CustomPageShowableDevice {
  /** Switches the Timebox to the custom channel with this device page (0..2) and turns it on; rejects with a readable error if that is not possible. */
  showCustomPage(page: number): Promise<void>;
}

/** The argument of the action "Show custom page": the dropdown id (`"1"`..`"3"`), validated before use. */
export interface ShowCustomPageArgs {
  page: unknown;
}

/** What the action "Show text" needs from the device argument. */
export interface TextShowableDevice {
  /** Scrolls the text (native text, not a mode); rejects with a readable error if that is not possible. */
  showText(request: TextRequest): Promise<void>;
}

/** The arguments of the action "Show text": all validated before use (the text is cleaned by the device). */
export interface ShowTextArgs {
  text: unknown;
  color: unknown;
  background: unknown;
  speed: unknown;
  duration: unknown;
}

/** What the actions "Show image" and "Show image from URL" need from the device argument. */
export interface ImageShowableDevice {
  /** Downloads the picture at `url` (validated) and shows it as an overlay; rejects with a readable error if that is not possible. */
  showImageFromUrl(url: string, fit: ImageFit, durationS: number): Promise<void>;
  /** Shows the image of the dropped image token (`droptoken`) as an overlay; rejects with a readable error if that is not possible. */
  showImageToken(image: unknown, fit: ImageFit, durationS: number): Promise<void>;
}

/** The arguments of the action "Show image": the image token Homey passes as `droptoken`, the fit dropdown id and the duration. */
export interface ShowImageArgs {
  droptoken?: unknown;
  fit: unknown;
  duration: unknown;
}

/** The arguments of the action "Show image from URL": the address, the fit dropdown id and the duration. */
export interface ShowImageUrlArgs {
  url: unknown;
  fit: unknown;
  duration: unknown;
}

/** What the action "Stop text" needs from the device argument. */
export interface TextStoppableDevice {
  /** Ends the native text; rejects with a readable error if the Timebox is not connected. */
  stopText(): Promise<void>;
}

/** What the action "Start countdown" needs from the device argument. */
export interface CountdownStartableDevice {
  /** Starts the countdown overlay; rejects with a readable error for 0:00 or if the Timebox is not connected. */
  startCountdown(time: CountdownTime): Promise<void>;
}

/** The arguments of the action "Start countdown": minutes and seconds, validated before use. */
export interface StartCountdownArgs {
  minutes: unknown;
  seconds: unknown;
}

/** What the action "Stop countdown" needs from the device argument. */
export interface CountdownStoppableDevice {
  /** Ends the countdown; rejects with a readable error if the Timebox is not connected. */
  stopCountdown(): Promise<void>;
}

/** What the actions "Set temperature" and "Set weather" need from the device argument. */
export interface WeatherSettableDevice {
  /**
   * Merges the given part (temperature or condition) into the stored weather and sends it as soon as the Timebox can
   * show it; rejects only for invalid input.
   */
  setWeather(update: WeatherUpdate): Promise<void>;
}

/** The argument of the action "Set temperature": the temperature in °C, validated before use. */
export interface SetTemperatureArgs {
  temperature: unknown;
}

/** The argument of the action "Set weather": the condition dropdown id, validated before use. */
export interface SetWeatherArgs {
  condition: unknown;
}

/** The argument of the channel cards: a dropdown value (its id), validated before use. */
export interface ChannelArg {
  channel: unknown;
}

export interface FlowLike {
  getConditionCard(id: string): {
    registerRunListener<Args>(listener: (args: Args) => boolean | Promise<boolean>): unknown;
  };
  getActionCard(id: string): {
    registerRunListener<Args>(listener: (args: Args) => void | Promise<void>): unknown;
  };
}

/** Compile-time proof that `homey.flow` satisfies `FlowLike`; returns it unchanged. */
export function asFlow(flow: Homey.App['homey']['flow']): FlowLike {
  return flow;
}

/**
 * Wraps a run listener: an `ArgumentError` it throws (invalid input, also from the device) is rethrown as a plain `Error`
 * with the localised message, any other error unchanged. Homey shows the message of a rejected listener to the user.
 */
function localised<Args, Result>(
  translate: (key: string) => string,
  listener: (args: Args) => Result | Promise<Result>,
): (args: Args) => Promise<Result> {
  return async (args) => {
    try {
      return await listener(args);
    } catch (e) {
      throw localiseError(e, translate);
    }
  };
}

/** The same Flow manager, but every registered run listener is wrapped with `localised`. */
function localisedFlow(flow: FlowLike, translate: (key: string) => string): FlowLike {
  return {
    getConditionCard: (id) => ({
      registerRunListener: (listener) => flow.getConditionCard(id).registerRunListener(localised(translate, listener)),
    }),
    getActionCard: (id) => ({
      registerRunListener: (listener) => flow.getActionCard(id).registerRunListener(localised(translate, listener)),
    }),
  };
}

/**
 * Registers the run listeners of the Timebox cards. Triggers are fired by the device, they need no listener.
 * `translate` is `homey.__`: every listener reports an invalid argument localised, in the language of the user.
 */
export function registerTimeboxFlowCards(rawFlow: FlowLike, translate: (key: string) => string): void {
  const flow = localisedFlow(rawFlow, translate);
  flow
    .getConditionCard(FLOW_CONDITION_IS_CONNECTED)
    .registerRunListener(({ device }: { device: ConnectableDevice }) => device.isConnected());
  flow
    .getConditionCard(FLOW_CONDITION_CHANNEL_IS)
    .registerRunListener(({ device, channel }: { device: ChannelReadableDevice } & ChannelArg) => {
      return device.getChannel() === parseChannelId(channel);
    });
  flow
    .getActionCard(FLOW_ACTION_SET_CHANNEL)
    .registerRunListener(async ({ device, channel }: { device: ChannelSwitchableDevice } & ChannelArg) => {
      await device.switchChannel(parseChannelId(channel));
    });
  flow
    .getActionCard(FLOW_ACTION_SHOW_CLOCK)
    .registerRunListener(async ({ device, style, color }: { device: ClockShowableDevice } & ShowClockArgs) => {
      await device.showClock(parseClockStyleId(style), parseHexColor(color));
    });
  flow
    .getActionCard(FLOW_ACTION_SET_LIGHTING)
    .registerRunListener(async ({ device, color }: { device: LightingSettableDevice } & SetLightingArgs) => {
      await device.setLighting(parseHexColor(color));
    });
  flow
    .getActionCard(FLOW_ACTION_SHOW_CUSTOM_PAGE)
    .registerRunListener(async ({ device, page }: { device: CustomPageShowableDevice } & ShowCustomPageArgs) => {
      await device.showCustomPage(parseCustomPageId(page));
    });
  flow
    .getActionCard(FLOW_ACTION_SHOW_TEXT)
    .registerRunListener(
      async ({ device, text, color, background, speed, duration }: { device: TextShowableDevice } & ShowTextArgs) => {
        await device.showText({
          text,
          color: parseHexColor(color, 'text_color'),
          background: parseHexColor(background, 'background'),
          speed: parseTextSpeedId(speed),
          durationS: parseTextDurationArg(duration),
        });
      },
    );
  flow.getActionCard(FLOW_ACTION_STOP_TEXT).registerRunListener(async ({ device }: { device: TextStoppableDevice }) => {
    await device.stopText();
  });
  flow
    .getActionCard(FLOW_ACTION_SHOW_IMAGE)
    .registerRunListener(
      async ({ device, droptoken, fit, duration }: { device: ImageShowableDevice } & ShowImageArgs) => {
        await device.showImageToken(droptoken, parseImageFitId(fit), parseTextDurationArg(duration));
      },
    );
  flow
    .getActionCard(FLOW_ACTION_SHOW_IMAGE_URL)
    .registerRunListener(async ({ device, url, fit, duration }: { device: ImageShowableDevice } & ShowImageUrlArgs) => {
      await device.showImageFromUrl(parseImageUrl(url), parseImageFitId(fit), parseTextDurationArg(duration));
    });
  flow
    .getActionCard(FLOW_ACTION_START_COUNTDOWN)
    .registerRunListener(
      async ({ device, minutes, seconds }: { device: CountdownStartableDevice } & StartCountdownArgs) => {
        await device.startCountdown(parseCountdownArgs(minutes, seconds));
      },
    );
  flow
    .getActionCard(FLOW_ACTION_STOP_COUNTDOWN)
    .registerRunListener(async ({ device }: { device: CountdownStoppableDevice }) => {
      await device.stopCountdown();
    });
  flow
    .getActionCard(FLOW_ACTION_SET_WEATHER)
    .registerRunListener(async ({ device, condition }: { device: WeatherSettableDevice } & SetWeatherArgs) => {
      await device.setWeather({ condition: parseWeatherConditionId(condition) });
    });
  flow
    .getActionCard(FLOW_ACTION_SET_TEMPERATURE)
    .registerRunListener(async ({ device, temperature }: { device: WeatherSettableDevice } & SetTemperatureArgs) => {
      await device.setWeather({ temperatureC: parseTemperatureArg(temperature) });
    });
}
