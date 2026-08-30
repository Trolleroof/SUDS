"use client";

import { useCallback, useEffect, useRef } from "react";

import type { EpisodeRow } from "@/lib/api-types";

/**
 * LeRobot v3 concatenates many episodes into one mp4 per chunk, so a clip is a
 * file plus a `[from, to]` window. Every camera is clamped to that window and
 * loops inside it, which is what makes scrubbing feel like one episode rather
 * than one long recording.
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

  const rewindAll = useCallback(() => {
    for (const [key, el] of refs.current) {
      const clip = episode.videos[key];
      if (!clip) continue;
      el.currentTime = clip.from;
      void el.play().catch(() => {
        /* autoplay refusal is fine; the user still has the controls */
      });
    }
  }, [episode]);

  // Selecting a new episode reuses the same <video> elements when the two share
  // a file, so the seek has to be driven explicitly rather than by a remount.
  useEffect(() => {
    for (const [key, el] of refs.current) {
      const clip = episode.videos[key];
      if (clip) el.currentTime = clip.from;
    }
  }, [episode]);

  const present = videoKeys.filter((key) => episode.videos[key]);

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
                  controls
                  muted
                  playsInline
                  preload="metadata"
                  onLoadedMetadata={(e) => {
                    e.currentTarget.currentTime = clip.from;
                  }}
                  onTimeUpdate={(e) => {
                    const el = e.currentTarget;
                    if (clip.to > clip.from && el.currentTime >= clip.to) el.currentTime = clip.from;
                  }}
                />
              </div>
            );
          })}
        </div>
        <div className="label-bar" style={{ marginTop: 10 }}>
          <button className="verdict" onClick={rewindAll}>
            replay all
          </button>
          <span className="hint">
            clip {episode.videos[present[0]].from.toFixed(2)}s → {episode.videos[present[0]].to.toFixed(2)}s ·{" "}
            {episode.length} frames
          </span>
        </div>
      </div>
    </section>
  );
}
