#!/usr/bin/env python
"""Power / connection checker for the SUDS dashboard.

Probes whether the arms and cameras are plugged in and powered — without holding
a teleop loop open. Each scan connects briefly, pings servos (or grabs one camera
frame), and disconnects.

    python scripts/health_server.py \
        --teleop-port /dev/tty.usbmodemXXXX --robot-port /dev/tty.usbmodemYYYY \
        --camera overhead=0 --camera wrist=1

    python scripts/health_server.py --mock

Dashboard: http://127.0.0.1:8612/status  (SUDS_HEALTH_URL to override)
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from power_check import scan_all  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("health")


class PowerMonitor:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.lock = threading.Lock()
        self._payload: dict = {"status": "offline", "message": "starting"}

    def status(self) -> dict:
        with self.lock:
            return dict(self._payload)

    def tick(self) -> None:
        payload = scan_all(
            teleop_port=self.args.teleop_port,
            robot_port=self.args.robot_port,
            teleop_id=self.args.teleop_id,
            robot_id=self.args.robot_id,
            cameras=self.camera_meta,
            width=self.args.width,
            height=self.args.height,
            fps=int(self.args.rate),
            mock=self.args.mock,
        )
        payload["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        with self.lock:
            self._payload = payload

    @property
    def camera_meta(self) -> dict[str, int]:
        return {spec.split("=", 1)[0]: int(spec.split("=", 1)[1]) for spec in self.args.camera}


def make_handler(monitor: PowerMonitor):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        def do_GET(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0].rstrip("/")
            if path in ("", "/status"):
                payload = json.dumps(monitor.status()).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            self.send_response(404)
            self.end_headers()

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8612)
    parser.add_argument("--teleop-port")
    parser.add_argument("--teleop-id", default="leader")
    parser.add_argument("--robot-port")
    parser.add_argument("--robot-id", default="follower")
    parser.add_argument("--camera", action="append", default=[], metavar="NAME=INDEX")
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--rate", type=float, default=30.0, help="Scan interval uses 1/rate seconds.")
    parser.add_argument("--mock", action="store_true")
    args = parser.parse_args()

    if not args.mock and not (args.teleop_port and args.robot_port):
        parser.error("--teleop-port and --robot-port are required unless --mock is set")

    monitor = PowerMonitor(args)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(monitor))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log.info("power check API on http://%s:%d", args.host, args.port)

    period = max(2.0, 1.0 / args.rate)
    try:
        while True:
            start = time.perf_counter()
            monitor.tick()
            time.sleep(max(0.5, period - (time.perf_counter() - start)))
    except KeyboardInterrupt:
        log.info("shutting down")
    finally:
        server.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
