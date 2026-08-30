#!/usr/bin/env python
"""Live preview of one OpenCV camera by index -- for finding/checking a
wrist or overhead camera before wiring it into a robot config.

Run standalone in a plain terminal (NOT mjpython -- this is unrelated to
MuJoCo and mjpython's Cocoa main-thread takeover will fight cv2's own window).

    python scripts/stream_camera.py --list
    python scripts/stream_camera.py --index 2
"""

from __future__ import annotations

import argparse
import sys

import cv2

from lerobot.cameras.opencv import OpenCVCamera, OpenCVCameraConfig


def list_cameras() -> int:
    from lerobot.cameras.opencv.camera_opencv import OpenCVCamera as _Cam

    infos = _Cam.find_cameras()
    if not infos:
        print("No OpenCV-visible cameras found.")
        return 1
    for info in infos:
        print(f"  index {info['id']}: {info.get('name', '?')}  ({info.get('default_stream_profile')})")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--index", type=int, default=None, help="Camera index to stream.")
    parser.add_argument("--list", action="store_true", help="List detected cameras and exit.")
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--fps", type=int, default=30)
    args = parser.parse_args()

    if args.list or args.index is None:
        rc = list_cameras()
        if args.index is None:
            print("\nPass --index N to stream one.")
            return rc

    cam = OpenCVCamera(OpenCVCameraConfig(index_or_path=args.index, width=args.width, height=args.height, fps=args.fps))
    cam.connect()
    print(f"Streaming camera {args.index}. Press 'q' or Ctrl-C in the window to stop.")
    try:
        while True:
            frame = cam.read()  # RGB
            bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
            cv2.imshow(f"camera {args.index}", bgr)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break
    except KeyboardInterrupt:
        pass
    finally:
        cam.disconnect()
        cv2.destroyAllWindows()
    return 0


if __name__ == "__main__":
    sys.exit(main())
