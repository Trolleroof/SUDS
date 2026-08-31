"use client";

import { useEffect } from "react";

import type { RecorderState } from "@/lib/api-types";
import type { Recorder } from "@/lib/use-recorder";

/**
 * Recording controls: one primary button plus whatever else applies right now.
 *
 *   idle       ● Record          -> start a take
 *   recording  ■ Stop            -> stop; frames stay in the writer's buffer
 *   pending    ⏎ Save now / ⌫ Delete take / ● Record next
 *
 * Nothing is written to disk until the commit window closes, so deleting a bad
 * take is instant and leaves no trace -- no parquet rewrite, no re-encode. Do
 * nothing and the take is kept, which is the right default for a button you are
 * hitting between attempts with a robot arm in your other hand.
 *
 * Every action is a button; the keys are a shortcut for the same commands, for
 * when both your hands are on the leader arm.
 */
export default function RecordBar({ recorder }: { recorder: Recorder }) {
  const { status, busy, send } = recorder;

  // Start/stop is also a keypress: while teleoperating you have a leader arm in
  // one hand and no attention to spare for finding a cursor.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (!status || status.offline || busy) return;

      const action = KEYS[event.key]?.(status.state);
      if (!action) return;
      event.preventDefault();
      void send(action as "record" | "stop" | "discard" | "save");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, busy, send]);

  if (!status) return null;

  if (status.offline) {
    return (
      <section className="panel recorder">
        <div className="inner label-bar">
          <span className="hint">
            recorder offline — start it with{" "}
            <code>python scripts/record_server.py --repo-id &lt;id&gt; --mock</code>
          </span>
        </div>
      </section>
    );
  }

  // Recording is not offered while the arms are dead or the geometry is being
  // rewritten underneath the dataset.
  if (status.state === "estopped" || status.state === "calibrating") {
    return (
      <section className={`panel recorder ${status.state}`}>
        <div className="inner label-bar">
          <span className="readout">recording paused</span>
          <span className="hint">
            {status.state === "estopped"
              ? "arms are e-stopped — re-arm to record again"
              : "finish or cancel the calibration to record again"}
          </span>
        </div>
      </section>
    );
  }

  const state = status.state;

  return (
    <section className={`panel recorder ${state}`}>
      <div className="inner label-bar">
        <button
          className={`record-btn ${state}`}
          disabled={busy || state === "saving"}
          // Not tabbable: otherwise Space would both fire the key handler and
          // activate the focused button, running the command twice.
          tabIndex={-1}
          onClick={() => {
            const action = PRIMARY[state];
            if (action) void send(action);
          }}
        >
          <span className="glyph">{GLYPH[state]}</span>
          {LABEL[state]}
          <span className="key">{KEY_HINT[state]}</span>
        </button>

        {state === "pending" && (
          <button className="verdict pass" tabIndex={-1} disabled={busy} onClick={() => void send("save")}>
            Save now <span className="key">⏎</span>
          </button>
        )}
        {(state === "recording" || state === "pending") && (
          <button className="verdict danger" tabIndex={-1} disabled={busy} onClick={() => void send("discard")}>
            Delete take <span className="key">⌫</span>
          </button>
        )}

        <span className="readout">
          {state === "recording" && (
            <>
              {status.elapsed_s.toFixed(1)}s · {status.frames} frames
            </>
          )}
          {state === "pending" && (
            <>
              {status.frames} frames · saving in {status.commit_in_s.toFixed(1)}s
            </>
          )}
          {state !== "recording" && state !== "pending" && status.message}
        </span>

        {state === "pending" && (
          <div className="commit-bar" aria-hidden>
            <div style={{ width: `${100 * (1 - status.commit_in_s / status.commit_seconds)}%` }} />
          </div>
        )}

        <span className="hint">
          {status.repo_id} · {status.saved_episodes} saved · {status.fps} fps · “{status.task}”
        </span>
      </div>
    </section>
  );
}

/**
 * Space toggles record/stop. Backspace throws the current take away -- during
 * the recording *or* inside the commit window, so a demo you can already see
 * going wrong does not have to be finished first. Enter commits early instead
 * of waiting the window out.
 */
const KEYS: Record<string, (state: RecorderState) => string | null> = {
  " ": (state) => (state === "idle" || state === "pending" ? "record" : state === "recording" ? "stop" : null),
  Backspace: (state) => (state === "recording" || state === "pending" ? "discard" : null),
  Enter: (state) => (state === "pending" ? "save" : null),
};

const PRIMARY: Partial<Record<RecorderState, "record" | "stop">> = {
  idle: "record",
  recording: "stop",
  pending: "record",
};

const LABEL: Record<RecorderState, string> = {
  idle: "Record",
  recording: "Stop",
  pending: "Record next",
  saving: "Encoding…",
  calibrating: "Calibrating",
  estopped: "Stopped",
};

const KEY_HINT: Record<RecorderState, string> = {
  idle: "space",
  recording: "space",
  pending: "space",
  saving: "",
  calibrating: "",
  estopped: "",
};

const GLYPH: Record<RecorderState, string> = {
  idle: "●",
  recording: "■",
  pending: "●",
  saving: "◌",
  calibrating: "⚙",
  estopped: "⏻",
};
