#!/usr/bin/env python
"""Stream one or more USB cameras as MJPEG, and nothing else.

The recording daemon also streams its cameras, but it needs an arm, a dataset,
and a matching schema before it will start. This is the "just turn the camera
on" case: no arms, no dataset, no writing anything.

    python scripts/camera_server.py --camera third_person=2 --camera wrist=0

    http://127.0.0.1:8614/stream?camera=wrist      MJPEG, renders in an <img>
    http://127.0.0.1:8614/snapshot?camera=wrist    one JPEG
    http://127.0.0.1:8614/status                   which cameras are up

Only one process can hold a capture device on macOS, so stop the recorder before
running this, and stop this before starting the recorder.
"""

from __future__ import annotations

import argparse
import json
import logging
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np

BOUNDARY = "suds-frame"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("cameras")


class Cameras:
    """Grabs from every camera on one thread and hands out the latest JPEG."""

    def __init__(self, meta: dict[str, int], width: int, height: int, stream_fps: float, quality: int):
        from lerobot.cameras.opencv import OpenCVCamera, OpenCVCameraConfig

        self.meta = meta
        self.quality = quality
        self.period = 1.0 / max(1.0, stream_fps)
        # No fps in the device config on purpose. LeRobot raises if the camera
        # cannot deliver exactly the rate asked for -- a webcam that only does
        # 30 refuses 15 -- and the rate the browser needs has nothing to do with
        # the rate the sensor runs at. Take the camera's own rate, publish at
        # --stream-fps.
        self.cameras = {
            name: OpenCVCamera(OpenCVCameraConfig(index_or_path=index, width=width, height=height))
            for name, index in meta.items()
        }
        self.jpegs: dict[str, bytes] = {}
        self.errors: dict[str, str] = {}
        self.misses: dict[str, int] = {}
        self.failed_at: dict[str, float] = {}
        self.retry_period = 5.0
        self.cv = threading.Condition()
        self.seq = 0

    def connect(self) -> None:
        for name, cam in self.cameras.items():
            try:
                cam.connect()
                log.info("camera %s (index %d) open", name, self.meta[name])
            except Exception as err:  # noqa: BLE001
                self.errors[name] = str(err)
                log.error("camera %s (index %d) failed: %s", name, self.meta[name], err)

    def disconnect(self) -> None:
        for cam in self.cameras.values():
            try:
                cam.disconnect()
            except Exception:  # noqa: BLE001
                pass

    def step(self) -> None:
        from record_server import encode_jpeg

        encoded = {}
        now = time.time()
        for name, cam in self.cameras.items():
            if self.errors.get(name):
                # A camera that has dropped out gets picked back up rather than
                # written off: USB cameras stall, and the alternative is a panel
                # that stays black until someone restarts the process.
                if now - self.failed_at.get(name, 0.0) >= self.retry_period:
                    self._reconnect(name)
                continue
            try:
                # read_latest peeks at the capture thread's buffer instead of
                # waiting on it. `read` blocks for its full 10s timeout when a
                # camera stalls, which stops every *other* camera dead too.
                frame = cam.read_latest(max_age_ms=1000)
            except Exception as err:  # noqa: BLE001
                # One stale frame is normal; a run of them is a dead camera.
                self.misses[name] = self.misses.get(name, 0) + 1
                if self.misses[name] >= 15:
                    self.errors[name] = str(err)
                    self.failed_at[name] = now
                    log.warning("camera %s stopped delivering: %s", name, err)
                continue
            self.misses[name] = 0
            if isinstance(frame, np.ndarray) and frame.ndim == 3:
                jpeg = encode_jpeg(frame, self.quality)
                if jpeg:
                    encoded[name] = jpeg
        if encoded:
            with self.cv:
                self.jpegs.update(encoded)
                self.seq += 1
                self.cv.notify_all()

    def _reconnect(self, name: str) -> None:
        # Runs off the step() thread: cam.connect(warmup=True) blocks for up to
        # warmup_s waiting on a frame (the exact "Timed out waiting for frame"
        # error a stalled webcam throws), and step() drives every camera, so a
        # blocking reconnect here freezes every other camera's stream too.
        self.failed_at[name] = time.time()
        threading.Thread(target=self._reconnect_worker, args=(name,), daemon=True).start()

    def _reconnect_worker(self, name: str) -> None:
        cam = self.cameras[name]
        try:
            cam.disconnect()
        except Exception:  # noqa: BLE001
            pass
        try:
            cam.connect(warmup=False)
        except Exception as err:  # noqa: BLE001
            self.errors[name] = str(err)
            return
        self.errors.pop(name, None)
        self.misses[name] = 0
        log.info("camera %s (index %d) back", name, self.meta[name])

    def wait(self, name: str, seq: int, timeout: float = 5.0) -> tuple[bytes | None, int]:
        with self.cv:
            if self.seq <= seq:
                self.cv.wait(timeout)
            return self.jpegs.get(name), self.seq

    def status(self) -> dict:
        return {
            "cameras": [
                {
                    "name": name,
                    "index": index,
                    "streaming": name in self.jpegs and not self.errors.get(name),
                    "error": self.errors.get(name),
                }
                for name, index in self.meta.items()
            ]
        }


def make_handler(cameras: Cameras):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        def do_GET(self) -> None:  # noqa: N802
            url = urlparse(self.path)
            path = url.path.rstrip("/")
            name = (parse_qs(url.query).get("camera") or [""])[0]

            if path in ("", "/status"):
                payload = json.dumps(cameras.status()).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            elif path == "/snapshot":
                jpeg = cameras.jpegs.get(name)
                if jpeg is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(jpeg)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(jpeg)
            elif path == "/stream":
                self._stream(name)
            else:
                self.send_response(404)
                self.end_headers()

        def _stream(self, name: str) -> None:
            if name not in cameras.meta:
                self.send_response(404)
                self.end_headers()
                return
            error = cameras.errors.get(name)
            if error and name not in cameras.jpegs:
                payload = json.dumps({"error": error}).encode()
                self.send_response(503)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
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
                    jpeg, seq = cameras.wait(name, seq)
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

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--camera", action="append", default=[], metavar="NAME=INDEX", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8614)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument(
        "--stream-fps",
        type=float,
        default=15.0,
        help="Rate frames are published to the browser. The cameras themselves run at their own rate.",
    )
    parser.add_argument("--quality", type=int, default=70)
    args = parser.parse_args()

    meta = {spec.split("=", 1)[0]: int(spec.split("=", 1)[1]) for spec in args.camera}
    cameras = Cameras(meta, args.width, args.height, args.stream_fps, args.quality)
    cameras.connect()

    server = ThreadingHTTPServer((args.host, args.port), make_handler(cameras))
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log.info("cameras on http://%s:%d — ready", args.host, args.port)

    try:
        while True:
            start = time.perf_counter()
            cameras.step()
            time.sleep(max(0.0, cameras.period - (time.perf_counter() - start)))
    except KeyboardInterrupt:
        log.info("shutting down")
    finally:
        server.shutdown()
        cameras.disconnect()
    return 0


if __name__ == "__main__":
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(main())
