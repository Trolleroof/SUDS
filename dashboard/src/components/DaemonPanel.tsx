"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { CameraSpec, DaemonConfig } from "@/lib/daemon";

type DaemonStatus = {
  running: boolean;
  pid: number | null;
  uptime_s: number;
  config: DaemonConfig | null;
  log: string[];
  exit: { code: number | null; signal: string | null; at: number } | null;
};

type Scan = { ports: string[]; cameras: { index: number; name: string }[]; scanned_cameras: boolean };

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
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [scan, setScan] = useState<Scan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [config, setConfig] = useState<DaemonConfig | null>(null);

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
    if (config || !status) return;
    setConfig(
      status.config ?? {
        repoId: repoId || "suds/dev",
        task: "pick up the sponge",
        fps: 30,
        mock: true,
        robotPort: null,
        teleopPort: null,
        cameras: (datasetCameras.length ? datasetCameras : ["third_person", "wrist"]).map((name, i) => ({
          name,
          index: i,
        })),
        deltaLimit: 25,
        autoEstop: false,
        commitSeconds: 6,
      },
    );
  }, [config, status, repoId, datasetCameras]);

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
    try {
      const res = await fetch("/api/daemon/scan", { cache: "no-store" });
      setScan((await res.json()) as Scan);
    } finally {
      setScanning(false);
    }
  }, []);

  if (!status || !config) return null;

  const patch = (fields: Partial<DaemonConfig>) => setConfig({ ...config, ...fields });
  const setCamera = (at: number, fields: Partial<CameraSpec>) =>
    patch({ cameras: config.cameras.map((camera, i) => (i === at ? { ...camera, ...fields } : camera)) });

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

        {external ? (
          <span className="hint">
            started outside this dashboard — stop it in its own terminal (ctrl-C) to manage it from here
          </span>
        ) : status.running ? (
          <>
            <button className="verdict danger" disabled={busy} onClick={() => void post("stop")}>
              Stop recorder
            </button>
            <button className="verdict" disabled={busy} onClick={() => void post("restart")}>
              Restart
            </button>
          </>
        ) : (
          <button className="verdict pass big" disabled={busy} onClick={() => void post("start", config)}>
            {busy ? "Starting…" : "Start recorder"}
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
            ? `pid ${status.pid} · up ${status.uptime_s.toFixed(0)}s · ${config.mock ? "mock" : "hardware"}`
            : external
              ? "port is in use"
              : status.exit
                ? `last exit code ${status.exit.code ?? "—"}${status.exit.signal ? ` (${status.exit.signal})` : ""}`
                : "not started from here"}
        </span>
      </div>

      {error && (
        <p className="daemon-error">
          {error}
          <button className="chip" onClick={() => setError(null)}>
            dismiss
          </button>
        </p>
      )}

      {showConfig && (
        <div className="inner daemon-config">
          <div className="cfg-row">
            <span className="cfg-label">source</span>
            <button className="chip wide" aria-pressed={config.mock} onClick={() => patch({ mock: true })}>
              mock — no hardware
            </button>
            <button className="chip wide" aria-pressed={!config.mock} onClick={() => patch({ mock: false })}>
              real arms
            </button>
            <button className="verdict" disabled={scanning || status.running} onClick={() => void rescan()}>
              {scanning ? "Scanning…" : "Scan hardware"}
            </button>
            {status.running && <span className="hint">stop the recorder to scan — it holds the cameras</span>}
          </div>

          <div className="cfg-row">
            <span className="cfg-label">dataset</span>
            <input
              className="notes"
              value={config.repoId}
              onChange={(e) => patch({ repoId: e.target.value })}
              placeholder="namespace/name"
            />
            <button className="chip" disabled={!repoId} onClick={() => patch({ repoId })}>
              use {repoId || "selected"}
            </button>
            <span className="cfg-label">task</span>
            <input className="notes" value={config.task} onChange={(e) => patch({ task: e.target.value })} />
          </div>

          {!config.mock && (
            <>
              <PortRow
                label="leader (teleop)"
                ports={scan?.ports ?? []}
                value={config.teleopPort}
                onPick={(port) => patch({ teleopPort: port })}
              />
              <PortRow
                label="follower"
                ports={scan?.ports ?? []}
                value={config.robotPort}
                onPick={(port) => patch({ robotPort: port })}
              />
            </>
          )}

          <div className="cfg-row cameras">
            <span className="cfg-label">cameras</span>
            <div className="camera-list">
              {config.cameras.map((camera, at) => (
                <div className="camera-row" key={at}>
                  <input
                    className="notes narrow"
                    value={camera.name}
                    onChange={(e) => setCamera(at, { name: e.target.value })}
                  />
                  <span className="hint">index</span>
                  {(scan?.cameras.length ? scan.cameras.map((c) => c.index) : [0, 1, 2, 3]).map((index) => (
                    <button
                      key={index}
                      className="chip"
                      aria-pressed={camera.index === index}
                      onClick={() => setCamera(at, { index })}
                    >
                      {index}
                    </button>
                  ))}
                  <button
                    className="chip"
                    onClick={() => patch({ cameras: config.cameras.filter((_, i) => i !== at) })}
                  >
                    remove
                  </button>
                </div>
              ))}
              <div className="camera-row">
                <button
                  className="verdict"
                  onClick={() =>
                    patch({
                      cameras: [...config.cameras, { name: `camera_${config.cameras.length + 1}`, index: config.cameras.length }],
                    })
                  }
                >
                  Add camera
                </button>
                {datasetCameras.length > 0 && (
                  <button
                    className="chip"
                    onClick={() =>
                      patch({ cameras: datasetCameras.map((name, i) => ({ name, index: config.cameras[i]?.index ?? i })) })
                    }
                  >
                    match {repoId}
                  </button>
                )}
                {scan && scan.cameras.length > 0 && (
                  <span className="hint">
                    detected: {scan.cameras.map((c) => `${c.index}${c.name ? ` ${c.name}` : ""}`).join(" · ")}
                  </span>
                )}
              </div>
            </div>
          </div>

          {mismatch && (
            <p className="daemon-warn">
              {repoId} was recorded with {datasetCameras.join(", ")} — a dataset&apos;s camera names are fixed, so
              the daemon will refuse to resume it under different ones. Press “match {repoId}”, or record into a new
              dataset.
            </p>
          )}

          <div className="cfg-row">
            <span className="cfg-label">safety</span>
            <NumberField label="delta limit" value={config.deltaLimit} onChange={(v) => patch({ deltaLimit: v })} />
            <button
              className="chip wide"
              aria-pressed={config.autoEstop}
              onClick={() => patch({ autoEstop: !config.autoEstop })}
            >
              auto-stop {config.autoEstop ? "on" : "off"}
            </button>
            <NumberField label="fps" value={config.fps} onChange={(v) => patch({ fps: v })} />
            <NumberField
              label="commit seconds"
              value={config.commitSeconds}
              onChange={(v) => patch({ commitSeconds: v })}
            />
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
  onPick,
}: {
  label: string;
  ports: string[];
  value: string | null;
  onPick: (port: string) => void;
}) {
  return (
    <div className="cfg-row">
      <span className="cfg-label">{label}</span>
      {ports.length === 0 && <span className="hint">press “Scan hardware” to list USB serial ports</span>}
      {ports.map((port) => (
        <button key={port} className="chip wide" aria-pressed={value === port} onClick={() => onPick(port)}>
          {port.replace("/dev/", "")}
        </button>
      ))}
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
