"use client";

import { useCallback, useEffect, useState } from "react";

import { useCamerasConfig } from "@/lib/use-cameras-config";

type CameraState = { name: string; index: number; streaming: boolean; error: string | null };

type CamerasStatus = {
  running: boolean;
  pid: number | null;
  log: string[];
  cameras?: CameraState[];
  gripper_vision?: boolean;
  gripper_calibrated?: boolean;
  gripper?: { state: "open" | "closed" | "unknown"; gap_px: number | null } | null;
  error?: string;
};

const WRIST = "wrist";

/**
 * Handheld collection preview: the wrist camera only.
 *
 * Overhead is a review camera, not policy input — opening it here would also
 * grab the laptop's built-in cam on this machine. The recorder is a different
 * process and is not started from this page.
 */
export default function CollectPanel() {
  const { configured, ready } = useCamerasConfig();
  const wristIndex = configured.find((camera) => camera.name === WRIST)?.index ?? 0;

  const [status, setStatus] = useState<CamerasStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/run/cameras", { cache: "no-store" });
      if (res.ok) setStatus((await res.json()) as CamerasStatus);
    } catch {
      /* dashboard itself is down */
    }
  }, []);

  const startWrist = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const current = await fetch("/api/run/cameras", { cache: "no-store" });
      const body = current.ok ? ((await current.json()) as CamerasStatus) : null;
      if (body?.running && body.gripper_vision) {
        setStatus(body);
        return;
      }
      if (body?.running) {
        await fetch("/api/run/cameras", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "stop" }),
        });
      }
      const res = await fetch("/api/run/cameras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start",
          config: {
            robotPort: null,
            teleopPort: null,
            robotId: "follower",
            teleopId: "leader",
            cameras: [{ name: WRIST, index: wristIndex }],
            gripperVision: { leftId: 1, rightId: 2 },
          },
        }),
      });
      const next = await res.json().catch(() => ({}));
      if (!res.ok || next?.ok === false) {
        const message = (next?.error as string | undefined) ?? "Could not start the wrist camera";
        if (!/already running/i.test(message)) setError(message);
        return;
      }
      setStatus(next as CamerasStatus);
      setNonce((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      void poll();
    }
  }, [poll, wristIndex]);

  const stopCameras = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/run/cameras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
      const next = await res.json().catch(() => ({}));
      if (!res.ok || next?.ok === false) setError(next?.error ?? "Could not stop cameras");
    } finally {
      setBusy(false);
      void poll();
    }
  }, [poll]);

  useEffect(() => {
    if (!ready) return;
    void startWrist();
  }, [ready, startWrist]);

  useEffect(() => {
    const timer = setInterval(() => void poll(), 1500);
    return () => clearInterval(timer);
  }, [poll]);

  const camera = status?.cameras?.find((entry) => entry.name === WRIST);
  const running = Boolean(status?.running);

  return (
    <section className="panel collect">
      <h2>Gripper collection</h2>
      <div className="inner">
        <p className="hint collect-lead">
          Handheld wrist camera only — no robot, no overhead view. This is what a
          policy will see from the rig in your hand. Gripper vision runs only here;
          processed SLAM paths appear in Review.
        </p>

        <div className="label-bar live-controls">
          <span className={`daemon-pill ${status?.running ? "up" : "down"}`}>
            <span className="dot" aria-hidden />
            {busy
              ? "starting…"
              : status?.running
                ? `wrist · index ${wristIndex} · pid ${status.pid}`
                : "camera off"}
          </span>
          <button className="verdict" disabled={busy} onClick={() => void startWrist()}>
            {status?.running ? "Reconnect" : "Start camera"}
          </button>
          {status?.running && (
            <button className="verdict danger" disabled={busy} onClick={() => void stopCameras()}>
              Stop
            </button>
          )}
          <button className="verdict" onClick={() => setNonce((n) => n + 1)}>
            Reload feed
          </button>
          <span className={`daemon-pill ${status?.gripper?.state === "unknown" ? "down" : "up"}`}>
            gripper {status?.gripper_calibrated ? status?.gripper?.state : "uncalibrated"}
            {status?.gripper?.gap_px != null ? ` · ${status.gripper.gap_px}px` : ""}
          </span>
        </div>

        {error && <p className="cmd-error">{error}</p>}

        <figure className="live-card collect-feed">
          <figcaption>
            <span className={`dot ${camera?.streaming ? "ok" : running ? "warn" : "fail"}`} aria-hidden />
            <span className="cam">{WRIST} · USB2.0_CAM1 · OpenCV {wristIndex}</span>
          </figcaption>
          {running ? (
            /* eslint-disable-next-line @next/next/no-img-element -- MJPEG */
            <img
              key={nonce}
              className="live-frame"
              alt="Handheld wrist camera"
              title="Click to view fullscreen"
              src={`/api/camera/${WRIST}?n=${nonce}`}
              onClick={() => setFullscreen(true)}
            />
          ) : (
            <div className="live-frame placeholder">
              <span>
                {busy
                  ? "Opening the wrist camera…"
                  : camera?.error
                    ? camera.error
                    : status?.running
                      ? "Waiting for frames…"
                      : "Camera is off"}
              </span>
            </div>
          )}
        </figure>

        {fullscreen && running && (
          <div className="live-frame-scrim" onClick={() => setFullscreen(false)}>
            <button
              className="live-frame-scrim-close"
              onClick={(e) => {
                e.stopPropagation();
                setFullscreen(false);
              }}
            >
              Close
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element -- MJPEG */}
            <img
              key={nonce}
              className="live-frame-full"
              alt="Handheld wrist camera fullscreen"
              src={`/api/camera/${WRIST}?n=${nonce}`}
            />
          </div>
        )}
      </div>
    </section>
  );
}
