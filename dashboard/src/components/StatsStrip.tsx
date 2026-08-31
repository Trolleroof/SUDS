"use client";

import { useMemo } from "react";

import type { DatasetPayload } from "@/lib/api-types";

export default function StatsStrip({ data }: { data: DatasetPayload | null }) {
  const stats = useMemo(() => {
    if (!data) return null;
    const eps = data.episodes;
    const labelled = eps.filter((e) => e.label && e.label.verdict !== "discard");
    const passed = labelled.filter((e) => e.label!.verdict === "pass");
    return {
      episodes: eps.length,
      labelled: labelled.length,
      passRate: labelled.length ? (100 * passed.length) / labelled.length : NaN,
    };
  }, [data]);

  if (!stats) return null;

  return (
    <div className="stats">
      <Stat k="episodes" v={String(stats.episodes)} />
      <Stat k="labelled" v={`${stats.labelled}/${stats.episodes}`} />
      <Stat
        k="pass"
        v={Number.isNaN(stats.passRate) ? "—" : `${stats.passRate.toFixed(0)}%`}
        tone="pass"
      />
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
