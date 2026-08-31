"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { ArmPower, CameraPower, HardwarePayload, HardwareStatus } from "@/lib/api-types";
import type { Recorder } from "@/lib/use-recorder";

/**
 * USB + power checks for teleop, follower, and cameras.
 *
 * The recorder holds the arms open and so always has the fresher answer; the
 * standalone health daemon is the fallback for when it is not running.
 */
export default function HealthPanel({ recorder }: { recorder: Recorder }) {
  const [scan, setScan] = useState<HardwarePayload | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/health/status", { cache: "no-store" });
      setScan(res.ok ? ((await res.json()) as HardwarePayload) : null);
    } catch {
      setScan(null);
    }
  }, []);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => clearInterval(timer);
  }, [poll]);

  const live = recorder.status?.hardware;
  const health: HardwarePayload = live?.teleop
    ? { ...live, source: "recorder" }
    : scan && !scan.offline
      ? scan
      : {
          source: "health",
          status: "offline",
          offline: true,
          teleop: offlineArm("teleop"),
          follower: offlineArm("follower"),
          cameras: {},
          ports_seen: [],
          error: scan?.error ?? "start health_server.py to scan for power",
        };

  const cameras = useMemo(() => Object.values(health.cameras ?? {}), [health]);

  return (
    <section className="health panel" aria-label="Power and connection">
      <div className="health-head">
        <h2>Power &amp; connection</h2>
        <span className={`health-overall ${health.status}`}>
          {STATUS_LABEL[health.status]}
        </span>
        <span className="hint">
          {health.source === "recorder" ? "live · recorder" : health.mock ? "mock" : health.offline ? "offline" : "scanning"}
        </span>
      </div>
      <div className="health-grid">
        <PowerCard label="Teleop (leader)" arm={health.teleop} />
        <PowerCard label="Follower" arm={health.follower} />
        {cameras.length === 0 && <CameraPowerCard camera={offlineCamera("overhead")} />}
        {cameras.map((camera) => (
          <CameraPowerCard key={camera.name} camera={camera} />
        ))}
      </div>
      {health.ports_seen && health.ports_seen.length > 0 && (
        <p className="health-hint">
          USB serial ports seen: {health.ports_seen.join(", ")}
        </p>
      )}
      {health.offline && (
        <p className="health-hint">
          Run{" "}
          <code>
            python scripts/health_server.py --teleop-port /dev/tty.usbmodem… --robot-port /dev/tty.usbmodem…
          </code>{" "}
          to check whether the arms are plugged in and powered. Use <code>--mock</code> to test the panel without
          hardware.
        </p>
      )}
    </section>
  );
}

function PowerCard({ label, arm }: { label: string; arm: ArmPower }) {
  return (
    <article className={`health-card ${arm.status}`}>
      <header>
        <span className={`dot ${arm.status}`} aria-hidden />
        <strong>{label}</strong>
      </header>
      <ul className="power-rows">
        <PowerRow label="USB" ok={arm.usb} okText="plugged in" badText="not plugged in" />
        <PowerRow label="Power" ok={arm.powered} okText="motors responding" badText="no motor response" />
      </ul>
      <p className="health-detail">{detailForArm(arm)}</p>
    </article>
  );
}

function CameraPowerCard({ camera }: { camera: CameraPower }) {
  return (
    <article className={`health-card ${camera.status}`}>
      <header>
        <span className={`dot ${camera.status}`} aria-hidden />
        <strong>Camera · {camera.name}</strong>
      </header>
      <ul className="power-rows">
        <PowerRow label="USB" ok={camera.usb} okText="detected" badText="not detected" />
        <PowerRow label="Video" ok={camera.streaming} okText="streaming" badText="no signal" />
      </ul>
      <p className="health-detail">{detailForCamera(camera)}</p>
    </article>
  );
}

function PowerRow({
  label,
  ok,
  okText,
  badText,
}: {
  label: string;
  ok: boolean;
  okText: string;
  badText: string;
}) {
  return (
    <li className={ok ? "on" : "off"}>
      <span className="power-label">{label}</span>
      <span className="power-state">{ok ? okText : badText}</span>
    </li>
  );
}

function offlineArm(role: string): ArmPower {
  return {
    role,
    status: "offline",
    port: null,
    usb: false,
    powered: false,
    motors_ok: 0,
    motors_total: 6,
  };
}

function offlineCamera(name: string): CameraPower {
  return { name, status: "offline", index: null, usb: false, streaming: false };
}

function detailForArm(arm: ArmPower): string {
  if (arm.message) return arm.message;
  if (!arm.usb) return arm.port ? `${arm.port} not found` : "configure --teleop-port / --robot-port";
  if (!arm.powered) return "USB is up but servos are not answering — check the arm power brick";
  if (arm.motors_ok < arm.motors_total) return `${arm.motors_ok}/${arm.motors_total} motors answered`;
  return arm.port ? `powered on ${arm.port}` : "powered";
}

function detailForCamera(camera: CameraPower): string {
  if (camera.message) return camera.message;
  if (!camera.usb) return camera.index != null ? `index ${camera.index} not visible` : "not configured";
  if (!camera.streaming) return "camera is plugged in but not delivering frames";
  return camera.index != null ? `ok at index ${camera.index}` : "ok";
}

const STATUS_LABEL: Record<HardwareStatus, string> = {
  ok: "all powered",
  warn: "partial",
  fail: "check power",
  offline: "offline",
};
