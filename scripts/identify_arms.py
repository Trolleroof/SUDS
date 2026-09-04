#!/usr/bin/env python
"""Work out which USB port is which arm, by watching both and seeing which moves.

`/dev/tty.usbmodem5C821071271` is the **leader** and `/dev/tty.usbmodem5C821094831` is the
**follower** on this bench. The names alone do not tell you which cable is which;
answer is `lerobot-find-port`, which has you unplug a cable and compare listings.
This is the same question asked the other way round: watch both ports at once,
have the operator move one arm by hand, and report which port saw it.

Read-only by design. Torque is never enabled, and -- crucially -- it is never
*disabled* either: the follower may be holding a pose against gravity, and
cutting torque to identify it would drop the arm. The bus is closed with
`disable_torque=False` for exactly that reason.

    python scripts/identify_arms.py --port /dev/tty.usbmodemA --port /dev/tty.usbmodemB

Prints one JSON object: per port, whether it answered, how far it moved, and
which joint moved most.
"""

from __future__ import annotations

import argparse
import json
import threading
import time
from typing import Any

SO101_MOTORS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]

# Encoder counts. A hand resting on an arm is a few counts of noise; a
# deliberate nudge of any joint is hundreds.
MOVED_THRESHOLD = 60


def watch(port: str, seconds: float, out: dict[str, Any]) -> None:
    from lerobot.motors import Motor, MotorNormMode
    from lerobot.motors.feetech import FeetechMotorsBus

    result: dict[str, Any] = {"port": port, "connected": False, "motors": 0, "travel": 0, "joint": None}
    out[port] = result

    bus = FeetechMotorsBus(
        port=port,
        motors={name: Motor(i + 1, "sts3215", MotorNormMode.RANGE_M100_100) for i, name in enumerate(SO101_MOTORS)},
    )
    try:
        bus.connect(handshake=False)
    except Exception as err:  # noqa: BLE001
        result["error"] = str(err)
        return

    result["connected"] = True
    mins: dict[str, int] = {}
    maxes: dict[str, int] = {}
    deadline = time.time() + seconds
    try:
        while time.time() < deadline:
            try:
                positions = bus.sync_read("Present_Position", normalize=False, num_retry=2)
            except Exception:  # noqa: BLE001
                time.sleep(0.05)
                continue
            result["motors"] = len(positions)
            for name, value in positions.items():
                mins[name] = min(mins.get(name, value), value)
                maxes[name] = max(maxes.get(name, value), value)
            time.sleep(0.03)
    finally:
        # Leave the arms exactly as they were found: see the module docstring.
        try:
            bus.disconnect(disable_torque=False)
        except Exception:  # noqa: BLE001
            pass

    travel = {name: maxes[name] - mins[name] for name in maxes}
    if travel:
        joint = max(travel, key=travel.get)
        result["travel"] = int(travel[joint])
        result["joint"] = joint
    result["moved"] = result["travel"] >= MOVED_THRESHOLD


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", action="append", default=[], required=True)
    parser.add_argument("--seconds", type=float, default=6.0)
    args = parser.parse_args()

    out: dict[str, Any] = {}
    # Both ports at once: the operator moves one arm during a single window, and
    # sampling them one after another would miss it on whichever came second.
    threads = [threading.Thread(target=watch, args=(port, args.seconds, out), daemon=True) for port in args.port]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=args.seconds + 15)

    moved = [r for r in out.values() if r.get("moved")]
    print(
        "RESULT:"
        + json.dumps(
            {
                "ports": list(out.values()),
                "moved_port": moved[0]["port"] if len(moved) == 1 else None,
                "ambiguous": len(moved) > 1,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
