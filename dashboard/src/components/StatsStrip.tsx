"use client";

import { useMemo } from "react";

import type { DatasetPayload } from "@/lib/api-types";

export default function StatsStrip({ data }: { data: DatasetPayload | null }) {
  const stats = useMemo(() => {
    if (!data) return null;
    const eps = data.episodes;
    const labelled = eps.filter((e) => e.label && e.label.verdict !== "discard");
    const passed = labelled.filter((e) => e.label!.verdict === "pass");
    const minutes = eps.reduce((sum, e) => sum + e.duration_s, 0) / 60;
    const dropped = eps.reduce((sum, e) => sum + (e.quality?.dropped_frames ?? 0), 0);
    return {
      episodes: eps.length,
      labelled: labelled.length,
      unlabelled: eps.filter((e) => !e.label).length,
      passRate: labelled.length ? (100 * passed.length) / labelled.length : NaN,
      minutes,
      dropped,
      fps: data.info.fps,
    };
  }, [data]);

  if (!stats) return <div className="stats" />;

  return (
    <div className="stats">
      <Stat k="episodes" v={String(stats.episodes)} />
      <Stat k="labelled" v={`${stats.labelled}/${stats.episodes}`} />
      <Stat
        k="pass rate"
        v={Number.isNaN(stats.passRate) ? "—" : `${stats.passRate.toFixed(0)}%`}
        tone="pass"
      />
      <Stat k="footage" v={`${stats.minutes.toFixed(1)}m`} />
      <Stat k="fps" v={String(stats.fps)} />
      <Stat k="dropped" v={String(stats.dropped)} tone={stats.dropped > 0 ? "warn" : undefined} />
    </div>
  );
}

function Stat({ k, v, tone }: { k: string; v: string; tone?: "pass" | "warn" }) {
  return (
    <div className="stat">
      <span className="k">{k}</span>
      <span className={`v ${tone ?? ""}`}>{v}</span>
    </div>
  );
}
