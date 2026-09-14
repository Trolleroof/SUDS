"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { EpisodeRow } from "@/lib/api-types";

/**
 * LeRobot v3 concatenates many episodes into one mp4 per chunk, so a clip is a
 * file plus a `[from, to]` window. Every camera is clamped to that window and
 * loops inside it, which is what makes scrubbing feel like one episode rather
 * than one long recording.
 *
 * The cameras share one transport rather than carrying their own controls: the
 * windows start at different offsets in their files, so a per-video scrubber
 * would show wall-clock positions that disagree between views of the same
 * instant. Everything here is in clip-relative seconds — 0 is the first frame
 * of the episode on every camera — and the bar seeks them as a unit.
 */
export default function VideoPanel({
  repoId,
  episode,
  videoKeys,
}: {
  repoId: string;
  episode: EpisodeRow;
  videoKeys: string[];
}) {
  const refs = useRef(new Map<string, HTMLVideoElement>());
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  // Held in a ref too: the rAF loop reads it every frame and must not re-arm
  // itself on each state change.
  const scrubbing = useRef(false);

  const present = videoKeys.filter((key) => episode.videos[key]);
  const lead = present[0];
  const leadClip = lead ? episode.videos[lead] : undefined;
  const duration = leadClip ? Math.max(leadClip.to - leadClip.from, 0) : 0;
  const fps = duration > 0 ? episode.length / duration : 30;

  /** Seek every camera to the same clip-relative instant. */
  const seekAll = useCallback(
    (t: number) => {
      const clamped = Math.min(Math.max(t, 0), duration);
      for (const [key, el] of refs.current) {
        const clip = episode.videos[key];
        if (!clip) continue;
        el.currentTime = clip.from + Math.min(clamped, Math.max(clip.to - clip.from, 0));
      }
      setTime(clamped);
    },
    [episode, duration],
  );

  const pauseAll = useCallback(() => {
    for (const el of refs.current.values()) el.pause();
    setPlaying(false);
  }, []);

  const playAll = useCallback(() => {
    for (const el of refs.current.values()) {
      void el.play().catch(() => {
        /* autoplay refusal is fine; the user can hit play again */
      });
    }
    setPlaying(true);
  }, []);

  const replayAll = useCallback(() => {
    seekAll(0);
    playAll();
  }, [seekAll, playAll]);

  // Selecting a new episode reuses the same <video> elements when the two share
  // a file, so the seek has to be driven explicitly rather than by a remount.
  useEffect(() => {
    pauseAll();
    seekAll(0);
    // seekAll/pauseAll are stable per episode; re-running on episode is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episode]);

  // One clock for the whole panel: the lead camera's playhead. Followers are
  // nudged back into line when they drift — decoders start at slightly
  // different times and would otherwise slowly separate over a long clip.
  useEffect(() => {
    if (!playing || !lead || !leadClip) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const leader = refs.current.get(lead);
      if (!leader || scrubbing.current) return;

      const t = leader.currentTime - leadClip.from;
      if (duration > 0 && t >= duration) {
        seekAll(0);
        return;
      }
      setTime(Math.max(t, 0));

      for (const [key, el] of refs.current) {
        if (key === lead) continue;
        const clip = episode.videos[key];
        if (!clip) continue;
        const want = clip.from + Math.min(t, Math.max(clip.to - clip.from, 0));
        if (Math.abs(el.currentTime - want) > 0.12) el.currentTime = want;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, lead, leadClip, duration, episode, seekAll]);

  if (!present.length) {
    return (
      <section className="panel">
        <h2>cameras</h2>
        <div className="inner hint">this dataset has no video features</div>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>
        cameras — episode {episode.episode_index}
        {episode.task ? ` · ${episode.task}` : ""}
      </h2>
      <div className="inner">
        <div className="videos">
          {present.map((key) => {
            const clip = episode.videos[key];
            const src = `/api/video?repo_id=${encodeURIComponent(repoId)}&path=${encodeURIComponent(clip.file)}`;
            return (
              <div className="video-card" key={key}>
                <div className="cam">{key.replace("observation.images.", "")}</div>
                <video
                  ref={(el) => {
                    if (el) refs.current.set(key, el);
                    else refs.current.delete(key);
                  }}
                  src={src}
                  muted
                  playsInline
                  preload="metadata"
                  onClick={() => (playing ? pauseAll() : playAll())}
                  onLoadedMetadata={(e) => {
                    e.currentTarget.currentTime = clip.from + time;
                  }}
                />
              </div>
            );
          })}
        </div>

        <div className="transport">
          <button
            className="transport-play"
            aria-label={playing ? "Pause" : "Play"}
            onClick={() => (playing ? pauseAll() : playAll())}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <button
            className="transport-step"
            aria-label="Back one frame"
            onClick={() => {
              pauseAll();
              seekAll(time - 1 / fps);
            }}
          >
            ‹
          </button>
          <button
            className="transport-step"
            aria-label="Forward one frame"
            onClick={() => {
              pauseAll();
              seekAll(time + 1 / fps);
            }}
          >
            ›
          </button>
          <input
            className="transport-scrub"
            type="range"
            min={0}
            max={duration || 0.001}
            step={0.001}
            value={Math.min(time, duration)}
            aria-label="Scrub all cameras"
            onPointerDown={() => {
              scrubbing.current = true;
            }}
            onPointerUp={() => {
              scrubbing.current = false;
            }}
            onKeyDown={() => {
              scrubbing.current = true;
            }}
            onKeyUp={() => {
              scrubbing.current = false;
            }}
            onChange={(e) => seekAll(Number(e.target.value))}
          />
          <span className="transport-time">
            {fmt(time)} / {fmt(duration)}
          </span>
          <span className="transport-frame">
            frame {Math.min(Math.round(time * fps), Math.max(episode.length - 1, 0))}
          </span>
        </div>

        <div className="label-bar" style={{ marginTop: 10 }}>
          <button className="verdict" onClick={replayAll}>
            replay all
          </button>
          <span className="hint">
            clip {leadClip!.from.toFixed(2)}s → {leadClip!.to.toFixed(2)}s · {episode.length} frames
          </span>
        </div>
      </div>
    </section>
  );
}

function fmt(seconds: number) {
  const s = Math.max(seconds, 0);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
}
