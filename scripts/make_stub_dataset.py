#!/usr/bin/env python
"""Write a synthetic LeRobot v3 dataset so the dashboard can be built and tested
before any hardware exists.

This goes through LeRobotDataset itself rather than hand-writing parquet, so the
layout, the meta schema, and the episode/video timestamp bookkeeping are exactly
what `lerobot-record` produces -- if the dashboard reads this, it reads a real
recording.

    python scripts/make_stub_dataset.py --repo-id suds/stub --episodes 8
"""

from __future__ import annotations

import argparse
import shutil

import numpy as np

from lerobot.configs.video import RGBEncoderConfig
from lerobot.datasets.lerobot_dataset import LeRobotDataset
from lerobot.utils.constants import HF_LEROBOT_HOME

JOINTS = [
    "shoulder_pan.pos",
    "shoulder_lift.pos",
    "elbow_flex.pos",
    "wrist_flex.pos",
    "wrist_roll.pos",
    "gripper.pos",
]
CAMERAS = ["observation.images.overhead", "observation.images.wrist"]
HEIGHT, WIDTH = 240, 320


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-id", default="suds/stub")
    parser.add_argument("--episodes", type=int, default=8)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--seconds", type=float, default=4.0)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()

    features = {
        "observation.state": {"dtype": "float32", "shape": (len(JOINTS),), "names": JOINTS},
        "action": {"dtype": "float32", "shape": (len(JOINTS),), "names": JOINTS},
    }
    for cam in CAMERAS:
        features[cam] = {"dtype": "video", "shape": (HEIGHT, WIDTH, 3), "names": ["height", "width", "channels"]}

    root = HF_LEROBOT_HOME / args.repo_id
    if root.exists():
        if not args.overwrite:
            raise SystemExit(f"{root} already exists; pass --overwrite to replace it.")
        shutil.rmtree(root)

    dataset = LeRobotDataset.create(
        repo_id=args.repo_id,
        fps=args.fps,
        features=features,
        robot_type="so101_follower",
        use_videos=True,
        # LeRobot defaults to AV1, which Safari only decodes on M3 and newer.
        # H.264 plays in every browser, which matters for a review dashboard.
        rgb_encoder=RGBEncoderConfig(vcodec="h264"),
    )

    rng = np.random.default_rng(0)
    for episode in range(args.episodes):
        # Vary the episode length a little; identical lengths would hide the
        # length histogram the dashboard is meant to surface.
        frames = int(args.fps * args.seconds * (0.85 + 0.3 * rng.random()))
        phase = rng.random() * np.pi
        for i in range(frames):
            u = i / max(frames - 1, 1)
            state = _pose(u, phase)
            # The action leads the state slightly, the way a leader arm does.
            action = _pose(min(u + 0.03, 1.0), phase)
            dataset.add_frame(
                {
                    "observation.state": state.astype(np.float32),
                    "action": action.astype(np.float32),
                    **{cam: _frame(u, c) for c, cam in enumerate(CAMERAS)},
                    "task": "pick up the sponge",
                }
            )
        dataset.save_episode()
        print(f"episode {episode}: {frames} frames")

    print(f"\nwrote {args.episodes} episodes to {dataset.root}")
    return 0


def _pose(u: float, phase: float) -> np.ndarray:
    """A smooth reach-and-close trajectory, in the degrees-ish units LeRobot uses."""
    return np.array(
        [
            30 * np.sin(2 * np.pi * u + phase),
            -20 + 35 * np.sin(np.pi * u),
            45 * np.sin(np.pi * u) - 10,
            15 * np.cos(2 * np.pi * u + phase),
            10 * np.sin(4 * np.pi * u),
            100 * (u > 0.6),  # gripper snaps shut partway through
        ]
    )


def _frame(u: float, cam: int) -> np.ndarray:
    """A moving block on a gradient -- enough for the video pane to show motion."""
    img = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    img[:, :, 2] = np.linspace(20, 90, WIDTH, dtype=np.uint8)[None, :]
    x = int(u * (WIDTH - 40))
    y = int((HEIGHT - 40) * (0.5 + 0.4 * np.sin(2 * np.pi * u)))
    img[y : y + 40, x : x + 40] = (240, 120, 40) if cam == 0 else (60, 220, 160)
    return img


if __name__ == "__main__":
    raise SystemExit(main())
