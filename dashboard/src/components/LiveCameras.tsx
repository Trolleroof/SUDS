"use client";

import { useCallback, useEffect, useState } from "react";

import type { Recorder } from "@/lib/use-recorder";

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
  const cameras = status?.cameras ?? [];
  const [focus, setFocus] = useState<string | null>(null);
  // Bumping this remounts the <img>, which is how you restart an MJPEG stream.
  const [nonce, setNonce] = useState(0);
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [live, setLive] = useState(true);

  const reload = useCallback(() => {
    setFailed({});
    setNonce((n) => n + 1);
  }, []);

  // A daemon restart drops every open stream; reconnect rather than leaving the
  // panel showing a broken image until someone clicks.
  useEffect(() => {
    if (!status?.offline) return;
    setFailed({});
  }, [status?.offline]);

  if (!status || status.offline) return null;

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

  const shown = focus ? cameras.filter((name) => name === focus) : cameras;

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
          <span className="hint">{live ? "streaming from the recorder" : "frozen — last frame held"}</span>
        </div>

        <div className={`live-grid ${focus ? "focused" : ""}`}>
          {shown.map((name) => (
            <figure key={name} className="live-card">
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
                  src={
                    live
                      ? `/api/stream/${encodeURIComponent(name)}?n=${nonce}`
                      : `/api/stream/${encodeURIComponent(name)}?mode=snapshot&n=${nonce}`
                  }
                  onError={() => setFailed((prev) => ({ ...prev, [name]: true }))}
                />
              )}
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
