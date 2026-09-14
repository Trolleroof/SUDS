"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Recorder } from "@/lib/use-recorder";
import { sortCamerasForDisplay } from "@/lib/camera-ports";

/**
 * Live view of every camera the recorder owns — the third-person view of the
 * cell and the wrist view off the arm.
 *
 * The recorder is already reading these cameras at the control rate; OpenCV will
 * not hand the same device to a second process, so the frames have to come from
 * the daemon rather than from a second capture here. It re-encodes them as MJPEG
 * (`/stream?camera=…`), which an `<img>` renders with no player, no codec
 * negotiation and no JavaScript — and which keeps running while the arms are
 * e-stopped, when you most want to see what happened.
 */
export default function LiveCameras({ recorder }: { recorder: Recorder }) {
  const { status } = recorder;
  // A control-loop hiccup (e.g. an arm read blocking on a dead port when the
  // bot gets unplugged) can flip `status.offline` for a couple of seconds even
  // though the cameras -- which run their own capture thread with their own
  // reconnect logic -- never stopped. Remembering the last camera list means a
  // blip pauses the status chrome, not the whole grid.
  const lastCameras = useRef<string[]>([]);
  if (status && !status.offline && status.cameras.length) lastCameras.current = status.cameras;
  const cameras = sortCamerasForDisplay(status?.offline ? lastCameras.current : (status?.cameras ?? []), (name) => name);
  const [focus, setFocus] = useState<string | null>(null);
  // Bumping this remounts the <img>, which is how you restart an MJPEG stream.
  const [nonce, setNonce] = useState(0);
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [live, setLive] = useState(true);
  const [fullscreen, setFullscreen] = useState<string | null>(null);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const reload = useCallback(() => {
    setFailed({});
    setNonce((n) => n + 1);
  }, []);

  // A daemon restart drops every open stream; reconnect rather than leaving the
  // panel showing a broken image until someone clicks. Only bump the streams
  // themselves on the offline -> online edge, not on every render, so a
  // transient blip (arm unplugged, control loop briefly stalled) doesn't
  // touch the <img> tags at all -- they keep streaming right through it.
  const wasOffline = useRef(false);
  useEffect(() => {
    if (status?.offline) {
      wasOffline.current = true;
      return;
    }
    if (wasOffline.current) {
      wasOffline.current = false;
      setFailed({});
      setNonce((n) => n + 1);
    }
  }, [status?.offline]);

  if (!status) return null;

  if (cameras.length === 0) {
    return (
      <section className="panel">
        <h2>live cameras</h2>
        <div className="inner hint">
          no cameras configured — start the recorder with{" "}
          <code>--camera third_person=0 --camera wrist=1</code>
        </div>
      </section>
    );
  }

  return (
    <section className="panel live">
      <h2>live cameras</h2>
      <div className="inner">
        <div className="label-bar live-controls">
          <button className="chip wide" aria-pressed={focus === null} onClick={() => setFocus(null)}>
            all {cameras.length}
          </button>
          {cameras.map((name) => (
            <button key={name} className="chip wide" aria-pressed={focus === name} onClick={() => setFocus(name)}>
              {name}
            </button>
          ))}
          <button className="verdict" onClick={() => setLive((on) => !on)}>
            {live ? "Freeze" : "Go live"}
          </button>
          <button className="verdict" onClick={reload}>
            Reconnect
          </button>
          <span className="hint">
            {status.offline
              ? "recorder reconnecting — streams held"
              : live
                ? "streaming from the recorder"
                : "frozen — last frame held"}
          </span>
        </div>

        {/* Every camera stays mounted for the life of the panel. Focus and
            fullscreen are styling, never unmounting: an <img> that leaves the
            tree drops its MJPEG connection, and the one it opens on the way
            back shows black until the next frame arrives. */}
        <div className={`live-grid ${focus ? "focused" : ""}`}>
          {cameras.map((name) => (
            <figure
              key={name}
              className={`live-card${fullscreen === name ? " fullscreen" : ""}`}
              hidden={Boolean(focus) && focus !== name && fullscreen !== name}
            >
              <figcaption>
                <span className="cam">{name}</span>
                <span className={`dot ${status.hardware?.cameras?.[name]?.status ?? "offline"}`} aria-hidden />
              </figcaption>
              {failed[name] ? (
                <div className="live-frame placeholder">
                  <span>no stream</span>
                  <button className="verdict" onClick={reload}>
                    Retry
                  </button>
                </div>
              ) : (
                /* eslint-disable-next-line @next/next/no-img-element -- MJPEG; next/image would buffer it */
                <img
                  key={`${name}-${nonce}-${live}`}
                  className="live-frame"
                  alt={`${name} camera`}
                  title={fullscreen === name ? "Click to exit fullscreen" : "Click to view fullscreen"}
                  src={
                    live
                      ? `/api/stream/${encodeURIComponent(name)}?n=${nonce}`
                      : `/api/stream/${encodeURIComponent(name)}?mode=snapshot&n=${nonce}`
                  }
                  onError={() => setFailed((prev) => ({ ...prev, [name]: true }))}
                  onClick={() => setFullscreen((current) => (current === name ? null : name))}
                />
              )}
            </figure>
          ))}
        </div>
      </div>

      {fullscreen && !failed[fullscreen] && (
        <div className="live-frame-scrim" onClick={() => setFullscreen(null)}>
          <button
            className="live-frame-scrim-close"
            onClick={(e) => {
              e.stopPropagation();
              setFullscreen(null);
            }}
          >
            Close
          </button>
        </div>
      )}
    </section>
  );
}
