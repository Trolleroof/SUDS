#!/usr/bin/env python3
"""Label passive gripper frames from two ArUco markers using OpenCV."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np


def marker_gap(frame: np.ndarray, left_id: int, right_id: int) -> float | None:
    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    corners, ids, _ = cv2.aruco.ArucoDetector(dictionary).detectMarkers(frame)
    if ids is None:
        return None
    centers = {int(tag): pts.reshape(4, 2).mean(axis=0) for tag, pts in zip(ids.ravel(), corners)}
    if left_id not in centers or right_id not in centers:
        return None
    return float(np.linalg.norm(centers[left_id] - centers[right_id]))


def classify_gap(gap_px: float | None, closed_max_px: float, open_min_px: float) -> str:
    if gap_px is None:
        return "unknown"
    if gap_px <= closed_max_px:
        return "closed"
    if gap_px >= open_min_px:
        return "open"
    return "unknown"


def _self_test() -> None:
    frame = np.full((480, 640), 255, dtype=np.uint8)
    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    frame[200:280, 180:260] = cv2.aruco.generateImageMarker(dictionary, 1, 80)
    frame[200:280, 380:460] = cv2.aruco.generateImageMarker(dictionary, 2, 80)
    gap = marker_gap(cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR), 1, 2)
    assert gap is not None and 199 <= gap <= 201
    assert classify_gap(50, 80, 160) == "closed"
    assert classify_gap(gap, 80, 160) == "open"
    assert classify_gap(120, 80, 160) == "unknown"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", nargs="?", type=Path)
    parser.add_argument("--left-id", type=int, default=1)
    parser.add_argument("--right-id", type=int, default=2)
    parser.add_argument("--closed-max-px", type=float)
    parser.add_argument("--open-min-px", type=float)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        _self_test()
        print("gripper vision checks passed")
        return 0
    if args.video is None or args.closed_max_px is None or args.open_min_px is None:
        parser.error("video, --closed-max-px, and --open-min-px are required")
    if args.closed_max_px >= args.open_min_px:
        parser.error("--closed-max-px must be less than --open-min-px")

    capture = cv2.VideoCapture(str(args.video))
    if not capture.isOpened():
        raise SystemExit(f"could not open {args.video}")
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    output = args.output.open("w") if args.output else sys.stdout
    try:
        frame_index = 0
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            gap = marker_gap(frame, args.left_id, args.right_id)
            row = {
                "frame_index": frame_index,
                "timestamp": round(frame_index / fps, 6),
                "state": classify_gap(gap, args.closed_max_px, args.open_min_px),
                "gap_px": None if gap is None else round(gap, 2),
            }
            output.write(json.dumps(row, separators=(",", ":")) + "\n")
            frame_index += 1
    finally:
        capture.release()
        if output is not sys.stdout:
            output.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
