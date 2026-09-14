#!/usr/bin/env python3
"""Freeze the reviewed real-episode pool and cut deterministic demo subsets.

The dashboard appends one JSON line per labeling action, so an episode that was
reviewed more than once appears more than once. Last write wins, by `labeled_at`.

The 5/10/20/40 subsets are nested (each is a prefix of the next) so a budget
difference is only ever *more* data, never different data. Evaluation episodes
are never drawn from here -- physical held-out trials are recorded separately.

    python scripts/make_subsets.py --dataset suds__live_2
"""

import argparse
import json
import random
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BUDGETS = (5, 10, 20, 40)
SEED = 1000


def resolve_labels(path: Path) -> dict[int, str]:
    """Collapse the append-only label log to one verdict per episode."""
    latest: dict[int, dict] = {}
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        episode = row["episode_index"]
        if episode not in latest or row["labeled_at"] > latest[episode]["labeled_at"]:
            latest[episode] = row
    return {episode: row["verdict"] for episode, row in latest.items()}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="suds__live_2")
    parser.add_argument("--seed", type=int, default=SEED)
    args = parser.parse_args()

    labels_path = REPO / "datasets" / f"{args.dataset}.labels.jsonl"
    verdicts = resolve_labels(labels_path)

    pool = sorted(ep for ep, verdict in verdicts.items() if verdict == "pass")
    discarded = sorted(ep for ep, verdict in verdicts.items() if verdict != "pass")

    # Shuffle once, then take prefixes, so the subsets nest.
    order = list(pool)
    random.Random(args.seed).shuffle(order)

    subsets = {}
    for budget in BUDGETS:
        if budget > len(pool):
            print(f"  skipping {budget}-demo subset: pool holds only {len(pool)}")
            continue
        subsets[str(budget)] = sorted(order[:budget])

    out = {
        "dataset": args.dataset,
        "seed": args.seed,
        "pool": pool,
        "discarded": discarded,
        "subsets": subsets,
    }
    out_path = REPO / "datasets" / f"{args.dataset}.subsets.json"
    out_path.write_text(json.dumps(out, indent=2) + "\n")

    print(f"reviewed {len(verdicts)} episodes -> {len(pool)} pass, {len(discarded)} discard")
    for budget, episodes in subsets.items():
        print(f"  {budget:>2}-demo: {episodes}")
    print(f"wrote {out_path.relative_to(REPO)}")


if __name__ == "__main__":
    main()
