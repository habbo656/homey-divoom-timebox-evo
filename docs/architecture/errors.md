# User-facing errors

_Part of [architecture](../architecture.md); moved from "User-facing errors (#108)" (#120)._

- **User-facing errors (#108)** (`src/device/argumentError.ts`, Homey-free): every error a user can see is localised (en + de).
  Input validation in the device layer (the parsers `parseTextSpeedId`, `parseTextDuration(Arg)`, `prepareText`, `parseCountdownArgs`,
  `parseTemperatureArg`, `parseWeatherConditionId`, `parseClockStyleId`, `parseHexColor(value, field)`, `parseChannelId`,
  `parseCustomPageId`, `hueSatToRgb`, `dimToBrightness`, `parseImageFitId`, `parseImageUrl`) throws an `ArgumentError`, a `RangeError` subclass with `kind`
  (`invalid_range`, `invalid_number`, `invalid_choice`, `invalid_color`, `invalid_text`, `invalid_url`), `field` (one of `ARGUMENT_FIELDS`, e.g.
  `duration`, `text_color`) and `params` (`value`, `min`, `max`, `allowed`, `type`). Its `message` stays the English text for logs.
  `localiseError(e, translate)` turns an `ArgumentError` into a plain `Error` with the text of `device.error.<kind>`, filled by
  `fillPlaceholders` with the params and `{field}` = `device.field.<field>` (the title of the card argument, so the message
  names what the user filled in; `src/manifest.test.ts` keeps them equal); the value is shown quoted for strings and cut after 32
  characters (`formatArgValue`), and the text content of "Show text" is never echoed. Any other error is returned unchanged.
  The mapping runs at the Homey boundary, once per throw, with `homey.__` (the current language): `registerTimeboxFlowCards`
  wraps every condition and action listener (also catching an `ArgumentError` thrown by the device), and `TimeboxDevice` wraps the
  `dim`, `light_hue` / `light_saturation` and `timebox_channel` capability listeners. The protocol builders (`src/protocol`) stay
  Homey-free and keep throwing plain `RangeError`s; they are a backstop, never the path to the user. Internal checks
  (`mergeWeather` without a part, `setPower` with a non-boolean, `brightnessToDim`) are plain `RangeError`s as well. The
  messages that are not argument errors (`not_connected`, `not_confirmed`, `text_empty`, `text_too_long`, `countdown_zero`) keep using `DeviceMessages`.
  `not_confirmed` (#141, #151): a display change (`switchTo`, see `modes.md`), a dim, a power off or a custom page read-back that the Timebox did not answer (`46`, or `bd 17 ff` for the page) within the confirm timeout. A link lost or `stop()` during that wait gives `not_connected` instead.
  Image errors (#31) are `ImageError`s (`src/device/imageError.ts`, kinds `unreachable`, `unreadable` (image tag), `too_large`, `unsupported`, `missing`; `params` `max_mb`, `max_mp`, `max_side`)
  and are localised by the same `localiseError` with `device.error.image_<kind>`. Their `message` is the real cause for the log (HTTP status, decoder
  message, never a URL path); the user sees only the localised text. The argument fields `fit` and `url` are labelled like the card arguments.

- **Pairing (#37):** the pairing view texts `scan_failed: {error}` and `add_failed: {error}` (`locales/*.json`, `pair.scan.*`) deliberately keep the raw cause
  (for example the Bluetooth error text) in parentheses as technical detail so a user can report it, and since #36 each is followed by
  an actionable sentence (check that the TimeBox is on, awake and close to the Homey and that Bluetooth works, close the Divoom app, then search / try again);
  `src/manifest.test.ts` asserts that both locales keep `{error}` and the guidance. The thrown
  `verify: missing device id` (`src/device/pairing.ts`) only happens on a malformed `verify` emit, which the shipped `scan.html` never sends;
  it is not a user-facing path and stays an English `Error`.
