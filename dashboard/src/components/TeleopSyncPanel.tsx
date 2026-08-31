"use client";

import { useMemo } from "react";

import type { RecorderAction } from "@/lib/api-types";
import type { Recorder } from "@/lib/use-recorder";

/**
 * Bringing the two arms together, and then deliberately connecting them.
 *
 * The daemon comes up *observing*: it reads both arms and publishes the delta,
 * but drives nothing. That is on purpose — engaging a follower that disagrees
 * with the leader makes it travel to the leader's pose at whatever speed the
 * servos can manage, and at startup the two are wherever they were left.
 *
 * So the operator's job before recording is to null the delta by hand, and this
 * panel is the readout for that: per joint, how far the *leader* has to move for
 * the follower to match, signed, because "12 units out" without a direction is
 * two guesses. Once every joint is inside the limit the daemon reports ready and
 * Engage lights up.
 */

// Both endpoints are new on the daemon and are not in the shared `RecorderAction`
// union yet; the cast is the seam until they land there.
const ENGAGE = "engage" as unknown as RecorderAction;
const DISENGAGE = "disengage" as unknown as RecorderAction;

/** `teleop` in the daemon's status payload; not yet in the shared api-types. */
type TeleopSync = {
  engaged: boolean;
  /** Whether the arms agree closely enough that engaging will not snap. */
  ready: boolean;
  worst: number;
  worst_joint: string | null;
};

export default function TeleopSyncPanel({ recorder }: { recorder: Recorder }) {
  const { status, busy, send, error, dismissError } = recorder;

  const teleop = (status as unknown as { teleop?: TeleopSync } | null)?.teleop;

  // Follower minus leader, signed: the amount the leader must travel to meet a
  // follower that is standing still. Worst joint first — that is the one the
  // operator has to fix, and it is the one the daemon will refuse on.
  const joints = useMemo(
    () =>
      Object.entries(status?.delta?.joints ?? {})
        .map(([name, joint]) => ({ name, ...joint, signed: joint.follower - joint.leader }))
        .sort((a, b) => b.delta - a.delta),
    [status],
  );

  if (!status || status.offline || !teleop) return null;

  const limit = status.delta?.limit ?? 0;
  // Refused engages come back with this in the message; the second button is the
  // acknowledgement, not a retry.
  const needsForce = error?.includes("engage anyway") ?? false;

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
              ? "the follower is tracking the leader"
              : "reading both arms · the follower is not being driven"}
          </span>
        </span>

        <span className="readout">
          worst {teleop.worst.toFixed(1)} / {limit.toFixed(0)}
          {teleop.worst_joint ? ` · ${teleop.worst_joint}` : ""}
        </span>

        {teleop.engaged ? (
          <button className="verdict" disabled={busy || recording} onClick={() => void send(DISENGAGE)}>
            Disengage
          </button>
        ) : (
          <button
            className={`verdict ${teleop.ready ? "pass" : ""}`}
            disabled={busy || !teleop.ready}
            onClick={() => void send(ENGAGE)}
            title={
              teleop.ready
                ? "Hand the follower to the leader"
                : "The arms are too far apart to connect safely"
            }
          >
            Engage teleop
          </button>
        )}

        {!teleop.engaged && needsForce && (
          <button
            className="verdict danger"
            disabled={busy}
            onClick={() => {
              dismissError();
              void send(ENGAGE, { force: true });
            }}
            title="The follower will snap to the leader's pose at full speed"
          >
            Engage anyway
          </button>
        )}

        {!teleop.engaged && !teleop.ready && (
          <span className="chip">
            {teleop.worst_joint
              ? `${teleop.worst_joint} is ${teleop.worst.toFixed(1)} out — move the arms together`
              : "waiting for a reading from both arms"}
          </span>
        )}
        {teleop.engaged && recording && <span className="chip">stop the take before disengaging</span>}

        {error && (
          <button className="chip" onClick={dismissError} title="dismiss">
            {error}
          </button>
        )}
      </div>

      {!teleop.engaged && (
        <div className="inner">
          <span className="hint">Move the leader by these amounts to meet the follower:</span>
          <div className="delta-grid">
            {joints.length === 0 && <span className="hint">no joint readings yet</span>}
            {joints.map((joint) => (
              <article key={joint.name} className={`delta-cell ${joint.delta > limit ? "bad" : ""}`}>
                <span className="delta-name">{joint.name}</span>
                <span className="delta-nums">
                  {joint.leader.toFixed(1)} → {joint.follower.toFixed(1)}
                </span>
                <span className="delta-value">
                  {joint.signed >= 0 ? "+" : "−"}
                  {Math.abs(joint.signed).toFixed(1)}
                </span>
                <span className="delta-bar" aria-hidden>
                  <i style={{ width: `${Math.min(100, (100 * joint.delta) / Math.max(limit, 1))}%` }} />
                </span>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
