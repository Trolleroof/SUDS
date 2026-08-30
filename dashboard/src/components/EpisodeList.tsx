"use client";

import { useEffect, useRef } from "react";

import type { EpisodeRow } from "@/lib/api-types";

export default function EpisodeList({
  episodes,
  selected,
  onSelect,
}: {
  episodes: EpisodeRow[];
  selected: number;
  onSelect: (index: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);

  // j/k moves the selection off-screen otherwise.
  useEffect(() => {
    container.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div ref={container}>
      {episodes.map((episode) => (
        <button
          key={episode.episode_index}
          className="row"
          aria-selected={episode.episode_index === selected}
          onClick={() => onSelect(episode.episode_index)}
        >
          <span className={`dot ${episode.label?.verdict ?? ""}`} />
          <span className="idx">{String(episode.episode_index).padStart(3, "0")}</span>
          <span className="meta">
            {episode.duration_s.toFixed(1)}s
            {episode.quality && episode.quality.dropped_frames > 0 && (
              <span className="flag" title={`${episode.quality.dropped_frames} dropped frames`}>
                {" "}⚠
              </span>
            )}
          </span>
        </button>
      ))}
      {episodes.length === 0 && <p className="empty">nothing matches this filter</p>}
    </div>
  );
}
