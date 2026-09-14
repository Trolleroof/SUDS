#!/usr/bin/env python
"""Green-block pick v2: drive the green blob into the wrist grasp zone, then close.

Grasp zone = lower-center of the wrist image (above the visible fingertips).
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
OUT = Path("/Users/nikhi/SUDS/outputs/green_pick_v2")
OUT.mkdir(parents=True, exist_ok=True)

STEP = 2.0
MAX_DELTA = {
    "shoulder_pan": 35.0,
    "shoulder_lift": 35.0,
    "elbow_flex": 35.0,
    "wrist_flex": 30.0,
    "wrist_roll": 20.0,
    "gripper": 90.0,
}
GRIPPER_OPEN = 50.0
GRIPPER_CLOSE = 5.0
# wrist image target: just above fingertips
TARGET_X = 0.50
TARGET_Y = 0.72
OK_X = 0.07
OK_Y = 0.08
AREA_GRASP = 0.028
MAX_ITERS = 50


@dataclass
class Blob:
    cx: float
    cy: float
    area: float
    w: int
    h: int


def grab() -> np.ndarray:
    cap = cv2.VideoCapture(WRIST_CAM)
    if not cap.isOpened():
        raise RuntimeError("wrist cam open failed")
    frame = None
    for _ in range(12):
        ok, frame = cap.read()
        if not ok:
            frame = None
    cap.release()
    if frame is None:
        raise RuntimeError("wrist cam read failed")
    return frame


def find_green(frame: np.ndarray) -> Blob | None:
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, (40, 90, 60), (90, 255, 255))
    mask = cv2.medianBlur(mask, 5)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None
    c = max(cnts, key=cv2.contourArea)
    area = float(cv2.contourArea(c))
    if area < 350:
        return None
    m = cv2.moments(c)
    if m["m00"] <= 1e-6:
        return None
    h, w = frame.shape[:2]
    return Blob(m["m10"] / m["m00"], m["m01"] / m["m00"], area, w, h)


def annotate(frame, blob, label):
    out = frame.copy()
    cv2.putText(out, label, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
    tx, ty = int(TARGET_X * out.shape[1]), int(TARGET_Y * out.shape[0])
    cv2.drawMarker(out, (tx, ty), (255, 255, 0), cv2.MARKER_CROSS, 24, 2)
    if blob is not None:
        cv2.circle(out, (int(blob.cx), int(blob.cy)), 8, (0, 0, 255), -1)
    return out


def read_pose(robot):
    obs = robot.get_observation()
    return {k.removesuffix(".pos"): float(v) for k, v in obs.items() if k.endswith(".pos")}


def clamp(pose, origin):
    return {
        k: float(min(origin[k] + MAX_DELTA.get(k, 20), max(origin[k] - MAX_DELTA.get(k, 20), v)))
        for k, v in pose.items()
    }


def send(robot, pose):
    robot.send_action({f"{k}.pos": float(v) for k, v in pose.items()})


def ramp(robot, start, goal, seconds=0.45, fps=20.0):
    steps = max(1, int(seconds * fps))
    for i in range(1, steps + 1):
        t = 0.5 * (1 - math.cos(math.pi * (i / steps)))
        pose = {k: start[k] + t * (goal[k] - start[k]) for k in start}
        send(robot, pose)
        time.sleep(1 / fps)
    return read_pose(robot)


def kill(robot):
    try:
        robot.bus.disable_torque(num_retry=3)
    except Exception:
        pass


def save(frame, name):
    path = OUT / name
    cv2.imwrite(str(path), frame)
    return str(path)


def probe_sign(robot, pose, origin, joint, step, blob0, coord="x"):
    """Move +step on joint; return sign that increases the chosen image coordinate."""
    before = blob0.cx if coord == "x" else blob0.cy
    goal = clamp({**pose, joint: pose[joint] + step}, origin)
    pose2 = ramp(robot, pose, goal, seconds=0.4)
    frame = grab()
    blob = find_green(frame)
    save(annotate(frame, blob, f"probe_{joint}"), f"probe_{joint}.jpg")
    if blob is None:
        # undo
        pose2 = ramp(robot, pose2, pose, seconds=0.4)
        return pose2, 1.0, False
    after = blob.cx if coord == "x" else blob.cy
    # +joint caused after-before change; sign for "increase coord" is sign(after-before) relative to +step
    delta = after - before
    sign = 1.0 if delta >= 0 else -1.0
    return pose2, sign, True


def main():
    from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig

    log = {"steps": []}
    cfg = SO101FollowerConfig(port=ROBOT_PORT, id="follower", disable_torque_on_disconnect=False, cameras={})
    robot = SO101Follower(cfg)
    robot.connect(calibrate=False)
    try:
        origin = read_pose(robot)
        # fresh origin for this attempt (travel measured from here)
        log["origin"] = origin
        pose = dict(origin)

        pose = ramp(robot, pose, clamp({**pose, "gripper": GRIPPER_OPEN}, origin), seconds=0.7)
        frame = grab()
        blob = find_green(frame)
        save(annotate(frame, blob, "open"), "00_open.jpg")
        if blob is None:
            log["status"] = "no_green"
            print(json.dumps(log, indent=2))
            return 2

        # Learn which way pan moves blob in x, and which way shoulder_lift moves blob in y
        pose, pan_to_inc_x, ok = probe_sign(robot, pose, origin, "shoulder_pan", STEP, blob, "x")
        frame = grab(); blob = find_green(frame)
        if not ok or blob is None:
            log["status"] = "pan_probe_failed"
            print(json.dumps(log, indent=2))
            return 3
        pose, lift_to_inc_y, ok = probe_sign(robot, pose, origin, "shoulder_lift", STEP, blob, "y")
        frame = grab(); blob = find_green(frame)
        if not ok or blob is None:
            log["status"] = "lift_probe_failed"
            print(json.dumps(log, indent=2))
            return 4
        # elbow as secondary for y
        pose, elbow_to_inc_y, ok = probe_sign(robot, pose, origin, "elbow_flex", STEP, blob, "y")
        frame = grab(); blob = find_green(frame)
        if blob is None:
            log["status"] = "lost_after_probes"
            print(json.dumps(log, indent=2))
            return 5

        log["pan_to_inc_x"] = pan_to_inc_x
        log["lift_to_inc_y"] = lift_to_inc_y
        log["elbow_to_inc_y"] = elbow_to_inc_y

        best_area = blob.area
        best_pose = dict(pose)

        for i in range(MAX_ITERS):
            frame = grab()
            blob = find_green(frame)
            save(annotate(frame, blob, f"servo_{i:02d}"), f"servo_{i:02d}.jpg")
            if blob is None:
                # retreat to best
                pose = ramp(robot, pose, best_pose, seconds=0.6)
                log["status"] = "lost_green"
                log["at"] = i
                print(json.dumps(log, indent=2))
                return 6

            if blob.area > best_area:
                best_area = blob.area
                best_pose = dict(pose)

            nx = blob.cx / blob.w - TARGET_X
            ny = blob.cy / blob.h - TARGET_Y
            area_frac = blob.area / float(blob.w * blob.h)
            log["steps"].append({"i": i, "nx": nx, "ny": ny, "area_frac": area_frac, "pose": dict(pose)})

            if abs(nx) <= OK_X and abs(ny) <= OK_Y and area_frac >= AREA_GRASP:
                log["ready"] = i
                break
            # also grasp if very close in y (in grasp band) and x ok even if area a bit low
            if abs(nx) <= OK_X and blob.cy / blob.h >= 0.65 and area_frac >= 0.02:
                log["ready_band"] = i
                break

            goal = dict(pose)
            if abs(nx) > OK_X:
                # want to decrease nx: move pan opposite to nx using pan_to_inc_x
                # if nx>0 blob too far right; need to decrease cx → move -pan_to_inc_x
                goal["shoulder_pan"] = pose["shoulder_pan"] - pan_to_inc_x * math.copysign(STEP, nx)
            if abs(ny) > OK_Y:
                # want to decrease ny (move blob toward TARGET_Y)
                goal["shoulder_lift"] = pose["shoulder_lift"] - lift_to_inc_y * math.copysign(STEP, ny)
                goal["elbow_flex"] = pose["elbow_flex"] - elbow_to_inc_y * math.copysign(STEP * 0.8, ny)
                # tip wrist down when blob is still high in the frame
                if ny < 0:
                    goal["wrist_flex"] = pose["wrist_flex"] + 1.5

            goal = clamp(goal, origin)
            # if clamp made no change and we're not aligned, try wrist pitch only
            if all(abs(goal[k] - pose[k]) < 1e-6 for k in goal) and ny < 0:
                goal = clamp({**pose, "wrist_flex": pose["wrist_flex"] + 2.5}, origin)
            pose = ramp(robot, pose, goal, seconds=0.35)
        else:
            # timeout: go to best area pose and attempt close anyway if reasonably near
            pose = ramp(robot, pose, best_pose, seconds=0.7)
            frame = grab(); blob = find_green(frame)
            save(annotate(frame, blob, "best_fallback"), "89_best_fallback.jpg")
            log["status"] = "timeout_fallback"
            if blob is None or blob.area / (blob.w * blob.h) < 0.015:
                print(json.dumps(log, indent=2))
                return 7

        # final inch-in: small moves that maximize area
        for j in range(6):
            frame = grab(); blob = find_green(frame)
            if blob is None:
                break
            base = dict(pose)
            candidates = [
                base,
                clamp({**base, "shoulder_lift": base["shoulder_lift"] + STEP}, origin),
                clamp({**base, "shoulder_lift": base["shoulder_lift"] - STEP}, origin),
                clamp({**base, "elbow_flex": base["elbow_flex"] + STEP}, origin),
                clamp({**base, "elbow_flex": base["elbow_flex"] - STEP}, origin),
                clamp({**base, "wrist_flex": base["wrist_flex"] + 2.0}, origin),
            ]
            scored = []
            # evaluate without moving first? we have to move — use sequential with undo
            cur_area = blob.area
            best_local = base
            best_a = cur_area
            for cand in candidates[1:]:
                pose = ramp(robot, pose, cand, seconds=0.25)
                f = grab(); b = find_green(f)
                a = b.area if b is not None else -1
                if a > best_a:
                    best_a = a
                    best_local = dict(pose)
                # return to base before next cand
                pose = ramp(robot, pose, base, seconds=0.25)
            pose = ramp(robot, pose, best_local, seconds=0.3)
            save(annotate(grab(), find_green(grab()), f"inch_{j}"), f"inch_{j}.jpg")
            if best_a <= cur_area * 1.01:
                break

        frame = grab(); blob = find_green(frame)
        save(annotate(frame, blob, "pre_close"), "90_pre_close.jpg")
        pose = ramp(robot, pose, clamp({**pose, "gripper": GRIPPER_CLOSE}, origin), seconds=0.8)
        time.sleep(0.35)
        frame = grab(); blob = find_green(frame)
        save(annotate(frame, blob, "closed"), "91_closed.jpg")

        # lift straight-ish
        lift = clamp({
            **pose,
            "shoulder_lift": pose["shoulder_lift"] - 8.0,
            "elbow_flex": pose["elbow_flex"] + 4.0,
        }, origin)
        pose = ramp(robot, pose, lift, seconds=1.0)
        frame = grab(); blob = find_green(frame)
        save(annotate(frame, blob, "lifted"), "92_lifted.jpg")

        # overhead evidence
        cap = cv2.VideoCapture(1)
        oh = None
        if cap.isOpened():
            for _ in range(10):
                ok, oh = cap.read()
            cap.release()
            if oh is not None:
                save(oh, "93_overhead_after.jpg")

        log["final_pose"] = pose
        log["status"] = "attempted"
        print(json.dumps(log, indent=2))
        return 0
    except Exception as e:
        log["status"] = "error"
        log["error"] = str(e)
        kill(robot)
        print(json.dumps(log, indent=2))
        return 1
    finally:
        try:
            robot.disconnect()
        except Exception:
            kill(robot)


if __name__ == "__main__":
    raise SystemExit(main())
