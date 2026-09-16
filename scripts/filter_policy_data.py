#!/usr/bin/env python3
"""Build a camera-corrected, non-destructive SUDS training snapshot.

The original dataset stays untouched. Files are hard-linked to save disk space;
only corrected metadata and swapped video directory entries differ.

    .venv/bin/python scripts/filter_policy_data.py --dataset suds__live_2
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
from pathlib import Path

import cv2
import numpy as np
import pandas as pd

from make_subsets import resolve_labels


TASK = "pick up the yellow sponge"


def first_frame(path: Path):
    capture = cv2.VideoCapture(str(path))
    ok, frame = capture.read()
    capture.release()
    return frame if ok else None


def orange_fraction(frame) -> float:
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    return float(((hsv[:, :, 0] >= 2) & (hsv[:, :, 0] <= 25) & (hsv[:, :, 1] > 100) & (hsv[:, :, 2] > 100)).mean())


def write_parquet_safely(frame: pd.DataFrame, path: Path) -> None:
    temporary = path.with_suffix(".tmp.parquet")
    frame.to_parquet(temporary, index=False)
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="suds__live_2")
    args = parser.parse_args()

    repo = Path(__file__).resolve().parents[1]
    source = Path.home() / ".cache/huggingface/lerobot/suds" / args.dataset.removeprefix("suds__")
    corrected = source.with_name(f"{source.name}_corrected")
    if corrected.exists():
        raise SystemExit(f"refusing to overwrite existing snapshot: {corrected}")

    temporary = Path(tempfile.mkdtemp(prefix=f".{corrected.name}-", dir=source.parent))
    shutil.copytree(source, temporary, dirs_exist_ok=True, copy_function=os.link)

    swapped: list[int] = []
    unreadable: list[int] = []
    total = json.loads((source / "meta/info.json").read_text())["total_episodes"]
    for episode in range(total):
        wrist = source / f"videos/observation.images.wrist/chunk-000/file-{episode:03d}.mp4"
        overhead = source / f"videos/observation.images.overhead/chunk-000/file-{episode:03d}.mp4"
        wrist_frame, overhead_frame = first_frame(wrist), first_frame(overhead)
        if wrist_frame is None or overhead_frame is None:
            unreadable.append(episode)
            continue
        # The source rig labels these two physical cameras in reverse.
        target_wrist = temporary / wrist.relative_to(source)
        target_overhead = temporary / overhead.relative_to(source)
        swap = target_wrist.with_suffix(".swap")
        target_wrist.rename(swap)
        target_overhead.rename(target_wrist)
        swap.rename(target_overhead)
        swapped.append(episode)

        episode_meta = temporary / f"meta/episodes/chunk-000/file-{episode:03d}.parquet"
        meta = pd.read_parquet(episode_meta)
        meta["tasks"] = [np.array([TASK], dtype=object)] * len(meta)
        if episode in swapped:
            for wrist_column in [column for column in meta if "observation.images.wrist" in column]:
                overhead_column = wrist_column.replace("observation.images.wrist", "observation.images.overhead")
                if overhead_column in meta:
                    meta[wrist_column], meta[overhead_column] = meta[overhead_column].copy(), meta[wrist_column].copy()
        write_parquet_safely(meta, episode_meta)

    tasks = pd.read_parquet(temporary / "meta/tasks.parquet")
    tasks["task"] = TASK
    write_parquet_safely(tasks, temporary / "meta/tasks.parquet")
    temporary.rename(corrected)

    labels = resolve_labels(repo / "datasets" / f"{args.dataset}.labels.jsonl")
    passed = sorted(episode for episode, verdict in labels.items() if verdict == "pass" and episode not in unreadable)
    discarded = sorted(episode for episode, verdict in labels.items() if verdict != "pass")
    manifest = {
        "dataset_root": str(corrected),
        "task": TASK,
        "camera_schema": {"wrist": "close_bowl_view", "overhead": "wide_arm_view"},
        "episodes": passed,
        "camera_labels_swapped": swapped,
        "excluded": {"dashboard_discard": discarded, "unreadable_video": unreadable},
        "note": "No recorder logs exist, so no episode is labelled as a bus/power fault without evidence.",
    }
    out = repo / "datasets" / f"{args.dataset}.policy_train.json"
    out.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"corrected {len(swapped)} camera labels; retained {len(passed)} passed episodes")
    print(corrected)


if __name__ == "__main__":
    main()
