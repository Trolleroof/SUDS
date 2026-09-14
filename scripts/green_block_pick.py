#!/usr/bin/env python
"""Best-effort green-block pick using wrist-camera visual servo on the SO-101 follower.

Safety: tiny joint steps, joint travel caps from the start pose, torque kill on error.
"""

from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

ROBOT_PORT = "/dev/tty.usbmodem5C821094831"
WRIST_CAM = 0
OUT = Path("/Users/nikhi/SUDS/outputs/green_pick")
OUT.mkdir(parents=True, exist_ok=True)

# Joint step / caps (degrees for arm joints; gripper is 0-100)
PAN_STEP = 1.5
EXTEND_STEP = 1.5
LIFT_STEP = 1.2
MAX_DELTA = {
    "shoulder_pan": 25.0,
    "shoulder_lift": 20.0,
    "elbow_flex": 25.0,
    "wrist_flex": 20.0,
    "wrist_roll": 15.0,
    "gripper": 80.0,
}
GRIPPER_OPEN = 45.0
GRIPPER_CLOSE = 8.0
ALIGN_X = 0.08  # fraction of width
ALIGN_Y = 0.10
AREA_NEAR = 0.035  # blob area / frame area to treat as close enough to grasp
MAX_ITERS = 40


@dataclass
class Blob:
    cx: float
    cy: float
    area: float
    w: int
    h: int


def grab_wrist(index: int = WRIST_CAM) -> np.ndarray:
    cap = cv2.VideoCapture(index)
    if not cap.isOpened():
        raise RuntimeError(f"wrist camera {index} failed to open")
    frame = None
    for _ in range(10):
        ok, frame = cap.read()
        if ok and frame is not None:
            pass
    cap.release()
    if frame is None:
        raise RuntimeError("wrist camera read failed")
    return frame


def find_green(frame: np.ndarray) -> Blob | None:
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    # solid green block; keep saturation high to ignore patterned cloth greens
    mask = cv2.inRange(hsv, (40, 90, 60), (90, 255, 255))
    mask = cv2.medianBlur(mask, 5)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None
    c = max(cnts, key=cv2.contourArea)
    area = float(cv2.contourArea(c))
    if area < 400:
        return None
    m = cv2.moments(c)
    if m["m00"] <= 1e-6:
        return None
    h, w = frame.shape[:2]
    return Blob(cx=m["m10"] / m["m00"], cy=m["m01"] / m["m00"], area=area, w=w, h=h)


def annotate(frame: np.ndarray, blob: Blob | None, label: str) -> np.ndarray:
    out = frame.copy()
    cv2.putText(out, label, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
    if blob is not None:
        cv2.circle(out, (int(blob.cx), int(blob.cy)), 8, (0, 0, 255), -1)
        cv2.drawMarker(out, (blob.w // 2, int(blob.h * 0.55)), (255, 255, 0), cv2.MARKER_CROSS, 20, 2)
    return out


def read_pose(robot) -> dict[str, float]:
    obs = robot.get_observation()
    return {k.removesuffix(".pos"): float(v) for k, v in obs.items() if k.endswith(".pos")}


def clamp_pose(target: dict[str, float], origin: dict[str, float]) -> dict[str, float]:
    out = {}
    for k, v in target.items():
        lo = origin[k] - MAX_DELTA.get(k, 15.0)
        hi = origin[k] + MAX_DELTA.get(k, 15.0)
        out[k] = float(min(hi, max(lo, v)))
    return out


def send_pose(robot, pose: dict[str, float]) -> None:
    robot.send_action({f"{k}.pos": float(v) for k, v in pose.items()})


def ramp(robot, start: dict[str, float], goal: dict[str, float], seconds: float = 1.2, fps: float = 20.0) -> dict[str, float]:
    steps = max(1, int(seconds * fps))
    pose = dict(start)
    for i in range(1, steps + 1):
        t = i / steps
        e = 0.5 * (1 - math.cos(math.pi * t))
        pose = {k: start[k] + e * (goal[k] - start[k]) for k in start}
        send_pose(robot, pose)
        time.sleep(1.0 / fps)
    return read_pose(robot)


def kill(robot) -> None:
    try:
        robot.bus.disable_torque(num_retry=3)
    except Exception:
        try:
            robot.bus.disable_torque()
        except Exception:
            pass


def save(frame: np.ndarray, name: str) -> str:
    path = OUT / name
    cv2.imwrite(str(path), frame)
    return str(path)


def main() -> int:
    from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig

    log: dict = {"steps": []}
    cfg = SO101FollowerConfig(
        port=ROBOT_PORT,
        id="follower",
        disable_torque_on_disconnect=False,  # don't drop a held object / slam the arm on exit
        cameras={},
    )
    robot = SO101Follower(cfg)
    robot.connect(calibrate=False)

    origin = None
    try:
        origin = read_pose(robot)
        log["origin"] = origin
        pose = dict(origin)

        # 1) open gripper
        open_goal = clamp_pose({**pose, "gripper": GRIPPER_OPEN}, origin)
        pose = ramp(robot, pose, open_goal, seconds=0.8)
        frame = grab_wrist()
        blob = find_green(frame)
        save(annotate(frame, blob, "open"), "00_open.jpg")
        if blob is None:
            log["status"] = "no_green_seen"
            print(json.dumps(log, indent=2))
            return 2

        # 2) learn pan sign with a tiny probe
        before = blob.cx
        probe = clamp_pose({**pose, "shoulder_pan": pose["shoulder_pan"] + PAN_STEP}, origin)
        pose = ramp(robot, pose, probe, seconds=0.5)
        frame = grab_wrist()
        blob = find_green(frame)
        save(annotate(frame, blob, "pan_probe"), "01_pan_probe.jpg")
        if blob is None:
            # undo probe
            pose = ramp(robot, pose, clamp_pose({**pose, "shoulder_pan": origin["shoulder_pan"]}, origin), seconds=0.5)
            log["status"] = "lost_green_after_pan_probe"
            print(json.dumps(log, indent=2))
            return 3
        # if cx increased after +pan, blob moved right → to move blob rightward in image use +pan
        pan_sign = 1.0 if blob.cx > before else -1.0
        log["pan_sign"] = pan_sign

        # Extension probe: less-negative shoulder_lift usually reaches forward on this arm's START/REST map
        before_y = blob.cy
        before_area = blob.area
        ext = clamp_pose({**pose, "shoulder_lift": pose["shoulder_lift"] + EXTEND_STEP}, origin)
        pose = ramp(robot, pose, ext, seconds=0.5)
        frame = grab_wrist()
        blob = find_green(frame)
        save(annotate(frame, blob, "extend_probe"), "02_extend_probe.jpg")
        if blob is None:
            pose = ramp(robot, pose, clamp_pose({**pose, "shoulder_lift": origin["shoulder_lift"]}, origin), seconds=0.5)
            log["status"] = "lost_green_after_extend_probe"
            print(json.dumps(log, indent=2))
            return 4
        # Prefer the direction that grows area (getting closer) or moves blob toward lower image (approach)
        lift_sign = 1.0 if (blob.area >= before_area or blob.cy >= before_y) else -1.0
        log["lift_sign"] = lift_sign

        # 3) visual servo
        for i in range(MAX_ITERS):
            frame = grab_wrist()
            blob = find_green(frame)
            save(annotate(frame, blob, f"servo_{i:02d}"), f"servo_{i:02d}.jpg")
            if blob is None:
                log["status"] = "lost_green_during_servo"
                log["servo_i"] = i
                print(json.dumps(log, indent=2))
                return 5

            nx = (blob.cx / blob.w) - 0.5
            # aim a bit below center so gripper tips meet the block
            ny = (blob.cy / blob.h) - 0.55
            area_frac = blob.area / float(blob.w * blob.h)
            step_info = {"i": i, "nx": nx, "ny": ny, "area_frac": area_frac, "pose": dict(pose)}
            log["steps"].append(step_info)

            aligned = abs(nx) < ALIGN_X and abs(ny) < ALIGN_Y
            near = area_frac >= AREA_NEAR

            if aligned and near:
                log["ready_grasp_at"] = i
                break

            goal = dict(pose)
            # pan to cancel x error: we want nx -> 0. If nx>0 blob is right of center, move pan to shift robot toward it.
            # After probe, +pan_sign moves blob to +x in image. To reduce nx, move opposite to nx.
            if abs(nx) >= ALIGN_X:
                goal["shoulder_pan"] = pose["shoulder_pan"] - pan_sign * math.copysign(PAN_STEP, nx)
            # vertical / distance: if blob above target (ny<0), extend; if below, retract a bit
            if abs(ny) >= ALIGN_Y or not near:
                direction = lift_sign if (ny < 0 or not near) else -lift_sign
                # mostly shoulder_lift; add a little elbow in the same geometric sense
                goal["shoulder_lift"] = pose["shoulder_lift"] + direction * EXTEND_STEP
                goal["elbow_flex"] = pose["elbow_flex"] - direction * (EXTEND_STEP * 0.6)
            # tip wrist down a touch as we approach
            if near and pose["wrist_flex"] < origin["wrist_flex"] + 12:
                goal["wrist_flex"] = pose["wrist_flex"] + 1.0

            goal = clamp_pose(goal, origin)
            pose = ramp(robot, pose, goal, seconds=0.35)
        else:
            log["status"] = "servo_timeout"
            print(json.dumps(log, indent=2))
            return 6

        # 4) final descend nudge + close
        descend = clamp_pose(
            {
                **pose,
                "shoulder_lift": pose["shoulder_lift"] + lift_sign * 2.0,
                "elbow_flex": pose["elbow_flex"] - lift_sign * 1.2,
                "wrist_flex": pose["wrist_flex"] + 2.0,
            },
            origin,
        )
        pose = ramp(robot, pose, descend, seconds=0.6)
        frame = grab_wrist()
        blob = find_green(frame)
        save(annotate(frame, blob, "pre_close"), "90_pre_close.jpg")

        close_goal = clamp_pose({**pose, "gripper": GRIPPER_CLOSE}, origin)
        pose = ramp(robot, pose, close_goal, seconds=0.7)
        time.sleep(0.3)
        frame = grab_wrist()
        blob = find_green(frame)
        save(annotate(frame, blob, "closed"), "91_closed.jpg")

        # 5) lift
        lift = clamp_pose(
            {
                **pose,
                "shoulder_lift": pose["shoulder_lift"] - lift_sign * 6.0,
                "elbow_flex": pose["elbow_flex"] + lift_sign * 3.0,
            },
            origin,
        )
        pose = ramp(robot, pose, lift, seconds=1.0)
        frame = grab_wrist()
        blob = find_green(frame)
        save(annotate(frame, blob, "lifted"), "92_lifted.jpg")
        log["final_pose"] = pose
        log["final_blob"] = None if blob is None else {"cx": blob.cx, "cy": blob.cy, "area": blob.area}
        # Heuristic success: still see green near gripper OR gripper didn't fully return (block may occlude)
        log["status"] = "attempted_lift"
        print(json.dumps(log, indent=2))
        return 0
    except Exception as err:
        log["status"] = "error"
        log["error"] = str(err)
        kill(robot)
        print(json.dumps(log, indent=2))
        return 1
    finally:
        try:
            # keep torque on so we don't drop mid-hold; caller can rest later
            robot.disconnect()
        except Exception:
            kill(robot)


if __name__ == "__main__":
    raise SystemExit(main())
