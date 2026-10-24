"""Talk to the Timebox Evo over BLE GATT (bleak). VERIFIED working path (2026-10-06) with the FE EF AA 55 envelope.

Usage: python ble.py [--legacy] [--response] [--chunk 20] [--all] step...
       python ble.py --scan SECONDS     (list every advertising BLE device, no name filter, no connect)
  default : payloads wrapped in the BLE envelope (seq 0x0101, 0x0102, ...) -> works
  --legacy: payloads wrapped in the SPP frame 01..02 instead -> silently ignored by the Evo (kept for re-tests)
Replies arrive on the notify characteristic as SPP frames (01 .. 02). Heartbeat f7 and seq echo 33 are hidden unless --all.
"""
import argparse, asyncio, subprocess
from bleak import BleakScanner, BleakClient
from divoom import ble_envelope, frame, split_frames, payloads_for, STEPS_HELP

ISSC_WRITE = "49535343-8841-43f4-a8d4-ecbe34729bb3"
ISSC_NOTIFY = "49535343-1e4d-4bd9-ba61-23c647249616"


async def scan(seconds):
    """Print every advertisement seen in `seconds`: what Homey's `ble.discover` has to work with (issue #46)."""
    found = await BleakScanner.discover(timeout=seconds, return_adv=True)
    print(f"scan {seconds:g} s: {len(found)} device(s), strongest first")
    for dev, adv in sorted(found.values(), key=lambda t: t[1].rssi, reverse=True):
        names = sorted({n for n in (dev.name, adv.local_name) if n})
        print(f"- address {dev.address}")
        print(f"  names: {names or '(none)'}")
        print(f"  rssi: {adv.rssi}")
        print(f"  service_uuids: {list(adv.service_uuids) or '(none)'}")
        print(f"  manufacturer_data: {({k: v.hex() for k, v in adv.manufacturer_data.items()}) or '(none)'}")
        print(f"  service_data: {({k: v.hex() for k, v in adv.service_data.items()}) or '(none)'}")
        print(f"  connectable: {getattr(adv, 'connectable', 'unknown')}")


async def main(a):
    if a.scan is not None:
        await scan(a.scan)
        return
    dev = await BleakScanner.find_device_by_filter(
        lambda d, ad: a.name in (d.name or ad.local_name or "").lower(), timeout=20)
    if not dev:
        raise SystemExit("no BLE device found")
    print("found", dev)
    rx = bytearray()
    async with BleakClient(dev) as c:
        print("connected, MTU", c.mtu_size)
        await c.start_notify(a.notify, lambda _, d: rx.extend(d))
        seq = 0x0101
        for step in a.steps:
            if step.startswith("w"):
                await asyncio.sleep(float(step[1:]))
                continue
            if step.startswith("snap:"):
                subprocess.run(["imagesnap", "-q", "-w", "1", step[5:]], stderr=subprocess.DEVNULL)
                continue
            cmds = payloads_for(step)
            if cmds is None:
                raise SystemExit(f"unknown step {step!r}; {STEPS_HELP}")
            for label, payload in cmds:  # multi-payload steps (text:) are spaced by --wait
                if a.legacy:
                    f = frame(payload)
                else:
                    f = ble_envelope(seq, payload)
                    seq = 0x0100 | ((seq + 1) & 0xFF)  # high byte 01, low byte always changes
                print(f"TX {label} ({len(f)} B): {f.hex(' ')}")
                for i in range(0, len(f), a.chunk):
                    await c.write_gatt_char(a.write, f[i:i + a.chunk], response=a.response)
                await asyncio.sleep(a.wait)
                frames, rest = split_frames(bytes(rx))
                del rx[:]
                rx.extend(rest)
                for fr in frames:
                    if a.all or fr[4] not in (0xF7, 0x33):
                        print(f"RX {fr.hex(' ')}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(epilog=STEPS_HELP)
    ap.add_argument("--name", default="timebox", help="case-insensitive substring of the advertised name")
    ap.add_argument("--write", default=ISSC_WRITE)
    ap.add_argument("--notify", default=ISSC_NOTIFY)
    ap.add_argument("--legacy", action="store_true", help="send SPP frames instead of the BLE envelope")
    ap.add_argument("--response", action="store_true", help="write with response")
    ap.add_argument("--chunk", type=int, default=138, help="bytes per GATT write (20 also works)")
    ap.add_argument("--scan", type=float, metavar="SECONDS", help="only list all advertising devices for SECONDS")
    ap.add_argument("--wait", type=float, default=1.0)
    ap.add_argument("--all", action="store_true", help="also print heartbeat (f7) and seq echo (33) frames")
    ap.add_argument("steps", nargs="*")
    asyncio.run(main(ap.parse_args()))
