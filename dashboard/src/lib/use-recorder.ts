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
  /** Resolves to the daemon's new status, or null if the command was refused. */
  send: (action: RecorderAction, payload?: Record<string, unknown>) => Promise<RecorderStatus | null>;
  /**
   * Skip the reconnect backoff and try the websocket right now. For right after
   * something else (e.g. `/api/daemon/start`) is known to have brought the
   * daemon up -- otherwise the hook may still be waiting out a multi-second
   * backoff from before the daemon existed to connect to.
   */
  reconnectNow: () => void;
  /**
   * Wait for a status condition to be met over the websocket stream without HTTP polling.
   */
  waitForStatus: (
    test: (status: RecorderStatus | null) => boolean,
    timeoutMs?: number,
    cancelled?: () => boolean,
  ) => Promise<RecorderStatus | null>;
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

  const statusRef = useRef<RecorderStatus | null>(null);
  const listeners = useRef<Set<(status: RecorderStatus) => void>>(new Set());

  const savedCount = useRef<number | null>(null);
  const socket = useRef<WebSocket | null>(null);
  // Callbacks live in a ref so reconnect logic does not re-run when a parent
  // re-renders with new closures -- that would tear down a healthy socket.
  const handlers = useRef({ onEpisodeSaved, onRepoId });
  handlers.current = { onEpisodeSaved, onRepoId };

  const apply = useCallback((next: RecorderStatus) => {
    statusRef.current = next;
    setStatus(next);
    listeners.current.forEach((fn) => {
      try {
        fn(next);
      } catch {
        /* listener error */
      }
    });
    handlers.current.onRepoId?.(next.repo_id);
    // Refresh the episode list exactly when a take lands, not on a timer.
    if (savedCount.current !== null && next.saved_episodes > savedCount.current) {
      handlers.current.onEpisodeSaved?.();
    }
    savedCount.current = next.saved_episodes;
  }, []);

  const reconnectRef = useRef<() => void>(() => {});

  useEffect(() => {
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let lastWsMessageTime = 0;
    let lastHttpSuccessTime = 0;

    async function pollHttp() {
      if (!live) return;
      try {
        const res = await fetch("/api/recorder/status", { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as RecorderStatus;
          if (data && typeof data === "object" && data.state && !data.offline) {
            lastHttpSuccessTime = Date.now();
            apply({ ...data, offline: false });
          }
        } else {
          const now = Date.now();
          if (now - lastWsMessageTime > 3000 && now - lastHttpSuccessTime > 3000) {
            apply(statusRef.current ? { ...statusRef.current, offline: true } : { ...OFFLINE });
          }
        }
      } catch {
        const now = Date.now();
        if (now - lastWsMessageTime > 3000 && now - lastHttpSuccessTime > 3000) {
          apply(statusRef.current ? { ...statusRef.current, offline: true } : { ...OFFLINE });
        }
      } finally {
        schedulePoll();
      }
    }

    function schedulePoll() {
      if (!live) return;
      clearTimeout(pollTimer);
      const isWsActive = socket.current?.readyState === WebSocket.OPEN && Date.now() - lastWsMessageTime < 800;
      const isBusyState =
        statusRef.current?.state === "recording" ||
        statusRef.current?.state === "pending" ||
        statusRef.current?.state === "saving";
      const interval = isWsActive ? 2500 : isBusyState ? 200 : 1000;
      pollTimer = setTimeout(() => void pollHttp(), interval);
    }

    async function connect() {
      if (!live) return;
      let url: string;
      try {
        const res = await fetch("/api/recorder/wsurl", { cache: "no-store" });
        url = ((await res.json()) as { url: string }).url;
      } catch {
        void pollHttp();
        return schedule();
      }
      if (!live) return;

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        void pollHttp();
        return schedule();
      }
      socket.current = ws;

      ws.onopen = () => {
        attempt = 0;
        schedulePoll();
      };
      ws.onmessage = (event) => {
        try {
          lastWsMessageTime = Date.now();
          apply(JSON.parse(event.data as string) as RecorderStatus);
        } catch {
          /* a truncated frame is not worth tearing the socket down for */
        }
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        socket.current = null;
        // Don't abruptly flip to OFFLINE if HTTP can reach the recorder.
        void pollHttp();
        schedule();
      };
    }

    function schedule() {
      if (!live) return;
      if (Date.now() - lastHttpSuccessTime > 3000 && Date.now() - lastWsMessageTime > 3000) {
        apply(statusRef.current ? { ...statusRef.current, offline: true } : { ...OFFLINE });
      }
      // 1s, 2s, 4s … capped at 15s.
      const delay = Math.min(15_000, 1000 * 2 ** attempt++);
      retry = setTimeout(() => void connect(), delay);
    }

    reconnectRef.current = () => {
      if (!live) return;
      clearTimeout(retry);
      attempt = 0;
      if (socket.current) {
        socket.current.onclose = null;
        socket.current.close();
        socket.current = null;
      }
      void pollHttp();
      void connect();
    };

    void pollHttp();
    void connect();
    return () => {
      live = false;
      clearTimeout(retry);
      clearTimeout(pollTimer);
      if (socket.current) {
        socket.current.onclose = null;
        socket.current.close();
        socket.current = null;
      }
    };
  }, [apply]);

  const waitForStatus = useCallback(
    (
      test: (s: RecorderStatus | null) => boolean,
      timeoutMs = 90_000,
      cancelled: () => boolean = () => false,
    ): Promise<RecorderStatus | null> => {
      if (cancelled()) return Promise.resolve(null);
      if (statusRef.current && test(statusRef.current)) {
        return Promise.resolve(statusRef.current);
      }
      return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onUpdate = (next: RecorderStatus) => {
          if (cancelled()) {
            cleanup();
            resolve(null);
            return;
          }
          if (test(next)) {
            cleanup();
            resolve(next);
          }
        };
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          listeners.current.delete(onUpdate);
        };
        listeners.current.add(onUpdate);
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            cleanup();
            resolve(statusRef.current);
          }, timeoutMs);
        }
      });
    },
    [],
  );

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
          return null;
        }
        return body?.state ? (body as RecorderStatus) : null;
      } catch (err) {
        setError((err as Error).message);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [apply],
  );

  return {
    status,
    busy,
    error,
    dismissError: () => setError(null),
    send,
    reconnectNow: () => reconnectRef.current(),
    waitForStatus,
  };
}
