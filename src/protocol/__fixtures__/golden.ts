// Golden vectors from docs/divoom-protocol.md. Replies were computed with scripts/probe/divoom.py (frame()).
// Hex strings only; tests convert them with fromHex().

/** Lighting red (section 1.2): payload `45 01 ff 00 00 64 00 01`. */
export const LIGHTING_RED_PAYLOAD = '45 01 ff 00 00 64 00 01';
/** Same payload in the BLE envelope with seq 0x0101 (section 1.2, ends with CRC `bb 01`). */
export const LIGHTING_RED_ENVELOPE = 'fe ef aa 55 0f 00 01 01 00 00 00 45 01 ff 00 00 64 00 01 bb 01';

/** Static image `44` (section 4): top row blue, rows 1-15 left half red, right half green. 85 bytes. */
export const IMAGE_PAYLOAD =
  '44 00 0a 0a 04 aa 50 00 00 00 00 03 00 00 ff ff 00 00 00 ff 00 ' + '00 00 00 00' + ' 55 55 aa aa'.repeat(15);
/** Image payload as SPP frame (section 4; CRC `8f 22`). */
export const IMAGE_SPP_FRAME = `01 57 00 ${IMAGE_PAYLOAD} 8f 22 02`;
/** Image payload in the BLE envelope with seq 0x0101 (LEN 0x5c, CRC `96 22`). */
export const IMAGE_ENVELOPE = `fe ef aa 55 5c 00 01 01 00 00 00 ${IMAGE_PAYLOAD} 96 22`;

/**
 * Notification icon Telegram `50 12` (section 5.5, #5) in the BLE envelope with seq 0x0101 (computed with
 * scripts/probe/divoom.py ble_envelope()). The KB recipe frame of this command uses another BLE framing and appends the
 * app's text length byte, so it is not comparable byte for byte; the SPP frame below equals the KB `raw 0x50 12` frame.
 */
export const NOTIFICATION_TELEGRAM_ENVELOPE = 'fe ef aa 55 09 00 01 01 00 00 00 50 12 6d 00';
/** The same payload as SPP frame (KB `raw 0x50 12` and scripts/probe/divoom.py frame(), CRC `66 00`). */
export const NOTIFICATION_TELEGRAM_SPP_FRAME = '01 04 00 50 12 66 00 02';

// Device replies as SPP frames `01 LEN 04 CMD 55 DATA CRC 02`, computed with scripts/probe/divoom.py frame().
/** `f7 55 4e 6f 62 02 69 04 00 00` heartbeat (section 2). */
export const REPLY_HEARTBEAT = '01 0d 00 04 f7 55 4e 6f 62 02 69 04 00 00 eb 02 02';
/** `33 55 0a 00 00 00` sequence echo (SS = 0x0a). */
export const REPLY_SEQ_ECHO = '01 09 00 04 33 55 0a 00 00 00 9f 00 02';
/** `31 55 32` brightness report (50). */
export const REPLY_BRIGHTNESS = '01 06 00 04 31 55 32 c2 00 02';
/** `46 55 00 01 … 13` status dump with data bytes 00..13 (synthetic). */
export const REPLY_STATUS = '01 19 00 04 46 55 00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f 10 11 12 13 76 01 02';
/** `44 55 6b` image acknowledgement (section 4). */
export const REPLY_IMAGE_ACK = '01 06 00 04 44 55 6b 0e 01 02';
/** `e5 55 01` reply for an opcode the app does not know. */
export const REPLY_UNKNOWN = '01 06 00 04 e5 55 01 45 01 02';
/** `74 aa` reply with a status byte other than 55 (old-Timebox style NAK; the Evo never sends it). */
export const REPLY_NOT_OK = '01 05 00 04 74 aa 27 01 02';

// Real `46` status replies captured from the owner's Evo over BLE on 2026-10-06 with scripts/probe/ble.py (#20).
// Frames are copied verbatim (CRC included). State before each capture is given in the comment.
/** Clock view, lighting colour red, brightness 50 (0x32), last visualization 3, clock colour ff 80 00, style 0. */
export const STATUS_CLOCK_B50 =
  '01 19 00 04 46 55 00 00 00 ff 00 00 32 00 01 03 32 01 ff 80 00 00 00 00 00 00 9f 03 02';
/** Clock view after `74 14` (brightness 20 = 0x14); lighting colour green. */
export const STATUS_CLOCK_B20_GREEN =
  '01 19 00 04 46 55 00 00 00 00 ff 00 14 00 01 03 14 01 ff 80 00 00 00 00 00 00 63 03 02';
/** Lighting channel (`45 01 00 ff 00 64 00 01`): channel 1, colour green, brightness 100 (0x64). */
export const STATUS_LIGHTING_GREEN_B100 =
  '01 19 00 04 46 55 01 00 00 00 ff 00 64 00 01 0b 64 01 ff 80 00 00 01 00 00 00 0d 04 02';
/** Visualization channel after `45 04 03`: channel 4, last visualization index 3. */
export const STATUS_VISUALIZATION_3 =
  '01 19 00 04 46 55 04 00 00 00 ff 00 64 00 01 03 64 01 ff 80 00 00 01 00 00 00 08 04 02';
/** Unsolicited `46` sent after a brightness change: 22 data bytes (the plain query reply has 20). */
export const STATUS_UNSOLICITED_22 =
  '01 1b 00 04 46 55 00 00 00 00 ff 00 14 00 01 03 14 01 ff 80 00 00 00 00 00 00 55 00 ba 03 02';

// Unsolicited countdown frames (docs/protocol/countdown.md P2/P5/P6/P8b; payloads as measured, SPP wrapping and CRC computed).
/** `71 55 03 01 01 00`: the countdown ended. */
export const COUNTDOWN_END = '01 09 00 04 71 55 03 01 01 00 d8 00 02';
/** `bd 55 13 01 32 00`: unknown frame that follows the end of a countdown at once. */
export const COUNTDOWN_END_BD_32 = '01 09 00 04 bd 55 13 01 32 00 65 01 02';
/** `bd 55 13 01 1e 00`: unknown frame about 12 s after the end of a countdown. */
export const COUNTDOWN_END_BD_1E = '01 09 00 04 bd 55 13 01 1e 00 51 01 02';
/** `bd 55 17 01`: the answer of `bd 17 ff`, custom page 2. */
export const REPLY_CUSTOM_PAGE_2 = '01 07 00 04 bd 55 17 01 35 01 02';
