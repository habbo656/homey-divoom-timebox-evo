"""Minimal Timebox Evo codec for hardware probing (mirrors src/protocol, see docs/divoom-protocol.md)."""
import math


def frame(payload: bytes) -> bytes:
    """01 | LEN (LE) | payload | CRC (LE) | 02, LEN = payload + 2, CRC = sum over LEN + payload."""
    ln = len(payload) + 2
    body = bytes([ln & 0xFF, ln >> 8]) + payload
    crc = sum(body) & 0xFFFF
    return b"\x01" + body + bytes([crc & 0xFF, crc >> 8]) + b"\x02"


def ble_envelope(seq: int, payload: bytes) -> bytes:
    """BLE framing: FE EF AA 55 | LEN (LE) | SEQ_hi SEQ_lo 00 00 00 | payload | CRC (LE).

    LEN counts seq + 3 zero bytes + payload + CRC; CRC = sum over LEN bytes + content.
    The Evo ignores the packet if SEQ_hi == 0 or SEQ_lo equals the last accepted SEQ_lo.
    """
    content = bytes([seq >> 8 & 0xFF, seq & 0xFF, 0, 0, 0]) + payload
    ln = len(content) + 2
    crc = ((ln & 0xFF) + (ln >> 8) + sum(content)) & 0xFFFF
    return bytes([0xFE, 0xEF, 0xAA, 0x55, ln & 0xFF, ln >> 8]) + content + bytes([crc & 0xFF, crc >> 8])


def split_frames(data: bytes):
    """Split a byte stream into frames by the length field; returns (frames, rest)."""
    frames, i = [], 0
    while i + 3 <= len(data):
        if data[i] != 0x01:
            i += 1
            continue
        end = i + 3 + (data[i + 1] | data[i + 2] << 8)
        if end > len(data):
            break
        frames.append(data[i:end + 1])
        i = end + 1
    return frames, data[i:]


def image(pixels) -> bytes:
    """Image payload (0x44) from 256 (r, g, b) tuples, row-major, top-left first."""
    pal = []
    for p in pixels:
        if p not in pal:
            pal.append(p)
    bits = max(1, math.ceil(math.log2(len(pal))))
    acc, n, out = 0, 0, bytearray()
    for p in pixels:
        acc |= pal.index(p) << n
        n += bits
        while n >= 8:
            out.append(acc & 0xFF)
            acc >>= 8
            n -= 8
    if n:
        out.append(acc & 0xFF)
    rest = b"\x00\x00\x00" + bytes([len(pal) & 0xFF]) + b"".join(bytes(c) for c in pal) + bytes(out)
    ln = 3 + len(rest)
    return bytes([0x44, 0x00, 0x0A, 0x0A, 0x04, 0xAA, ln & 0xFF, ln >> 8]) + rest


def test_image() -> bytes:
    """Golden test image: top row blue, left half red, right half green."""
    px = []
    for y in range(16):
        for x in range(16):
            px.append((0, 0, 255) if y == 0 else (255, 0, 0) if x < 8 else (0, 255, 0))
    return image(px)


def test_image_8bpp() -> bytes:
    """Golden test image as a 256-colour image: NN = 256 (`00`), 8 bits per pixel, palette padded with black.

    This is the encoding the app uses for every `44` image (#31). Payload 1036 bytes."""
    colours = [(0, 0, 255), (255, 0, 0), (0, 255, 0)]
    indices = [0 if y == 0 else 1 if x < 8 else 2 for y in range(16) for x in range(16)]
    palette = b"".join(bytes(c) for c in colours) + bytes(3 * (256 - len(colours)))
    rest = b"\x00\x00\x00\x00" + palette + bytes(indices)  # NN = 00 means 256
    ln = 3 + len(rest)
    return bytes([0x44, 0x00, 0x0A, 0x0A, 0x04, 0xAA, ln & 0xFF, ln >> 8]) + rest


def native_text(text: str, speed: int, fg, bg) -> list:
    """Native scrolling text (docs/divoom-protocol.md 5.5): the five payloads `6e 01`, `86 01 LL text`, `86 00 SP`,
    `6c 00 00 LLLL frame0`, `6c 01 00 LLLL frame1`. LL = UTF-16 code units, LLLL (LE16) = length of that frame."""
    units = text.encode("utf-16-le")
    n = len(units) // 2
    if not 1 <= n <= 255:
        raise ValueError("text must be 1..255 UTF-16 code units (the device shows the first 64)")
    if not 1 <= speed <= 255:
        raise ValueError("speed must be 1..255")
    palette = bytes(bg) * 127 + bytes(fg) * 127 + bytes(bg) * 2
    frame0 = bytes([0xAA, 0x07, 0x04, 0x3C, 0x00, 0x00, 0x00]) + palette + bytes(256)
    frame1 = bytes([0xAA, 0x07, 0x01, 0x3C, 0x00, 0x01, 0x00]) + bytes(256)

    def upload(index: int, data: bytes) -> bytes:
        return bytes([0x6C, index, 0x00, len(data) & 0xFF, len(data) >> 8]) + data

    return [
        bytes([0x6E, 0x01]),
        bytes([0x86, 0x01, n]) + units,
        bytes([0x86, 0x00, speed]),
        upload(0, frame0),
        upload(1, frame1),
    ]


def payload_for(step: str):
    """Map a CLI step to (label, payload); None if the step is not a command."""
    if step == "q":
        return "query", bytes([0x46])
    if step.startswith("b") and step[1:].isdigit():
        return f"brightness {step[1:]}", bytes([0x74, int(step[1:])])
    if step == "img":
        return "image", test_image()
    if step == "img8":
        return "image 256 colours, 8 bpp", test_image_8bpp()
    if step == "clock":
        return "clock view", bytes([0x45, 0x00])
    if step.startswith("rgb:"):
        return f"lighting {step[4:]}", bytes([0x45, 0x01]) + bytes.fromhex(step[4:]) + bytes([100, 0x00, 0x01])
    if step.startswith("hex:"):
        return "raw payload", bytes.fromhex(step[4:])
    return None


def payloads_for(step: str):
    """Like payload_for, but returns a list of (label, payload): one entry for most steps, several for `text:`.

    text:SP:RRGGBB:RRGGBB:message  native scrolling text (speed, text colour, background colour; the message may
                                  contain ':'); textoff = stop it (`6e 00`).
    """
    if step == "textoff":
        return [("native text off", bytes([0x6E, 0x00]))]
    if step.startswith("text:"):
        sp, fg, bg, message = step[5:].split(":", 3)
        return [(f"native text part {i + 1}/5", p)
                for i, p in enumerate(native_text(message, int(sp), bytes.fromhex(fg), bytes.fromhex(bg)))]
    one = payload_for(step)
    return None if one is None else [one]


STEPS_HELP = (
    "steps: q (query 46) | bNN (brightness 0..100) | img (golden test image) | img8 (same image, 256-colour 8 bpp encoding) | clock (45 00) | rgb:RRGGBB (lighting) | "
    "hex:AABB (raw payload, gets framed) | text:SP:RRGGBB:RRGGBB:message (native scrolling text, BLE only) | "
    "textoff (6e 00) | wSECONDS (wait) | snap:FILE.jpg (webcam photo via imagesnap)"
)
