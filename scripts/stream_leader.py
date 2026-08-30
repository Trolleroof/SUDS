#!/usr/bin/env python
"""Live stream of a single SO-101 leader arm's joint positions.

The leader is a standalone teleoperator: it only reads its own servos, so no
follower arm is needed to verify the USB link and the motor chain.

Two modes:

  raw (default)  Reads Present_Position straight off the bus in servo ticks
                 (0-4095). Needs no calibration file, so it works the moment
                 the arm is plugged in.
  --calibrated   Uses the saved calibration for the given --id to report
                 degrees (and 0-100 for the gripper). Runs the interactive
                 calibration routine if none is saved yet.

Usage:
    python scripts/stream_leader.py                     # auto-detect port, raw
    python scripts/stream_leader.py --probe             # ping motors and exit
    python scripts/stream_leader.py --calibrated
"""

from __future__ import annotations

import argparse
import glob
import sys
import time

from lerobot.teleoperators.so_leader import SO101Leader, SO101LeaderConfig

JOINTS = [
    "shoulder_pan",
    "shoulder_lift",
    "elbow_flex",
    "wrist_flex",
    "wrist_roll",
    "gripper",
]

RAW_MIN, RAW_MAX = 0, 4095
BAR_WIDTH = 32


def autodetect_port() -> str:
    ports = sorted(glob.glob("/dev/tty.usbmodem*") + glob.glob("/dev/tty.usbserial*"))
    if not ports:
        sys.exit(
            "No /dev/tty.usbmodem* device found. Plug in the leader arm, or pass --port explicitly."
        )
    if len(ports) > 1:
        sys.exit(
            "Multiple serial devices found:\n  "
            + "\n  ".join(ports)
            + "\nPass one with --port (use `lerobot-find-port` to tell the arms apart)."
        )
    return ports[0]


def bar(value: float, lo: float, hi: float) -> str:
    """A fixed-width bar with a marker at the current value."""
    span = hi - lo
    frac = 0.0 if span == 0 else (value - lo) / span
    frac = min(max(frac, 0.0), 1.0)
    pos = round(frac * (BAR_WIDTH - 1))
    return "".join("|" if i == pos else "-" for i in range(BAR_WIDTH))


def probe(leader: SO101Leader) -> int:
    """Ping each expected servo id and report which answer."""
    print("Pinging motors on the chain...\n")
    missing = []
    for name, motor in leader.bus.motors.items():
        model = leader.bus.ping(name, num_retry=2)
        if model is None:
            missing.append(name)
            print(f"  id {motor.id}  {name:<14} NO RESPONSE")
        else:
            print(f"  id {motor.id}  {name:<14} ok (model {model})")
    if missing:
        print(
            f"\n{len(missing)} motor(s) did not respond: {', '.join(missing)}."
            "\nCheck the daisy-chain cabling and that servo ids were assigned with"
            " `lerobot-setup-motors`."
        )
        return 1
    print("\nAll 6 motors responded.")
    return 0


def stream(leader: SO101Leader, hz: float, calibrated: bool, duration: float | None) -> None:
    period = 1.0 / hz
    if calibrated:
        # Degrees for the body joints, 0-100 for the gripper.
        ranges = {j: (-180.0, 180.0) for j in JOINTS}
        ranges["gripper"] = (0.0, 100.0)
        units = {j: "deg" for j in JOINTS}
        units["gripper"] = "%"
        fmt = "{:>8.2f}"
    else:
        ranges = {j: (float(RAW_MIN), float(RAW_MAX)) for j in JOINTS}
        units = {j: "tick" for j in JOINTS}
        fmt = "{:>8.0f}"

    mode = "calibrated" if calibrated else "raw ticks"
    header_lines = 4
    body_lines = len(JOINTS)
    print(f"Streaming {leader.bus.port} at {hz:g} Hz ({mode}). Move the arm. Ctrl-C to stop.\n")
    # Reserve the block we will repaint in place.
    print("\n" * (header_lines + body_lines), end="")

    frames = 0
    started = t0 = time.perf_counter()
    last_rate = 0.0
    try:
        while True:
            loop_start = time.perf_counter()
            if duration is not None and loop_start - started >= duration:
                print(f"\nDone after {duration:g}s.")
                return

            if calibrated:
                action = leader.get_action()
                values = {j: action[f"{j}.pos"] for j in JOINTS}
            else:
                raw = leader.bus.sync_read("Present_Position", normalize=False, num_retry=2)
                values = {j: float(raw[j]) for j in JOINTS}

            frames += 1
            elapsed = loop_start - t0
            if elapsed >= 0.5:
                last_rate = frames / elapsed
                frames = 0
                t0 = loop_start

            lines = [
                f"  rate {last_rate:5.1f} Hz    mode {mode}",
                "",
                f"  {'joint':<14} {'value':>8}  {'unit':<5} {'position':<{BAR_WIDTH}}",
                f"  {'-' * 14} {'-' * 8}  {'-' * 5} {'-' * BAR_WIDTH}",
            ]
            for j in JOINTS:
                lo, hi = ranges[j]
                v = values[j]
                lines.append(
                    f"  {j:<14} {fmt.format(v)}  {units[j]:<5} {bar(v, lo, hi)}"
                )

            # Move the cursor back up over the block and repaint it.
            sys.stdout.write(f"\033[{header_lines + body_lines}A")
            for line in lines:
                sys.stdout.write("\033[2K" + line + "\n")
            sys.stdout.flush()

            sleep = period - (time.perf_counter() - loop_start)
            if sleep > 0:
                time.sleep(sleep)
    except KeyboardInterrupt:
        print("\nStopped.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", default=None, help="Serial port; auto-detected when omitted.")
    parser.add_argument("--id", default="leader", help="Arm id used to look up calibration.")
    parser.add_argument("--hz", type=float, default=30.0, help="Read rate. Default 30.")
    parser.add_argument(
        "--calibrated",
        action="store_true",
        help="Report degrees using the saved calibration (runs calibration if none exists).",
    )
    parser.add_argument("--probe", action="store_true", help="Ping the six servos and exit.")
    parser.add_argument(
        "--duration",
        type=float,
        default=None,
        help="Stop after this many seconds instead of running until Ctrl-C.",
    )
    args = parser.parse_args()

    port = args.port or autodetect_port()
    leader = SO101Leader(SO101LeaderConfig(port=port, id=args.id))

    # calibrate=False keeps connect() from blocking on the interactive routine
    # in raw mode; the bus and motors are still fully configured.
    leader.connect(calibrate=args.calibrated)
    try:
        # The leader is backdrivable by hand, so torque must stay off.
        leader.disable_torque()
        if args.probe:
            return probe(leader)
        stream(leader, args.hz, args.calibrated, args.duration)
    finally:
        leader.disconnect()
    return 0


if __name__ == "__main__":
    sys.exit(main())
