"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { ArmPower, CameraPower, HardwarePayload } from "@/lib/api-types";
import { useArmsConfig } from "@/lib/use-arms-config";
import type { Recorder } from "@/lib/use-recorder";

const DANGEROUS_TEMP_C = 65;
const WARN_TEMP_C = 55;

/** Compact USB + power indicators with motor temperature hover telemetry. */
export default function HealthPanel({ recorder }: { recorder: Recorder }) {
  const { ready: armsReady } = useArmsConfig();
  const [scan, setScan] = useState<HardwarePayload | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/health/status", { cache: "no-store" });
      const body = (await res.json()) as HardwarePayload & { error?: string };
      if (body.teleop) {
        setScan(body);
        setScanError(null);
        return;
      }
      setScan(null);
      setScanError(body.error ?? (res.ok ? null : "health check unavailable"));
    } catch {
      setScan(null);
      setScanError("health check unavailable");
    }
  }, []);

  // Sync ports from config/arms.json and start the health daemon when nothing else holds the arms.
  useEffect(() => {
    if (!armsReady) return;
    void fetch("/api/health/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
      .then(() => poll())
      .catch(() => poll());
  }, [armsReady, poll]);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => clearInterval(timer);
  }, [poll]);

  const live = recorder.status?.hardware;
  const recorderLive = Boolean(recorder.status && !recorder.status.offline && live?.teleop);
  const health: HardwarePayload = recorderLive
    ? { ...live!, source: "recorder" }
    : scan?.teleop
      ? scan
      : {
          source: "health",
          status: "offline",
          offline: true,
          teleop: offlineArm("teleop", scanError),
          follower: offlineArm("follower", scanError),
          cameras: {},
        };

  const cameras = useMemo(() => Object.values(health.cameras ?? {}), [health]);

  // Check for dangerous temperatures across both arms (>= 65°C)
  const overheatAlerts = useMemo(() => {
    const alerts: { arm: string; motor: string; temp: number }[] = [];
    for (const [armLabel, arm] of [
      ["Leader", health.teleop],
      ["Follower", health.follower],
    ] as const) {
      if (arm?.temperatures) {
        for (const [motor, temp] of Object.entries(arm.temperatures)) {
          if (temp >= DANGEROUS_TEMP_C) {
            alerts.push({ arm: armLabel, motor, temp });
          }
        }
      }
    }
    return alerts;
  }, [health]);

  return (
    <div className="power-panel-container">
      {overheatAlerts.length > 0 && (
        <div className="temp-danger-banner" role="alert">
          <span className="temp-danger-icon" aria-hidden>⚠️</span>
          <span>
            <strong>SERVO OVERHEAT DANGER:</strong>{" "}
            {overheatAlerts
              .map((a) => `${a.arm} ${a.motor} (${a.temp}°C)`)
              .join(", ")}{" "}
            exceeded {DANGEROUS_TEMP_C}°C threshold! Stop or cut torque to prevent permanent servo damage.
          </span>
        </div>
      )}
      <div className="power-strip" aria-label="Power and connection">
        <PowerPill label="Leader" arm={health.teleop} />
        <PowerPill label="Follower" arm={health.follower} />
        {cameras.map((c) => (
          <CameraPill key={c.name} camera={c} />
        ))}
      </div>
    </div>
  );
}

function PowerPill({ label, arm }: { label: string; arm: ArmPower }) {
  const [hovered, setHovered] = useState(false);
  const title = arm.message ?? pillTitle(arm);

  const temperatures = arm.temperatures ?? {};
  const tempEntries = Object.entries(temperatures);
  const maxTemp = arm.max_temperature ?? (tempEntries.length ? Math.max(...tempEntries.map(([, t]) => t)) : null);
  const isDangerous = maxTemp !== null && maxTemp >= DANGEROUS_TEMP_C;
  const isWarm = maxTemp !== null && maxTemp >= WARN_TEMP_C && !isDangerous;

  const pillClass = isDangerous
    ? "fail overheat"
    : isWarm
      ? "warn"
      : arm.status;

  return (
    <div
      className="power-pill-wrapper"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      tabIndex={0}
      role="region"
      aria-label={`${label} arm power and temperature metrics`}
    >
      <span className={`power-pill ${pillClass}`} title={title}>
        <span className={`dot ${isDangerous ? "fail overheat-pulse" : arm.status}`} aria-hidden />
        {label}: {isDangerous ? `${maxTemp}°C OVERHEAT` : arm.powered ? (maxTemp !== null ? `on (${maxTemp}°C)` : "on") : arm.usb ? "no power" : "offline"}
      </span>

      {hovered && (
        <div className="temp-hover-card" role="tooltip">
          <div className="temp-card-head">
            <span className="temp-card-title">{label} Arm Telemetry</span>
            {maxTemp !== null ? (
              <span className={`temp-badge ${isDangerous ? "danger" : isWarm ? "warn" : "ok"}`}>
                {isDangerous ? `⚠️ ${maxTemp}°C DANGER` : isWarm ? `⚡ ${maxTemp}°C Warm` : `✓ ${maxTemp}°C Normal`}
              </span>
            ) : (
              <span className="temp-badge offline">No Temp</span>
            )}
          </div>

          <div className="temp-card-sub">
            <span>Port: <code>{arm.port ?? "None"}</code></span>
            <span>Motors: {arm.motors_ok}/{arm.motors_total}</span>
          </div>

          {tempEntries.length > 0 ? (
            <div className="temp-grid">
              <div className="temp-grid-header">
                <span>Joint / Servo</span>
                <span>Temperature</span>
              </div>
              {tempEntries.map(([joint, temp]) => {
                const motorDanger = temp >= DANGEROUS_TEMP_C;
                const motorWarn = temp >= WARN_TEMP_C && !motorDanger;
                return (
                  <div key={joint} className={`temp-row ${motorDanger ? "danger" : motorWarn ? "warn" : "ok"}`}>
                    <span className="temp-motor-name">{joint}</span>
                    <span className="temp-motor-val-wrap">
                      <span className={`temp-motor-val ${motorDanger ? "danger" : motorWarn ? "warn" : "ok"}`}>
                        {temp}°C
                      </span>
                      <span className="temp-bar" aria-hidden>
                        <i
                          style={{
                            width: `${Math.min(100, (temp / 80) * 100)}%`,
                            backgroundColor: motorDanger ? "var(--fail)" : motorWarn ? "var(--warn)" : "var(--pass)",
                          }}
                        />
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="temp-empty">
              {arm.powered
                ? "Sampling motor temperatures…"
                : "Arm not powered — connect power to read temperatures."}
            </p>
          )}

          <div className="temp-card-foot">
            <span className="temp-legend">
              <span className="temp-legend-item"><i className="legend-dot ok" /> &lt;55°C Normal</span>
              <span className="temp-legend-item"><i className="legend-dot warn" /> 55–64°C Warm</span>
              <span className="temp-legend-item"><i className="legend-dot danger" /> ≥65°C Dangerous</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function CameraPill({ camera }: { camera: CameraPower }) {
  const title = camera.message ?? (camera.streaming ? `index ${camera.index}` : "not streaming");
  return (
    <span className={`power-pill ${camera.status}`} title={title}>
      <span className={`dot ${camera.status}`} aria-hidden />
      {camera.name}: {camera.streaming ? "on" : camera.usb ? "no signal" : "offline"}
    </span>
  );
}

function offlineArm(role: string, message: string | null): ArmPower {
  return {
    role,
    status: "offline",
    port: null,
    usb: false,
    powered: false,
    motors_ok: 0,
    motors_total: 6,
    temperatures: {},
    max_temperature: null,
    temperature_status: "ok",
    message: message ?? undefined,
  };
}

function pillTitle(arm: ArmPower): string {
  if (!arm.usb) return "Not plugged in";
  if (!arm.powered) return "USB ok — check power brick";
  return arm.port ?? "Powered";
}
