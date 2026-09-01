#!/usr/bin/env python
"""Quick-check teleop: mirror the leader on the follower, nothing else.

This is what the dashboard's "Teleop" button runs. It used to shell out to
LeRobot's own `lerobot-teleoperate` unmodified, which has no concept of
`record_server.py`'s hand-posed `START_POSE` / `REST_POSE` -- so pressing
"Start teleop" or "Stop teleop" here never eased the follower anywhere; it
just started or killed the raw mirror loop. This script gives the quick check
the same two hardcoded poses and the same eased ramps the recording daemon
uses, so start and stop look and feel identical whether or not you're
recording.

    python scripts/teleop_run.py \
        --robot-port /dev/tty.usbmodemXXXX --teleop-port /dev/tty.usbmodemYYYY
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from record_server import (  # noqa: E402
    DEFAULT_REST_SECONDS,
    DEFAULT_START_SECONDS,
    DEFAULT_SYNC_SECONDS,
    REST_POSE,
    START_POSE,
    _ease_in_out,
    _ease_out_cubic,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("teleop")


def ramp_to(follower, pose: dict[str, float], seconds: float, fps: float) -> None:
    """Ease the follower from wherever it reads now onto `pose`.

    Same shape as `Recorder._ramp_to` in record_server.py, minus the hw_lock
    and Recorder state this standalone script has neither of.
    """
    observation = follower.get_observation()
    current = {
        key: float(value)
        for key, value in observation.items()
        if key.endswith(".pos") and isinstance(value, (int, float))
    }
    if not current:
        return
    target = {key: pose.get(key.removesuffix(".pos"), value) for key, value in current.items()}
    steps = max(1, round(fps * seconds))
    for step in range(1, steps + 1):
        fraction = _ease_in_out(step / steps)
        follower.send_action({
            key: value + fraction * (target[key] - value)
            for key, value in current.items()
        })
        if step < steps:
            time.sleep(1.0 / fps)
    time.sleep(0.2)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--robot-port", required=True)
    parser.add_argument("--robot-id", default="follower")
    parser.add_argument("--teleop-port", required=True)
    parser.add_argument("--teleop-id", default="leader")
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--start-seconds", type=float, default=DEFAULT_START_SECONDS)
    parser.add_argument("--sync-seconds", type=float, default=DEFAULT_SYNC_SECONDS)
    parser.add_argument("--rest-seconds", type=float, default=DEFAULT_REST_SECONDS)
    args = parser.parse_args()

    from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig
    from lerobot.teleoperators.so_leader import SO101Leader, SO101LeaderConfig

    follower = SO101Follower(SO101FollowerConfig(port=args.robot_port, id=args.robot_id))
    leader = SO101Leader(SO101LeaderConfig(port=args.teleop_port, id=args.teleop_id))

    follower.connect()
    # calibrate=False: raw connect, same as record_server.py -- an interactive
    # calibration prompt here would just hang with no terminal to answer it.
    leader.connect(calibrate=False)
    # Backdrivable: the operator walks the leader to match the follower before
    # tracking starts, same expectation as the recording daemon's engage gate.
    leader.disable_torque()

    try:
        follower.configure()
        ramp_to(follower, START_POSE, args.start_seconds, args.fps)
        # Ease onto wherever the leader actually is before handing over, so
        # the first live tick is not a jump from START_POSE to a leader that
        # was never posed to match it.
        leader_pose = {
            key.removesuffix(".pos"): float(value)
            for key, value in leader.get_action().items()
            if key.endswith(".pos") and isinstance(value, (int, float))
        }
        ramp_to(follower, leader_pose, args.sync_seconds, args.fps)

        period = 1.0 / args.fps
        log.info("tracking the leader — Ctrl-C to stop")
        while True:
            start = time.perf_counter()
            try:
                follower.send_action(leader.get_action())
            except Exception as err:  # noqa: BLE001
                log.warning("read/write failed, skipping this tick: %s", err)
            time.sleep(max(0.0, period - (time.perf_counter() - start)))
    except KeyboardInterrupt:
        log.info("stopping")
    finally:
        try:
            ramp_to(follower, REST_POSE, args.rest_seconds, args.fps)
        except Exception as err:  # noqa: BLE001
            log.warning("could not move the follower to rest: %s", err)
        try:
            follower.bus.disable_torque()
        except Exception as err:  # noqa: BLE001
            log.error("could not cut follower torque: %s", err)
        try:
            leader.bus.disable_torque()
        except Exception as err:  # noqa: BLE001
            log.error("could not cut leader torque: %s", err)
        follower.disconnect()
        leader.disconnect()
    return 0


if __name__ == "__main__":
    sys.exit(main())
