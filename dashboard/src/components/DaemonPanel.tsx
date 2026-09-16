"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { CameraSpec, DaemonConfig } from "@/lib/daemon";
import {
  DEFAULT_ARM_PORTS,
  readStoredSetup,
  reconcileArmPorts,
  resolveArmPorts,
  shortPort,
} from "@/lib/arm-ports";
import { resolveCameras, sortCamerasForDisplay } from "@/lib/camera-ports";
import { useArmsConfig } from "@/lib/use-arms-config";
import { useCamerasConfig } from "@/lib/use-cameras-config";

type DaemonStatus = {
  running: boolean;
  pid: number | null;
  uptime_s: number;
  config: DaemonConfig | null;
  log: string[];
  exit: { code: number | null; signal: string | null; at: number } | null;
};

type Scan = { ports: string[]; cameras: { index: number; name: string }[]; scanned_cameras: boolean };

const JOINT_BY_ID: Record<number, string> = {
  1: "shoulder_pan",
  2: "shoulder_lift",
  3: "elbow_flex",
  4: "wrist_flex",
  5: "wrist_roll",
  6: "gripper",
};

/** Last traceback line is often just `{1: 777, …}` — the found-motors dump. */
function daemonExitHint(log: string[]): string {
  const port = log.map((line) => /motor check failed on port '([^']+)'/.exec(line)?.[1]).find(Boolean);
  const missing: number[] = [];
  for (const line of log) {
    const hit = /-\s*(\d+)\s*\(expected model/.exec(line);
    if (hit) missing.push(Number(hit[1]));
  }
  if (missing.length) {
    const named = missing.map((id) => JOINT_BY_ID[id] ?? `motor ${id}`).join(" and ");
    const where = port ? ` on ${shortPort(port)}` : "";
    return `${named} did not answer${where} — check the daisy-chain into that joint`;
  }
  return log.filter((line) => !line.startsWith("—")).at(-1) ?? "unknown error";
}

/** The parts of /api/calibrate/status this panel needs: is each arm usable. */
type CalibrationSummary = Record<"leader" | "follower", { exists: boolean; suspect: string[] }>;

/**
 * Start and stop the recorder daemon from the dashboard.
 *
 * Everything the daemon takes on its command line is a control here: which
 * dataset, which serial port is which arm, which camera index is the
 * third-person view and which is the wrist. Ports and camera indices are
 * discovered rather than typed, because on macOS `/dev/tty.usbmodem*` names
 * change between reboots and a wrong index is the single most common way to
 * lose an afternoon.
 *
 * Camera *names* are not free choice once a dataset exists: an existing
 * LeRobotDataset has a fixed schema, so the names are prefilled from whatever
 * the selected dataset was recorded with, and the daemon refuses to start on a
 * mismatch rather than failing one Record press later.
 */
export default function DaemonPanel({
  repoId,
  videoKeys,
  recorderOnline,
  onChanged,
}: {
  repoId: string;
  videoKeys: string[];
  /** True when something is answering on the recorder port, whoever started it. */
  recorderOnline: boolean;
  onChanged: () => void;
}) {
  const { configured, ready: armsReady } = useArmsConfig();
  const { configured: cameraDefaults, ready: camerasReady } = useCamerasConfig();
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [scan, setScan] = useState<Scan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [portWarning, setPortWarning] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [config, setConfig] = useState<DaemonConfig | null>(null);
  const [calibration, setCalibration] = useState<CalibrationSummary | null>(null);

  // Read once the setup dialog opens: this is the last screen before the arms
  // are driven, so it is the right place to find out they are not calibrated.
  useEffect(() => {
    if (!showConfig) return;
    void fetch("/api/calibrate/status", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => setCalibration(body?.saved ?? null))
      .catch(() => setCalibration(null));
  }, [showConfig]);

  const datasetCameras = useMemo(
    () => videoKeys.map((key) => key.replace("observation.images.", "")),
    [videoKeys],
  );

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/daemon/status", { cache: "no-store" });
      if (res.ok) setStatus((await res.json()) as DaemonStatus);
    } catch {
      /* the dashboard itself is what serves this; a failure here is transient */
    }
  }, []);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => clearInterval(timer);
  }, [poll]);

  // Seed the form from the last run if there is one, otherwise from the dataset
  // on screen — so the common case is "press Start".
  useEffect(() => {
    if (config || !status || !armsReady || !camerasReady) return;
    const stored = readStoredSetup();
    const ports = resolveArmPorts(
      {
        teleopPort: (stored.teleopPort as string | null) ?? null,
        robotPort: (stored.robotPort as string | null) ?? null,
      },
      configured,
    );
    const storedTask = String(stored.task ?? "").trim();
    const datasetCams = (datasetCameras.length ? datasetCameras : cameraDefaults.map((c) => c.name)).map((name, i) => ({
      name,
      index: cameraDefaults.find((camera) => camera.name === name)?.index ?? i,
    }));
    const cameras = cameraDefaults.length ? cameraDefaults : resolveCameras(stored.cameras as CameraSpec[], datasetCams);
    setConfig(
      status.config ?? {
        repoId: (stored.repoId as string) || repoId || "suds/live",
        task:
          !storedTask || storedTask === "pick up the sponge" || storedTask === "pick up block"
            ? "pick up the yellow sponge"
            : storedTask,
        fps: (stored.fps as number) || 30,
        robotPort: ports.robotPort ?? DEFAULT_ARM_PORTS.robotPort,
        teleopPort: ports.teleopPort ?? DEFAULT_ARM_PORTS.teleopPort,
        cameras,
        deltaLimit: (stored.deltaLimit as number) ?? 25,
        autoEstop: (stored.autoEstop as boolean) ?? false,
        engageOnStart: false,
        commitSeconds: (stored.commitSeconds as number) ?? 6,
      },
    );
  }, [config, status, repoId, datasetCameras, armsReady, camerasReady, configured, cameraDefaults]);

  // Cameras are locked to config/cameras.json.
  useEffect(() => {
    if (!config || !camerasReady || !cameraDefaults.length) return;
    const same =
      config.cameras.length === cameraDefaults.length &&
      config.cameras.every((camera, i) => camera.name === cameraDefaults[i]?.name && camera.index === cameraDefaults[i]?.index);
    if (same) return;
    setConfig({ ...config, cameras: cameraDefaults });
  }, [config, camerasReady, cameraDefaults]);

  const post = useCallback(
    async (action: "start" | "stop" | "restart", body?: unknown) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/daemon/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
        const payload = await res.json().catch(() => ({}));
        if (payload?.running !== undefined) setStatus(payload as DaemonStatus);
        if (!res.ok || payload?.ok === false) {
          setError(payload?.error ?? `${action} failed`);
          setShowLog(true);
          return false;
        }
        onChanged();
        return true;
      } finally {
        setBusy(false);
        void poll();
      }
    },
    [onChanged, poll],
  );

  const rescan = useCallback(async () => {
    setScanning(true);
    setPortWarning(null);
    try {
      const res = await fetch("/api/daemon/scan", { cache: "no-store" });
      const body = (await res.json()) as Scan;
      setScan(body);
      const found = body.ports ?? [];
      const { ports: next, changed, missing } = reconcileArmPorts(found, configured);
      setConfig((prev) => {
        if (!prev) return prev;
        const merged = resolveArmPorts(
          { teleopPort: prev.teleopPort, robotPort: prev.robotPort },
          next,
        );
        return { ...prev, ...merged };
      });
      if (missing.length && !changed) {
        setPortWarning(
          `Expected ${missing.map((p) => shortPort(p)).join(", ")} not found — plug in arms or edit config/arms.json`,
        );
      } else if (changed) {
        setPortWarning("USB names changed — updated from scan (edit config/arms.json to make permanent)");
      }
    } finally {
      setScanning(false);
    }
  }, [configured]);

  // Ports load from config/arms.json; rescan is manual (USB or cameras).

  // The quick-command buttons need the same ports and cameras this dialog picks,
  // and they are used before the recorder has ever been started -- so the
  // selection is remembered here rather than only reaching the server on Start.
  useEffect(() => {
    if (!config) return;
    try {
      window.localStorage.setItem("suds.setup", JSON.stringify(config));
    } catch {
      /* private windows refuse storage; the buttons just fall back to a scan */
    }
  }, [config]);

  if (!status || !config) return null;

  const patch = (fields: Partial<DaemonConfig>) => setConfig({ ...config, ...fields });

  // An arm with no calibration file is not a warning either: `robot.connect()`
  // calibrates when it finds none, and calibrating blocks on `input()` -- so
  // the daemon would sit there forever, silent, with the port already taken.
  const uncalibrated = (["leader", "follower"] as const).filter((role) => calibration && !calibration[role].exists);
  const narrow = (["leader", "follower"] as const).flatMap((role) =>
    calibration?.[role].suspect.map((joint) => `${role} ${joint}`) ?? [],
  );

  const mismatch =
    datasetCameras.length > 0 &&
    config.repoId === repoId &&
    JSON.stringify([...config.cameras.map((c) => c.name)].sort()) !== JSON.stringify([...datasetCameras].sort());

  // A daemon started from a terminal owns the port but is not ours to stop:
  // offering Start would just crash the new process on an address in use.
  const external = !status.running && recorderOnline;

  return (
    <section className={`panel daemon ${status.running || external ? "up" : "down"}`}>
      <div className="inner label-bar">
        <span className={`daemon-pill ${status.running || external ? "up" : "down"}`}>
          <span className="dot" aria-hidden />
          {status.running ? "recorder running" : external ? "recorder running elsewhere" : "recorder stopped"}
        </span>

        {external && (
          <span className="hint">
            started outside this dashboard — stop it in its own terminal (ctrl-C) to manage it from here
          </span>
        )}
        {status.running && !external && (
          <button className="chip" disabled={busy} onClick={() => void post("stop")} title="Shut down the daemon (Record starts it)">
            Shut down
          </button>
        )}

        <button className="verdict" aria-pressed={showConfig} onClick={() => setShowConfig((on) => !on)}>
          {showConfig ? "Hide setup" : "Setup"}
        </button>
        <button className="verdict" aria-pressed={showLog} onClick={() => setShowLog((on) => !on)}>
          {showLog ? "Hide log" : "Log"}
        </button>

        <span className="hint">
          {status.running
            ? `pid ${status.pid} · up ${status.uptime_s.toFixed(0)}s`
            : external
              ? "port is in use"
              : status.exit
                ? `last exit code ${status.exit.code ?? "—"}${status.exit.signal ? ` (${status.exit.signal})` : ""}`
                : "not started from here"}
        </span>
      </div>

      {!status.running && status.exit && status.exit.code !== 0 && status.log.length > 1 && (
        <p className="daemon-error">
          exited ({status.exit.code}): {daemonExitHint(status.log)}
        </p>
      )}

      {error && (
        <p className="daemon-error">
          {error}
          <button className="chip" onClick={() => setError(null)}>
            dismiss
          </button>
        </p>
      )}

      {showConfig && (
        <div className="modal-scrim" role="dialog" aria-modal aria-label="Recorder setup" onClick={(e) => {
          if (e.target === e.currentTarget) setShowConfig(false);
        }}>
        <div className="modal">
        <div className="modal-head">
          <h2>Recorder setup</h2>
          <button className="chip" onClick={() => setShowConfig(false)}>
            close
          </button>
        </div>
        <div className="inner daemon-config">
          <div className="setup-row">
            <span className="setup-label">Hardware</span>
            <div className="setup-fields">
              <button className="verdict" disabled={scanning || status.running} onClick={() => void rescan()}>
                {scanning ? "Scanning…" : "Scan hardware"}
              </button>
              {portWarning && <span className="hint">{portWarning}</span>}
              {status.running && <span className="hint">Stop the recorder first — it holds the cameras.</span>}
            </div>
          </div>

          <div className="setup-row">
            <span className="setup-label">Dataset</span>
            <div className="setup-fields">
              <input
                className="notes setup-input"
                value={config.repoId}
                onChange={(e) => patch({ repoId: e.target.value })}
                placeholder="namespace/name"
              />
              <button className="chip" disabled={!repoId} onClick={() => patch({ repoId })}>
                use {repoId || "selected"}
              </button>
            </div>
          </div>

          <div className="setup-row">
            <span className="setup-label">Task</span>
            <div className="setup-fields">
              <input className="notes setup-input wide" value={config.task} onChange={(e) => patch({ task: e.target.value })} />
            </div>
          </div>

          <PortRow
            label="Leader"
            ports={scan?.ports ?? []}
            value={config.teleopPort}
            taken={config.robotPort}
            onPick={(port) => patch({ teleopPort: port })}
          />
          <PortRow
            label="Follower"
            ports={scan?.ports ?? []}
            value={config.robotPort}
            taken={config.teleopPort}
            onPick={(port) => patch({ robotPort: port })}
          />

          <div className="setup-row setup-row-top">
            <span className="setup-label">Cameras</span>
            <div className="camera-list">
              {sortCamerasForDisplay(config.cameras, (camera) => camera.name).map((camera) => (
                <div className="camera-row locked" key={camera.name}>
                  <span className="camera-name-locked">{camera.name}</span>
                  <span className="slot-badge">index {camera.index}</span>
                  <div className="camera-preview-slot">
                    <CameraThumb index={camera.index} enabled={!status.running} auto={false} />
                  </div>
                </div>
              ))}
              <p className="hint">Locked — wrist on top (index 1), overhead below (index 0)</p>
            </div>
          </div>

          {uncalibrated.length > 0 && (
            <p className="daemon-warn">
              The {uncalibrated.join(" and ")} {uncalibrated.length === 1 ? "has" : "have"} never been calibrated.
              The daemon calibrates on connect, and calibrating waits on a terminal prompt it has no way to answer —
              it would hang holding the port. Calibrate from the Calibration panel first.
            </p>
          )}
          {uncalibrated.length === 0 && narrow.length > 0 && (
            <p className="daemon-warn">
              {narrow.join(", ")} {narrow.length === 1 ? "has" : "have"} almost no range in the saved calibration,
              so commands to {narrow.length === 1 ? "it" : "them"} are scaled up to fill it — this is what makes a
              follower joint swing to its limit. Recalibrate before recording.
            </p>
          )}

          {mismatch && (
            <p className="daemon-warn">
              {repoId} was recorded with {datasetCameras.join(", ")} — a dataset&apos;s camera names are fixed, so
              the daemon will refuse to resume it under different ones. Press “match {repoId}”, or record into a new
              dataset.
            </p>
          )}

          <div className="setup-row">
            <span className="setup-label">Safety</span>
            <div className="setup-fields setup-fields-wrap">
              <NumberField label="Delta limit" value={config.deltaLimit} onChange={(v) => patch({ deltaLimit: v })} />
              <button
                className="chip wide"
                aria-pressed={config.autoEstop}
                onClick={() => patch({ autoEstop: !config.autoEstop })}
              >
                Auto-stop {config.autoEstop ? "on" : "off"}
              </button>
              <button
                className="chip wide"
                aria-pressed={config.engageOnStart}
                onClick={() => patch({ engageOnStart: !config.engageOnStart })}
                title="Hand the follower to the leader as soon as the daemon is up"
              >
                Teleop on start {config.engageOnStart ? "on" : "off"}
              </button>
            </div>
          </div>

          <div className="setup-row">
            <span className="setup-label">Timing</span>
            <div className="setup-fields setup-fields-wrap">
              <NumberField label="FPS" value={config.fps} onChange={(v) => patch({ fps: v })} />
              <NumberField
                label="Commit (s)"
                value={config.commitSeconds}
                onChange={(v) => patch({ commitSeconds: v })}
              />
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <span className="hint">
            {status.running
              ? "the recorder is already running — stop it to apply changes"
              : uncalibrated.length
                ? `${uncalibrated.join(" and ")} not calibrated`
                : mismatch
                ? `camera names do not match ${repoId}`
                : `${config.cameras.length} camera${config.cameras.length === 1 ? "" : "s"} · Record starts teleop, waits for sync, then records`}
          </span>
          <button className="verdict" onClick={() => setShowConfig(false)}>
            Cancel
          </button>
          <button
            className="verdict pass big"
            onClick={() => setShowConfig(false)}
            disabled={uncalibrated.length > 0}
          >
            {busy ? "Starting…" : "Done"}
          </button>
        </div>
        </div>
        </div>
      )}

      {showLog && (
        <pre className="daemon-log">{status.log.length ? status.log.join("\n") : "no output yet"}</pre>
      )}
    </section>
  );
}

function PortRow({
  label,
  ports,
  value,
  taken,
  onPick,
}: {
  label: string;
  ports: string[];
  value: string | null;
  /** The port the other arm is on, which this one cannot also be. */
  taken: string | null;
  onPick: (port: string) => void;
}) {
  return (
    <div className="setup-row">
      <span className="setup-label">{label}</span>
      <div className="setup-fields setup-fields-wrap">
        {ports.length === 0 && <span className="hint">Scan hardware to list USB ports.</span>}
        {ports.map((port) => (
          <button
            key={port}
            className="chip wide"
            aria-pressed={value === port}
            disabled={taken === port}
            title={taken === port ? "Already assigned to the other arm" : undefined}
            onClick={() => onPick(port)}
          >
            {port.replace("/dev/", "")}
          </button>
        ))}
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="cfg-number">
      <span className="hint">{label}</span>
      <input
        className="notes narrow"
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

/**
 * One frame from a camera index, fetched on demand.
 *
 * "OpenCV Camera @ 2" tells you nothing about which physical camera it is, and
 * picking the wrong index is how you record an afternoon of the ceiling. The
 * grab spawns a short-lived Python process, so it is deliberately not automatic
 * and not while the recorder holds the devices.
 */
function CameraThumb({ index, enabled, auto = false }: { index: number; enabled: boolean; auto?: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");

  const grab = useCallback(async () => {
    setState("loading");
    try {
      const res = await fetch(`/api/daemon/preview?index=${index}`, { cache: "no-store" });
      if (!res.ok) throw new Error("no frame");
      const blob = await res.blob();
      setSrc((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return URL.createObjectURL(blob);
      });
      setState("idle");
    } catch {
      setState("failed");
    }
  }, [index]);

  useEffect(() => {
    setSrc((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
    setState("idle");
    if (auto && enabled) void grab();
  }, [index, auto, enabled, grab]);

  useEffect(() => () => {
    if (src) URL.revokeObjectURL(src);
  }, [src]);

  if (!enabled) return <span className="camera-thumb muted">Live while recording</span>;
  if (src) {
    /* eslint-disable-next-line @next/next/no-img-element -- blob URL from daemon preview */
    return <img className="camera-thumb" src={src} alt={`Camera ${index}`} onClick={() => void grab()} title="Refresh preview" />;
  }
  return (
    <button type="button" className="camera-thumb camera-thumb-btn" onClick={() => void grab()} disabled={state === "loading"}>
      {state === "loading" ? "…" : state === "failed" ? "Retry" : "Preview"}
    </button>
  );
}
