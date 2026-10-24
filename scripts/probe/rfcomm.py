"""Talk to the Timebox Evo over Bluetooth Classic RFCOMM (macOS, IOBluetooth via PyObjC). VERIFIED working path.

Usage: TIMEBOX_MAC=xx-xx-xx-xx-xx-xx python rfcomm.py [--channel 1] [--sdp] step...
"""
import argparse, os, subprocess, sys, time
from Foundation import NSObject, NSRunLoop, NSDate
import IOBluetooth
from divoom import frame, split_frames, payload_for, STEPS_HELP

rx = bytearray()


class Delegate(NSObject):
    def rfcommChannelData_data_length_(self, ch, data, length):
        rx.extend(bytes(data[:length]))

    def rfcommChannelClosed_(self, ch):
        print("channel closed", flush=True)


def pump(sec):
    end = time.time() + sec
    while time.time() < end:
        NSRunLoop.currentRunLoop().runUntilDate_(NSDate.dateWithTimeIntervalSinceNow_(0.05))


def sdp(dev):
    print("SDP query status", dev.performSDPQuery_(None))
    pump(4)
    for r in dev.services() or []:
        status, chan = r.getRFCOMMChannelID_(None)
        print(f"  {r.getServiceName()}: " + (f"RFCOMM channel {chan}" if status == 0 else "no RFCOMM"))


def main():
    ap = argparse.ArgumentParser(epilog=STEPS_HELP)
    ap.add_argument("--mac", default=os.environ.get("TIMEBOX_MAC"), help="e.g. xx-xx-xx-xx-xx-xx (blueutil --paired)")
    ap.add_argument("--channel", type=int, default=1)
    ap.add_argument("--wait", type=float, default=1.5, help="seconds to listen after each command")
    ap.add_argument("--sdp", action="store_true", help="list SDP services first")
    ap.add_argument("steps", nargs="*")
    a = ap.parse_args()
    if not a.mac:
        sys.exit("set --mac or TIMEBOX_MAC")

    dev = IOBluetooth.IOBluetoothDevice.deviceWithAddressString_(a.mac)
    if a.sdp:
        sdp(dev)
    dlg = Delegate.alloc().init()
    status, ch = dev.openRFCOMMChannelSync_withChannelID_delegate_(None, a.channel, dlg)
    if status != 0 or ch is None:
        sys.exit(f"openRFCOMMChannelSync failed: status {status}")
    print(f"RFCOMM channel {a.channel} open, MTU {ch.getMTU()}", flush=True)
    pump(1.0)

    for step in a.steps:
        if step.startswith("w"):
            pump(float(step[1:]))
            continue
        if step.startswith("snap:"):
            subprocess.run(["imagesnap", "-q", "-w", "1", step[5:]], stderr=subprocess.DEVNULL)
            continue
        cmd = payload_for(step)
        if cmd is None:
            sys.exit(f"unknown step {step!r}; {STEPS_HELP}")
        label, payload = cmd
        f = frame(payload)
        del rx[:]
        print(f"TX {label}: {f.hex(' ')}", flush=True)
        mtu = ch.getMTU()
        for i in range(0, len(f), mtu):
            part = f[i:i + mtu]
            r = ch.writeSync_length_(part, len(part))
            if r != 0:
                print(f"  write status {r}")
        pump(a.wait)
        frames, rest = split_frames(bytes(rx))
        for fr in frames:
            print(f"RX {fr.hex(' ')}")
        if not frames:
            print("RX (none)")
        if rest:
            print(f"RX incomplete: {rest.hex(' ')}")

    ch.closeChannel()
    pump(0.5)


if __name__ == "__main__":
    main()
