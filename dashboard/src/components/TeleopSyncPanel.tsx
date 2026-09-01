"use client";

import type { RecorderAction } from "@/lib/api-types";
import type { Recorder } from "@/lib/use-recorder";

const ENGAGE = "engage" as unknown as RecorderAction;
const DISENGAGE = "disengage" as unknown as RecorderAction;

type TeleopSync = {
  engaged: boolean;
  ready: boolean;
  worst: number;
  worst_joint: string | null;
};

export default function TeleopSyncPanel({ recorder }: { recorder: Recorder }) {
  const { status, busy, send, error, dismissError } = recorder;

  const teleop = (status as unknown as { teleop?: TeleopSync } | null)?.teleop;

  if (!status || status.offline || !teleop) return null;

  if (status.state === "estopped") {
    return (
      <section className="panel">
        <div className="inner label-bar">
          <span className="safety-state">
            <strong className="bad">TELEOP OFFLINE</strong>
            <span className="hint">the arms are e-stopped — re-arm before engaging teleop</span>
          </span>
        </div>
      </section>
    );
  }

  if (status.state === "calibrating") {
    return (
      <section className="panel">
        <div className="inner label-bar">
          <span className="safety-state">
            <strong>TELEOP HELD</strong>
            <span className="hint">
              calibrating {status.calibration?.arm ?? "an arm"} — teleop stays observing until it is done
            </span>
          </span>
        </div>
      </section>
    );
  }

  const recording = status.state === "recording";

  return (
    <section className="panel">
      <div className="inner label-bar">
        <span className={`dot ${teleop.engaged ? "ok" : "warn"}`} aria-hidden />
        <span className="safety-state">
          <strong className={teleop.engaged ? "good" : "bad"}>
            {teleop.engaged ? "ENGAGED" : "OBSERVING"}
          </strong>
          <span className="hint">
            {teleop.engaged
              ? "follower tracking leader"
              : "arms unlinked · click Engage or Record to sync"}
          </span>
        </span>

        {teleop.engaged ? (
          <button className="verdict" disabled={busy || recording} onClick={() => void send(DISENGAGE)}>
            Disengage
          </button>
        ) : (
          <button
            className="verdict pass"
            disabled={busy}
            onClick={() => void send(ENGAGE)}
            title="Sync and link the follower to the leader"
          >
            Engage teleop
          </button>
        )}

        {error && (
          <button className="chip" onClick={dismissError} title="dismiss">
            {error}
          </button>
        )}
      </div>
    </section>
  );
}
