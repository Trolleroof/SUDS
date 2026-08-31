#!/usr/bin/env python
"""Recording daemon: owns the arms, the cameras, and the dataset writer, and
exposes recording, an emergency stop, recalibration and live camera streams over
HTTP so the dashboard can drive all of it from buttons.

Why not shell out to `lerobot-record`: that script owns a terminal and takes its
episode boundaries -- and its calibration prompts -- from keyboard listeners,
which a web UI cannot reach. Driving the LeRobot API directly is both simpler and
gives exact control over when an episode is committed.

The interesting part is the commit window. Stopping does *not* immediately write
the episode -- the frames sit in the writer's buffer, and `--commit-seconds`
later the loop saves them. Discarding inside that window is
`clear_episode_buffer()`: instant, and nothing was ever written, so there is no
parquet rewrite and no video re-encode. Walk away and the take is kept, which is
the safe default.

Four things run alongside the recording loop:

*   **E-stop.** `POST /estop` cuts servo torque on both arms from the HTTP
    thread, without waiting for the control loop -- see `_kill_torque`.
*   **Teleop engagement.** The loop starts *observing*: both arms are read and
    the delta is published, but nothing is driven, so bringing the daemon up
    never moves the follower. `POST /engage` hands the follower to the leader
    once the two agree; `POST /disengage` lets go again.
*   **Tracking delta.** Every tick compares the leader's commanded angle against
    the follower's measured angle, per joint. A large delta means the follower is
    fighting something (or is about to). With `--auto-estop` it kills the arms by
    itself.
*   **Calibration.** The LeRobot routine blocks on `input()`; this one is a state
    machine stepped by the loop, so the phases are buttons in the browser.

Hardware is touched under `hw_lock`: the loop holds it for a tick, HTTP handlers
take it for the length of one command. The e-stop is the one caller allowed to
give up on the lock and write anyway.

    python scripts/record_server.py --repo-id suds/pick_sponge \
        --robot-port /dev/tty.usbmodemXXXX --teleop-port /dev/tty.usbmodemYYYY \
        --camera third_person=0 --camera wrist=1
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import logging
import socket
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from power_check import aggregate_status, build_arm_power, build_camera_power, motor_probe, motor_temperatures  # noqa: E402

from lerobot.configs.video import RGBEncoderConfig
from lerobot.datasets.lerobot_dataset import LeRobotDataset
from lerobot.motors import MotorCalibration
from lerobot.utils.constants import ACTION, OBS_STR
from lerobot.utils.feature_utils import build_dataset_frame, hw_to_dataset_features

IDLE, RECORDING, PENDING, SAVING = "idle", "recording", "pending", "saving"
CALIBRATING, ESTOPPED = "calibrating", "estopped"

# The motor whose range is a full turn and so cannot be swept by hand.
FULL_TURN_MOTOR = "wrist_roll"
FULL_TURN_RANGE = (0, 4095)

BOUNDARY = "suds-frame"

# 10 Hz: a legible commit countdown and a live delta, on an already-open socket.
WS_PERIOD = 0.1
DEFAULT_REST_SECONDS = 2.0
DEFAULT_RISE_SECONDS = 1.5
DEFAULT_SYNC_SECONDS = 1.0
# SO-101 follower rest pose, in the project's normalized joint units. A loose,
# settled pose -- shoulder and elbow drooped rather than curled tight, gripper
# cracked open -- so the arm looks at rest instead of clenched when torque
# drops. Tune these by feel on the physical arm; nothing here reads a range.
REST_POSE = {
    "shoulder_pan": 0.0,
    "shoulder_lift": -20.0,
    "elbow_flex": 65.0,
    "wrist_flex": 50.0,
    "wrist_roll": -35.0,
    "gripper": 15.0,
}
# Cleared, centered pose the follower rises to before it starts tracking the
# leader, so every engage starts from the same known height instead of
# wherever the follower was left (often curled at REST_POSE). Tune by feel.
RISE_POSE = {
    "shoulder_pan": 0.0,
    "shoulder_lift": 10.0,
    "elbow_flex": 30.0,
    "wrist_flex": 0.0,
    "wrist_roll": 0.0,
    "gripper": 50.0,
}


def _ease_out_cubic(t: float) -> float:
    """0..1 in, 0..1 out: fast start, soft arrival instead of a dead stop."""
    return 1.0 - (1.0 - t) ** 3

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("recorder")


class Calibration:
    """Non-interactive rewrite of `SOFollower.calibrate` / `SOLeader.calibrate`.

    LeRobot's version is a straight line through two `input()` calls; the phases
    here are the same two pauses, but they end when a button is pressed in the
    browser instead. Between them the control loop keeps sampling raw encoder
    counts, which is exactly what `record_ranges_of_motion` does while it waits
    on the terminal.
    """

    HOME, RANGE = "home", "range"

    def __init__(self, arm, role: str):
        self.arm = arm
        self.role = role
        self.phase = self.HOME
        self.homing_offsets: dict[str, int] = {}
        self.mins: dict[str, int] = {}
        self.maxes: dict[str, int] = {}
        self.positions: dict[str, int] = {}
        # Restored if the operator backs out, so a cancelled calibration leaves
        # the arm exactly as usable as it was before.
        self.previous = dict(getattr(arm, "calibration", {}) or {})

    @property
    def bus(self):
        return self.arm.bus

    @property
    def sweep_motors(self) -> list[str]:
        return [motor for motor in self.bus.motors if motor != FULL_TURN_MOTOR]

    def begin(self) -> None:
        """Free the joints so they can be moved by hand."""
        from lerobot.motors.feetech import OperatingMode

        self.bus.disable_torque()
        for motor in self.bus.motors:
            self.bus.write("Operating_Mode", motor, OperatingMode.POSITION.value)

    def set_home(self) -> None:
        """Centre every joint's range on where it is standing right now."""
        self.homing_offsets = self.bus.set_half_turn_homings()
        self.positions = self.bus.sync_read("Present_Position", normalize=False, num_retry=3)
        self.mins = dict(self.positions)
        self.maxes = dict(self.positions)
        self.phase = self.RANGE

    def sample(self) -> None:
        """One tick of the range sweep."""
        if self.phase != self.RANGE:
            return
        positions = self.bus.sync_read("Present_Position", self.sweep_motors, normalize=False, num_retry=3)
        self.positions = positions
        for motor, value in positions.items():
            self.mins[motor] = min(self.mins.get(motor, value), value)
            self.maxes[motor] = max(self.maxes.get(motor, value), value)

    def unswept(self) -> list[str]:
        """Joints that have not actually been moved yet.

        LeRobot raises on a zero-width range at the end of the sweep. Reporting
        it up front instead lets the dashboard grey out the finish button and
        name the joints still to move.
        """
        return [m for m in self.sweep_motors if self.maxes.get(m, 0) - self.mins.get(m, 0) < 2]

    def finish(self) -> dict[str, MotorCalibration]:
        mins = dict(self.mins)
        maxes = dict(self.maxes)
        mins[FULL_TURN_MOTOR], maxes[FULL_TURN_MOTOR] = FULL_TURN_RANGE

        calibration = {
            motor: MotorCalibration(
                id=m.id,
                drive_mode=0,
                homing_offset=self.homing_offsets[motor],
                range_min=mins[motor],
                range_max=maxes[motor],
            )
            for motor, m in self.bus.motors.items()
        }
        self.arm.calibration = calibration
        self.bus.write_calibration(calibration)
        self.arm._save_calibration()
        self.arm.configure()
        return calibration

    def cancel(self) -> None:
        if self.previous:
            self.arm.calibration = dict(self.previous)
            self.bus.write_calibration(self.previous)
        self.arm.configure()

    def status(self) -> dict[str, Any]:
        joints = {
            motor: {
                "pos": int(self.positions.get(motor, 0)),
                "min": int(self.mins.get(motor, 0)),
                "max": int(self.maxes.get(motor, 0)),
                "swept": self.maxes.get(motor, 0) - self.mins.get(motor, 0) >= 2,
            }
            for motor in self.sweep_motors
        }
        return {
            "arm": self.role,
            "phase": self.phase,
            "joints": joints,
            "unswept": self.unswept(),
            "can_finish": self.phase == self.RANGE and not self.unswept(),
        }


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
        *,
        camera_meta: dict[str, int] | None = None,
        delta_limit: float = 25.0,
        auto_estop: bool = False,
        engage_on_start: bool = False,
        rest_seconds: float = DEFAULT_REST_SECONDS,
        rise_seconds: float = DEFAULT_RISE_SECONDS,
        sync_seconds: float = DEFAULT_SYNC_SECONDS,
        delta_grace: int = 5,
        stream_fps: float = 10.0,
        stream_quality: int = 70,
    ):
        self.robot = robot
        self.teleop = teleop
        self.dataset = dataset
        self.fps = fps
        self.task = task
        self.commit_seconds = commit_seconds
        self.flush_every = max(1, flush_every)
        self.camera_meta = camera_meta or {}
        self._since_flush = 0

        self.obs_features = hw_to_dataset_features(robot.observation_features, OBS_STR, use_video=True)
        self.action_features = hw_to_dataset_features(robot.action_features, ACTION, use_video=True)

        self.lock = threading.Lock()
        # Serial buses are not reentrant and not thread-safe. Everything that
        # talks to a bus takes this; the loop holds it for one tick at a time.
        self.hw_lock = threading.RLock()
        self.state = IDLE
        self.frames = 0
        self.started_at = 0.0
        self.commit_at = 0.0
        self.last_message = "ready"
        self._command: str | None = None
        self._payload: dict[str, Any] = {}
        self._command_done: threading.Event | None = None
        self._command_result: dict[str, Any] = {}

        self.estop = False
        self.estop_reason = ""
        self.estop_at = 0.0
        self._estop_reasserted_at = 0.0

        # Observing until someone asks for otherwise: on the first tick the
        # leader is wherever it was left, and sending that straight to a cold
        # follower is a full-speed snap across the arm's range.
        self.engaged = False
        # Engaging needs a measured delta, and there is none until the loop has
        # read both arms once -- so this is a request, honoured on the first tick
        # that has numbers to check it against.
        self._engage_pending = engage_on_start

        self.delta_limit = delta_limit
        self.auto_estop = auto_estop
        self.rest_seconds = max(0.0, rest_seconds)
        self.rise_seconds = max(0.0, rise_seconds)
        self.sync_seconds = max(0.0, sync_seconds)
        self.delta_grace = max(1, delta_grace)
        self._over_ticks = 0
        self._delta: dict[str, Any] = {"joints": {}, "max": 0.0, "max_joint": None, "over": False}

        self.calib: Calibration | None = None

        self._stream_period = 1.0 / max(1.0, stream_fps)
        self._stream_quality = stream_quality
        self._stream_at = 0.0
        self._jpegs: dict[str, bytes] = {}
        self._stream_cv = threading.Condition()
        self._stream_seq = 0

        self._motors_probed_at = 0.0
        self._teleop_motors: dict[str, bool] = {}
        self._follower_motors: dict[str, bool] = {}
        self._teleop_temps: dict[str, int] = {}
        self._follower_temps: dict[str, int] = {}
        self._hardware: dict[str, Any] = {}

    # -- called from the HTTP thread ------------------------------------

    def command(self, name: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        """Queue a command and block until the loop has applied it.

        Blocking matters: the UI fires stop-then-discard within milliseconds, and
        at 30 Hz that is well inside one tick. If the calls returned early, the
        second would be validated against the pre-stop state and rejected.
        """
        payload = payload or {}

        # The kill switch does not queue. Everything else does.
        if name == "estop":
            return self.emergency_stop(payload.get("reason") or "operator")
        if name == "rearm":
            return self.rearm(force=bool(payload.get("force")))
        # Engagement is a torque write like re-arming is, and it has the same
        # reason not to queue: the operator is standing over the arms with a
        # hand on them, and a button that waits on a tick reads as a dead button.
        if name in ("engage", "disengage"):
            return self._set_engaged(name == "engage", force=bool(payload.get("force")))

        done = threading.Event()
        with self.lock:
            if self._command is not None:
                return {"ok": False, "error": "a command is already in flight"}
            if self.estop and name != "task":
                return {"ok": False, "error": "arms are e-stopped — re-arm first"}
            if name == "task":
                self.task = payload.get("task") or self.task
            elif name == "record" and not self.engaged:
                # A take whose follower was never driven is a video of one arm
                # moving and an action stream nothing obeyed: unusable training
                # data that looks fine until it is trained on.
                return {"ok": False, "error": "teleop is observing — engage it before recording"}
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
            elif name == "calibrate_start" and self.state == IDLE:
                self._command = "calibrate_start"
            elif name in ("calibrate_home", "calibrate_finish", "calibrate_cancel") and self.state == CALIBRATING:
                self._command = name
            else:
                return {"ok": False, "error": f"cannot {name} while {self.state}"}
            queued = self._command is not None
            if queued:
                self._payload = payload
                self._command_done = done
                self._command_result = {}

        if not queued:
            return {"ok": True}

        # `save`, a `record` that commits a pending take, and finishing a
        # calibration all run seconds of work inside the loop, so the wait has to
        # tolerate seconds, not ticks.
        if not done.wait(timeout=30.0):
            return {"ok": False, "error": f"{name} timed out"}
        with self.lock:
            return self._command_result or {"ok": True}

    def emergency_stop(self, reason: str = "operator") -> dict[str, Any]:
        """Cut torque on both arms now, from whatever thread asked.

        Deliberately not routed through the command queue: a queued kill is only
        as fast as the loop, and the loop can be several seconds deep in a video
        encode. An in-flight take is dropped -- a take that ended in a kill is a
        bad take by definition, and its frames were never written.
        """
        with self.lock:
            already = self.estop
            prior = self.state
            self.estop = True
            self.estop_reason = reason
            self.estop_at = time.time()
            self.state = ESTOPPED
            # Torque is about to go; the gate follows it, so re-arming lands
            # back in observing rather than resuming a drive nobody asked for.
            self.engaged = False

        self._rest_and_release()
        killed = self._kill_torque()
        self._estop_reasserted_at = time.time()

        if prior in (RECORDING, PENDING):
            try:
                self.dataset.clear_episode_buffer()
            except Exception as err:  # noqa: BLE001
                log.warning("could not clear the episode buffer: %s", err)
        if prior == CALIBRATING and self.calib is not None:
            self.calib = None

        with self.lock:
            self.frames = 0
            self.last_message = f"E-STOP · {reason} · torque off: {', '.join(killed) or 'nothing answered'}"
        if not already:
            log.warning("E-STOP (%s); torque cut on %s", reason, killed or "nothing")
        return {"ok": True, "killed": killed, "already": already}

    def rearm(self, force: bool = False) -> dict[str, Any]:
        """Put torque back on the follower after an e-stop.

        Refused while the arms disagree: re-energising a follower that is far
        from the leader makes it snap to the leader's pose at full speed, which
        is how you break a gripper (or a finger). Move them together first, or
        pass force.
        """
        with self.lock:
            if not self.estop:
                return {"ok": False, "error": "not stopped"}
            worst = self._delta.get("max", 0.0)
            worst_joint = self._delta.get("max_joint")
        if not force and worst > self.delta_limit:
            return {
                "ok": False,
                "error": (
                    f"leader and follower are {worst:.1f} apart on {worst_joint} "
                    f"(limit {self.delta_limit:.0f}) — match them by hand, or re-arm anyway"
                ),
                "needs_force": True,
            }

        try:
            with self.hw_lock:
                self.robot.configure()
        except Exception as err:  # noqa: BLE001
            return {"ok": False, "error": f"could not re-arm: {err}"}

        with self.lock:
            self.estop = False
            self.estop_reason = ""
            self.state = IDLE
            self.last_message = "re-armed"
        self._over_ticks = 0
        log.info("re-armed")
        return {"ok": True}

    def _set_engaged(self, engaged: bool, force: bool = False) -> dict[str, Any]:
        """Hand the follower to the leader, or take it back.

        Engaging is the same hazard as re-arming -- a follower that is energised
        while it disagrees with the leader travels to the leader's pose at full
        speed -- so it is refused on the same delta and cleared the same way.
        Disengaging goes the other direction and needs no guard: the arms keep
        being read, so the delta readout stays live while the operator walks the
        leader back to the follower by hand.
        """
        verb = "engage" if engaged else "disengage"
        with self.lock:
            if self.estop:
                return {"ok": False, "error": f"cannot {verb} while e-stopped — re-arm first"}
            if self.state == CALIBRATING:
                return {"ok": False, "error": f"cannot {verb} while calibrating"}
            if engaged != self.engaged and not engaged and self.state == RECORDING:
                return {"ok": False, "error": "stop the take before disengaging"}
            if engaged == self.engaged:
                return {"ok": True, "already": True}
            worst = self._delta.get("max", 0.0)
            worst_joint = self._delta.get("max_joint")

        if engaged and not force and worst > self.delta_limit:
            return {
                "ok": False,
                "error": (
                    f"leader and follower are {worst:.1f} apart on {worst_joint} "
                    f"(limit {self.delta_limit:.0f}) — match them by hand, or engage anyway"
                ),
                "needs_force": True,
            }

        try:
            with self.hw_lock:
                if engaged:
                    # `configure` is what puts torque back on; it is the same
                    # call `rearm` leans on rather than a bare enable_torque,
                    # because the follower's operating mode and gains have to be
                    # right before it is asked to hold a position.
                    self.robot.configure()
                    self._engage_ramp()
                else:
                    self._rest_and_release()
        except Exception as err:  # noqa: BLE001
            return {"ok": False, "error": f"could not {verb}: {err}"}

        with self.lock:
            self.engaged = engaged
            self.last_message = (
                "teleop engaged — the follower is tracking the leader"
                if engaged
                else "teleop observing — follower torque off"
            )
        log.info("teleop %sd", verb)
        return {"ok": True}

    def _kill_torque(self) -> list[str]:
        # Torque off outranks a clean serial transaction: if the loop will not
        # hand over the bus quickly, write anyway and accept a garbled packet
        # (the retries below cover it).
        acquired = self.hw_lock.acquire(timeout=0.5)
        if not acquired:
            log.warning("e-stop could not take the hardware lock in 500ms; cutting torque regardless")
        try:
            killed = []
            for role, arm in (("follower", self.robot), ("teleop", self.teleop)):
                bus = getattr(arm, "bus", None)
                if bus is None:
                    continue
                try:
                    bus.disable_torque(num_retry=3)
                    killed.append(role)
                except Exception as err:  # noqa: BLE001
                    log.error("could not cut torque on %s: %s", role, err)
            return killed
        finally:
            if acquired:
                self.hw_lock.release()

    def _ramp_to(self, pose: dict[str, float], seconds: float) -> None:
        """Ease the follower from wherever it reads now onto `pose`.

        Eased rather than linear so the arm decelerates into the target instead
        of travelling at a constant rate and stopping dead -- the difference
        between settling into a pose and being switched off mid-motion. Caller
        holds `hw_lock`.
        """
        observation = self.robot.get_observation()
        current = {
            key: float(value)
            for key, value in observation.items()
            if key.endswith(".pos") and isinstance(value, (int, float, np.number))
        }
        if not current:
            return
        target = {key: pose.get(key.removesuffix(".pos"), value) for key, value in current.items()}
        steps = max(1, round(self.fps * seconds))
        for step in range(1, steps + 1):
            fraction = _ease_out_cubic(step / steps)
            self.robot.send_action({
                key: value + fraction * (target[key] - value)
                for key, value in current.items()
            })
            if step < steps:
                time.sleep(1.0 / self.fps)

    def _rest_and_release(self) -> None:
        """Ease the follower into the relaxed pose, then leave both arms unpowered."""
        try:
            with self.hw_lock:
                self.robot.configure()
                self._ramp_to(REST_POSE, self.rest_seconds)
        except Exception as err:  # noqa: BLE001
            log.warning("could not move the follower to neutral: %s", err)
        finally:
            with self.lock:
                self.engaged = False
            self._kill_torque()

    def _engage_ramp(self) -> None:
        """Rise to a known pose, then ease onto the leader before live tracking.

        A bare `configure()` leaves the very next tick driving the follower
        straight to whatever the leader currently reads -- a full-speed snap if
        the two disagree by anywhere close to `delta_limit`. Rising first means
        every engage starts from the same height instead of cutting through the
        workspace from a curled rest pose, and syncing is its own eased ramp
        rather than the first raw teleop tick.
        """
        self._ramp_to(RISE_POSE, self.rise_seconds)
        leader_action = self.teleop.get_action()
        leader_pose = {
            key.removesuffix(".pos"): float(value)
            for key, value in leader_action.items()
            if key.endswith(".pos") and isinstance(value, (int, float, np.number))
        }
        self._ramp_to(leader_pose, self.sync_seconds)

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
                "hardware": dict(self._hardware),
                "cameras": list(self.camera_meta),
                "estop": {
                    "engaged": self.estop,
                    "reason": self.estop_reason,
                    "since_s": (now - self.estop_at) if self.estop else 0.0,
                    "auto": self.auto_estop,
                },
                "delta": dict(self._delta),
                "teleop": {
                    "engaged": self.engaged,
                    # Same number the delta panel already shows, restated as the
                    # yes/no the Engage button needs. A delta with no joints in
                    # it is not "aligned", it is "not measured yet".
                    "ready": bool(self._delta.get("joints")) and self._delta.get("max", 0.0) <= self.delta_limit,
                    "worst": self._delta.get("max", 0.0),
                    "worst_joint": self._delta.get("max_joint"),
                },
                "calibration": self._calibration_status,
            }

    @property
    def _calibration_status(self) -> dict[str, Any] | None:
        calib = self.calib
        return calib.status() if calib is not None else None

    def jpeg(self, name: str) -> bytes | None:
        with self._stream_cv:
            return self._jpegs.get(name)

    def wait_for_jpeg(self, name: str, seq: int, timeout: float = 5.0) -> tuple[bytes | None, int]:
        """Block until a frame newer than `seq` exists, for the MJPEG stream."""
        with self._stream_cv:
            if self._stream_seq <= seq:
                self._stream_cv.wait(timeout)
            return self._jpegs.get(name), self._stream_seq

    # -- called from the control loop thread ----------------------------

    def step(self) -> None:
        observation: dict[str, Any] | None = None
        sent: dict[str, Any] | None = None

        if self.estop:
            observation = self._estop_hold()
        elif self.calib is not None:
            observation = self._calibration_sample()
        else:
            observation, sent = self._teleop()
            if self._engage_pending:
                self._engage_on_start()

        with self.lock:
            state = self.state
        self._dispatch()

        if state == RECORDING and observation is not None and sent is not None:
            frame = {
                **build_dataset_frame(self.obs_features, observation, prefix=OBS_STR),
                **build_dataset_frame(self.action_features, sent, prefix=ACTION),
                "task": self.task,
            }
            self.dataset.add_frame(frame)
            with self.lock:
                self.frames += 1

        with self.lock:
            expired = self.state == PENDING and time.time() >= self.commit_at
        if expired:
            self._save()

        self._update_hardware(observation)
        self._publish_frames(observation)

    def _teleop(self) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        """Read both arms every tick; drive the follower only once engaged.

        Observing costs exactly the same two bus transactions, which is the
        point: the delta the operator is lining the arms up against is measured
        by the same code that will drive them a moment later.

        A dropped USB packet here must not take the daemon down with it -- the
        control loop's own `while True` only catches Ctrl-C, so anything else
        that escapes `step()` kills the process and both arms disconnect as a
        side effect, which reads exactly like a stop that nobody pressed. Log
        it and pick the read back up next tick instead.
        """
        try:
            with self.hw_lock:
                observation = self.robot.get_observation()
                action = self.teleop.get_action()
                sent = self.robot.send_action(action) if self.engaged else None
        except Exception as err:  # noqa: BLE001
            log.warning("teleop read/write failed, skipping this tick: %s", err)
            return None, None
        self._update_delta(action, observation)
        return observation, sent

    def _engage_on_start(self) -> None:
        """Apply --engage-on-start, once there is a delta to gate it on.

        Still gated: starting the daemon must not make a follower that is
        nowhere near its leader snap across its range, and the whole reason
        engagement is a separate step is that it is the moment that can happen.
        A refusal leaves teleop observing and says so, rather than failing
        silently and looking like a dead flag.
        """
        with self.lock:
            measured = bool(self._delta.get("joints"))
        if not measured:
            return
        self._engage_pending = False

        result = self._set_engaged(True)
        if not result.get("ok"):
            with self.lock:
                self.last_message = f"stayed observing — {result.get('error')}"
            log.warning("--engage-on-start refused: %s", result.get("error"))

    def _estop_hold(self) -> dict[str, Any] | None:
        """Keep reading -- and keep re-cutting torque -- while stopped.

        Reads carry on because the delta readout is what tells the operator when
        it is safe to re-arm, and because the camera streams should not go black
        at the moment something has just gone wrong.
        """
        try:
            with self.hw_lock:
                observation = self.robot.get_observation()
                action = self.teleop.get_action()
            self._update_delta(action, observation)
        except Exception as err:  # noqa: BLE001
            log.debug("read failed while e-stopped: %s", err)
            observation = None

        now = time.time()
        if now - self._estop_reasserted_at >= 2.0:
            self._estop_reasserted_at = now
            self._kill_torque()
        return observation

    def _calibration_sample(self) -> dict[str, Any] | None:
        calib = self.calib
        if calib is None:
            return None
        try:
            with self.hw_lock:
                calib.sample()
        except Exception as err:  # noqa: BLE001
            log.debug("calibration read failed: %s", err)
        # Normalised joint readings are meaningless mid-calibration, but the
        # cameras still are not, so the operator can see the arm they are moving.
        return self._camera_only_observation()

    def _camera_only_observation(self) -> dict[str, Any]:
        images: dict[str, Any] = {}
        cameras = getattr(self.robot, "cameras", {}) or {}
        for name, cam in cameras.items():
            try:
                with self.hw_lock:
                    images[name] = cam.read_latest()
            except Exception:  # noqa: BLE001
                continue
        return images

    def _dispatch(self) -> None:
        with self.lock:
            command, self._command = self._command, None
            payload, self._payload = self._payload, {}
            done, self._command_done = self._command_done, None

        if command is None:
            if done is not None:
                done.set()
            return

        result: dict[str, Any] = {"ok": True}
        if command == "record":
            with self.lock:
                pending = self.state == PENDING
            if pending:
                self._save()
            self._begin()
        elif command == "stop":
            self._pend()
            self._rest_and_release()
        elif command == "discard":
            self._discard()
        elif command == "save":
            self._save()
        elif command == "calibrate_start":
            result = self._calibrate_start(payload.get("arm") or "follower")
        elif command == "calibrate_home":
            result = self._calibrate_home()
        elif command == "calibrate_finish":
            result = self._calibrate_finish()
        elif command == "calibrate_cancel":
            result = self._calibrate_cancel()

        with self.lock:
            self._command_result = result
        if done is not None:
            done.set()

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
        # race a second recording would corrupt the writer's buffer. (The e-stop
        # is not affected -- it never waits on the loop.)
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

    # -- calibration ----------------------------------------------------

    def _arm(self, role: str):
        return self.teleop if role == "teleop" else self.robot

    def _calibrate_start(self, role: str) -> dict[str, Any]:
        if role not in ("teleop", "follower"):
            return {"ok": False, "error": f"unknown arm {role!r}"}
        arm = self._arm(role)
        if getattr(arm, "bus", None) is None:
            return {"ok": False, "error": f"{role} has no motor bus"}
        calib = Calibration(arm, role)
        try:
            with self.hw_lock:
                calib.begin()
        except Exception as err:  # noqa: BLE001
            return {"ok": False, "error": f"could not free the joints: {err}"}
        self.calib = calib
        with self.lock:
            self.state = CALIBRATING
            self.last_message = f"calibrating {role} — move it to the middle of its range"
        log.info("calibration started on %s", role)
        return {"ok": True}

    def _calibrate_home(self) -> dict[str, Any]:
        calib = self.calib
        if calib is None:
            return {"ok": False, "error": "not calibrating"}
        try:
            with self.hw_lock:
                calib.set_home()
        except Exception as err:  # noqa: BLE001
            return {"ok": False, "error": f"could not set home: {err}"}
        with self.lock:
            self.last_message = f"calibrating {calib.role} — sweep every joint through its range"
        return {"ok": True}

    def _calibrate_finish(self) -> dict[str, Any]:
        calib = self.calib
        if calib is None:
            return {"ok": False, "error": "not calibrating"}
        if calib.phase != Calibration.RANGE:
            return {"ok": False, "error": "set the home position first"}
        unswept = calib.unswept()
        if unswept:
            return {"ok": False, "error": f"not moved yet: {', '.join(unswept)}"}
        try:
            with self.hw_lock:
                calib.finish()
        except Exception as err:  # noqa: BLE001
            return {"ok": False, "error": f"could not write calibration: {err}"}
        self.calib = None
        with self.lock:
            self.state = IDLE
            self.last_message = f"calibrated {calib.role} → {getattr(calib.arm, 'calibration_fpath', 'motors')}"
        log.info("calibration written for %s", calib.role)
        return {"ok": True}

    def _calibrate_cancel(self) -> dict[str, Any]:
        calib = self.calib
        if calib is None:
            return {"ok": False, "error": "not calibrating"}
        try:
            with self.hw_lock:
                calib.cancel()
        except Exception as err:  # noqa: BLE001
            log.warning("could not restore the previous calibration: %s", err)
        self.calib = None
        with self.lock:
            self.state = IDLE
            self.last_message = f"calibration of {calib.role} cancelled"
        return {"ok": True}

    # -- tracking delta -------------------------------------------------

    def _update_delta(self, action: dict[str, Any] | None, observation: dict[str, Any] | None) -> None:
        """Per-joint |leader commanded − follower measured|.

        Both sides are in the same normalised units (−100..100, or 0..100 for the
        gripper), so one limit covers every joint. A delta that stays large is
        the follower failing to reach where it was told to go: it is jammed, is
        pushing on something, or has lost power.
        """
        if not action or not observation:
            return
        joints: dict[str, Any] = {}
        worst, worst_joint = 0.0, None
        for key, commanded in action.items():
            if not key.endswith(".pos"):
                continue
            measured = observation.get(key)
            if not isinstance(measured, (int, float)) or not isinstance(commanded, (int, float)):
                continue
            delta = abs(float(commanded) - float(measured))
            joints[key[: -len(".pos")]] = {
                "leader": round(float(commanded), 2),
                "follower": round(float(measured), 2),
                "delta": round(delta, 2),
            }
            if delta > worst:
                worst, worst_joint = delta, key[: -len(".pos")]

        over = worst > self.delta_limit
        self._over_ticks = self._over_ticks + 1 if over else 0
        with self.lock:
            self._delta = {
                "joints": joints,
                "max": round(worst, 2),
                "max_joint": worst_joint,
                "limit": self.delta_limit,
                "over": over,
                "over_ticks": self._over_ticks,
            }

        if self.auto_estop and not self.estop and self._over_ticks >= self.delta_grace:
            self.emergency_stop(f"tracking error {worst:.1f} > {self.delta_limit:.0f} on {worst_joint}")

    # -- camera streams -------------------------------------------------

    def _publish_frames(self, observation: dict[str, Any] | None) -> None:
        """Re-encode the frames the loop already grabbed, for the MJPEG streams.

        Throttled to `--stream-fps`: the cameras are read at the control rate
        either way, and JPEG-encoding two 640×480 frames 30 times a second buys
        nothing a browser can show.
        """
        if not observation:
            return
        now = time.time()
        if now - self._stream_at < self._stream_period:
            return
        self._stream_at = now

        encoded: dict[str, bytes] = {}
        for name in self.camera_meta:
            frame = observation.get(name)
            if isinstance(frame, np.ndarray) and frame.ndim == 3:
                jpeg = encode_jpeg(frame, self._stream_quality)
                if jpeg:
                    encoded[name] = jpeg
        if not encoded:
            return
        with self._stream_cv:
            self._jpegs.update(encoded)
            self._stream_seq += 1
            self._stream_cv.notify_all()

    # -- power panel ----------------------------------------------------

    def _update_hardware(self, observation: dict[str, Any] | None) -> None:
        now = time.time()

        if now - self._motors_probed_at >= 5.0 and self.state not in (CALIBRATING,):
            self._motors_probed_at = now
            for attr_probe, attr_temp, arm in (
                ("_teleop_motors", "_teleop_temps", self.teleop),
                ("_follower_motors", "_follower_temps", self.robot),
            ):
                bus = getattr(arm, "bus", None)
                if bus is None:
                    continue
                try:
                    with self.hw_lock:
                        setattr(self, attr_probe, motor_probe(bus))
                        setattr(self, attr_temp, motor_temperatures(bus))
                except Exception:  # noqa: BLE001
                    pass

        teleop_port = getattr(self.teleop, "bus", None) and self.teleop.bus.port
        follower_port = getattr(self.robot, "bus", None) and self.robot.bus.port
        teleop_ok = sum(self._teleop_motors.values()) if self._teleop_motors else 0
        follower_ok = sum(self._follower_motors.values()) if self._follower_motors else 0

        teleop = build_arm_power(
            role="teleop",
            port=teleop_port,
            usb=getattr(self.teleop, "is_connected", False),
            powered=getattr(self.teleop, "is_connected", False) and teleop_ok > 0,
            motors_ok=teleop_ok,
            motors_total=len(self._teleop_motors) or 6,
            temperatures=self._teleop_temps,
            message="torque cut by the e-stop" if self.estop else None,
        )
        follower = build_arm_power(
            role="follower",
            port=follower_port,
            usb=getattr(self.robot, "is_connected", False),
            powered=getattr(self.robot, "is_connected", False) and follower_ok > 0,
            motors_ok=follower_ok,
            motors_total=len(self._follower_motors) or 6,
            temperatures=self._follower_temps,
            message="torque cut by the e-stop" if self.estop else None,
        )

        cameras: dict[str, Any] = {}
        for name, index in self.camera_meta.items():
            frame = (observation or {}).get(name)
            streaming = isinstance(frame, np.ndarray) and frame.ndim == 3
            cameras[name] = build_camera_power(
                name=name,
                index=index,
                usb=getattr(self.robot, "is_connected", False),
                streaming=streaming,
                message=None if streaming else "no frame from camera",
            )

        overall = aggregate_status([teleop["status"], follower["status"], *(c["status"] for c in cameras.values())])

        with self.lock:
            self._hardware = {
                "source": "recorder",
                "status": "fail" if self.estop else overall,
                "teleop": teleop,
                "follower": follower,
                "cameras": cameras,
            }


def encode_jpeg(frame: np.ndarray, quality: int = 70) -> bytes | None:
    """RGB ndarray → JPEG bytes. Cameras hand back RGB; cv2 encodes BGR."""
    try:
        import cv2
    except ImportError:  # pragma: no cover - cv2 ships with the camera extra
        return None
    ok, buffer = cv2.imencode(".jpg", frame[:, :, ::-1], [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    return buffer.tobytes() if ok else None


# -- websocket (RFC 6455, server side only) -------------------------------
#
# A dependency-free implementation, because the venv has no websockets library
# and the daemon only needs the narrow half of the protocol: accept one upgrade,
# push text frames, notice when the client leaves. Reading is limited to
# recognising close and ping, since nothing the browser sends here matters.

WS_GUID = "258EAFA5-E914-47DA-95CA-5AB0DC85B11F"


def ws_accept_key(key: str) -> str:
    return base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()


def ws_frame(payload: bytes, opcode: int = 0x1) -> bytes:
    """One unfragmented, unmasked frame. Servers never mask."""
    header = bytearray([0x80 | opcode])
    length = len(payload)
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header += struct.pack("!H", length)
    else:
        header.append(127)
        header += struct.pack("!Q", length)
    return bytes(header) + payload


def ws_read_opcode(sock: socket.socket) -> int | None:
    """Opcode of one waiting client frame, or None if nothing is pending.

    Client frames are always masked; the payload is read and dropped, since the
    only ones that matter are close (0x8) and ping (0x9).
    """
    try:
        first = sock.recv(2)
    except (BlockingIOError, TimeoutError):
        return None
    except OSError:
        return 0x8
    if len(first) < 2:
        return 0x8

    opcode = first[0] & 0x0F
    masked = first[1] & 0x80
    length = first[1] & 0x7F
    try:
        if length == 126:
            length = struct.unpack("!H", recv_exactly(sock, 2))[0]
        elif length == 127:
            length = struct.unpack("!Q", recv_exactly(sock, 8))[0]
        if masked:
            recv_exactly(sock, 4)
        if length:
            recv_exactly(sock, length)
    except OSError:
        return 0x8
    return opcode


def recv_exactly(sock: socket.socket, count: int) -> bytes:
    chunks = []
    while count:
        chunk = sock.recv(count)
        if not chunk:
            raise OSError("connection closed")
        chunks.append(chunk)
        count -= len(chunk)
    return b"".join(chunks)


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
            url = urlparse(self.path)
            path = url.path.rstrip("/")
            query = parse_qs(url.query)
            name = (query.get("camera") or [""])[0]

            if path in ("", "/status"):
                self._reply(recorder.status())
            elif path == "/ws":
                self._websocket()
            elif path == "/snapshot":
                self._snapshot(name)
            elif path == "/stream":
                self._stream(name)
            else:
                self._reply({"error": "not found"}, 404)

        def _websocket(self) -> None:
            """Push status to the dashboard until the client goes away.

            Replaces a 4 Hz poll per panel. The saving is not really the request
            count -- it is that a poll against a daemon that is not running is a
            failed request every 250ms forever, whereas a socket that will not
            open is one failed connect and a backoff.
            """
            key = self.headers.get("Sec-WebSocket-Key")
            if not key or "websocket" not in (self.headers.get("Upgrade") or "").lower():
                self._reply({"error": "expected a websocket upgrade"}, 400)
                return

            self.send_response(101, "Switching Protocols")
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", ws_accept_key(key))
            self.end_headers()
            self.close_connection = True

            sock = self.connection
            # Short timeout rather than non-blocking: recv is only used to notice
            # the client leaving, and it must not stall the push cadence.
            sock.settimeout(0.01)
            try:
                while True:
                    payload = json.dumps(recorder.status()).encode()
                    sock.settimeout(None)
                    sock.sendall(ws_frame(payload))
                    sock.settimeout(0.01)

                    opcode = ws_read_opcode(sock)
                    if opcode == 0x8:
                        break
                    if opcode == 0x9:
                        sock.sendall(ws_frame(b"", opcode=0xA))
                    time.sleep(WS_PERIOD)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                try:
                    sock.settimeout(None)
                except OSError:
                    pass

        def _snapshot(self, name: str) -> None:
            jpeg = recorder.jpeg(name)
            if jpeg is None:
                self._reply({"error": f"no frames from camera {name!r}"}, 404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(jpeg)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(jpeg)

        def _stream(self, name: str) -> None:
            """MJPEG: one multipart part per frame, held open until the client
            goes away. An <img src> renders this with no JavaScript at all."""
            if name not in recorder.camera_meta:
                self._reply({"error": f"unknown camera {name!r}"}, 404)
                return
            self.send_response(200)
            self.send_header("Content-Type", f"multipart/x-mixed-replace; boundary={BOUNDARY}")
            self.send_header("Cache-Control", "no-store, no-cache, private")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True

            seq = -1
            try:
                while True:
                    jpeg, seq = recorder.wait_for_jpeg(name, seq)
                    if jpeg is None:
                        continue
                    self.wfile.write(
                        b"--" + BOUNDARY.encode() + b"\r\n"
                        b"Content-Type: image/jpeg\r\n"
                        b"Content-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n"
                    )
                    self.wfile.write(jpeg)
                    self.wfile.write(b"\r\n")
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                payload = {}
            name = self.path.strip("/").split("/")[-1]
            if name not in COMMANDS:
                self._reply({"error": "not found"}, 404)
                return
            result = recorder.command(name, payload)
            self._reply({**result, **recorder.status()}, 200 if result.get("ok") else 409)

    return Handler


COMMANDS = {
    "record",
    "stop",
    "discard",
    "save",
    "task",
    "estop",
    "rearm",
    "engage",
    "disengage",
    "calibrate_start",
    "calibrate_home",
    "calibrate_finish",
    "calibrate_cancel",
}


def build_hardware(args):
    camera_meta = {spec.split("=", 1)[0]: int(spec.split("=", 1)[1]) for spec in args.camera}

    from lerobot.cameras.opencv import OpenCVCameraConfig
    from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig
    from lerobot.teleoperators.so_leader import SO101Leader, SO101LeaderConfig

    cameras = {
        name: OpenCVCameraConfig(index_or_path=index, width=args.width, height=args.height, fps=args.fps)
        for name, index in camera_meta.items()
    }

    robot = SO101Follower(SO101FollowerConfig(port=args.robot_port, id=args.robot_id, cameras=cameras))
    teleop = SO101Leader(SO101LeaderConfig(port=args.teleop_port, id=args.teleop_id))
    return robot, teleop, camera_meta


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
        help="Repeatable, e.g. --camera third_person=0 --camera wrist=1",
    )
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument(
        "--delta-limit",
        type=float,
        default=25.0,
        help="Leader/follower disagreement (normalised units) the dashboard flags as a tracking fault.",
    )
    parser.add_argument(
        "--auto-estop",
        action="store_true",
        help="Cut torque automatically when the delta stays over the limit. Off by default: "
        "a follower can legitimately lag the leader through a fast move.",
    )
    parser.add_argument(
        "--delta-grace",
        type=int,
        default=5,
        help="Consecutive ticks over the limit before --auto-estop fires.",
    )
    parser.add_argument(
        "--engage-on-start",
        action="store_true",
        help="Hand the follower to the leader as soon as the arms are read, instead of starting in "
        "observing mode. Still refused if the two are further apart than --delta-limit.",
    )
    parser.add_argument(
        "--rest-seconds",
        type=float,
        default=DEFAULT_REST_SECONDS,
        help="Seconds used to ease the follower to the relaxed pose before torque is released.",
    )
    parser.add_argument(
        "--rise-seconds",
        type=float,
        default=DEFAULT_RISE_SECONDS,
        help="Seconds used to raise the follower to RISE_POSE at the start of an engage.",
    )
    parser.add_argument(
        "--sync-seconds",
        type=float,
        default=DEFAULT_SYNC_SECONDS,
        help="Seconds used to ease from RISE_POSE onto the leader's live pose before tracking begins.",
    )
    parser.add_argument("--stream-fps", type=float, default=10.0, help="Rate of the browser camera streams.")
    parser.add_argument("--stream-quality", type=int, default=70, help="JPEG quality of the camera streams.")
    args = parser.parse_args()

    if not (args.robot_port and args.teleop_port):
        parser.error("--robot-port and --teleop-port are required")

    robot, teleop, camera_meta = build_hardware(args)
    robot.connect()
    teleop.connect()

    features = {
        **hw_to_dataset_features(robot.observation_features, OBS_STR, use_video=True),
        **hw_to_dataset_features(robot.action_features, ACTION, use_video=True),
    }

    from lerobot.utils.constants import HF_LEROBOT_HOME

    if (HF_LEROBOT_HOME / args.repo_id).exists():
        # `root` is required: without it resume() would build a writer over the
        # revision-safe Hub snapshot cache, which it refuses to do. Same reason
        # as in reopen() -- and we always want the local directory anyway.
        dataset = LeRobotDataset.resume(
            repo_id=args.repo_id,
            root=HF_LEROBOT_HOME / args.repo_id,
            rgb_encoder=RGBEncoderConfig(vcodec="h264"),
        )
        log.info("resuming %s at %d episodes", args.repo_id, dataset.meta.total_episodes)
        # An existing dataset's schema is fixed. Adding frames under camera names
        # it was not created with fails deep inside the writer, one Record press
        # later; catching it here says which names it actually wants.
        existing = {key.split(".")[-1] for key in dataset.meta.features if key.startswith(f"{OBS_STR}.images.")}
        if existing != set(camera_meta):
            parser.error(
                f"{args.repo_id} was recorded with cameras {sorted(existing)}, but this run configures "
                f"{sorted(camera_meta)}. Pass --camera NAME=INDEX matching the dataset, or record into a new "
                "--repo-id."
            )
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
        robot,
        teleop,
        dataset,
        args.fps,
        args.task,
        args.commit_seconds,
        args.flush_every,
        camera_meta=camera_meta,
        delta_limit=args.delta_limit,
        auto_estop=args.auto_estop,
        engage_on_start=args.engage_on_start,
        rest_seconds=args.rest_seconds,
        rise_seconds=args.rise_seconds,
        sync_seconds=args.sync_seconds,
        delta_grace=args.delta_grace,
        stream_fps=args.stream_fps,
        stream_quality=args.stream_quality,
    )

    server = ThreadingHTTPServer((args.host, args.port), make_handler(recorder))
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log.info("control API on http://%s:%d — ready", args.host, args.port)
    for name, index in camera_meta.items():
        log.info("camera %s (index %d) at http://%s:%d/stream?camera=%s", name, index, args.host, args.port, name)

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
        recorder._rest_and_release()
        robot.disconnect()
        teleop.disconnect()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
