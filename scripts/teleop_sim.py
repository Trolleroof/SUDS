#!/usr/bin/env python
"""Teleoperate the physical follower from the leader, mirroring the follower's
*actual measured* joints into MuJoCo -- not the leader's target.

This replaces `lerobot-teleoperate` rather than running alongside it: both
serial ports can only have one owner each, so a single process does the read
-> command -> read-back -> render loop itself.

Why mirror the follower's telemetry and not the leader's action: the leader is
what you're commanding, the follower is what actually happened. They differ
whenever `--max-relative-target` clamps a jump, a joint is near a mechanical
limit, or the arm is still catching up to a fast move. Watching the follower
in sim is a live check that the physical arm is tracking, not just that the
leader is moving.

macOS: launch with mjpython, not python.

    mjpython scripts/teleop_sim.py \
        --leader-port /dev/tty.usbmodemXXXX --follower-port /dev/tty.usbmodemYYYY
"""

from __future__ import annotations

import argparse
import math
import sys
import time
from pathlib import Path

import mujoco
import mujoco.viewer
import numpy as np

from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig
from lerobot.teleoperators.so_leader import SO101Leader, SO101LeaderConfig

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sim_leader import DEFAULT_SCENE, GRIPPER_DEG_AT_FULL_OPEN, JOINTS, build_model  # noqa: E402


def action_to_radians(obs: dict[str, float]) -> np.ndarray:
    out = np.empty(len(JOINTS), dtype=float)
    for i, joint in enumerate(JOINTS):
        value = obs[f"{joint}.pos"]
        deg = (value / 100.0) * GRIPPER_DEG_AT_FULL_OPEN if joint == "gripper" else value
        out[i] = math.radians(deg)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--leader-port", required=True)
    parser.add_argument("--leader-id", default="leader")
    parser.add_argument("--follower-port", required=True)
    parser.add_argument("--follower-id", default="follower")
    parser.add_argument(
        "--max-relative-target",
        type=float,
        default=10.0,
        help="Per-step degree cap on the follower's commanded motion. Same safety this "
        "is meant to catch as lerobot-teleoperate's flag. 0 disables it.",
    )
    parser.add_argument("--scene", type=Path, default=DEFAULT_SCENE)
    parser.add_argument("--rate", type=float, default=30.0, help="Control / render rate (Hz).")
    parser.add_argument("--cube", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--cube-pos", default="0.2,0.0")
    parser.add_argument("--cube-size", type=float, default=0.015)
    parser.add_argument("--cube-mass", type=float, default=0.05)
    args = parser.parse_args()

    if not args.scene.is_file():
        sys.exit(f"MJCF scene not found at {args.scene}. See SETUP.md for the SO-ARM100 clone step.")

    cx, cy = (float(v) for v in args.cube_pos.split(","))
    model = build_model(args.scene, args.cube, (cx, cy), args.cube_size, args.cube_mass)
    data = mujoco.MjData(model)

    def joint_id(name: str) -> int:
        return mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, name)

    arm_qpos = np.array([model.jnt_qposadr[joint_id(j)] for j in JOINTS])
    arm_dof = np.array([model.jnt_dofadr[joint_id(j)] for j in JOINTS])

    leader = SO101Leader(SO101LeaderConfig(port=args.leader_port, id=args.leader_id))
    max_rel = args.max_relative_target if args.max_relative_target > 0 else None
    follower = SO101Follower(
        SO101FollowerConfig(port=args.follower_port, id=args.follower_id, max_relative_target=max_rel)
    )

    leader.connect(calibrate=False)
    if not leader.is_calibrated:
        leader.disconnect()
        sys.exit(f"Leader '{args.leader_id}' has no calibration. Run scripts/stream_leader.py --calibrated first.")
    leader.disable_torque()

    follower.connect(calibrate=False)
    if not follower.is_calibrated:
        leader.disconnect()
        follower.disconnect()
        sys.exit(
            f"Follower '{args.follower_id}' has no calibration. Run:\n"
            f"  lerobot-calibrate --robot.type=so101_follower --robot.port={args.follower_port} "
            f"--robot.id={args.follower_id}"
        )

    period = 1.0 / args.rate
    print(f"Leader {args.leader_port}  ->  Follower {args.follower_port}")
    print(f"max_relative_target={max_rel}  |  sim mirrors the follower's measured pose.")
    print("Close the viewer window (or Ctrl-C) to stop.")

    try:
        with mujoco.viewer.launch_passive(model, data) as viewer:
            obs = follower.get_observation()
            data.qpos[arm_qpos] = action_to_radians(obs)
            mujoco.mj_forward(model, data)

            while viewer.is_running():
                frame_start = time.perf_counter()

                action = leader.get_action()
                follower.send_action(action)
                obs = follower.get_observation()

                q = action_to_radians(obs)
                data.qpos[arm_qpos] = q
                data.qvel[arm_dof] = 0.0
                mujoco.mj_step(model, data)
                viewer.sync()

                sleep = period - (time.perf_counter() - frame_start)
                if sleep > 0:
                    time.sleep(sleep)
    except RuntimeError as err:
        if "mjpython" in str(err).lower():
            sys.exit(f"MuJoCo's viewer needs mjpython on macOS. Re-run as:\n  mjpython {' '.join(sys.argv)}")
        raise
    except KeyboardInterrupt:
        pass
    finally:
        leader.disconnect()
        follower.disconnect()

    print("Stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
