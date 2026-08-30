#!/usr/bin/env python
"""Recording daemon: owns the arm, the cameras, and the dataset writer, and
exposes start/stop/discard over HTTP so the dashboard can drive it.

Why not shell out to `lerobot-record`: that script owns a terminal and takes its
episode boundaries from keyboard listeners, which a web UI cannot reach. Driving
the LeRobot API directly is both simpler and gives exact control over when an
episode is committed.

The interesting part is the commit window. Stopping does *not* immediately write
the episode -- the frames sit in the writer's buffer, and `--commit-seconds`
later the loop saves them. Discarding inside that window is
`clear_episode_buffer()`: instant, and nothing was ever written, so there is no
parquet rewrite and no video re-encode. Walk away and the take is kept, which is
the safe default.

Hardware is touched only from the main loop thread; HTTP handlers just set
fields under a lock.

    python scripts/record_server.py --repo-id suds/pick_sponge \
        --robot-port /dev/tty.usbmodemXXXX --teleop-port /dev/tty.usbmodemYYYY

    python scripts/record_server.py --repo-id suds/dev --mock   # no hardware
"""

from __future__ import annotations

import argparse
import json
import logging
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import numpy as np

from lerobot.configs.video import RGBEncoderConfig
from lerobot.datasets.lerobot_dataset import LeRobotDataset
from lerobot.utils.constants import ACTION, OBS_STR
from lerobot.utils.feature_utils import build_dataset_frame, hw_to_dataset_features

IDLE, RECORDING, PENDING, SAVING = "idle", "recording", "pending", "saving"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("recorder")


class Recorder:
    """State machine driven by HTTP, stepped by the control loop."""

    def __init__(
        self,
        robot,
        teleop,
        dataset: LeRobotDataset,
        fps: int,
        task: str,
        commit_seconds: float,
        flush_every: int = 1,
    ):
        self.robot = robot
        self.teleop = teleop
        self.dataset = dataset
        self.fps = fps
        self.task = task
        self.commit_seconds = commit_seconds
        self.flush_every = max(1, flush_every)
        self._since_flush = 0

        self.obs_features = hw_to_dataset_features(robot.observation_features, OBS_STR, use_video=True)
        self.action_features = hw_to_dataset_features(robot.action_features, ACTION, use_video=True)

        self.lock = threading.Lock()
        self.state = IDLE
        self.frames = 0
        self.started_at = 0.0
        self.commit_at = 0.0
        self.last_message = "ready"
        self._command: str | None = None
        self._command_done: threading.Event | None = None

    # -- called from the HTTP thread ------------------------------------

    def command(self, name: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        """Queue a command and block until the loop has applied it.

        Blocking matters: the UI fires stop-then-discard within milliseconds, and
        at 30 Hz that is well inside one tick. If the calls returned early, the
        second would be validated against the pre-stop state and rejected.
        """
        done = threading.Event()
        with self.lock:
            if self._command is not None:
                return {"ok": False, "error": "a command is already in flight"}
            if name == "task":
                self.task = (payload or {}).get("task") or self.task
            elif name == "record" and self.state in (IDLE, PENDING):
                # Starting a new take commits whatever is pending, so nothing is
                # lost by reaching for the button again straight away.
                self._command = "record"
            elif name == "stop" and self.state == RECORDING:
                self._command = "stop"
            elif name == "discard" and self.state in (RECORDING, PENDING):
                self._command = "discard"
            elif name == "save" and self.state == PENDING:
                self._command = "save"
            else:
                return {"ok": False, "error": f"cannot {name} while {self.state}"}
            queued = self._command is not None
            if queued:
                self._command_done = done

        # `save` and a `record` that commits a pending take both run a video
        # encode inside the loop, so the wait has to tolerate seconds, not ticks.
        if queued and not done.wait(timeout=30.0):
            return {"ok": False, "error": f"{name} timed out"}
        return {"ok": True}

    def status(self) -> dict[str, Any]:
        with self.lock:
            now = time.time()
            return {
                "state": self.state,
                "repo_id": self.dataset.repo_id,
                "fps": self.fps,
                "task": self.task,
                "frames": self.frames,
                "elapsed_s": (now - self.started_at) if self.state == RECORDING else 0.0,
                "commit_in_s": max(0.0, self.commit_at - now) if self.state == PENDING else 0.0,
                "commit_seconds": self.commit_seconds,
                "saved_episodes": self.dataset.meta.total_episodes,
                "message": self.last_message,
            }

    # -- called from the control loop thread ----------------------------

    def step(self) -> None:
        observation = self.robot.get_observation()
        action = self.teleop.get_action()
        sent = self.robot.send_action(action)

        with self.lock:
            command, self._command = self._command, None
            done, self._command_done = self._command_done, None
            state = self.state

        if command == "record":
            if state == PENDING:
                self._save()
            self._begin()
        elif command == "stop":
            self._pend()
        elif command == "discard":
            self._discard()
        elif command == "save":
            self._save()
        if done is not None:
            done.set()

        with self.lock:
            state = self.state
            expired = state == PENDING and time.time() >= self.commit_at
        if expired:
            self._save()

        if state == RECORDING:
            frame = {
                **build_dataset_frame(self.obs_features, observation, prefix=OBS_STR),
                **build_dataset_frame(self.action_features, sent, prefix=ACTION),
                "task": self.task,
            }
            self.dataset.add_frame(frame)
            with self.lock:
                self.frames += 1

    def _begin(self) -> None:
        with self.lock:
            self.state = RECORDING
            self.frames = 0
            self.started_at = time.time()
            self.last_message = "recording"
        log.info("recording started")

    def _pend(self) -> None:
        with self.lock:
            self.state = PENDING
            self.commit_at = time.time() + self.commit_seconds
            self.last_message = f"{self.frames} frames — saving in {self.commit_seconds:.0f}s"
        log.info("stopped with %d frames; commit window open", self.frames)

    def _discard(self) -> None:
        frames = self.frames
        self.dataset.clear_episode_buffer()
        with self.lock:
            self.state = IDLE
            self.frames = 0
            self.last_message = f"discarded {frames} frames"
        log.info("discarded %d frames", frames)

    def _save(self) -> None:
        with self.lock:
            if self.state not in (RECORDING, PENDING):
                return
            self.state = SAVING
            frames = self.frames
            self.last_message = "encoding…"
        # Blocks the loop for the length of the video encode. That is deliberate:
        # the arm is not being teleoperated between takes anyway, and letting it
        # race a second recording would corrupt the writer's buffer.
        self.dataset.save_episode()
        # `meta/episodes` is written through an open ParquetWriter whose footer
        # only lands on close, so an episode is not *readable* until the dataset
        # is finalized. Reopening after every take is what makes "stop" mean
        # "reviewable in the dashboard" rather than "reviewable when I quit".
        self._since_flush += 1
        if self._since_flush >= self.flush_every:
            self.dataset = reopen(self.dataset)
            self._since_flush = 0
        with self.lock:
            self.state = IDLE
            self.frames = 0
            self.last_message = f"saved episode {self.dataset.meta.total_episodes - 1} ({frames} frames)"
        log.info("saved episode %d", self.dataset.meta.total_episodes - 1)


def reopen(dataset: LeRobotDataset) -> LeRobotDataset:
    """Close the writer (flushing metadata) and reopen for appending.

    ``root`` has to be passed explicitly -- resume() refuses to create a writer
    over the Hub snapshot cache, and we always want the local directory anyway.
    """
    repo_id, root = dataset.repo_id, dataset.root
    dataset.finalize()
    return LeRobotDataset.resume(repo_id=repo_id, root=root, rgb_encoder=RGBEncoderConfig(vcodec="h264"))


def make_handler(recorder: Recorder):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):  # noqa: D102 - the loop already logs what matters
            pass

        def _reply(self, body: dict, status: int = 200) -> None:
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self) -> None:  # noqa: N802
            if self.path.rstrip("/") in ("", "/status"):
                self._reply(recorder.status())
            else:
                self._reply({"error": "not found"}, 404)

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                payload = {}
            name = self.path.strip("/").split("/")[-1]
            if name not in {"record", "stop", "discard", "save", "task"}:
                self._reply({"error": "not found"}, 404)
                return
            result = recorder.command(name, payload)
            self._reply({**result, **recorder.status()}, 200 if result.get("ok") else 409)

    return Handler


def build_hardware(args):
    if args.mock:
        return MockArm(args.fps), MockArm(args.fps)

    from lerobot.cameras.opencv import OpenCVCameraConfig
    from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig
    from lerobot.teleoperators.so_leader import SO101Leader, SO101LeaderConfig

    cameras = {}
    for spec in args.camera:
        name, index = spec.split("=", 1)
        cameras[name] = OpenCVCameraConfig(
            index_or_path=int(index), width=args.width, height=args.height, fps=args.fps
        )

    robot = SO101Follower(
        SO101FollowerConfig(port=args.robot_port, id=args.robot_id, cameras=cameras)
    )
    teleop = SO101Leader(SO101LeaderConfig(port=args.teleop_port, id=args.teleop_id))
    return robot, teleop


class MockArm:
    """Stand-in that produces a plausible trajectory, so the whole record →
    dashboard loop can be exercised with no arms plugged in."""

    JOINTS = [
        "shoulder_pan.pos",
        "shoulder_lift.pos",
        "elbow_flex.pos",
        "wrist_flex.pos",
        "wrist_roll.pos",
        "gripper.pos",
    ]
    H, W = 240, 320

    def __init__(self, fps: int):
        self.fps = fps
        self.t = 0.0

    @property
    def observation_features(self):
        return {**dict.fromkeys(self.JOINTS, float), "overhead": (self.H, self.W, 3)}

    @property
    def action_features(self):
        return dict.fromkeys(self.JOINTS, float)

    def connect(self, calibrate: bool = True):
        pass

    def disconnect(self):
        pass

    def get_observation(self):
        self.t += 1 / self.fps
        return {**self._joints(), "overhead": self._image()}

    def get_action(self):
        return self._joints()

    def send_action(self, action):
        return action

    def _joints(self):
        u = self.t
        return {
            "shoulder_pan.pos": 30 * np.sin(u),
            "shoulder_lift.pos": -20 + 25 * np.sin(0.7 * u),
            "elbow_flex.pos": 40 * np.sin(0.5 * u),
            "wrist_flex.pos": 15 * np.cos(u),
            "wrist_roll.pos": 10 * np.sin(2 * u),
            "gripper.pos": 100.0 * (np.sin(0.4 * u) > 0),
        }

    def _image(self):
        img = np.zeros((self.H, self.W, 3), dtype=np.uint8)
        img[:, :, 2] = np.linspace(20, 90, self.W, dtype=np.uint8)[None, :]
        x = int((0.5 + 0.45 * np.sin(self.t)) * (self.W - 40))
        y = int((0.5 + 0.35 * np.cos(0.8 * self.t)) * (self.H - 40))
        img[y : y + 40, x : x + 40] = (240, 120, 40)
        return img


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo-id", required=True)
    parser.add_argument("--task", default="pick up the sponge")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument(
        "--commit-seconds",
        type=float,
        default=6.0,
        help="How long after stopping you can still discard the take for free.",
    )
    parser.add_argument(
        "--flush-every",
        type=int,
        default=1,
        help="Reopen the dataset every N saved episodes. 1 (the default) makes every take "
        "immediately reviewable, at the cost of one data/video file per episode. Raise it "
        "to let LeRobot pack episodes into larger files, at the cost of liveness.",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8611)
    parser.add_argument("--robot-port")
    parser.add_argument("--robot-id", default="follower")
    parser.add_argument("--teleop-port")
    parser.add_argument("--teleop-id", default="leader")
    parser.add_argument(
        "--camera",
        action="append",
        default=[],
        metavar="NAME=INDEX",
        help="Repeatable, e.g. --camera overhead=0 --camera wrist=1",
    )
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--mock", action="store_true", help="Synthesize data; no hardware needed.")
    args = parser.parse_args()

    if not args.mock and not (args.robot_port and args.teleop_port):
        parser.error("--robot-port and --teleop-port are required unless --mock is set")

    robot, teleop = build_hardware(args)
    robot.connect()
    teleop.connect()

    features = {
        **hw_to_dataset_features(robot.observation_features, OBS_STR, use_video=True),
        **hw_to_dataset_features(robot.action_features, ACTION, use_video=True),
    }

    from lerobot.utils.constants import HF_LEROBOT_HOME

    if (HF_LEROBOT_HOME / args.repo_id).exists():
        dataset = LeRobotDataset.resume(repo_id=args.repo_id)
        log.info("resuming %s at %d episodes", args.repo_id, dataset.meta.total_episodes)
    else:
        dataset = LeRobotDataset.create(
            repo_id=args.repo_id,
            fps=args.fps,
            features=features,
            robot_type=getattr(robot, "name", "so101_follower"),
            use_videos=True,
            # AV1 (the default) only decodes in Safari on M3 and newer; the
            # dashboard has to play these back.
            rgb_encoder=RGBEncoderConfig(vcodec="h264"),
        )
        log.info("created %s", args.repo_id)

    recorder = Recorder(
        robot, teleop, dataset, args.fps, args.task, args.commit_seconds, args.flush_every
    )

    server = ThreadingHTTPServer((args.host, args.port), make_handler(recorder))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log.info("control API on http://%s:%d — ready", args.host, args.port)

    period = 1 / args.fps
    try:
        while True:
            start = time.perf_counter()
            recorder.step()
            time.sleep(max(0.0, period - (time.perf_counter() - start)))
    except KeyboardInterrupt:
        log.info("shutting down")
        # An in-flight take is worth more than a clean exit; commit it.
        if recorder.state in (RECORDING, PENDING):
            recorder._save()
        recorder.dataset.finalize()
    finally:
        server.shutdown()
        robot.disconnect()
        teleop.disconnect()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
