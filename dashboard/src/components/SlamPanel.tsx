"use client";

import { useEffect, useMemo, useState } from "react";

type Point = { x: number; y: number; z: number };
type Slam = { points: Point[]; frames: number; tracked_frames: number; lost_frames: number };

export default function SlamPanel({ repoId, episodeIndex }: { repoId: string; episodeIndex: number }) {
  const [slam, setSlam] = useState<Slam | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setSlam(null);
    fetch(`/api/slam?repo_id=${encodeURIComponent(repoId)}&episode_index=${episodeIndex}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => setSlam(body as Slam | null))
      .catch(() => {});
    return () => controller.abort();
  }, [repoId, episodeIndex]);

  const plot = useMemo(() => project(slam?.points ?? []), [slam]);
  if (!slam) return null;

  return (
    <section className="panel slam-panel">
      <h2>SLAM — episode {episodeIndex}</h2>
      <div className="inner">
        {plot ? (
          <svg viewBox="0 0 640 260" role="img" aria-label="Top-down gripper trajectory">
            <polyline points={plot.path} fill="none" stroke="currentColor" strokeWidth="3" />
            <circle cx={plot.start.x} cy={plot.start.y} r="6" className="slam-start" />
            <circle cx={plot.end.x} cy={plot.end.y} r="6" className="slam-end" />
          </svg>
        ) : (
          <p className="hint">No tracked SLAM poses in this episode.</p>
        )}
        <div className="label-bar">
          <span className="cam">top-down TCP path</span>
          <span className="hint">
            {slam.tracked_frames}/{slam.frames} tracked · {slam.lost_frames} lost
            {plot ? ` · z ${plot.zMin.toFixed(3)}–${plot.zMax.toFixed(3)} m` : ""}
          </span>
        </div>
      </div>
    </section>
  );
}

function project(points: Point[]) {
  if (!points.length) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const zs = points.map((point) => point.z);
  const xMin = Math.min(...xs);
  const xSpan = Math.max(Math.max(...xs) - xMin, 0.001);
  const yMin = Math.min(...ys);
  const ySpan = Math.max(Math.max(...ys) - yMin, 0.001);
  const xy = points.map((point) => ({
    x: 20 + ((point.x - xMin) / xSpan) * 600,
    y: 240 - ((point.y - yMin) / ySpan) * 220,
  }));
  return {
    path: xy.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" "),
    start: xy[0],
    end: xy[xy.length - 1],
    zMin: Math.min(...zs),
    zMax: Math.max(...zs),
  };
}
