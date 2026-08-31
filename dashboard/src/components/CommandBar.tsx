"use client";

import { useCallback, useEffect, useState } from "react";

import {
  knownRoleForPort,
  readStoredSetup,
  reconcileArmPorts,
  resolveArmPorts,
  shortPort,
  writeStoredSetup,
  type ArmRole,
} from "@/lib/arm-ports";
import { useArmsConfig } from "@/lib/use-arms-config";

type CameraState = { name: string; index: number; streaming: boolean; error: string | null };

type ProcStatus = {
  name: string;
  running: boolean;
  pid: number | null;
  uptime_s: number;
  log: string[];
  exit: { code: number | null; signal: string | null } | null;
  cameras?: CameraState[];
};

type Config = {
  robotPort: string | null;
  teleopPort: string | null;
  robotId: string;
  teleopId: string;
  cameras: { name: string; index: number }[];
};

const EMPTY: Config = {
  robotPort: null,
  teleopPort: null,
  robotId: "follower",
  teleopId: "leader",
  cameras: [],
};

export default function CommandBar({ recorderRunning }: { recorderRunning: boolean }) {
  const { configured, ready: armsReady } = useArmsConfig();
  const [config, setConfig] = useState<Config>(EMPTY);
  const [teleop, setTeleop] = useState<ProcStatus | null>(null);
  const [cameras, setCameras] = useState<ProcStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [showLog, setShowLog] = useState<string | null>(null);
  const [ports, setPorts] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [identifying, setIdentifying] = useState(false);
  const [identified, setIdentified] = useState<string | null>(null);
  const [identifyNote, setIdentifyNote] = useState<string | null>(null);
  const [portWarning, setPortWarning] = useState<string | null>(null);

  // Permanent ports from config/arms.json — no rescan required on load.
  useEffect(() => {
    if (!armsReady) return;
    setConfig((prev) => {
      const stored = readStoredSetup();
      const merged = resolveArmPorts(
        { teleopPort: (stored.teleopPort as string | null) ?? null, robotPort: (stored.robotPort as string | null) ?? null },
        configured,
      );
      return { ...prev, teleopPort: merged.teleopPort, robotPort: merged.robotPort };
    });
    setPorts([configured.teleopPort, configured.robotPort].filter(Boolean) as string[]);
  }, [armsReady, configured]);

  const scanPorts = useCallback(async () => {
    setScanning(true);
    setPortWarning(null);
    try {
      const res = await fetch("/api/daemon/scan", { cache: "no-store" });
      if (!res.ok) return;
      const found = ((await res.json()) as { ports: string[] }).ports ?? [];
      setPorts(found);
      const { ports: next, changed, missing } = reconcileArmPorts(found, configured);
      setConfig((prev) => {
        const out = { ...prev, ...next };
        writeStoredSetup(out);
        return out;
      });
      if (missing.length && !changed) {
        setPortWarning(
          `Expected ${missing.map((p) => shortPort(p)).join(", ")} not found — plug in arms or update config/arms.json`,
        );
      } else if (changed) {
        setPortWarning("USB names changed — updated ports from scan (save config/arms.json to keep)");
      }
    } finally {
      setScanning(false);
    }
  }, [configured]);

  const runIdentify = useCallback(async () => {
    setIdentifying(true);
    setIdentified(null);
    setIdentifyNote("Move one arm by hand — watching both ports for 6 seconds…");
    try {
      const res = await fetch("/api/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ports, seconds: 6 }),
      });
      const body = await res.json();
      if (!res.ok || body.ok === false) {
        setIdentifyNote(body.error ?? "Identification failed");
        return;
      }
      if (body.ambiguous) {
        setIdentifyNote("Both ports moved — hold one arm still and try again");
      } else if (body.moved_port) {
        const moved = body.moved_port as string;
        setIdentified(moved);
        const role = knownRoleForPort(moved);
        if (role) {
          setConfig((prev) => {
            const patch = role === "leader" ? { teleopPort: moved } : { robotPort: moved };
            const next = { ...prev, ...patch };
            writeStoredSetup(next);
            return next;
          });
          setIdentifyNote(`That is the ${role} (${shortPort(moved)})`);
        } else {
          setIdentifyNote(`Movement on ${shortPort(moved)} — assign Leader or Follower below`);
        }
      } else {
        const dead = (body.ports as { port: string; connected: boolean }[]).filter((p) => !p.connected);
        setIdentifyNote(
          dead.length
            ? `No movement — ${dead.length} port did not answer (check power)`
            : "No movement seen — move a joint further",
        );
      }
    } finally {
      setIdentifying(false);
    }
  }, [ports]);

  const pick = useCallback(
    (role: ArmRole, port: string) => {
      setConfig((prev) => {
        const which = role === "leader" ? "teleopPort" : "robotPort";
        const other = role === "leader" ? "robotPort" : "teleopPort";
        const next = { ...prev, [which]: port };
        if (next[other] === port) next[other] = null;
        writeStoredSetup(next);
        return next;
      });
    },
    [],
  );

  const poll = useCallback(async () => {
    try {
      const stored = readStoredSetup();
      setConfig((prev) => ({
        ...prev,
        ...resolveArmPorts(
          {
            teleopPort: prev.teleopPort ?? (stored.teleopPort as string | null) ?? null,
            robotPort: prev.robotPort ?? (stored.robotPort as string | null) ?? null,
          },
          configured,
        ),
        robotId: "follower",
        teleopId: "leader",
        cameras: (stored.cameras as Config["cameras"]) ?? prev.cameras,
      }));
    } catch {
      /* storage refused */
    }

    for (const [name, set] of [
      ["teleop", setTeleop],
      ["cameras", setCameras],
    ] as const) {
      try {
        const res = await fetch(`/api/run/${name}`, { cache: "no-store" });
        if (res.ok) set((await res.json()) as ProcStatus);
      } catch {
        /* transient */
      }
    }
  }, [configured]);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => clearInterval(timer);
  }, [poll]);

  const run = useCallback(
    async (name: "teleop" | "cameras", action: "start" | "stop") => {
      setBusy(name);
      setError(null);
      try {
        const res = await fetch(`/api/run/${name}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, config }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body?.ok === false) {
          setError(body?.error ?? `Could not ${action} ${name}`);
          setBusyName(name);
        } else {
          setError(null);
          setBusyName(null);
        }
      } finally {
        setBusy(null);
        void poll();
      }
    },
    [config, poll],
  );

  const rows: { name: "teleop" | "cameras"; label: string; status: ProcStatus | null; detail: string }[] = [
    {
      name: "teleop",
      label: "Teleop",
      status: teleop,
      detail: config.teleopPort
        ? `Leader on ${shortPort(config.teleopPort)} → follower on ${config.robotPort ? shortPort(config.robotPort) : "?"}`
        : "Assign leader and follower below, or open Setup",
    },
    {
      name: "cameras",
      label: "Cameras",
      status: cameras,
      detail: config.cameras.map((c) => `${c.name}=${c.index}`).join(" ") || "Set cameras in Setup",
    },
  ];

  return (
    <section className="panel">
      <h2>Quick commands</h2>
      <div className="inner">
        <div className="arm-slots">
          {(["leader", "follower"] as ArmRole[]).map((role) => (
            <ArmSlot
              key={role}
              role={role}
              port={role === "leader" ? config.teleopPort : config.robotPort}
              ports={ports}
              identified={identified}
              onPick={(port) => pick(role, port)}
            />
          ))}
          <div className="arm-slot-actions">
            <button className="chip" disabled={scanning} onClick={() => void scanPorts()}>
              {scanning ? "Scanning…" : "Rescan"}
            </button>
            <button
              className="verdict"
              disabled={identifying || ports.length === 0}
              onClick={() => void runIdentify()}
              title="Move one arm — detects which USB port it is on"
            >
              {identifying ? "Watching…" : "Which moved?"}
            </button>
          </div>
        </div>
        {identifyNote && (
          <p className={`identify-note ${identifying ? "busy" : identified ? "found" : ""}`}>{identifyNote}</p>
        )}
        {portWarning && <p className="identify-note">{portWarning}</p>}

        {rows.map((row) => {
          const running = Boolean(row.status?.running);
          const blocked = recorderRunning && !running;
          return (
            <div className="label-bar cmd-row" key={row.name}>
              <button
                className={`verdict ${running ? "danger" : "pass"} big`}
                disabled={busy === row.name || blocked}
                onClick={() => void run(row.name, running ? "stop" : "start")}
              >
                {busy === row.name ? "…" : running ? `Stop ${row.label.toLowerCase()}` : `Start ${row.label.toLowerCase()}`}
              </button>
              <span className={`daemon-pill ${running ? "up" : "down"}`}>
                <span className="dot" aria-hidden />
                {running ? `running · pid ${row.status?.pid}` : "stopped"}
              </span>
              <span className="hint">
                {blocked
                  ? "Stop the recorder first — it uses the same ports"
                  : row.status?.exit && row.status.exit.code !== 0 && !running
                    ? `Exited with code ${row.status.exit.code}`
                    : row.detail}
              </span>
              <button
                className="chip"
                onClick={() => setShowLog((current) => (current === row.name ? null : row.name))}
              >
                {showLog === row.name ? "Hide log" : "Log"}
              </button>
              {error && busyName === row.name && <span className="cmd-error">{error}</span>}
            </div>
          );
        })}

        {showLog && (
          <pre className="daemon-log">
            {(showLog === "teleop" ? teleop : cameras)?.log.join("\n") || "No output yet"}
          </pre>
        )}

        {cameras?.running && (
          <div className="cmd-cams">
            {(cameras.cameras ?? config.cameras.map((c) => ({ ...c, streaming: false, error: null }))).map(
              (camera) => (
                <figure className="live-card" key={camera.name}>
                  <figcaption>
                    <span className={`dot ${camera.streaming ? "ok" : "fail"}`} aria-hidden />
                    <span className="cam">
                      {camera.name} · index {camera.index}
                    </span>
                  </figcaption>
                  {camera.streaming ? (
                    /* eslint-disable-next-line @next/next/no-img-element -- MJPEG */
                    <img
                      className="live-frame"
                      alt={`${camera.name} camera`}
                      src={`/api/camera/${encodeURIComponent(camera.name)}`}
                    />
                  ) : (
                    <div className="live-frame placeholder">
                      <span>{camera.error ? "Camera stopped" : "Waiting for frames…"}</span>
                      {camera.error && <span className="cmd-cam-error">{camera.error}</span>}
                    </div>
                  )}
                </figure>
              ),
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function ArmSlot({
  role,
  port,
  ports,
  identified,
  onPick,
}: {
  role: ArmRole;
  port: string | null;
  ports: string[];
  identified: string | null;
  onPick: (port: string) => void;
}) {
  const label = role === "leader" ? "Leader" : "Follower";
  const known = port ? knownRoleForPort(port) : null;
  const mismatch = known && known !== role;

  return (
    <article className={`arm-slot ${port ? "assigned" : ""} ${identified === port ? "found" : ""}`}>
      <header>
        <strong>{label}</strong>
        {port ? (
          <code title={port}>{shortPort(port)}</code>
        ) : (
          <span className="hint">Not assigned</span>
        )}
      </header>
      {mismatch && (
        <p className="arm-slot-warn">Serial usually maps to {known} — double-check assignment</p>
      )}
      <div className="arm-slot-picks">
        {ports.length === 0 && <span className="hint">Plug in and rescan</span>}
        {ports.map((candidate) => (
          <button
            key={candidate}
            type="button"
            className={`chip ${port === candidate ? "on" : ""}`}
            aria-pressed={port === candidate}
            onClick={() => onPick(candidate)}
          >
            {shortPort(candidate)}
          </button>
        ))}
      </div>
    </article>
  );
}
