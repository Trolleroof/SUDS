"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type RecorderStatus = {
  state: "idle" | "recording" | "pending" | "saving";
  repo_id: string;
  fps: number;
  task: string;
  frames: number;
  elapsed_s: number;
  commit_in_s: number;
  commit_seconds: number;
  saved_episodes: number;
  message: string;
  offline?: boolean;
};

/**
 * One button, three jobs.
 *
 *   idle       ● Record          -> start a take
 *   recording  ■ Stop            -> stop; frames stay in the writer's buffer
 *   pending    ⌫ Delete take     -> drop the buffer, for `commit_seconds`
 *
 * Nothing is written to disk until the commit window closes, so deleting a bad
 * take is instant and leaves no trace -- no parquet rewrite, no re-encode. Do
 * nothing and the take is kept, which is the right default for a button you are
 * hitting between attempts with a robot arm in your other hand.
 */
export default function RecordBar({
  onEpisodeSaved,
  onRepoId,
}: {
  onEpisodeSaved: () => void;
  /** Reported once the daemon answers, so the picker can follow it. */
  onRepoId: (repoId: string) => void;
}) {
  const [status, setStatus] = useState<RecorderStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const savedCount = useRef<number | null>(null);

  const poll = useCallback(async () => {
    const res = await fetch("/api/recorder/status", { cache: "no-store" });
    const body = await res.json();
    setStatus(res.ok ? (body as RecorderStatus) : { ...body, offline: true });

    // Refresh the episode list exactly when a take lands, not on a timer.
    if (res.ok) {
      const status = body as RecorderStatus;
      onRepoId(status.repo_id);
      if (savedCount.current !== null && status.saved_episodes > savedCount.current) onEpisodeSaved();
      savedCount.current = status.saved_episodes;
    }
  }, [onEpisodeSaved, onRepoId]);

  useEffect(() => {
    void poll();
    // 4 Hz: fast enough for a legible commit countdown, cheap enough to leave on.
    const timer = setInterval(() => void poll(), 250);
    return () => clearInterval(timer);
  }, [poll]);

  const send = useCallback(
    async (action: string) => {
      setBusy(true);
      try {
        await fetch(`/api/recorder/${action}`, { method: "POST" });
        await poll();
      } finally {
        setBusy(false);
      }
    },
    [poll],
  );

  // Start/stop is a keypress, not a click: while teleoperating you have a leader
  // arm in one hand and no attention to spare for finding a cursor. Space is the
  // only key that matters -- it toggles recording and nothing else.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (!status || status.offline || busy) return;

      const action = KEYS[event.key]?.(status.state);
      if (!action) return;
      event.preventDefault();
      void send(action);
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

  const action = NEXT_ACTION[status.state];

  return (
    <section className={`panel recorder ${status.state}`}>
      <div className="inner label-bar">
        <button
          className={`record-btn ${status.state}`}
          disabled={busy || status.state === "saving"}
          // Not tabbable: otherwise Space would both fire this handler and
          // activate the focused button, running the command twice.
          tabIndex={-1}
          onClick={() => action && void send(action)}
        >
          <span className="glyph">{GLYPH[status.state]}</span>
          {LABEL[status.state]}
          <span className="key">{KEY_HINT[status.state]}</span>
        </button>

        <span className="readout">
          {status.state === "recording" && (
            <>
              {status.elapsed_s.toFixed(1)}s · {status.frames} frames
            </>
          )}
          {status.state === "pending" && (
            <>
              {status.frames} frames · saving in {status.commit_in_s.toFixed(1)}s
            </>
          )}
          {status.state !== "recording" && status.state !== "pending" && status.message}
        </span>

        {status.state === "pending" && (
          <div className="commit-bar" aria-hidden>
            <div style={{ width: `${100 * (1 - status.commit_in_s / status.commit_seconds)}%` }} />
          </div>
        )}

        <span className="hint">
          space record/stop · ⌫ delete take · ⏎ save now
        </span>
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
const KEYS: Record<string, (state: RecorderStatus["state"]) => string | null> = {
  " ": (state) => (state === "idle" || state === "pending" ? "record" : state === "recording" ? "stop" : null),
  Backspace: (state) => (state === "recording" || state === "pending" ? "discard" : null),
  Enter: (state) => (state === "pending" ? "save" : null),
};

const NEXT_ACTION: Record<RecorderStatus["state"], string | null> = {
  idle: "record",
  recording: "stop",
  pending: "discard",
  saving: null,
};

const LABEL: Record<RecorderStatus["state"], string> = {
  idle: "Record",
  recording: "Stop",
  pending: "Delete take",
  saving: "Encoding…",
};

const KEY_HINT: Record<RecorderStatus["state"], string> = {
  idle: "space",
  recording: "space",
  pending: "⌫",
  saving: "",
};

const GLYPH: Record<RecorderStatus["state"], string> = {
  idle: "●",
  recording: "■",
  pending: "⌫",
  saving: "◌",
};
