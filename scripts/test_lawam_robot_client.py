"""No hardware/network: python scripts/test_lawam_robot_client.py."""
import base64
import json
import logging
import tempfile
import threading
import unittest
from pathlib import Path
from queue import Queue
from types import SimpleNamespace
from unittest.mock import patch

import cv2
import numpy as np
import torch

from lawam_robot_client import LawamRobotClient, RobotClient, TimedAction, strict_camera_read
from lerobot.async_inference.helpers import TimedObservation


def action(step, value=1):
    return TimedAction(0, step, torch.full((6,), float(value)))


def client():
    c = LawamRobotClient.__new__(LawamRobotClient)
    c.action_queue = Queue()
    c.action_queue_lock = threading.RLock()
    c.latest_action_lock = threading.Lock()
    c.latest_action = 0
    c.action_queue_size = []
    c.observation_queue = Queue(maxsize=1)
    c.shutdown_event = threading.Event()
    c.logger = logging.getLogger("test")
    c._audit_count = 0
    c._starved_at = None
    c.robot = SimpleNamespace(action_features={f"joint{i}.pos": float for i in range(6)})
    return c


class ClientTests(unittest.TestCase):
    def test_preserves_pending_tail_and_ignores_stale_chunk(self):
        c = client()
        c._aggregate_action_queues([action(i) for i in range(1, 25)])
        c._aggregate_action_queues([action(0), action(1, 3)], lambda old, new: (old + new) / 2)
        self.assertEqual([a.timestep for a in c.action_queue.queue], list(range(1, 25)))
        self.assertEqual(c.action_queue.queue[0].action.tolist(), [2] * 6)
        c._aggregate_action_queues([action(0)])
        self.assertEqual(c.action_queue.qsize(), 24)

    def test_inflight_action_cannot_be_reinserted(self):
        c = client()
        c._aggregate_action_queues([action(1), action(2)])
        sending, release, merging, merged = (threading.Event() for _ in range(4))
        def send(target):
            sending.set()
            if not release.wait(2):
                raise RuntimeError("Test motor wait expired")
            return target
        c.robot.send_action = send
        def merge():
            merging.set()
            c._aggregate_action_queues([action(1, 2), action(2, 2)])
            merged.set()
        motor = threading.Thread(target=c.control_loop_action)
        receiver = threading.Thread(target=merge)
        motor.start()
        self.assertTrue(sending.wait(1))
        receiver.start()
        try:
            self.assertTrue(merging.wait(1))
            self.assertFalse(merged.wait(0.05))
        finally:
            release.set()
            motor.join(2)
            receiver.join(2)
        self.assertFalse(motor.is_alive() or receiver.is_alive())
        self.assertTrue(merged.is_set())
        self.assertEqual([a.timestep for a in c.action_queue.queue], [2])

    def test_invalid_actions_rejected_without_queue_loss(self):
        c = client()
        c._aggregate_action_queues([action(1)])
        for tensor in (torch.zeros(5), torch.full((6,), float("nan"))):
            with self.assertRaises(ValueError):
                c._aggregate_action_queues([TimedAction(0, 2, tensor)])
            self.assertEqual(c.action_queue.qsize(), 1)

    def test_named_camera_required_and_rgb_preserved(self):
        rgb = np.full((16, 16, 3), (210, 40, 10), dtype=np.uint8)
        ok, jpeg = cv2.imencode(".jpg", rgb)
        self.assertTrue(ok)
        images = {"overhead": base64.b64encode(jpeg).decode()}
        camera = SimpleNamespace(is_connected=True, camera_name="wrist",
                                 socket=SimpleNamespace(recv_string=lambda: json.dumps({"images": images})))
        with self.assertRaisesRegex(RuntimeError, "Missing required camera: wrist"):
            strict_camera_read(camera)
        camera.camera_name = "overhead"
        np.testing.assert_allclose(strict_camera_read(camera), rgb, atol=3)

    def test_latest_observation_forced_and_three_inputs_saved(self):
        c = client()
        raw = {k: float(i) for i, k in enumerate(c.robot.action_features)}
        raw.update(image=np.zeros((8, 8, 3), np.uint8), image2=np.ones((8, 8, 3), np.uint8), task="scrub")
        with tempfile.TemporaryDirectory() as directory:
            c._audit_dir = Path(directory)
            for i in range(4):
                c._queue_observation(TimedObservation(0, i, raw, must_go=False))
                with patch.object(RobotClient, "send_observation", return_value=True):
                    c.send_observation(c.observation_queue.queue[0])
            queued = c.observation_queue.get_nowait()
            self.assertTrue(queued.must_go)
            self.assertEqual(queued.timestep, 3)
            self.assertEqual(len(list(c._audit_dir.glob("*.npz"))), 3)
            with np.load(c._audit_dir / "input_0.npz") as saved:
                np.testing.assert_array_equal(saved["overhead"], raw["image"])
                np.testing.assert_array_equal(saved["wrist"], raw["image2"])
                self.assertEqual(saved["state"].tolist(), list(range(6)))

    def test_capture_and_receiver_failure_request_shutdown(self):
        c = client()
        with patch.object(RobotClient, "control_loop_observation", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "Observation capture failed"):
                c.control_loop_observation("scrub")
        self.assertTrue(c.shutdown_event.is_set())
        c.shutdown_event.clear()
        with patch.object(RobotClient, "receive_actions", side_effect=ValueError("bad chunk")):
            with self.assertRaises(ValueError):
                c.receive_actions()
        self.assertTrue(c.shutdown_event.is_set())


if __name__ == "__main__":
    unittest.main()
