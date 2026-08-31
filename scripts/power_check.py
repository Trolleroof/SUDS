"""Power and connection checks for SO-101 arms and cameras."""

from __future__ import annotations

import glob
import os
from typing import Any


def list_serial_ports() -> list[str]:
    return sorted(glob.glob("/dev/tty.usbmodem*") + glob.glob("/dev/tty.usbserial*"))


def motor_probe(bus) -> dict[str, bool]:
    return {name: bus.ping(name, num_retry=2) is not None for name in bus.motors}


def arm_power_status(*, usb: bool, powered: bool, motors_ok: int, motors_total: int) -> str:
    if not usb:
        return "offline"
    if not powered:
        return "fail"
    if motors_ok < motors_total:
        return "warn"
    return "ok"


def camera_power_status(*, usb: bool, streaming: bool) -> str:
    if not usb:
        return "offline"
    if not streaming:
        return "fail"
    return "ok"


def aggregate_status(statuses: list[str]) -> str:
    order = {"fail": 0, "offline": 1, "warn": 2, "ok": 3}
    if not statuses:
        return "offline"
    return min(statuses, key=lambda s: order.get(s, 1))


def build_arm_power(
    *,
    role: str,
    port: str | None,
    usb: bool,
    powered: bool,
    motors_ok: int = 0,
    motors_total: int = 6,
    message: str | None = None,
) -> dict[str, Any]:
    status = arm_power_status(usb=usb, powered=powered, motors_ok=motors_ok, motors_total=motors_total)
    out: dict[str, Any] = {
        "role": role,
        "status": status,
        "port": port,
        "usb": usb,
        "powered": powered,
        "motors_ok": motors_ok,
        "motors_total": motors_total,
    }
    if message:
        out["message"] = message
    return out


def build_camera_power(
    *,
    name: str,
    index: int | None,
    usb: bool,
    streaming: bool,
    message: str | None = None,
) -> dict[str, Any]:
    status = camera_power_status(usb=usb, streaming=streaming)
    return {
        "name": name,
        "status": status,
        "index": index,
        "usb": usb,
        "streaming": streaming,
        **({"message": message} if message else {}),
    }


def probe_leader(port: str | None, arm_id: str = "leader") -> dict[str, Any]:
    usb = bool(port and os.path.exists(port))
    if not port:
        return build_arm_power(role="teleop", port=None, usb=False, powered=False, message="no port configured")
    if not usb:
        return build_arm_power(
            role="teleop",
            port=port,
            usb=False,
            powered=False,
            message="USB not seen — check cable and power brick",
        )
    try:
        from lerobot.teleoperators.so_leader import SO101Leader, SO101LeaderConfig

        arm = SO101Leader(SO101LeaderConfig(port=port, id=arm_id))
        arm.connect(calibrate=False)
        arm.disable_torque()
        motors = motor_probe(arm.bus)
        arm.disconnect()
        motors_ok = sum(motors.values())
        powered = motors_ok > 0
        msg = None
        if not powered:
            msg = "USB ok but no motors answered — check arm power supply"
        elif motors_ok < len(motors):
            msg = f"only {motors_ok}/{len(motors)} motors answered"
        return build_arm_power(
            role="teleop",
            port=port,
            usb=True,
            powered=powered,
            motors_ok=motors_ok,
            motors_total=len(motors),
            message=msg,
        )
    except Exception as err:  # noqa: BLE001
        return build_arm_power(
            role="teleop",
            port=port,
            usb=True,
            powered=False,
            message=str(err),
        )


def probe_follower(port: str | None, arm_id: str = "follower") -> dict[str, Any]:
    usb = bool(port and os.path.exists(port))
    if not port:
        return build_arm_power(role="follower", port=None, usb=False, powered=False, message="no port configured")
    if not usb:
        return build_arm_power(
            role="follower",
            port=port,
            usb=False,
            powered=False,
            message="USB not seen — check cable and power brick",
        )
    try:
        from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig

        arm = SO101Follower(SO101FollowerConfig(port=port, id=arm_id))
        arm.connect(calibrate=False)
        motors = motor_probe(arm.bus)
        arm.disconnect()
        motors_ok = sum(motors.values())
        powered = motors_ok > 0
        msg = None
        if not powered:
            msg = "USB ok but no motors answered — check arm power supply"
        elif motors_ok < len(motors):
            msg = f"only {motors_ok}/{len(motors)} motors answered"
        return build_arm_power(
            role="follower",
            port=port,
            usb=True,
            powered=powered,
            motors_ok=motors_ok,
            motors_total=len(motors),
            message=msg,
        )
    except Exception as err:  # noqa: BLE001
        return build_arm_power(
            role="follower",
            port=port,
            usb=True,
            powered=False,
            message=str(err),
        )


def probe_camera(name: str, index: int, width: int = 640, height: int = 480, fps: int = 30) -> dict[str, Any]:
    try:
        from lerobot.cameras.opencv import OpenCVCamera, OpenCVCameraConfig
        from lerobot.cameras.opencv.camera_opencv import OpenCVCamera as OpenCVCameraImpl

        visible = {int(info["id"]) for info in OpenCVCameraImpl.find_cameras()}
        usb = index in visible
        if not usb:
            hint = f"visible indices: {sorted(visible)}" if visible else "no cameras visible to OpenCV"
            return build_camera_power(
                name=name,
                index=index,
                usb=False,
                streaming=False,
                message=f"index {index} not found ({hint})",
            )
        cam = OpenCVCamera(OpenCVCameraConfig(index_or_path=index, width=width, height=height, fps=fps))
        cam.connect()
        frame = cam.read()
        cam.disconnect()
        streaming = frame is not None
        return build_camera_power(
            name=name,
            index=index,
            usb=True,
            streaming=streaming,
            message=None if streaming else "camera opens but returned no frame",
        )
    except Exception as err:  # noqa: BLE001
        return build_camera_power(name=name, index=index, usb=False, streaming=False, message=str(err))


def scan_all(
    *,
    teleop_port: str | None,
    robot_port: str | None,
    teleop_id: str = "leader",
    robot_id: str = "follower",
    cameras: dict[str, int] | None = None,
    width: int = 640,
    height: int = 480,
    fps: int = 30,
    mock: bool = False,
) -> dict[str, Any]:
    if mock:
        camera_meta = cameras or {"overhead": 0}
        teleop = build_arm_power(role="teleop", port="/dev/mock-leader", usb=True, powered=True, motors_ok=6)
        follower = build_arm_power(role="follower", port="/dev/mock-follower", usb=True, powered=True, motors_ok=6)
        cams = {
            name: build_camera_power(name=name, index=idx, usb=True, streaming=True)
            for name, idx in camera_meta.items()
        }
    else:
        teleop = probe_leader(teleop_port, teleop_id)
        follower = probe_follower(robot_port, robot_id)
        cams = {
            name: probe_camera(name, idx, width=width, height=height, fps=fps)
            for name, idx in (cameras or {}).items()
        }

    overall = aggregate_status([teleop["status"], follower["status"], *(c["status"] for c in cams.values())])
    return {
        "source": "health",
        "mock": mock,
        "status": overall,
        "teleop": teleop,
        "follower": follower,
        "cameras": cams,
        "ports_seen": list_serial_ports(),
    }
