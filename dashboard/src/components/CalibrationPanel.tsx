"use client";

import type { Recorder } from "@/lib/use-recorder";

/**
 * Recalibration, as three buttons instead of three terminal prompts.
 *
 * LeRobot's `calibrate()` is a straight line through two `input()` calls: centre
 * the arm, then sweep every joint while it streams encoder counts. Those pauses
 * are the two phases below. The daemon keeps sampling between them, so the
 * "swept" ticks fill in live as you move the arm — which is the part the
 * terminal version makes you infer from a scrolling table.
 *
 * Calibration is per arm and is written both to the servos and to
 * `~/.cache/huggingface/lerobot/calibration/…/<id>.json`, so it survives a
 * restart. Cancelling puts the previous calibration back.
 */
export default function CalibrationPanel({ recorder }: { recorder: Recorder }) {
  const { status, busy, send } = recorder;
  if (!status || status.offline) return null;

  const calibration = status.calibration;
  const idle = status.state === "idle";

  if (!calibration) {
    return (
      <section className="panel calib">
        <h2>calibration</h2>
        <div className="inner label-bar">
          <button className="verdict" disabled={!idle || busy} onClick={() => void send("calibrate_start", { arm: "teleop" })}>
            Recalibrate leader
          </button>
          <button
            className="verdict"
            disabled={!idle || busy}
            onClick={() => void send("calibrate_start", { arm: "follower" })}
          >
            Recalibrate follower
          </button>
          <span className="hint">
            {idle
              ? "takes about a minute per arm · the arm goes limp while you do it"
              : `unavailable while ${status.state}`}
          </span>
        </div>
      </section>
    );
  }

  const joints = Object.entries(calibration.joints);

  return (
    <section className="panel calib active">
      <h2>calibrating {calibration.arm}</h2>
      <div className="inner">
        <div className="label-bar">
          {calibration.phase === "home" ? (
            <>
              <button className="verdict pass" disabled={busy} onClick={() => void send("calibrate_home")}>
                Set home position
              </button>
              <span className="hint">
                torque is off — move the arm to the middle of every joint&apos;s travel, then press this
              </span>
            </>
          ) : (
            <>
              <button
                className="verdict pass"
                disabled={busy || !calibration.can_finish}
                onClick={() => void send("calibrate_finish")}
              >
                Save calibration
              </button>
              <span className="hint">
                {calibration.can_finish
                  ? "every joint has been moved — save when you are done"
                  : `still to move: ${calibration.unswept.join(", ")}`}
              </span>
            </>
          )}
          <button className="verdict danger" disabled={busy} onClick={() => void send("calibrate_cancel")}>
            Cancel
          </button>
        </div>

        {calibration.phase === "range" && (
          <div className="calib-grid">
            {joints.map(([name, joint]) => (
              <article key={name} className={`calib-cell ${joint.swept ? "swept" : ""}`}>
                <span className="calib-name">
                  {joint.swept ? "✓" : "○"} {name}
                </span>
                <span className="calib-nums">
                  {joint.min} … {joint.max}
                </span>
                {/* Raw encoder counts, 0–4095 over one turn. */}
                <span className="calib-bar" aria-hidden>
                  <i
                    style={{
                      left: `${(100 * joint.min) / 4095}%`,
                      width: `${Math.max(1, (100 * (joint.max - joint.min)) / 4095)}%`,
                    }}
                  />
                  <b style={{ left: `${(100 * joint.pos) / 4095}%` }} />
                </span>
              </article>
            ))}
            <p className="hint calib-note">
              wrist_roll turns freely, so its range is not swept — it is written as the full 0–4095 turn.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
