"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { RecorderAction, RecorderStatus } from "./api-types";

export type Recorder = {
  status: RecorderStatus | null;
  /** Set while a command is in flight, so buttons can disable themselves. */
  busy: boolean;
  /** Last command the daemon refused, e.g. "not moved yet: wrist_flex". */
  error: string | null;
  dismissError: () => void;
  send: (action: RecorderAction, payload?: Record<string, unknown>) => Promise<boolean>;
};

const OFFLINE: RecorderStatus = {
  state: "idle",
  repo_id: "",
  fps: 0,
  task: "",
  frames: 0,
  elapsed_s: 0,
  commit_in_s: 0,
  commit_seconds: 0,
  saved_episodes: 0,
  message: "",
  cameras: [],
  estop: { engaged: false, reason: "", since_s: 0, auto: false },
  delta: { joints: {}, max: 0, max_joint: null, limit: 0, over: false, over_ticks: 0 },
  calibration: null,
  offline: true,
};

/**
 * One websocket to the recorder daemon, shared by every panel that needs it.
 *
 * This used to be a 4 Hz poll per panel. The request count was not really the
 * problem -- localhost JSON is cheap. The problem was that a poll against a
 * daemon that is *not running* is a failed request every 250 ms for as long as
 * the tab is open, which buries anything else in the server log. A socket that
 * will not open is one failed connect and a backoff.
 *
 * The daemon pushes status at 10 Hz, so the commit countdown and the tracking
 * delta are smoother than the poll ever was.
 */
export function useRecorder({
  onEpisodeSaved,
  onRepoId,
}: {
  onEpisodeSaved?: () => void;
  onRepoId?: (repoId: string) => void;
} = {}): Recorder {
  const [status, setStatus] = useState<RecorderStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const savedCount = useRef<number | null>(null);
  const socket = useRef<WebSocket | null>(null);
  // Callbacks live in a ref so reconnect logic does not re-run when a parent
  // re-renders with new closures -- that would tear down a healthy socket.
  const handlers = useRef({ onEpisodeSaved, onRepoId });
  handlers.current = { onEpisodeSaved, onRepoId };

  const apply = useCallback((next: RecorderStatus) => {
    setStatus(next);
    handlers.current.onRepoId?.(next.repo_id);
    // Refresh the episode list exactly when a take lands, not on a timer.
    if (savedCount.current !== null && next.saved_episodes > savedCount.current) {
      handlers.current.onEpisodeSaved?.();
    }
    savedCount.current = next.saved_episodes;
  }, []);

  useEffect(() => {
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    async function connect() {
      if (!live) return;
      let url: string;
      try {
        const res = await fetch("/api/recorder/wsurl", { cache: "no-store" });
        url = ((await res.json()) as { url: string }).url;
      } catch {
        return schedule();
      }
      if (!live) return;

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        return schedule();
      }
      socket.current = ws;

      ws.onopen = () => {
        attempt = 0;
      };
      ws.onmessage = (event) => {
        try {
          apply(JSON.parse(event.data as string) as RecorderStatus);
        } catch {
          /* a truncated frame is not worth tearing the socket down for */
        }
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        socket.current = null;
        setStatus({ ...OFFLINE });
        schedule();
      };
    }

    function schedule() {
      if (!live) return;
      setStatus((prev) => (prev ? { ...prev, offline: true } : { ...OFFLINE }));
      // 1s, 2s, 4s … capped at 15s. The daemon being down is the normal state
      // before you press Start, not an error worth retrying hard.
      const delay = Math.min(15_000, 1000 * 2 ** attempt++);
      retry = setTimeout(() => void connect(), delay);
    }

    void connect();
    return () => {
      live = false;
      clearTimeout(retry);
      // Drop the handler first: this close is deliberate and must not schedule
      // a reconnect against an unmounted component.
      if (socket.current) {
        socket.current.onclose = null;
        socket.current.close();
        socket.current = null;
      }
    };
  }, [apply]);

  const send = useCallback(
    async (action: RecorderAction, payload: Record<string, unknown> = {}) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/recorder/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => ({}));
        // The daemon answers every command with the full status, so a button
        // never has to wait for the next pushed frame to show its effect.
        if (body?.state) apply(body as RecorderStatus);
        if (!res.ok || body?.ok === false) {
          setError(body?.error ?? `${action} failed`);
          return false;
        }
        return true;
      } catch (err) {
        setError((err as Error).message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [apply],
  );

  return { status, busy, error, dismissError: () => setError(null), send };
}
