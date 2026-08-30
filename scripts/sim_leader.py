#!/usr/bin/env python
"""Drive a simulated SO-101 in MuJoCo from the physical leader arm.

Two modes, because "see the leader in sim" can mean two things:

  mirror (default)  The arm's joint angles are pinned to the leader's every
                    step: no gravity, no lag, no tracking error. Objects in the
                    scene still simulate normally, so the arm behaves like an
                    infinitely stiff robot that can push the cube around.
  physics           The leader's angles become position-actuator *targets* and
                    the arm is simulated for real. It sags under gravity, lags
                    on fast moves, and can miss its target at the 3.35 N-m
                    limit. This is the one that stands in for a follower arm.

Grasping works in both modes -- the model carries proper collision geoms on the
gripper and moving jaw -- but `physics` is the honest test of whether a grasp
would actually hold.

The model is the SO-101 MJCF from TheRobotStudio/SO-ARM100, which is also the
model LeRobot's own kinematics scripts point at. The cube is added at load time
with MjSpec, so the vendored clone is never modified.

macOS note: MuJoCo's interactive viewer must be launched with `mjpython`:

    mjpython scripts/sim_leader.py --port /dev/tty.usbmodemXXXX
    mjpython scripts/sim_leader.py --mode physics
    mjpython scripts/sim_leader.py --no-cube
"""

from __future__ import annotations

import argparse
import glob
import math
import sys
import time
from pathlib import Path

import mujoco
import mujoco.viewer
import numpy as np

from lerobot.teleoperators.so_leader import SO101Leader, SO101LeaderConfig

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SCENE = REPO_ROOT / "SO-ARM100" / "Simulation" / "SO101" / "scene.xml"

# The MJCF joint names match LeRobot's motor names one-to-one, in this order.
JOINTS = [
    "shoulder_pan",
    "shoulder_lift",
    "elbow_flex",
    "wrist_flex",
    "wrist_roll",
    "gripper",
]

# The five body joints are reported in degrees; the gripper is a 0-100 percent
# opening, which the MJCF expresses as roughly 0-100 degrees of jaw rotation.
GRIPPER_DEG_AT_FULL_OPEN = 100.0


def autodetect_port() -> str:
    ports = sorted(glob.glob("/dev/tty.usbmodem*") + glob.glob("/dev/tty.usbserial*"))
    if not ports:
        sys.exit("No /dev/tty.usbmodem* device found. Plug in the leader arm, or pass --port.")
    if len(ports) > 1:
        sys.exit(
            "Multiple serial devices found:\n  "
            + "\n  ".join(ports)
            + "\nPass the leader's with --port. The leader is the board whose motors carry the\n"
            "homing offsets in its calibration file; the follower will not match."
        )
    return ports[0]


def parse_per_joint(raw: str | None, default: float, name: str) -> np.ndarray:
    """Parse a comma-separated per-joint list, or a single value applied to all."""
    if raw is None:
        return np.full(len(JOINTS), default, dtype=float)
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    if len(parts) == 1:
        return np.full(len(JOINTS), float(parts[0]), dtype=float)
    if len(parts) != len(JOINTS):
        sys.exit(f"--{name} needs 1 or {len(JOINTS)} comma-separated values, got {len(parts)}.")
    return np.array([float(p) for p in parts], dtype=float)


def build_model(
    scene: Path, add_cube: bool, cube_xy: tuple[float, float], half: float, mass: float
) -> mujoco.MjModel:
    """Compile the scene, optionally with a free-floating cube on the floor."""
    spec = mujoco.MjSpec.from_file(str(scene))
    if add_cube:
        # Resting on the floor means the body sits one half-extent up.
        body = spec.worldbody.add_body(name="cube", pos=[cube_xy[0], cube_xy[1], half])
        body.add_freejoint(name="cube_free")
        body.add_geom(
            name="cube",
            type=mujoco.mjtGeom.mjGEOM_BOX,
            size=[half, half, half],
            rgba=[0.85, 0.25, 0.25, 1.0],
            mass=mass,
            # Sliding friction high enough that a pinch grip holds rather than squirts out.
            friction=[1.0, 0.02, 0.001],
        )
    return spec.compile()


def action_to_radians(action: dict[str, float], sign: np.ndarray, offset: np.ndarray) -> np.ndarray:
    """Map a leader action dict onto the arm's joint vector, in radians."""
    out = np.empty(len(JOINTS), dtype=float)
    for i, joint in enumerate(JOINTS):
        value = action[f"{joint}.pos"]
        if joint == "gripper":
            deg = (value / 100.0) * GRIPPER_DEG_AT_FULL_OPEN
        else:
            deg = value
        out[i] = math.radians(sign[i] * deg + offset[i])
    return out


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--port", default=None, help="Serial port; auto-detected when unambiguous.")
    parser.add_argument("--id", default="leader", help="Arm id used to look up calibration.")
    parser.add_argument(
        "--mode",
        choices=["mirror", "physics"],
        default="mirror",
        help="mirror: pin joint angles to the leader. physics: drive actuators and simulate.",
    )
    parser.add_argument("--scene", type=Path, default=DEFAULT_SCENE, help="MJCF scene to load.")
    parser.add_argument("--rate", type=float, default=60.0, help="Leader read / render rate (Hz).")
    parser.add_argument(
        "--cube",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Add a grabbable cube to the scene (default: on).",
    )
    parser.add_argument(
        "--cube-pos", default="0.2,0.0", help="Cube x,y on the floor, in metres. Default 0.2,0.0."
    )
    parser.add_argument(
        "--cube-size", type=float, default=0.015, help="Cube half-extent in metres. Default 0.015."
    )
    parser.add_argument("--cube-mass", type=float, default=0.05, help="Cube mass in kg. Default 0.05.")
    parser.add_argument(
        "--sign",
        default=None,
        help="Per-joint direction, one value or 6 comma-separated (e.g. '1,-1,1,1,1,1').",
    )
    parser.add_argument(
        "--offset", default=None, help="Per-joint zero offset in degrees, one value or 6 comma-separated."
    )
    args = parser.parse_args()

    if not args.scene.is_file():
        sys.exit(
            f"MJCF scene not found at {args.scene}\n"
            "Fetch it with:\n"
            "  git clone --filter=blob:none --sparse --depth 1 "
            "https://github.com/TheRobotStudio/SO-ARM100.git\n"
            "  cd SO-ARM100 && git sparse-checkout set Simulation/SO101"
        )

    try:
        cx, cy = (float(v) for v in args.cube_pos.split(","))
    except ValueError:
        sys.exit("--cube-pos wants two comma-separated numbers, e.g. '0.2,0.0'.")

    sign = parse_per_joint(args.sign, 1.0, "sign")
    offset = parse_per_joint(args.offset, 0.0, "offset")

    model = build_model(args.scene, args.cube, (cx, cy), args.cube_size, args.cube_mass)
    data = mujoco.MjData(model)

    # Address the arm explicitly: with a cube in the scene, qpos is no longer
    # just the six arm joints, so slicing qpos[:6] would be wrong.
    def joint_id(name: str) -> int:
        jid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, name)
        if jid < 0:
            sys.exit(f"Joint '{name}' not found in {args.scene.name}.")
        return jid

    arm_qpos = np.array([model.jnt_qposadr[joint_id(j)] for j in JOINTS])
    arm_dof = np.array([model.jnt_dofadr[joint_id(j)] for j in JOINTS])
    arm_ctrl = np.array(
        [mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_ACTUATOR, j) for j in JOINTS]
    )

    port = args.port or autodetect_port()
    leader = SO101Leader(SO101LeaderConfig(port=port, id=args.id))
    leader.connect(calibrate=False)

    if not leader.is_calibrated:
        leader.disconnect()
        sys.exit(
            f"Leader '{args.id}' has no calibration, so its readings are raw ticks and would be "
            "meaningless as joint angles.\nRun: python scripts/stream_leader.py --calibrated "
            f"--id {args.id}"
        )

    leader.disable_torque()

    period = 1.0 / args.rate
    steps_per_frame = max(1, round(period / model.opt.timestep))

    print(f"Leader on {port}, model {args.scene.name}, mode '{args.mode}'.")
    if args.cube:
        print(f"Cube: {args.cube_size * 2 * 100:.0f}mm, {args.cube_mass * 1e3:.0f}g, at ({cx}, {cy}).")
    print(f"Stepping {steps_per_frame} x {model.opt.timestep * 1e3:.1f}ms per frame.")
    print("Move the leader; close the viewer window to stop.")

    try:
        with mujoco.viewer.launch_passive(model, data) as viewer:
            # Start at the leader's pose so the arm doesn't swing in from the
            # model's default posture and punt the cube across the floor.
            targets = action_to_radians(leader.get_action(), sign, offset)
            data.qpos[arm_qpos] = targets
            data.ctrl[arm_ctrl] = targets
            mujoco.mj_forward(model, data)

            while viewer.is_running():
                frame_start = time.perf_counter()
                targets = action_to_radians(leader.get_action(), sign, offset)

                # Both modes step the sim, so scene objects always have real
                # dynamics. The modes differ only in how the arm is driven.
                if args.mode == "mirror":
                    for _ in range(steps_per_frame):
                        data.qpos[arm_qpos] = targets
                        data.qvel[arm_dof] = 0.0
                        mujoco.mj_step(model, data)
                else:
                    data.ctrl[arm_ctrl] = targets
                    for _ in range(steps_per_frame):
                        mujoco.mj_step(model, data)

                viewer.sync()

                sleep = period - (time.perf_counter() - frame_start)
                if sleep > 0:
                    time.sleep(sleep)
    except RuntimeError as err:
        if "mjpython" in str(err).lower():
            sys.exit(
                "MuJoCo's viewer needs mjpython on macOS. Re-run as:\n"
                f"  mjpython {' '.join(sys.argv)}"
            )
        raise
    except KeyboardInterrupt:
        pass
    finally:
        leader.disconnect()

    print("Stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
