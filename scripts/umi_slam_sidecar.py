#!/usr/bin/env python3
"""Transform official UMI/ORB-SLAM3 camera trajectories into SO-101 TCP poses."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

import cv2
import numpy as np

SLAM_COLUMNS = {"timestamp", "x", "y", "z", "q_x", "q_y", "q_z", "q_w", "is_lost"}


def quaternion_matrix(x: float, y: float, z: float, w: float) -> np.ndarray:
    q = np.array([x, y, z, w], dtype=float)
    norm = np.linalg.norm(q)
    if norm < 1e-8:
        raise ValueError("zero-length quaternion")
    x, y, z, w = q / norm
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )


def matrix(path: Path, key: str) -> np.ndarray:
    value = np.asarray(json.loads(path.read_text())[key], dtype=float)
    if value.shape != (4, 4) or not np.allclose(value[3], [0, 0, 0, 1]):
        raise ValueError(f"{path}:{key} must be a 4x4 homogeneous transform")
    return value


def lost(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes"}


def tcp_pose(row: dict[str, str], base_from_slam: np.ndarray, camera_to_tcp: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    slam_to_camera = np.eye(4)
    slam_to_camera[:3, :3] = quaternion_matrix(*(float(row[k]) for k in ("q_x", "q_y", "q_z", "q_w")))
    slam_to_camera[:3, 3] = [float(row[k]) for k in ("x", "y", "z")]
    base_to_tcp = base_from_slam @ slam_to_camera @ camera_to_tcp
    return base_to_tcp[:3, 3], cv2.Rodrigues(base_to_tcp[:3, :3])[0].ravel()


def _self_test() -> None:
    rotation = quaternion_matrix(0, 0, 0, 1)
    assert np.allclose(rotation, np.eye(3))
    assert lost("true") and not lost("false")
    row = {"x": "1", "y": "2", "z": "3", "q_x": "0", "q_y": "0", "q_z": "0", "q_w": "1"}
    position, rotvec = tcp_pose(row, np.eye(4), np.eye(4))
    assert np.allclose(position, [1, 2, 3]) and np.allclose(rotvec, 0)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trajectory", nargs="?", type=Path)
    parser.add_argument("--base-from-slam", type=Path)
    parser.add_argument("--camera-to-tcp", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--max-lost", type=int, default=10)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        _self_test()
        print("UMI SLAM sidecar checks passed")
        return 0
    if not all((args.trajectory, args.base_from_slam, args.camera_to_tcp, args.output)):
        parser.error("trajectory, --base-from-slam, --camera-to-tcp, and --output are required")

    base_from_slam = matrix(args.base_from_slam, "base_from_slam")
    camera_to_tcp = matrix(args.camera_to_tcp, "camera_to_tcp")
    with args.trajectory.open(newline="") as stream:
        reader = csv.DictReader(stream)
        missing = SLAM_COLUMNS - set(reader.fieldnames or ())
        if missing:
            raise SystemExit(f"trajectory is missing columns: {', '.join(sorted(missing))}")
        source = list(reader)
    if not source:
        raise SystemExit("trajectory has no frames")
    lost_count = sum(lost(row["is_lost"]) for row in source)
    if lost_count > args.max_lost:
        raise SystemExit(f"refusing trajectory with {lost_count} lost frames (max {args.max_lost})")

    timestamps = [float(row["timestamp"]) for row in source]
    if any(b <= a for a, b in zip(timestamps, timestamps[1:])):
        raise SystemExit("trajectory timestamps must be strictly increasing")

    fields = ["frame_index", "timestamp", "x", "y", "z", "rx", "ry", "rz", "tracked"]
    with args.output.open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for frame_index, row in enumerate(source):
            position, rotvec = tcp_pose(row, base_from_slam, camera_to_tcp)
            writer.writerow(
                {
                    "frame_index": frame_index,
                    "timestamp": row["timestamp"],
                    "x": position[0],
                    "y": position[1],
                    "z": position[2],
                    "rx": rotvec[0],
                    "ry": rotvec[1],
                    "rz": rotvec[2],
                    "tracked": int(not lost(row["is_lost"])),
                }
            )
    print(f"wrote {len(source)} TCP poses to {args.output} ({lost_count} lost)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
