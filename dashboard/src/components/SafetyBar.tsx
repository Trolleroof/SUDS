"use client";

import { useMemo } from "react";

import type { Recorder } from "@/lib/use-recorder";

/**
 * The kill switch, and the number that tells you when to hit it.
 *
 * `delta` is per joint |leader commanded − follower measured|. A follower that
 * lags its leader by a couple of units through a fast move is normal; one that
 * sits 30 units behind is pushing against something it cannot move, and the
 * servos are heating up while it tries. That is the case this bar exists for.
 *
 * The stop is never disabled and never behind a confirmation — it is reachable
 * while saving, while calibrating, and while it is already engaged.
 */
export default function SafetyBar({ recorder }: { recorder: Recorder }) {
  const { status, busy, send, error, dismissError } = recorder;

  const joints = useMemo(() => Object.entries(status?.delta?.joints ?? {}), [status]);

  if (!status || status.offline) return null;

  const estop = status.estop;
  const delta = status.delta;
  const limit = delta?.limit ?? 0;
  const worst = delta?.max ?? 0;
  // Refused re-arms come back with this in the message; the second button is the
  // acknowledgement, not a retry.
  const needsForce = error?.includes("apart on") ?? false;

  return (
    <section className={`panel safety ${estop.engaged ? "engaged" : delta?.over ? "over" : ""}`}>
      <div className="inner safety-bar">
        <button
          className="kill"
          onClick={() => void send("estop", { reason: "operator" })}
          title="Cut servo torque on both arms immediately"
        >
          <span className="glyph" aria-hidden>
            ⏻
          </span>
          {estop.engaged ? "Kill again" : "Kill arms"}
        </button>

        {estop.engaged ? (
          <>
            <span className="safety-state">
              <strong>TORQUE OFF</strong>
              <span className="hint">
                {estop.reason} · {estop.since_s.toFixed(0)}s ago
              </span>
            </span>
            <button className="verdict rearm" disabled={busy} onClick={() => void send("rearm")}>
              Re-arm follower
            </button>
            {needsForce && (
              <button
                className="verdict danger"
                disabled={busy}
                onClick={() => {
                  dismissError();
                  void send("rearm", { force: true });
                }}
                title="The follower will snap to the leader's pose at full speed"
              >
                Re-arm anyway
              </button>
            )}
          </>
        ) : (
          <span className="safety-state">
            <strong className={delta?.over ? "bad" : "good"}>
              {delta?.over ? "TRACKING FAULT" : "tracking ok"}
            </strong>
            <span className="hint">
              worst {worst.toFixed(1)} / {limit.toFixed(0)}
              {delta?.max_joint ? ` · ${delta.max_joint}` : ""}
              {estop.auto ? " · auto-stop armed" : ""}
            </span>
          </span>
        )}

        {error && (
          <button className="safety-error" onClick={dismissError} title="dismiss">
            {error}
          </button>
        )}
      </div>

      <div className="delta-grid">
        {joints.length === 0 && <span className="hint">no joint readings yet</span>}
        {joints.map(([name, joint]) => (
          <article key={name} className={`delta-cell ${joint.delta > limit ? "bad" : ""}`}>
            <span className="delta-name">{name}</span>
            <span className="delta-nums">
              {joint.leader.toFixed(1)} → {joint.follower.toFixed(1)}
            </span>
            <span className="delta-value">{joint.delta.toFixed(1)}</span>
            <span className="delta-bar" aria-hidden>
              <i style={{ width: `${Math.min(100, (100 * joint.delta) / Math.max(limit, 1))}%` }} />
            </span>
          </article>
        ))}
      </div>
    </section>
  );
}
