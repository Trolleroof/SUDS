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
pointing the picker at the held-out physical eval dataset gives you autonomous
success rate with no extra work. For SUDS, compare that rate across frozen real
demo budgets (5/10/20/40) for real-only and sim+real GROOT fine-tuning. Keep
simulated data out of this picker: the claim is reduced *physical* data need,
not simulated success.

## Power & connection

The **Power & connection** panel at the top checks whether each arm and camera is
plugged in (USB visible) and actually powered (servos ping back / camera delivers
a frame). It does not measure teleop quality — just "is there power?"

```bash
python scripts/health_server.py \
    --teleop-port /dev/tty.usbmodemXXXX --robot-port /dev/tty.usbmodemYYYY \
    --camera overhead=0 --camera wrist=1
```

The daemon rescans every couple of seconds on `http://127.0.0.1:8612`
(`SUDS_HEALTH_URL`). While `record_server.py` is running, the panel reads live
power state from the recorder instead.

## Two screens

**Live** is what you look at with a leader arm in your hand: the daemon, the
kill switch, the teleop sync, the cameras pointing at the cell right now, and
the record button. **Review** is the episode screen — sidebar, recorded video,
verdicts, traces — for afterwards, with both hands free.

They are separate because sharing one scroll put a live camera directly above a
*recording* of a camera. When the arm is moving you must never have to wonder
whether the picture is from now.

## Teleop sync

The follower is not driven until you say so. Starting the daemon leaves teleop
**observing**: both arms are read, the delta is live, nothing moves. Press
**Engage teleop** to hand the follower over to the leader.

**teleop on start** in Setup skips the manual step: the daemon engages as soon
as it has read both arms, so Record works immediately. It is still gated on the
delta — if the arms are too far apart it stays observing and says why, rather
than snapping the follower on startup.

This exists because engaging is the moment the follower snaps to the leader's
pose at full speed — the same hazard the re-arm button guards. Observing shows
you, per joint, how far and *which way* the leader has to move to meet the
follower, so you can bring them together by hand first. Engage is refused while
they disagree by more than the delta limit, and recording is refused while
observing, because an episode where the follower was not tracking is garbage
data.

## Status over websocket

The dashboard holds one websocket to the daemon (`ws://…:8611/ws`) and the
daemon pushes status at 10 Hz. Every panel reads that one stream.

It used to be a 4 Hz poll per panel. The request count was not really the
problem — localhost JSON is cheap. The problem was that a poll against a daemon
that is *not running* is a failed request every 250 ms for as long as the tab is
open, which buries everything else in the server log. A socket that will not
open is one failed connect and a backoff, capped at 15 s.

The daemon implements the protocol itself, in about eighty lines of stdlib —
there is no websocket library in the venv, and it only needs the narrow half:
accept one upgrade, push text frames, notice when the client leaves. The browser
connects to it directly, since Next's app router cannot proxy an upgrade.

## Starting the recorder

The top panel starts and stops `scripts/record_server.py` itself, so nothing in
the normal loop needs a terminal. **Setup** opens the same options the script
takes on its command line:

- **Scan hardware** — lists the USB serial ports and the camera indices OpenCV
  can see, as buttons. On macOS `/dev/tty.usbmodem*` names change between
  reboots and a wrong camera index is the classic way to lose an afternoon, so
  neither is typed in. Scanning is only offered while the recorder is stopped:
  enumerating cameras means opening them, and the recorder already has them.
- **dataset / task / fps / commit seconds / delta limit / auto-stop**.
- **camera previews** — each index shows a real frame on demand, because
  "OpenCV Camera @ 2" says nothing about which physical camera it is.

Setup is a dialog rather than a panel in the page: it is a thing you do once
before a session, and it should not compete for the screen with the cameras.

Camera *names* are not free choice once a dataset exists. A `LeRobotDataset` has
a fixed schema, so a dataset recorded with `overhead` cannot accept frames
labelled `wrist` — the panel prefills the names from the selected dataset,
warns on a mismatch, and the daemon refuses to start rather than failing one
Record press later. **Log** shows the daemon's own output, which is where that
refusal (and any hardware error) is legible.

**Stop** sends SIGINT rather than SIGTERM: the daemon's interrupt handler commits
an in-flight take and finalizes the dataset, and a take is worth more than a fast
shutdown. It escalates to SIGKILL after 20 seconds.

A daemon you started in a terminal is detected but not managed — the panel says
so and disables Start, because a second daemon would only crash on the port the
first one holds.

Config values arrive over HTTP and are validated before they reach a process:
repo ids and camera names are pattern-matched, ports must be `/dev/tty.*` devices
that actually exist, and arguments are passed as an argv array, never through a
shell.

## Kill switch and tracking delta

The top bar is the emergency stop. **Kill arms** cuts servo torque on the
follower *and* the leader, and it is the one control that is never disabled —
it works while a take is recording, while an episode is encoding, while a
calibration is half-finished, and again while it is already engaged.

It does not go through the recorder's command queue. Queued commands are applied
by the control loop, and the loop can be several seconds deep in a video encode;
the stop writes to the buses from the request thread instead, taking the hardware
lock if it can get it inside 500 ms and writing anyway if it cannot. A take that
was in flight is dropped — its frames were never written to disk, and a take that
ended in a kill is a bad take by definition.

Next to it is the reason you would hit it. **delta** is, per joint,
|leader commanded − follower measured| in the same normalised units both sides
use. A follower trailing its leader by a unit or two through a fast move is
normal. One sitting 30 units behind is not tracking: it is jammed, pushing on
something, or has lost power — and the servos are heating up while it tries.
`--delta-limit` (default 25) is where the bar turns amber; `--auto-estop` makes
the daemon cut torque by itself once the delta stays over the limit for
`--delta-grace` ticks (default 5). It is off by default because a fast enough
demonstration can trip it honestly.

**Re-arm follower** puts torque back. It refuses while the two arms are more
than `--delta-limit` apart, because re-energising a follower that is far from
its leader makes it snap to the leader's pose at full speed — match them by hand
first, or press **Re-arm anyway** once you have read the number.

The camera streams keep running the whole time the arms are dead, which is
exactly when you want to see what happened.

## Live cameras

The recorder is already reading every camera at the control rate, and OpenCV
will not hand the same device to a second process — so the live view is
re-encoded frames from the daemon rather than a second capture. They arrive as
MJPEG on `/api/stream/<name>`, which an `<img>` renders with no player, no codec
negotiation and no JavaScript.

Buttons pick one camera to fill the panel or show them all, freeze the view on
the last frame, and reconnect a stream after a daemon restart. Rate and quality
are `--stream-fps` (default 10) and `--stream-quality` (default 70); the control
loop reads at `--fps` regardless.

## Recalibration

LeRobot's `calibrate()` is a straight line through two `input()` calls, which is
why recalibrating normally means stopping everything and going back to a
terminal. The **calibration** panel is the same routine with those two pauses
turned into buttons:

1. **Recalibrate leader** / **Recalibrate follower** — torque comes off and the
   arm goes limp.
2. Move it to the middle of every joint's travel, then **Set home position**.
   That is `set_half_turn_homings()`: each joint's range is centred on where it
   is standing.
3. Sweep every joint through its full travel. The daemon samples raw encoder
   counts on every control tick, and each joint ticks green as it moves, so you
   can see what you have and have not covered. `wrist_roll` turns freely and is
   written as the full 0–4095 turn rather than swept.
4. **Save calibration** — greyed out until every joint has actually moved,
   because LeRobot raises on a zero-width range at the end of the sweep. It
   writes to the servos and to
   `~/.cache/huggingface/lerobot/calibration/…/<id>.json`.

**Cancel** puts the previous calibration back. Recording is unavailable while a
calibration is open, and starting one is unavailable unless the recorder is idle.

## Recording from the dashboard

`lerobot-record` takes its episode boundaries from terminal keyboard listeners,
which a web UI cannot reach. So recording runs through a small daemon that owns
the arm, the cameras, and the dataset writer, and exposes start/stop over HTTP:

```bash
# real hardware
python ../scripts/record_server.py --repo-id suds/pick_sponge \
    --robot-port /dev/tty.usbmodemXXXX --teleop-port /dev/tty.usbmodemYYYY \
    --camera third_person=0 --camera wrist=1 --task "pick up the sponge"
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

Every one of these is also a button, and so is everything else the daemon can
do: the keys are a shortcut for when both your hands are on the leader arm, not
the only way in.

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
src/app/api/   datasets, dataset, traces, label, video (byte-range mp4),
               recorder (command proxy), health, stream (MJPEG passthrough)
src/components/ Dashboard and its panels
```

Parquet is read with `hyparquet` (pure JS, no native deps). Row ranges are
pushed down to the reader, so pulling one episode out of a 100 MB data file only
touches that file's pages.
