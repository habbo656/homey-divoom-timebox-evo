# Hardware probe scripts (macOS)

Small Python tools to talk to a real Timebox Evo from a Mac, outside Homey. Use them to verify protocol findings
before implementing them. Results go into `docs/divoom-protocol.md` (see the "How to probe" section there).
These scripts are not part of the Homey app.

## Setup

```sh
brew install blueutil imagesnap          # pairing info, webcam photos
python3 -m venv .venv && .venv/bin/pip install -r scripts/probe/requirements.txt
```

## Steps (shared by both scripts)

`q` query (`46`), `bNN` brightness, `img` golden test image (top row blue, left red, right green), `img8` the same picture as a 256-colour 8 bpp
image (1036 bytes, as the app sends images), `clock`
(`45 00`), `rgb:RRGGBB` lighting colour, `hex:AABB` raw payload (framed automatically), `wSECONDS` wait,
`snap:FILE.jpg` webcam photo, `text:SP:RRGGBB:RRGGBB:message` native scrolling text (speed, text colour, background
colour, message; BLE only, sends five payloads spaced by `--wait`, use `--wait 0.05`), `textoff` (`6e 00`). Replies are split into frames and printed as hex.

## BLE (the transport Homey can use)

No pairing needed. Payloads are wrapped in the `FE EF AA 55` envelope with seq `0x01xx`.

```sh
cd scripts/probe
../../.venv/bin/python ble.py q rgb:ff8800 w1 snap:orange.jpg img clock
../../.venv/bin/python ble.py --wait 0.05 text:5:ffff00:000080:'Hallo Homey 123' w5 snap:text.jpg textoff   # native text
../../.venv/bin/python ble.py --chunk 20 --response img        # 20-byte writes also work
../../.venv/bin/python ble.py --legacy q                      # SPP framing over BLE: ignored (negative control)
../../.venv/bin/python ble.py --scan 20                       # advertisement survey, see below
```

`--scan SECONDS` lists every advertising BLE device without a name filter and does not connect: address, name(s),
RSSI, service UUIDs, manufacturer/service data and connectable flag, strongest first. Use it to record what the
Evo advertises (does it advertise the ISSC service `49535343-fe7d-...`, which names, which data), because the
pairing flow (#46) filters on the ISSC service UUID and falls back to listing everything. Run it with the Evo
switched on and nothing else holding it (no Homey run, no phone app). On macOS the address is a CoreBluetooth UUID,
not the MAC.

## RFCOMM (Bluetooth Classic, works too)

Pair the Evo in the macOS Bluetooth settings first. `blueutil --paired` shows its MAC. Payloads use the SPP frame
`01 … 02`.

```sh
export TIMEBOX_MAC=xx-xx-xx-xx-xx-xx   # from blueutil --paired
../../.venv/bin/python rfcomm.py --sdp q
../../.venv/bin/python rfcomm.py q b60 img snap:img.jpg clock
```

Do not use `/dev/cu.TimeBox-Evo-audio` with pyserial: it works once and then stays silent. While the Classic link
is connected, macOS makes the Evo the default audio input **and** output, and reconnects it automatically later. In
that state the Evo stopped reacting to its buttons and to BLE. After RFCOMM tests, unpair it
(`blueutil --unpair <mac>`) and check your audio devices (`SwitchAudioSource -c -t output`).

The terminal app running Python needs Bluetooth permission (and camera permission for `snap:`).
