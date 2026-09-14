"use client";

import type { Recorder } from "@/lib/use-recorder";

/**
 * Clean safety bar: immediate kill switch and re-arm controls.
 */
export default function SafetyBar({ recorder }: { recorder: Recorder }) {
  const { status, busy, send, error, dismissError } = recorder;

  if (!status || status.offline) return null;

  const estop = status.estop;

  async function stopTeleopAndRecord() {
    // The daemon refuses disengage while a take is open, so stop first.
    // `stop` parks the follower and opens the commit window; `save` writes it.
    let next = status;
    if (next?.state === "recording") {
      next = (await send("stop")) ?? next;
    }
    if (next?.state === "pending") {
      next = (await send("save")) ?? next;
    }
    if (next?.teleop?.engaged !== false) {
      await send("disengage");
    }
  }

  return (
    <section className={`panel safety ${estop.engaged ? "engaged" : ""}`}>
      <div className="inner safety-bar">
        {!estop.engaged ? (
          <button
            className="kill"
            disabled={busy}
            onClick={() => void stopTeleopAndRecord()}
            title="Stop teleop and save the current take"
          >
            <span className="glyph" aria-hidden>
              ⏻
            </span>
            Kill arms
          </button>
        ) : (
          <>
            <span className="safety-state">
              <strong>TORQUE OFF</strong>
              <span className="hint">
                {estop.reason || "operator"} · {estop.since_s.toFixed(0)}s ago
              </span>
            </span>
            <button className="verdict rearm" disabled={busy} onClick={() => void send("rearm")}>
              Re-arm arms
            </button>
          </>
        )}

        {error && (
          <button className="safety-error" onClick={dismissError} title="dismiss">
            {error}
          </button>
        )}
      </div>
    </section>
  );
}
