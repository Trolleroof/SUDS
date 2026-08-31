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

/**
 * One poll of the recorder daemon, shared by every panel that needs it.
 *
 * Four separate components used to poll it independently; that is four requests
 * per tick describing the same state, and four chances for them to disagree
 * about whether the arms are live.
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

  const poll = useCallback(async () => {
    let res: Response;
    try {
      res = await fetch("/api/recorder/status", { cache: "no-store" });
    } catch {
      setStatus((prev) => (prev ? { ...prev, offline: true } : prev));
      return;
    }
    const body = await res.json();
    setStatus(res.ok ? (body as RecorderStatus) : { ...body, offline: true });

    // Refresh the episode list exactly when a take lands, not on a timer.
    if (res.ok) {
      const next = body as RecorderStatus;
      onRepoId?.(next.repo_id);
      if (savedCount.current !== null && next.saved_episodes > savedCount.current) onEpisodeSaved?.();
      savedCount.current = next.saved_episodes;
    }
  }, [onEpisodeSaved, onRepoId]);

  useEffect(() => {
    void poll();
    // 4 Hz: fast enough for a legible commit countdown and a live delta readout,
    // cheap enough to leave on all day.
    const timer = setInterval(() => void poll(), 250);
    return () => clearInterval(timer);
  }, [poll]);

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
        // The daemon answers every command with the full status, so the UI is
        // never a poll behind the thing it just did.
        if (body?.state) setStatus(body as RecorderStatus);
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
        void poll();
      }
    },
    [poll],
  );

  return { status, busy, error, dismissError: () => setError(null), send };
}
