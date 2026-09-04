"use client";

import { useEffect, useState } from "react";

import type { EpisodeRow, Verdict } from "@/lib/api-types";

export default function LabelBar({
  episode,
  onLabel,
}: {
  episode: EpisodeRow;
  onLabel: (verdict: Verdict, patch?: { notes?: string | null }) => Promise<void>;
}) {
  const [notes, setNotes] = useState(episode.label?.notes ?? "");

  // The textarea is uncontrolled across episodes; reset it when the row changes
  // so notes never bleed from one episode onto the next.
  useEffect(() => {
    setNotes(episode.label?.notes ?? "");
  }, [episode.episode_index, episode.label?.notes]);

  const verdict = episode.label?.verdict ?? null;

  return (
    <section className="panel">
      <h2>Verdict</h2>
      <div className="inner label-bar">
        {(["pass", "discard"] as Verdict[]).map((v) => (
          <button
            key={v}
            className={`verdict ${v}`}
            aria-pressed={verdict === v}
            onClick={() => void onLabel(v)}
          >
            {v}
          </button>
        ))}

        <input
          className="notes"
          placeholder="notes (enter to save)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.currentTarget.blur();
            void onLabel(verdict ?? "pass", { notes: notes || null });
          }}
        />
      </div>
    </section>
  );
}
