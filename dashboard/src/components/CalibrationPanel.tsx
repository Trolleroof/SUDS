"use client";

import { useCallback, useEffect, useState } from "react";

import { readStoredSetup, resolveArmPorts, shortPort } from "@/lib/arm-ports";
import { useArmsConfig } from "@/lib/use-arms-config";

/**
 * Recalibration, as buttons instead of terminal prompts.
 *
 * This drives LeRobot's own `lerobot-calibrate` -- the exact command you would
 * type -- through /api/calibrate. That CLI is a straight line through two
 * blocking reads on stdin: centre the arm, then sweep every joint while it
 * streams encoder counts. Those pauses are the two phases below, and the
 * counts it streams become the live grid, so the "swept" ticks fill in while
 * you are still holding the arm -- which is the part the terminal version makes
 * you infer from a table scrolling past.
 *
 * The panel is also readable when nothing is running, and that is the more
 * important half. A follower whose joints "go everywhere" is a follower whose
 * saved ranges are too narrow: a joint that was never really swept gets a range
 * of a few hundred counts, and every later command against it is scaled up to
 * fill that range. Those joints are flagged here, from the calibration file on
 * disk, before you power anything on.
 */

type Joint = { name: string; min: number; pos: number; max: number };

type SavedJoint = {
  name: string;
  homing_offset: number;
  range_min: number;
  range_max: number;
  suspect: boolean;
};

type SavedCalibration = {
  role: Role;
  id: string;
  path: string;
  exists: boolean;
  modified: number | null;
  joints: SavedJoint[];
  suspect: string[];
};

type Phase = "idle" | "starting" | "confirm" | "home" | "range" | "saving" | "done" | "failed";

type Status = {
  running: boolean;
  role: Role | null;
  phase: Phase;
  joints: Joint[];
  unswept: string[];
  canFinish: boolean;
  message: string;
  error: string | null;
  log: string[];
  command: string | null;
  savedTo: string | null;
  saved: { leader: SavedCalibration; follower: SavedCalibration };
};

type Role = "leader" | "follower";

/** One turn of an STS3215 is 4096 encoder counts; every range is drawn on that. */
const TURN = 4095;

export default function CalibrationPanel({ recorderOnline }: { recorderOnline: boolean }) {
  const { configured } = useArmsConfig();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/calibrate/status", { cache: "no-store" });
      if (res.ok) setStatus((await res.json()) as Status);
    } catch {
      /* transient */
    }
  }, []);

  // Fast while the live table is streaming, lazy when it is only showing what
  // is already on disk.
  useEffect(() => {
    void poll();
    const active = status?.running ?? false;
    const timer = setInterval(() => void poll(), active ? 400 : 3000);
    return () => clearInterval(timer);
  }, [poll, status?.running]);

  const post = useCallback(
    async (action: "start" | "advance" | "cancel", body: Record<string, unknown> = {}) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/calibrate/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok || payload?.ok === false) setError(payload?.error ?? `could not ${action}`);
      } finally {
        setBusy(false);
        void poll();
      }
    },
    [poll],
  );

  // Resolved exactly as Quick commands resolves them -- config/arms.json,
  // overridden by anything reassigned by hand -- so calibration uses the
  // assignment already on screen rather than asking for it a second time.
  const armPorts = useCallback(() => {
    const setup = readStoredSetup();
    const stored = {
      teleopPort: (setup.teleopPort as string | null) ?? null,
      robotPort: (setup.robotPort as string | null) ?? null,
    };
    const { teleopPort, robotPort } = resolveArmPorts(stored, configured);
    return { leader: teleopPort, follower: robotPort };
  }, [configured]);

  const begin = useCallback(
    (role: Role) => {
      void post("start", {
        role,
        ports: armPorts(),
        ids: { leader: "leader", follower: "follower" },
      });
    },
    [post, armPorts],
  );

  if (!status) return null;

  const active = status.running;
  const ports = armPorts();

  return (
    <section className={`panel calib ${active ? "active" : ""}`}>
      <h2>Calibration</h2>
      <div className="inner">
        {active ? (
          <Wizard status={status} busy={busy} onAdvance={() => void post("advance")} onCancel={() => void post("cancel")} />
        ) : (
          <div className="calib-arms">
            {(["leader", "follower"] as Role[]).map((role) => (
              <ArmCalibration
                key={role}
                role={role}
                saved={status.saved[role]}
                port={ports[role]}
                busy={busy}
                blocked={recorderOnline}
                onRecalibrate={() => begin(role)}
              />
            ))}
          </div>
        )}

        {(error || (!active && status.error)) && <p className="calib-error">{error ?? status.error}</p>}
        {!active && status.phase === "done" && status.savedTo && (
          <p className="hint">Saved to {status.savedTo}</p>
        )}

        {status.command && (
          <div className="calib-cmd">
            <button className="chip" onClick={() => setShowLog((open) => !open)}>
              {showLog ? "Hide log" : "Log"}
            </button>
            <code title={status.command}>{status.command}</code>
          </div>
        )}
        {showLog && <pre className="daemon-log">{status.log.join("\n") || "No output yet"}</pre>}
      </div>
    </section>
  );
}

/** What is on disk for one arm, plus the button that replaces it. */
function ArmCalibration({
  role,
  saved,
  port,
  busy,
  blocked,
  onRecalibrate,
}: {
  role: Role;
  saved: SavedCalibration;
  port: string | null;
  busy: boolean;
  blocked: boolean;
  onRecalibrate: () => void;
}) {
  const bad = saved.suspect.length > 0;
  const label = role === "leader" ? "Leader" : "Follower";

  return (
    <article className={`calib-arm ${bad ? "suspect" : saved.exists ? "ok" : ""}`}>
      <header>
        <strong>{label}</strong>
        {port ? <code title={port}>{shortPort(port)}</code> : <span className="hint">no port assigned</span>}
      </header>

      <p className={`calib-verdict ${bad ? "bad" : saved.exists ? "good" : "none"}`}>
        {!saved.exists
          ? "Never calibrated — the arm will refuse to connect until you do."
          : bad
            ? `${saved.suspect.join(", ")} barely moved during the last calibration. ` +
              "A range that narrow makes small commands swing the joint through its whole travel — recalibrate."
            : "Calibrated. Every joint has a full range of travel."}
      </p>

      {saved.exists && (
        <div className="calib-grid">
          {saved.joints.map((joint) => (
            <article key={joint.name} className={`calib-cell ${joint.suspect ? "bad" : "swept"}`}>
              <span className="calib-name">
                {joint.suspect ? "!" : "✓"} {joint.name}
              </span>
              <span className="calib-nums">
                {joint.range_min} … {joint.range_max}
                <em> ({joint.range_max - joint.range_min})</em>
              </span>
              <Span min={joint.range_min} max={joint.range_max} />
            </article>
          ))}
        </div>
      )}

      <div className="label-bar">
        <button className="verdict" disabled={busy || blocked || !port} onClick={onRecalibrate}>
          Recalibrate {role}
        </button>
        <span className="hint">
          {blocked
            ? "stop the recorder first — it holds both arm ports"
            : !port
              ? "assign this arm a port in Quick commands"
              : "about a minute · the arm goes limp while you do it"}
        </span>
      </div>
    </article>
  );
}

/** The two prompts `lerobot-calibrate` blocks on, one button each. */
function Wizard({
  status,
  busy,
  onAdvance,
  onCancel,
}: {
  status: Status;
  busy: boolean;
  onAdvance: () => void;
  onCancel: () => void;
}) {
  const { phase, joints, unswept, canFinish } = status;
  const waiting = phase === "starting" || phase === "confirm" || phase === "saving";

  return (
    <>
      <div className="label-bar">
        {phase === "home" && (
          <button className="verdict pass" disabled={busy} onClick={onAdvance}>
            Set home position
          </button>
        )}
        {phase === "range" && (
          <button className="verdict pass" disabled={busy || !canFinish} onClick={onAdvance}>
            Save calibration
          </button>
        )}
        {waiting && <span className="readout">{phase === "saving" ? "Saving…" : "Starting…"}</span>}

        <span className="hint">
          {phase === "range" && !canFinish
            ? `still to sweep: ${unswept.length ? unswept.join(", ") : "waiting for the first reading"}`
            : status.message}
        </span>

        <button className="verdict danger" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>

      {phase === "range" && (
        <div className="calib-grid">
          {joints.map((joint) => {
            const swept = !unswept.includes(joint.name);
            return (
              <article key={joint.name} className={`calib-cell ${swept ? "swept" : ""}`}>
                <span className="calib-name">
                  {swept ? "✓" : "○"} {joint.name}
                </span>
                <span className="calib-nums">
                  {joint.min} … {joint.max}
                  <em> ({joint.max - joint.min})</em>
                </span>
                <Span min={joint.min} max={joint.max} pos={joint.pos} />
              </article>
            );
          })}
          <p className="hint calib-note">
            wrist_roll turns freely, so it is never swept — LeRobot writes it as the full 0–4095 turn.
          </p>
        </div>
      )}
    </>
  );
}

/** Raw encoder counts drawn against one full turn, so a stunted range looks it. */
function Span({ min, max, pos }: { min: number; max: number; pos?: number }) {
  return (
    <span className="calib-bar" aria-hidden>
      <i
        style={{
          left: `${(100 * min) / TURN}%`,
          width: `${Math.max(1, (100 * (max - min)) / TURN)}%`,
        }}
      />
      {pos !== undefined && <b style={{ left: `${(100 * pos) / TURN}%` }} />}
    </span>
  );
}
