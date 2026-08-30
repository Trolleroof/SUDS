# SUDS Episode Review

A local dashboard for judging LeRobot episodes: watch the clip, read the joint
traces, mark it pass/fail, move on. It reads a `LeRobotDataset` directly off
disk — nothing is imported, copied, or re-encoded.

```bash
npm install
npm run dev          # http://localhost:3117
```

## What it is for

`lerobot-record` stores *what happened*; it has no notion of whether the episode
was any good. That judgement is the one thing the dataset cannot supply, and it
is the thing you need before training — a policy trained on 50 demos where 12
were botched is a policy that has learned to botch things 24% of the time.

So this app is a read-only view over the dataset plus one small sidecar file it
writes: the verdicts.

Because `lerobot-record --policy.path=...` writes rollouts in the *same* format,
pointing the picker at the eval dataset gives you autonomous success rate with
no extra work. Demo pass rate and rollout pass rate side by side is the number
that says whether the pipeline works.

## Recording from the dashboard

`lerobot-record` takes its episode boundaries from terminal keyboard listeners,
which a web UI cannot reach. So recording runs through a small daemon that owns
the arm, the cameras, and the dataset writer, and exposes start/stop over HTTP:

```bash
# real hardware
python ../scripts/record_server.py --repo-id suds/pick_sponge \
    --robot-port /dev/tty.usbmodemXXXX --teleop-port /dev/tty.usbmodemYYYY \
    --camera overhead=0 --camera wrist=1 --task "pick up the sponge"

# no arms plugged in
python ../scripts/record_server.py --repo-id suds/dev --mock
```

The dashboard finds it at `http://127.0.0.1:8611` (`SUDS_RECORDER_URL` to
change that) and follows whatever dataset it is recording into. Without it the
rest of the dashboard works normally; the record bar just says it is offline.

### Keys

Start/stop is a keypress, not a click — while teleoperating you have a leader
arm in one hand and no attention to spare for finding a cursor.

| key | |
|---|---|
| `space` | start recording / stop recording |
| `⌫` backspace | throw the current take away — during the recording *or* inside the commit window |
| `⏎` enter | commit the take now instead of waiting the window out |

The bar mirrors the state (`● Record` → `■ Stop` → `⌫ Delete take`) and is
clickable too, but the keys are the interface.

Stopping does **not** write the episode. The frames stay in the buffer for
`--commit-seconds` (default 6), and deleting inside that window is
`clear_episode_buffer()` — instant, with no parquet rewrite and no video
re-encode, because nothing was written yet. Let the window expire and the take
is saved. Keeping the take is the default because that is the safe direction to
fail in, and a bad take is the one you know about immediately.

Once the window closes the episode is on disk and appears in the sidebar right
away — the daemon reopens the dataset after each save, since LeRobot only writes
the `meta/episodes` parquet footer on close. That costs one data and video file
per episode; `--flush-every N` trades that liveness back for packed files.

## Where things live

| | |
|---|---|
| Datasets | `~/.cache/huggingface/lerobot/<repo_id>/` — override with `SUDS_DATASET_ROOT` |
| Verdicts | `../datasets/<namespace>__<name>.labels.jsonl` — override with `SUDS_LABELS_ROOT` |

Labels are deliberately **outside** the dataset directory. Re-recording an
episode and `lerobot-edit-dataset` both rewrite the parquet files; labels kept
next to the code survive that, and diff cleanly in git.

The file is append-only JSONL, last line per episode wins:

```json
{"episode_index":2,"verdict":"fail","failure_mode":"missed_grasp","notes":"gripper closed early","labeled_at":"2026-08-30T16:54:39.685Z"}
```

Relabelling appends rather than rewrites, so there is no read-modify-write race
and the file doubles as a record of how your judgement changed.

## The screen

**Header** — dataset picker and the aggregate strip: episode count, how many are
labelled, pass rate over non-discarded episodes, total footage, fps, and total
dropped frames.

**Sidebar** — every episode, filterable by `all / unlabeled / pass / fail`.
The dot is the verdict; `⚠` means dropped frames were detected.

**Cameras** — one player per video feature. LeRobot v3 concatenates many
episodes into a single mp4, so each player seeks to the episode's
`from_timestamp` and loops at its `to_timestamp`.

**Verdict** — pass / fail / discard, a failure-mode enum (only enabled on fail),
and free-text notes. Enter saves the notes.

**Joint traces** — one chart per joint, commanded `action` (blue) drawn over
measured `observation.state` (green) on a shared scale. The gap between the two
lines is follower tracking error, which is the thing that quietly poisons a
dataset and the thing a single 6-line overlay hides completely.

### Keyboard

| key | |
|---|---|
| `j` / `k`, `↓` / `↑` | next / previous episode |
| `p` / `f` / `d` | pass / fail / discard |

Keys are ignored while an input has focus.

## Quality metrics

Computed per episode on load and memoized against `(episode count, total frames)`,
so a re-scan only happens when `lerobot-record` actually adds something:

- **mean / max step** — per-step L∞ change in `action`. A high max means a jump
  the follower could not have tracked; ACT will learn the jump anyway.
- **dropped frames** — timestamp gaps wider than 1.5× the nominal period.
- **state range** — per-joint min/max, for spotting joints your demos never
  exercised. A policy cannot learn to reach where you never went.

## Before it exists on hardware

```bash
python ../scripts/make_stub_dataset.py --repo-id suds/stub --episodes 8
```

This goes through `LeRobotDataset` itself rather than hand-writing parquet, so
the layout and metadata are exactly what `lerobot-record` produces.

## Video codec

LeRobot encodes AV1 by default; Safari only decodes it on M3 and newer. Record
H.264 instead and every browser plays it:

```bash
lerobot-record --dataset.rgb_encoder.vcodec=h264 ...
```

## Layout

```
src/lib/       paths, parquet reader, dataset/meta parsing, labels, quality metrics
src/app/api/   datasets, dataset, traces, label, video (byte-range mp4)
src/components/ Dashboard and its panels
```

Parquet is read with `hyparquet` (pure JS, no native deps). Row ranges are
pushed down to the reader, so pulling one episode out of a 100 MB data file only
touches that file's pages.
