#!/usr/bin/env python3
"""Check a recorded LeRobot dataset against a policy's fine-tuning contract.

Run this before renting a GPU. It catches the failures that only surface after
the model is loaded: wrong feature layout, wrong fps, missing quantiles, or an
undecodable video codec.

    python scripts/preflight.py                  # GR00T N1.7 (default)
    python scripts/preflight.py --policy molmoact2

Exits non-zero if any hard check fails.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path
from urllib.request import urlopen

REPO = Path(__file__).resolve().parent.parent

EXPECTED_LAYOUT = [
    "shoulder_pan.pos",
    "shoulder_lift.pos",
    "elbow_flex.pos",
    "wrist_flex.pos",
    "wrist_roll.pos",
    "gripper.pos",
]
EXPECTED_FPS = 30

# GR00T pads state/action into a fixed-width vector and learns its own q01/q99
# per embodiment, so the only dimensional requirement is fitting inside it.
GROOT_MAX_DIM = 132

# MolmoAct2 only: the released checkpoint is old-convention, a fresh
# `lerobot-calibrate` is not. The policy reconciles them as an explicit step:
#     q_model = signs * q_lerobot + offsets
MOLMOACT2_JOINT_SIGNS = [1.0, -1.0, 1.0, 1.0, 1.0, 1.0]
MOLMOACT2_JOINT_OFFSETS = [0.0, 90.0, 90.0, 0.0, 0.0, 0.0]
MOLMOACT2_NORM_STATS_URL = (
    "https://huggingface.co/allenai/MolmoAct2-SO100_101/resolve/main/norm_stats.json"
)
MOLMOACT2_NORM_TAG = "so100_so101_molmoact2"

failures: list[str] = []
warnings: list[str] = []


def check(ok: bool, label: str, detail: str = "") -> bool:
    print(f"  [{'ok  ' if ok else 'FAIL'}] {label}" + (f" -- {detail}" if detail else ""))
    if not ok:
        failures.append(label)
    return ok


def warn(label: str, detail: str = "") -> None:
    print(f"  [warn] {label}" + (f" -- {detail}" if detail else ""))
    warnings.append(label)


def check_molmoact2_joint_frame(stats: dict, tolerance: float) -> None:
    """Compare recorded joint ranges to the distribution the base was trained on."""
    print(f"\njoint frame vs checkpoint training distribution (molmoact2)")
    print(f"  fetching {MOLMOACT2_NORM_TAG} stats from allenai/MolmoAct2-SO100_101")
    try:
        with urlopen(MOLMOACT2_NORM_STATS_URL, timeout=60) as response:
            norm = json.load(response)["metadata_by_tag"][MOLMOACT2_NORM_TAG]
    except Exception as exc:  # network is optional; the rest of the preflight still stands
        warn("could not fetch released norm_stats.json", str(exc))
        return

    def to_model_frame(values: list[float]) -> list[float]:
        return [s * v + o for s, v, o in zip(MOLMOACT2_JOINT_SIGNS, values, MOLMOACT2_JOINT_OFFSETS)]

    for key, block in (("observation.state", "state_stats"), ("action", "action_stats")):
        ref_lo, ref_hi = norm[block]["q01"], norm[block]["q99"]
        # A negative sign flips the order of a quantile pair, so re-sort per joint.
        pairs = [sorted(p) for p in zip(to_model_frame(stats[key]["q01"]),
                                        to_model_frame(stats[key]["q99"]))]
        print(f"\n  {key} (model frame, degrees)")
        for i, name in enumerate(EXPECTED_LAYOUT):
            lo, hi = pairs[i]
            slack = max(ref_lo[i] - lo, hi - ref_hi[i])
            status = "ok  " if slack <= tolerance else "OUT "
            print(f"    [{status}] {name:17s} ours [{lo:8.1f},{hi:8.1f}]  "
                  f"ckpt [{ref_lo[i]:8.1f},{ref_hi[i]:8.1f}]")
            if slack > tolerance:
                warnings.append(f"{key}/{name} sits {slack:.1f} deg outside checkpoint q01/q99")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--policy", choices=["groot", "molmoact2"], default="groot")
    parser.add_argument(
        "--root",
        type=Path,
        default=Path.home() / ".cache/huggingface/lerobot/suds/live_2",
    )
    parser.add_argument("--subsets", type=Path, default=REPO / "datasets/suds__live_2.subsets.json")
    parser.add_argument("--tolerance", type=float, default=15.0,
                        help="molmoact2 only: degrees a joint may sit outside the base q01/q99")
    args = parser.parse_args()

    info = json.loads((args.root / "meta/info.json").read_text())
    stats = json.loads((args.root / "meta/stats.json").read_text())

    print(f"\npolicy: {args.policy}")

    print("\nfeature contract")
    state = info["features"]["observation.state"]
    action = info["features"]["action"]
    check(state["names"] == EXPECTED_LAYOUT, "state layout is joint_gripper_6")
    check(action["names"] == EXPECTED_LAYOUT, "action layout is joint_gripper_6")
    check(info["fps"] == EXPECTED_FPS, "fps is 30", f"got {info['fps']}")

    if args.policy == "groot":
        # new_embodiment pads into a fixed-width vector; it does not require 6 dims.
        check(
            state["shape"][0] <= GROOT_MAX_DIM and action["shape"][0] <= GROOT_MAX_DIM,
            f"state/action fit GR00T's {GROOT_MAX_DIM}-dim vector",
            f"state {state['shape'][0]}, action {action['shape'][0]}",
        )
    else:
        check(state["shape"] == [6] and action["shape"] == [6], "state/action are 6-dim")

    print("\ncameras")
    cams = sorted(k for k in info["features"] if k.startswith("observation.images."))
    check(len(cams) == 2, "exactly two camera streams", ", ".join(cams))
    for cam in cams:
        codec = info["features"][cam]["info"].get("video.codec")
        if codec == "av1":
            warn(f"{cam} is AV1", "pass --dataset.video_backend=pyav")
        else:
            check(codec is not None, f"{cam} declares a codec", str(codec))

    print("\nquantile statistics")
    for key in ("observation.state", "action"):
        check(key in stats and {"q01", "q99"} <= set(stats[key]), f"{key} has q01/q99")

    if args.policy == "molmoact2":
        check_molmoact2_joint_frame(stats, args.tolerance)
    else:
        print("\njoint frame")
        print("  [ok  ] GR00T new_embodiment learns q01/q99 from this dataset -- no remap needed")

    print("\nepisode subsets")
    if args.subsets.exists():
        subsets = json.loads(args.subsets.read_text())
        pool = subsets["pool"]
        check(len(pool) > 0, "frozen pass pool is non-empty", f"{len(pool)} episodes")
        check(max(pool) < info["total_episodes"], "every pooled episode exists in the dataset",
              f"max {max(pool)} < {info['total_episodes']}")
        for budget, episodes in subsets["subsets"].items():
            check(set(episodes) <= set(pool), f"{budget}-demo subset draws only from the pass pool")
    else:
        warn("no subsets file", f"run scripts/make_subsets.py first ({args.subsets})")

    print("\nffprobe spot check")
    sample = next(args.root.glob("videos/**/*.mp4"), None)
    if sample is None:
        warn("no mp4 found under videos/")
    else:
        try:
            out = subprocess.run(
                ["ffprobe", "-v", "error", "-select_streams", "v:0",
                 "-show_entries", "stream=codec_name,width,height,r_frame_rate",
                 "-of", "json", str(sample)],
                capture_output=True, text=True, timeout=30, check=True,
            )
            s = json.loads(out.stdout)["streams"][0]
            print(f"  [ok  ] {sample.name}: {s['codec_name']} "
                  f"{s['width']}x{s['height']} @ {s['r_frame_rate']}")
        except FileNotFoundError:
            warn("ffprobe not installed", "brew install ffmpeg")
        except Exception as exc:
            check(False, "ffprobe could decode a sample video", str(exc))

    print()
    if failures:
        print(f"{len(failures)} hard check(s) failed:")
        for item in failures:
            print(f"  - {item}")
    if warnings:
        print(f"{len(warnings)} warning(s):")
        for item in warnings:
            print(f"  - {item}")
    if not failures and not warnings:
        print("all checks passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
