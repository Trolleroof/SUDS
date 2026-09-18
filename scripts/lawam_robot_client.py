"""Local LaWAM client corrections; no changes to the ignored LeRobot checkout.

Importing this module does not connect cameras, motors, or a policy server.
"""
import base64
import json
import threading
import time
from pathlib import Path
from queue import Queue

import cv2
import draccus
import numpy as np
import torch
import zmq

from lerobot.async_inference.robot_client import RobotClient, RobotClientConfig
from lerobot.async_inference.helpers import TimedAction
from lerobot.cameras.zmq.camera_zmq import ZMQCamera
from lerobot.utils.import_utils import register_third_party_plugins


def strict_camera_read(camera):
    """Keep the publisher's RGB byte convention; never substitute another view."""
    if not camera.is_connected or camera.socket is None:
        raise RuntimeError(f"{camera} is not connected")
    try:
        payload = json.loads(camera.socket.recv_string())
    except zmq.Again as exc:
        raise TimeoutError(f"{camera} camera receive timeout") from exc
    encoded = payload.get("images", {}).get(camera.camera_name)
    if not encoded:
        raise RuntimeError(f"Missing required camera: {camera.camera_name}")
    frame = cv2.imdecode(np.frombuffer(base64.b64decode(encoded, validate=True), np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise RuntimeError(f"Invalid JPEG for camera: {camera.camera_name}")
    return frame


class LawamRobotClient(RobotClient):
    def __init__(self, config):
        super().__init__(config)
        # Base control_loop_action also acquires this lock. Keep pop, send and
        # latest_action publication atomic relative to incoming queue merges.
        self.action_queue_lock = threading.RLock()
        self._starved_at = None
        self._audit_count = 0
        self._audit_dir = Path("logs") / f"lawam_inputs_{time.time_ns()}"

    def _aggregate_action_queues(self, incoming_actions, aggregate_fn=None):
        if any(a.get_action().shape != (6,) or not torch.isfinite(a.get_action()).all()
               for a in incoming_actions):
            raise ValueError("Expected finite six-joint actions from LaWAM")
        aggregate_fn = aggregate_fn or (lambda old, new: new)
        with self.action_queue_lock, self.latest_action_lock:
            pending = {a.get_timestep(): a for a in self.action_queue.queue
                       if a.get_timestep() > self.latest_action}
            before = len(pending)
            stale = 0
            for action in incoming_actions:
                step = action.get_timestep()
                if step <= self.latest_action:
                    stale += 1
                    continue
                if step in pending:
                    action = TimedAction(action.get_timestamp(), step,
                                         aggregate_fn(pending[step].get_action(), action.get_action()))
                pending[step] = action
            replacement = Queue()
            for step in sorted(pending):
                replacement.put(pending[step])
            self.action_queue = replacement
            self.logger.info("Action queue: before=%d incoming=%d stale=%d after=%d",
                             before, len(incoming_actions), stale, len(pending))

    def _queue_observation(self, observation):
        # The server's similarity filter compares joints only. A stationary arm
        # still needs fresh visual predictions; don't wait for an empty queue.
        observation.must_go = True
        super()._queue_observation(observation)

    def send_observation(self, observation):
        # Save on the upload worker, never on the motor-control loop.
        if self._audit_count < 3:
            raw = observation.get_observation()
            self._audit_dir.mkdir(parents=True, exist_ok=True)
            np.savez_compressed(self._audit_dir / f"input_{self._audit_count}.npz",
                                overhead=raw["image"], wrist=raw["image2"],
                                state=np.array([raw[k] for k in self.robot.action_features]),
                                joint_names=np.array(list(self.robot.action_features)),
                                task=raw["task"])
            self._audit_count += 1
            self.logger.info("Saved pre-upload observation %d/3 in %s", self._audit_count, self._audit_dir)
        return super().send_observation(observation)

    def actions_available(self):
        available = super().actions_available()
        if not available and self.latest_action >= 0 and self._starved_at is None:
            self._starved_at = time.monotonic()
        elif available and self._starved_at is not None:
            self.logger.warning("Action queue starvation lasted %.3fs", time.monotonic() - self._starved_at)
            self._starved_at = None
        return available

    def control_loop_action(self, verbose=False):
        with self.action_queue_lock:
            target = self._action_tensor_to_action_dict(self.action_queue.queue[0].get_action())
            performed = super().control_loop_action(verbose)
        self.logger.debug("Action target=%s commanded_after_limits=%s", target, performed)
        return performed

    def control_loop_observation(self, task, verbose=False):
        observation = super().control_loop_observation(task, verbose)
        if observation is None:
            self.shutdown_event.set()
            raise RuntimeError("Observation capture failed; stopping policy control")
        return observation

    def receive_actions(self, verbose=False):
        try:
            super().receive_actions(verbose)
        finally:
            self.shutdown_event.set()

    def send_observations(self):
        try:
            super().send_observations()
        finally:
            self.shutdown_event.set()


@draccus.wrap()
def main(config: RobotClientConfig):
    if config.policy_type != "lawam":
        raise ValueError("This launcher requires policy_type=lawam")
    # Scope the strict camera decoder to this client process only.
    ZMQCamera._read_from_hardware = strict_camera_read
    client = LawamRobotClient(config)
    workers = []
    try:
        if not client.start():
            raise RuntimeError("Policy server initialization failed")
        workers = [threading.Thread(target=client.receive_actions, daemon=True),
                   threading.Thread(target=client.send_observations, daemon=True)]
        for worker in workers:
            worker.start()
        client.control_loop(task=config.task)
        # This loop only returns when a transport/observation/watchdog failure
        # requests shutdown. Don't report that as a successful completed task.
        raise RuntimeError("Policy client stopped early; inspect the preceding error")
    finally:
        client.stop()
        for worker in workers:
            worker.join(timeout=2)


if __name__ == "__main__":
    register_third_party_plugins()
    main()
